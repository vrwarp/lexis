/**
 * The real lexis app for the browser tests, with the Agent SDK replaced by the
 * scripted pipeline and Claude Code by the fake binary. E2E_LINKED=1 starts it
 * already signed in to Claude.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis-e2e-'));
process.env.LEXIS_DATA_DIR = dataDir;
process.env.CLAUDE_BINARY = path.join(here, '..', 'support', 'fake-claude.mjs');
process.env.LEXIS_PASSWORD ??= 'e2e-password';
for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'LEXIS_PUBLIC_URL']) delete process.env[k];
if (process.env.E2E_LINKED === '1') {
  fs.mkdirSync(path.join(dataDir, 'claude'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'claude', '.credentials.json'), '{}');
}

const { sdk } = await import('../../src/sdk.js');
const { fake, fakeQuery } = await import('../support/fake-sdk.js');
fake.delayMs = Number(process.env.E2E_STEP_MS ?? 40);
sdk.query = fakeQuery(undefined, () => ({ email: 'reader@example.com', subscriptionType: 'max' }));
const { timing } = await import('../../src/engine/engine.js');
timing.transientBackoffMs = [50, 50];
timing.bootDelayMs = 50;
const { createServer } = await import('../../src/app.js');
const port = Number(process.env.PORT ?? 4801);
// All interfaces: the browser uses localhost, which passkeys need (an IP is not a valid RP ID).
createServer().listen(port, () => console.log(`lexis e2e server on ${port} (data ${dataDir})`));
