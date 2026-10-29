import path from 'node:path';
import type { AgentDefinition, HookCallbackMatcher, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeEnv, findClaudeBinary } from '../claude.js';
import { env } from '../env.js';
import { sdk } from '../sdk.js';
import type { ModelUsageTotals } from '../types.js';

/**
 * One agent run: a fresh Claude Code session with the agent's prompt as its
 * system prompt, the task prompt as its one user message, the agent's file
 * tools and nothing else, sandboxed to the workspace, under a turn cap, a
 * dollar cap and a wall-clock timeout.
 */

export type OutcomeKind =
  | 'ok'
  /** The agent finished but the harness rejected what it wrote (checked by the caller). */
  | 'failed'
  /** Rate limited or overloaded: worth retrying after a wait. */
  | 'transient'
  /** The subscription's usage limit: wait until it resets. */
  | 'limit'
  /** Claude Code cannot sign in or bill: nothing will run until the user fixes it. */
  | 'auth'
  | 'timeout'
  | 'aborted';

export interface Outcome {
  kind: OutcomeKind;
  error?: string;
  /** When Claude said the limit lifts, if it did. */
  resetsAt?: number;
  durationMs: number;
  costUsd: number;
  tokens: { input: number; output: number };
  usage: Record<string, ModelUsageTotals>;
  model?: string;
  /** The agent's final reply, when it finished. */
  reply?: string;
  turns?: number;
}

export interface RunRequest {
  workspace: string;
  agent: AgentDefinition;
  agentName: string;
  prompt: string;
  model: string;
  effort: string;
  timeoutMs: number;
  budgetUsd: number;
  maxTurns: number;
  /** The engine's stop signal. */
  signal?: AbortSignal;
  /** Everything the agent says and does, for the feed. */
  onEvent: (type: 'agent_text' | 'thinking' | 'tool_use', data: Record<string, unknown>) => void;
  /** Tokens as they stream by, for the live cost display. */
  onUsage?: (model: string, delta: { input: number; output: number; cacheRead: number; cacheWrite: number }) => void;
}

/**
 * Standard API pricing per MTok, used only to estimate the cost of a run
 * while it streams. The SDK's own figure replaces it at the end.
 */
const MODEL_PRICES: { match: RegExp; inTok: number; outTok: number; cacheRead: number; cacheWrite: number }[] = [
  { match: /(fable|mythos)-5-1/i, inTok: 10, outTok: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  { match: /fable|mythos/i, inTok: 10, outTok: 50, cacheRead: 1, cacheWrite: 12.5 },
  { match: /opus-5-5/i, inTok: 4, outTok: 20, cacheRead: 0.2, cacheWrite: 5 },
  { match: /sonnet-5/i, inTok: 2, outTok: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  { match: /haiku-5/i, inTok: 0.1, outTok: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  { match: /opus/i, inTok: 5, outTok: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { match: /sonnet/i, inTok: 3, outTok: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { match: /haiku/i, inTok: 1, outTok: 5, cacheRead: 0.1, cacheWrite: 1.25 },
];

export function estimateCostUsd(model: string, t: ModelUsageTotals): number {
  const price = MODEL_PRICES.find((p) => p.match.test(model));
  if (!price) return 0;
  return (t.inputTokens * price.inTok + t.outputTokens * price.outTok + t.cacheReadInputTokens * price.cacheRead + t.cacheCreationInputTokens * price.cacheWrite) / 1_000_000;
}

/** Tools no agent may use, whatever its definition says: the pipeline is file work inside one folder. */
const NEVER = ['Bash', 'Task', 'Agent', 'WebSearch', 'WebFetch', 'TodoWrite', 'NotebookEdit', 'KillShell', 'BashOutput'];

/**
 * Keep every tool call inside the workspace, and keep original/ untouched.
 * Runs before each tool call, whatever the permission mode.
 */
export function sandbox(workspace: string): HookCallbackMatcher[] {
  const root = path.resolve(workspace);
  const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: reason } });
  return [
    {
      hooks: [
        async (input) => {
          if (input.hook_event_name !== 'PreToolUse') return {};
          if (NEVER.includes(input.tool_name)) return deny(`${input.tool_name} is not available in this pipeline`);
          const args = (input.tool_input ?? {}) as Record<string, unknown>;
          for (const key of ['file_path', 'path', 'notebook_path']) {
            const p = args[key];
            if (typeof p !== 'string' || !p) continue;
            const abs = path.resolve(root, p);
            if (abs !== root && !abs.startsWith(root + path.sep)) return deny(`${p} is outside the project; only files under the project root may be used`);
            if (/^(Write|Edit|MultiEdit)$/.test(input.tool_name) && (abs === path.join(root, 'original') || abs.startsWith(path.join(root, 'original') + path.sep))) {
              return deny('original/ is the source text and is never modified; write to draft/, final/, notes/ or critique/');
            }
          }
          return {};
        },
      ],
    },
  ];
}

const emptyTotals = (): ModelUsageTotals => ({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0 });

function summarizeInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    out[key] = typeof value === 'string' && value.length > 400 ? value.slice(0, 400) + ` … (${value.length} chars)` : value;
  }
  return out;
}

/** Sort an error message into what the engine should do about it. */
export function classifyError(text: string): OutcomeKind {
  const t = text.toLowerCase();
  if (/usage limit|limit reached|out of (extra )?usage|resets? at|rate_limit_reached|hit your limit/.test(t)) return 'limit';
  if (/rate.?limit|429|overloaded|529|econnreset|etimedout|socket hang up|fetch failed|network|temporarily|server_error|internal server error|5\d\d\b/.test(t)) return 'transient';
  if (/authentication|not logged in|credential|unauthori[sz]ed|401|403|billing|account.*hold|log in|login/.test(t)) return 'auth';
  return 'failed';
}

