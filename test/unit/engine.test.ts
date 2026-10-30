import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { restoreEnv, until } from '../support/boot.js';
import { engineProject, exists, file } from '../support/engine.js';
import { fake, untilRun } from '../support/fake-sdk.js';

afterEach(restoreEnv);

const CH = (i: number) => `chapter${i}.xhtml`;
const modesOf = (mode: string) => fake.calls.filter((c) => c.mode === mode);

async function timingFor() {
  const { timing } = await import('../../src/engine/engine.js');
  timing.transientBackoffMs = [20, 20, 20, 20, 20];
  timing.limitPauseMs = 60_000;
  timing.bootDelayMs = 20;
  return timing;
}

describe('a whole run', () => {
  it('translates a book: extracts, plans, runs every stage in order, stops at the gate, packages on approval', async () => {
    const { engine, project, ws } = await engineProject({ book: { chapters: 3 } });
    await timingFor();
    const events: string[] = [];
    project.subscribe((e) => events.push(e.type));
    engine.start();
    await untilRun(engine, 'awaiting_review');

    // The plan came from the spine: the text-less cover page is excluded by default, titles from the nav.
    expect(engine.chapters.map((c) => [c.key, c.excluded, c.title])).toEqual([
      ['cover.xhtml', true, 'Cover'],
      [CH(1), false, 'Chapter 1: The Title'],
      [CH(2), false, 'Chapter 2: The Title'],
      [CH(3), false, 'Chapter 3: The Title'],
    ]);
    expect(engine.chapters[0].excludedReason).toBe('no text');
    expect(JSON.parse(file(ws, 'notes/contents.json'))).toEqual([
      { index: 1, filename: CH(1), path: 'OEBPS/chapter1.xhtml', title: 'Chapter 1: The Title' },
      { index: 2, filename: CH(2), path: 'OEBPS/chapter2.xhtml', title: 'Chapter 2: The Title' },
      { index: 3, filename: CH(3), path: 'OEBPS/chapter3.xhtml', title: 'Chapter 3: The Title' },
    ]);

    // Every agent ran for every chapter, nothing for the excluded one, and the outputs are where the next agent looks.
    for (let i = 1; i <= 3; i++) {
      for (const rel of [`notes/${CH(i)}.summary.txt`, `notes/${CH(i)}.lexicon.json`, `draft/OEBPS/chapter${i}.xhtml`, `critique/${CH(i)}.critique.md`, `final/OEBPS/chapter${i}.xhtml`, `critique/${CH(i)}.final_check.md`]) {
        expect(exists(ws, rel), rel).toBe(true);
      }
    }
    expect(fake.calls.some((c) => c.chapter === 'cover.xhtml')).toBe(false);
    expect(JSON.parse(file(ws, 'notes/master_glossary.json'))).toHaveLength(3);
    expect(modesOf('glossary').map((c) => c.chapter)).toEqual([CH(1), CH(2), CH(3)]);
    // Glossary merges happen in reading order, strictly one after another.
    const g = modesOf('glossary');
    expect(g[1].startedAt).toBeGreaterThanOrEqual(g[0].endedAt!);
    expect(g[2].startedAt).toBeGreaterThanOrEqual(g[1].endedAt!);
    // No draft starts before the last glossary merge and the charter are done.
    const barrier = Math.max(g[2].endedAt!, modesOf('charter')[0].endedAt!);
    for (const t of modesOf('translate')) expect(t.startedAt).toBeGreaterThanOrEqual(barrier);
    // Within a chapter the stages are sequential; across chapters they overlap.
    expect(fake.maxActive).toBeGreaterThanOrEqual(2);
    expect(fake.maxActive).toBeLessThanOrEqual(3);
    const order = (ch: string) => ['translate', 'audit', 'scan', 'critique', 'final', 'verify'].map((m) => fake.calls.find((c) => c.mode === m && c.chapter === ch)!.startedAt);
    for (let i = 1; i <= 3; i++) {
      const t = order(CH(i));
      for (let k = 1; k < t.length; k++) expect(t[k]).toBeGreaterThanOrEqual(t[k - 1]);
    }

    // The gate: assembled from the state.
    const { summary, warnings } = engine.reviewSummary();
    expect(summary).toContain('3 sections finalized and verified; 1 excluded.');
    expect(summary).toContain('Glossary: 3 entries.');
    expect(warnings).toEqual([]);
    expect(project.meta.status).toBe('awaiting_review');
    expect(engine.state.steps.package.state).toBe('pending');

    expect(engine.approve()).toBe(true);
    expect(engine.approve()).toBe(false);
    await untilRun(engine, 'completed');
    expect(project.meta.outputPath).toBe('translated_book.epub');
    expect(exists(ws, 'translated_book.epub')).toBe(true);
    // The packager ran on a mirrored final/ and the harness zipped it; untranslated pages and assets came along.
    expect(exists(ws, 'final/OEBPS/cover.xhtml')).toBe(true);
    expect(exists(ws, 'final/OEBPS/images/cover.png')).toBe(true);
    expect(file(ws, 'final/OEBPS/content.opf')).toContain('<dc:language>es</dc:language>');
    expect(modesOf('package')).toHaveLength(1);

    // Usage was recorded per run and per project.
    expect(project.meta.usage!.totalCostUsd).toBeGreaterThan(0.5);
    expect(engine.state.steps[`${CH(1)}/draft`].costUsd).toBeCloseTo(0.06);
    expect(engine.state.steps[`${CH(1)}/draft`].runs.map((r) => r.mode)).toEqual(['translate', 'audit']);
    expect(engine.trace.prompt(engine.state.steps.metadata.runs[0].id)).toContain('Write `notes/metadata.json`');
    // Milestone versions.
    const { listVersions } = await import('../../src/versioning.js');
    const labels = (await listVersions(project)).map((v) => v.label);
    // Milestones that nothing else could have absorbed are always there; a chapter's own snapshot may find
    // nothing new when a sibling's snapshot already captured its files.
    expect(labels).toEqual(expect.arrayContaining(['initialization complete', 'packaged epub']));
    expect(labels.some((l) => l.endsWith('finalized'))).toBe(true);
    expect(labels[0]).toBe('packaged epub');
    // The feed carried the plan, every step change, run changes and the gate.
    for (const t of ['plan', 'step', 'run', 'review_request', 'review_response', 'agent_text', 'tool_use', 'usage', 'version']) expect(events, t).toContain(t);
    expect(events).not.toContain('error');
  });

  it('never runs more steps at once than the concurrency setting, and honours a change mid-run', async () => {
    const { engine } = await engineProject({ book: { chapters: 4 }, env: { LEXIS_CONCURRENCY: '1' } });
    await timingFor();
    fake.delayMs = 15;
    engine.start();
    await until(() => fake.calls.length >= 4, 5000, 'four steps');
    expect(fake.maxActive).toBe(1);
    engine.setConcurrency(4);
    await untilRun(engine, 'awaiting_review');
    expect(fake.maxActive).toBeGreaterThanOrEqual(2);
    expect(fake.maxActive).toBeLessThanOrEqual(4);
  });
});

