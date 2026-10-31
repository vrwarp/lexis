import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SoftAuthenticator } from '../support/authenticator.js';
import { restoreEnv } from '../support/boot.js';
import { type TestServer, startServer } from '../support/server.js';

let s: TestServer;
afterEach(async () => {
  await s?.close();
  restoreEnv();
});

/** Every route that needs a session, as (method, path). */
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
  ['GET', '/api/auth/security'],
  ['POST', '/api/auth/stepup/password'],
  ['POST', '/api/auth/stepup/passkey/options'],
  ['POST', '/api/auth/stepup/passkey/verify'],
  ['POST', '/api/auth/passkeys/options'],
  ['POST', '/api/auth/passkeys/verify'],
  ['POST', '/api/auth/passkeys/x/rename'],
  ['DELETE', '/api/auth/passkeys/x'],
  ['DELETE', '/api/auth/sessions/x'],
  ['POST', '/api/auth/sessions/revoke-others'],
];

const json = async (r: Response) => r.json();
const post = (p: string, body?: unknown) => s.request(p, { method: 'POST', ...(body === undefined ? {} : { json: body }) });

/** Register a passkey for the signed-in client and return the device holding it. */
async function addPasskey(name = 'Laptop'): Promise<SoftAuthenticator> {
  const device = new SoftAuthenticator(s.base);
  const { challengeId, options } = await json(await post('/api/auth/passkeys/options'));
  const r = await post('/api/auth/passkeys/verify', { challengeId, response: device.create(options), name });
  expect(r.status).toBe(200);
  return device;
}

async function passkeySignIn(device: SoftAuthenticator): Promise<Response> {
  const { challengeId, options } = await json(await post('/api/auth/passkey/options'));
  return post('/api/auth/passkey/verify', { challengeId, response: device.get(options) });
}

