import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { freshEnv, restoreEnv } from '../support/boot.js';

afterEach(restoreEnv);

async function setup() {
  freshEnv();
  const { createProject } = await import('../../src/projects.js');
  const v = await import('../../src/versioning.js');
  const p = createProject({ name: 'B', targetLanguage: 'French', context: '', epubBuffer: Buffer.from('x'), epubFilename: 'b.epub' });
  const write = (rel: string, body: string) => {
    fs.mkdirSync(path.dirname(path.join(p.workspace, rel)), { recursive: true });
    fs.writeFileSync(path.join(p.workspace, rel), body);
  };
  return { p, write, ...v };
}

describe('versioning', () => {
  it('saves a labelled version only when something changed', async () => {
    const { p, write, saveVersion, listVersions } = await setup();
    expect(await saveVersion(p, 'nothing')).toBeNull();
    write('notes/a.txt', 'a');
    const v = await saveVersion(p, 'first notes');
    expect(v).toMatchObject({ label: 'first notes', auto: false });
    write('notes/a.txt', 'b');
    const auto = await saveVersion(p, 'checkpoint', true);
    expect(auto).toMatchObject({ label: 'checkpoint', auto: true });
    const all = await listVersions(p);
    expect(all.map((x) => x.label)).toEqual(['checkpoint', 'first notes', 'lexis: project created']);
    expect(all[0].id).toMatch(/^[0-9a-f]{40}$/);
    expect(p.readEvents().filter((e) => e.type === 'version')).toHaveLength(2);
  });

  it('reverts to an earlier version non-destructively, removing files added since', async () => {
    const { p, write, saveVersion, listVersions, revertToVersion } = await setup();
    write('final/ch1.xhtml', 'v1');
    const v1 = (await saveVersion(p, 'v1'))!;
    write('final/ch1.xhtml', 'v2');
    write('final/ch2.xhtml', 'new');
    await saveVersion(p, 'v2');
    write('final/ch1.xhtml', 'unsaved work');

    const reverted = await revertToVersion(p, v1.id.slice(0, 8));
    expect(reverted.label).toBe(`revert to ${v1.id.slice(0, 8)} (v1)`);
    expect(fs.readFileSync(path.join(p.workspace, 'final/ch1.xhtml'), 'utf8')).toBe('v1');
    expect(fs.existsSync(path.join(p.workspace, 'final/ch2.xhtml'))).toBe(false);
    const labels = (await listVersions(p)).map((x) => x.label);
    expect(labels.slice(0, 3)).toEqual([reverted.label, 'snapshot before revert', 'v2']);

    // The unsaved work is still reachable: revert to the snapshot.
    const snap = (await listVersions(p))[1];
    await revertToVersion(p, snap.id);
    expect(fs.readFileSync(path.join(p.workspace, 'final/ch1.xhtml'), 'utf8')).toBe('unsaved work');
  });

  it('returns the target itself when the workspace already matches it', async () => {
    const { p, write, saveVersion, revertToVersion } = await setup();
    write('a', '1');
    const v = (await saveVersion(p, 'only'))!;
    expect((await revertToVersion(p, v.id)).id).toBe(v.id);
  });

  it('rejects an unknown version', async () => {
    const { p, revertToVersion } = await setup();
    await expect(revertToVersion(p, 'deadbeef')).rejects.toThrow(/Unknown version/);
  });
});
