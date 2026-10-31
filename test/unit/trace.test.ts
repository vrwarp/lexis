import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Trace, normalizeReason, renderTranscript, sha256, summarize, table, textMetrics } from '../../src/engine/trace.js';
import type { PipelineState, ProjectMeta } from '../../src/types.js';

const meta: ProjectMeta = { id: 'p1', name: 'B', targetLanguage: 'Spanish', context: '', status: 'created', createdAt: '', updatedAt: '', epubFilename: 'b.epub' };

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis-trace-'));
  const ws = path.join(dir, 'workspace');
  fs.mkdirSync(path.join(ws, 'notes'), { recursive: true });
  return { dir, ws, trace: new Trace(dir, ws) };
}

describe('textMetrics', () => {
  it('counts words, paragraphs and the share of each script', () => {
    const m = textMetrics('<html><body><p>Hello world again</p><p>第二段落的文字</p></body></html>');
    expect(m.paragraphs).toBe(2);
    expect(m.words).toBe(3 + 7);
    expect(m.scripts.latin).toBeCloseTo(15 / 22, 2);
    expect(m.scripts.han).toBeCloseTo(7 / 22, 2);
    const t = textMetrics('Один абзац.\n\nВторой абзац.', false);
    expect(t.paragraphs).toBe(2);
    expect(t.scripts.cyrillic).toBe(1);
  });
});

describe('the store', () => {
  it('deduplicates blobs by content and snapshots files that exist', () => {
    const { ws, trace, dir } = fresh();
    fs.writeFileSync(path.join(ws, 'notes', 'a.txt'), 'same');
    fs.writeFileSync(path.join(ws, 'notes', 'b.txt'), 'same');
    const refs = trace.snapshot(['notes/a.txt', 'notes/b.txt', 'notes/missing.txt'], true);
    expect(refs.map((r) => r.path)).toEqual(['notes/a.txt', 'notes/b.txt']);
    expect(refs[0].hash).toBe(refs[1].hash);
    expect(refs[0].hash).toBe(sha256('same'));
    expect(refs[0].metrics?.words).toBe(1);
    expect(fs.readdirSync(path.join(dir, 'trace', 'blobs'))).toHaveLength(1);
    expect(trace.blob(refs[0].hash)!.toString()).toBe('same');
    expect(trace.blob('nope')).toBeNull();
  });

  it('records a run: prompt, transcript with capped tool results, outputs with change detection', () => {
    const { ws, trace, dir } = fresh();
    trace.ensure(meta, { concurrency: 2 } as PipelineState['config']);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'trace', 'meta.json'), 'utf8'))).toMatchObject({ v: 1, project: { id: 'p1' }, config: { concurrency: 2 } });
    fs.writeFileSync(path.join(ws, 'notes', 'in.txt'), 'input');
    fs.writeFileSync(path.join(ws, 'notes', 'out.txt'), 'old output');
    const run = { id: 'abcd1234', agent: 'x', mode: 'final', round: 1, attempt: 1, state: 'running' as const, startedAt: new Date().toISOString() };
    const tracer = trace.beginRun(run, 'do the thing', ['notes/in.txt'], ['notes/out.txt', 'notes/new.txt']);
    expect(trace.prompt('abcd1234')).toBe('do the thing');
    tracer.record({ kind: 'init', model: 'm', claudeCodeVersion: '9.9', sessionId: 's' });
    tracer.record({ kind: 'tool_use', id: 't1', tool: 'Read', input: { file_path: 'notes/in.txt' } });
    tracer.record({ kind: 'tool_result', toolUseId: 't1', content: 'x'.repeat(70_000) });
    tracer.record({ kind: 'tool_use', id: 't2', tool: 'Write', input: { file_path: 'notes/out.txt', content: 'new' } });
    tracer.record({ kind: 'api_retry', attempt: 1, maxRetries: 3, delayMs: 10, status: 529, error: 'overloaded' });
    tracer.record({ kind: 'stderr', line: 'warn' });
    tracer.record({ kind: 'text', text: 'All done.' });
    tracer.record({ kind: 'result', subtype: 'success', isError: false, turns: 4, durationMs: 100, apiMs: 60, errors: [], usage: {}, denials: [{ tool_name: 'Bash' }] });
    fs.writeFileSync(path.join(ws, 'notes', 'out.txt'), 'new output');
    fs.writeFileSync(path.join(ws, 'notes', 'new.txt'), 'brand new');
    const record = tracer.finish({
      step: 's', stage: 'final', agent: 'x', agentPrompt: 'h', mode: 'final', round: 1, attempt: 1, model: 'm', effort: 'high',
      config: { maxTurns: 1, budgetUsd: 1, timeoutMs: 1, concurrency: 2 }, startedAt: run.startedAt, endedAt: new Date().toISOString(), durationMs: 100,
      outcome: 'ok', check: { ok: true }, usage: { byModel: {}, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.1 },
    });
    expect(record).toMatchObject({ v: 1, id: 'abcd1234', tools: { Read: 1, Write: 1 }, denials: 1, retries: 1, stderrLines: 1, apiMs: 60, claudeCodeVersion: '9.9', sessionId: 's', reply: 'All done.' });
    expect(record.inputs).toEqual([expect.objectContaining({ path: 'notes/in.txt', size: 5 })]);
    expect(record.outputs).toEqual([
      expect.objectContaining({ path: 'notes/out.txt', changed: true, prevHash: sha256('old output'), hash: sha256('new output') }),
      expect.objectContaining({ path: 'notes/new.txt', changed: true, prevHash: undefined }),
    ]);
    const transcript = trace.transcript('abcd1234');
    expect(transcript.map((r) => r.kind)).toEqual(['init', 'tool_use', 'tool_result', 'tool_use', 'api_retry', 'stderr', 'text', 'result']);
    const result = transcript[2] as { content: string; truncated?: boolean };
    expect(result.content.length).toBe(64 * 1024);
    expect(result.truncated).toBe(true);
    expect(trace.runs()).toHaveLength(1);
    expect(renderTranscript(transcript, 'do the thing', record)).toContain('1 tool calls denied by the sandbox');
    expect(trace.transcript('nope')).toEqual([]);
  });

  it('exports a tarball of the trace and the project state', async () => {
    const { dir, trace } = fresh();
    trace.timeline('run', { state: 'running' });
    fs.writeFileSync(path.join(dir, 'pipeline.json'), '{}');
    const out = path.join(dir, 'out.tgz');
    await trace.export(out);
    const { execFileSync } = await import('node:child_process');
    const listing = execFileSync('tar', ['tzf', out], { encoding: 'utf8' });
    expect(listing).toContain('trace/timeline.jsonl');
    expect(listing).toContain('pipeline.json');
  });
});

