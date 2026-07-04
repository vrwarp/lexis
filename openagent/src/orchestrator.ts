/**
 * The long-lived interactive orchestrator session — the lexis contract on the
 * open-agent substrate (Vercel AI SDK v5).
 *
 * Substrate mapping (see docs/OPENAGENT_ANALYSIS.md):
 * - agent loop                 -> generateText + stopWhen: stepCountIs(cap)
 * - Task subagents             -> nested generateText tools (subagents.ts)
 * - SDK messages -> UiEvents   -> onStepFinish per agent
 * - mid-run user messages      -> inbox drained in prepareStep
 * - context compaction         -> tool-output truncation in old history
 * - session resume             -> persisted ModelMessage[] history
 * - modelUsage/costUSD         -> per-step usage + pricing table
 */
import fs from 'node:fs';
import {
  streamText,
  stepCountIs,
  type ModelMessage,
  type StepResult,
  type ToolSet,
} from 'ai';
import { ModelFactory } from './config.js';
import { buildFileTools } from './fs-tools.js';
import { buildHarnessTools, ReviewGate } from './harness-tools.js';
import type { Project } from './projects.js';
import { orchestratorPrompt } from './prompt.js';
import { PromptRegistry } from './prompts.js';
import { buildSubagentTools, type SessionHooks } from './subagents.js';
import { describeError, logLine } from './diagnostics.js';
import type { ModelUsageTotals, UsageTotals } from './types.js';
import { saveVersion } from './versioning.js';

const ORCH_MAX_STEPS = Number(process.env.LEXIS_OA_ORCH_MAX_STEPS ?? 500);
/** History entries beyond this recency window get their tool outputs truncated. */
const PRUNE_KEEP_RECENT = Number(process.env.LEXIS_OA_KEEP_RECENT_MESSAGES ?? 40);
const PRUNE_OUTPUT_CHARS = Number(process.env.LEXIS_OA_PRUNED_OUTPUT_CHARS ?? 1500);
const USAGE_EMIT_INTERVAL_MS = 10_000;
/** Abort the turn after this many consecutive subagent failures (a dead model
 * would otherwise make the orchestrator grind to ORCH_MAX_STEPS silently). */
const FAILFAST_THRESHOLD = Number(process.env.LEXIS_OA_FAILFAST ?? 4);
/** Per-step console logging (turn/subagent/error lines are always logged). */
const DEBUG = Boolean(process.env.LEXIS_OA_DEBUG);

const HARNESS_TOOL_NAMES = new Set([
  'report_progress',
  'save_version',
  'list_versions',
  'revert_version',
  'request_review',
  'mark_complete',
]);

const emptyModelTotals = (): ModelUsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  costUsd: 0,
});

function summarizeInput(input: unknown): unknown {
  if (typeof input === 'string') {
    return input.length > 400 ? input.slice(0, 400) + ` … (${input.length} chars)` : input;
  }
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      out[key] = typeof value === 'string' && value.length > 400
        ? value.slice(0, 400) + ` … (${value.length} chars)`
        : value;
    }
    return out;
  }
  return input;
}

export class OrchestratorSession {
  readonly project: Project;
  private readonly factory: ModelFactory;
  private readonly registry: PromptRegistry;
  private readonly gate = new ReviewGate();
  private inbox: string[] = [];
  private history: ModelMessage[] = [];
  private loopRunning = false;
  private closed = false;
  private completedThisTurn = false;
  private abortController: AbortController | null = null;
  private subagentNames: Set<string>;
  private lastUsageEmit = 0;
  private consecutiveFailures = 0;
  private abortReason: string | null = null;

  constructor(project: Project, factory?: ModelFactory, registry?: PromptRegistry) {
    this.project = project;
    this.factory = factory ?? new ModelFactory();
    this.registry = registry ?? new PromptRegistry();
    this.subagentNames = new Set(this.registry.names());
    this.restoreHistory();
  }

  get running(): boolean {
    return this.loopRunning;
  }

  get awaitingReview(): boolean {
    return this.gate.pending;
  }

  /** Push a user message into the live session (starting it if needed). */
  send(text: string): void {
    this.project.emit('user_message', 'user', { text });
    this.inbox.push(text);
    if (!this.loopRunning) {
      void this.runLoop();
    } else {
      this.project.setStatus('running');
    }
  }

  resolveReview(decision: 'approve' | 'revise', instructions?: string): boolean {
    if (!this.gate.pending) return false;
    this.project.emit('review_response', 'user', { decision, instructions });
    return this.gate.resolve(
      decision === 'approve'
        ? 'APPROVED — proceed with packaging.'
        : `REVISION REQUESTED — do not package yet. The user's instructions:\n\n${instructions ?? '(none given)'}\n\nApply these, save a version, then call request_review again.`,
    );
  }

