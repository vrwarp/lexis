import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { countWords, textOf } from '../epub.js';
import type { AgentRun, PipelineState, ProjectMeta } from '../types.js';
import type { Check } from './steps.js';

const execFileAsync = promisify(execFile);

/**
 * The trace: a complete, append-only record of a project's run, kept so a
 * failure can be explained afterwards and the pipeline improved from
 * evidence. docs/ANALYSIS.md describes it for people; this file is the
 * format.
 *
 *   trace/meta.json              versions and settings
 *   trace/runs.jsonl             one RunRecord per agent run (the index)
 *   trace/timeline.jsonl         engine events (TimelineRecord)
 *   trace/runs/<id>/prompt.md    the task prompt
 *   trace/runs/<id>/transcript.jsonl  TranscriptRecord lines
 *   trace/blobs/<sha256>         input and output file contents, deduplicated
 *   trace/agents/<name>-<hash>.md each agent prompt version that ran
 */

export const TRACE_FORMAT = 1;

/** A file as it was at a moment: content-addressed. */
export interface FileRef {
  path: string;
  hash: string;
  size: number;
  /** For outputs: the hash the file had before the run (absent when it did not exist). */
  prevHash?: string;
  /** For outputs: whether the run changed the file. */
  changed?: boolean;
  metrics?: TextMetrics;
}

/** Shape of a document's text, for sanity checks that need no model. */
export interface TextMetrics {
  chars: number;
  words: number;
  paragraphs: number;
  /** Letters by script, as a share of all letters. */
  scripts: Record<string, number>;
}

export interface RunRecord {
  v: typeof TRACE_FORMAT;
  id: string;
  step: string;
  stage: string;
  chapter?: string;
  chapterTitle?: string;
  chapterWords?: number;
  agent: string;
  /** Hash of the agent's system prompt (the file in trace/agents/). */
  agentPrompt: string;
  mode: string;
  round: number;
  attempt: number;
  model: string;
  effort: string;
  config: { maxTurns: number; budgetUsd: number; timeoutMs: number; concurrency: number };
  startedAt: string;
  endedAt: string;
  durationMs: number;
  apiMs?: number;
  turns?: number;
  outcome: string;
  error?: string;
  resetsAt?: number;
  check: Check | null;
  usage: { byModel: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUsd: number }>; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number };
  tools: Record<string, number>;
  denials: number;
  retries: number;
  stderrLines: number;
  inputs: FileRef[];
  outputs: FileRef[];
  reply?: string;
  claudeCodeVersion?: string;
  sessionId?: string;
}

export type TranscriptRecord = { t: string } & (
  | { kind: 'init'; model: string; claudeCodeVersion?: string; tools?: string[]; sessionId?: string }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; id: string; tool: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError?: boolean; truncated?: boolean }
  | { kind: 'api_retry'; attempt: number; maxRetries: number; delayMs: number; status: number | null; error: string }
  | { kind: 'rate_limit'; info: unknown }
  | { kind: 'result'; subtype: string; isError: boolean; turns: number; durationMs: number; apiMs?: number; errors: string[]; usage: unknown; denials: unknown[] }
  | { kind: 'stderr'; line: string }
  | { kind: 'error'; message: string }
  | { kind: 'check'; check: Check }
);

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A transcript record before the trace stamps the time on it. */
export type TranscriptInput = DistributiveOmit<TranscriptRecord, 't'>;

export interface TimelineRecord {
  t: string;
  kind: string;
  [key: string]: unknown;
}

/** Tool results are kept whole up to this size; a chapter read is well under it. */
const RESULT_CAP = 64 * 1024;

export const sha256 = (data: string | Buffer): string => crypto.createHash('sha256').update(data).digest('hex');

const SCRIPTS: [string, RegExp][] = [
  ['latin', /\p{Script=Latin}/gu],
  ['han', /\p{Script=Han}/gu],
  ['kana', /[\p{Script=Hiragana}\p{Script=Katakana}]/gu],
  ['hangul', /\p{Script=Hangul}/gu],
  ['cyrillic', /\p{Script=Cyrillic}/gu],
  ['arabic', /\p{Script=Arabic}/gu],
  ['greek', /\p{Script=Greek}/gu],
];

export function textMetrics(content: string, isHtml = /<html\b|<body\b|<p\b/i.test(content)): TextMetrics {
  const text = isHtml ? textOf(content) : content;
  const letters = (text.match(/\p{L}/gu) ?? []).length || 1;
  const scripts: Record<string, number> = {};
  let counted = 0;
  for (const [name, re] of SCRIPTS) {
    const n = (text.match(re) ?? []).length;
    if (n) scripts[name] = Math.round((n / letters) * 1000) / 1000;
    counted += n;
  }
  if (letters - counted > 0) scripts.other = Math.round(((letters - counted) / letters) * 1000) / 1000;
  const paragraphs = isHtml ? (content.match(/<p\b/gi) ?? []).length : content.split(/\n\s*\n/).filter((s) => s.trim()).length;
  return { chars: text.length, words: countWords(text), paragraphs, scripts };
}