/** Make the current session look as if it signed in long ago (the store re-reads its file). */
function ageSession(dataDir: string): void {
  const file = path.join(dataDir, 'auth', 'auth.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const sess of state.sessions) sess.verifiedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(state));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
}

describe('open routes and headers', () => {
  it('serves the health check, the UI shell, the WebAuthn helper and the sign-in state without a session', async () => {
    s = await startServer();
    expect(await json(await s.request('/healthz'))).toEqual({ ok: true });
    expect(await (await s.request('/')).text()).toContain('id="login-screen"');
    expect((await s.request('/app.js')).status).toBe(200);
    expect(await (await s.request('/vendor/webauthn.js')).text()).toContain('SimpleWebAuthnBrowser');
    expect(await json(await s.request('/api/auth/state'))).toEqual({ signedIn: false, passwordSet: true, passkeys: false });
  });

  it('sends security headers on every response', async () => {
    s = await startServer();
    for (const p of ['/', '/healthz', '/api/projects']) {
      const r = await s.request(p);
      expect(r.headers.get('content-security-policy'), p).toContain("frame-ancestors 'none'");
      expect(r.headers.get('content-security-policy'), p).toContain("script-src 'self'");
      expect(r.headers.get('x-frame-options'), p).toBe('DENY');
      expect(r.headers.get('x-content-type-options'), p).toBe('nosniff');
      expect(r.headers.get('referrer-policy'), p).toBe('no-referrer');
      expect(r.headers.get('x-powered-by'), p).toBeNull();
      expect(r.headers.get('strict-transport-security'), p).toBeNull();
    }
  });

  it('adds HSTS when served over https', async () => {
    s = await startServer({ env: { COOKIE_SECURE: '1' } });
    expect((await s.request('/healthz')).headers.get('strict-transport-security')).toMatch(/max-age=31536000/);
  });
});

describe('sessions', () => {
  it('refuses every protected route without a valid session cookie', async () => {
    s = await startServer();
    for (const [method, p] of PROTECTED) {
      expect((await s.request(p, { method })).status, `${method} ${p}`).toBe(401);
      expect((await s.request(p, { method, headers: { cookie: 'lexis_session=forged' } })).status, `${method} ${p} forged`).toBe(401);
    }
  });

  it('signs in with the password and signs out for real: the old cookie stops working', async () => {
    s = await startServer();
    for (const body of [{ password: 'nope' }, {}, { password: ['test-password'] }, { password: 42 }]) {
      const r = await post('/api/auth/password', body);
      expect(r.status).toBe(401);
      expect(await json(r)).toEqual({ error: 'Wrong password' });
    }
    const ok = await post('/api/auth/password', { password: 'test-password' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('set-cookie')).toMatch(/^lexis_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000$/);
    expect((await json(await s.request('/api/auth/state'))).signedIn).toBe(true);
    const stolen = s.cookie();

    await post('/api/auth/logout');
    expect((await s.request('/api/projects')).status).toBe(401);
    expect((await s.request('/api/projects', { headers: { cookie: stolen } })).status).toBe(401);
  });

  it('uses a __Host- cookie over https', async () => {
    s = await startServer({ env: { COOKIE_SECURE: '1' } });
    const ok = await post('/api/auth/password', { password: 'test-password' });
    expect(ok.headers.get('set-cookie')).toMatch(/^__Host-lexis=.*; Secure$/);
  });

  it('locks out password guessing after five tries, even for the right password', async () => {
    s = await startServer();
    for (let i = 0; i < 5; i++) expect((await post('/api/auth/password', { password: `guess-${i}` })).status).toBe(401);
    const blocked = await post('/api/auth/password', { password: 'test-password' });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(800);
  });

  it('lets nobody in by password while LEXIS_PASSWORD is unset', async () => {
    s = await startServer({ env: { LEXIS_PASSWORD: '' } });
    expect((await json(await s.request('/api/auth/state'))).passwordSet).toBe(false);
    expect((await post('/api/auth/password', { password: '' })).status).toBe(503);
  });

  it('lists signed-in browsers and signs others out', async () => {
    s = await startServer();
    await s.login();
    const first = s.cookie();
    await s.login();
    const second = s.cookie();
    const sec = await json(await s.request('/api/auth/security'));
    expect(sec.sessions).toHaveLength(2);
    expect(sec.sessions.filter((x: { current: boolean }) => x.current)).toHaveLength(1);
    expect(sec.sessions[0]).toMatchObject({ method: 'password', ip: expect.any(String), userAgent: expect.any(String) });
    expect(sec.sessions[0].id).toMatch(/^[0-9a-f]{16}$/);

    expect(await json(await post('/api/auth/sessions/revoke-others'))).toEqual({ ok: true, signedOut: 1 });
    expect((await s.request('/api/projects', { headers: { cookie: first } })).status).toBe(401);
    expect((await s.request('/api/projects', { headers: { cookie: second } })).status).toBe(200);

    const mine = (await json(await s.request('/api/auth/security'))).sessions[0].id;
    expect((await s.request('/api/auth/sessions/0000000000000000', { method: 'DELETE' })).status).toBe(404);
    const out = await s.request(`/api/auth/sessions/${mine}`, { method: 'DELETE' });
    expect(out.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    expect((await s.request('/api/projects', { headers: { cookie: second } })).status).toBe(401);
  });
});

describe('cross-site protection', () => {
  it('refuses writes from another site, even with a valid session', async () => {
    s = await startServer();
    await s.login();
    const r = await s.request('/api/projects/x/message', { method: 'POST', json: { text: 'hi' }, headers: { origin: 'https://evil.example' } });
    expect(r.status).toBe(403);
    const login = await s.request('/api/auth/password', { method: 'POST', json: { password: 'test-password' }, headers: { origin: 'https://evil.example' } });
    expect(login.status).toBe(403);
  });

  it('closes WebSockets opened from another site or without a session', async () => {
    s = await startServer();
    await s.login();
    const WebSocket = (await import('ws')).default;
    const evil = new WebSocket(`${s.base.replace('http', 'ws')}/ws?project=x`, { headers: { cookie: s.cookie() }, origin: 'https://evil.example' });
    expect(await new Promise((r) => evil.on('close', r))).toBe(4003);
    const { closed } = await s.ws('project=x', true);
    expect(await closed).toBe(4001);
  });
});

describe('passkeys', () => {
  it('sets up a passkey after a password sign-in, then signs in with it; the password stays as backup', async () => {
    s = await startServer();
    await s.login();
    const { options } = await json(await post('/api/auth/passkeys/options'));
    expect(options.rp.id).toBe('localhost');
    const device = await addPasskey('Laptop');

    expect(await json(await s.request('/api/auth/state'))).toMatchObject({ signedIn: true, passkeys: true });
    const sec = await json(await s.request('/api/auth/security'));
    expect(sec.passkeys).toEqual([expect.objectContaining({ name: 'Laptop', deviceType: 'multiDevice', backedUp: true })]);
    expect(sec.passkeys[0].publicKey).toBeUndefined();

    await post('/api/auth/logout');
    const signedIn = await passkeySignIn(device);
    expect(signedIn.status).toBe(200);
    expect((await s.request('/api/projects')).status).toBe(200);
    const after = await json(await s.request('/api/auth/security'));
    expect(after.sessions.find((x: { current: boolean }) => x.current).method).toBe('passkey');
    expect(after.passkeys[0].lastUsedAt).toBeTruthy();

    // The password still signs in, as the backup.
    await post('/api/auth/logout');
    expect((await post('/api/auth/password', { password: 'test-password' })).status).toBe(200);
  });

  it('offers no passkey sign-in before one exists, and rejects a garbage response', async () => {
    s = await startServer();
    expect((await post('/api/auth/passkey/options')).status).toBe(404);
    await s.login();
    await addPasskey();
    await post('/api/auth/logout');
    const { challengeId } = await json(await post('/api/auth/passkey/options'));
    const bad = await post('/api/auth/passkey/verify', { challengeId, response: { id: 'nope', response: {} } });
    expect(bad.status).toBe(400);
    expect((await s.request('/api/projects')).status).toBe(401);
  });

  it('does not accept a passkey from another site', async () => {
    s = await startServer();
    await s.login();
    const device = await addPasskey();
    await post('/api/auth/logout');
    const { challengeId, options } = await json(await post('/api/auth/passkey/options'));
    const phished = await post('/api/auth/passkey/verify', { challengeId, response: device.get(options, { origin: 'https://lexis-login.example' }) });
    expect(phished.status).toBe(400);
  });

  it('pins passkeys to LEXIS_PUBLIC_URL', async () => {
    s = await startServer({ env: { LEXIS_PUBLIC_URL: 'https://lexis.example.com' } });
    // A browser on another origin cannot even write here.
    expect((await post('/api/auth/password', { password: 'test-password' })).status).toBe(403);
    const r = await s.request('/api/auth/password', { method: 'POST', json: { password: 'test-password' }, headers: { origin: 'https://lexis.example.com' } });
    expect(r.status).toBe(200);
    const opts = await json(await s.request('/api/auth/passkeys/options', { method: 'POST', headers: { origin: 'https://lexis.example.com' } }));
    expect(opts.options.rp.id).toBe('lexis.example.com');
  });

  it('asks a browser that signed in a while ago to confirm before adding or removing a passkey', async () => {
    s = await startServer();
    await s.login();
    const device = await addPasskey('First');
    ageSession(s.dataDir);

    const blocked = await post('/api/auth/passkeys/options');
    expect(blocked.status).toBe(403);
    expect(await json(blocked)).toEqual({ error: 'Confirm it is you first.', stepUp: 'passkey' });
    const id = (await json(await s.request('/api/auth/security'))).passkeys[0].id;
    expect((await s.request(`/api/auth/passkeys/${id}`, { method: 'DELETE' })).status).toBe(403);
    // Renaming is harmless and needs no confirmation.
    expect((await post(`/api/auth/passkeys/${id}/rename`, { name: 'Renamed' })).status).toBe(200);

    // Step up with the passkey…
    const { challengeId, options } = await json(await post('/api/auth/stepup/passkey/options'));
    expect((await post('/api/auth/stepup/passkey/verify', { challengeId, response: device.get(options) })).status).toBe(200);
    expect((await json(await s.request('/api/auth/security'))).fresh).toBe(true);
    expect((await post('/api/auth/passkeys/options')).status).toBe(200);

    // …or with the password, the backup.
    ageSession(s.dataDir);
    expect((await post('/api/auth/stepup/password', { password: 'wrong' })).status).toBe(401);
    expect((await post('/api/auth/stepup/password', { password: 'test-password' })).status).toBe(200);
    const del = await s.request(`/api/auth/passkeys/${id}`, { method: 'DELETE' });
    expect(await json(del)).toEqual({ ok: true, remaining: 0 });
    expect((await s.request('/api/auth/passkeys/nope', { method: 'DELETE' })).status).toBe(404);
  });

  it('will not let one session finish a registration another session started', async () => {
    s = await startServer();
    await s.login();
    const { challengeId, options } = await json(await post('/api/auth/passkeys/options'));
    await s.login(); // a different session now
    const device = new SoftAuthenticator(s.base);
    const r = await post('/api/auth/passkeys/verify', { challengeId, response: device.create(options) });
    expect(r.status).toBe(400);
    expect((await json(r)).error).toMatch(/expired/);
  });

  it('can be reset from the host with the recovery command', async () => {
    s = await startServer();
    await s.login();
    await addPasskey();
    const env = { ...process.env, LEXIS_DATA_DIR: s.dataDir };
    const status = execFileSync('npx', ['tsx', 'src/cli.ts', 'status'], { env, encoding: 'utf8' });
    expect(status).toContain('passkeys: 1');
    expect(status).toContain('password sign-in: on (backup)');
    execFileSync('npx', ['tsx', 'src/cli.ts', 'reset-passkeys'], { env });
    expect((await s.request('/api/projects')).status).toBe(401);
    expect(await json(await s.request('/api/auth/state'))).toMatchObject({ passkeys: false, signedIn: false });
  });
});
