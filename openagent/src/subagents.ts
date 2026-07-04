/**
 * The 14 pipeline agents as tools — open-agent's composition pattern
 * (a tool that looks up a named prompt, binds its model, and runs a nested
 * LLM call), made agentic: the nested call is a generateText loop with the
 * agent's file tools and a fresh message array per invocation (the analogue
 * of the Claude SDK's Task and smolagents' managed agents).
 */
import { streamText, stepCountIs, tool, type StepResult, type Tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { ModelFactory } from './config.js';
import { describeError } from './diagnostics.js';
import { buildFileTools, diffWritten, humanSize, snapshotWorkspace, type FileStamp } from './fs-tools.js';
import type { PromptRegistry } from './prompts.js';

/** A deterministic, harness-computed statement of what the subagent actually
 * wrote — appended to every subagent result so the orchestrator relies on
 * ground truth, not the model's (often garbled or absent) self-report. */
function filesWrittenReport(written: string[], after: Map<string, FileStamp>): string {
  if (written.length === 0) {
    return (
      'Files written this run: NONE. The subagent wrote no files. If it was supposed to produce output, ' +
      're-dispatch it once with clearer inputs, or skip this item and note it — do NOT try alternate ' +
      'output-path spellings; each agent writes to a fixed path defined by its role.'
    );
  }
  const MAX = 15;
  const shown = written.slice(0, MAX).map(p => `${p} (${humanSize(after.get(p)?.size ?? 0)})`);
  const extra = written.length > MAX ? `, +${written.length - MAX} more` : '';
  return `Files written this run: ${shown.join(', ')}${extra}`;
}

export interface SessionHooks {
  emit: (type: string, agent: string, data: Record<string, unknown>) => void;
  trackUsage: (modelId: string, usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }) => void;
  onStepEvents: (agent: string, step: StepResult<ToolSet>) => void;
  currentSignal: () => AbortSignal | undefined;
  /** Report each subagent invocation's outcome so the session can fail fast. */
  reportOutcome: (agent: string, ok: boolean, detail: string) => void;
}

const TASK_REMINDER =
  '\n\nReminder: you are a subagent in the lexis translation pipeline. Do the work by reading and writing ' +
  'workspace files exactly as your role instructions specify. When the work is done, reply with a concise ' +
  'status report: what you produced or verified, the exact output file paths, and any warnings. Do not paste ' +
  'whole file contents into your reply.';

export function buildSubagentTools(
  workspace: string,
  registry: PromptRegistry,
  factory: ModelFactory,
  hooks: SessionHooks,
): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  for (const agent of registry.all()) {
    const fileTools = buildFileTools(workspace, agent.tools);
    tools[agent.name] = tool({
      description: `${agent.description} Provide a complete task description: the exact chapter file, inputs to read, outputs to write, and any user guidance.`,
      inputSchema: z.object({
        task: z.string().describe('Long detailed description of the task for this agent'),
      }),
      execute: async ({ task }) => {
        hooks.emit('task_start', 'orchestrator', {
          agent: agent.name,
          description: String(task).slice(0, 300),
        });
        const before = snapshotWorkspace(workspace);
        // streamText (not generateText): the response streams token-by-token, so
        // the resilient fetch's idle timeout keeps a slow reasoning generation
        // alive as long as it is producing output, instead of a hard total-time
        // cap that kills long reasoning outputs (see diagnostics.ts).
        const runOnce = async (): Promise<string> => {
          const { model, modelId, settings } = factory.resolve(agent.tier, agent.name);
          const result = streamText({
            model,
            system: registry.finish(agent.name),
            messages: [{ role: 'user', content: task + TASK_REMINDER }],
            tools: fileTools,
            stopWhen: stepCountIs(agent.maxSteps),
            abortSignal: hooks.currentSignal(),
            maxRetries: 0, // the resilient fetch (config.ts) owns retry/backoff
            onStepFinish: step => {
              hooks.trackUsage(modelId, step.usage ?? {});
              hooks.onStepEvents(agent.name, step);
            },
            ...settings,
          });
          return (await result.text)?.trim() ?? '';
        };
        try {
          let text = await runOnce();
          let after = snapshotWorkspace(workspace);
          let written = diffWritten(before, after);
          // A run that touched no files AND returned no status text is almost
          // always a transient model garble (e.g. a free reasoning model emits a
          // tool call as plain text so it never executes). Retry once before
          // giving up, so one bad roll of the dice doesn't strand the pipeline.
          if (written.length === 0 && !text) {
            hooks.emit('task_retry', 'orchestrator', { agent: agent.name });
            text = await runOnce();
            after = snapshotWorkspace(workspace);
            written = diffWritten(before, after);
          }
          const ok = written.length > 0 || text.length > 0;
          hooks.reportOutcome(
            agent.name,
            ok,
            ok ? '' : `${agent.name}: produced no output files and no status report (the model likely garbled its tool calls)`,
          );
          const body = text || '(the subagent returned no status text)';
          return `${body}\n\n${filesWrittenReport(written, after)}`;
        } catch (error) {
          const message = describeError(error);
          hooks.reportOutcome(agent.name, false, `${agent.name}: ${message}`);
          return `Subagent ${agent.name} failed: ${message}`;
        } finally {
          hooks.emit('task_end', 'orchestrator', { agent: agent.name });
        }
      },
    });
  }
  return tools;
}
