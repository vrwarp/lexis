import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { env, type Tier } from './env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.join(__dirname, '..', 'agents');

/**
 * Load the 15 pipeline subagents from claude/agents/*.md.
 *
 * Each file carries a small frontmatter block (description, tier, tools)
 * followed by the agent's system prompt. The tier picks the model and effort
 * from env.ts, following the mapping the pipeline was reverted back to (see
 * docs/LESSONS.md): the strong model for the translation-quality tier, the
 * cheaper one for the mechanical/extraction tier.
 */
export function loadAgents(): Record<string, AgentDefinition> {
  const agents: Record<string, AgentDefinition> = {};
  for (const file of fs.readdirSync(AGENTS_DIR).sort()) {
    if (!file.endsWith('.md')) continue;
    const name = file.replace(/\.md$/, '');
    const raw = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8');
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) throw new Error(`Agent file ${file} is missing frontmatter`);
    const [, frontmatter, prompt] = match;
    const fields: Record<string, string> = {};
    for (const line of frontmatter.split('\n')) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    const tier = fields.tier as Tier;
    if (!fields.description || (tier !== 'translation' && tier !== 'mechanical')) {
      throw new Error(`Agent file ${file} must declare a description and tier: translation|mechanical`);
    }
    agents[name] = {
      description: fields.description,
      prompt: prompt.trim(),
      model: env.models[tier],
      effort: env.effort[tier],
      tools: fields.tools ? fields.tools.split(',').map((t) => t.trim()) : undefined,
    };
  }
  return agents;
}
