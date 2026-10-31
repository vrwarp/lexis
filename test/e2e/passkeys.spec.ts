import { type Credential, PASSWORD, expect, signIn, signInWithPassword, test, virtualAuthenticator } from './fixtures.js';

// One server, one sign-in history: these run in order and hand the passkey from test to test.
test.describe.configure({ mode: 'serial' });

let laptop: Credential[] = [];
/** The authenticator of the running test; its passkey (with the advanced signature counter) carries over. */
let current: { credentials(): Promise<Credential[]> } | null = null;

test.afterEach(async () => {
  if (current) laptop = await current.credentials();
  current = null;
});

test('sets up the first passkey from the prompt after a password sign-in', async ({ page, context }) => {
  const device = await virtualAuthenticator(context, page);
  current = device;
  await signIn(page, { keepPrompt: true });
  await page.getByRole('dialog', { name: 'Protect lexis with a passkey' }).getByLabel('Name').fill('Laptop');
  await page.getByRole('button', { name: 'Create passkey' }).click();

  const panel = page.getByRole('dialog', { name: 'Security' });
  await expect(panel).toBeVisible();
  await expect(page.locator('#security-msg')).toHaveText('Passkey created. Sign in with it from now on; the password stays as a backup.');
  await expect(page.locator('#passkey-list')).toContainText('Laptop');
  await expect(page.locator('#security-summary')).toContainText('the password still works as a backup');
  await expect(page.locator('#security-dot')).toHaveClass(/ok/);
  const made = await device.credentials();
  expect(made).toHaveLength(1);
  expect(made[0].isResidentCredential).toBe(true);
});

test('signs in with the passkey, with the password offered as the backup', async ({ page, context }) => {
  current = await virtualAuthenticator(context, page, laptop);
  await page.goto('/');
  const passkeyButton = page.getByRole('button', { name: /Sign in with a passkey/ });
  await expect(passkeyButton).toBeVisible();
  await expect(passkeyButton).toBeFocused();
  await expect(page.getByText('or use the password')).toBeVisible();
  await expect(page.getByPlaceholder('Password', { exact: true })).toBeVisible();
  await passkeyButton.click();
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#passkey-setup')).toBeHidden();

  await page.getByRole('button', { name: /Security/ }).click();
  await expect(page.locator('#session-list li', { hasText: 'this browser' })).toContainText('passkey ·');
  await expect(page.locator('#passkey-list')).not.toContainText('last used never');
});

test('still signs in with the password when no passkey is at hand', async ({ page }) => {
  await page.goto('/');
  await signInWithPassword(page, PASSWORD);
  // A passkey already exists, so no setup prompt.
  await expect(page.locator('#passkey-setup')).toBeHidden();
});

test('reports a cancelled passkey prompt without signing in', async ({ page, context }) => {
  const device = await virtualAuthenticator(context, page, laptop);
  await device.refuse();
  await page.goto('/');
  await page.getByRole('button', { name: /Sign in with a passkey/ }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('#app')).toBeHidden();
});

test('refuses to register a second passkey on a device that already has one', async ({ page, context }) => {
  current = await virtualAuthenticator(context, page, laptop);
  await page.goto('/');
  await page.getByRole('button', { name: /Sign in with a passkey/ }).click();
  await page.getByRole('button', { name: /Security/ }).click();
  page.once('dialog', (d) => d.accept('Again'));
  await page.getByRole('button', { name: /Add a passkey/ }).click();
  await expect(page.locator('#security-msg')).toHaveText('That passkey is already registered here.');
  await expect(page.locator('#passkey-list li')).toHaveCount(1);
});

test('adds, renames and removes a passkey on a second device', async ({ page, context }) => {
  // A phone with no lexis passkey yet: sign in there with the password backup, then add one.
  await virtualAuthenticator(context, page);
  await page.goto('/');
  await signInWithPassword(page);
  await page.getByRole('button', { name: /Security/ }).click();

  page.once('dialog', (d) => d.accept('Phone'));
  await page.getByRole('button', { name: /Add a passkey/ }).click();
  await expect(page.locator('#security-msg')).toHaveText('Added "Phone".');
  const phone = page.locator('#passkey-list li', { hasText: 'Phone' });
  await expect(phone).toBeVisible();

  page.once('dialog', (d) => d.accept('Work phone'));
  await phone.getByRole('button', { name: 'rename' }).click();
  const work = page.locator('#passkey-list li', { hasText: 'Work phone' });
  await expect(work).toBeVisible();

  page.once('dialog', (d) => d.accept());
  await work.getByRole('button', { name: 'remove' }).click();
  await expect(page.locator('#security-msg')).toHaveText('Removed "Work phone".');
  await expect(page.locator('#passkey-list li')).toHaveCount(1);
});

test('signs another browser out from the security panel', async ({ page, context, browser }) => {
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await otherPage.goto('/');
  await signInWithPassword(otherPage);

  current = await virtualAuthenticator(context, page, laptop);
  await page.goto('/');
  await page.getByRole('button', { name: /Sign in with a passkey/ }).click();
  await page.getByRole('button', { name: /Security/ }).click();
  await expect(page.locator('#session-list li').nth(1)).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Sign out all others' }).click();
  await expect(page.locator('#security-msg')).toHaveText(/Signed out [1-9]\d* browser/);
  await expect(page.locator('#session-list li')).toHaveCount(1);

  // The other browser finds itself signed out at its next request.
  await otherPage.getByRole('button', { name: /New translation/ }).click();
  await otherPage.reload();
  await expect(otherPage.locator('#login-screen')).toBeVisible();
  await other.close();
});
