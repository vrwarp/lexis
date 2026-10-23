import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  vi.resetModules();
});

/** env.ts and friends as a fresh boot of the server would load them, with this environment. */
async function boot(vars: Record<string, string>) {
  vi.resetModules();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis-test-'));
  process.env = { ...saved, LEXIS_DATA_DIR: dataDir, ...vars };
  return {
    dataDir,
    env: await import('./env.js'),
    auth: await import('./auth.js'),
    agents: await import('./agents.js'),
  };
}

describe('model tiers', () => {
  it('pins the strong model on translation and the cheaper one on everything else', async () => {
    const { agents } = await boot({});
    const all = agents.loadAgents();
    expect(Object.keys(all)).toHaveLength(15);
    for (const name of ['primary-translator', 'final-translator', 'native-critique', 'critique-charter-generator', 'metadata-generator', 'style-analyzer']) {
      expect(all[name].model, name).toBe('claude-opus-5-5');
      expect(all[name].effort, name).toBe('high');
    }
    for (const name of ['toc-generator', 'glossary-manager', 'omission-detector', 'ebook-packager']) {
      expect(all[name].model, name).toBe('claude-sonnet-5-5');
      expect(all[name].effort, name).toBe('medium');
    }
  });

  it('takes every tier from the environment', async () => {
    const { env, agents } = await boot({
      LEXIS_TRANSLATION_MODEL: 'claude-fable-5-1',
      LEXIS_MECHANICAL_MODEL: 'claude-haiku-5-5',
      LEXIS_TRANSLATION_EFFORT: 'xhigh',
      LEXIS_MECHANICAL_EFFORT: 'nonsense',
    });
    const all = agents.loadAgents();
    expect(all['primary-translator']).toMatchObject({ model: 'claude-fable-5-1', effort: 'xhigh' });
    expect(all['toc-generator']).toMatchObject({ model: 'claude-haiku-5-5', effort: 'medium' });
    expect(env.env.models.orchestrator).toBe('claude-haiku-5-5');
  });
});

describe('app sign-in', () => {
  it('accepts only the configured password, and none when it is unset', async () => {
    expect((await boot({ LEXIS_PASSWORD: 'correct horse' })).auth.checkPassword('correct horse')).toBe(true);
    expect((await boot({ LEXIS_PASSWORD: 'correct horse' })).auth.checkPassword('correct')).toBe(false);
    expect((await boot({ LEXIS_PASSWORD: '' })).auth.checkPassword('')).toBe(false);
  });

  it('verifies its own tokens and rejects forged or expired ones', async () => {
    const { auth } = await boot({ SESSION_SECRET: 'one' });
    const t = auth.makeToken();
    expect(auth.verifyToken(t)).toBe(true);
    expect(auth.isSignedIn(`a=1; ${auth.AUTH_COOKIE}=${t}`)).toBe(true);
    const [ts, sig] = t.split('.');
    expect(auth.verifyToken(`${ts}.${sig}x`)).toBe(false);
    expect(auth.verifyToken(undefined)).toBe(false);
    expect(auth.verifyToken('.')).toBe(false);
    const old = (Date.now() - 31 * 24 * 3600 * 1000).toString(36);
    expect(auth.verifyToken(`${old}.${sig}`)).toBe(false);
    expect((await boot({ SESSION_SECRET: 'two' })).auth.verifyToken(t)).toBe(false);
  });

  it('keeps a generated secret in the data directory so sign-ins survive a restart', async () => {
    const first = await boot({});
    const t = first.auth.makeToken();
    vi.resetModules();
    const env2 = await import('./env.js');
    const auth2 = await import('./auth.js');
    expect(env2.env.dataDir).toBe(first.dataDir);
    expect(auth2.verifyToken(t)).toBe(true);
  });
});

describe('credential detection', () => {
  it('follows Claude Code precedence', async () => {
    const { env, dataDir } = await boot({});
    const cfg = path.join(dataDir, 'claude');
    fs.mkdirSync(cfg, { recursive: true });
    expect(env.detectCredential({}, cfg)).toBe('none');
    fs.writeFileSync(path.join(cfg, '.credentials.json'), '{}');
    expect(env.detectCredential({}, cfg)).toBe('login');
    expect(env.detectCredential({ CLAUDE_CODE_OAUTH_TOKEN: 't' }, cfg)).toBe('oauth_token');
    expect(env.detectCredential({ CLAUDE_CODE_OAUTH_TOKEN: 't', ANTHROPIC_API_KEY: 'k' }, cfg)).toBe('api_key');
  });
});
