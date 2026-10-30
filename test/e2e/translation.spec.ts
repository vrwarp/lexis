import { cell, expect, newProject, runToReview, signIn, test } from './fixtures.js';

const CH1 = 'chapter1.xhtml';
const CH2 = 'chapter2.xhtml';

test.describe('translating a book', () => {
  test('creates a project, watches the matrix fill, reviews, approves and downloads the EPUB', async ({ page }) => {
    await signIn(page);
    await expect(page.locator('#claude-label')).toHaveText(/^Claude linked/);
    await newProject(page, { name: 'The Little Test', language: 'Spanish', context: 'For children' });
    await expect(page.locator('#project-lang')).toHaveText('Spanish');
    await expect(page.locator('#project-status')).toHaveText('new');
    await expect(page.locator('.project-item.active .p-name')).toHaveText('The Little Test');
    await expect(page.locator('#run-state')).toHaveText('Not started');
    // Nothing is known about the chapters until the book is extracted.
    await expect(page.locator('#matrix tbody tr')).toHaveCount(0);

    await page.getByRole('button', { name: /Start translation/ }).click();
    await expect(page.locator('#run-state')).toHaveText('Running');
    await expect(page.getByRole('button', { name: /Pause/ })).toBeVisible();
    // The plan appears as soon as the EPUB is read: the cover page is excluded, the chapters are rows.
    await expect(page.locator('#matrix tbody tr')).toHaveCount(3);
    await expect(page.locator('#matrix tbody tr').first()).toContainText('excluded · no text');
    await expect(page.locator('#matrix tbody tr').nth(1)).toContainText('Chapter 1: The Title');
    await expect(page.locator('#global-steps .gstep', { hasText: 'Prepare' })).toHaveClass(/state-done/);

    const banner = page.locator('#review-banner');
    await expect(banner).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('#run-state')).toHaveText('Waiting for your review');
    await expect(page.locator('#review-summary')).toContainText('2 sections finalized and verified; 1 excluded.');
    await expect(page.locator('#review-summary')).toContainText('Glossary: 2 entries.');
    await expect(page.locator('#project-status')).toHaveText('review');
    for (const stage of ['summarize', 'lexicon', 'glossary', 'draft', 'stray', 'critique', 'final', 'verify']) {
      await expect(cell(page, CH1, stage)).toHaveClass(/state-done/);
      await expect(cell(page, CH2, stage)).toHaveClass(/state-done/);
    }
    await expect(page.locator('#global-steps .gstep', { hasText: 'Charter' })).toHaveClass(/state-done/);
    await expect(page.locator('#global-steps .gstep', { hasText: 'Package' })).toHaveClass(/state-pending/);
    await expect(page.locator('#run-progress')).toContainText('steps');

    // The feed shows every agent, attributed; tool detail is hidden until asked for.
    await expect(page.locator('#feed')).toContainText('Done: translate for chapter1.xhtml.');
    await expect(page.locator('#feed .ev.subagent.kind-text .badge', { hasText: 'primary-translator' }).first()).toBeVisible();
    const toolRow = page.locator('#feed .kind-tool').first();
    await expect(toolRow).toBeHidden();
    await page.locator('#show-detail').check();
    await expect(toolRow).toContainText('⚙ Read');
    await page.locator('#show-detail').uncheck();
    // …and can be narrowed to one chapter.
    await page.locator('#feed-filter').selectOption(CH2);
    await expect(page.locator('#feed .ev:visible').first()).toHaveAttribute('data-chapter', CH2);
    await expect(page.locator('#feed .ev[data-chapter="chapter1.xhtml"]:visible')).toHaveCount(0);
    await page.locator('#feed-filter').selectOption('');

    // Versions arrive as the engine reaches milestones.
    await expect(page.locator('#version-list')).toContainText('initialization complete');
    await expect(page.locator('#version-list')).toContainText('finalized');

    await page.getByRole('button', { name: /Approve & package/ }).click();
    await expect(banner).toBeHidden();
    await expect(page.locator('#project-status')).toHaveText('done', { timeout: 30_000 });
    await expect(page.locator('#run-state')).toHaveText('Completed');
    await expect(page.locator('#global-steps .gstep', { hasText: 'Package' })).toHaveClass(/state-done/);
    await expect(page.locator('#feed')).toContainText('Packaged translated_book.epub');
    await expect(page.locator('#usage-total')).toHaveText(/\$\d+\.\d\d/);
    await expect(page.locator('#usage-panel')).toContainText('opus 5.5');
    await expect(page.locator('#usage-panel')).toContainText('sonnet 5.5');

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: /Download EPUB/ }).click();
    expect((await download).suggestedFilename()).toBe('The Little Test (Spanish).epub');
  });

  test('opens a step: its runs, the prompt the agent got, and its own log', async ({ page }) => {
    await signIn(page);
    await newProject(page, { name: 'Step Book', context: 'Keep it playful' });
    await runToReview(page);
    await cell(page, CH1, 'draft').locator('button').click();
    const modal = page.getByRole('dialog', { name: /Draft — Chapter 1/ });
    await expect(modal).toBeVisible();
    await expect(modal.locator('#step-kv')).toContainText('done');
    await expect(modal.locator('#step-runs li')).toHaveCount(2);
    await expect(modal.locator('#step-runs')).toContainText('primary-translator · translate');
    await expect(modal.locator('#step-runs')).toContainText('omission-detector · audit');
    await modal.locator('#step-runs li', { hasText: 'primary-translator' }).getByRole('button', { name: 'prompt' }).click();
    await expect(modal.locator('#step-prompt')).toContainText('Instructions from the user: Keep it playful');
    await expect(modal.locator('#step-prompt')).toContainText('Translate `original/OEBPS/chapter1.xhtml`');
    await expect(modal.locator('#step-log')).toContainText('Done: translate for chapter1.xhtml.');
    await expect(modal.locator('#step-log')).not.toContainText('chapter2');
    await page.locator('#step-close').click();
    await expect(modal).toBeHidden();
    // Global steps open the same way.
    await page.locator('#global-steps .gstep', { hasText: 'Metadata' }).click();
    await expect(page.getByRole('dialog', { name: 'Metadata' })).toContainText('metadata-generator · metadata');
  });

  test('asks for another pass on chosen chapters, then approves', async ({ page }) => {
    await signIn(page);
    await newProject(page, { name: 'Revision Book' });
    await runToReview(page);

    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: /Run another pass/ }).click(); // empty: refused
    await expect(page.locator('#review-banner')).toBeVisible();

    await page.locator('#review-instructions').fill('Make the dialogue warmer');
    await page.locator('#review-scope').selectOption('some');
    await page.locator('#review-chapters .pick', { hasText: 'Chapter 2' }).locator('input').check();
    await page.locator('#review-from').selectOption('final');
    await page.getByRole('button', { name: /Run another pass/ }).click();
    await expect(page.locator('#review-banner')).toBeHidden();
    await expect(page.locator('#feed')).toContainText('↺ Another pass (1 chapters, from Final): Make the dialogue warmer');
    await expect(page.locator('#review-banner')).toBeVisible({ timeout: 60_000 });
    // Only chapter 2's final and verify ran again; the note is on the chapter.
    await cell(page, CH2, 'final').locator('button').click();
    await expect(page.locator('#step-runs li')).toHaveCount(2);
    await page.locator('#step-close').click();
    await cell(page, CH1, 'final').locator('button').click();
    await expect(page.locator('#step-runs li')).toHaveCount(1);
    await page.locator('#step-close').click();
    await expect(page.locator('#matrix tbody tr', { hasText: 'Chapter 2' })).toContainText('note');
    await page.getByRole('button', { name: /Approve & package/ }).click();
    await expect(page.locator('#project-status')).toHaveText('done', { timeout: 30_000 });
  });

  test('chats with the assistant, which can steer the engine', async ({ page }) => {
    await signIn(page);
    await newProject(page, { name: 'Chat Book' });
    await runToReview(page);
    await page.getByPlaceholder(/Ask the assistant/).fill('What will you do first?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByPlaceholder(/Ask the assistant/)).toHaveValue('');
    await expect(page.locator('#feed .ev.user')).toContainText('What will you do first?');
    await expect(page.locator('#feed .ev.assistant.kind-text').last()).toContainText('Noted: What will you do first?');
    await page.getByPlaceholder(/Ask the assistant/).fill(`rerun ${CH1} from final: shorter sentences`);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('#feed .ev.assistant.kind-text').last()).toContainText('Queued 1 chapter(s) from final');
    // The engine ran the polish again (the fake is quick, so the run may already be back at the gate).
    await cell(page, CH1, 'final').locator('button').click();
    await expect(page.locator('#step-runs li')).toHaveCount(2, { timeout: 60_000 });
    await page.locator('#step-close').click();
    await expect(page.locator('#review-banner')).toBeVisible({ timeout: 60_000 });
  });

  test('shows an assistant failure in the feed without touching the run', async ({ page }) => {
    await signIn(page);
    await newProject(page, { name: 'Failing Book' });
    await page.getByPlaceholder(/Ask the assistant/).fill('please explode');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('#feed .kind-error')).toContainText('simulated SDK failure');
    await expect(page.locator('#run-state')).toHaveText('Not started');
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
