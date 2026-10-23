import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { restoreEnv, until } from '../support/boot.js';
import { PNG, readEntry } from '../support/epub.js';
import { type TestServer, startServer } from '../support/server.js';

let s: TestServer;
afterEach(async () => {
  await s?.close();
  restoreEnv();
});

/** A signed-in server whose Claude credential comes from the environment. */
async function ready() {
  s = await startServer({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok' } });
  await s.login();
  return s;
}

const get = async (p: string) => (await s.request(p)).json();
const post = (p: string, json?: unknown) => s.request(p, { method: 'POST', ...(json === undefined ? {} : { json }) });
const statusOf = async (id: string) => (await get(`/api/projects/${id}`)).status as string;

async function runToReview(id: string) {
  expect((await post(`/api/projects/${id}/start`)).status).toBe(200);
  await until(async () => (await get(`/api/projects/${id}`)).awaitingReview, 8000, 'review gate');
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
    expect(detail).toMatchObject({ id: p.id, awaitingReview: false });
    expect(detail.versions[0].label).toBe('lexis: project created');
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
    for (const p of ['/api/projects/nope', '/api/projects/nope/events', '/api/projects/nope/files', '/api/projects/nope/download']) {
      expect((await s.request(p)).status, p).toBe(404);
    }
  });
});

