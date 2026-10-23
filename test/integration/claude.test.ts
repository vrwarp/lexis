import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { restoreEnv } from '../support/boot.js';
import { type TestServer, startServer } from '../support/server.js';

let s: TestServer;
afterEach(async () => {
  await s?.close();
  restoreEnv();
});

describe('/api/claude', () => {
  it('reports no credential, the configured models, and refuses to start work', async () => {
    s = await startServer();
    await s.login();
    const status = await (await s.request('/api/claude')).json();
    expect(status).toMatchObject({
      credential: 'none',
      auth: 'needs_login',
      shadowedByEnv: false,
      hasLoginFile: false,
      inProgress: null,
      models: { translation: 'claude-opus-5-5', mechanical: 'claude-sonnet-5-5', orchestrator: 'claude-sonnet-5-5' },
      effort: { translation: 'high', mechanical: 'medium', orchestrator: 'medium' },
    });
    const p = await s.createProject();
    const r = await s.request(`/api/projects/${p.id}/start`, { method: 'POST' });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/Claude is not linked/);
  });

  it('links a subscription from the browser flow, reports the account, and signs out', async () => {
    s = await startServer();
    await s.login();
    const start = await (await s.request('/api/claude/login/start', { method: 'POST' })).json();
    expect(start.url).toMatch(/^https:\/\/claude\.com\//);
    expect((await (await s.request('/api/claude')).json()).inProgress).toEqual(start);

    const bad = await (await s.request('/api/claude/login/code', { method: 'POST', json: { id: start.id, code: 'nope' } })).json();
    expect(bad).toEqual({ ok: false, error: 'Invalid code' });

    const again = await (await s.request('/api/claude/login/start', { method: 'POST' })).json();
    const good = await (await s.request('/api/claude/login/code', { method: 'POST', json: { id: again.id, code: 'good-code' } })).json();
    expect(good).toEqual({ ok: true, account: { email: 'reader@example.com', subscriptionType: 'max' } });
    expect(fs.existsSync(path.join(s.dataDir, 'claude', '.credentials.json'))).toBe(true);

    const linked = await (await s.request('/api/claude?account=1')).json();
    expect(linked).toMatchObject({ credential: 'login', auth: 'ok', hasLoginFile: true, account: { email: 'reader@example.com' } });

    expect(await (await s.request('/api/claude/logout', { method: 'POST' })).json()).toEqual({ ok: true });
    expect(await (await s.request('/api/claude')).json()).toMatchObject({ credential: 'none', hasLoginFile: false });
  });

  it('cancels a pending sign-in', async () => {
    s = await startServer();
    await s.login();
    await s.request('/api/claude/login/start', { method: 'POST' });
    await s.request('/api/claude/login/cancel', { method: 'POST' });
    expect((await (await s.request('/api/claude')).json()).inProgress).toBeNull();
  });

  it('says when an environment credential outranks the web sign-in', async () => {
    s = await startServer({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok' } });
    await s.login();
    expect(await (await s.request('/api/claude')).json()).toMatchObject({ credential: 'oauth_token', shadowedByEnv: true, auth: 'ok' });
  });

  it('turns a missing binary into a clear error', async () => {
    s = await startServer({ env: { CLAUDE_BINARY: '/bin/false' } });
    await s.login();
    const r = await s.request('/api/claude/login/start', { method: 'POST' });
    expect(r.status).toBe(502);
    expect((await r.json()).error).toBeTruthy();
  });
});