describe('loops and checks', () => {
  it('runs the omission loop until complete, up to the cap, and records a warning at the cap', async () => {
    const { engine } = await engineProject({ book: { chapters: 2 } });
    await timingFor();
    fake.on(`audit:${CH(1)}`, { status: 'INCOMPLETE' }, { status: 'INCOMPLETE' }, {});
    fake.on(`audit:${CH(2)}`, { status: 'INCOMPLETE' }, { status: 'INCOMPLETE' }, { status: 'INCOMPLETE' }, { status: 'INCOMPLETE' });
    engine.start();
    await untilRun(engine, 'awaiting_review');
    const one = engine.state.steps[`${CH(1)}/draft`];
    expect(one.rounds).toBe(3);
    expect(one.warning).toBeUndefined();
    expect(one.runs.map((r) => r.mode)).toEqual(['translate', 'audit', 'refine', 'audit', 'refine', 'audit']);
    const two = engine.state.steps[`${CH(2)}/draft`];
    expect(two.state).toBe('done');
    expect(two.rounds).toBe(3);
    expect(two.warning).toMatch(/still found gaps after 3 rounds/);
    expect(two.runs.filter((r) => r.mode === 'refine')).toHaveLength(2);
    expect(engine.reviewSummary().warnings).toEqual([expect.stringMatching(/Chapter 2: The Title: draft — the omission audit still found gaps/)]);
  });

  it('fixes stray phrases until the scan is clean, and applies one fix after a failed verification', async () => {
    const { engine } = await engineProject({ book: { chapters: 1 } });
    await timingFor();
    fake.on(`scan:${CH(1)}`, { status: 'ISSUES_FOUND' }, {});
    fake.on(`verify:${CH(1)}`, { status: 'ISSUES_FOUND' });
    engine.start();
    await untilRun(engine, 'awaiting_review');
    expect(engine.state.steps[`${CH(1)}/stray`].runs.map((r) => r.mode)).toEqual(['scan', 'fix', 'scan']);
    const verify = engine.state.steps[`${CH(1)}/verify`];
    expect(verify.runs.map((r) => r.mode)).toEqual(['verify', 'verify-fix']);
    expect(verify.warning).toMatch(/one fix pass was applied/);
    // Never re-verified, by design.
    expect(modesOf('verify')).toHaveLength(1);
  });

  it('rejects bad output and asks again with the reason; marks the step failed after the attempts and pauses', async () => {
    const { engine, project } = await engineProject({ book: { chapters: 1 } });
    await timingFor();
    fake.on('metadata', { fault: 'garbage' });
    fake.on(`translate:${CH(1)}`, { fault: 'plain-text' }, { fault: 'plain-text' });
    const errors: string[] = [];
    project.subscribe((e) => e.type === 'error' && errors.push(String(e.data.message)));
    engine.start();
    await untilRun(engine, 'paused');
    const meta = engine.state.steps.metadata;
    expect(meta.state).toBe('done');
    expect(meta.runs.map((r) => r.state)).toEqual(['failed', 'done']);
    expect(meta.runs[0].error).toMatch(/not a JSON object/);
    expect(engine.trace.prompt(meta.runs[1].id)).toContain('The previous attempt was rejected: `notes/metadata.json` is not a JSON object');
    const draft = engine.state.steps[`${CH(1)}/draft`];
    expect(draft.state).toBe('failed');
    expect(draft.error).toMatch(/lost the XHTML structure/);
    expect(draft.runs).toHaveLength(2);
    expect(engine.state.run.reason).toMatch(/1 step failed \(Draft of "Chapter 1: The Title"\); retry them to continue/);
    expect(project.meta.status).toBe('paused');
    expect(errors.some((m) => m.includes('asking again'))).toBe(true);
    // Retry runs it again from scratch and the run continues to the gate.
    engine.retryStep(`${CH(1)}/draft`);
    await untilRun(engine, 'awaiting_review');
    expect(engine.state.steps[`${CH(1)}/draft`].state).toBe('done');
  });

  it('retries a transient API failure without spending an attempt, and gives up into a pause', async () => {
    const { engine } = await engineProject({ book: { chapters: 1 } });
    const timing = await timingFor();
    fake.on('style', { fault: 'transient' }, { fault: 'transient' }, {});
    engine.start();
    await untilRun(engine, 'awaiting_review');
    const style = engine.state.steps.style;
    expect(style.runs.map((r) => r.state)).toEqual(['failed', 'failed', 'done']);
    expect(style.runs.every((r) => r.attempt === 1)).toBe(true);

    const second = await engineProject({ book: { chapters: 1 } });
    (await timingFor()).transientBackoffMs = [5, 5]; // fresh modules: set the new engine's timing
    void timing;
    fake.always.set('metadata', { fault: 'transient' });
    second.engine.start();
    await untilRun(second.engine, 'paused');
    expect(second.engine.state.run.reason).toMatch(/keeps refusing/);
    expect(second.engine.state.run.resumeAt).toBeTruthy();
    expect(second.engine.state.steps.metadata.state).toBe('pending');
  });

  it('pauses on a usage limit until Claude\'s reset time, and continues by itself', async () => {
    const { engine, project } = await engineProject({ book: { chapters: 1 } });
    await timingFor();
    const resetsAt = Math.floor(Date.now() / 1000) + 1; // one second from now, in Claude's seconds
    fake.on('metadata', { fault: 'limit', resetsAt });
    engine.start();
    await untilRun(engine, 'paused');
    expect(engine.state.run.reason).toMatch(/usage limit/);
    expect(Date.parse(engine.state.run.resumeAt!)).toBeCloseTo(resetsAt * 1000, -3);
    expect(project.meta.status).toBe('paused');
    await untilRun(engine, 'awaiting_review', 10_000);
    expect(engine.state.steps.metadata.runs.map((r) => r.state)).toEqual(['failed', 'done']);
  });

  it('pauses with no timer when Claude cannot sign in', async () => {
    const { engine } = await engineProject({ book: { chapters: 1 } });
    await timingFor();
    fake.on('metadata', { fault: 'auth' });
    engine.start();
    await untilRun(engine, 'paused');
    expect(engine.state.run.reason).toMatch(/Fix the sign-in/);
    expect(engine.state.run.resumeAt).toBeUndefined();
  });

  it('treats a turn-cap hit as a failed attempt', async () => {
    const { engine } = await engineProject({ book: { chapters: 1 } });
    await timingFor();
    fake.on('metadata', { fault: 'max-turns' }, {});
    engine.start();
    await untilRun(engine, 'awaiting_review');
    expect(engine.state.steps.metadata.runs[0].error).toMatch(/used all 80 turns/);
  });
});

