export type ProjectStatus =
  | 'created'
  | 'running'
  | 'awaiting_review'
  | 'awaiting_input'
  | 'completed'
  | 'error';

export interface ProjectMeta {
  id: string;
  name: string;
  targetLanguage: string;
  context: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  epubFilename: string;
  sessionId?: string;
  outputPath?: string;
  coverFilename?: string;
  lastError?: string;
}

export interface VersionInfo {
  id: string; // git commit hash
  label: string;
  date: string;
  auto: boolean;
}

export type UiEventType =
  | 'status' // project status change: { status, detail? }
  | 'agent_text' // assistant prose: { text }
  | 'thinking' // assistant reasoning summary: { text }
  | 'tool_use' // { tool, input }
  | 'tool_result' // { tool, ok, summary }
  | 'task_start' // subagent launched: { agent, description }
  | 'task_end' // subagent finished: { agent }
  | 'progress' // structured pipeline progress: { phase, chapter?, state, detail? }
  | 'review_request' // { summary }
  | 'review_response' // { decision, instructions? }
  | 'user_message' // { text }
  | 'version' // { versions: VersionInfo[] } or { version: VersionInfo }
  | 'usage' // { costUsd, durationMs, turns }
  | 'error'; // { message }

export interface UiEvent {
  seq: number;
  ts: string;
  type: UiEventType;
  /** which agent produced it: 'orchestrator' or a subagent name */
  agent: string;
  data: Record<string, unknown>;
}

/** Pipeline phases the orchestrator reports progress against. */
export const PHASES = [
  'preparation',
  'initialization',
  'extraction',
  'production',
  'review',
  'packaging',
  'done',
] as const;
export type Phase = (typeof PHASES)[number];
