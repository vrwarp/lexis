import { describe, expect, it } from 'vitest';
import { assistantPrompt } from '../../src/prompt.js';
import type { ProjectMeta } from '../../src/types.js';

const meta = (over: Partial<ProjectMeta> = {}): ProjectMeta => ({
  id: 'p',
  name: 'n',
  targetLanguage: 'Traditional Chinese (Taiwan)',
  context: 'Young adult readers',
  status: 'created',
  createdAt: '',
  updatedAt: '',
  epubFilename: 'b.epub',
  ...over,
});

describe('assistantPrompt', () => {
  it('carries the target language and the user instructions verbatim', () => {
    const p = assistantPrompt(meta());
    expect(p).toContain('Target language: Traditional Chinese (Taiwan)');
    expect(p).toContain("The user's instructions: Young adult readers");
    expect(assistantPrompt(meta({ context: '' }))).toContain('(none)');
  });

  it('names every engine tool and keeps the assistant out of the translating', () => {
    const p = assistantPrompt(meta());
    for (const t of ['pipeline_status', 'rerun_chapters', 'set_note', 'save_version', 'pause_run', 'resume_run']) expect(p, t).toContain(`\`${t}\``);
    expect(p).toMatch(/never translate, summarize or critique text yourself/);
    expect(p).toMatch(/Never edit `original\/`/);
  });
});
