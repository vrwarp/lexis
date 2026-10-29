import { CHAPTER_STAGES, GLOBAL_STAGES, type Chapter, type ChapterStage, type GlobalStage, type PipelineState, type Stage, type Step } from '../types.js';

/**
 * The plan: which steps exist and what each one waits for. This is the whole
 * of the sequencing that used to live in the orchestrator's prompt.
 */

export const stepId = (stage: Stage, chapter?: string): string => (chapter ? `${chapter}/${stage}` : stage);

/** The agents a stage runs (the first is its main one), and which tier the stage's timeout follows. */
export const STAGE_INFO: Record<Stage, { agents: string[]; tier: 'translation' | 'mechanical' | 'code'; label: string }> = {
  prepare: { agents: [], tier: 'code', label: 'Prepare' },
  metadata: { agents: ['metadata-generator'], tier: 'translation', label: 'Metadata' },
  style: { agents: ['style-analyzer'], tier: 'translation', label: 'Style guide' },
  charter: { agents: ['critique-charter-generator'], tier: 'translation', label: 'Critique charter' },
  summarize: { agents: ['narrative-summarizer'], tier: 'mechanical', label: 'Summary' },
  lexicon: { agents: ['local-lexicographer'], tier: 'mechanical', label: 'Lexicon' },
  glossary: { agents: ['glossary-manager'], tier: 'mechanical', label: 'Glossary' },
  draft: { agents: ['primary-translator', 'omission-detector'], tier: 'translation', label: 'Draft' },
  stray: { agents: ['stray-phrase-detector', 'stray-phrase-fixer'], tier: 'mechanical', label: 'Stray scan' },
  critique: { agents: ['native-critique'], tier: 'translation', label: 'Critique' },
  final: { agents: ['final-translator'], tier: 'translation', label: 'Final' },
  verify: { agents: ['native-critique', 'final-translator'], tier: 'translation', label: 'Verify' },
  package: { agents: ['ebook-packager'], tier: 'mechanical', label: 'Package' },
};

const included = (state: PipelineState): Chapter[] => state.chapters.filter((c) => !c.excluded);

const isDone = (state: PipelineState, id: string): boolean => state.steps[id]?.state === 'done';

/**
 * What a step waits for. Extraction may start as soon as the metadata exists
 * (summaries need only the plan); production waits for every included
 * chapter's glossary merge and the whole initialization (LESSONS.md §2: the
 * glossary is complete before any chapter is translated).
 */
export function dependencies(state: PipelineState, step: Step): string[] {
  const deps: string[] = [];
  const ch = step.chapter;
  const chapters = included(state);
  const allGlossaries = () => chapters.map((c) => stepId('glossary', c.key));
  switch (step.stage) {
    case 'prepare':
      break;
    case 'metadata':
      deps.push('prepare');
      break;
    case 'style':
      deps.push('metadata');
      break;
    case 'charter':
      deps.push('style');
      break;
    case 'summarize':
      deps.push('prepare');
      break;
    case 'lexicon':
      deps.push('metadata');
      break;
    case 'glossary': {
      deps.push(stepId('lexicon', ch));
      const i = chapters.findIndex((c) => c.key === ch);
      if (i > 0) deps.push(stepId('glossary', chapters[i - 1].key));
      break;
    }
    case 'draft':
      deps.push(stepId('summarize', ch), 'charter', ...allGlossaries());
      break;
    case 'stray':
      deps.push(stepId('draft', ch));
      break;
    case 'critique':
      deps.push(stepId('stray', ch));
      break;
    case 'final':
      deps.push(stepId('critique', ch));
      break;
    case 'verify':
      deps.push(stepId('final', ch));
      break;
    case 'package':
      deps.push(...chapters.map((c) => stepId('verify', c.key)));
      break;
  }
  return deps;
}

export function isReady(state: PipelineState, step: Step): boolean {
  return dependencies(state, step).every((id) => isDone(state, id));
}

/** True when a dependency failed or was skipped, so this step can never run as things stand. */
export function isBlocked(state: PipelineState, step: Step): boolean {
  return dependencies(state, step).some((id) => {
    const s = state.steps[id]?.state;
    return s === 'failed' || s === 'skipped';
  });
}

