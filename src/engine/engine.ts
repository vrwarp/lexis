import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadAgents } from '../agents.js';
import { env } from '../env.js';
import { discoverChapters, extractEpub, readPackage, replaceCover, resolveHref, syncAssets, validateEpubDir, zipEpub } from '../epub.js';
import type { Project } from '../projects.js';
import {
  CHAPTER_STAGES,
  type AgentRun,
  type Chapter,
  type ChapterStage,
  type ModelUsageTotals,
  type PipelineState,
  type RunConfig,
  type RunState,
  type Stage,
  type Step,
  type UsageTotals,
} from '../types.js';
import { saveVersion } from '../versioning.js';
import { STAGE_INFO, ensureSteps, excludedChapter, isBlocked, progress, readySteps, stagesFrom, stepId } from './plan.js';
import { type Outcome, estimateCostUsd, runAgent } from './runner.js';
import { MODE_AGENT, type RunMode, type StepContext, checkOutput, chapterPaths, outputsExist, outputsOf, taskPrompt } from './steps.js';

/** Waits the engine observes; tests shorten them. */
export const timing = {
  /** Backoff between retries of a rate-limited or overloaded run, then the run pauses. */
  transientBackoffMs: [30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000],
  /** How long a run paused by a usage limit waits when Claude did not say when it lifts. */
  limitPauseMs: 15 * 60_000,
  /** How long after a restart a running run picks up again. */
  bootDelayMs: 2000,
};

class StepFailed extends Error {}
class RunPaused extends Error {
  constructor(
    readonly reason: string,
    readonly resumeAt?: number,
  ) {
    super(reason);
  }
}
class Stopped extends Error {}

const now = () => new Date().toISOString();

export interface EngineHooks {
  /** Tests observe engine-level decisions here. */
  onSave?: (state: PipelineState) => void;
}

/**
 * Runs one project's pipeline: decides what runs next, runs it, checks what
 * it wrote, and keeps the state on disk so a restart continues from the
 * files that exist.
 */
export class Engine {
  readonly project: Project;
  readonly state: PipelineState;
  private readonly file: string;
  private inFlight = new Map<string, AbortController>();
  private saveTimer: NodeJS.Timeout | null = null;
  private resumeTimer: NodeJS.Timeout | null = null;
  private versions: Promise<unknown> = Promise.resolve();
  private live = new Map<string, Record<string, ModelUsageTotals>>();
  private lastLiveEmit = 0;
  private agents = loadAgents();
  private ticking = false;

  constructor(project: Project, hooks: EngineHooks = {}) {
    this.project = project;
    this.file = path.join(project.dir, 'pipeline.json');
    this.hooks = hooks;
    this.state = this.load();
    this.revalidate(false);
  }

  private hooks: EngineHooks;

  // ---------- state on disk ----------

