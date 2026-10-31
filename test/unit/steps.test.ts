import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type StepContext, checkOutput, chapterPaths, outputsExist, outputsOf, taskPrompt } from '../../src/engine/steps.js';
import type { Chapter } from '../../src/types.js';

const chapter: Chapter = { key: 'chapter1.xhtml', path: 'OEBPS/Text/chapter1.xhtml', index: 1, title: 'Chapter 1: The Title', excluded: false, words: 120, note: 'keep the poem rhyming' };
const other: Chapter = { key: 'chapter2.xhtml', path: 'OEBPS/Text/chapter2.xhtml', index: 2, title: 'Chapter 2', excluded: false, words: 400 };

function ctx(): StepContext {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis-steps-'));
  fs.mkdirSync(path.join(ws, 'original', 'OEBPS', 'Text'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'original', 'OEBPS', 'Text', 'chapter1.xhtml'), '<html><head><title>t</title></head><body><p>Hello world, this is the source text of chapter one.</p></body></html>');
  return {
    workspace: ws,
    meta: { id: 'p', name: 'n', targetLanguage: 'Spanish (Mexico)', context: 'For young readers', status: 'created', createdAt: '', updatedAt: '', epubFilename: 'b.epub' },
    chapters: [chapter, other],
    opfPath: 'OEBPS/content.opf',
    navPath: 'OEBPS/nav.xhtml',
    maxLoopRounds: 3,
  };
}

const write = (c: StepContext, rel: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(c.workspace, rel)), { recursive: true });
  fs.writeFileSync(path.join(c.workspace, rel), body);
};

describe('task prompts', () => {
  it('name the exact files, carry the instructions and the chapter note, and the contract', () => {
    const p = taskPrompt(ctx(), 'translate', chapter);
    expect(p).toContain('Translating into: Spanish (Mexico)');
    expect(p).toContain('Instructions from the user: For young readers');
    expect(p).toContain('Note from the user about this section: keep the poem rhyming');
    expect(p).toContain('This section: 1 of 2 — "Chapter 1: The Title"');
    expect(p).toContain('Translate `original/OEBPS/Text/chapter1.xhtml` and write the draft to `draft/OEBPS/Text/chapter1.xhtml`');
    expect(p).toContain('`notes/chapter1.xhtml.summary.txt`');
    expect(p).toContain('keep every tag, attribute, id and class');
    expect(p).toContain('# Harness contract');
    expect(p).not.toContain('Previous attempt');
  });

  it('is the same for the same inputs', () => {
    const c = ctx();
    expect(taskPrompt(c, 'critique', chapter)).toBe(taskPrompt(c, 'critique', chapter));
  });

  it('carries the round and the rejection reason', () => {
    const p = taskPrompt(ctx(), 'refine', chapter, { round: 2, hint: 'the draft lost the XHTML structure' });
    expect(p).toContain('round 2 of 3');
    expect(p).toContain('The previous attempt was rejected: the draft lost the XHTML structure');
  });

  it('tells the packager what the harness already did and where the nav is', () => {
    const p = taskPrompt(ctx(), 'package', undefined);
    expect(p).toContain('`final/OEBPS/content.opf`');
    expect(p).toContain('`final/OEBPS/nav.xhtml`');
    expect(p).toContain('Do not zip');
  });

  it('names the chapter files by key and path', () => {
    const p = chapterPaths(chapter);
    expect(p.draft).toBe('draft/OEBPS/Text/chapter1.xhtml');
    expect(p.omission).toBe('notes/chapter1.xhtml.omission_report.md');
    expect(p.finalCheck).toBe('critique/chapter1.xhtml.final_check.md');
  });
});

