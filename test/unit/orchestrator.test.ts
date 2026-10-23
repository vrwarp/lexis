import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { freshEnv, restoreEnv, until } from '../support/boot.js';
import { makeEpub } from '../support/epub.js';
import { type Scenario, calls, fakeQuery, init, pipelineScenario, result, say, toolResult, toolUse } from '../support/fake-sdk.js';

afterEach(restoreEnv);

async function setup(scenario: Scenario) {
  const dataDir = freshEnv();
  const { sdk } = await import('../../src/sdk.js');
  sdk.query = fakeQuery(scenario);
  const { createProject } = await import('../../src/projects.js');
  const { sessionFor } = await import('../../src/orchestrator.js');
  const epub = makeEpub(path.join(dataDir, 'in.epub'));
  const project = createProject({ name: 'B', targetLanguage: 'Spanish', context: '', epubBuffer: fs.readFileSync(epub), epubFilename: 'in.epub' });
  calls.length = 0;
  return { project, session: sessionFor(project), sessionFor };
}

const types = (p: { readEvents(): { type: string }[] }) => p.readEvents().map((e) => e.type);

describe('OrchestratorSession', () => {
  it('runs the pipeline with the configured models, tools and isolation', async () => {
    const { project, session } = await setup(pipelineScenario);
    session.send('Begin the translation of source.epub into Spanish.');
    await until(() => session.awaitingReview, 5000, 'review gate');
    const opts = calls[0].options!;
    expect(opts).toMatchObject({
      cwd: project.workspace,
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      settingSources: [],
      permissionMode: 'bypassPermissions',
      disallowedTools: ['WebSearch', 'WebFetch'],
    });
    expect(opts.agents!['primary-translator']).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' });
    expect(opts.env!.CLAUDE_CONFIG_DIR).toMatch(/claude$/);
    expect(opts.allowedTools).toContain('mcp__lexis__request_review');
    expect(opts.resume).toBeUndefined();
    expect(project.meta.status).toBe('awaiting_review');
    expect(project.meta.sessionId).toBe('fake-session-1');
  });

  it('turns SDK messages into UI events with subagent attribution', async () => {
    const { project, session } = await setup(pipelineScenario);
    session.send('Begin the translation of source.epub into Spanish.');
    await until(() => session.awaitingReview);
    const events = project.readEvents();
    expect(events[0]).toMatchObject({ type: 'user_message', agent: 'user' });
    expect(events.find((e) => e.type === 'task_start')).toMatchObject({ agent: 'orchestrator', data: { agent: 'ebook-disbinder', description: 'Extract the EPUB' } });
    expect(events.find((e) => e.type === 'agent_text' && e.data.text === 'Extracted 1 chapter.')?.agent).toBe('ebook-disbinder');
    expect(events.find((e) => e.type === 'tool_use')).toMatchObject({ agent: 'ebook-disbinder', data: { tool: 'Bash' } });
    expect(events.filter((e) => e.type === 'task_end').map((e) => e.data.agent)).toEqual(['ebook-disbinder', 'primary-translator']);
    expect(events.filter((e) => e.type === 'progress').length).toBeGreaterThan(8);
    expect(events.find((e) => e.type === 'review_request')?.data.summary).toMatch(/1 chapter/);
    // lexis' own tools are not echoed as tool_use noise
    expect(events.some((e) => e.type === 'tool_use' && String(e.data.tool).startsWith('mcp__lexis__'))).toBe(false);
  });

  it('approves through the review gate, records completion and accumulates usage', async () => {
    const { project, session } = await setup(pipelineScenario);
    session.send('Begin the translation of source.epub into Spanish.');
    await until(() => session.awaitingReview);
    expect(session.resolveReview('approve')).toBe(true);
    expect(session.resolveReview('approve')).toBe(false);
    await until(() => project.meta.status === 'completed', 5000, 'completed');
    expect(project.meta.outputPath).toBe('translated_book.epub');
    expect(project.meta.usage?.totalCostUsd).toBeCloseTo(0.07);
    expect(project.meta.usage?.byModel['claude-opus-5-5']).toMatchObject({ inputTokens: 4000, outputTokens: 1500 });
    expect(types(project)).toContain('review_response');
    const usage = project.readEvents().filter((e) => e.type === 'usage').at(-1)!;
    expect(usage.data).toMatchObject({ turnCostUsd: expect.closeTo(0.07), turns: 3 });
  });

  it('stays awaiting review when the user messages during the gate', async () => {
    const { project, session } = await setup(pipelineScenario);
    session.send('Begin the translation of source.epub into Spanish.');
    await until(() => session.awaitingReview);
    session.send('[User comment on asset `final/chapter1.xhtml`]\n\nToo stiff');
    expect(project.meta.status).toBe('awaiting_review');
    session.resolveReview('approve');
    await until(() => project.readEvents().some((e) => e.type === 'agent_text' && String(e.data.text).startsWith('Noted: [User comment')));
  });

  it('loops through the gate again on revision instructions', async () => {
    const { project, session } = await setup(pipelineScenario);
    session.send('Begin the translation of source.epub into Spanish.');
    await until(() => session.awaitingReview);
    session.resolveReview('revise', 'Make it warmer');
    await until(() => project.readEvents().filter((e) => e.type === 'review_request').length === 2);
    expect(fs.readFileSync(path.join(project.workspace, 'final/chapter1.xhtml'), 'utf8')).toContain('revised');
    session.resolveReview('approve');
    await until(() => project.meta.status === 'completed');
  });

  it('only counts each turn once when results report cumulative usage', async () => {
    const { project, session } = await setup(async (s) => {
      for (let turn = 1; ; turn++) {
        if ((await s.next()) === null) return;
        s.emit(init('sess'));
        s.emit(say(`turn ${turn}`));
        s.emit(result({ 'claude-sonnet-5-5': { in: 100 * turn, out: 10 * turn, cost: 0.01 * turn } }));
      }
    });
    session.send('one');
    await until(() => project.meta.status === 'awaiting_input');
    session.send('two');
    await until(() => project.readEvents().filter((e) => e.type === 'usage').length === 2);
    expect(project.meta.usage!.byModel['claude-sonnet-5-5'].inputTokens).toBe(200);
    expect(project.meta.usage!.totalCostUsd).toBeCloseTo(0.02);
  });

  it('estimates live costs from token counts during a long turn', async () => {
    const { project, session } = await setup(async (s) => {
      await s.next();
      s.emit(say('working', { model: 'claude-opus-5-5', usage: { input_tokens: 1_000_000, output_tokens: 0 } }));
      await s.next();
    });
    session.send('go');
    const live = await until(() => project.readEvents().find((e) => e.type === 'usage' && e.data.live));
    expect(live.data).toMatchObject({ estimated: true, totalCostUsd: 4 });
    await session.close();
  });

  it('checks mark_complete: the path must stay in the workspace and be a plausible EPUB', async () => {
    const answers: { text: string; isError?: boolean }[] = [];
    const { project, session } = await setup(async (s) => {
      await s.next();
      for (const epub_path of ['../escape.epub', 'missing.epub']) {
        const r = await s.tool('mark_complete', { epub_path, summary: 's' });
        answers.push({ text: r.content[0].text, isError: r.isError });
      }
      s.emit(result());
    });
    session.send('go');
    await until(() => answers.length === 2);
    expect(answers[0]).toEqual({ text: 'Path escapes the workspace.', isError: true });
    expect(answers[1].isError).toBe(true);
    expect(project.meta.outputPath).toBeUndefined();
  });

  it('serves list_versions and revert_version to the agent', async () => {
    const texts: string[] = [];
    const { project, session } = await setup(async (s) => {
      await s.next();
      fs.writeFileSync(path.join(s.cwd, 'a.txt'), '1');
      texts.push((await s.tool('save_version', { label: 'one' })).content[0].text);
      texts.push((await s.tool('save_version', { label: 'again' })).content[0].text);
      texts.push((await s.tool('list_versions', {})).content[0].text);
      const id = texts[2].split('\n').at(-1)!.split(' ')[0];
      texts.push((await s.tool('revert_version', { id })).content[0].text);
      s.emit(result());
    });
    session.send('go');
    await until(() => texts.length === 4);
    expect(texts[0]).toMatch(/^Saved version [0-9a-f]{8}: one$/);
    expect(texts[1]).toBe('No changes since the last version; nothing to save.');
    expect(texts[2]).toMatch(/one\n.*lexis: project created$/);
    expect(texts[3]).toMatch(/^Workspace restored/);
    expect(fs.existsSync(path.join(project.workspace, 'a.txt'))).toBe(false);
  });

  it('resumes the saved session on the next run', async () => {
    const { project, session } = await setup(async (s) => {
      await s.next();
      s.emit(init('sess-42'));
      s.emit(result());
    });
    session.send('first');
    await until(() => calls.length === 1 && project.meta.sessionId === 'sess-42' && !session.running);
    session.send('second');
    await until(() => calls.length === 2);
    expect(calls[1].options!.resume).toBe('sess-42');
  });

  it('marks the project failed when the SDK throws', async () => {
    const { project, session } = await setup(async (s) => {
      await s.next();
      throw new Error('rate limited');
    });
    session.send('go');
    await until(() => project.meta.status === 'error');
    expect(project.meta.lastError).toMatch(/rate limited/);
    expect(project.readEvents().find((e) => e.type === 'error')?.data.message).toMatch(/rate limited/);
  });

  it('settles to awaiting input when a run ends without completion', async () => {
    const { project, session } = await setup(async (s) => {
      await s.next();
    });
    session.send('go');
    await until(() => !session.running && project.meta.status === 'awaiting_input');
  });

  it('interrupts the live query and unblocks a pending review on close', async () => {
    let interrupted = false;
    const { session } = await setup(async (s) => {
      await s.next();
      const r = await s.tool('request_review', { summary: 'x' });
      interrupted = s.interrupted && r.content[0].text.includes('shutting down');
    });
    session.send('go');
    await until(() => session.awaitingReview);
    await session.interrupt();
    await session.close();
    await until(() => interrupted);
    expect(session.awaitingReview).toBe(false);
  });

  it('truncates long tool inputs in the feed and attributes unknown parents to "subagent"', async () => {
    const { project, session } = await setup(async (s) => {
      await s.next();
      s.emit(toolUse('Write', { file_path: 'x', content: 'y'.repeat(1000) }, { parent: 'unknown-task' }).message);
      s.emit(toolResult('unknown-task'));
      s.emit(result());
    });
    session.send('go');
    const e = await until(() => project.readEvents().find((x) => x.type === 'tool_use'));
    expect(e.agent).toBe('subagent');
    expect(String(e.data.input && (e.data.input as Record<string, string>).content)).toMatch(/… \(1000 chars\)$/);
  });

  it('keeps one session per project', async () => {
    const { project, session, sessionFor } = await setup(async () => {});
    expect(sessionFor(project)).toBe(session);
  });
});
