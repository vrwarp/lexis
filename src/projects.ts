import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './env.js';
import type { ProjectMeta, ProjectStatus, UiEvent, UiEventType } from './types.js';

const PROJECTS_DIR = env.projectsDir;

type Listener = (event: UiEvent) => void;

export class Project {
  meta: ProjectMeta;
  private seq = 0;
  private listeners = new Set<Listener>();

  constructor(meta: ProjectMeta) {
    this.meta = meta;
    // Continue the sequence from the persisted event log.
    const events = this.readEvents();
    this.seq = events.length ? events[events.length - 1].seq : 0;
  }

  get dir(): string {
    return path.join(PROJECTS_DIR, this.meta.id);
  }

  /** The agent's working directory — everything the pipeline touches lives here. */
  get workspace(): string {
    return path.join(this.dir, 'workspace');
  }

  get eventsFile(): string {
    return path.join(this.dir, 'events.jsonl');
  }

  save(): void {
    this.meta.updatedAt = new Date().toISOString();
    fs.writeFileSync(path.join(this.dir, 'project.json'), JSON.stringify(this.meta, null, 2));
  }

  setStatus(status: ProjectStatus, detail?: string): void {
    if (this.meta.status === status) return;
    this.meta.status = status;
    if (status === 'error' && detail) this.meta.lastError = detail;
    this.save();
    this.emit('status', 'engine', { status, detail });
  }

  emit(type: UiEventType, agent: string, data: Record<string, unknown>, where: { step?: string; run?: string; chapter?: string } = {}): UiEvent {
    const event: UiEvent = {
      seq: ++this.seq,
      ts: new Date().toISOString(),
      type,
      agent,
      ...(where.step ? { step: where.step } : {}),
      ...(where.run ? { run: where.run } : {}),
      ...(where.chapter ? { chapter: where.chapter } : {}),
      data,
    };
    fs.appendFileSync(this.eventsFile, JSON.stringify(event) + '\n');
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a broken websocket must not break the pipeline
      }
    }
    return event;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Events after `afterSeq`; `only` narrows to one step, one agent run or one chapter. */
  readEvents(afterSeq = 0, only: { step?: string; run?: string; chapter?: string } = {}): UiEvent[] {
    if (!fs.existsSync(this.eventsFile)) return [];
    const lines = fs.readFileSync(this.eventsFile, 'utf8').split('\n').filter(Boolean);
    const events: UiEvent[] = [];
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as UiEvent;
        if (event.seq <= afterSeq) continue;
        if (only.run && event.run !== only.run) continue;
        if (only.step && event.step !== only.step) continue;
        if (only.chapter && event.chapter !== only.chapter) continue;
        events.push(event);
      } catch {
        // skip corrupt lines
      }
    }
    return events;
  }
}

const projects = new Map<string, Project>();

function loadFromDisk(): void {
  if (!fs.existsSync(PROJECTS_DIR)) return;
  for (const id of fs.readdirSync(PROJECTS_DIR)) {
    const metaFile = path.join(PROJECTS_DIR, id, 'project.json');
    if (!fs.existsSync(metaFile)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as ProjectMeta;
      // A server restart interrupts any in-flight run; the engine resumes it and sets the status again.
      if (meta.status === 'running') meta.status = 'paused';
      projects.set(id, new Project(meta));
    } catch {
      // skip corrupt projects
    }
  }
}

export function listProjects(): Project[] {
  return [...projects.values()].sort((a, b) => b.meta.createdAt.localeCompare(a.meta.createdAt));
}

export function getProject(id: string): Project | undefined {
  return projects.get(id);
}

export function createProject(input: {
  name: string;
  targetLanguage: string;
  context: string;
  epubBuffer: Buffer;
  epubFilename: string;
}): Project {
  const id = randomBytes(6).toString('hex');
  const now = new Date().toISOString();
  const meta: ProjectMeta = {
    id,
    name: input.name,
    targetLanguage: input.targetLanguage,
    context: input.context,
    status: 'created',
    createdAt: now,
    updatedAt: now,
    epubFilename: input.epubFilename,
  };
  const project = new Project(meta);
  fs.mkdirSync(project.workspace, { recursive: true });
  fs.writeFileSync(path.join(project.workspace, 'source.epub'), input.epubBuffer);
  // The workspace is a git repository: that is the versioning mechanism.
  const git = (...args: string[]) => execFileSync('git', args, { cwd: project.workspace });
  git('init', '-q');
  git('config', 'user.email', 'lexis@localhost');
  git('config', 'user.name', 'lexis');
  git('add', '-A');
  git('commit', '-qm', 'lexis: project created');
  project.save();
  projects.set(id, project);
  return project;
}

fs.mkdirSync(PROJECTS_DIR, { recursive: true });
loadFromDisk();