describe('output checks', () => {
  it('accepts a translated document that keeps the XHTML structure', () => {
    const c = ctx();
    write(c, 'draft/OEBPS/Text/chapter1.xhtml', '<html><head><title>t</title></head><body><p>Hola mundo, este es el texto de origen del capítulo uno.</p></body></html>');
    expect(checkOutput(c, 'translate', chapter)).toEqual({ ok: true });
  });

  it('rejects a missing, empty, plain-text or fenced translation with a usable reason', () => {
    const c = ctx();
    expect(checkOutput(c, 'translate', chapter).problem).toMatch(/was not written/);
    write(c, 'draft/OEBPS/Text/chapter1.xhtml', 'Hola mundo, este es el texto de origen del capítulo uno, sin etiquetas.');
    expect(checkOutput(c, 'translate', chapter).problem).toMatch(/lost the XHTML structure/);
    write(c, 'draft/OEBPS/Text/chapter1.xhtml', '```html\n<html><body><p>Hola</p></body></html>\n```');
    expect(checkOutput(c, 'translate', chapter).problem).toMatch(/code fence/);
    write(c, 'draft/OEBPS/Text/chapter1.xhtml', '<html><body></body></html>');
    expect(checkOutput(c, 'final', chapter)).toMatchObject({ ok: false });
  });

  it('warns, without rejecting, when a translation is suspiciously short', () => {
    const c = ctx();
    write(c, 'original/OEBPS/Text/chapter1.xhtml', `<html><body>${'<p>A long paragraph of source text that goes on and on.</p>'.repeat(20)}</body></html>`);
    write(c, 'final/OEBPS/Text/chapter1.xhtml', '<html><body><p>Hola.</p></body></html>');
    expect(checkOutput(c, 'final', chapter)).toMatchObject({ ok: true, warning: expect.stringMatching(/of the source's size/) });
  });

  it('reads the omission audit\'s status from its last line', () => {
    const c = ctx();
    const p = chapterPaths(chapter);
    write(c, p.omission, '<scratchpad>\n1. ok\n</scratchpad>\n\nSTATUS: COMPLETE\n\n');
    expect(checkOutput(c, 'audit', chapter)).toEqual({ ok: true, status: 'COMPLETE' });
    write(c, p.omission, 'STATUS: INCOMPLETE\n\n## Omission 1\n...');
    expect(checkOutput(c, 'audit', chapter)).toEqual({ ok: true, status: 'INCOMPLETE' });
    write(c, p.omission, 'I found nothing missing.');
    expect(checkOutput(c, 'audit', chapter).problem).toMatch(/STATUS line/);
  });

  it('reads the stray scan and the verification gate', () => {
    const c = ctx();
    const p = chapterPaths(chapter);
    write(c, p.stray, '{"status": "CLEAN", "stray_phrases": []}');
    expect(checkOutput(c, 'scan', chapter).status).toBe('CLEAN');
    write(c, p.stray, '```json\n{"status": "ISSUES_FOUND", "stray_phrases": [{}]}\n```');
    expect(checkOutput(c, 'scan', chapter).status).toBe('ISSUES_FOUND');
    write(c, p.stray, '{"status": "MAYBE"}');
    expect(checkOutput(c, 'scan', chapter).ok).toBe(false);
    write(c, p.finalCheck, '# check\n\nfine\n\n**STATUS: PASS**\n');
    expect(checkOutput(c, 'verify', chapter).status).toBe('PASS');
    write(c, p.finalCheck, 'STATUS: ISSUES_FOUND\n\nmore to do');
    expect(checkOutput(c, 'verify', chapter).ok).toBe(false);
  });

  it('checks the global notes and the glossary', () => {
    const c = ctx();
    expect(checkOutput(c, 'metadata').ok).toBe(false);
    write(c, 'notes/metadata.json', '{"target_language": "Spanish"}');
    expect(checkOutput(c, 'metadata').ok).toBe(true);
    write(c, 'notes/metadata.json', '[1]');
    expect(checkOutput(c, 'metadata').problem).toMatch(/not a JSON object/);
    write(c, 'notes/master_glossary.json', '[{"term":"a"}]');
    expect(checkOutput(c, 'glossary', chapter, { glossaryEntries: 3 })).toMatchObject({ ok: true, warning: expect.stringMatching(/shrank/) });
    write(c, 'notes/master_glossary.json', '{}');
    expect(checkOutput(c, 'glossary', chapter).ok).toBe(false);
    write(c, 'notes/style_guide.md', 'short');
    expect(checkOutput(c, 'style').problem).toMatch(/too short/);
  });

  it('knows which outputs a stage owns, for re-validation and re-runs', () => {
    const c = ctx();
    expect(outputsExist(c, 'draft', chapter)).toBe(false);
    write(c, 'draft/OEBPS/Text/chapter1.xhtml', '<html/>');
    expect(outputsExist(c, 'draft', chapter)).toBe(true);
    expect(outputsOf('draft', chapter)).toEqual(['draft/OEBPS/Text/chapter1.xhtml', 'notes/chapter1.xhtml.omission_report.md', 'notes/chapter1.xhtml.stray_report.json']);
    expect(outputsOf('final', chapter)).toEqual(['final/OEBPS/Text/chapter1.xhtml', 'critique/chapter1.xhtml.final_check.md']);
  });
});
