import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_CLAUDE, freshEnv, restoreEnv } from '../support/boot.js';
import { fakeQuery } from '../support/fake-sdk.js';

afterEach(restoreEnv);

async function load(vars: Record<string, string | undefined> = {}) {
  const dataDir = freshEnv(vars);
  const claude = await import('../../src/claude.js');
  const { env } = await import('../../src/env.js');
  const { sdk } = await import('../../src/sdk.js');
  sdk.query = fakeQuery(async () => {}, () => ({ email: 'reader@example.com', subscriptionType: 'max' }));
  return { dataDir, env, ...claude };
}

describe('findClaudeBinary', () => {
  it('honours CLAUDE_BINARY', async () => {
    const { findClaudeBinary } = await load();
    expect(findClaudeBinary()).toBe(FAKE_CLAUDE);
  });

  it('finds the binary the SDK ships for this platform', async () => {
    const { findClaudeBinary } = await load({ CLAUDE_BINARY: undefined });
    const found = findClaudeBinary();
    expect(found).toMatch(/claude-agent-sdk-[a-z0-9-]+[/\\]claude(\.exe)?$/);
    expect(fs.existsSync(found!)).toBe(true);
  });
});

describe('claudeEnv', () => {
  it('points Claude Code at the data volume and quiets it', async () => {
    const { claudeEnv, env } = await load();
    const e = claudeEnv();
    expect(e.CLAUDE_CONFIG_DIR).toBe(env.claudeConfigDir);
    expect(e.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
    expect(e.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
  });
});

describe('probeAuth', () => {
  it('needs a login with no credential, and trusts an environment token without spawning', async () => {
    const { probeAuth } = await load();
    expect(await probeAuth(true)).toBe('needs_login');
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok';
    expect(await probeAuth(true)).toBe('ok');
  });

  it('asks `claude auth status` about a login file, and caches the answer', async () => {
    const { probeAuth, env } = await load();
    fs.mkdirSync(env.claudeConfigDir, { recursive: true });
    fs.writeFileSync(path.join(env.claudeConfigDir, '.credentials.json'), '{}');
    expect(await probeAuth(true)).toBe('ok');
    fs.rmSync(path.join(env.claudeConfigDir, '.credentials.json'));
    fs.writeFileSync(path.join(env.claudeConfigDir, '.credentials.json'), '{}');
    expect(await probeAuth()).toBe('ok');
  });

  it('reports unknown when the binary cannot answer', async () => {
    const { probeAuth, env } = await load({ CLAUDE_BINARY: '/nonexistent/claude' });
    fs.mkdirSync(env.claudeConfigDir, { recursive: true });
    fs.writeFileSync(path.join(env.claudeConfigDir, '.credentials.json'), '{}');
    expect(await probeAuth(true)).toBe('unknown');
  });
});

describe('readAccount', () => {
  it('returns the account Claude Code reports at initialization', async () => {
    const { readAccount } = await load();
    expect(await readAccount()).toEqual({ email: 'reader@example.com', organization: undefined, subscriptionType: 'max' });
  });
});

describe('envCredentialShadowsLogin', () => {
  it('is true only for environment credentials', async () => {
    const { envCredentialShadowsLogin } = await load();
    expect(envCredentialShadowsLogin()).toBe(false);
    process.env.ANTHROPIC_API_KEY = 'k';
    expect(envCredentialShadowsLogin()).toBe(true);
  });
});

describe('ClaudeLogin', () => {
  it('offers a link, accepts the right code, and promotes the login to the SDK config dir', async () => {
    const { ClaudeLogin, env } = await load();
    const login = new ClaudeLogin();
    const { id, url } = await login.start();
    expect(url).toBe('https://claude.com/cai/oauth/authorize?code=true&client_id=fake&state=xyz');
    expect(login.inProgress).toEqual({ id, url });
    const r = await login.submit(id, '  good-code \n');
    expect(r).toEqual({ ok: true, account: { email: 'reader@example.com', organization: undefined, subscriptionType: 'max' } });
    expect(fs.existsSync(path.join(env.claudeConfigDir, '.credentials.json'))).toBe(true);
    expect(login.inProgress).toBeNull();
    expect(fs.readdirSync(path.join(env.dataDir, 'claude-login'))).toEqual([]);
  });

  it('reports a rejected code, cleans up, and leaves an existing login alone', async () => {
    const { ClaudeLogin, env } = await load();
    fs.mkdirSync(env.claudeConfigDir, { recursive: true });
    fs.writeFileSync(path.join(env.claudeConfigDir, '.credentials.json'), 'previous');
    const login = new ClaudeLogin();
    const { id } = await login.start();
    expect(await login.submit(id, 'bad-code')).toEqual({ ok: false, error: 'Invalid code' });
    expect(login.inProgress).toBeNull();
    expect(fs.readFileSync(path.join(env.claudeConfigDir, '.credentials.json'), 'utf8')).toBe('previous');
  });

  it('refuses an empty code, a stale id, and a code sent twice', async () => {
    const { ClaudeLogin } = await load();
    const login = new ClaudeLogin();
    const { id } = await login.start();
    expect(await login.submit(id, '   ')).toEqual({ ok: false, error: 'Paste the code Claude showed you.' });
    expect(await login.submit('other', 'good-code')).toEqual({ ok: false, error: 'That sign-in has expired. Start again.' });
    const first = login.submit(id, 'good-code');
    expect(await login.submit(id, 'good-code')).toEqual({ ok: false, error: 'That code was already used. Start again.' });
    expect((await first).ok).toBe(true);
  });

  it('replaces a half-finished sign-in when started again, and cancels', async () => {
    const { ClaudeLogin } = await load();
    const login = new ClaudeLogin();
    const a = await login.start();
    const b = await login.start();
    expect(b.id).not.toBe(a.id);
    expect(await login.submit(a.id, 'good-code')).toMatchObject({ ok: false });
    login.cancel(a.id); // a stale id cancels nothing
    expect(login.inProgress?.id).toBe(b.id);
    login.cancel();
    expect(login.inProgress).toBeNull();
  });

  it('fails clearly when the binary is missing or offers no link', async () => {
    const { ClaudeLogin, LoginError } = await load({ CLAUDE_BINARY: '/bin/false' });
    const login = new ClaudeLogin();
    await expect(login.start()).rejects.toBeInstanceOf(LoginError);
    expect(login.inProgress).toBeNull();
  });

  it('signs out by removing the login file', async () => {
    const { ClaudeLogin, env, probeAuth } = await load();
    const login = new ClaudeLogin();
    const { id } = await login.start();
    await login.submit(id, 'good-code');
    await login.signOut();
    expect(fs.existsSync(path.join(env.claudeConfigDir, '.credentials.json'))).toBe(false);
    expect(await probeAuth()).toBe('needs_login');
  });
});