const newStep = (stage: Stage, chapter?: string): Step => ({ id: stepId(stage, chapter), stage, chapter, state: 'pending', rounds: 0, attempts: 0, runs: [], costUsd: 0 });

/** Make sure every step the plan calls for exists; keep the ones that do. Returns the ids added. */
export function ensureSteps(state: PipelineState): string[] {
  const added: string[] = [];
  const want: Step[] = [];
  for (const stage of GLOBAL_STAGES) want.push(newStep(stage));
  for (const c of state.chapters) for (const stage of CHAPTER_STAGES) want.push(newStep(stage, c.key));
  for (const s of want) {
    if (!state.steps[s.id]) {
      state.steps[s.id] = s;
      added.push(s.id);
    }
  }
  return added;
}

/** Steps that may start now, most urgent first: global steps, then by chapter order, then by stage depth. */
export function readySteps(state: PipelineState): Step[] {
  const order = new Map(state.chapters.map((c, i) => [c.key, i]));
  const stageRank = (s: Stage) => (GLOBAL_STAGES as readonly string[]).indexOf(s) + 100 * ((CHAPTER_STAGES as readonly string[]).indexOf(s) + 1);
  return Object.values(state.steps)
    .filter((s) => (s.state === 'pending' || s.state === 'ready') && !excludedChapter(state, s) && isReady(state, s))
    .sort((a, b) => {
      // Glossary merges are the serial spine of extraction: let them jump the queue.
      const ga = a.stage === 'glossary' ? -1 : 0;
      const gb = b.stage === 'glossary' ? -1 : 0;
      if (ga !== gb) return ga - gb;
      const ca = a.chapter ? (order.get(a.chapter) ?? 0) : -1;
      const cb = b.chapter ? (order.get(b.chapter) ?? 0) : -1;
      // Finish chapters already in production before opening new ones: deeper stages first.
      const pa = isProduction(a.stage) ? -stageRank(a.stage) : 0;
      const pb = isProduction(b.stage) ? -stageRank(b.stage) : 0;
      if (isProduction(a.stage) && isProduction(b.stage) && pa !== pb) return pa - pb;
      if (ca !== cb) return ca - cb;
      return stageRank(a.stage) - stageRank(b.stage);
    });
}

export const isProduction = (stage: Stage): boolean => ['draft', 'stray', 'critique', 'final', 'verify'].includes(stage);
export const isChapterStage = (stage: Stage): stage is ChapterStage => (CHAPTER_STAGES as readonly string[]).includes(stage);
export const isGlobalStage = (stage: Stage): stage is GlobalStage => (GLOBAL_STAGES as readonly string[]).includes(stage);

export function excludedChapter(state: PipelineState, step: Step): boolean {
  if (!step.chapter) return false;
  return state.chapters.find((c) => c.key === step.chapter)?.excluded ?? true;
}

/** The chapter stages at or after `from`, in order. */
export function stagesFrom(from: ChapterStage): ChapterStage[] {
  return CHAPTER_STAGES.slice(CHAPTER_STAGES.indexOf(from));
}

export interface Progress {
  total: number;
  done: number;
  running: number;
  failed: number;
  /** Milliseconds the remaining steps are expected to take at this run's own pace, or null before any finished. */
  etaMs: number | null;
}

/** Counts over the steps that are part of this run (excluded chapters' steps are not). */
export function progress(state: PipelineState): Progress {
  const steps = Object.values(state.steps).filter((s) => !excludedChapter(state, s));
  const out: Progress = { total: steps.length, done: 0, running: 0, failed: 0, etaMs: null };
  const all = Object.values(state.timings).flat();
  // Steps of stages not yet seen take the average pace of everything seen so far.
  const overall = all.length ? all.reduce((a, b) => a + b, 0) / all.length : null;
  let remainingMs = 0;
  for (const s of steps) {
    if (s.state === 'done' || s.state === 'skipped') out.done++;
    else if (s.state === 'running') out.running++;
    else if (s.state === 'failed') out.failed++;
    if (s.state === 'done' || s.state === 'skipped' || overall === null) continue;
    const sample = state.timings[s.stage];
    remainingMs += sample?.length ? sample.reduce((a, b) => a + b, 0) / sample.length : overall;
  }
  if (overall !== null) out.etaMs = Math.round(remainingMs / Math.max(1, state.config.concurrency));
  return out;
}
