/**
 * Recovery commands, run inside the container:
 *
 *   docker compose exec lexis node dist/cli.js status
 *   docker compose exec lexis node dist/cli.js signout-all
 *   docker compose exec lexis node dist/cli.js reset-passkeys
 *
 * The password always signs in as a backup, so these are for a lost or stolen
 * device: revoke every session, or forget every passkey, from a shell on the
 * host. The running app picks up the change on its next request.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AuthStore } from './auth/store.js';
import { Trace, render, renderTranscript, summarize, type Section } from './engine/trace.js';
import { env } from './env.js';
import type { PipelineState, ProjectMeta } from './types.js';

const store = new AuthStore(path.join(env.authDir, 'auth.json'));
const [command, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const args = rest.filter((a) => !a.startsWith('--'));

/** A project's files read directly: the CLI never starts the engine. */
function openProject(id: string): { meta: ProjectMeta; state: PipelineState; trace: Trace } | null {
  const dir = path.join(env.projectsDir, id);
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')) as ProjectMeta;
    let state: PipelineState;
    try {
      state = JSON.parse(fs.readFileSync(path.join(dir, 'pipeline.json'), 'utf8')) as PipelineState;
    } catch {
      state = { version: 1, run: { state: 'idle' }, config: { concurrency: 0, maxLoopRounds: 0, maxAttempts: 0, stepTimeoutMs: { translation: 0, mechanical: 0 }, stepBudgetUsd: 0, maxTurns: 0, models: { translation: '', mechanical: '' }, effort: { translation: '', mechanical: '' } }, chapters: [], steps: {}, timings: {}, revisions: [] };
    }
    return { meta, state, trace: new Trace(dir, path.join(dir, 'workspace')) };
  } catch {
    return null;
  }
}

function listProjectsOnDisk(): ProjectMeta[] {
  try {
    return fs
      .readdirSync(env.projectsDir)
      .map((id) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(env.projectsDir, id, 'project.json'), 'utf8')) as ProjectMeta;
        } catch {
          return null;
        }
      })
      .filter((m): m is ProjectMeta => Boolean(m))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } catch {
    return [];
  }
}

async function traceCommand(): Promise<void> {
  const [projectId, section = 'summary', extra] = args;
  if (!projectId) {
    console.log('usage: node dist/cli.js trace <project> [summary|stages|chapters|failures|timeline|prompts|run <runId>|export [file]] [--json]');
    console.log('projects:');
    for (const m of listProjectsOnDisk()) console.log(`  ${m.id}  ${m.name} → ${m.targetLanguage}  (${m.status})${m.series ? `  series: ${m.series} #${m.seriesIndex}` : ''}`);
    return;
  }
  const p = openProject(projectId);
  if (!p) {
    console.error(`no project ${projectId} under ${env.projectsDir}`);
    process.exit(1);
  }
  if (section === 'run') {
    const run = p.trace.runs().find((r) => r.id === extra);
    const records = p.trace.transcript(extra ?? '');
    if (!run && !records.length) {
      console.error('no such run; ids are in `trace <project> failures` and in runs.jsonl');
      process.exit(1);
    }
    if (flags.has('--json')) console.log(JSON.stringify({ run, prompt: p.trace.prompt(extra ?? ''), records }, null, 2));
    else console.log(renderTranscript(records, p.trace.prompt(extra ?? ''), run));
    return;
  }
  if (section === 'export') {
    const out = path.resolve(extra ?? `lexis-trace-${projectId}.tgz`);
    await p.trace.export(out);
    console.log(`wrote ${out}`);
    return;
  }
  const summary = summarize(p.meta, p.state, p.trace);
  if (flags.has('--json')) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  const sections: Section[] = ['summary', 'stages', 'chapters', 'failures', 'timeline', 'prompts'];
  if (!sections.includes(section as Section)) {
    console.error(`unknown section ${section}; one of ${sections.join(', ')}, run <id>, export [file]`);
    process.exit(1);
  }
  console.log(render(summary, section as Section));
}

function status(): void {
  console.log(`password sign-in: ${env.password ? 'on (backup)' : 'off: LEXIS_PASSWORD is not set'}`);
  console.log(`passkeys: ${store.passkeys.length}`);
  for (const p of store.passkeys) console.log(`  - ${p.name} (created ${p.createdAt}, last used ${p.lastUsedAt ?? 'never'})`);
  console.log(`signed-in browsers: ${store.sessions.length}`);
  for (const s of store.sessions) console.log(`  - ${s.method}, last seen ${s.lastSeenAt}, ${s.ip} ${s.userAgent.slice(0, 60)}`);
}

switch (command) {
  case 'status':
    status();
    break;
  case 'trace':
    await traceCommand();
    break;
  case 'series': {
    const by = new Map<string, ProjectMeta[]>();
    for (const m of listProjectsOnDisk()) if (m.series) by.set(m.series, [...(by.get(m.series) ?? []), m]);
    if (!by.size) console.log('no series yet');
    for (const [name, books] of by) {
      console.log(name);
      for (const b of books.sort((x, y) => (x.seriesIndex ?? 0) - (y.seriesIndex ?? 0))) console.log(`  #${b.seriesIndex ?? '?'}  ${b.id}  ${b.name}  (${b.status})${b.inherited ? `  inherited from ${b.inherited.fromName}` : ''}`);
    }
    break;
  }
  case 'signout-all':
    console.log(`signed out ${store.removeSessions(() => true)} browser(s)`);
    break;
  case 'reset-passkeys':
    store.reset();
    console.log('Removed every passkey and signed every browser out.');
    console.log(env.password ? 'Sign in with the password and set up a new passkey.' : 'Set LEXIS_PASSWORD, restart, then sign in and set up a new passkey.');
    break;
  default:
    console.log('usage: node dist/cli.js status | signout-all | reset-passkeys | trace <project> [section] | series');
    process.exit(command ? 1 : 0);
}
