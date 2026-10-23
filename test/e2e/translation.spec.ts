import { expect, newProject, signIn, test } from './fixtures.js';

test.describe('translating a book', () => {
  test('creates a project, runs the pipeline to review, approves and downloads the EPUB', async ({ page }) => {
    await signIn(page);
    await expect(page.locator('#claude-label')).toHaveText(/^Claude linked/);
    await newProject(page, { name: 'The Little Test', language: 'Spanish', context: 'For children' });
    await expect(page.locator('#project-lang')).toHaveText('Spanish');
    await expect(page.locator('#project-status')).toHaveText('new');
    await expect(page.locator('.project-item.active .p-name')).toHaveText('The Little Test');

    await page.getByRole('button', { name: /Start translation/ }).click();

    // The live board and feed follow the run.
    const banner = page.locator('#review-banner');
    await expect(banner).toBeVisible();
    await expect(page.locator('#review-summary')).toHaveText('1 chapter translated. Glossary: 1 term.');
    await expect(page.locator('#project-status')).toHaveText('review');
    const board = page.locator('#pipeline-board .phase');
    await expect(board.filter({ hasText: 'Prepare' })).toHaveClass(/state-completed/);
    await expect(board.filter({ hasText: 'Translate' })).toContainText('1/1 done');
    await expect(page.locator('#feed')).toContainText('⇢ ebook-disbinder — Extract the EPUB');
    await expect(page.locator('#feed')).toContainText('⇠ primary-translator finished');
    await expect(page.locator('#feed .ev.subagent .badge').first()).toHaveText('ebook-disbinder');
    await expect(page.locator('#interrupt-btn')).toBeVisible();

    // Tool detail is hidden until asked for.
    const toolRow = page.locator('#feed .kind-tool').first();
    await expect(toolRow).toBeHidden();
    await page.locator('#show-detail').check();
    await expect(toolRow).toContainText('⚙ Bash');

    // Versions arrive as the orchestrator saves them.
    await expect(page.locator('#version-list')).toContainText('all chapters finalized');

    await page.getByRole('button', { name: /Approve & package/ }).click();
    await expect(banner).toBeHidden();
    await expect(page.locator('#project-status')).toHaveText('done');
    await expect(page.locator('#feed')).toContainText('The translated EPUB is ready.');
    await expect(page.locator('#usage-total')).toHaveText('$0.07');
    await expect(page.locator('#usage-panel')).toContainText('opus 5.5');
    await expect(page.locator('#usage-panel')).toContainText('sonnet 5.5');

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: /Download EPUB/ }).click();
    expect((await download).suggestedFilename()).toBe('The Little Test (Spanish).epub');
  });

  test('asks for another pass with instructions, then approves', async ({ page }) => {
    await signIn(page);
    await newProject(page, { name: 'Revision Book' });
    await page.getByRole('button', { name: /Start translation/ }).click();
    await expect(page.locator('#review-banner')).toBeVisible();

    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: /Request another pass/ }).click(); // empty: refused
    await expect(page.locator('#review-banner')).toBeVisible();

    await page.locator('#review-instructions').fill('Make the dialogue warmer');
    await page.getByRole('button', { name: /Request another pass/ }).click();
    await expect(page.locator('#feed')).toContainText('↺ Another pass requested: Make the dialogue warmer');
    await expect(page.locator('#review-summary')).toHaveText('Revision applied.');
    await expect(page.locator('#version-list')).toContainText('applied revision');
    await page.getByRole('button', { name: /Approve & package/ }).click();
    await expect(page.locator('#project-status')).toHaveText('done');
  });

  test('chats with the orchestrator', async ({ page }) => {
    await signIn(page);
    await newProject(page, { name: 'Chat Book' });
    await page.getByPlaceholder(/Message the orchestrator/).fill('What will you do first?');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByPlaceholder(/Message the orchestrator/)).toHaveValue('');
    await expect(page.locator('#feed .ev.user')).toContainText('What will you do first?');
    await expect(page.locator('#feed')).toContainText('Noted: What will you do first?');
    await expect(page.locator('#project-status')).toHaveText('idle');
  });

  test('shows an orchestrator failure in the feed and status', async ({ page }) => {
    await signIn(page);
    await newProject(page, { name: 'Failing Book' });
    await page.getByPlaceholder(/Message the orchestrator/).fill('please explode');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('#project-status')).toHaveText('error');
    await expect(page.locator('#feed .kind-error')).toContainText('simulated SDK failure');
  });

  test('switches between projects and keeps each feed separate', async ({ page }) => {
    await signIn(page);
    // Unique per run: the browser tests share one server, so retries see earlier projects.
    const first = `First <b>Book</b> ${Date.now()}`;
    await newProject(page, { name: first, language: '<img src=x onerror=alert(1)>' });
    await newProject(page, { name: `Second Book ${Date.now()}` });
    await expect(page.locator('#feed')).toBeEmpty();
    const item = page.locator('.project-item', { hasText: first });
    await item.click();
    await expect(page.locator('#project-title')).toHaveText(first);
    // Names and languages render as text, never as markup.
    await expect(item.locator('.p-lang')).toHaveText('<img src=x onerror=alert(1)>');
    await expect(page.locator('#project-lang')).toHaveText('<img src=x onerror=alert(1)>');
  });
});
