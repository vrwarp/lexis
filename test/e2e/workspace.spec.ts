import { PNG } from '../support/epub.js';
import { expect, newProject, signIn, test } from './fixtures.js';
import type { Page } from '@playwright/test';


async function finishedProject(page: Page, name: string) {
  await signIn(page);
  await newProject(page, { name });
  await page.getByRole('button', { name: /Start translation/ }).click();
  await expect(page.locator('#review-banner')).toBeVisible();
}

test.describe('workspace review', () => {
  test('browses generated files, reads a chapter and comments on a quoted passage', async ({ page }) => {
    await finishedProject(page, 'Files Book');
    await page.getByRole('button', { name: 'Files' }).click();
    const tree = page.locator('#file-tree');
    await expect(tree).toContainText('final');
    await expect(tree).toContainText('notes');
    await expect(tree.locator('.f-name')).not.toContainText(['.git']);

    await tree.locator('.file-row', { hasText: 'master_glossary.json' }).click();
    await expect(page.locator('#asset-path')).toHaveText('notes/master_glossary.json');
    await expect(page.locator('#asset-content')).toContainText('"target": "mundo"');
    await page.keyboard.press('Escape');
    await expect(page.locator('#asset-modal')).toBeHidden();

    await tree.locator('details', { hasText: 'final' }).locator('.file-row', { hasText: 'chapter1.xhtml' }).click();
    const frame = page.frameLocator('#asset-content iframe');
    await expect(frame.locator('p')).toHaveText('¡Hola, mundo!');
    await page.getByRole('button', { name: /source view/ }).click();
    await expect(page.locator('#asset-content')).toContainText('<p>¡Hola, mundo!</p>');

    // Select text in the source view to quote it.
    await page.locator('#asset-content').evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await expect(page.locator('#asset-quote')).toBeVisible();
    await page.getByPlaceholder(/Comment on this file/).fill('Use a softer greeting');
    await page.getByRole('button', { name: 'Send to orchestrator' }).click();
    await expect(page.getByRole('button', { name: 'Sent ✓' })).toBeVisible();
    await page.locator('#asset-close').click();
    await expect(page.locator('#feed')).toContainText('[User comment on asset `final/chapter1.xhtml`]');
    await expect(page.locator('#feed')).toContainText('Use a softer greeting');
    // The comment queues behind the review gate; the review stays open.
    await expect(page.locator('#project-status')).toHaveText('review');
    await expect(page.locator('#review-banner')).toBeVisible();
  });

  test('opens binary files as a download link', async ({ page }) => {
    await finishedProject(page, 'Binary Book');
    await page.getByRole('button', { name: 'Files' }).click();
    await page.locator('#file-tree details', { hasText: '(project root)' }).locator('summary').click();
    await page.locator('.file-row', { hasText: 'source.epub' }).click();
    await expect(page.getByRole('link', { name: '⤓ download source.epub' })).toBeVisible();
  });

  test('snapshots and reverts the workspace from the version list', async ({ page }) => {
    await finishedProject(page, 'Versions Book');
    page.once('dialog', (d) => d.accept('my checkpoint'));
    await page.getByRole('button', { name: /snapshot/ }).click();
    // Nothing changed since the last version, so the list does not grow with "my checkpoint".
    const items = page.locator('#version-list .version-item');
    await expect(items.first()).toContainText('all chapters finalized');

    const prep = items.filter({ hasText: 'after preparation' });
    await expect(prep.getByRole('button', { name: 'revert' })).toBeHidden(); // shown on hover only
    await prep.hover();
    page.once('dialog', (d) => d.accept());
    await prep.getByRole('button', { name: 'revert' }).click();
    await expect(items.first()).toContainText(/revert to [0-9a-f]{8} \(after preparation\)/);
    await expect(page.locator('#feed')).toContainText('reverted the workspace');
    await page.getByRole('button', { name: 'Files' }).click();
    await expect(page.locator('#file-tree')).not.toContainText('final');
  });

  test('uploads a custom cover and repackages the finished book', async ({ page }) => {
    await finishedProject(page, 'Cover Book');
    await page.getByRole('button', { name: /Approve & package/ }).click();
    await expect(page.locator('#project-status')).toHaveText('done');

    const confirm = page.waitForEvent('dialog');
    await page.locator('#cover-input').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: PNG });
    const d = await confirm;
    expect(d.message()).toMatch(/Repackage the translated EPUB/);
    await d.accept();
    await expect(page.locator('#version-list .version-item').first()).toContainText('repackaged with custom cover');
    await expect(page.getByRole('button', { name: /Repackage/ })).toBeVisible();

    page.once('dialog', (x) => x.accept());
    await page.getByRole('button', { name: /Repackage/ }).click();
    await expect(page.locator('#feed')).toContainText('Repackaged with custom cover');
  });
});