/** Records one agent run's transcript as it happens; `finish` writes the index record. */
export class RunTracer {
  private readonly file: string;
  readonly tools: Record<string, number> = {};
  denials = 0;
  retries = 0;
  stderrLines = 0;
  claudeCodeVersion?: string;
  sessionId?: string;
  apiMs?: number;
  reply?: string;

  constructor(
    private readonly trace: Trace,
    readonly runId: string,
    readonly inputs: FileRef[],
    private readonly outputPaths: string[],
    private readonly before: Map<string, string | undefined>,
  ) {
    this.file = path.join(trace.dir, 'runs', runId, 'transcript.jsonl');
  }

  record(rec: TranscriptInput): void {
    const full = { t: new Date().toISOString(), ...rec } as TranscriptRecord;
    switch (full.kind) {
      case 'tool_use':
        this.tools[full.tool] = (this.tools[full.tool] ?? 0) + 1;
        break;
      case 'api_retry':
        this.retries++;
        break;
      case 'stderr':
        this.stderrLines++;
        break;
      case 'init':
        this.claudeCodeVersion = full.claudeCodeVersion;
        this.sessionId = full.sessionId;
        break;
      case 'result':
        this.denials = Array.isArray(full.denials) ? full.denials.length : 0;
        this.apiMs = full.apiMs;
        break;
      case 'tool_result':
        if (full.content.length > RESULT_CAP) {
          full.content = full.content.slice(0, RESULT_CAP);
          full.truncated = true;
        }
        break;
      case 'text':
        this.reply = full.text.slice(0, 600);
        break;
      default:
        break;
    }
    fs.appendFileSync(this.file, JSON.stringify(full) + '\n');
  }

  /** Snapshot the outputs as they are now and write the run's index record. */
  finish(base: Omit<RunRecord, 'v' | 'id' | 'tools' | 'denials' | 'retries' | 'stderrLines' | 'inputs' | 'outputs' | 'reply' | 'claudeCodeVersion' | 'sessionId' | 'apiMs'>): RunRecord {
    const outputs = this.trace.snapshot(this.outputPaths, true).map((f) => {
      const prevHash = this.before.get(f.path);
      return { ...f, prevHash, changed: prevHash !== f.hash };
    });
    const record: RunRecord = {
      ...base,
      v: TRACE_FORMAT,
      id: this.runId,
      apiMs: this.apiMs,
      tools: this.tools,
      denials: this.denials,
      retries: this.retries,
      stderrLines: this.stderrLines,
      inputs: this.inputs,
      outputs,
      reply: this.reply,
      claudeCodeVersion: this.claudeCodeVersion,
      sessionId: this.sessionId,
    };
    fs.appendFileSync(path.join(this.trace.dir, 'runs.jsonl'), JSON.stringify(record) + '\n');
    return record;
  }
}

export class Trace {
  readonly dir: string;

  constructor(
    readonly projectDir: string,
    readonly workspace: string,
  ) {
    this.dir = path.join(projectDir, 'trace');
  }

  /** Create the folders and write meta.json once. */
  ensure(meta: ProjectMeta, config: PipelineState['config']): void {
    for (const d of ['', 'runs', 'blobs', 'agents']) fs.mkdirSync(path.join(this.dir, d), { recursive: true });
    const metaFile = path.join(this.dir, 'meta.json');
    if (fs.existsSync(metaFile)) return;
    fs.writeFileSync(
      metaFile,
      JSON.stringify(
        {
          v: TRACE_FORMAT,
          project: { id: meta.id, name: meta.name, targetLanguage: meta.targetLanguage, series: meta.series, inheritFrom: meta.inheritFrom },
          createdAt: new Date().toISOString(),
          lexis: appVersion(),
          agentSdk: sdkVersion(),
          node: process.version,
          config,
        },
        null,
        2,
      ),
    );
  }

  /** Store content by hash; returns the hash. */
  putBlob(content: Buffer | string): string {
    const hash = sha256(content);
    const file = path.join(this.dir, 'blobs', hash);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    return hash;
  }

  blob(hash: string): Buffer | null {
    try {
      return fs.readFileSync(path.join(this.dir, 'blobs', hash));
    } catch {
      return null;
    }
  }

  /** Files as they are now (those that exist), stored as blobs. `withMetrics` adds text metrics for documents. */
  snapshot(paths: string[], withMetrics = false): FileRef[] {
    const refs: FileRef[] = [];
    for (const rel of paths) {
      const abs = path.join(this.workspace, rel);
      let content: Buffer;
      try {
        content = fs.readFileSync(abs);
      } catch {
        continue;
      }
      const ref: FileRef = { path: rel, hash: this.putBlob(content), size: content.length };
      if (withMetrics && /\.(x?html?|txt|md)$/i.test(rel)) ref.metrics = textMetrics(content.toString('utf8'));
      refs.push(ref);
    }
    return refs;
  }

