import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { freshEnv, restoreEnv } from '../support/boot.js';

afterEach(restoreEnv);

const load = () => import('../../src/projects.js');
const input = (over: Record<string, unknown> = {}) => ({
  name: 'Book',
  targetLanguage: 'Spanish',
  context: 'for kids',
  epubBuffer: Buffer.from('epub-bytes'),
  epubFilename: 'book.epub',
  ...over,
});

describe('projects', () => {
  it('creates a workspace holding the source EPUB under a first git commit', async () => {
    freshEnv();
    const { createProject, getProject, listProjects } = await load();
    const p = createProject(input());
    expect(p.meta).toMatchObject({ name: 'Book', targetLanguage: 'Spanish', context: 'for kids', status: 'created' });
    expect(p.meta.id).toMatch(/^[0-9a-f]{12}$/);
    expect(fs.readFileSync(path.join(p.workspace, 'source.epub'), 'utf8')).toBe('epub-bytes');
    const log = execFileSync('git', ['log', '--format=%s'], { cwd: p.workspace, encoding: 'utf8' }).trim();
    expect(log).toBe('lexis: project created');
    expect(getProject(p.meta.id)).toBe(p);
    expect(listProjects()).toEqual([p]);
    expect(JSON.parse(fs.readFileSync(path.join(p.dir, 'project.json'), 'utf8')).id).toBe(p.meta.id);
  });

  it('lists the newest project first', async () => {
    freshEnv();
    const { createProject, listProjects } = await load();
    const a = createProject(input({ name: 'A' }));
    a.meta.createdAt = '2020-01-01T00:00:00.000Z';
    const b = createProject(input({ name: 'B' }));
    expect(listProjects().map((p) => p.meta.name)).toEqual(['B', 'A']);
    expect(b).toBeDefined();
  });

  it('persists events, numbers them, filters by sequence and notifies subscribers', async () => {
    freshEnv();
    const { createProject } = await load();
    const p = createProject(input());
    const seen: number[] = [];
    const off = p.subscribe((e) => seen.push(e.seq));
    p.subscribe(() => {
      throw new Error('a broken socket must not break the pipeline');
    });
    p.emit('agent_text', 'orchestrator', { text: 'one' });
    p.emit('agent_text', 'orchestrator', { text: 'two' });
    off();
    p.emit('agent_text', 'orchestrator', { text: 'three' });
    expect(seen).toEqual([1, 2]);
    expect(p.readEvents().map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(p.readEvents(2).map((e) => e.data.text)).toEqual(['three']);
  });

  it('skips corrupt event lines', async () => {
    freshEnv();
    const { createProject } = await load();
    const p = createProject(input());
    p.emit('agent_text', 'orchestrator', { text: 'ok' });
    fs.appendFileSync(p.eventsFile, '{not json\n');
    expect(p.readEvents()).toHaveLength(1);
  });

  it('records status changes once, with the error detail', async () => {
    freshEnv();
    const { createProject } = await load();
    const p = createProject(input());
    p.setStatus('running');
    p.setStatus('running');
    p.setStatus('error', 'boom');
    expect(p.readEvents().filter((e) => e.type === 'status').map((e) => e.data.status)).toEqual(['running', 'error']);
    expect(p.meta.lastError).toBe('boom');
  });

  it('reloads projects after a restart, continuing the event sequence and settling interrupted runs', async () => {
    const dataDir = freshEnv();
    const first = await load();
    const p = first.createProject(input());
    p.emit('agent_text', 'orchestrator', { text: 'x' });
    p.setStatus('awaiting_review');
    const id = p.meta.id;
    fs.mkdirSync(path.join(dataDir, 'projects', 'garbage'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'projects', 'garbage', 'project.json'), '{oops');

    freshEnv({ LEXIS_DATA_DIR: dataDir });
    const second = await load();
    const again = second.getProject(id)!;
    expect(second.listProjects()).toHaveLength(1);
    expect(again.meta.status).toBe('awaiting_input');
    const seq = again.emit('agent_text', 'orchestrator', { text: 'y' }).seq;
    expect(seq).toBe(3);
  });
});
