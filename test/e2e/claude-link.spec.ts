import { expect, signIn, test } from './fixtures.js';

test.describe.configure({ mode: 'serial' });

test.describe('Claude subscription link', () => {
  test('shows the configured models and the unlinked state', async ({ page }) => {
    await signIn(page);
    await expect(page.locator('#tier-note')).toHaveText('claude-opus-5-5 does the translating. claude-sonnet-5-5 does everything else.');
    await page.locator('#claude-open').click();
    const kv = page.locator('#claude-kv');
    await expect(kv).toContainText('not linked');
    await expect(kv).toContainText('claude-opus-5-5 · effort high');
    await expect(kv).toContainText('claude-sonnet-5-5 · effort medium');
    await expect(page.getByRole('button', { name: 'Sign in with Claude' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out of Claude' })).toBeHidden();
    await page.locator('#claude-close').click();
    await expect(page.locator('#claude-modal')).toBeHidden();
  });

  test('reports a rejected code and lets you cancel', async ({ page }) => {
    await signIn(page);
    await page.locator('#claude-open').click();
    await page.getByRole('button', { name: 'Sign in with Claude' }).click();
    const link = page.getByRole('link', { name: /Open Claude sign-in/ });
    await expect(link).toHaveAttribute('href', /^https:\/\/claude\.com\/cai\/oauth\/authorize/);
    await expect(link).toHaveAttribute('target', '_blank');
    await page.getByPlaceholder('Paste the code').fill('wrong');
    await page.getByRole('button', { name: 'Link Claude' }).click();
    await expect(page.locator('#claude-msg')).toHaveText('Invalid code');
    await expect(page.locator('#claude-steps')).toBeHidden();

    await page.getByRole('button', { name: 'Sign in with Claude' }).click();
    await expect(page.locator('#claude-steps')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('#claude-steps')).toBeHidden();
  });

  test('links with the right code, shows the account, and signs out', async ({ page }) => {
    await signIn(page);
    await page.locator('#claude-open').click();
    await page.getByRole('button', { name: 'Sign in with Claude' }).click();
    await page.getByPlaceholder('Paste the code').fill('good-code');
    await page.getByRole('button', { name: 'Link Claude' }).click();
    await expect(page.locator('#claude-msg')).toHaveText('Linked as reader@example.com.');
    await expect(page.locator('#claude-kv')).toContainText('reader@example.com · max');
    await expect(page.locator('#claude-label')).toHaveText('Claude linked · reader@example.com');
    await expect(page.locator('#claude-dot')).toHaveClass(/ok/);

    // The link survives a reload.
    await page.reload();
    await expect(page.locator('#claude-label')).toHaveText(/^Claude linked/);

    await page.locator('#claude-open').click();
    await expect(page.getByRole('button', { name: 'Sign in again' })).toBeVisible();
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Sign out of Claude' }).click();
    await expect(page.locator('#claude-msg')).toHaveText('Signed out of Claude.');
    await expect(page.locator('#claude-label')).toHaveText('Claude not linked — sign in');
  });
});