  /** The hash a file has right now, or undefined when it does not exist. */
  hashOf(rel: string): string | undefined {
    try {
      return sha256(fs.readFileSync(path.join(this.workspace, rel)));
    } catch {
      return undefined;
    }
  }

  /** Keep an agent prompt version; returns its hash. */
  agentPrompt(name: string, text: string): string {
    const hash = sha256(text);
    const file = path.join(this.dir, 'agents', `${name}-${hash.slice(0, 12)}.md`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, text);
    return hash;
  }

  /** Begin recording a run: its prompt now, the inputs as they are now, the outputs' current hashes for change detection. */
  beginRun(run: AgentRun, prompt: string, inputPaths: string[], outputPaths: string[]): RunTracer {
    const dir = path.join(this.dir, 'runs', run.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'prompt.md'), prompt);
    const before = new Map(outputPaths.map((p) => [p, this.hashOf(p)]));
    return new RunTracer(this, run.id, this.snapshot(inputPaths, true), outputPaths, before);
  }

  timeline(kind: string, data: Record<string, unknown> = {}): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(path.join(this.dir, 'timeline.jsonl'), JSON.stringify({ t: new Date().toISOString(), kind, ...data }) + '\n');
  }

  // ---------- reading ----------

  prompt(runId: string): string | null {
    try {
      return fs.readFileSync(path.join(this.dir, 'runs', runId, 'prompt.md'), 'utf8');
    } catch {
      return null;
    }
  }

  transcript(runId: string): TranscriptRecord[] {
    return readJsonl<TranscriptRecord>(path.join(this.dir, 'runs', runId, 'transcript.jsonl'));
  }

  runs(): RunRecord[] {
    return readJsonl<RunRecord>(path.join(this.dir, 'runs.jsonl'));
  }

  timelineRecords(): TimelineRecord[] {
    return readJsonl<TimelineRecord>(path.join(this.dir, 'timeline.jsonl'));
  }

  meta(): Record<string, unknown> | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, 'meta.json'), 'utf8')) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /** A .tgz of the trace plus the project's state files, for handing over. */
  async export(outPath: string): Promise<void> {
    const entries = ['trace', 'pipeline.json', 'project.json', 'events.jsonl'].filter((e) => fs.existsSync(path.join(this.projectDir, e)));
    await execFileAsync('tar', ['czf', outPath, '-C', this.projectDir, ...entries]);
  }
}

function readJsonl<T>(file: string): T[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // a line cut short by a crash
    }
  }
  return out;
}

let versions: { app?: string; sdk?: string } = {};
function appVersion(): string | undefined {
  if (versions.app !== undefined) return versions.app;
  try {
    versions.app = (JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? '';
  } catch {
    versions.app = '';
  }
  return versions.app;
}
function sdkVersion(): string | undefined {
  if (versions.sdk !== undefined) return versions.sdk;
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve('@anthropic-ai/claude-agent-sdk');
    let dir = path.dirname(entry);
    for (let i = 0; i < 4; i++) {
      const pkg = path.join(dir, 'package.json');
      if (fs.existsSync(pkg)) {
        const parsed = JSON.parse(fs.readFileSync(pkg, 'utf8')) as { name?: string; version?: string };
        if (parsed.name === '@anthropic-ai/claude-agent-sdk') {
          versions.sdk = parsed.version ?? '';
          return versions.sdk;
        }
      }
      dir = path.dirname(dir);
    }
  } catch {
    // not installed as a package (tests may stub it)
  }
  versions.sdk = '';
  return versions.sdk;
}

// ---------- analysis ----------

export interface ModeStats {
  mode: string;
  agent: string;
  runs: number;
  ok: number;
  rejected: number;
  failed: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  apiShare: number | null;
  turnsMean: number | null;
  toolsMean: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheHit: number;
  costUsd: number;
}

export interface ChapterStats {
  key: string;
  title: string;
  words: number;
  excluded: boolean;
  runs: number;
  durationMs: number;
  costUsd: number;
  costPer1k: number | null;
  msPer1k: number | null;
  draftRounds: number;
  strayRounds: number;
  verify: string;
  expansion: number | null;
  scripts: Record<string, number> | null;
  warnings: string[];
}

