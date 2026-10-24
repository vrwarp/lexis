import { defineConfig, devices } from '@playwright/test';

const GATE = 4801; // no Claude credential: password and Claude sign-in flows
const STUDIO = 4802; // already linked to Claude: the translation workflow
const KEYS = 4803; // its own sign-in state: passkey setup and use

// Use a preinstalled Chromium when one is provided (e.g. a sandbox without downloads).
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

export default defineConfig({
  testDir: 'test/e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    ...devices['Desktop Chrome'],
    launchOptions: { executablePath },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    // localhost, not 127.0.0.1: a secure context with a host name, as passkeys require.
    { name: 'gate', testMatch: /(access|claude-link)\.spec\.ts/, use: { baseURL: `http://localhost:${GATE}` } },
    { name: 'studio', testMatch: /(translation|workspace)\.spec\.ts/, use: { baseURL: `http://localhost:${STUDIO}` } },
    { name: 'keys', testMatch: /passkeys\.spec\.ts/, use: { baseURL: `http://localhost:${KEYS}` } },
  ],
  webServer: [
    {
      command: 'npx tsx test/e2e/server.ts',
      url: `http://localhost:${GATE}/healthz`,
      env: { PORT: String(GATE) },
      reuseExistingServer: false,
      stdout: 'pipe',
    },
    {
      command: 'npx tsx test/e2e/server.ts',
      url: `http://localhost:${STUDIO}/healthz`,
      env: { PORT: String(STUDIO), E2E_LINKED: '1' },
      reuseExistingServer: false,
      stdout: 'pipe',
    },
    {
      command: 'npx tsx test/e2e/server.ts',
      url: `http://localhost:${KEYS}/healthz`,
      env: { PORT: String(KEYS), E2E_LINKED: '1' },
      reuseExistingServer: false,
      stdout: 'pipe',
    },
  ],
});
