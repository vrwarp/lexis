import fs from 'node:fs';
import path from 'node:path';
import {
  createSdkMcpServer,
  query,
  tool,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { loadAgents } from './agents.js';
import type { Project } from './projects.js';
import { orchestratorPrompt } from './prompt.js';
import { listVersions, revertToVersion, saveVersion } from './versioning.js';

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
        project.emit('usage', 'orchestrator', {
          costUsd: 'total_cost_usd' in message ? message.total_cost_usd : undefined,
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
