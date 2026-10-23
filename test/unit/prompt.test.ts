import { describe, expect, it } from 'vitest';
import { orchestratorPrompt } from '../../src/prompt.js';
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

describe('orchestratorPrompt', () => {
  it('carries the target language and the user context verbatim', () => {
    const p = orchestratorPrompt(meta());
    expect(p).toContain('Target language: Traditional Chinese (Taiwan)');
    expect(p).toContain('User-provided context / instructions: Young adult readers');
  });

  it('says when there is no context', () => {
    expect(orchestratorPrompt(meta({ context: '' }))).toContain('(none provided)');
  });

  it('names every pipeline agent and every lexis tool it must use', async () => {
    const p = orchestratorPrompt(meta());
    const { loadAgents } = await import('../../src/agents.js');
    for (const agent of Object.keys(loadAgents())) expect(p, agent).toContain(`\`${agent}\``);
    for (const t of ['report_progress', 'save_version', 'list_versions', 'revert_version', 'request_review', 'mark_complete']) {
      expect(p, t).toContain(`\`${t}\``);
    }
  });

  it('keeps the review gate mandatory before packaging', () => {
    expect(orchestratorPrompt(meta())).toMatch(/MUST NOT package until `request_review` returns an approval/);
  });
});
