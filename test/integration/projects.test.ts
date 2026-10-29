import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { restoreEnv, until } from '../support/boot.js';
import { PNG, readEntry } from '../support/epub.js';
import { fake } from '../support/fake-sdk.js';
import { type TestServer, startServer } from '../support/server.js';

let s: TestServer;
afterEach(async () => {
  await s?.close();
  restoreEnv();
});

/** A signed-in server whose Claude credential comes from the environment. */
async function ready(env: Record<string, string> = {}) {
  s = await startServer({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok', LEXIS_CONCURRENCY: '3', ...env } });
  await s.login();
  return s;
}

const CH1 = 'chapter1.xhtml';
const CH2 = 'chapter2.xhtml';
const get = async (p: string) => (await s.request(p)).json();
const post = (p: string, json?: unknown) => s.request(p, { method: 'POST', ...(json === undefined ? {} : { json }) });
const put = (p: string, json: unknown) => s.request(p, { method: 'PUT', json });
const patch = (p: string, json: unknown) => s.request(p, { method: 'PATCH', json });
const runState = async (id: string) => (await get(`/api/projects/${id}/pipeline`)).run.state as string;
const statusOf = async (id: string) => (await get(`/api/projects/${id}`)).status as string;

async function runToReview(id: string) {
  expect((await post(`/api/projects/${id}/run/start`)).status).toBe(200);
  await until(async () => (await runState(id)) === 'awaiting_review', 10_000, 'review gate');
}

describe('project creation', () => {
  it('creates a project from an uploaded EPUB and lists it', async () => {
    await ready();
    const p = await s.createProject({ targetLanguage: ' Japanese ', context: ' keep honorifics ' });
    expect(p).toMatchObject({ name: 'My Book', targetLanguage: 'Japanese', context: 'keep honorifics', status: 'created', epubFilename: 'My Book.epub' });
    const named = await s.createProject({ name: 'Custom' });
    const list = await get('/api/projects');
    expect(list.map((x: { id: string }) => x.id).sort()).toEqual([p.id, named.id].sort());
    const detail = await get(`/api/projects/${p.id}`);
    expect(detail).toMatchObject({ id: p.id, awaitingReview: false, run: { state: 'idle' } });
    expect(detail.versions[0].label).toBe('lexis: project created');
    // The plan exists before anything runs: prepare is pending, nothing else is known yet.
    const pipeline = await get(`/api/projects/${p.id}/pipeline`);
    expect(pipeline.steps.prepare.state).toBe('pending');
    expect(pipeline.config).toMatchObject({ concurrency: 3, maxLoopRounds: 3, models: { translation: 'claude-opus-5-5' } });
  });

  it('validates the upload', async () => {
    await ready();
    const noFile = new FormData();
    noFile.append('targetLanguage', 'Spanish');
    expect((await s.request('/api/projects', { method: 'POST', body: noFile })).status).toBe(400);

    const wrongType = new FormData();
    wrongType.append('epub', new Blob(['x']), 'notes.txt');
    wrongType.append('targetLanguage', 'Spanish');
    const r = await s.request('/api/projects', { method: 'POST', body: wrongType });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/epub/);

    const noLanguage = new FormData();
    noLanguage.append('epub', new Blob(['x']), 'b.epub');
    noLanguage.append('targetLanguage', '   ');
    expect((await s.request('/api/projects', { method: 'POST', body: noLanguage })).status).toBe(400);
  });

  it('answers 404 for an unknown project', async () => {
    await ready();
    for (const p of ['/api/projects/nope', '/api/projects/nope/events', '/api/projects/nope/files', '/api/projects/nope/download', '/api/projects/nope/pipeline']) {
      expect((await s.request(p)).status, p).toBe(404);
    }
  });

  it('refuses to start before Claude is linked', async () => {
    s = await startServer();
    await s.login();
    const p = await s.createProject();
    const r = await post(`/api/projects/${p.id}/run/start`);
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/Claude is not linked/);
  });
});

describe('a full translation over HTTP', () => {
  it('runs to the review gate, approves, and serves the translated EPUB', async () => {
    await ready();
    const p = await s.createProject();
    await runToReview(p.id);
    expect(await statusOf(p.id)).toBe('awaiting_review');

    const pipeline = await get(`/api/projects/${p.id}/pipeline`);
    expect(pipeline.chapters.map((c: { key: string; excluded: boolean }) => [c.key, c.excluded])).toEqual([['cover.xhtml', true], [CH1, false], [CH2, false]]);
    expect(pipeline.steps[`${CH1}/verify`].state).toBe('done');
    expect(pipeline.steps[`${CH1}/draft`].runs.map((r: { mode: string }) => r.mode)).toEqual(['translate', 'audit']);
    expect(pipeline.steps[`${CH1}/draft`].runs[0].prompt).toBeUndefined();
    expect(pipeline.progress).toMatchObject({ failed: 0, running: 0 });
    expect(pipeline.usage.totalCostUsd).toBeGreaterThan(0);
    const step = await get(`/api/projects/${p.id}/step?id=${encodeURIComponent(`${CH1}/draft`)}`);
    expect(step.runs[0].prompt).toContain('Translate `original/OEBPS/chapter1.xhtml`');
    expect((await s.request(`/api/projects/${p.id}/step?id=nope`)).status).toBe(404);

    expect((await post(`/api/projects/${p.id}/review`, { decision: 'maybe' })).status).toBe(400);
    expect((await post(`/api/projects/${p.id}/review`, { decision: 'approve' })).status).toBe(200);
    expect((await post(`/api/projects/${p.id}/review`, { decision: 'approve' })).status).toBe(409);
    await until(async () => (await statusOf(p.id)) === 'completed', 10_000, 'completed');

    const dl = await s.request(`/api/projects/${p.id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-disposition')).toContain('My Book (Spanish).epub');
    expect(Buffer.from(await dl.arrayBuffer()).subarray(0, 2).toString()).toBe('PK');

    const detail = await get(`/api/projects/${p.id}`);
    expect(detail.outputPath).toBe('translated_book.epub');
    expect(detail.versions.map((v: { label: string }) => v.label)).toEqual(expect.arrayContaining(['initialization complete', 'packaged epub']));

    const events = await get(`/api/projects/${p.id}/events`);
    expect(events.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(['plan', 'step', 'run', 'review_request', 'review_response']));
    const review = events.find((e: { type: string }) => e.type === 'review_request');
    expect(review.data.summary).toContain('2 sections finalized and verified; 1 excluded.');
    expect((await get(`/api/projects/${p.id}/events?after=${events.at(-2).seq}`)).length).toBe(1);
    // Events can be narrowed to one step or one agent run.
    const draftEvents = await get(`/api/projects/${p.id}/events?step=${encodeURIComponent(`${CH1}/draft`)}`);
    expect(draftEvents.length).toBeGreaterThan(0);
    expect(draftEvents.every((e: { step: string }) => e.step === `${CH1}/draft`)).toBe(true);
    const runId = step.runs[0].id;
    const runEvents = await get(`/api/projects/${p.id}/events?run=${runId}`);
    expect(runEvents.some((e: { type: string }) => e.type === 'tool_use')).toBe(true);
    expect(runEvents.every((e: { run: string }) => e.run === runId)).toBe(true);
  });

  it('asks for another pass on chosen chapters, then approves', async () => {
    await ready();
    const p = await s.createProject();
    await runToReview(p.id);
    expect((await post(`/api/projects/${p.id}/review`, { decision: 'revise' })).status).toBe(400);
    const before = fake.calls.length;
    expect((await post(`/api/projects/${p.id}/review`, { decision: 'revise', instructions: 'warmer', chapters: [CH2], from: 'final' })).status).toBe(200);
    await until(async () => (await get(`/api/projects/${p.id}/events`)).filter((e: { type: string }) => e.type === 'review_request').length === 2, 10_000);
    expect(fake.calls.slice(before).map((c) => `${c.mode}:${c.chapter}`)).toEqual([`final:${CH2}`, `verify:${CH2}`]);
    const resp = (await get(`/api/projects/${p.id}/events`)).find((e: { type: string }) => e.type === 'review_response');
    expect(resp.data).toEqual({ decision: 'revise', instructions: 'warmer', chapters: [CH2], from: 'final' });
    expect((await get(`/api/projects/${p.id}/pipeline`)).chapters.find((c: { key: string }) => c.key === CH2).note).toBe('Revision 1: warmer');
  });

  it('streams events over the WebSocket, replaying history first', async () => {
    await ready();
    const p = await s.createProject();
    await runToReview(p.id);
    const late = await s.ws(`project=${p.id}&after=0`);
    await until(() => late.messages.some((m) => m.type === 'review_request'));
    const seqs = late.messages.map((m) => m.seq as number);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    await post(`/api/projects/${p.id}/review`, { decision: 'approve' });
    await until(() => late.messages.some((m) => m.type === 'run' && (m.data as { run: { state: string } }).run.state === 'completed'), 10_000);
    late.socket.close();

    const unknown = await s.ws('project=nope');
    expect(await unknown.closed).toBe(4004);
  });

  it('chats with the assistant, which can steer the engine', async () => {
    await ready();
    const p = await s.createProject();
    await runToReview(p.id);
    expect((await post(`/api/projects/${p.id}/message`, { text: '   ' })).status).toBe(400);
    expect((await post(`/api/projects/${p.id}/message`, { text: 'How is it going?' })).status).toBe(200);
    await until(async () => (await get(`/api/projects/${p.id}/events`)).some((e: { agent: string; type: string; data: { text?: string } }) => e.agent === 'assistant' && e.type === 'agent_text' && e.data.text?.startsWith('Noted: How is it going')));
    expect((await post(`/api/projects/${p.id}/message`, { text: 'status' })).status).toBe(200);
    await until(async () => (await get(`/api/projects/${p.id}/events`)).some((e: { agent: string; data: { text?: string } }) => e.agent === 'assistant' && e.data.text?.startsWith('Run: awaiting_review')));
    // A re-run asked for in chat shows up as engine work.
    const before = fake.calls.length;
    await post(`/api/projects/${p.id}/message`, { text: `rerun ${CH1} from final: use shorter sentences` });
    await until(() => fake.calls.length >= before + 2, 10_000);
    expect(fake.calls.slice(before).map((c) => c.mode)).toEqual(['final', 'verify']);
    expect(fake.calls[before].prompt).toContain('use shorter sentences');
    await until(async () => (await runState(p.id)) === 'awaiting_review', 10_000);
  });

  it('forwards file comments to the assistant with the quoted passage', async () => {
    await ready();
    const p = await s.createProject();
    expect((await post(`/api/projects/${p.id}/files/comment`, { path: 'final/x', comment: '' })).status).toBe(400);
    expect((await post(`/api/projects/${p.id}/files/comment`, { path: '../../etc/passwd', comment: 'hi' })).status).toBe(400);
    expect((await post(`/api/projects/${p.id}/files/comment`, { path: 'final/ch1.xhtml', comment: 'Too stiff', excerpt: 'line one\nline two' })).status).toBe(200);
    const msg = (await get(`/api/projects/${p.id}/events`)).filter((e: { type: string }) => e.type === 'user_message').at(-1);
    expect(msg.data.text).toBe('[User comment on asset `final/ch1.xhtml`]\n\nRegarding this passage:\n> line one\n> line two\n\nToo stiff');
  });

  it('records an assistant failure in the feed', async () => {
    await ready();
    const p = await s.createProject();
    await post(`/api/projects/${p.id}/message`, { text: 'please explode' });
    await until(async () => (await get(`/api/projects/${p.id}/events`)).some((e: { type: string; data: { message?: string } }) => e.type === 'error' && e.data.message?.includes('simulated SDK failure')));
    // The engine's state is untouched by the chat.
    expect(await runState(p.id)).toBe('idle');
  });
});

describe('run control', () => {
  it('pauses, resumes, stops and changes concurrency', async () => {
    await ready();
    const p = await s.createProject();
    fake.delayMs = 40;
    await post(`/api/projects/${p.id}/run/start`);
    await until(() => fake.calls.length >= 2);
    expect(await (await post(`/api/projects/${p.id}/run/pause`)).json()).toMatchObject({ ok: true, run: { state: 'paused', reason: 'paused by you' } });
    await until(() => fake.active === 0);
    const atPause = fake.calls.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.calls.length).toBe(atPause);
    expect(await statusOf(p.id)).toBe('paused');

    expect((await put(`/api/projects/${p.id}/run/concurrency`, { concurrency: 0 })).status).toBe(400);
    expect(await (await put(`/api/projects/${p.id}/run/concurrency`, { concurrency: 2 })).json()).toEqual({ ok: true, concurrency: 2 });

    await post(`/api/projects/${p.id}/run/resume`);
    await until(() => fake.calls.length > atPause);
    expect(await (await post(`/api/projects/${p.id}/run/stop`)).json()).toMatchObject({ run: { state: 'paused', reason: 'stopped by you' } });
    await until(() => fake.active === 0);
    fake.delayMs = 8;
    await post(`/api/projects/${p.id}/run/resume`);
    await until(async () => (await runState(p.id)) === 'awaiting_review', 15_000);
    expect(fake.maxActive).toBeLessThanOrEqual(3);
  });

  it('retries a failed step and re-runs chapters from a stage', async () => {
    await ready();
    const p = await s.createProject();
    fake.on(`critique:${CH1}`, { fault: 'nothing' }, { fault: 'nothing' });
    await post(`/api/projects/${p.id}/run/start`);
    await until(async () => (await runState(p.id)) === 'paused', 15_000);
    const pipeline = await get(`/api/projects/${p.id}/pipeline`);
    expect(pipeline.run.reason).toMatch(/1 step failed/);
    expect(pipeline.steps[`${CH1}/critique`]).toMatchObject({ state: 'failed', attempts: 2 });
    expect(pipeline.progress.failed).toBe(1);
    expect((await post(`/api/projects/${p.id}/steps/retry`, { id: 'nope' })).status).toBe(404);
    expect((await post(`/api/projects/${p.id}/steps/retry`, { id: `${CH1}/critique` })).status).toBe(200);
    await until(async () => (await runState(p.id)) === 'awaiting_review', 15_000);

    expect((await post(`/api/projects/${p.id}/chapters/rerun`, { chapters: [], from: 'final' })).status).toBe(400);
    expect((await post(`/api/projects/${p.id}/chapters/rerun`, { chapters: [CH1], from: 'summarize' })).status).toBe(400);
    const before = fake.calls.length;
    expect(await (await post(`/api/projects/${p.id}/chapters/rerun`, { chapters: [CH1, 'nope'], from: 'critique', note: 'be bolder' })).json()).toEqual({ ok: true, chapters: [CH1] });
    await until(async () => (await runState(p.id)) === 'awaiting_review', 15_000);
    expect(fake.calls.slice(before).map((c) => c.mode)).toEqual(['critique', 'final', 'verify']);
    expect(fake.calls[before].prompt).toContain('be bolder');
  });

  it('edits the plan and the instructions', async () => {
    await ready();
    const p = await s.createProject({}, { chapters: 3 });
    await post(`/api/projects/${p.id}/run/start`);
    await until(async () => (await get(`/api/projects/${p.id}/pipeline`)).steps.prepare.state === 'done');
    expect((await patch(`/api/projects/${p.id}/chapters/nope`, { excluded: true })).status).toBe(404);
    expect(await (await patch(`/api/projects/${p.id}/chapters/chapter3.xhtml`, { excluded: true, note: 'skip for now', title: 'Three' })).json()).toMatchObject({ key: 'chapter3.xhtml', excluded: true, note: 'skip for now', title: 'Three' });
    expect((await put(`/api/projects/${p.id}/instructions`, { context: 42 })).status).toBe(400);
    expect(await (await put(`/api/projects/${p.id}/instructions`, { context: ' Formal register. ' })).json()).toEqual({ ok: true, context: 'Formal register.' });
    await until(async () => (await runState(p.id)) === 'awaiting_review', 15_000);
    expect(fake.calls.some((c) => c.chapter === 'chapter3.xhtml' && c.mode === 'translate')).toBe(false);
    expect(fake.calls.filter((c) => c.mode === 'translate').every((c) => c.prompt.includes('Formal register.'))).toBe(true);
    const contents = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'projects', p.id, 'workspace', 'notes', 'contents.json'), 'utf8'));
    expect(contents.map((c: { filename: string }) => c.filename)).toEqual([CH1, CH2]);
  });

  it('refuses a revert while running, and re-reads the files after one', async () => {
    await ready();
    const p = await s.createProject();
    fake.delayMs = 40;
    await post(`/api/projects/${p.id}/run/start`);
    await until(() => fake.calls.length >= 1);
    const versions = await get(`/api/projects/${p.id}/versions`);
    expect((await post(`/api/projects/${p.id}/versions/${versions.at(-1).id}/revert`)).status).toBe(409);
    await post(`/api/projects/${p.id}/run/pause`);
    await until(() => fake.active === 0);
    expect((await post(`/api/projects/${p.id}/versions/${versions.at(-1).id}/revert`)).status).toBe(200);
    const pipeline = await get(`/api/projects/${p.id}/pipeline`);
    expect(pipeline.steps.prepare.state).toBe('pending');
  });
});

describe('workspace files', () => {
  it('lists, reads and serves files, and keeps requests inside the workspace', async () => {
    await ready();
    const p = await s.createProject();
    await runToReview(p.id);
    const files = await get(`/api/projects/${p.id}/files`);
    const paths = files.map((f: { path: string }) => f.path);
    expect(paths).toEqual(expect.arrayContaining(['source.epub', 'final/OEBPS/chapter1.xhtml', 'notes/master_glossary.json', `critique/${CH1}.critique.md`]));
    expect(paths.some((x: string) => x.startsWith('.git'))).toBe(false);
    expect(files.find((f: { path: string }) => f.path === 'source.epub').kind).toBe('binary');
    expect(files.find((f: { path: string }) => f.path === 'final/OEBPS/chapter1.xhtml').kind).toBe('text');

    const c = await get(`/api/projects/${p.id}/files/content?path=${encodeURIComponent('final/OEBPS/chapter1.xhtml')}`);
    expect(c).toMatchObject({ content: expect.stringContaining('ES'), truncated: false });
    expect((await s.request(`/api/projects/${p.id}/files/content?path=source.epub`)).status).toBe(415);
    expect((await s.request(`/api/projects/${p.id}/files/raw?path=source.epub`)).status).toBe(200);

    for (const bad of ['../project.json', '../../session-secret', '.git/config', 'final/../.git/HEAD', 'missing.txt', 'final']) {
      expect((await s.request(`/api/projects/${p.id}/files/content?path=${encodeURIComponent(bad)}`)).status, bad).toBe(404);
      expect((await s.request(`/api/projects/${p.id}/files/raw?path=${encodeURIComponent(bad)}`)).status, bad).toBe(404);
    }
  });
});

describe('versions', () => {
  it('snapshots on request and lists the engine\'s milestones', async () => {
    await ready();
    const p = await s.createProject();
    await runToReview(p.id);
    fs.writeFileSync(path.join(s.dataDir, 'projects', p.id, 'workspace', 'manual.txt'), 'x');
    const snap = await (await post(`/api/projects/${p.id}/versions`, { label: 'mine' })).json();
    expect(snap.label).toBe('mine');
    expect(await (await post(`/api/projects/${p.id}/versions`, {})).json()).toEqual({ unchanged: true });
    const labels = (await get(`/api/projects/${p.id}/versions`)).map((v: { label: string }) => v.label);
    expect(labels).toContain('initialization complete');
    expect((await post(`/api/projects/${p.id}/versions/ffffffff/revert`)).status).toBe(404);
  });
});

describe('cover and repackaging', () => {
  it('stores one cover override, applies it when packaging, and repackages on demand', async () => {
    await ready();
    const p = await s.createProject();
    const upload = async (name: string, body: Buffer) => {
      const form = new FormData();
      form.append('cover', new Blob([new Uint8Array(body)]), name);
      return s.request(`/api/projects/${p.id}/cover`, { method: 'POST', body: form });
    };
    expect((await upload('cover.bmp', PNG)).status).toBe(400);
    expect((await post(`/api/projects/${p.id}/repackage`)).status).toBe(400);
    expect(await (await upload('a.jpg', Buffer.from('jpeg'))).json()).toEqual({ ok: true, coverFilename: 'cover_override.jpg' });
    const newCover = Buffer.concat([PNG, Buffer.from('custom')]);
    expect(await (await upload('b.PNG', newCover)).json()).toEqual({ ok: true, coverFilename: 'cover_override.png' });
    const ws = path.join(s.dataDir, 'projects', p.id, 'workspace');
    expect(fs.readdirSync(ws).filter((f) => f.startsWith('cover_override'))).toEqual(['cover_override.png']);

    await runToReview(p.id);
    await post(`/api/projects/${p.id}/review`, { decision: 'approve' });
    await until(async () => (await statusOf(p.id)) === 'completed', 10_000);
    // The engine applied the override while packaging.
    expect(readEntry(path.join(ws, 'translated_book.epub'), 'OEBPS/images/cover.png').equals(newCover)).toBe(true);
    const third = Buffer.concat([PNG, Buffer.from('third')]);
    await upload('c.png', third);
    expect((await post(`/api/projects/${p.id}/repackage`)).status).toBe(200);
    expect(readEntry(path.join(ws, 'translated_book.epub'), 'OEBPS/images/cover.png').equals(third)).toBe(true);
    expect((await get(`/api/projects/${p.id}/versions`))[0].label).toBe('repackaged with custom cover');
  });
});