describe('steering', () => {
  it('pauses after the steps in flight finish, and resumes', async () => {
    const { engine } = await engineProject({ book: { chapters: 2 } });
    await timingFor();
    fake.delayMs = 30;
    engine.start();
    await until(() => fake.calls.length >= 2);
    engine.pause();
    expect(engine.runState).toBe('paused');
    const atPause = fake.calls.length;
    await until(() => fake.active === 0);
    await new Promise((r) => setTimeout(r, 80));
    expect(fake.calls.length).toBe(atPause);
    expect(Object.values(engine.state.steps).some((s) => s.state === 'running')).toBe(false);
    engine.resume();
    await untilRun(engine, 'awaiting_review');
  });

  it('stops what is in flight; the steps run again on resume', async () => {
    const { engine } = await engineProject({ book: { chapters: 1 } });
    await timingFor();
    fake.on('metadata', { fault: 'hang' });
    engine.start();
    await until(() => engine.state.steps.metadata.state === 'running' && fake.active === 1);
    engine.stop();
    await until(() => fake.active === 0 && engine.state.steps.metadata.state === 'pending');
    expect(engine.runState).toBe('paused');
    expect(engine.state.steps.metadata.runs[0]).toMatchObject({ state: 'failed', error: 'stopped' });
    engine.resume();
    await untilRun(engine, 'awaiting_review');
    expect(engine.state.steps.metadata.runs).toHaveLength(2);
  });

  it('carries changed instructions and chapter notes into the next prompts', async () => {
    const { engine } = await engineProject({ book: { chapters: 1 }, context: 'first instructions' });
    await timingFor();
    fake.on('charter', { fault: 'hang' });
    engine.start();
    await until(() => engine.state.steps.charter.state === 'running');
    engine.setInstructions('second instructions');
    engine.setChapter(CH(1), { note: 'mind the poem' });
    engine.stop();
    await until(() => fake.active === 0);
    engine.resume();
    await untilRun(engine, 'awaiting_review');
    expect(modesOf('metadata')[0].prompt).toContain('first instructions');
    const translate = modesOf('translate')[0].prompt;
    expect(translate).toContain('second instructions');
    expect(translate).toContain('Note from the user about this section: mind the poem');
  });

  it('excludes and includes chapters, keeping contents.json and the plan in step', async () => {
    const { engine, ws } = await engineProject({ book: { chapters: 3 } });
    await timingFor();
    engine.start();
    await until(() => engine.state.steps.prepare.state === 'done');
    engine.setChapter(CH(2), { excluded: true });
    engine.setChapter('cover.xhtml', { excluded: false });
    await untilRun(engine, 'awaiting_review');
    expect(JSON.parse(file(ws, 'notes/contents.json')).map((c: { filename: string }) => c.filename)).toEqual(['cover.xhtml', CH(1), CH(3)]);
    expect(fake.calls.some((c) => c.chapter === CH(2) && c.mode === 'translate')).toBe(false);
    expect(fake.calls.some((c) => c.chapter === 'cover.xhtml' && c.mode === 'translate')).toBe(true);
    expect(engine.state.steps[`${CH(2)}/draft`].state).toBe('pending');
    expect(engine.chapters.find((c) => c.key === 'cover.xhtml')!.excludedReason).toBeUndefined();
  });

  it('reopens the run when a chapter is included at the gate or after completion', async () => {
    const { engine, project } = await engineProject({ book: { chapters: 1 } });
    await timingFor();
    engine.start();
    await untilRun(engine, 'awaiting_review');
    engine.setChapter('cover.xhtml', { excluded: false });
    await untilRun(engine, 'running');
    await untilRun(engine, 'awaiting_review');
    expect(engine.state.steps['cover.xhtml/verify'].state).toBe('done');
    expect(engine.reviewSummary().summary).toContain('2 sections finalized and verified; 0 excluded.');
    engine.approve();
    await untilRun(engine, 'completed');
    engine.setChapter('cover.xhtml', { excluded: true });
    // Excluding after completion changes the book: it must be packaged again, which needs the gate again.
    expect(engine.runState).toBe('completed');
    void project;
  });

  it('runs another pass on chosen chapters at the gate, with the instructions in their prompts, then gates again', async () => {
    const { engine, project } = await engineProject({ book: { chapters: 3 } });
    await timingFor();
    engine.start();
    await untilRun(engine, 'awaiting_review');
    const before = fake.calls.length;
    const { listVersions } = await import('../../src/versioning.js');
    expect(await engine.revise({ chapters: [CH(2)], from: 'final', instructions: 'warmer dialogue' })).toBe(true);
    await untilRun(engine, 'running');
    await untilRun(engine, 'awaiting_review');
    const later = fake.calls.slice(before);
    expect(later.map((c) => `${c.mode}:${c.chapter}`)).toEqual([`final:${CH(2)}`, `verify:${CH(2)}`]);
    expect(later[0].prompt).toContain('Revision 1: warmer dialogue');
    expect(engine.state.revisions).toHaveLength(1);
    expect(engine.chapter(CH(2))!.note).toBe('Revision 1: warmer dialogue');
    expect(engine.state.steps[`${CH(2)}/final`].runs).toHaveLength(2);
    // The snapshot before the revision was taken before anything was discarded: the discarded final/ file is in a version.
    const { execFileSync } = await import('node:child_process');
    const history = execFileSync('git', ['log', '--format=%s', '--', 'final/OEBPS/chapter2.xhtml'], { cwd: project.workspace, encoding: 'utf8' }).trim().split('\n');
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect((await listVersions(project)).length).toBeGreaterThanOrEqual(3);
    // Revise again from the critique for everyone, then approve.
    await engine.revise({ from: 'critique', instructions: 'tighter prose' });
    await untilRun(engine, 'running');
    await untilRun(engine, 'awaiting_review');
    expect(fake.calls.slice(before + 2).filter((c) => c.mode === 'critique')).toHaveLength(3);
    engine.approve();
    await untilRun(engine, 'completed');
  });

  it('re-runs a chapter from an earlier stage while a later stage of it is in flight, without running the two at once', async () => {
    const { engine } = await engineProject({ book: { chapters: 1 } });
    await timingFor();
    fake.on(`verify:${CH(1)}`, { fault: 'hang' }, {});
    engine.start();
    await until(() => engine.state.steps[`${CH(1)}/verify`]?.state === 'running');
    expect(await engine.rerunChapters([CH(1)], 'final', 'again')).toEqual([CH(1)]);
    await untilRun(engine, 'awaiting_review');
    const verify = engine.state.steps[`${CH(1)}/verify`];
    expect(verify.runs.map((r) => [r.mode, r.state, r.error])).toEqual([['verify', 'failed', 'stopped'], ['verify', 'done', undefined]]);
    expect(engine.state.steps[`${CH(1)}/final`].runs).toHaveLength(2);
    // The aborted run finished unwinding before the step ran again, and nothing is left in flight.
    const times = fake.calls.filter((c) => c.mode === 'verify');
    expect(times[1].startedAt).toBeGreaterThanOrEqual(times[0].endedAt!);
    expect(fake.active).toBe(0);
    expect(fake.maxActive).toBeLessThanOrEqual(3);
  });

  it('re-runs a chapter after completion and packages the book again', async () => {
    const { engine, ws } = await engineProject({ book: { chapters: 1 } });
    await timingFor();
    engine.start();
    await untilRun(engine, 'awaiting_review');
    engine.approve();
    await untilRun(engine, 'completed');
    const packaged = fs.statSync(path.join(ws, 'translated_book.epub')).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    expect(await engine.rerunChapters([CH(1)], 'draft', 'retranslate it')).toEqual([CH(1)]);
    expect(exists(ws, `draft/OEBPS/chapter1.xhtml`)).toBe(false);
    await untilRun(engine, 'awaiting_review');
    expect(engine.state.steps[`${CH(1)}/draft`].runs.filter((r) => r.mode === 'translate')).toHaveLength(2);
    engine.approve();
    await untilRun(engine, 'completed');
    expect(fs.statSync(path.join(ws, 'translated_book.epub')).mtimeMs).toBeGreaterThan(packaged);
    expect(modesOf('package')).toHaveLength(2);
  });
});

