/**
 * Named-prompt registry — open-agent's ChatPrompt/PromptService pattern
 * (Mustache templates, param substitution, per-prompt model binding), seeded
 * from files instead of Postgres: the 14 agents/*.md definitions become the
 * catalog, same file-per-agent format as every other lexis harness.
 */
import fs from 'node:fs';
import path from 'node:path';
import Mustache from 'mustache';
import { HARNESS_DIR } from './config.js';

// Match open-agent: no HTML escaping in prompt templates.
Mustache.escape = (text: string) => text;

const AGENTS_DIR = path.join(HARNESS_DIR, 'agents');

export interface AgentPrompt {
  /** Tool-safe name (underscores), e.g. ebook_disbinder. */
  name: string;
  description: string;
  /** Model tier from frontmatter: translation | mechanical. */
  tier: string;
  /** File-tool allowlist from frontmatter. */
  tools: string[];
  maxSteps: number;
  /** The agent's role instructions (markdown body, Mustache-templatable). */
  template: string;
}

const DEFAULT_SUBAGENT_MAX_STEPS = 30;

export class PromptRegistry {
  private prompts = new Map<string, AgentPrompt>();

  constructor(dir: string = AGENTS_DIR) {
    for (const file of fs.readdirSync(dir).sort()) {
      if (!file.endsWith('.md')) continue;
      const raw = fs.readFileSync(path.join(dir, file), 'utf8');
      const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      if (!match) throw new Error(`Agent file ${file} is missing frontmatter`);
      const [, frontmatter, body] = match;
      const fields: Record<string, string> = {};
      for (const line of frontmatter.split('\n')) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
      if (!fields.description || !fields.model) {
        throw new Error(`Agent file ${file} must declare description and model`);
      }
      const name = file.replace(/\.md$/, '').replaceAll('-', '_');
      this.prompts.set(name, {
        name,
        description: fields.description,
        tier: fields.model,
        tools: fields.tools ? fields.tools.split(',').map(t => t.trim()) : [],
        maxSteps: fields.max_steps ? Number(fields.max_steps) : DEFAULT_SUBAGENT_MAX_STEPS,
        template: body.trim(),
      });
    }
  }

  get(name: string): AgentPrompt {
    const prompt = this.prompts.get(name);
    if (!prompt) throw new Error(`Unknown prompt: ${name}`);
    return prompt;
  }

  names(): string[] {
    return [...this.prompts.keys()];
  }

  all(): AgentPrompt[] {
    return [...this.prompts.values()];
  }

  /** Render a prompt's instructions with params (open-agent's prompt.finish). */
  finish(name: string, params: Record<string, string> = {}): string {
    const prompt = this.get(name);
    return Mustache.render(prompt.template, {
      ...params,
      'oa::date': new Date().toLocaleDateString(),
    });
  }
}
