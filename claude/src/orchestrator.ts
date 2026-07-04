import fs from 'node:fs';
import path from 'node:path';
import {
  createSdkMcpServer,
  query,
  tool,
  type ModelUsage,
  type Query,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { loadAgents } from './agents.js';
import type { Project } from './projects.js';
import { orchestratorPrompt } from './prompt.js';
import type { ModelUsageTotals, UsageTotals } from './types.js';
import { listVersions, revertToVersion, saveVersion } from './versioning.js';

const emptyModelTotals = (): ModelUsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  costUsd: 0,
});

/**
 * Standard API pricing per MTok, used ONLY to estimate the cost of the live
 * in-turn token overlay. The SDK's authoritative costUSD (reported on result
 * messages at turn boundaries) replaces these estimates whenever it arrives —
 * which matters because the whole pipeline can be one long turn (the review
 * gate blocks inside it), so without an estimate the cost would read $0.00
 * until the book is finished.
 */
const MODEL_PRICES: { match: RegExp; inTok: number; outTok: number; cacheRead: number; cacheWrite: number }[] = [
  { match: /opus/i, inTok: 5, outTok: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { match: /sonnet/i, inTok: 3, outTok: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { match: /haiku/i, inTok: 1, outTok: 5, cacheRead: 0.1, cacheWrite: 1.25 },
];

function estimateCostUsd(model: string, t: ModelUsageTotals): number {
  const price = MODEL_PRICES.find((p) => p.match.test(model));
  if (!price) return 0;
  return (
    (t.inputTokens * price.inTok +
      t.outputTokens * price.outTok +
      t.cacheReadInputTokens * price.cacheRead +
      t.cacheCreationInputTokens * price.cacheWrite) /
    1_000_000
  );
}

const AGENTS = loadAgents();

interface ReviewGate {
  resolve: (answer: string) => void;
}

/**
 * A long-lived interactive orchestrator session for one project.
 *
 * The Agent SDK query runs in streaming-input mode: user messages (from the
 * web UI) are pushed into an async queue that feeds the session, and every
 * SDK message coming back is translated into a UiEvent for the frontend.
 */
export class OrchestratorSession {
  readonly project: Project;
  private q: Query | null = null;
  private queue: SDKUserMessage[] = [];
  private wakeQueue: (() => void) | null = null;
  private closed = false;
  private reviewGate: ReviewGate | null = null;
  private completedThisTurn = false;
  /** tool_use_id of a Task invocation -> subagent name, for attribution. */
  private taskAgents = new Map<string, string>();
  /**
   * The last per-model usage snapshot seen from the current SDK run. Result
   * messages report usage cumulatively within a run, so per-turn deltas
   * against this snapshot are accumulated into the persisted project totals.
   */
  private lastRunUsage: Record<string, ModelUsage> | null = null;
  /**
   * Live token overlay for the current turn. Cost and modelUsage are only
   * reported on `result` messages, i.e. at turn boundaries — during a long
   * turn (a whole extraction pass can be one turn) the panel would otherwise
   * sit at zero for hours. Tokens are counted from each assistant message's
   * API usage as they stream by, then discarded when the authoritative
   * turn-boundary numbers are folded into the persisted totals.
   */
  private liveUsage = new Map<string, ModelUsageTotals>();
  /** API message ids already counted (assistant messages can repeat an id). */
  private seenUsageIds = new Set<string>();
  private lastLiveEmit = 0;

  constructor(project: Project) {
    this.project = project;
  }

  get running(): boolean {
    return this.q !== null && !this.closed;
  }

  get awaitingReview(): boolean {
    return this.reviewGate !== null;
  }

  /** Push a user message into the live session (starting it if needed). */
  send(text: string): void {
    this.project.emit('user_message', 'user', { text });
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    } as SDKUserMessage);
    this.wakeQueue?.();
    if (!this.running) void this.run();
    else this.project.setStatus('running');
  }

  /** Resolve a pending request_review gate with the user's decision. */
  resolveReview(decision: 'approve' | 'revise', instructions?: string): boolean {
    if (!this.reviewGate) return false;
    const gate = this.reviewGate;
    this.reviewGate = null;
    this.project.emit('review_response', 'user', { decision, instructions });
    this.project.setStatus('running');
    gate.resolve(
      decision === 'approve'
        ? 'APPROVED — proceed with packaging.'
        : `REVISION REQUESTED — do not package yet. The user's instructions:\n\n${instructions ?? '(none given)'}\n\nApply these, save a version, then call request_review again.`,
    );
    return true;
  }

  async interrupt(): Promise<void> {
    await this.q?.interrupt().catch(() => undefined);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.reviewGate?.resolve('Session is shutting down; stop.');
    this.reviewGate = null;
    this.wakeQueue?.();
    await this.q?.interrupt().catch(() => undefined);
    this.q = null;
  }

  private async *inputStream(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      await new Promise<void>((resolve) => {
        this.wakeQueue = resolve;
      });
      this.wakeQueue = null;
    }
  }

  private mcpServer() {
    const project = this.project;
    return createSdkMcpServer({
      name: 'lexis',
      version: '1.0.0',
      tools: [
        tool(
          'report_progress',
          'Report structured pipeline progress to the user interface. Call whenever a phase or chapter changes state.',
          {
            phase: z.enum([
              'preparation',
              'initialization',
              'extraction',
              'production',
              'review',
              'packaging',
              'done',
            ]),
            chapter: z.string().optional().describe('The chapter filename, when chapter-scoped'),
            state: z.enum(['started', 'completed', 'failed']),
            detail: z.string().optional(),
          },
          async (args) => {
            project.emit('progress', 'orchestrator', args);
            return { content: [{ type: 'text' as const, text: 'ok' }] };
          },
        ),
        tool(
          'save_version',
          'Snapshot the entire workspace as a named version the user can inspect and revert to.',
          { label: z.string().describe('Short human-readable label for this version') },
          async (args) => {
            const version = await saveVersion(project, args.label);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: version
                    ? `Saved version ${version.id.slice(0, 8)}: ${version.label}`
                    : 'No changes since the last version; nothing to save.',
                },
              ],
            };
          },
        ),
        tool('list_versions', 'List all saved workspace versions, newest first.', {}, async () => {
          const versions = await listVersions(project);
          const text = versions
            .map((v) => `${v.id.slice(0, 8)}  ${v.date}  ${v.label}${v.auto ? ' (auto)' : ''}`)
            .join('\n');
          return { content: [{ type: 'text' as const, text: text || 'No versions yet.' }] };
        }),
        tool(
          'revert_version',
          'Restore the workspace to a previous version. The current state is snapshotted first, so this is non-destructive.',
          { id: z.string().describe('Version id (full or abbreviated commit hash)') },
          async (args) => {
            const version = await revertToVersion(project, args.id);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Workspace restored. New version ${version.id.slice(0, 8)}: ${version.label}. Re-read the workspace before continuing.`,
                },
              ],
            };
          },
        ),
        tool(
          'request_review',
          'MANDATORY before packaging. Presents your summary to the user and blocks until they approve or send revision instructions. Returns the decision.',
          {
            summary: z
              .string()
              .describe(
                'What was translated, glossary/consistency notes, notable challenges, open questions',
              ),
          },
          async (args) => {
            project.emit('review_request', 'orchestrator', { summary: args.summary });
            project.setStatus('awaiting_review');
            const answer = await new Promise<string>((resolve) => {
              this.reviewGate = { resolve };
            });
            return { content: [{ type: 'text' as const, text: answer }] };
          },
        ),
        tool(
          'mark_complete',
          'Record that the translated EPUB has been produced. Call exactly once per successful packaging.',
          {
            epub_path: z.string().describe('Path to the produced .epub, relative to the project root'),
            summary: z.string().describe('One-paragraph completion summary for the user'),
          },
          async (args) => {
            const abs = path.resolve(project.workspace, args.epub_path);
            if (!abs.startsWith(project.workspace)) {
              return {
                content: [{ type: 'text' as const, text: 'Path escapes the workspace.' }],
                isError: true,
              };
            }
            if (!fs.existsSync(abs) || fs.statSync(abs).size < 1024) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `No plausible EPUB found at ${args.epub_path} — verify packaging actually succeeded.`,
                  },
                ],
                isError: true,
              };
            }
            project.meta.outputPath = path.relative(project.workspace, abs);
            project.save();
            this.completedThisTurn = true;
            project.emit('progress', 'orchestrator', {
              phase: 'done',
              state: 'completed',
              detail: args.summary,
            });
            return { content: [{ type: 'text' as const, text: 'Completion recorded.' }] };
          },
        ),
      ],
    });
  }

  private async run(): Promise<void> {
    const project = this.project;
    project.setStatus('running');
    this.lastRunUsage = null;
    this.liveUsage.clear();
    this.seenUsageIds.clear();
    const stream = query({
      prompt: this.inputStream(),
      options: {
        cwd: project.workspace,
        model: 'sonnet',
        systemPrompt: orchestratorPrompt(project.meta),
        agents: AGENTS,
        mcpServers: { lexis: this.mcpServer() },
        settingSources: [],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        allowedTools: [
          'Read',
          'Write',
          'Edit',
          'Bash',
          'Glob',
          'Grep',
          'Task',
          'TodoWrite',
          'mcp__lexis__report_progress',
          'mcp__lexis__save_version',
          'mcp__lexis__list_versions',
          'mcp__lexis__revert_version',
          'mcp__lexis__request_review',
          'mcp__lexis__mark_complete',
        ],
        disallowedTools: ['WebSearch', 'WebFetch'],
        forwardSubagentText: true,
        ...(project.meta.sessionId ? { resume: project.meta.sessionId } : {}),
        stderr: (data: string) => {
          if (process.env.LEXIS_DEBUG) console.error(`[claude:${project.meta.id}]`, data);
        },
      },
    });
    this.q = stream;
    try {
      for await (const message of stream) {
        this.handleMessage(message);
      }
    } catch (error) {
      project.setStatus('error', String(error));
      project.emit('error', 'orchestrator', { message: String(error) });
    } finally {
      this.q = null;
      if (project.meta.status === 'running' || project.meta.status === 'awaiting_review') {
        project.setStatus(project.meta.outputPath ? 'completed' : 'awaiting_input');
      }
    }
  }

  /**
   * Count tokens from an assistant message's API usage into the live overlay
   * and push a throttled panel update. Applies to subagent messages too
   * (forwardSubagentText delivers them), so the panel moves while a subagent
   * grinds through a chapter.
   */
  private trackLiveUsage(message: SDKAssistantMessage): void {
    const api = message.message;
    const usage = api?.usage;
    const model = api?.model;
    if (!usage || !model) return;
    if (api.id) {
      if (this.seenUsageIds.has(api.id)) return; // multi-block messages repeat the id
      this.seenUsageIds.add(api.id);
      if (this.seenUsageIds.size > 1000) {
        const oldest = this.seenUsageIds.values().next().value;
        if (oldest) this.seenUsageIds.delete(oldest);
      }
    }
    const entry = this.liveUsage.get(model) ?? emptyModelTotals();
    entry.inputTokens += usage.input_tokens ?? 0;
    entry.outputTokens += usage.output_tokens ?? 0;
    entry.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0;
    entry.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0;
    entry.costUsd = estimateCostUsd(model, entry);
    this.liveUsage.set(model, entry);
    const now = Date.now();
    if (now - this.lastLiveEmit >= 10_000) {
      this.lastLiveEmit = now;
      const combined = this.combinedUsage();
      this.project.emit('usage', 'orchestrator', {
        byModel: combined.byModel as unknown as Record<string, unknown>,
        totalCostUsd: combined.totalCostUsd,
        estimated: true,
        live: true,
      });
    }
  }

  /**
   * Persisted (authoritative) totals plus the live in-turn overlay, whose
   * cost portion is a pricing-table estimate until the next turn boundary.
   */
  private combinedUsage(): UsageTotals {
    const base = this.project.meta.usage;
    const totals: UsageTotals = base
      ? (JSON.parse(JSON.stringify(base)) as UsageTotals)
      : { byModel: {}, totalCostUsd: 0 };
    for (const [model, live] of this.liveUsage) {
      const entry = totals.byModel[model] ?? emptyModelTotals();
      entry.inputTokens += live.inputTokens;
      entry.outputTokens += live.outputTokens;
      entry.cacheReadInputTokens += live.cacheReadInputTokens;
      entry.cacheCreationInputTokens += live.cacheCreationInputTokens;
      entry.costUsd += live.costUsd;
      totals.byModel[model] = entry;
      totals.totalCostUsd += live.costUsd;
    }
    return totals;
  }

  /**
   * Fold a run-cumulative per-model usage snapshot into the persisted project
   * totals. Returns the cost of the delta (i.e. this turn's cost).
   */
  private accumulateUsage(snapshot: Record<string, ModelUsage>): number {
    const project = this.project;
    const totals = project.meta.usage ?? { byModel: {}, totalCostUsd: 0 };
    let turnCostUsd = 0;
    for (const [model, usage] of Object.entries(snapshot)) {
      const prev = this.lastRunUsage?.[model];
      const delta = {
        inputTokens: Math.max(0, usage.inputTokens - (prev?.inputTokens ?? 0)),
        outputTokens: Math.max(0, usage.outputTokens - (prev?.outputTokens ?? 0)),
        cacheReadInputTokens: Math.max(
          0,
          usage.cacheReadInputTokens - (prev?.cacheReadInputTokens ?? 0),
        ),
        cacheCreationInputTokens: Math.max(
          0,
          usage.cacheCreationInputTokens - (prev?.cacheCreationInputTokens ?? 0),
        ),
        costUsd: Math.max(0, usage.costUSD - (prev?.costUSD ?? 0)),
      };
      const entry = totals.byModel[model] ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUsd: 0,
      };
      entry.inputTokens += delta.inputTokens;
      entry.outputTokens += delta.outputTokens;
      entry.cacheReadInputTokens += delta.cacheReadInputTokens;
      entry.cacheCreationInputTokens += delta.cacheCreationInputTokens;
      entry.costUsd += delta.costUsd;
      totals.byModel[model] = entry;
      totals.totalCostUsd += delta.costUsd;
      turnCostUsd += delta.costUsd;
    }
    this.lastRunUsage = snapshot;
    project.meta.usage = totals;
    project.save();
    return turnCostUsd;
  }

  private agentFor(parentToolUseId: string | null | undefined): string {
    if (!parentToolUseId) return 'orchestrator';
    return this.taskAgents.get(parentToolUseId) ?? 'subagent';
  }

  private handleMessage(message: SDKMessage): void {
    const project = this.project;
    switch (message.type) {
      case 'system': {
        if (message.subtype === 'init') {
          if (project.meta.sessionId !== message.session_id) {
            project.meta.sessionId = message.session_id;
            project.save();
          }
        } else if (message.subtype === 'task_started') {
          // Progress heartbeats handled via assistant tool_use below; ignore.
        }
        break;
      }
      case 'assistant': {
        this.trackLiveUsage(message);
        const agent = this.agentFor(message.parent_tool_use_id);
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text.trim()) {
            project.emit('agent_text', agent, { text: block.text });
          } else if (block.type === 'thinking' && block.thinking?.trim()) {
            project.emit('thinking', agent, { text: block.thinking });
          } else if (block.type === 'tool_use') {
            if (block.name === 'Task') {
              const input = block.input as { subagent_type?: string; description?: string };
              const name = input.subagent_type ?? 'subagent';
              this.taskAgents.set(block.id, name);
              project.emit('task_start', 'orchestrator', {
                agent: name,
                description: input.description ?? '',
              });
            } else if (!block.name.startsWith('mcp__lexis__')) {
              project.emit('tool_use', agent, {
                tool: block.name,
                input: summarizeInput(block.input as Record<string, unknown>),
              });
            }
          }
        }
        break;
      }
      case 'user': {
        // Tool results flowing back (including subagent completions).
        const content = message.message.content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (typeof block === 'object' && block !== null && block.type === 'tool_result') {
            const toolUseId = (block as { tool_use_id?: string }).tool_use_id;
            const finishedTask = toolUseId ? this.taskAgents.get(toolUseId) : undefined;
            if (finishedTask) {
              project.emit('task_end', 'orchestrator', { agent: finishedTask });
            }
          }
        }
        break;
      }
      case 'result': {
        // The turn-boundary report is authoritative — drop the live overlay.
        this.liveUsage.clear();
        const turnCostUsd = this.accumulateUsage(message.modelUsage ?? {});
        project.emit('usage', 'orchestrator', {
          turnCostUsd,
          totalCostUsd: project.meta.usage?.totalCostUsd,
          byModel: project.meta.usage?.byModel as unknown as Record<string, unknown>,
          durationMs: message.duration_ms,
          turns: message.num_turns,
          isError: message.is_error,
        });
        // Auto checkpoint at every turn boundary — cheap, and a no-op when
        // nothing changed.
        void saveVersion(project, 'checkpoint (turn end)', true).catch(() => undefined);
        if (this.completedThisTurn) {
          this.completedThisTurn = false;
          project.setStatus('completed');
        } else if (!this.reviewGate) {
          project.setStatus('awaiting_input');
        }
        break;
      }
      default:
        break;
    }
  }
}

function summarizeInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && value.length > 400) {
      out[key] = value.slice(0, 400) + ` … (${value.length} chars)`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

const sessions = new Map<string, OrchestratorSession>();

export function sessionFor(project: Project): OrchestratorSession {
  let session = sessions.get(project.meta.id);
  if (!session) {
    session = new OrchestratorSession(project);
    sessions.set(project.meta.id, session);
  }
  return session;
}