describe('the trace', () => {
  it('records every agent run with its prompt, transcript, inputs, outputs and usage, plus the engine timeline', async () => {
    const { engine, project, ws } = await engineProject({ book: { chapters: 2 } });
    await timingFor();
    fake.on('metadata', { fault: 'garbage' });
    fake.on(`audit:${CH(1)}`, { status: 'INCOMPLETE' }, {});
    engine.start();
    await untilRun(engine, 'awaiting_review');
    engine.approve();
    await untilRun(engine, 'completed');

    const runs = engine.trace.runs();
    expect(runs.length).toBe(fake.calls.length);
    expect(runs.every((r) => r.v === 1 && r.id && r.step && r.agent && r.mode && r.model && r.startedAt && r.endedAt)).toBe(true);
    // The rejected metadata run and its retry.
    const meta = runs.filter((r) => r.mode === 'metadata');
    expect(meta.map((r) => [r.attempt, r.outcome, r.check?.ok])).toEqual([[1, 'ok', false], [2, 'ok', true]]);
    expect(meta[0].check?.problem).toMatch(/not a JSON object/);
    expect(meta[0].outputs[0]).toMatchObject({ path: 'notes/metadata.json', changed: true });
    expect(engine.trace.prompt(meta[1].id)).toContain('The previous attempt was rejected');
    // A translation run: what it read, what it wrote, how the text looks.
    const translate = runs.find((r) => r.mode === 'translate' && r.chapter === CH(1))!;
    expect(translate.inputs.map((i) => i.path)).toEqual(expect.arrayContaining(['original/OEBPS/chapter1.xhtml', `notes/${CH(1)}.summary.txt`, 'notes/master_glossary.json', 'notes/style_guide.md']));
    expect(translate.outputs).toEqual([expect.objectContaining({ path: 'draft/OEBPS/chapter1.xhtml', changed: true })]);
    expect(translate.outputs[0].prevHash).toBeUndefined();
    expect(translate.outputs[0].metrics).toMatchObject({ paragraphs: 6 });
    expect(translate.inputs[0].metrics?.words).toBeGreaterThan(50);
    expect(translate.usage).toMatchObject({ input: 4000, output: 1500, costUsd: 0.05 });
    expect(translate.tools).toEqual({ Read: 1 });
    expect(translate.chapterWords).toBeGreaterThan(0);
    expect(translate.agentPrompt).toMatch(/^[0-9a-f]{64}$/);
    expect(translate.model).toBe('claude-opus-5-5');
    expect(translate.effort).toBe('high');
    expect(translate.reply).toContain('Done: translate');
    // The refine round after an incomplete audit saw the report and changed the draft.
    const refine = runs.find((r) => r.mode === 'refine')!;
    expect(refine.inputs.map((i) => i.path)).toContain(`notes/${CH(1)}.omission_report.md`);
    expect(refine.outputs[0]).toMatchObject({ changed: true });
    expect(refine.outputs[0].prevHash).toBe(translate.outputs[0].hash);
    // Blobs hold the content, deduplicated.
    expect(engine.trace.blob(translate.outputs[0].hash)!.toString()).toContain('ES');
    const sourceRefs = runs.flatMap((r) => r.inputs.filter((i) => i.path === 'original/OEBPS/chapter1.xhtml'));
    expect(new Set(sourceRefs.map((i) => i.hash)).size).toBe(1);
    expect(fs.readdirSync(path.join(project.dir, 'trace', 'blobs')).length).toBeLessThan(runs.length * 4);
    // The transcript has the whole session.
    const kinds = engine.trace.transcript(translate.id).map((r) => r.kind);
    expect(kinds).toEqual(['init', 'tool_use', 'text', 'result', 'check']);
    const result = engine.trace.transcript(translate.id).find((r) => r.kind === 'result') as { turns: number };
    expect(result.turns).toBe(3);
    // Agent prompt versions are kept.
    expect(fs.readdirSync(path.join(project.dir, 'trace', 'agents')).some((f) => f.startsWith('primary-translator-'))).toBe(true);
    // The timeline has the run's shape.
    const timeline = engine.trace.timelineRecords();
    const kindsSeen = new Set(timeline.map((t) => t.kind));
    for (const k of ['run', 'step', 'checkpoint', 'review']) expect(kindsSeen, k).toContain(k);
    expect(timeline.filter((t) => t.kind === 'run').map((t) => t.state)).toEqual(['running', 'awaiting_review', 'running', 'completed']);
    expect(timeline.filter((t) => t.kind === 'step' && t.state === 'done').length).toBe(Object.values(engine.state.steps).filter((s) => s.state === 'done').length);
    expect(JSON.parse(fs.readFileSync(path.join(project.dir, 'trace', 'meta.json'), 'utf8'))).toMatchObject({ v: 1, project: { id: project.meta.id }, config: { concurrency: 3 } });
    void ws;
  });

  it('summarizes a run: totals, modes, loops, rejections, chapters, utilization, chains', async () => {
    const { engine, project } = await engineProject({ book: { chapters: 2 } });
    await timingFor();
    fake.on('style', { fault: 'garbage' });
    fake.on(`scan:${CH(2)}`, { status: 'ISSUES_FOUND' }, { status: 'ISSUES_FOUND' }, { status: 'ISSUES_FOUND' }, { status: 'ISSUES_FOUND' });
    fake.on(`verify:${CH(1)}`, { status: 'ISSUES_FOUND' });
    engine.start();
    await until(() => fake.calls.length >= 3);
    engine.pause();
    await until(() => fake.active === 0);
    await new Promise((r) => setTimeout(r, 30));
    engine.resume();
    await untilRun(engine, 'awaiting_review');
    engine.approve();
    await untilRun(engine, 'completed');
    const { summarize, render } = await import('../../src/engine/trace.js');
    const s = summarize(project.meta, engine.state, engine.trace);
    expect(s.totals.runs).toBe(fake.calls.length);
    expect(s.totals.rejected).toBe(1);
    expect(s.totals.ok).toBe(fake.calls.length - 1);
    expect(s.totals.costUsd).toBeCloseTo(project.meta.usage!.totalCostUsd, 5);
    expect(s.rejections).toEqual([{ reason: 'the style guide <file> is empty or far too short', count: 1, examples: [expect.any(String)] }]);
    expect(s.loops.stray).toEqual({ 1: 1, 3: 1 });
    expect(s.loops.strayCapHits).toBe(1);
    expect(s.loops.verifyIssues).toBe(1);
    expect(s.loops.verifyPass).toBe(1);
    const scan = s.byMode.find((m) => m.mode === 'scan')!;
    expect(scan.runs).toBe(4);
    expect(scan.agent).toBe('stray-phrase-detector');
    const ch2 = s.chapters.find((c) => c.key === CH(2))!;
    expect(ch2.strayRounds).toBe(3);
    expect(ch2.warnings[0]).toMatch(/stray/);
    expect(ch2.expansion).toBeGreaterThan(0);
    expect(ch2.costPer1k).toBeGreaterThan(0);
    expect(s.chapters.find((c) => c.key === 'cover.xhtml')!.excluded).toBe(true);
    expect(s.concurrency.utilization.reduce((a, u) => a + u.pct, 0)).toBeGreaterThan(99);
    expect(s.concurrency.utilization.some((u) => u.inFlight >= 2)).toBe(true);
    expect(s.pauses.length).toBeGreaterThanOrEqual(1);
    expect(s.chains.glossaryMs).toBeGreaterThan(0);
    expect(s.chains.longestChapter).toBeTruthy();
    expect(s.prompts.find((p) => p.agent === 'stray-phrase-detector')!.runs).toBe(4);
    expect(s.noChange).toEqual([]);
    expect(s.run.wallMs).toBeGreaterThan(0);
    for (const section of ['summary', 'stages', 'chapters', 'failures', 'timeline', 'prompts'] as const) expect(render(s, section).length).toBeGreaterThan(20);
    expect(render(s)).toContain('agent runs:');
    expect(render(s, 'failures')).toContain('rejected — the style guide');
  });
});

describe('series', () => {
  it('starts a sequel from the previous book\'s notes: glossary entries settled, initialization refreshed', async () => {
    const first = await engineProject({ book: { chapters: 2 } });
    await timingFor();
    first.engine.start();
    await untilRun(first.engine, 'awaiting_review');
    first.engine.approve();
    await untilRun(first.engine, 'completed');
    expect(JSON.parse(file(first.ws, 'notes/master_glossary.json'))).toHaveLength(2);

    const projects = await import('../../src/projects.js');
    const engineMod = await import('../../src/engine/engine.js');
    const { makeBook } = await import('../support/epub.js');
    const sequelEpub = makeBook(path.join(first.dataDir, 'sequel.epub'), { chapters: 1 });
    first.project.meta.series = 'Saga';
    first.project.meta.seriesIndex = 1;
    first.project.save();
    expect(() => projects.createProject({ name: 'Sequel', targetLanguage: 'French', context: '', epubBuffer: fs.readFileSync(sequelEpub), epubFilename: 's.epub', series: 'Saga' })).toThrow(/language-specific/);
    const sequel = projects.createProject({ name: 'Sequel', targetLanguage: 'spanish ', context: '', epubBuffer: fs.readFileSync(sequelEpub), epubFilename: 's.epub', series: 'Saga' });
    expect(sequel.meta).toMatchObject({ series: 'Saga', seriesIndex: 2, inheritFrom: first.project.meta.id });
    expect(projects.listSeries()).toEqual([{ name: 'Saga', books: [first.project.meta, sequel.meta], latest: first.project.meta }]);

    const before = fake.calls.length;
    const engine = engineMod.engineFor(sequel);
    engine.start();
    await untilRun(engine, 'awaiting_review');
    expect(sequel.meta.inherited).toMatchObject({ from: first.project.meta.id, fromName: 'Book', glossaryEntries: 2, files: ['notes/master_glossary.json', 'notes/style_guide.md', 'notes/metadata.json', 'notes/critique_charter.md'] });
    // The glossary grew from the inherited two, not from zero.
    expect(JSON.parse(file(sequel.workspace, 'notes/master_glossary.json'))).toHaveLength(3);
    // The initialization agents were told to refresh, and every chapter agent knows the series.
    const calls = fake.calls.slice(before);
    const metadata = calls.find((c) => c.mode === 'metadata')!;
    expect(metadata.prompt).toContain('already exists, produced for "Book"');
    expect(metadata.prompt).toContain('part 2 of the series "Saga"');
    expect(calls.find((c) => c.mode === 'translate')!.prompt).toContain('2 terms established in "Book": they are settled');
    expect(engine.trace.timelineRecords().find((t) => t.kind === 'inherit')).toMatchObject({ glossaryEntries: 2, sourceCompleted: true });
    expect(engine.trace.runs().find((r) => r.mode === 'glossary')!.inputs.find((i) => i.path === 'notes/master_glossary.json')!.size).toBeGreaterThan(10);
  });
});

describe('restarts', () => {
  it('continues a run after the process dies: running steps run again, done steps do not', async () => {
    const { engine, reload, project } = await engineProject({ book: { chapters: 2 } });
    await timingFor();
    fake.on('charter', { fault: 'hang' });
    engine.start();
    await until(() => engine.state.steps.charter.state === 'running');
    const doneBefore = Object.values(engine.state.steps).filter((s) => s.state === 'done').map((s) => s.id);
    expect(doneBefore).toContain('metadata');
    engine.saveNow();
    // The old process is gone; its hanging query is never answered.
    const { engine: again, project: p2, boot } = await reload();
    await timingFor();
    expect(again.runState).toBe('paused');
    expect(again.state.run.reason).toMatch(/server restarted/);
    expect(again.state.steps.charter.state).toBe('pending');
    expect(again.state.steps.charter.runs[0]).toMatchObject({ state: 'failed', error: 'interrupted by a restart' });
    for (const id of doneBefore) expect(again.state.steps[id].state, id).toBe('done');
    expect(p2.meta.status).toBe('paused');
    const before = fake.calls.length;
    boot();
    await untilRun(again, 'awaiting_review');
    const after = fake.calls.slice(before);
    expect(after.filter((c) => c.mode === 'metadata')).toHaveLength(0); // done before the restart: not run again
    expect(after.filter((c) => c.mode === 'charter')).toHaveLength(1);
    void project;
  });

  it('runs a done step again when its output has gone (a revert, a deleted file)', async () => {
    const { engine, ws } = await engineProject({ book: { chapters: 1 } });
    await timingFor();
    engine.start();
    await untilRun(engine, 'awaiting_review');
    fs.rmSync(path.join(ws, 'notes', 'style_guide.md'));
    fs.rmSync(path.join(ws, 'final', 'OEBPS', 'chapter1.xhtml'));
    engine.revalidate();
    expect(engine.state.steps.style).toMatchObject({ state: 'pending', warning: expect.stringMatching(/went missing/) });
    expect(engine.state.steps[`${CH(1)}/final`].state).toBe('pending');
    expect(engine.state.steps[`${CH(1)}/verify`].state).toBe('pending');
    expect(engine.state.steps[`${CH(1)}/critique`].state).toBe('done');
  });

  it('picks up a project made before the engine existed from the files it has', async () => {
    const { engine, ws, reload } = await engineProject({ book: { chapters: 1 } });
    await timingFor();
    engine.start();
    await until(() => engine.state.steps.metadata.state === 'done');
    engine.pause();
    await until(() => fake.active === 0);
    fs.rmSync(path.join(ws, '..', 'pipeline.json'));
    const { engine: again } = await reload();
    expect(again.chapters.map((c) => c.key)).toEqual(['cover.xhtml', CH(1)]);
    expect(again.runState).toBe('idle');
    expect(again.state.steps.prepare.state).toBe('pending');
  });
});
