import { createSdkMcpServer, tool, type ModelUsage, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { claudeEnv, findClaudeBinary } from './claude.js';
import { type Engine, engineFor } from './engine/engine.js';
import { sandbox } from './engine/runner.js';
import { env } from './env.js';
import type { Project } from './projects.js';
import { assistantPrompt } from './prompt.js';
import { sdk } from './sdk.js';
import type { ChapterStage } from './types.js';
import { saveVersion } from './versioning.js';

const CLAUDE_BINARY = findClaudeBinary();

/**
 * The project's chat: a long-lived interactive session the user talks to
 * from the UI. It reads the workspace, edits the notes, and steers the
 * engine through tools; it does not translate.
 */
export class Assistant {
  readonly project: Project;
  private readonly engine: Engine;
  private q: Query | null = null;
  private queue: SDKUserMessage[] = [];
  private wakeQueue: (() => void) | null = null;
  private closed = false;
  /** Usage is cumulative within one streaming session; deltas against this are what each turn cost. */
  private lastRunUsage: Record<string, ModelUsage> | null = null;

  constructor(project: Project) {
    this.project = project;
    this.engine = engineFor(project);
  }

  get running(): boolean {
    return this.q !== null && !this.closed;
  }

  send(text: string): void {
    this.project.emit('user_message', 'user', { text });
    this.queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null } as SDKUserMessage);
    this.wakeQueue?.();
    if (!this.running) void this.run();
  }

  async interrupt(): Promise<void> {
    await this.q?.interrupt().catch(() => undefined);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.wakeQueue?.();
    await this.q?.interrupt().catch(() => undefined);
    this.q = null;
  }

  private async *inputStream(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      while (this.queue.length > 0) yield this.queue.shift()!;
      await new Promise<void>((resolve) => {
        this.wakeQueue = resolve;
      });
      this.wakeQueue = null;
    }
  }

  private tools() {
    const engine = this.engine;
    const project = this.project;
    const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
    return [
      tool('pipeline_status', 'The state of the run: every chapter and stage, warnings, notes. Call this before describing progress.', {}, async () => text(engine.describeState())),
      tool(
        'rerun_chapters',
        'Re-run chapters from a stage with a note that goes into those agents\' prompts. from: "final" = polish pass applying the note; "critique" = fresh critique then polish; "draft" = full retranslation. The engine runs them like any other work; the book is packaged again afterwards.',
        {
          chapters: z.array(z.string()).describe('Chapter keys, as listed by pipeline_status'),
          from: z.enum(['draft', 'critique', 'final']).describe('The first stage to run again'),
          note: z.string().describe('What the agents should do differently; it is added to the chapter notes'),
        },
        async (args) => {
          const done = await engine.rerunChapters(args.chapters, args.from as ChapterStage, args.note);
          return text(done.length ? `Queued ${done.length} chapter(s) from ${args.from}: ${done.join(', ')}. The user sees them in the matrix.` : 'None of those chapters is in the plan (check the keys with pipeline_status).');
        },
      ),
      tool(
        'set_note',
        'Attach a note to one chapter (or, with no chapter, to the whole project) that every later step sees. Does not re-run anything now.',
        { chapter: z.string().optional().describe('Chapter key; omit for the project-wide instructions'), note: z.string() },
        async (args) => {
          if (args.chapter) {
            const c = engine.chapter(args.chapter);
            if (!c) return text(`No chapter ${args.chapter}.`);
            engine.setChapter(args.chapter, { note: c.note ? `${c.note}\n${args.note}` : args.note });
            return text(`Noted on ${args.chapter}.`);
          }
          engine.setInstructions(project.meta.context ? `${project.meta.context}\n${args.note}` : args.note);
          return text('Added to the project instructions.');
        },
      ),
      tool('save_version', 'Snapshot the whole workspace as a named version the user can inspect and revert to.', { label: z.string() }, async (args) => {
        const v = await saveVersion(project, args.label);
        return text(v ? `Saved version ${v.id.slice(0, 8)}: ${v.label}` : 'No changes since the last version; nothing to save.');
      }),
      tool('pause_run', 'Pause the engine after the steps in flight finish.', {}, async () => {
        engine.pause('paused by the assistant at your request');
        return text(`Run is now ${engine.runState}.`);
      }),
      tool('resume_run', 'Continue a paused run.', {}, async () => {
        engine.resume();
        return text(`Run is now ${engine.runState}.`);
      }),
    ];
  }

  private async run(): Promise<void> {
    const project = this.project;
    this.lastRunUsage = null;
    const tools = this.tools();
    const fileTools = ['Read', 'Glob', 'Grep', 'Edit', 'Write'];
    const resume = project.meta.assistantSessionId;
    const stream = sdk.query(
      {
        prompt: this.inputStream(),
        options: {
          cwd: project.workspace,
          model: env.models.assistant,
          effort: env.effort.assistant as never,
          systemPrompt: assistantPrompt(project.meta),
          tools: fileTools,
          allowedTools: [...fileTools, ...tools.map((t) => `mcp__lexis__${t.name}`)],
          disallowedTools: ['Bash', 'Task', 'Agent', 'WebSearch', 'WebFetch'],
          mcpServers: { lexis: createSdkMcpServer({ name: 'lexis', version: '2.0.0', tools }) },
          hooks: { PreToolUse: sandbox(project.workspace) },
          settingSources: [],
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          env: claudeEnv(),
          ...(CLAUDE_BINARY ? { pathToClaudeCodeExecutable: CLAUDE_BINARY } : {}),
          ...(resume ? { resume } : {}),
          stderr: (data: string) => {
            if (env.debug) console.error(`[assistant:${project.meta.id}]`, data.trimEnd());
          },
        },
      },
      { tools },
    );
    this.q = stream;
    try {
      for await (const message of stream as AsyncIterable<SDKMessage>) this.handle(message);
    } catch (error) {
      project.emit('error', 'assistant', { message: `The assistant stopped: ${String(error)}` });
    } finally {
      this.q = null;
    }
  }

  private handle(message: SDKMessage): void {
    const project = this.project;
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init' && project.meta.assistantSessionId !== message.session_id) {
          project.meta.assistantSessionId = message.session_id;
          project.save();
        }
        break;
      case 'assistant':
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text.trim()) project.emit('agent_text', 'assistant', { text: block.text });
          else if (block.type === 'thinking' && block.thinking?.trim()) project.emit('thinking', 'assistant', { text: block.thinking });
          else if (block.type === 'tool_use') {
            const input = block.input as Record<string, unknown>;
            const shown: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(input ?? {})) shown[k] = typeof v === 'string' && v.length > 400 ? v.slice(0, 400) + ` … (${v.length} chars)` : v;
            project.emit('tool_use', 'assistant', { tool: block.name.replace(/^mcp__lexis__/, ''), input: shown });
          }
        }
        break;
      case 'result': {
        const turnCostUsd = this.accumulate(message.modelUsage ?? {});
        project.emit('usage', 'assistant', {
          turnCostUsd,
          totalCostUsd: project.meta.usage?.totalCostUsd,
          byModel: project.meta.usage?.byModel as unknown as Record<string, unknown>,
          durationMs: message.duration_ms,
          turns: message.num_turns,
          isError: message.is_error,
        });
        if (message.is_error) project.emit('error', 'assistant', { message: ('errors' in message ? message.errors : []).join('; ') || message.subtype });
        break;
      }
      default:
        break;
    }
  }

  private accumulate(snapshot: Record<string, ModelUsage>): number {
    const totals = this.project.meta.usage ?? { byModel: {}, totalCostUsd: 0 };
    let turnCostUsd = 0;
    for (const [model, usage] of Object.entries(snapshot)) {
      const prev = this.lastRunUsage?.[model];
      const d = {
        inputTokens: Math.max(0, usage.inputTokens - (prev?.inputTokens ?? 0)),
        outputTokens: Math.max(0, usage.outputTokens - (prev?.outputTokens ?? 0)),
        cacheReadInputTokens: Math.max(0, usage.cacheReadInputTokens - (prev?.cacheReadInputTokens ?? 0)),
        cacheCreationInputTokens: Math.max(0, usage.cacheCreationInputTokens - (prev?.cacheCreationInputTokens ?? 0)),
        costUsd: Math.max(0, usage.costUSD - (prev?.costUSD ?? 0)),
      };
      const e = totals.byModel[model] ?? { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0 };
      e.inputTokens += d.inputTokens;
      e.outputTokens += d.outputTokens;
      e.cacheReadInputTokens += d.cacheReadInputTokens;
      e.cacheCreationInputTokens += d.cacheCreationInputTokens;
      e.costUsd += d.costUsd;
      totals.byModel[model] = e;
      totals.totalCostUsd += d.costUsd;
      turnCostUsd += d.costUsd;
    }
    this.lastRunUsage = snapshot;
    this.project.meta.usage = totals;
    this.project.save();
    return turnCostUsd;
  }
}

const assistants = new Map<string, Assistant>();

export function assistantFor(project: Project): Assistant {
  let a = assistants.get(project.meta.id);
  if (!a) {
    a = new Assistant(project);
    assistants.set(project.meta.id, a);
  }
  return a;
}
