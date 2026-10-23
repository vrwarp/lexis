import os from 'node:os';
import path from 'node:path';
import { type Page, expect, test as base } from '@playwright/test';
import { makeEpub } from '../support/epub.js';

export const PASSWORD = 'e2e-password';

export async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByPlaceholder('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#app')).toBeVisible();
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