describe('a full translation over HTTP', () => {
  it('runs to the review gate, approves, and serves the translated EPUB', async () => {
    await ready();
    const p = await s.createProject();
    await runToReview(p.id);
    expect(await statusOf(p.id)).toBe('awaiting_review');

    expect((await post(`/api/projects/${p.id}/review`, { decision: 'maybe' })).status).toBe(400);
    expect((await post(`/api/projects/${p.id}/review`, { decision: 'approve' })).status).toBe(200);
    expect((await post(`/api/projects/${p.id}/review`, { decision: 'approve' })).status).toBe(409);
    await until(async () => (await statusOf(p.id)) === 'completed', 8000, 'completed');

    const dl = await s.request(`/api/projects/${p.id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-disposition')).toContain('My Book (Spanish).epub');
    expect(Buffer.from(await dl.arrayBuffer()).subarray(0, 2).toString()).toBe('PK');

    const detail = await get(`/api/projects/${p.id}`);
    expect(detail.outputPath).toBe('translated_book.epub');
    expect(detail.usage.totalCostUsd).toBeCloseTo(0.07);
    expect(detail.versions.map((v: { label: string }) => v.label)).toEqual(
      expect.arrayContaining(['after preparation', 'all chapters finalized', 'packaged epub']),
    );

    const events = await get(`/api/projects/${p.id}/events`);
    expect(events[0].data.text).toMatch(/^Begin the translation of source.epub into Spanish\./);
    expect((await get(`/api/projects/${p.id}/events?after=${events.at(-2).seq}`)).length).toBe(1);
  });

  it('sends revision instructions back through the gate', async () => {
    await ready();
    const p = await s.createProject();
    await runToReview(p.id);
    expect((await post(`/api/projects/${p.id}/review`, { decision: 'revise', instructions: 'warmer' })).status).toBe(200);
    await until(async () => (await get(`/api/projects/${p.id}/events`)).filter((e: { type: string }) => e.type === 'review_request').length === 2);
    const resp = (await get(`/api/projects/${p.id}/events`)).find((e: { type: string }) => e.type === 'review_response');
    expect(resp.data).toEqual({ decision: 'revise', instructions: 'warmer' });
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
    await until(() => late.messages.some((m) => m.type === 'status' && (m.data as { status: string }).status === 'completed'), 8000);
    late.socket.close();

    const unknown = await s.ws('project=nope');
    expect(await unknown.closed).toBe(4004);
  });

  it('chats with the orchestrator and forwards file comments with the quoted passage', async () => {
    await ready();
    const p = await s.createProject();
    expect((await post(`/api/projects/${p.id}/message`, { text: '   ' })).status).toBe(400);
    expect((await post(`/api/projects/${p.id}/message`, { text: 'How long will this take?' })).status).toBe(200);
    await until(async () => (await get(`/api/projects/${p.id}/events`)).some((e: { type: string; data: { text?: string } }) => e.type === 'agent_text' && e.data.text?.startsWith('Noted: How long')));

    expect((await post(`/api/projects/${p.id}/files/comment`, { path: 'final/x', comment: '' })).status).toBe(400);
    expect((await post(`/api/projects/${p.id}/files/comment`, { path: '../../etc/passwd', comment: 'hi' })).status).toBe(400);
    expect((await post(`/api/projects/${p.id}/files/comment`, { path: 'final/ch1.xhtml', comment: 'Too stiff', excerpt: 'line one\nline two' })).status).toBe(200);
    const msg = (await get(`/api/projects/${p.id}/events`)).filter((e: { type: string }) => e.type === 'user_message').at(-1);
    expect(msg.data.text).toBe('[User comment on asset `final/ch1.xhtml`]\n\nRegarding this passage:\n> line one\n> line two\n\nToo stiff');
  });

  it('records an SDK failure as an error status', async () => {
    await ready();
    const p = await s.createProject();
    await post(`/api/projects/${p.id}/message`, { text: 'please explode' });
    await until(async () => (await statusOf(p.id)) === 'error');
    expect((await get(`/api/projects/${p.id}`)).lastError).toMatch(/simulated SDK failure/);
  });

  it('interrupts a running orchestrator', async () => {
    await ready();
    const p = await s.createProject();
    await runToReview(p.id);
    expect((await post(`/api/projects/${p.id}/interrupt`)).status).toBe(200);
  });
});

describe('workspace files', () => {
  it('lists, reads and serves files, and keeps requests inside the workspace', async () => {
    await ready();
    const p = await s.createProject();
    await runToReview(p.id);
    const files = await get(`/api/projects/${p.id}/files`);
    const paths = files.map((f: { path: string }) => f.path);
    expect(paths).toEqual(expect.arrayContaining(['source.epub', 'final/chapter1.xhtml', 'notes/master_glossary.json']));
    expect(paths.some((x: string) => x.startsWith('.git'))).toBe(false);
    expect(files.find((f: { path: string }) => f.path === 'source.epub').kind).toBe('binary');
    expect(files.find((f: { path: string }) => f.path === 'final/chapter1.xhtml').kind).toBe('text');

    const c = await get(`/api/projects/${p.id}/files/content?path=${encodeURIComponent('final/chapter1.xhtml')}`);
    expect(c).toMatchObject({ content: expect.stringContaining('¡Hola, mundo!'), truncated: false });
    expect((await s.request(`/api/projects/${p.id}/files/content?path=source.epub`)).status).toBe(415);
    expect((await s.request(`/api/projects/${p.id}/files/raw?path=source.epub`)).status).toBe(200);

    for (const bad of ['../project.json', '../../session-secret', '.git/config', 'final/../.git/HEAD', 'missing.txt', 'final']) {
      expect((await s.request(`/api/projects/${p.id}/files/content?path=${encodeURIComponent(bad)}`)).status, bad).toBe(404);
      expect((await s.request(`/api/projects/${p.id}/files/raw?path=${encodeURIComponent(bad)}`)).status, bad).toBe(404);
    }
  });
});

describe('versions', () => {
  it('snapshots on request and reverts, telling a live orchestrator', async () => {
    await ready();
    const p = await s.createProject();
    await runToReview(p.id);
    fs.writeFileSync(path.join(s.dataDir, 'projects', p.id, 'workspace', 'manual.txt'), 'x');
    const snap = await (await post(`/api/projects/${p.id}/versions`, { label: 'mine' })).json();
    expect(snap.label).toBe('mine');
    expect(await (await post(`/api/projects/${p.id}/versions`, {})).json()).toEqual({ unchanged: true });

    const versions = await get(`/api/projects/${p.id}/versions`);
    const prep = versions.find((v: { label: string }) => v.label === 'after preparation');
    const reverted = await (await post(`/api/projects/${p.id}/versions/${prep.id}/revert`)).json();
    expect(reverted.label).toMatch(/^revert to/);
    expect(fs.existsSync(path.join(s.dataDir, 'projects', p.id, 'workspace', 'final'))).toBe(false);
    const note = (await get(`/api/projects/${p.id}/events`)).filter((e: { type: string }) => e.type === 'user_message').at(-1);
    expect(note.data.text).toMatch(/reverted the workspace to version/);

    expect((await post(`/api/projects/${p.id}/versions/ffffffff/revert`)).status).toBe(404);
  });
});

describe('cover and repackaging', () => {
  it('stores one cover override and repackages the finished EPUB without agents', async () => {
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
    await until(async () => (await statusOf(p.id)) === 'completed', 8000);
    expect((await post(`/api/projects/${p.id}/repackage`)).status).toBe(200);
    expect(readEntry(path.join(ws, 'translated_book.epub'), 'OEBPS/images/cover.png').equals(newCover)).toBe(true);
    const versions = await get(`/api/projects/${p.id}/versions`);
    expect(versions[0].label).toBe('repackaged with custom cover');
  });
});