  private load(): PipelineState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as PipelineState;
      if (raw.version === 1) {
        raw.config = { ...defaultConfig(), ...raw.config };
        raw.timings ??= {};
        raw.revisions ??= [];
        return raw;
      }
    } catch {
      // first run, or an unreadable file: start from what the workspace holds
    }
    const state: PipelineState = { version: 1, run: { state: 'idle' }, config: defaultConfig(), chapters: [], steps: {}, timings: {}, revisions: [] };
    // A project made before the engine existed may already hold extracted chapters.
    if (fs.existsSync(path.join(this.project.workspace, 'original', 'META-INF', 'container.xml'))) {
      try {
        state.chapters = discoverChapters(path.join(this.project.workspace, 'original')).chapters;
      } catch {
        // not usable; prepare will say why
      }
    }
    ensureSteps(state);
    return state;
  }

  private save(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 200);
  }

  saveNow(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
    this.hooks.onSave?.(this.state);
  }

  /**
   * Trust the workspace over the record: a step that was running when the
   * process died runs again; a done step whose output is gone runs again.
   */
  revalidate(announce = true): void {
    ensureSteps(this.state);
    const ctx = this.context();
    const changed: Step[] = [];
    for (const step of Object.values(this.state.steps)) {
      const was = step.state;
      for (const run of step.runs) {
        if (run.state === 'running') {
          run.state = 'failed';
          run.error = 'interrupted by a restart';
          run.endedAt = now();
        }
      }
      const chapter = step.chapter ? this.chapter(step.chapter) : undefined;
      if (step.state === 'running' || step.state === 'ready') {
        step.state = 'pending';
      } else if (step.state === 'done' && !outputsExist(ctx, step.stage, chapter)) {
        step.state = 'pending';
        step.warning = 'its output went missing; it will run again';
      }
      if (step.state !== was) changed.push(step);
    }
    if (announce) {
      for (const step of changed) this.emitStep(step);
      this.emitRun();
    }
    if (this.state.run.state === 'running' && !this.inFlight.size) {
      // Picked up again by boot(); until then it is paused, which is what the UI should say.
      this.state.run.state = 'paused';
      this.state.run.reason = 'the server restarted; resuming';
      this.state.run.resumeAt = new Date(Date.now() + timing.bootDelayMs).toISOString();
    }
    this.saveNow();
  }

  /** Continue a run the previous process was in the middle of. */
  boot(): void {
    const run = this.state.run;
    if (run.state === 'paused' && run.resumeAt) {
      const delay = Math.max(1000, Date.parse(run.resumeAt) - Date.now());
      this.resumeTimer = setTimeout(() => this.resume(), delay);
      this.resumeTimer.unref?.();
    }
  }

  // ---------- views ----------

  chapter(key: string): Chapter | undefined {
    return this.state.chapters.find((c) => c.key === key);
  }

  private context(): StepContext {
    const ws = this.project.workspace;
    let opfPath = '';
    let navPath: string | undefined;
    let ncxPath: string | undefined;
    try {
      const pkg = readPackage(path.join(ws, 'original'));
      opfPath = pkg.opfPath;
      const nav = pkg.manifest.find((i) => i.properties.includes('nav'));
      const ncx = pkg.manifest.find((i) => i.mediaType === 'application/x-dtbncx+xml');
      navPath = nav ? resolveHref(pkg.opfDir, nav.href) : undefined;
      ncxPath = ncx ? resolveHref(pkg.opfDir, ncx.href) : undefined;
    } catch {
      // before prepare
    }
    return { workspace: ws, meta: this.project.meta, chapters: this.state.chapters, opfPath, navPath, ncxPath, maxLoopRounds: this.state.config.maxLoopRounds };
  }

  /** The state for the API: everything but the stored prompts (fetched per step). */
  snapshot() {
    const steps: Record<string, Omit<Step, 'runs'> & { runs: Omit<AgentRun, 'prompt'>[] }> = {};
    for (const [id, s] of Object.entries(this.state.steps)) steps[id] = stripStep(s);
    return { run: this.state.run, config: this.state.config, chapters: this.state.chapters, steps, progress: progress(this.state), revisions: this.state.revisions, usage: this.combinedUsage() };
  }

  step(id: string): Step | undefined {
    return this.state.steps[id];
  }

  /** The gate summary: assembled from the state, not narrated by a model. */
  reviewSummary(): { summary: string; warnings: string[] } {
    const included = this.state.chapters.filter((c) => !c.excluded);
    const warnings: string[] = [];
    for (const c of included) {
      for (const stage of CHAPTER_STAGES) {
        const s = this.state.steps[stepId(stage, c.key)];
        if (s?.warning) warnings.push(`${c.title}: ${STAGE_INFO[stage].label.toLowerCase()} — ${s.warning}`);
        if (s?.state === 'failed') warnings.push(`${c.title}: ${STAGE_INFO[stage].label.toLowerCase()} failed — ${s.error ?? ''}`);
      }
    }
    let glossary = 0;
    try {
      glossary = (JSON.parse(fs.readFileSync(path.join(this.project.workspace, 'notes', 'master_glossary.json'), 'utf8')) as unknown[]).length;
    } catch {
      // none
    }
    const cost = this.combinedUsage().totalCostUsd;
    const lines = [
      `${included.length} section${included.length === 1 ? '' : 's'} finalized and verified; ${this.state.chapters.length - included.length} excluded.`,
      `Glossary: ${glossary} entries.`,
      `Cost so far: $${cost.toFixed(2)}.`,
      warnings.length ? `${warnings.length} thing${warnings.length === 1 ? '' : 's'} to look at (listed below).` : 'No loop caps hit, nothing left unresolved by verification.',
      'Approve to package the EPUB, or ask for another pass — for every section or just some — with instructions.',
    ];
    return { summary: lines.join('\n'), warnings };
  }

  // ---------- controls ----------

  /** Begin, or continue after a pause. */
  start(): void {
    const run = this.state.run;
    if (run.state === 'running') return;
    if (run.state === 'completed' && !Object.values(this.state.steps).some((s) => s.state !== 'done' && s.state !== 'skipped' && !excludedChapter(this.state, s))) return;
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
    run.state = 'running';
    run.reason = undefined;
    run.resumeAt = undefined;
    run.startedAt ??= now();
    run.endedAt = undefined;
    this.project.setStatus('running');
    this.emitRun();
    this.save();
    void this.tick();
  }

  resume(): void {
    this.start();
  }

  /** Finish what is in flight; start nothing new. */
  pause(reason = 'paused by you', resumeAt?: number): void {
    if (this.state.run.state !== 'running') return;
    this.state.run.state = 'paused';
    this.state.run.reason = reason;
    this.state.run.resumeAt = resumeAt ? new Date(resumeAt).toISOString() : undefined;
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    if (resumeAt) {
      this.resumeTimer = setTimeout(() => this.resume(), Math.max(1000, resumeAt - Date.now()));
      this.resumeTimer.unref?.();
    }
    this.project.setStatus('paused', reason);
    this.emitRun();
    this.save();
  }

  /** Abort what is in flight; those steps run again on resume. */
  stop(): void {
    if (this.state.run.state === 'running') this.pause('stopped by you');
    else if (this.state.run.state === 'awaiting_review') return;
    for (const abort of this.inFlight.values()) abort.abort();
  }

  setConcurrency(n: number): void {
    this.state.config.concurrency = Math.max(1, Math.min(8, Math.round(n)));
    this.emitPlan();
    this.save();
    void this.tick();
  }

  setInstructions(text: string): void {
    this.project.meta.context = text;
    this.project.save();
    this.project.emit('status', 'user', { status: this.project.meta.status, detail: 'Instructions updated; steps that start from now on see them.' });
  }

  setChapter(key: string, patch: { excluded?: boolean; note?: string; title?: string }): Chapter {
    const c = this.chapter(key);
    if (!c) throw new Error(`unknown chapter ${key}`);
    if (patch.excluded !== undefined) {
      c.excluded = patch.excluded;
      if (!patch.excluded) c.excludedReason = undefined;
    }
    if (patch.note !== undefined) c.note = patch.note.trim() || undefined;
    if (patch.title !== undefined && patch.title.trim()) c.title = patch.title.trim().slice(0, 120);
    this.writeContents();
    if (patch.excluded === false && (this.state.run.state === 'awaiting_review' || this.state.run.state === 'completed')) {
      // A chapter joined after the gate: its stages are new work, and the book must be packaged again.
      this.reopen();
      this.start();
    }
    this.emitPlan();
    this.save();
    void this.tick();
    return c;
  }

  /** Run a failed (or any finished) step again, from scratch. */
  retryStep(id: string): void {
    const step = this.state.steps[id];
    if (!step) throw new Error(`unknown step ${id}`);
    if (step.state === 'running') throw new Error('that step is running');
    const chapter = step.chapter ? this.chapter(step.chapter) : undefined;
    if (chapter && step.chapter) this.resetChapterFrom(chapter, step.stage as ChapterStage);
    else this.resetStep(step);
    if (step.stage === 'package') this.state.run.approved = true;
    this.save();
    if (this.state.run.state !== 'running') this.start();
    else void this.tick();
  }

  /** Re-run chapters from a stage, with a note that goes into their prompts. The files it discards are snapshotted first. */
  async rerunChapters(keys: string[], from: ChapterStage, note?: string, label?: string): Promise<string[]> {
    const todo = keys.map((k) => this.chapter(k)).filter((c): c is Chapter => Boolean(c) && !c!.excluded);
    if (!todo.length) return [];
    await this.checkpoint(label ?? `before re-running ${todo.map((c) => c.title).join(', ')} from ${STAGE_INFO[from].label.toLowerCase()}`);
    const done: string[] = [];
    for (const c of todo) {
      if (note?.trim()) c.note = c.note ? `${c.note}\n${note.trim()}` : note.trim();
      this.resetChapterFrom(c, from);
      done.push(c.key);
    }
    if (done.length) {
      this.reopen();
      this.emitPlan();
      this.save();
      if (this.state.run.state !== 'running') this.start();
      else void this.tick();
    }
    return done;
  }

  /** The user approved at the review gate: package. */
  approve(): boolean {
    if (this.state.run.state !== 'awaiting_review') return false;
    this.state.run.approved = true;
    this.project.emit('review_response', 'user', { decision: 'approve' });
    this.start();
    return true;
  }

  /** The user asked for another pass at the review gate. */
  async revise(opts: { chapters?: string[]; from?: ChapterStage; instructions: string }): Promise<boolean> {
    if (this.state.run.state !== 'awaiting_review') return false;
    const from = opts.from ?? 'critique';
    const keys = opts.chapters?.length ? opts.chapters : this.state.chapters.filter((c) => !c.excluded).map((c) => c.key);
    const n = this.state.revisions.length + 1;
    this.state.revisions.push({ at: now(), chapters: keys, from, instructions: opts.instructions });
    this.project.emit('review_response', 'user', { decision: 'revise', instructions: opts.instructions, chapters: keys, from });
    await this.rerunChapters(keys, from, `Revision ${n}: ${opts.instructions}`, `before revision ${n}`);
    return true;
  }

  // ---------- the plan ----------

  private reopen(): void {
    // Translated chapters changed: the book must be packaged again.
    const pkg = this.state.steps.package;
    if (pkg && pkg.state !== 'pending') this.resetStep(pkg);
    this.state.run.approved = false;
    if (this.state.run.state === 'completed' || this.state.run.state === 'awaiting_review') {
      this.state.run.state = 'paused';
      this.state.run.reason = 'more work queued';
    }
  }

  private resetStep(step: Step): void {
    step.state = 'pending';
    step.rounds = 0;
    step.attempts = 0;
    step.warning = undefined;
    step.error = undefined;
    step.startedAt = undefined;
    step.endedAt = undefined;
    step.durationMs = undefined;
    this.emitStep(step);
  }

  private resetChapterFrom(c: Chapter, from: ChapterStage): void {
    for (const stage of stagesFrom(from)) {
      const step = this.state.steps[stepId(stage, c.key)];
      if (!step) continue;
      // An aborted launch keeps its slot until it has unwound, so the scheduler cannot start the
      // step again while the old agent process is still being stopped.
      if (step.state === 'running') this.inFlight.get(step.id)?.abort();
      for (const rel of outputsOf(stage, c)) fs.rmSync(path.join(this.project.workspace, rel), { force: true });
      this.resetStep(step);
    }
    // Later chapters' glossary merges depend on this one; nothing else does.
  }

  private writeContents(): void {
    const dir = path.join(this.project.workspace, 'notes');
    if (!fs.existsSync(path.join(this.project.workspace, 'original', 'META-INF'))) return;
    fs.mkdirSync(dir, { recursive: true });
    const included = this.state.chapters.filter((c) => !c.excluded);
    const contents = included.map((c, i) => ({ index: i + 1, filename: c.key, path: c.path, title: c.title }));
    fs.writeFileSync(path.join(dir, 'contents.json'), JSON.stringify(contents, null, 2));
  }

  // ---------- scheduling ----------

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      while (this.state.run.state === 'running' && this.inFlight.size < this.state.config.concurrency) {
        const next = readySteps(this.state).find((s) => !this.inFlight.has(s.id) && (s.stage !== 'package' || this.state.run.approved));
        if (!next) break;
        this.launch(next);
      }
      this.settle();
    } finally {
      this.ticking = false;
    }
  }

  private launch(step: Step): void {
    const abort = new AbortController();
    this.inFlight.set(step.id, abort);
    step.state = 'running';
    step.startedAt = now();
    step.endedAt = undefined;
    step.error = undefined;
    step.attempts = 0;
    this.emitStep(step);
    this.emitRun();
    this.save();
    // A re-run can abort this launch and the scheduler may start the step again before this
    // launch has finished unwinding: only the launch that still owns the slot may touch the step.
    const mine = () => this.inFlight.get(step.id) === abort;
    void this.execute(step, abort.signal)
      .then(() => this.milestone(step))
      .then(() => {
        if (!mine()) return;
        step.state = 'done';
        step.error = undefined;
      })
      .catch((e: unknown) => {
        if (!mine()) return;
        if (e instanceof Stopped) {
          step.state = 'pending';
        } else if (e instanceof RunPaused) {
          step.state = 'pending';
          this.pause(e.reason, e.resumeAt);
        } else {
          step.state = 'failed';
          step.error = e instanceof Error ? e.message : String(e);
          this.project.emit('error', 'engine', { message: `${describe(step, this.state)}: ${step.error}` }, { step: step.id, chapter: step.chapter });
        }
      })
      .finally(() => {
        if (!mine()) return;
        this.inFlight.delete(step.id);
        step.endedAt = now();
        step.durationMs = Date.parse(step.endedAt) - Date.parse(step.startedAt ?? step.endedAt);
        if (step.state === 'done') (this.state.timings[step.stage] ??= []).push(step.durationMs);
        this.emitStep(step);
        this.emitRun();
        this.save();
        void this.afterStep(step);
      });
  }

  private async afterStep(_step: Step): Promise<void> {
    await this.tick();
  }

  /**
   * A milestone snapshot is part of the step that earns it, so the step is
   * not done until the snapshot is committed. Other chapters may be mid-write
   * when it is taken; that is what a snapshot of a busy workspace is.
   */
  private async milestone(step: Step): Promise<void> {
    if (step.stage === 'charter') await this.checkpoint('initialization complete');
    else if (step.stage === 'glossary' && this.lastIncludedKey() === step.chapter) await this.checkpoint('glossary complete');
    else if (step.stage === 'verify') await this.checkpoint(`${this.chapter(step.chapter!)?.title ?? step.chapter} finalized`);
  }

  private lastIncludedKey(): string | undefined {
    const inc = this.state.chapters.filter((c) => !c.excluded);
    return inc[inc.length - 1]?.key;
  }

  /** Nothing is running and nothing can start: decide what the run has reached. */
  private settle(): void {
    if (this.state.run.state !== 'running' || this.inFlight.size) return;
    const steps = Object.values(this.state.steps).filter((s) => !excludedChapter(this.state, s));
    if (steps.some((s) => s.state === 'pending' && !isBlocked(this.state, s) && readySteps(this.state).some((r) => r.id === s.id) && (s.stage !== 'package' || this.state.run.approved))) return;
    const included = this.state.chapters.filter((c) => !c.excluded);
    const pkg = this.state.steps.package;
    if (pkg?.state === 'done') {
      this.state.run.state = 'completed';
      this.state.run.endedAt = now();
      this.project.setStatus('completed');
      this.emitRun();
      this.save();
      return;
    }
    const failed = steps.filter((s) => s.state === 'failed');
    if (failed.length) {
      const what = failed.map((s) => describe(s, this.state)).slice(0, 3).join(', ');
      this.pause(`${failed.length} step${failed.length === 1 ? '' : 's'} failed (${what}${failed.length > 3 ? ', …' : ''}); retry them to continue`);
      return;
    }
    const allVerified = included.every((c) => this.state.steps[stepId('verify', c.key)]?.state === 'done');
    if (allVerified && !this.state.run.approved) {
      this.state.run.state = 'awaiting_review';
      const { summary, warnings } = this.reviewSummary();
      this.project.setStatus('awaiting_review');
      this.project.emit('review_request', 'engine', { summary, warnings });
      this.emitRun();
      this.save();
      return;
    }
    // Nothing runnable, nothing failed, not finished: a chapter was excluded mid-flight or the plan is empty.
    this.pause('nothing left to run; check the chapter plan');
  }

  // ---------- running a step ----------

  private async execute(step: Step, signal: AbortSignal): Promise<void> {
    const chapter = step.chapter ? this.chapter(step.chapter) : undefined;
    if (step.chapter && !chapter) throw new StepFailed(`unknown chapter ${step.chapter}`);
    switch (step.stage) {
      case 'prepare':
        return this.prepare();
      case 'metadata':
      case 'style':
      case 'charter':
      case 'summarize':
      case 'lexicon':
      case 'critique':
      case 'final':
        await this.invoke(step, step.stage, chapter, signal);
        return;
      case 'glossary': {
        let before: number | undefined;
        try {
          before = (JSON.parse(fs.readFileSync(path.join(this.project.workspace, 'notes', 'master_glossary.json'), 'utf8')) as unknown[]).length;
        } catch {
          before = undefined;
        }
        await this.invoke(step, 'glossary', chapter, signal, { before: { glossaryEntries: before } });
        return;
      }
      case 'draft': {
        const c = chapter!;
        for (const rel of outputsOf('draft', c)) fs.rmSync(path.join(this.project.workspace, rel), { force: true });
        await this.invoke(step, 'translate', c, signal);
        for (let round = 1; ; round++) {
          const audit = await this.invoke(step, 'audit', c, signal, { round });
          step.rounds = round;
          if (audit.status === 'COMPLETE') return;
          if (round >= this.state.config.maxLoopRounds) {
            step.warning = `the omission audit still found gaps after ${round} rounds`;
            return;
          }
          await this.invoke(step, 'refine', c, signal, { round });
        }
      }
      case 'stray': {
        const c = chapter!;
        for (let round = 1; ; round++) {
          const scan = await this.invoke(step, 'scan', c, signal, { round });
          step.rounds = round;
          if (scan.status === 'CLEAN') return;
          if (round >= this.state.config.maxLoopRounds) {
            step.warning = `stray source-language text remained after ${round} rounds`;
            return;
          }
          await this.invoke(step, 'fix', c, signal, { round });
        }
      }
      case 'verify': {
        const c = chapter!;
        const check = await this.invoke(step, 'verify', c, signal);
        step.rounds = 1;
        if (check.status === 'PASS') return;
        await this.invoke(step, 'verify-fix', c, signal);
        step.rounds = 2;
        step.warning = 'verification found issues; one fix pass was applied (not re-verified, by design)';
        return;
      }
      case 'package':
        return this.package(step, signal);
    }
  }

  private async prepare(): Promise<void> {
    const ws = this.project.workspace;
    const original = path.join(ws, 'original');
    if (!fs.existsSync(path.join(original, 'META-INF', 'container.xml'))) {
      await extractEpub(path.join(ws, 'source.epub'), original);
    }
    const found = discoverChapters(original);
    // Keep what the user already decided about chapters that are still there.
    const old = new Map(this.state.chapters.map((c) => [c.key, c]));
    this.state.chapters = found.chapters.map((c) => {
      const prev = old.get(c.key);
      return prev ? { ...c, excluded: prev.excluded, excludedReason: prev.excluded ? (prev.excludedReason ?? c.excludedReason) : undefined, note: prev.note, title: prev.title } : c;
    });
    ensureSteps(this.state);
    for (const d of ['notes', 'draft', 'critique', 'final']) fs.mkdirSync(path.join(ws, d), { recursive: true });
    const glossary = path.join(ws, 'notes', 'master_glossary.json');
    if (!fs.existsSync(glossary)) fs.writeFileSync(glossary, '[]\n');
    this.writeContents();
    this.emitPlan();
    const included = this.state.chapters.filter((c) => !c.excluded).length;
    this.project.emit('agent_text', 'engine', { text: `Extracted the EPUB: ${this.state.chapters.length} documents in the spine, ${included} to translate.` }, { step: 'prepare' });
  }

  private async package(step: Step, signal: AbortSignal): Promise<void> {
    const ws = this.project.workspace;
    const copied = syncAssets(path.join(ws, 'original'), path.join(ws, 'final'));
    this.project.emit('agent_text', 'engine', { text: `Mirrored ${copied.length} untranslated file${copied.length === 1 ? '' : 's'} from original/ into final/.` }, { step: step.id });
    await this.invoke(step, 'package', undefined, signal);
    const problems = validateEpubDir(path.join(ws, 'final'));
    if (problems.length) throw new StepFailed(`final/ is not a valid EPUB layout: ${problems.join('; ')}`);
    const out = path.join(ws, 'translated_book.epub');
    await zipEpub(path.join(ws, 'final'), out);
    const cover = fs.readdirSync(ws).find((f) => f.startsWith('cover_override.'));
    if (cover) {
      try {
        await replaceCover(out, path.join(ws, cover));
      } catch (e) {
        step.warning = `the custom cover could not be applied: ${(e as Error).message}`;
      }
    }
    this.project.meta.outputPath = 'translated_book.epub';
    this.project.save();
    this.project.emit('agent_text', 'engine', { text: `Packaged translated_book.epub (${(fs.statSync(out).size / 1024).toFixed(0)} kB).` }, { step: step.id });
    await this.checkpoint('packaged epub');
  }

  /**
   * One agent invocation with its retries: the harness checks what was
   * written and asks again with the reason when it is not right; a rate
   * limit waits and tries again; a usage limit pauses the whole run.
   */
  private async invoke(step: Step, mode: RunMode, chapter: Chapter | undefined, signal: AbortSignal, opts: { round?: number; before?: { glossaryEntries?: number } } = {}) {
    const ctx = this.context();
    const agentName = MODE_AGENT[mode];
    const agent = this.agents[agentName];
    if (!agent) throw new StepFailed(`no agent definition for ${agentName}`);
    const tier = STAGE_INFO[step.stage].tier === 'translation' ? 'translation' : 'mechanical';
    const agentTier = ['metadata-generator', 'style-analyzer', 'critique-charter-generator', 'primary-translator', 'final-translator', 'native-critique'].includes(agentName) ? 'translation' : 'mechanical';
    let hint: string | undefined;
    let transient = 0;
    for (let attempt = 1; attempt <= this.state.config.maxAttempts; ) {
      if (signal.aborted) throw new Stopped();
      const prompt = taskPrompt(ctx, mode, chapter, { round: opts.round, hint });
      const run: AgentRun = {
        id: crypto.randomBytes(4).toString('hex'),
        agent: agentName,
        mode,
        round: opts.round ?? 1,
        attempt,
        state: 'running',
        startedAt: now(),
        prompt,
      };
      step.runs.push(run);
      step.attempts = attempt;
      this.emitStep(step);
      this.save();
      const outcome = await runAgent({
        workspace: ctx.workspace,
        agent,
        agentName,
        prompt,
        model: this.state.config.models[agentTier],
        effort: this.state.config.effort[agentTier],
        timeoutMs: this.state.config.stepTimeoutMs[tier],
        budgetUsd: this.state.config.stepBudgetUsd,
        maxTurns: this.state.config.maxTurns,
        signal,
        onEvent: (type, data) => this.project.emit(type, agentName, data, { step: step.id, run: run.id, chapter: step.chapter }),
        onUsage: (model, delta) => this.trackLive(run.id, model, delta),
      });
      this.live.delete(run.id);
      this.recordUsage(outcome);
      run.endedAt = now();
      run.durationMs = outcome.durationMs;
      run.costUsd = outcome.costUsd;
      run.tokens = outcome.tokens;
      run.model = outcome.model;
      step.costUsd += outcome.costUsd;

      if (outcome.kind === 'ok') {
        const check = checkOutput(ctx, mode, chapter, opts.before ?? {});
        if (check.ok) {
          run.state = 'done';
          if (check.warning) step.warning = check.warning;
          this.emitStep(step);
          this.save();
          return check;
        }
        run.state = 'failed';
        run.error = check.problem;
        hint = check.problem;
        this.project.emit('error', 'engine', { message: `${describe(step, this.state)}: ${check.problem}${attempt < this.state.config.maxAttempts ? ' — asking again' : ''}` }, { step: step.id, run: run.id, chapter: step.chapter });
        attempt++;
      } else if (outcome.kind === 'transient' && transient < timing.transientBackoffMs.length) {
        run.state = 'failed';
        run.error = outcome.error;
        const wait = timing.transientBackoffMs[transient++];
        this.project.emit('error', 'engine', { message: `${describe(step, this.state)}: ${outcome.error} — retrying in ${Math.round(wait / 1000)}s` }, { step: step.id, run: run.id, chapter: step.chapter });
        this.emitStep(step);
        await sleep(wait, signal);
      } else if (outcome.kind === 'limit' || outcome.kind === 'auth' || (outcome.kind === 'transient' && transient >= timing.transientBackoffMs.length)) {
        run.state = 'failed';
        run.error = outcome.error;
        this.emitStep(step);
        const resumeAt = outcome.kind === 'auth' ? undefined : (outcome.resetsAt ?? Date.now() + timing.limitPauseMs);
        const reason =
          outcome.kind === 'auth'
            ? `Claude cannot run: ${outcome.error}. Fix the sign-in under “Claude” and resume.`
            : outcome.kind === 'limit'
              ? `Claude's usage limit was reached (${outcome.error}); trying again ${resumeAt ? `at ${new Date(resumeAt).toLocaleTimeString()}` : 'later'}`
              : `Claude keeps refusing (${outcome.error}); trying again at ${new Date(resumeAt!).toLocaleTimeString()}`;
        throw new RunPaused(reason, resumeAt);
      } else if (outcome.kind === 'aborted') {
        run.state = 'failed';
        run.error = 'stopped';
        this.emitStep(step);
        throw new Stopped();
      } else {
        run.state = 'failed';
        run.error = outcome.error;
        hint = outcome.kind === 'timeout' ? `it ran out of time (${outcome.error}); work efficiently and finish` : outcome.error;
        this.project.emit('error', 'engine', { message: `${describe(step, this.state)}: ${outcome.error}${attempt < this.state.config.maxAttempts ? ' — trying again' : ''}` }, { step: step.id, run: run.id, chapter: step.chapter });
        attempt++;
      }
      this.emitStep(step);
      this.save();
    }
    throw new StepFailed(hint ?? 'failed');
  }

  // ---------- usage ----------

  private trackLive(runId: string, model: string, delta: { input: number; output: number; cacheRead: number; cacheWrite: number }): void {
    const byModel = this.live.get(runId) ?? {};
    const t = byModel[model] ?? { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0 };
    t.inputTokens += delta.input;
    t.outputTokens += delta.output;
    t.cacheReadInputTokens += delta.cacheRead;
    t.cacheCreationInputTokens += delta.cacheWrite;
    byModel[model] = t;
    this.live.set(runId, byModel);
    const at = Date.now();
    if (at - this.lastLiveEmit >= 10_000) {
      this.lastLiveEmit = at;
      const combined = this.combinedUsage();
      this.project.emit('usage', 'engine', { byModel: combined.byModel as unknown as Record<string, unknown>, totalCostUsd: combined.totalCostUsd, estimated: true, live: true });
    }
  }

  private recordUsage(outcome: Outcome): void {
    const totals = this.project.meta.usage ?? { byModel: {}, totalCostUsd: 0 };
    for (const [model, u] of Object.entries(outcome.usage)) {
      const e = totals.byModel[model] ?? { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0 };
      e.inputTokens += u.inputTokens;
      e.outputTokens += u.outputTokens;
      e.cacheReadInputTokens += u.cacheReadInputTokens;
      e.cacheCreationInputTokens += u.cacheCreationInputTokens;
      e.costUsd += u.costUsd;
      totals.byModel[model] = e;
      totals.totalCostUsd += u.costUsd;
    }
    this.project.meta.usage = totals;
    this.project.save();
    this.project.emit('usage', 'engine', { byModel: totals.byModel as unknown as Record<string, unknown>, totalCostUsd: totals.totalCostUsd });
  }

  /** Persisted totals plus what the in-flight runs have streamed so far (priced by the table, hence estimated). */
  combinedUsage(): UsageTotals & { estimated?: boolean } {
    const base = this.project.meta.usage;
    const totals: UsageTotals & { estimated?: boolean } = base ? (JSON.parse(JSON.stringify(base)) as UsageTotals) : { byModel: {}, totalCostUsd: 0 };
    for (const byModel of this.live.values()) {
      for (const [model, t] of Object.entries(byModel)) {
        const e = totals.byModel[model] ?? { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0 };
        const cost = estimateCostUsd(model, t);
        e.inputTokens += t.inputTokens;
        e.outputTokens += t.outputTokens;
        e.cacheReadInputTokens += t.cacheReadInputTokens;
        e.cacheCreationInputTokens += t.cacheCreationInputTokens;
        e.costUsd += cost;
        totals.byModel[model] = e;
        totals.totalCostUsd += cost;
        totals.estimated = true;
      }
    }
    return totals;
  }

  // ---------- versions and events ----------

  /** Snapshots are serialized: parallel steps finishing together must not race git. */
  checkpoint(label: string, auto = false): Promise<void> {
    const next = this.versions.then(() => saveVersion(this.project, label, auto)).catch((e) => console.error('[lexis] version failed', e, (e as { stderr?: string }).stderr));
    this.versions = next;
    return next.then(() => undefined);
  }

  private emitStep(step: Step): void {
    this.project.emit('step', 'engine', { step: stripStep(step) as unknown as Record<string, unknown> }, { step: step.id, chapter: step.chapter });
  }

  private emitRun(): void {
    this.project.emit('run', 'engine', { run: this.state.run as unknown as Record<string, unknown>, progress: progress(this.state) as unknown as Record<string, unknown> });
  }

  private emitPlan(): void {
    this.project.emit('plan', 'engine', { chapters: this.state.chapters as unknown as Record<string, unknown>[], config: this.state.config as unknown as Record<string, unknown> });
  }

  /** The chapter plan and settings for the assistant and the API. */
  get chapters(): Chapter[] {
    return this.state.chapters;
  }

  get runState(): RunState {
    return this.state.run.state;
  }

  /** A compact text picture of the run, for the assistant. */
  describeState(): string {
    const p = progress(this.state);
    const lines = [`Run: ${this.state.run.state}${this.state.run.reason ? ` (${this.state.run.reason})` : ''}. Steps: ${p.done}/${p.total} done, ${p.running} running, ${p.failed} failed.`];
    for (const stage of ['prepare', 'metadata', 'style', 'charter', 'package'] as Stage[]) lines.push(`- ${STAGE_INFO[stage].label}: ${this.state.steps[stage]?.state ?? 'pending'}`);
    for (const c of this.state.chapters) {
      if (c.excluded) {
        lines.push(`- ${c.key} "${c.title}": excluded${c.excludedReason ? ` (${c.excludedReason})` : ''}`);
        continue;
      }
      const cells = CHAPTER_STAGES.map((s) => {
        const st = this.state.steps[stepId(s, c.key)];
        return `${s}=${st?.state ?? 'pending'}${st?.warning ? '!' : ''}`;
      });
      lines.push(`- ${c.key} "${c.title}": ${cells.join(' ')}${c.note ? ` | note: ${c.note}` : ''}`);
    }
    return lines.join('\n');
  }
}

