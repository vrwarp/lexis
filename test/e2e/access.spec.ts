import { PASSWORD, expect, signIn, test } from './fixtures.js';

test.describe('password gate', () => {
  test('shows only the sign-in screen until the password is entered', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#login-screen')).toBeVisible();
    await expect(page.locator('#app')).toBeHidden();
    await expect(page.getByPlaceholder('Password')).toBeFocused();
  });

  test('rejects a wrong password with a message', async ({ page }) => {
    await page.goto('/');
    await page.getByPlaceholder('Password').fill('not-it');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toHaveText('Wrong password');
    await expect(page.locator('#app')).toBeHidden();
  });

  test('stays signed in across reloads and signs out', async ({ page }) => {
    await signIn(page);
    await page.reload();
    await expect(page.locator('#app')).toBeVisible();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.locator('#login-screen')).toBeVisible();
    await expect(page.locator('#login-note')).toHaveText('Signed out.');
    await page.reload();
    await expect(page.locator('#login-screen')).toBeVisible();
  });

  test('drops back to the sign-in screen when the session is gone', async ({ page, context }) => {
    await signIn(page);
    await context.clearCookies();
    await page.getByRole('button', { name: /New translation/ }).click();
    await page.locator('#new-project-form input[name=targetLanguage]').fill('x');
    // any API call now gets a 401 and the app returns to the password screen
    await page.evaluate(() => fetch('/api/projects').then(() => undefined));
    await page.reload();
    await expect(page.locator('#login-screen')).toBeVisible();
    await page.getByPlaceholder('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('#app')).toBeVisible();
  });

  test('refuses to start a translation before Claude is linked', async ({ page }) => {
    await signIn(page);
    await expect(page.locator('#claude-label')).toHaveText('Claude not linked — sign in');
    const { newProject } = await import('./fixtures.js');
    await newProject(page, { name: 'Unlinked Book' });
    const dialog = page.waitForEvent('dialog');
    await page.getByRole('button', { name: /Start translation/ }).click();
    const d = await dialog;
    expect(d.message()).toMatch(/Claude is not linked/);
    await d.dismiss();
    await expect(page.locator('#project-status')).toHaveText('new');
  });
});
