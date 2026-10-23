import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';

export const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-claude.mjs');

const pristine = { ...process.env };

/**
 * Point the app at a fresh data directory and the fake Claude binary, with no
 * ambient Claude credential, then return a loader for app modules as a fresh
 * boot would see them (module state such as the project registry is reset).
 */
export function freshEnv(vars: Record<string, string | undefined> = {}): string {
  vi.resetModules();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis-test-'));
  process.env = { ...pristine, LEXIS_DATA_DIR: dataDir, CLAUDE_BINARY: FAKE_CLAUDE, LEXIS_PASSWORD: 'test-password' };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'DATA_DIR', 'SESSION_SECRET']) {
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return dataDir;
}

export function restoreEnv(): void {
  process.env = { ...pristine };
}

/** Poll until `check` returns truthy, or fail after `ms`. */
export async function until<T>(check: () => T | Promise<T>, ms = 5000, what = 'condition'): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