const CLAUDE_BINARY = findClaudeBinary();

export async function runAgent(req: RunRequest): Promise<Outcome> {
  const started = Date.now();
  const abort = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, req.timeoutMs);
  const onStop = () => abort.abort();
  req.signal?.addEventListener('abort', onStop, { once: true });
  if (req.signal?.aborted) abort.abort();

  const live = new Map<string, ModelUsageTotals>();
  const seenIds = new Set<string>();
  const outcome: Outcome = { kind: 'failed', durationMs: 0, costUsd: 0, tokens: { input: 0, output: 0 }, usage: {} };
  const tools = (req.agent.tools ?? ['Read', 'Write', 'Edit', 'Glob', 'Grep']).filter((t) => !NEVER.includes(t));
  let apiError: string | undefined;
  let limitResetsAt: number | undefined;
  let finished = false;

  try {
    const q = sdk.query(
      {
        prompt: req.prompt,
        options: {
          cwd: req.workspace,
          model: req.model,
          effort: req.effort as never,
          systemPrompt: req.agent.prompt,
          tools,
          allowedTools: tools,
          disallowedTools: NEVER,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          settingSources: [],
          persistSession: false,
          maxTurns: req.maxTurns,
          maxBudgetUsd: req.budgetUsd,
          abortController: abort,
          hooks: { PreToolUse: sandbox(req.workspace) },
          env: claudeEnv(),
          ...(CLAUDE_BINARY ? { pathToClaudeCodeExecutable: CLAUDE_BINARY } : {}),
          stderr: (data: string) => {
            if (env.debug) console.error(`[${req.agentName}]`, data.trimEnd());
          },
        },
      },
      { tools: [] },
    );
    for await (const message of q as AsyncIterable<SDKMessage>) {
      switch (message.type) {
        case 'assistant': {
          if (message.error) apiError = message.error;
          const api = message.message;
          if (api?.usage && api.model && api.id && !seenIds.has(api.id)) {
            seenIds.add(api.id);
            const entry = live.get(api.model) ?? emptyTotals();
            const u = api.usage;
            const delta = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 };
            entry.inputTokens += delta.input;
            entry.outputTokens += delta.output;
            entry.cacheReadInputTokens += delta.cacheRead;
            entry.cacheCreationInputTokens += delta.cacheWrite;
            entry.costUsd = estimateCostUsd(api.model, entry);
            live.set(api.model, entry);
            outcome.model = api.model;
            req.onUsage?.(api.model, delta);
          }
          for (const block of api?.content ?? []) {
            if (block.type === 'text' && block.text.trim()) req.onEvent('agent_text', { text: block.text });
            else if (block.type === 'thinking' && block.thinking?.trim()) req.onEvent('thinking', { text: block.thinking });
            else if (block.type === 'tool_use') req.onEvent('tool_use', { tool: block.name, input: summarizeInput(block.input as Record<string, unknown>) });
          }
          break;
        }
        case 'rate_limit_event': {
          const info = message.rate_limit_info;
          if (info?.status === 'rejected') limitResetsAt = info.resetsAt ? info.resetsAt * (info.resetsAt < 1e12 ? 1000 : 1) : undefined;
          break;
        }
        case 'result': {
          finished = true;
          outcome.turns = message.num_turns;
          for (const [model, u] of Object.entries(message.modelUsage ?? {})) {
            outcome.usage[model] = { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadInputTokens: u.cacheReadInputTokens, cacheCreationInputTokens: u.cacheCreationInputTokens, costUsd: u.costUSD };
            outcome.model = outcome.model ?? model;
          }
          outcome.costUsd = Object.values(outcome.usage).reduce((a, u) => a + u.costUsd, 0);
          if (message.subtype === 'success') {
            outcome.kind = 'ok';
            outcome.reply = message.result;
          } else if (message.subtype === 'error_max_turns') {
            outcome.error = `the agent used all ${req.maxTurns} turns without finishing`;
          } else if (message.subtype === 'error_max_budget_usd') {
            outcome.error = `the agent spent the $${req.budgetUsd} budget for one run without finishing`;
          } else {
            const text = (message.errors ?? []).join('; ') || apiError || 'Claude Code reported an error';
            outcome.error = text;
            outcome.kind = limitResetsAt ? 'limit' : classifyError(text);
          }
          break;
        }
        default:
          break;
      }
    }
    if (!finished && outcome.kind !== 'ok') {
      outcome.error = outcome.error ?? apiError ?? 'Claude Code ended without a result';
      outcome.kind = apiError ? classifyError(apiError) : 'failed';
    }
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    if (timedOut) {
      outcome.kind = 'timeout';
      outcome.error = `no result after ${Math.round(req.timeoutMs / 60000)} minutes`;
    } else if (abort.signal.aborted) {
      outcome.kind = 'aborted';
      outcome.error = 'stopped';
    } else {
      outcome.kind = limitResetsAt ? 'limit' : classifyError(text);
      outcome.error = text;
    }
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener('abort', onStop);
  }
  if (limitResetsAt && outcome.kind !== 'ok') {
    outcome.kind = 'limit';
    outcome.resetsAt = limitResetsAt;
  }
  if (!Object.keys(outcome.usage).length) {
    // No result message (crash, timeout): the streamed counts are all we have.
    for (const [model, t] of live) outcome.usage[model] = t;
    outcome.costUsd = Object.values(outcome.usage).reduce((a, u) => a + u.costUsd, 0);
  }
  for (const u of Object.values(outcome.usage)) {
    outcome.tokens.input += u.inputTokens;
    outcome.tokens.output += u.outputTokens;
  }
  outcome.durationMs = Date.now() - started;
  return outcome;
}