export interface Summary {
  project: { id: string; name: string; targetLanguage: string; series?: string; inheritFrom?: string; chapters: number; included: number; words: number };
  versions: { lexis?: string; agentSdk?: string; claudeCode?: string };
  run: { state: string; startedAt?: string; endedAt?: string; wallMs: number | null; pausedMs: number; activeMs: number | null; meanInFlight: number | null };
  totals: { runs: number; ok: number; rejected: number; failed: number; transient: number; limit: number; timeout: number; costUsd: number; input: number; output: number; cacheRead: number; cacheWrite: number; cacheHit: number };
  byMode: ModeStats[];
  loops: { draft: Record<string, number>; stray: Record<string, number>; draftCapHits: number; strayCapHits: number; verifyPass: number; verifyIssues: number };
  rejections: { reason: string; count: number; examples: string[] }[];
  errors: { kind: string; message: string; count: number; examples: string[] }[];
  chapters: ChapterStats[];
  concurrency: { configured: number; utilization: { inFlight: number; ms: number; pct: number }[] };
  pauses: { at: string; reason: string; ms: number }[];
  chains: { initMs: number; glossaryMs: number; longestChapterMs: number; longestChapter?: string; sumRunMs: number };
  prompts: { agent: string; hash: string; runs: number; ok: number; meanMs: number; costUsd: number }[];
  noChange: { run: string; mode: string; chapter?: string }[];
  inherited?: Record<string, unknown>;
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

/** Strip what varies between occurrences of the same problem. */
export function normalizeReason(text: string): string {
  return text
    .replace(/`[^`]*`/g, '<file>')
    .replace(/\d+(\.\d+)?/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

export function summarize(meta: ProjectMeta, state: PipelineState, trace: Trace): Summary {
  const runs = trace.runs();
  const timeline = trace.timelineRecords();
  const tmeta = trace.meta() ?? {};
  const chapters = state.chapters;
  const included = chapters.filter((c) => !c.excluded);
  const words = included.reduce((a, c) => a + c.words, 0);

  // Run clock.
  const started = state.run.startedAt ? Date.parse(state.run.startedAt) : null;
  const ended = state.run.endedAt ? Date.parse(state.run.endedAt) : ['running', 'paused', 'awaiting_review'].includes(state.run.state) ? Date.now() : null;
  const wallMs = started !== null && ended !== null ? ended - started : null;
  const pauses: Summary['pauses'] = [];
  let pausedMs = 0;
  let pausedAt: TimelineRecord | null = null;
  for (const r of timeline) {
    if (r.kind !== 'run') continue;
    if (r.state === 'paused' && !pausedAt) pausedAt = r;
    else if (r.state !== 'paused' && pausedAt) {
      const ms = Date.parse(r.t) - Date.parse(pausedAt.t);
      pauses.push({ at: pausedAt.t, reason: String(pausedAt.reason ?? ''), ms });
      pausedMs += ms;
      pausedAt = null;
    }
  }
  if (pausedAt) {
    const ms = Date.now() - Date.parse(pausedAt.t);
    pauses.push({ at: pausedAt.t, reason: String(pausedAt.reason ?? ''), ms });
    pausedMs += ms;
  }
  const activeMs = wallMs !== null ? Math.max(0, wallMs - pausedMs) : null;
  const sumRunMs = runs.reduce((a, r) => a + r.durationMs, 0);

  // Totals.
  const totals: Summary['totals'] = { runs: runs.length, ok: 0, rejected: 0, failed: 0, transient: 0, limit: 0, timeout: 0, costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheHit: 0 };
  for (const r of runs) {
    if (r.outcome === 'ok' && r.check?.ok) totals.ok++;
    else if (r.outcome === 'ok') totals.rejected++;
    else if (r.outcome === 'transient') totals.transient++;
    else if (r.outcome === 'limit' || r.outcome === 'auth') totals.limit++;
    else if (r.outcome === 'timeout') totals.timeout++;
    else totals.failed++;
    totals.costUsd += r.usage.costUsd;
    totals.input += r.usage.input;
    totals.output += r.usage.output;
    totals.cacheRead += r.usage.cacheRead;
    totals.cacheWrite += r.usage.cacheWrite;
  }
  totals.cacheHit = pct(totals.cacheRead, totals.input + totals.cacheRead);

  // By mode.
  const byModeMap = new Map<string, RunRecord[]>();
  for (const r of runs) byModeMap.set(r.mode, [...(byModeMap.get(r.mode) ?? []), r]);
  const byMode: ModeStats[] = [...byModeMap.entries()].map(([mode, rs]) => {
    const ok = rs.filter((r) => r.outcome === 'ok' && r.check?.ok);
    const durations = ok.map((r) => r.durationMs);
    const withApi = ok.filter((r) => r.apiMs != null);
    const input = rs.reduce((a, r) => a + r.usage.input, 0);
    const cacheRead = rs.reduce((a, r) => a + r.usage.cacheRead, 0);
    return {
      mode,
      agent: rs[0].agent,
      runs: rs.length,
      ok: ok.length,
      rejected: rs.filter((r) => r.outcome === 'ok' && !r.check?.ok).length,
      failed: rs.filter((r) => r.outcome !== 'ok').length,
      meanMs: Math.round(mean(durations)),
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      apiShare: withApi.length ? pct(withApi.reduce((a, r) => a + (r.apiMs ?? 0), 0), withApi.reduce((a, r) => a + r.durationMs, 0)) : null,
      turnsMean: ok.some((r) => r.turns != null) ? Math.round(mean(ok.map((r) => r.turns ?? 0)) * 10) / 10 : null,
      toolsMean: Math.round(mean(rs.map((r) => Object.values(r.tools).reduce((a, b) => a + b, 0))) * 10) / 10,
      input,
      output: rs.reduce((a, r) => a + r.usage.output, 0),
      cacheRead,
      cacheHit: pct(cacheRead, input + cacheRead),
      costUsd: rs.reduce((a, r) => a + r.usage.costUsd, 0),
    };
  });

  // Loops and verification, from the engine's own state.
  const loops: Summary['loops'] = { draft: {}, stray: {}, draftCapHits: 0, strayCapHits: 0, verifyPass: 0, verifyIssues: 0 };
  for (const c of included) {
    const d = state.steps[`${c.key}/draft`];
    const s = state.steps[`${c.key}/stray`];
    const v = state.steps[`${c.key}/verify`];
    if (d?.state === 'done') {
      loops.draft[d.rounds] = (loops.draft[d.rounds] ?? 0) + 1;
      if (d.warning) loops.draftCapHits++;
    }
    if (s?.state === 'done') {
      loops.stray[s.rounds] = (loops.stray[s.rounds] ?? 0) + 1;
      if (s.warning) loops.strayCapHits++;
    }
    if (v?.state === 'done') {
      if (v.warning) loops.verifyIssues++;
      else loops.verifyPass++;
    }
  }

  // Rejections and errors, grouped.
  const group = <T extends { count: number; examples: string[] }>(map: Map<string, T>, key: string, make: () => T, example: string) => {
    const g = map.get(key) ?? make();
    g.count++;
    if (g.examples.length < 3) g.examples.push(example);
    map.set(key, g);
  };
  const rejMap = new Map<string, Summary['rejections'][number]>();
  const errMap = new Map<string, Summary['errors'][number]>();
  for (const r of runs) {
    if (r.outcome === 'ok' && r.check && !r.check.ok) {
      const reason = normalizeReason(r.check.problem ?? '');
      group(rejMap, reason, () => ({ reason, count: 0, examples: [] }), r.id);
    } else if (r.outcome !== 'ok') {
      const message = normalizeReason(r.error ?? '');
      group(errMap, `${r.outcome}|${message}`, () => ({ kind: r.outcome, message, count: 0, examples: [] }), r.id);
    }
  }

  // Chapters.
  const chapterStats: ChapterStats[] = chapters.map((c) => {
    const rs = runs.filter((r) => r.chapter === c.key);
    const durationMs = rs.reduce((a, r) => a + r.durationMs, 0);
    const costUsd = rs.reduce((a, r) => a + r.usage.costUsd, 0);
    const finalRun = [...rs].reverse().find((r) => (r.mode === 'final' || r.mode === 'verify-fix') && r.outcome === 'ok' && r.check?.ok);
    const finalOut = finalRun?.outputs.find((o) => o.path.startsWith('final/'));
    const source = finalRun?.inputs.find((i) => i.path.startsWith('original/'));
    const warnings: string[] = [];
    for (const stage of ['summarize', 'lexicon', 'glossary', 'draft', 'stray', 'critique', 'final', 'verify']) {
      const st = state.steps[`${c.key}/${stage}`];
      if (st?.warning) warnings.push(`${stage}: ${st.warning}`);
      if (st?.state === 'failed') warnings.push(`${stage} failed: ${st.error ?? ''}`);
    }
    const verify = state.steps[`${c.key}/verify`];
    return {
      key: c.key,
      title: c.title,
      words: c.words,
      excluded: c.excluded,
      runs: rs.length,
      durationMs,
      costUsd,
      costPer1k: c.words ? Math.round((costUsd / c.words) * 1000 * 100) / 100 : null,
      msPer1k: c.words ? Math.round((durationMs / c.words) * 1000) : null,
      draftRounds: state.steps[`${c.key}/draft`]?.rounds ?? 0,
      strayRounds: state.steps[`${c.key}/stray`]?.rounds ?? 0,
      verify: verify?.state !== 'done' ? (verify?.state ?? 'pending') : verify.warning ? 'issues, fixed once' : 'pass',
      expansion: finalOut?.metrics && source?.metrics?.chars ? Math.round((finalOut.metrics.chars / source.metrics.chars) * 100) / 100 : null,
      scripts: finalOut?.metrics?.scripts ?? null,
      warnings,
    };
  });

  // Concurrency utilization: a sweep over the runs' intervals.
  const edges: [number, number][] = [];
  for (const r of runs) {
    edges.push([Date.parse(r.startedAt), 1]);
    edges.push([Date.parse(r.endedAt), -1]);
  }
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const levelMs = new Map<number, number>();
  let level = 0;
  let last: number | null = null;
  for (const [t, d] of edges) {
    if (last !== null && t > last) levelMs.set(level, (levelMs.get(level) ?? 0) + (t - last));
    level += d;
    last = t;
  }
  const busyMs = [...levelMs.values()].reduce((a, b) => a + b, 0);
  const utilization = [...levelMs.entries()].sort((a, b) => a[0] - b[0]).map(([inFlight, ms]) => ({ inFlight, ms, pct: pct(ms, busyMs) }));
  const meanInFlight = activeMs ? Math.round((sumRunMs / activeMs) * 100) / 100 : null;

  // The serial chains that bound the run.
  const sumFor = (f: (r: RunRecord) => boolean) => runs.filter(f).reduce((a, r) => a + r.durationMs, 0);
  const initMs = sumFor((r) => ['metadata', 'style', 'charter'].includes(r.mode));
  const glossaryMs = sumFor((r) => r.mode === 'glossary');
  let longestChapterMs = 0;
  let longestChapter: string | undefined;
  for (const c of included) {
    const ms = sumFor((r) => r.chapter === c.key && ['translate', 'refine', 'audit', 'scan', 'fix', 'critique', 'final', 'verify', 'verify-fix'].includes(r.mode));
    if (ms > longestChapterMs) {
      longestChapterMs = ms;
      longestChapter = c.title;
    }
  }

  // Prompt versions.
  const promptMap = new Map<string, Summary['prompts'][number] & { ms: number[] }>();
  for (const r of runs) {
    const key = `${r.agent}|${r.agentPrompt}`;
    const p = promptMap.get(key) ?? { agent: r.agent, hash: r.agentPrompt.slice(0, 12), runs: 0, ok: 0, meanMs: 0, costUsd: 0, ms: [] };
    p.runs++;
    if (r.outcome === 'ok' && r.check?.ok) {
      p.ok++;
      p.ms.push(r.durationMs);
    }
    p.costUsd += r.usage.costUsd;
    promptMap.set(key, p);
  }
  const prompts = [...promptMap.values()].map(({ ms, ...p }) => ({ ...p, meanMs: Math.round(mean(ms)) }));

  const noChange = runs
    .filter((r) => ['refine', 'fix', 'verify-fix'].includes(r.mode) && r.outcome === 'ok' && r.outputs.length && r.outputs.every((o) => o.changed === false))
    .map((r) => ({ run: r.id, mode: r.mode, chapter: r.chapter }));

  const claudeCode = runs.map((r) => r.claudeCodeVersion).filter(Boolean).at(-1);
  return {
    project: { id: meta.id, name: meta.name, targetLanguage: meta.targetLanguage, series: meta.series, inheritFrom: meta.inheritFrom, chapters: chapters.length, included: included.length, words },
    versions: { lexis: (tmeta.lexis as string) || undefined, agentSdk: (tmeta.agentSdk as string) || undefined, claudeCode },
    run: { state: state.run.state, startedAt: state.run.startedAt, endedAt: state.run.endedAt, wallMs, pausedMs, activeMs, meanInFlight },
    totals,
    byMode,
    loops,
    rejections: [...rejMap.values()].sort((a, b) => b.count - a.count),
    errors: [...errMap.values()].sort((a, b) => b.count - a.count),
    chapters: chapterStats,
    concurrency: { configured: state.config.concurrency, utilization },
    pauses,
    chains: { initMs, glossaryMs, longestChapterMs, longestChapter, sumRunMs },
    prompts,
    noChange,
    inherited: meta.inherited as Record<string, unknown> | undefined,
  };
}

// ---------- rendering ----------

export function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return '–';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}
const usd = (n: number) => `$${n.toFixed(2)}`;
const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

export function table(rows: (string | number)[][], align: ('l' | 'r')[] = []): string {
  const cells = rows.map((r) => r.map((c) => String(c)));
  const widths = cells[0].map((_, i) => Math.max(...cells.map((r) => (r[i] ?? '').length)));
  return cells.map((r) => r.map((c, i) => ((align[i] ?? (i === 0 ? 'l' : 'r')) === 'r' ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ').trimEnd()).join('\n');
}

export type Section = 'summary' | 'stages' | 'chapters' | 'failures' | 'timeline' | 'prompts';

export function render(s: Summary, section: Section = 'summary'): string {
  const out: string[] = [];
  const h = (t: string) => out.push('', `## ${t}`);
  if (section === 'summary') {
    out.push(`# ${s.project.name} → ${s.project.targetLanguage}${s.project.series ? ` (series: ${s.project.series})` : ''}`);
    out.push(`${s.project.included}/${s.project.chapters} chapters, ${tok(s.project.words)} words · lexis ${s.versions.lexis ?? '?'} · agent sdk ${s.versions.agentSdk ?? '?'} · claude code ${s.versions.claudeCode ?? '?'}`);
    if (s.inherited) out.push(`inherited from ${String(s.inherited.fromName ?? s.inherited.from)}: ${(s.inherited.files as string[] | undefined)?.join(', ') ?? ''}${s.inherited.glossaryEntries != null ? ` (${s.inherited.glossaryEntries} glossary entries)` : ''}`);
    out.push(`run: ${s.run.state} · wall ${fmtMs(s.run.wallMs)} · paused ${fmtMs(s.run.pausedMs)} · active ${fmtMs(s.run.activeMs)} · agent time ${fmtMs(s.chains.sumRunMs)} (${s.run.meanInFlight ?? '–'} in flight on average, ${s.concurrency.configured} configured)`);
    out.push(`agent runs: ${s.totals.runs} · accepted ${s.totals.ok} · rejected ${s.totals.rejected} · failed ${s.totals.failed} · timeouts ${s.totals.timeout} · transient ${s.totals.transient} · limits ${s.totals.limit}`);
    out.push(`cost ${usd(s.totals.costUsd)} · tokens in ${tok(s.totals.input)} out ${tok(s.totals.output)} · cache read ${tok(s.totals.cacheRead)} (${s.totals.cacheHit}% of input) write ${tok(s.totals.cacheWrite)}`);
    h('By mode');
    out.push(renderModes(s));
    h('Loops and verification');
    out.push(`draft/omission rounds: ${hist(s.loops.draft)}${s.loops.draftCapHits ? ` · cap hit ${s.loops.draftCapHits}×` : ''}`);
    out.push(`stray/fix rounds: ${hist(s.loops.stray)}${s.loops.strayCapHits ? ` · cap hit ${s.loops.strayCapHits}×` : ''}`);
    out.push(`verification: ${s.loops.verifyPass} pass, ${s.loops.verifyIssues} with issues (fixed once)${s.noChange.length ? ` · ${s.noChange.length} refine/fix runs changed nothing` : ''}`);
    h('Rejections and errors');
    if (!s.rejections.length && !s.errors.length) out.push('none');
    for (const r of s.rejections) out.push(`${r.count}× rejected: ${r.reason}  (e.g. ${r.examples.join(', ')})`);
    for (const e of s.errors) out.push(`${e.count}× ${e.kind}: ${e.message}  (e.g. ${e.examples.join(', ')})`);
    h('Where the time went');
    out.push(`init chain ${fmtMs(s.chains.initMs)} · glossary chain ${fmtMs(s.chains.glossaryMs)} · longest chapter ${fmtMs(s.chains.longestChapterMs)}${s.chains.longestChapter ? ` (${s.chains.longestChapter})` : ''}`);
    out.push(`in flight: ${s.concurrency.utilization.map((u) => `${u.inFlight}→${u.pct}%`).join(' ')}`);
    if (s.pauses.length) out.push(`pauses: ${s.pauses.map((p) => `${fmtMs(p.ms)} (${p.reason})`).join('; ')}`);
    const outliers = s.chapters.filter((c) => !c.excluded && c.warnings.length);
    if (outliers.length) {
      h('Chapters to look at');
      for (const c of outliers) out.push(`${c.title}: ${c.warnings.join('; ')}`);
    }
    return out.join('\n');
  }
  if (section === 'stages') return renderModes(s);
  if (section === 'chapters') {
    const rows: (string | number)[][] = [['chapter', 'words', 'runs', 'time', 'cost', '$/1k', 'min/1k', 'draft', 'stray', 'verify', 'expand', 'scripts', 'notes']];
    for (const c of s.chapters) {
      if (c.excluded) {
        rows.push([c.title.slice(0, 28), c.words, 'excluded', '', '', '', '', '', '', '', '', '', '']);
        continue;
      }
      const scripts = c.scripts ? Object.entries(c.scripts).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(' ') : '';
      rows.push([c.title.slice(0, 28), c.words, c.runs, fmtMs(c.durationMs), usd(c.costUsd), c.costPer1k ?? '', c.msPer1k != null ? (c.msPer1k / 60000).toFixed(1) : '', c.draftRounds, c.strayRounds, c.verify, c.expansion ?? '', scripts, c.warnings.join('; ').slice(0, 40)]);
    }
    return table(rows);
  }
  if (section === 'failures') {
    if (!s.rejections.length && !s.errors.length) return 'No rejected or failed runs.';
    for (const r of s.rejections) out.push(`${r.count}× rejected — ${r.reason}`, ...r.examples.map((e) => `    trace/runs/${e}/transcript.jsonl`));
    for (const e of s.errors) out.push(`${e.count}× ${e.kind} — ${e.message}`, ...e.examples.map((x) => `    trace/runs/${x}/transcript.jsonl`));
    return out.join('\n');
  }
  if (section === 'timeline') {
    out.push(`wall ${fmtMs(s.run.wallMs)} · paused ${fmtMs(s.run.pausedMs)} · active ${fmtMs(s.run.activeMs)} · summed agent time ${fmtMs(s.chains.sumRunMs)}`);
    out.push(`mean in flight ${s.run.meanInFlight ?? '–'} of ${s.concurrency.configured} configured`);
    out.push(table([['in flight', 'time', 'share'], ...s.concurrency.utilization.map((u) => [u.inFlight, fmtMs(u.ms), `${u.pct}%`])]));
    out.push('', `serial chains: init ${fmtMs(s.chains.initMs)} · glossary ${fmtMs(s.chains.glossaryMs)} · longest chapter ${fmtMs(s.chains.longestChapterMs)}${s.chains.longestChapter ? ` (${s.chains.longestChapter})` : ''}`);
    if (s.pauses.length) {
      out.push('', 'pauses:');
      for (const p of s.pauses) out.push(`  ${p.at}  ${fmtMs(p.ms)}  ${p.reason}`);
    }
    return out.join('\n');
  }
  if (section === 'prompts') {
    return table([['agent', 'prompt', 'runs', 'accepted', 'mean time', 'cost'], ...s.prompts.map((p) => [p.agent, p.hash, p.runs, p.ok, fmtMs(p.meanMs), usd(p.costUsd)])]);
  }
  return out.join('\n');
}

function renderModes(s: Summary): string {
  const rows: (string | number)[][] = [['mode', 'agent', 'runs', 'ok', 'rej', 'fail', 'p50', 'p95', 'api%', 'turns', 'tools', 'in', 'out', 'cache%', 'cost']];
  for (const m of s.byMode) rows.push([m.mode, m.agent, m.runs, m.ok, m.rejected, m.failed, fmtMs(m.p50Ms), fmtMs(m.p95Ms), m.apiShare ?? '', m.turnsMean ?? '', m.toolsMean, tok(m.input), tok(m.output), m.cacheHit, usd(m.costUsd)]);
  return table(rows);
}

function hist(h: Record<string, number>): string {
  const keys = Object.keys(h).sort((a, b) => Number(a) - Number(b));
  return keys.length ? keys.map((k) => `${k}:${h[k]}`).join(' ') : '–';
}

/** A run's transcript as something a person can read. */
export function renderTranscript(records: TranscriptRecord[], prompt: string | null, run?: RunRecord): string {
  const out: string[] = [];
  if (run) out.push(`# ${run.agent} · ${run.mode}${run.chapter ? ` · ${run.chapter}` : ''} · round ${run.round} attempt ${run.attempt} · ${run.outcome}${run.check ? (run.check.ok ? ' · accepted' : ` · rejected: ${run.check.problem}`) : ''}`, `${run.model} effort ${run.effort} · ${fmtMs(run.durationMs)} · ${run.turns ?? '?'} turns · ${usd(run.usage.costUsd)} · tools ${JSON.stringify(run.tools)}`, '');
  if (prompt) out.push('## Task prompt', prompt, '');
  out.push('## Transcript');
  for (const r of records) {
    const t = r.t.slice(11, 19);
    switch (r.kind) {
      case 'init':
        out.push(`${t} init ${r.model} (claude code ${r.claudeCodeVersion ?? '?'})`);
        break;
      case 'thinking':
        out.push(`${t} thinking: ${r.text.slice(0, 300).replace(/\n/g, ' ')}${r.text.length > 300 ? ' …' : ''}`);
        break;
      case 'text':
        out.push(`${t} says: ${r.text}`);
        break;
      case 'tool_use':
        out.push(`${t} ${r.tool} ${JSON.stringify(r.input).slice(0, 300)}`);
        break;
      case 'tool_result':
        out.push(`${t}   → ${r.isError ? 'ERROR ' : ''}${r.content.length} chars${r.truncated ? ' (capped)' : ''}: ${r.content.slice(0, 160).replace(/\n/g, ' ')}`);
        break;
      case 'api_retry':
        out.push(`${t} api retry ${r.attempt}/${r.maxRetries} after ${r.status ?? '?'} ${r.error}, waiting ${r.delayMs}ms`);
        break;
      case 'rate_limit':
        out.push(`${t} rate limit ${JSON.stringify(r.info)}`);
        break;
      case 'stderr':
        out.push(`${t} stderr: ${r.line}`);
        break;
      case 'error':
        out.push(`${t} ERROR ${r.message}`);
        break;
      case 'check':
        out.push(`${t} check: ${r.check.ok ? 'accepted' : `rejected — ${r.check.problem}`}${r.check.warning ? ` (warning: ${r.check.warning})` : ''}${r.check.status ? ` status ${r.check.status}` : ''}`);
        break;
      case 'result':
        out.push(`${t} result ${r.subtype} · ${r.turns} turns · ${fmtMs(r.durationMs)} (api ${fmtMs(r.apiMs)})${r.errors.length ? ` · errors: ${r.errors.join('; ')}` : ''}${Array.isArray(r.denials) && r.denials.length ? ` · ${r.denials.length} tool calls denied by the sandbox` : ''}`);
        break;
    }
  }
  return out.join('\n');
}
