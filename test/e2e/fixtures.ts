import os from 'node:os';
import path from 'node:path';
import { type BrowserContext, type CDPSession, type Page, expect, test as base } from '@playwright/test';
import { makeEpub } from '../support/epub.js';

export const PASSWORD = 'e2e-password';

/** Sign in with the password, and wave off the passkey setup prompt it brings up. */
export async function signIn(page: Page, opts: { keepPrompt?: boolean } = {}): Promise<void> {
  await page.goto('/');
  await signInWithPassword(page);
  if (!opts.keepPrompt) {
    await expect(page.locator('#passkey-setup')).toBeVisible();
    await page.getByRole('button', { name: 'Not now' }).click();
  }
}

export async function signInWithPassword(page: Page, password = PASSWORD): Promise<void> {
  await page.getByPlaceholder('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in with password' }).click();
  await expect(page.locator('#app')).toBeVisible();
}

export type Credential = Record<string, unknown>;

/**
 * Give the page a virtual platform authenticator (user-verifying, always
 * approving), optionally holding passkeys made earlier.
 */
export async function virtualAuthenticator(context: BrowserContext, page: Page, credentials: Credential[] = []) {
  const cdp: CDPSession = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  for (const credential of credentials) await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: credential as never });
  return {
    credentials: async () => (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials as unknown as Credential[],
    /** Make the authenticator refuse, like a user dismissing the prompt. */
    refuse: () => cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false }),
  };
}

/** Create a project through the sidebar form and wait for its view. */
export async function newProject(page: Page, opts: { name: string; language?: string; context?: string }): Promise<void> {
  const file = makeEpub(path.join(os.tmpdir(), `lexis-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}.epub`));
  await page.getByRole('button', { name: /New translation/ }).click();
  const form = page.locator('#new-project-form');
  await form.locator('input[name=epub]').setInputFiles(file);
  await form.locator('input[name=name]').fill(opts.name);
  await form.locator('input[name=targetLanguage]').fill(opts.language ?? 'Spanish');
  if (opts.context) await form.locator('textarea[name=context]').fill(opts.context);
  await form.getByRole('button', { name: 'Create project' }).click();
  await expect(page.locator('#project-title')).toHaveText(opts.name);
}

/** Fail the test on any uncaught page error. */
export const test = base.extend<{ pageErrors: string[] }>({
  pageErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await use(errors);
      expect(errors, 'uncaught page errors').toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };
