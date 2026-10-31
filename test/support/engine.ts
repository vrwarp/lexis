import fs from 'node:fs';
import path from 'node:path';
import { freshEnv } from './boot.js';
import { type BookOptions, makeBook } from './epub.js';
import { fake, fakeQuery } from './fake-sdk.js';

/**
 * A project with a generated book and the engine for it, on the fake SDK,
 * loaded fresh so module state (project registry, engine registry) is clean.
 */
export async function engineProject(opts: { book?: BookOptions; env?: Record<string, string | undefined>; context?: string } = {}) {
  const dataDir = freshEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'tok', LEXIS_CONCURRENCY: '3', ...opts.env });
  fake.reset();
  const { sdk } = await import('../../src/sdk.js');
  sdk.query = fakeQuery();
  const projects = await import('../../src/projects.js');
  const engineMod = await import('../../src/engine/engine.js');
  const epub = makeBook(path.join(dataDir, 'book.epub'), opts.book);
  const project = projects.createProject({ name: 'Book', targetLanguage: 'Spanish', context: opts.context ?? '', epubBuffer: fs.readFileSync(epub), epubFilename: 'book.epub' });
  const engine = engineMod.engineFor(project);
  const reload = async () => {
    // What a server restart does: fresh modules, same data directory.
    freshEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'tok', LEXIS_DATA_DIR: dataDir, ...opts.env });
    const { sdk: sdk2 } = await import('../../src/sdk.js');
    sdk2.query = fakeQuery();
    const p2 = await import('../../src/projects.js');
    const e2 = await import('../../src/engine/engine.js');
    const again = p2.getProject(project.meta.id)!;
    return { project: again, engine: e2.engineFor(again), boot: () => e2.bootEngines(p2.listProjects()) };
  };
  return { dataDir, project, engine, reload, ws: project.workspace };
}

export const file = (ws: string, rel: string) => fs.readFileSync(path.join(ws, rel), 'utf8');
export const exists = (ws: string, rel: string) => fs.existsSync(path.join(ws, rel));
