/**
 * The 14 pipeline agents as tools — open-agent's composition pattern
 * (a tool that looks up a named prompt, binds its model, and runs a nested
 * LLM call), made agentic: the nested call is a generateText loop with the
 * agent's file tools and a fresh message array per invocation (the analogue
 * of the Claude SDK's Task and smolagents' managed agents).
 */
import { generateText, stepCountIs, tool, type StepResult, type Tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { ModelFactory } from './config.js';
import { buildFileTools } from './fs-tools.js';
import type { PromptRegistry } from './prompts.js';

export interface SessionHooks {
  emit: (type: string, agent: string, data: Record<string, unknown>) => void;
  trackUsage: (modelId: string, usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }) => void;
  onStepEvents: (agent: string, step: StepResult<ToolSet>) => void;
  currentSignal: () => AbortSignal | undefined;
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
        try {
          const { model, modelId, settings } = factory.resolve(agent.tier, agent.name);
          const result = await generateText({
            model,
            system: registry.finish(agent.name),
            messages: [{ role: 'user', content: task + TASK_REMINDER }],
            tools: fileTools,
            stopWhen: stepCountIs(agent.maxSteps),
            abortSignal: hooks.currentSignal(),
            onStepFinish: step => {
              hooks.trackUsage(modelId, step.usage ?? {});
              hooks.onStepEvents(agent.name, step);
            },
            ...settings,
          });
          const text = result.text?.trim();
          return text || '(subagent finished without a status report — verify its output files on disk)';
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return `Subagent ${agent.name} failed: ${message}`;
        } finally {
          hooks.emit('task_end', 'orchestrator', { agent: agent.name });
        }
      },
    });
  }
  return tools;
}