function defaultConfig(): RunConfig {
  return {
    concurrency: env.pipeline.concurrency,
    maxLoopRounds: env.pipeline.maxLoopRounds,
    maxAttempts: env.pipeline.maxAttempts,
    stepTimeoutMs: { ...env.pipeline.stepTimeoutMs },
    stepBudgetUsd: env.pipeline.stepBudgetUsd,
    maxTurns: env.pipeline.maxTurns,
    models: { translation: env.models.translation, mechanical: env.models.mechanical },
    effort: { translation: env.effort.translation, mechanical: env.effort.mechanical },
  };
}

function stripStep(s: Step) {
  return { ...s, runs: s.runs.map(({ prompt: _prompt, ...r }) => r) };
}

function describe(step: Step, state: PipelineState): string {
  const c = step.chapter ? state.chapters.find((x) => x.key === step.chapter) : undefined;
  return c ? `${STAGE_INFO[step.stage].label} of "${c.title}"` : STAGE_INFO[step.stage].label;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Stopped());
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Stopped());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const engines = new Map<string, Engine>();

export function engineFor(project: Project): Engine {
  let e = engines.get(project.meta.id);
  if (!e) {
    e = new Engine(project);
    engines.set(project.meta.id, e);
  }
  return e;
}

/** Continue runs the previous process left running. */
export function bootEngines(projects: Project[]): void {
  for (const p of projects) {
    if (!fs.existsSync(path.join(p.dir, 'pipeline.json'))) continue;
    engineFor(p).boot();
  }
}
