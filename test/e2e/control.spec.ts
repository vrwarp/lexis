import { cell, expect, newProject, runToReview, signIn, test } from './fixtures.js';

const CH1 = 'chapter1.xhtml';
const CH3 = 'chapter3.xhtml';

test.describe('steering the run', () => {
  test('pauses, resumes, stops and changes concurrency', async ({ page }) => {
    await signIn(page);
    await newProject(page, { name: 'Control Book', book: { chapters: 3 } });
    await page.getByRole('button', { name: /Start translation/ }).click();
    await expect(page.locator('#matrix tbody tr')).toHaveCount(4);
    await page.getByRole('button', { name: /Pause/ }).click();
    await expect(page.locator('#run-state')).toHaveText('Paused');
    await expect(page.locator('#run-reason')).toContainText('paused by you');
    await expect(page.locator('#project-status')).toHaveText('paused');
    await expect(page.getByRole('button', { name: /Resume/ })).toBeVisible();
    // Nothing runs while paused.
    await page.waitForTimeout(400);
    await expect(page.locator('#matrix .m-cell.state-running')).toHaveCount(0);

    await page.locator('#concurrency').selectOption('1');
    await page.getByRole('button', { name: /Resume/ }).click();
    await expect(page.locator('#run-state')).toHaveText('Running');
    await expect(page.locator('#matrix .m-cell.state-running, #global-steps .gstep.state-running')).toHaveCount(1);
    await page.getByRole('button', { name: /Stop/ }).click();
    await expect(page.locator('#run-reason')).toContainText('stopped by you');
    await page.locator('#concurrency').selectOption('3');
    await page.getByRole('button', { name: /Resume/ }).click();
    await expect(page.locator('#review-banner')).toBeVisible({ timeout: 90_000 });
  });

  test('edits the instructions, notes and excludes a chapter, and re-runs one from the row menu', async ({ page }) => {
    await signIn(page);
    await newProject(page, { name: 'Plan Book', book: { chapters: 3 } });
    await page.getByRole('button', { name: /Instructions/ }).click();
    await page.locator('#instructions-text').fill('Formal register throughout.');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('#instructions-modal')).toBeHidden();

    await page.getByRole('button', { name: /Start translation/ }).click();
    await expect(page.locator('#matrix tbody tr')).toHaveCount(4);
    // Exclude chapter 3 before production reaches it.
    const row3 = page.locator('#matrix tbody tr', { hasText: 'Chapter 3' });
    await row3.getByRole('button', { name: 'Chapter actions' }).click();
    await page.locator('.menu button', { hasText: 'Exclude from the translation' }).click();
    await expect(row3).toContainText('excluded');
    await expect(cell(page, CH3, 'draft').locator('button')).toHaveCount(0);

    await expect(page.locator('#review-banner')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('#review-summary')).toContainText('2 sections finalized and verified; 2 excluded.');
    // The instructions reached the agents.
    await cell(page, CH1, 'critique').locator('button').click();
    await page.locator('#step-runs').getByRole('button', { name: 'prompt' }).first().click();
    await expect(page.locator('#step-prompt')).toContainText('Formal register throughout.');
    await page.locator('#step-close').click();

    // A note and a re-run from the row menu.
    const row1 = page.locator('#matrix tbody tr', { hasText: 'Chapter 1' });
    await row1.getByRole('button', { name: 'Chapter actions' }).click();
    page.once('dialog', (d) => d.accept('Keep the nicknames.'));
    await page.locator('.menu button', { hasText: 'Add a note' }).click();
    await expect(row1).toContainText('note');
    await row1.getByRole('button', { name: 'Chapter actions' }).click();
    page.once('dialog', (d) => d.accept('Shorter sentences.'));
    await page.locator('.menu button', { hasText: 'Re-run: polish only' }).click();
    await expect(page.locator('#review-banner')).toBeHidden();
    await expect(page.locator('#review-banner')).toBeVisible({ timeout: 60_000 });
    await cell(page, CH1, 'final').locator('button').click();
    await expect(page.locator('#step-runs li')).toHaveCount(2);
    await page.locator('#step-runs').getByRole('button', { name: 'prompt' }).first().click();
    await expect(page.locator('#step-prompt')).toContainText('Keep the nicknames.');
    await expect(page.locator('#step-prompt')).toContainText('Shorter sentences.');
  });

  test('re-runs a step from its modal and re-includes a chapter', async ({ page }) => {
    await signIn(page);
    await newProject(page, { name: 'Retry Book' });
    await runToReview(page);
    await cell(page, CH1, 'critique').locator('button').click();
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: /run again from here/ }).click();
    await expect(page.locator('#step-modal')).toBeHidden();
    await expect(page.locator('#run-state')).toHaveText('Running');
    await expect(page.locator('#review-banner')).toBeVisible({ timeout: 60_000 });
    await cell(page, CH1, 'verify').locator('button').click();
    await expect(page.locator('#step-runs li')).toHaveCount(2);
    await page.locator('#step-close').click();

    // Bring the cover page in: it gets translated too.
    const cover = page.locator('#matrix tbody tr', { hasText: 'Cover' });
    await cover.getByRole('button', { name: 'Chapter actions' }).click();
    await page.locator('.menu button', { hasText: 'Include in the translation' }).click();
    await expect(cover).not.toContainText('excluded');
    await expect(page.locator('#run-state')).toHaveText('Running');
    await expect(cell(page, 'cover.xhtml', 'verify')).toHaveClass(/state-done/, { timeout: 60_000 });
    await expect(page.locator('#review-banner')).toBeVisible();
    await expect(page.locator('#review-summary')).toContainText('3 sections finalized and verified; 0 excluded.');
  });
});

test.describe('series and diagnostics', () => {
  test('continues a series from the previous book, and downloads the diagnostics', async ({ page }) => {
    await signIn(page);
    const series = `Saga ${Date.now()}`;
    await newProject(page, { name: 'Saga One', series, book: { chapters: 1 } });
    await expect(page.locator('#run-series')).toContainText(`Part 1 of the series “${series}”`);
    await runToReview(page);

    await page.getByRole('button', { name: /New translation/ }).click();
    await page.locator('#new-project-form input[name=series]').fill(series);
    await expect(page.locator('#inherit-row')).toBeVisible();
    await expect(page.locator('#inherit-from')).toHaveValue(/^[0-9a-f]{12}$/);
    await expect(page.locator('#inherit-from option:checked')).toContainText('Saga One');
    await page.locator('#new-project-form button', { hasText: 'Cancel' }).click();

    await newProject(page, { name: 'Saga Two', series, book: { chapters: 1 } });
    await expect(page.locator('.project-item.active .p-series')).toHaveText(`${series} #2`);
    await expect(page.locator('#run-series')).toContainText('Will inherit the glossary');
    await runToReview(page);
    await expect(page.locator('#run-series')).toContainText('Inherited master glossary, style guide, metadata, critique charter from “Saga One” (1 glossary entries)');
    await expect(page.locator('#feed')).toContainText('Continues "Saga One"');

    // The diagnostics bundle and a run's transcript are one click away.
    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: /Diagnostics/ }).click();
    expect((await download).suggestedFilename()).toMatch(/^lexis-trace-[0-9a-f]{12}\.tgz$/);
    await cell(page, CH1, 'draft').locator('button').click();
    const popup = page.waitForEvent('popup');
    await page.locator('#step-runs').getByRole('link', { name: 'transcript' }).first().click();
    const transcript = await popup;
    await expect(transcript.locator('body')).toContainText('## Task prompt');
    await expect(transcript.locator('body')).toContainText('part 2 of the series');
  });
});
