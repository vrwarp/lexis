/**
 * Harness contract tools — port of the in-process MCP server of the Claude
 * harness (report_progress, save_version, list_versions, revert_version,
 * request_review, mark_complete) as AI SDK tool()s.
 *
 * `request_review.execute` awaits a promise resolved by the HTTP layer; the
 * AI SDK loop awaits tool execution, so the run blocks mid-turn exactly like
 * the other harnesses' review gates.
 */
import fs from 'node:fs';
import path from 'node:path';
import { tool, type Tool } from 'ai';
import { z } from 'zod';
import type { Project } from './projects.js';
import { PHASES } from './types.js';
import { listVersions, revertToVersion, saveVersion } from './versioning.js';

export class ReviewGate {
  private resolver: ((answer: string) => void) | null = null;

  get pending(): boolean {
    return this.resolver !== null;
  }

  wait(): Promise<string> {
    return new Promise<string>(resolve => {
      this.resolver = resolve;
    });
  }

  resolve(answer: string): boolean {
    if (!this.resolver) return false;
    const resolver = this.resolver;
    this.resolver = null;
    resolver(answer);
    return true;
  }

  abort(): void {
    this.resolve('Session is shutting down; stop.');
  }
}

export function buildHarnessTools(
  project: Project,
  gate: ReviewGate,
  onComplete: () => void,
): Record<string, Tool> {
  return {
    report_progress: tool({
      description:
        'Report structured pipeline progress to the user interface. Call whenever a phase or chapter ' +
        `changes state. Phases: ${PHASES.join(', ')}.`,
      inputSchema: z.object({
        phase: z.enum(PHASES),
        state: z.enum(['started', 'completed', 'failed']),
        chapter: z.string().optional().describe('The chapter filename, when chapter-scoped'),
        detail: z.string().optional(),
      }),
      execute: async args => {
        project.emit('progress', 'orchestrator', args);
        return 'ok';
      },
    }),

    save_version: tool({
      description: 'Snapshot the entire workspace as a named version the user can inspect and revert to.',
      inputSchema: z.object({
        label: z.string().describe('Short human-readable label for this version'),
      }),
      execute: async ({ label }) => {
        const version = await saveVersion(project, label);
        return version
          ? `Saved version ${version.id.slice(0, 8)}: ${version.label}`
          : 'No changes since the last version; nothing to save.';
      },
    }),

    list_versions: tool({
      description: 'List all saved workspace versions, newest first.',
      inputSchema: z.object({}),
      execute: async () => {
        const versions = await listVersions(project);
        if (!versions.length) return 'No versions yet.';
        return versions
          .map(v => `${v.id.slice(0, 8)}  ${v.date}  ${v.label}${v.auto ? ' (auto)' : ''}`)
          .join('\n');
      },
    }),

    revert_version: tool({
      description:
        'Restore the workspace to a previous version. The current state is snapshotted first, so this is non-destructive.',
      inputSchema: z.object({
        id: z.string().describe('Version id (full or abbreviated commit hash)'),
      }),
      execute: async ({ id }) => {
        const version = await revertToVersion(project, id);
        return `Workspace restored. New version ${version.id.slice(0, 8)}: ${version.label}. Re-read the workspace before continuing.`;
      },
    }),

    request_review: tool({
      description:
        'MANDATORY before packaging. Presents your summary to the user and blocks until they approve or ' +
        'send revision instructions. Returns the decision.',
      inputSchema: z.object({
        summary: z
          .string()
          .describe('What was translated, glossary/consistency notes, notable challenges, open questions'),
      }),
      execute: async ({ summary }) => {
        const answer = gate.wait();
        project.emit('review_request', 'orchestrator', { summary });
        project.setStatus('awaiting_review');
        const result = await answer;
        project.setStatus('running');
        return result;
      },
    }),

    mark_complete: tool({
      description: 'Record that the translated EPUB has been produced. Call exactly once per successful packaging.',
      inputSchema: z.object({
        epub_path: z.string().describe('Path to the produced .epub, relative to the project root'),
        summary: z.string().describe('One-paragraph completion summary for the user'),
      }),
      execute: async ({ epub_path, summary }) => {
        const abs = path.resolve(project.workspace, epub_path);
        if (abs !== project.workspace && !abs.startsWith(project.workspace + path.sep)) {
          return 'Error: path escapes the workspace.';
        }
        if (!fs.existsSync(abs) || fs.statSync(abs).size < 1024) {
          return `No plausible EPUB found at ${epub_path} — verify packaging actually succeeded.`;
        }
        project.meta.outputPath = path.relative(project.workspace, abs);
        project.save();
        onComplete();
        project.emit('progress', 'orchestrator', { phase: 'done', state: 'completed', detail: summary });
        return 'Completion recorded.';
      },
    }),
  };
}
