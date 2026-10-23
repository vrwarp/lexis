import { afterEach, describe, expect, it } from 'vitest';
import { restoreEnv } from '../support/boot.js';
import { type TestServer, startServer } from '../support/server.js';

let s: TestServer;
afterEach(async () => {
  await s?.close();
  restoreEnv();
});

/** Every API route but sign-in itself, as (method, path). */
const PROTECTED: [string, string][] = [
  ['GET', '/api/projects'],
  ['POST', '/api/projects'],
  ['GET', '/api/projects/x'],
  ['GET', '/api/projects/x/events'],
  ['POST', '/api/projects/x/start'],
  ['POST', '/api/projects/x/message'],
  ['POST', '/api/projects/x/review'],
  ['POST', '/api/projects/x/interrupt'],
  ['GET', '/api/projects/x/versions'],
  ['POST', '/api/projects/x/versions'],
  ['POST', '/api/projects/x/versions/abc/revert'],
  ['GET', '/api/projects/x/files'],
  ['GET', '/api/projects/x/files/content'],
  ['GET', '/api/projects/x/files/raw'],
  ['POST', '/api/projects/x/files/comment'],
  ['POST', '/api/projects/x/cover'],
  ['POST', '/api/projects/x/repackage'],
  ['GET', '/api/projects/x/download'],
  ['GET', '/api/claude'],
  ['POST', '/api/claude/login/start'],
  ['POST', '/api/claude/login/code'],
  ['POST', '/api/claude/login/cancel'],
  ['POST', '/api/claude/logout'],
];

describe('the password gate', () => {
  it('leaves the health check, the UI shell and the session probe open', async () => {
    s = await startServer();
    expect(await (await s.request('/healthz')).json()).toEqual({ ok: true });
    const html = await (await s.request('/')).text();
    expect(html).toContain('id="login-screen"');
    expect((await s.request('/app.js')).status).toBe(200);
    expect(await (await s.request('/api/session')).json()).toEqual({ signedIn: false, passwordSet: true });
  });

  it('refuses every API route without a valid cookie', async () => {
    s = await startServer();
    for (const [method, p] of PROTECTED) {
      const plain = await s.request(p, { method });
      expect(plain.status, `${method} ${p}`).toBe(401);
      const forged = await s.request(p, { method, headers: { cookie: 'lexis_auth=abc.def' } });
      expect(forged.status, `${method} ${p} forged`).toBe(401);
    }
  });

  it('signs in with the password only, and out again', async () => {
    s = await startServer();
    for (const json of [{ password: 'nope' }, {}, { password: ['test-password'] }, { password: 42 }]) {
      const r = await s.request('/api/login', { method: 'POST', json });
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: 'Wrong password' });
    }
    const ok = await s.request('/api/login', { method: 'POST', json: { password: 'test-password' } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('set-cookie')).toMatch(/^lexis_auth=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
    expect(await (await s.request('/api/session')).json()).toEqual({ signedIn: true, passwordSet: true });
    expect((await s.request('/api/projects')).status).toBe(200);

    const out = await s.request('/api/logout', { method: 'POST' });
    expect(out.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    expect((await s.request('/api/projects')).status).toBe(401);
  });

  it('marks the cookie Secure when COOKIE_SECURE=1', async () => {
    s = await startServer({ env: { COOKIE_SECURE: '1' } });
    const ok = await s.request('/api/login', { method: 'POST', json: { password: 'test-password' } });
    expect(ok.headers.get('set-cookie')).toMatch(/; Secure$/);
  });

  it('lets nobody in while LEXIS_PASSWORD is unset', async () => {
    s = await startServer({ env: { LEXIS_PASSWORD: '' } });
    expect(await (await s.request('/api/session')).json()).toEqual({ signedIn: false, passwordSet: false });
    const r = await s.request('/api/login', { method: 'POST', json: { password: '' } });
    expect(r.status).toBe(503);
  });

  it('closes a WebSocket without the cookie', async () => {
    s = await startServer();
    const { closed } = await s.ws('project=x', true);
    expect(await closed).toBe(4001);
  });
});