describe('summaries', () => {
  it('normalizes reasons so the same problem groups', () => {
    expect(normalizeReason('`draft/OEBPS/ch1.xhtml` lost the XHTML structure')).toBe('<file> lost the XHTML structure');
    expect(normalizeReason('the agent used all 80 turns')).toBe('the agent used all N turns');
  });

  it('lays out tables', () => {
    expect(table([['a', 'bb'], ['ccc', '1']])).toBe('a    bb\nccc   1');
  });

  it('computes utilization, pauses and chains from records', () => {
    const { trace } = fresh();
    const t0 = Date.parse('2026-01-01T00:00:00Z');
    const run = (id: string, mode: string, chapter: string | undefined, start: number, end: number, ok = true) =>
      fs.appendFileSync(path.join(trace.dir, 'runs.jsonl'), JSON.stringify({ v: 1, id, step: 's', stage: 'x', chapter, agent: 'a', agentPrompt: 'p', mode, round: 1, attempt: 1, model: 'm', effort: 'e', config: {}, startedAt: new Date(t0 + start).toISOString(), endedAt: new Date(t0 + end).toISOString(), durationMs: end - start, outcome: 'ok', check: ok ? { ok: true } : { ok: false, problem: 'bad `x`' }, usage: { byModel: {}, input: 100, output: 10, cacheRead: 100, cacheWrite: 0, costUsd: 1 }, tools: { Read: 2 }, denials: 0, retries: 0, stderrLines: 0, inputs: [], outputs: [] }) + '\n');
    fs.mkdirSync(trace.dir, { recursive: true });
    run('r1', 'metadata', undefined, 0, 1000);
    run('r2', 'glossary', 'c1', 1000, 2000);
    run('r3', 'translate', 'c1', 2000, 4000);
    run('r4', 'translate', 'c2', 3000, 5000, false);
    trace.timeline('run', { state: 'running' });
    fs.appendFileSync(path.join(trace.dir, 'timeline.jsonl'), JSON.stringify({ t: new Date(t0 + 5000).toISOString(), kind: 'run', state: 'paused', reason: 'limit' }) + '\n');
    fs.appendFileSync(path.join(trace.dir, 'timeline.jsonl'), JSON.stringify({ t: new Date(t0 + 7000).toISOString(), kind: 'run', state: 'running' }) + '\n');
    const state: PipelineState = {
      version: 1,
      run: { state: 'completed', startedAt: new Date(t0).toISOString(), endedAt: new Date(t0 + 9000).toISOString() },
      config: { concurrency: 2 } as PipelineState['config'],
      chapters: [
        { key: 'c1', path: 'c1.xhtml', index: 1, title: 'One', excluded: false, words: 1000 },
        { key: 'c2', path: 'c2.xhtml', index: 2, title: 'Two', excluded: false, words: 500 },
      ],
      steps: {},
      timings: {},
      revisions: [],
    };
    const s = summarize(meta, state, trace);
    expect(s.totals).toMatchObject({ runs: 4, ok: 3, rejected: 1, costUsd: 4, cacheHit: 50 });
    expect(s.run).toMatchObject({ wallMs: 9000, pausedMs: 2000, activeMs: 7000 });
    expect(s.pauses).toEqual([{ at: new Date(t0 + 5000).toISOString(), reason: 'limit', ms: 2000 }]);
    expect(s.concurrency.utilization).toEqual([
      { inFlight: 1, ms: 4000, pct: 80 },
      { inFlight: 2, ms: 1000, pct: 20 },
    ]);
    expect(s.chains).toMatchObject({ initMs: 1000, glossaryMs: 1000, longestChapterMs: 2000, sumRunMs: 6000 });
    expect(s.rejections).toEqual([{ reason: 'bad <file>', count: 1, examples: ['r4'] }]);
    expect(s.chapters.find((c) => c.key === 'c1')).toMatchObject({ runs: 2, durationMs: 3000, costUsd: 2, costPer1k: 2, msPer1k: 3000 });
    expect(s.byMode.find((m) => m.mode === 'translate')).toMatchObject({ runs: 2, ok: 1, rejected: 1, toolsMean: 2 });
  });
});