  interrupt(): void {
    this.abortController?.abort();
    this.gate.abort();
  }

  close(): void {
    this.closed = true;
    this.interrupt();
  }

  // ---------- the session loop ----------

  private async runLoop(): Promise<void> {
    this.loopRunning = true;
    try {
      while (this.inbox.length > 0 && !this.closed) {
        const task = this.inbox.shift()!;
        await this.runTurn(task);
      }
    } finally {
      this.loopRunning = false;
    }
  }

  private async runTurn(task: string): Promise<void> {
    const project = this.project;
    project.setStatus('running');
    this.completedThisTurn = false;
    this.abortController = new AbortController();
    this.consecutiveFailures = 0;
    this.abortReason = null;
    const injected: string[] = [];
    logLine('turn-start', `${project.meta.id}: ${task.replace(/\s+/g, ' ').slice(0, 100)}`);

    this.pruneHistory();
    this.history.push({ role: 'user', content: task });

    const hooks: SessionHooks = {
      emit: (type, agent, data) => project.emit(type as never, agent, data),
      trackUsage: (modelId, usage) => this.trackUsage(modelId, usage),
      onStepEvents: (agent, step) => this.emitStepEvents(agent, step),
      currentSignal: () => this.abortController?.signal,
      reportOutcome: (agent, ok, detail) => this.reportSubagentOutcome(agent, ok, detail),
    };

    const tools = {
      ...buildFileTools(project.workspace, ['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'bash']),
      ...buildHarnessTools(project, this.gate, () => {
        this.completedThisTurn = true;
      }),
      ...buildSubagentTools(project.workspace, this.registry, this.factory, hooks),
    };

    try {
      const { model, modelId, settings } = this.factory.resolve('orchestrator', 'orchestrator');
      const result = streamText({
        model,
        system: orchestratorPrompt(project.meta),
        messages: this.history,
        tools,
        stopWhen: stepCountIs(ORCH_MAX_STEPS),
        abortSignal: this.abortController.signal,
        maxRetries: 0, // the resilient fetch (config.ts) owns retry/backoff
        // Mid-run steering: queued user messages join the conversation before
        // the next step (a capability open-agent's own chat does not have).
        prepareStep: ({ messages }) => {
          if (this.inbox.length === 0) return {};
          const drained = this.inbox.splice(0, this.inbox.length);
          injected.push(...drained);
          return {
            messages: [
              ...messages,
              ...drained.map(text => ({
                role: 'user' as const,
                content: `[New user message received mid-run — fold it into your plan now]\n${text}`,
              })),
            ],
          };
        },
        onStepFinish: step => {
          this.trackUsage(modelId, step.usage ?? {});
          this.emitStepEvents('orchestrator', step);
        },
        ...settings,
      });

      // Awaiting result.text drives the stream to completion (firing onStepFinish
      // and prepareStep along the way); result.response is resolved by then.
      const finalText = (await result.text)?.trim();
      const response = await result.response;
      this.history.push(...(response.messages as ModelMessage[]));
      // Injected messages were seen mid-run via prepareStep; keep their content
      // in the persisted transcript for future turns (position approximated).
      for (const text of injected) {
        this.history.push({ role: 'user', content: `[Mid-run message, already handled above]\n${text}` });
        this.history.push({ role: 'assistant', content: '(acknowledged mid-run)' });
      }

      if (finalText) project.emit('agent_text', 'orchestrator', { text: finalText });
    } catch (error) {
      if (this.abortReason) {
        // A fail-fast abort we triggered ourselves — surface the real reason.
        logLine('turn-aborted', this.abortReason);
        project.setStatus('error', this.abortReason);
        project.emit('error', 'orchestrator', { message: this.abortReason });
      } else if (this.abortController.signal.aborted) {
        logLine('turn-interrupted', project.meta.id);
        project.emit('status', 'orchestrator', { status: 'interrupted', detail: 'Run interrupted.' });
      } else {
        const message = describeError(error);
        logLine('turn-error', message);
        if (DEBUG) console.error(error);
        project.setStatus('error', message);
        project.emit('error', 'orchestrator', { message });
      }
    } finally {
      this.abortController = null;
      // Auto checkpoint at every turn boundary — cheap, and a no-op when
      // nothing changed.
      await saveVersion(project, 'checkpoint (turn end)', true).catch(() => undefined);
      this.persistHistory();
      this.emitUsage(true);
      if (project.meta.status === 'running' || project.meta.status === 'awaiting_review') {
        if (this.completedThisTurn) {
          project.setStatus('completed');
        } else if (this.inbox.length === 0) {
          project.setStatus('awaiting_input');
        }
      }
    }
  }

  // ---------- fail-fast ----------

  /** Called by each subagent tool with its outcome. Repeated failures abort the
   * turn instead of letting the orchestrator grind to ORCH_MAX_STEPS silently. */
  private reportSubagentOutcome(agent: string, ok: boolean, detail: string): void {
    if (ok) {
      this.consecutiveFailures = 0;
      return;
    }
    this.consecutiveFailures += 1;
    logLine('subagent-fail', `${agent} (${this.consecutiveFailures}/${FAILFAST_THRESHOLD}): ${detail}`);
    // Surface every subagent failure to the UI immediately (previously these were
    // buried in the orchestrator's tool observation and never shown).
    this.project.emit('error', agent, { message: detail });
    if (this.consecutiveFailures >= FAILFAST_THRESHOLD) {
      this.abortReason =
        `Stopped after ${this.consecutiveFailures} consecutive subagent failures. Last error: ${detail}`;
      this.abortController?.abort();
    }
  }

  // ---------- events ----------

  private emitStepEvents(agent: string, step: StepResult<ToolSet>): void {
    const project = this.project;
    if (DEBUG) {
      const tools = (step.toolCalls ?? []).map(c => c.toolName).join(', ') || '—';
      logLine('step', `${agent}: tools[${tools}] tok=${step.usage?.totalTokens ?? '?'}`);
    }
    const text = step.text?.trim();
    if (text) project.emit('agent_text', agent, { text });
    if (step.reasoningText?.trim()) {
      project.emit('thinking', agent, { text: step.reasoningText.trim().slice(0, 4000) });
    }
    for (const call of step.toolCalls ?? []) {
      const isOrchestrator = agent === 'orchestrator';
      if (isOrchestrator && (this.subagentNames.has(call.toolName) || HARNESS_TOOL_NAMES.has(call.toolName))) {
        continue; // dedicated task_start/progress/version/review events cover these
      }
      project.emit('tool_use', agent, { tool: call.toolName, input: summarizeInput(call.input) });
    }
  }

  // ---------- usage & cost ----------

  private trackUsage(
    modelId: string,
    usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number },
  ): void {
    const meta = this.project.meta;
    const totals: UsageTotals = meta.usage ?? { byModel: {}, totalCostUsd: 0 };
    const entry = totals.byModel[modelId] ?? emptyModelTotals();
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const cached = usage.cachedInputTokens ?? 0;
    entry.inputTokens += Math.max(0, inputTokens - cached);
    entry.cacheReadInputTokens += cached;
    entry.outputTokens += outputTokens;
    const price = this.factory.pricePerMTok(modelId);
    let stepCost = 0;
    if (price) {
      // Cached input billed at 10% of the input rate (Anthropic/OpenAI convention).
      stepCost =
        (Math.max(0, inputTokens - cached) * price[0] + cached * price[0] * 0.1 + outputTokens * price[1]) /
        1_000_000;
    }
    entry.costUsd += stepCost;
    totals.byModel[modelId] = entry;
    totals.totalCostUsd += stepCost;
    meta.usage = totals;
    this.emitUsage();
  }

  private emitUsage(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastUsageEmit < USAGE_EMIT_INTERVAL_MS) return;
    this.lastUsageEmit = now;
    this.project.save();
    const totals = this.project.meta.usage ?? { byModel: {}, totalCostUsd: 0 };
    this.project.emit('usage', 'orchestrator', {
      byModel: totals.byModel as unknown as Record<string, unknown>,
      totalCostUsd: totals.totalCostUsd,
      estimated: true,
      live: !force,
    });
  }

