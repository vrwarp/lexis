import { describe, expect, it } from 'vitest';
import { dependencies, ensureSteps, isReady, progress, readySteps, stepId } from '../../src/engine/plan.js';
import { CHAPTER_STAGES, type PipelineState } from '../../src/types.js';

function state(keys: string[], excluded: string[] = []): PipelineState {
  const s: PipelineState = {
    version: 1,
    run: { state: 'idle' },
    config: { concurrency: 3, maxLoopRounds: 3, maxAttempts: 2, stepTimeoutMs: { translation: 1, mechanical: 1 }, stepBudgetUsd: 1, maxTurns: 1, models: { translation: 'o', mechanical: 's' }, effort: { translation: 'high', mechanical: 'medium' } },
    chapters: keys.map((key, i) => ({ key, path: `${key}.xhtml`, index: i + 1, title: key, excluded: excluded.includes(key), words: 100 })),
    steps: {},
    timings: {},
    revisions: [],
  };
  ensureSteps(s);
  return s;
}

const done = (s: PipelineState, ...ids: string[]) => {
  for (const id of ids) s.steps[id].state = 'done';
};

describe('the plan', () => {
  it('creates one step per global stage and per chapter stage', () => {
    const s = state(['a', 'b']);
    expect(Object.keys(s.steps)).toHaveLength(5 + 2 * CHAPTER_STAGES.length);
    expect(ensureSteps(s)).toEqual([]);
  });

  it('starts with prepare only', () => {
    const s = state(['a', 'b']);
    expect(readySteps(s).map((x) => x.id)).toEqual(['prepare']);
  });

  it('lets summaries start after prepare and lexicons after metadata, in chapter order', () => {
    const s = state(['a', 'b']);
    done(s, 'prepare');
    expect(readySteps(s).map((x) => x.id)).toEqual(['metadata', 'a/summarize', 'b/summarize']);
    done(s, 'metadata');
    const ready = readySteps(s).map((x) => x.id);
    expect(ready).toContain('a/lexicon');
    expect(ready).toContain('style');
    expect(ready).not.toContain('a/glossary');
  });

  it('merges glossaries one chapter at a time in reading order, ahead of other work', () => {
    const s = state(['a', 'b', 'c']);
    done(s, 'prepare', 'metadata', 'a/lexicon', 'b/lexicon', 'c/lexicon');
    expect(readySteps(s)[0].id).toBe('a/glossary');
    expect(isReady(s, s.steps['b/glossary'])).toBe(false);
    done(s, 'a/glossary');
    expect(readySteps(s)[0].id).toBe('b/glossary');
  });

  it('holds every draft until the whole initialization and every glossary merge are done', () => {
    const s = state(['a', 'b']);
    done(s, 'prepare', 'metadata', 'style', 'a/summarize', 'b/summarize', 'a/lexicon', 'b/lexicon', 'a/glossary');
    expect(isReady(s, s.steps['a/draft'])).toBe(false);
    done(s, 'b/glossary');
    expect(isReady(s, s.steps['a/draft'])).toBe(false);
    done(s, 'charter');
    expect(isReady(s, s.steps['a/draft'])).toBe(true);
    expect(isReady(s, s.steps['b/draft'])).toBe(true);
    expect(dependencies(s, s.steps['a/draft'])).toEqual(['a/summarize', 'charter', 'a/glossary', 'b/glossary']);
  });

  it('runs a chapter\'s production stages in order and prefers finishing a chapter over starting one', () => {
    const s = state(['a', 'b']);
    done(s, 'prepare', 'metadata', 'style', 'charter', 'a/summarize', 'b/summarize', 'a/lexicon', 'b/lexicon', 'a/glossary', 'b/glossary', 'a/draft');
    const ready = readySteps(s).map((x) => x.id);
    expect(ready[0]).toBe('a/stray');
    expect(ready).toContain('b/draft');
    expect(ready).not.toContain('a/critique');
  });

  it('ignores excluded chapters everywhere', () => {
    const s = state(['a', 'b', 'c'], ['b']);
    done(s, 'prepare', 'metadata', 'style', 'charter', 'a/summarize', 'c/summarize', 'a/lexicon', 'c/lexicon', 'a/glossary');
    expect(readySteps(s).map((x) => x.id)).toContain('c/glossary');
    expect(dependencies(s, s.steps['c/glossary'])).toEqual(['c/lexicon', 'a/glossary']);
    done(s, 'c/glossary');
    expect(isReady(s, s.steps['a/draft'])).toBe(true);
    expect(readySteps(s).some((x) => x.chapter === 'b')).toBe(false);
    expect(dependencies(s, s.steps.package)).toEqual(['a/verify', 'c/verify']);
  });

  it('estimates the time left from this run\'s own timings', () => {
    const s = state(['a']);
    expect(progress(s).etaMs).toBeNull();
    done(s, 'prepare', 'metadata');
    s.timings.metadata = [60_000];
    const p = progress(s);
    expect(p.done).toBe(2);
    expect(p.total).toBe(5 + CHAPTER_STAGES.length);
    // 11 remaining steps at the one known pace, spread over 3 workers.
    expect(p.etaMs).toBe(Math.round((11 * 60_000) / 3));
  });
});
