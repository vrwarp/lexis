export type ProjectStatus =
  | 'created'
  | 'running'
  | 'paused'
  | 'awaiting_review'
  | 'awaiting_input'
  | 'completed'
  | 'error';

export interface ModelUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
}

export interface UsageTotals {
  byModel: Record<string, ModelUsageTotals>;
  totalCostUsd: number;
}

export interface ProjectMeta {
  id: string;
  name: string;
  targetLanguage: string;
  /** The project-wide instructions. Editable mid-run; every step that starts afterwards sees the new text. */
  context: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  epubFilename: string;
  /** The assistant chat session, resumed across restarts. (Old projects carry the retired orchestrator's id here; it is ignored.) */
  sessionId?: string;
  assistantSessionId?: string;
  outputPath?: string;
  coverFilename?: string;
  lastError?: string;
  /** Accumulated token/cost usage across everything this project ran. */
  usage?: UsageTotals;
  /** The series this book belongs to, and its place in it. */
  series?: string;
  seriesIndex?: number;
  /** The project whose glossary, style guide, metadata and charter this one starts from. */
  inheritFrom?: string;
  /** What was inherited, once prepare has done it. */
  inherited?: { from: string; fromName: string; at: string; files: string[]; glossaryEntries: number };
}

export interface VersionInfo {
  id: string; // git commit hash
  label: string;
  date: string;
  auto: boolean;
}

// ---------- the pipeline ----------

/** The global steps, in order. */
export const GLOBAL_STAGES = ['prepare', 'metadata', 'style', 'charter', 'package'] as const;
export type GlobalStage = (typeof GLOBAL_STAGES)[number];

/** The per-chapter steps, in order. */
export const CHAPTER_STAGES = ['summarize', 'lexicon', 'glossary', 'draft', 'stray', 'critique', 'final', 'verify'] as const;
export type ChapterStage = (typeof CHAPTER_STAGES)[number];

export type Stage = GlobalStage | ChapterStage;

/** Stages the user can re-run a chapter from. */
export const RERUN_STAGES: ChapterStage[] = ['draft', 'critique', 'final'];

export type StepState = 'pending' | 'ready' | 'running' | 'done' | 'failed' | 'skipped';

/** One agent invocation inside a step: a stage can take several (loop rounds, retries). */
export interface AgentRun {
  id: string;
  agent: string;
  /** What this invocation was for, e.g. 'translate', 'refine', 'audit', 'fix', 'verify'. */
  mode: string;
  round: number;
  attempt: number;
  state: 'running' | 'done' | 'failed';
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  costUsd?: number;
  tokens?: { input: number; output: number };
  model?: string;
  /** Why it failed, when it did. */
  error?: string;
  /** Hash of the task prompt; the text is in the project's trace. */
  promptHash?: string;
}

export interface Step {
  id: string;
  stage: Stage;
  /** The chapter key; absent on global steps. */
  chapter?: string;
  state: StepState;
  /** Loop rounds taken (draft/omission, stray/fix). */
  rounds: number;
  attempts: number;
  runs: AgentRun[];
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  costUsd: number;
  /** Something to tell the user that did not stop the step: a loop cap hit, verification issues left. */
  warning?: string;
  /** The failure that blocks the step. */
  error?: string;
}

export interface Chapter {
  /** Unique short name; the agents' `<original file>` (summary, lexicon and report files are named by it). */
  key: string;
  /** Path relative to original/ (and mirrored in draft/ and final/). */
  path: string;
  index: number;
  title: string;
  /** Excluded chapters are copied into the book untranslated. */
  excluded: boolean;
  /** Why the plan excluded it by default, if it did. */
  excludedReason?: string;
  words: number;
  /** A note for this chapter, added to every prompt about it. */
  note?: string;
}

export type RunState = 'idle' | 'running' | 'paused' | 'awaiting_review' | 'completed';

export interface RunConfig {
  concurrency: number;
  maxLoopRounds: number;
  maxAttempts: number;
  stepTimeoutMs: { translation: number; mechanical: number };
  stepBudgetUsd: number;
  maxTurns: number;
  models: { translation: string; mechanical: string };
  effort: { translation: string; mechanical: string };
}

export interface RunInfo {
  state: RunState;
  /** Why the run is paused, when it is. */
  reason?: string;
  /** When a paused run will try again by itself. */
  resumeAt?: string;
  startedAt?: string;
  endedAt?: string;
  /** Set once the user approved the review gate; packaging follows. */
  approved?: boolean;
}

export interface PipelineState {
  version: 1;
  run: RunInfo;
  config: RunConfig;
  chapters: Chapter[];
  steps: Record<string, Step>;
  /** Durations of finished runs by stage, for the ETA. */
  timings: Partial<Record<Stage, number[]>>;
  /** Instructions given at review gates, newest last. */
  revisions: { at: string; chapters: string[]; from: ChapterStage; instructions: string }[];
}

// ---------- the live feed ----------

export type UiEventType =
  | 'status' // project status change: { status, detail? }
  | 'plan' // the chapter plan: { chapters, config }
  | 'step' // a step changed: { step }
  | 'run' // the run changed: { run, progress }
  | 'agent_text' // agent prose: { text }
  | 'thinking' // agent reasoning summary: { text }
  | 'tool_use' // { tool, input }
  | 'review_request' // { summary, warnings }
  | 'review_response' // { decision, instructions?, chapters? }
  | 'user_message' // { text }
  | 'version' // { version: VersionInfo }
  | 'usage' // { byModel, totalCostUsd, estimated?, live? }
  | 'error'; // { message }

export interface UiEvent {
  seq: number;
  ts: string;
  type: UiEventType;
  /** Who produced it: an agent name, 'engine', 'assistant' or 'user'. */
  agent: string;
  /** The step and agent run it belongs to, when it belongs to one. */
  step?: string;
  run?: string;
  chapter?: string;
  data: Record<string, unknown>;
}