  // ---------- bounded memory & persistence ----------

  /** Truncate old tool outputs; durable state lives in notes/ on disk. */
  private pruneHistory(): void {
    const cutoff = Math.max(0, this.history.length - PRUNE_KEEP_RECENT);
    for (let i = 0; i < cutoff; i++) {
      const message = this.history[i];
      if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (
          part.type === 'tool-result' &&
          part.output &&
          typeof part.output === 'object' &&
          'type' in part.output &&
          part.output.type === 'text' &&
          typeof part.output.value === 'string' &&
          part.output.value.length > PRUNE_OUTPUT_CHARS
        ) {
          part.output.value =
            part.output.value.slice(0, PRUNE_OUTPUT_CHARS) +
            '\n… (older observation truncated — re-read workspace files if you need the details)';
        }
      }
    }
  }

  private persistHistory(): void {
    try {
      fs.writeFileSync(this.project.historyFile, JSON.stringify(this.history));
    } catch {
      // history persistence must never break a turn
    }
  }

  private restoreHistory(): void {
    try {
      if (fs.existsSync(this.project.historyFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.project.historyFile, 'utf8'));
        if (Array.isArray(parsed)) this.history = parsed as ModelMessage[];
      }
    } catch {
      this.history = [];
    }
  }
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

/** Existing session or undefined — for read-only paths that must not pay for
 * (or fail on) model construction. */
export function peekSession(project: Project): OrchestratorSession | undefined {
  return sessions.get(project.meta.id);
}
