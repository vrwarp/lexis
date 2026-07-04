/**
 * Model tier configuration — the open-agent provider layer, distilled.
 *
 * open-agent registers CopilotProvider classes per vendor family around the
 * Vercel AI SDK and picks models by capability conditions. The lexis pipeline
 * needs exactly one capability (text+tools), so the layer reduces to: named
 * tiers -> an @ai-sdk/* LanguageModel plus call settings, with per-agent
 * overrides and a pricing table for cost display (their TokenTracker idea).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { createResilientFetch } from './diagnostics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const HARNESS_DIR = path.join(__dirname, '..');
const MODELS_FILE = process.env.LEXIS_OA_MODELS ?? path.join(HARNESS_DIR, 'models.json');

export interface TierSpec {
  tier?: string;
  provider?: 'anthropic' | 'openai' | 'google' | 'openai-compatible';
  model_id?: string;
  apiKeyEnv?: string;
  baseURL?: string;
  maxOutputTokens?: number;
  temperature?: number;
}

export interface ResolvedModel {
  model: LanguageModel;
  modelId: string;
  settings: { maxOutputTokens?: number; temperature?: number };
}

interface ModelConfig {
  tiers: Record<string, TierSpec>;
  agent_overrides?: Record<string, TierSpec | string>;
  pricing?: Record<string, { in?: number; out?: number } | string>;
}

/** Fallback per-MTok pricing, mirroring the other harnesses. */
const DEFAULT_PRICING: [string, number, number][] = [
  ['opus', 5, 25],
  ['sonnet', 3, 15],
  ['haiku', 1, 5],
];

export class ModelFactory {
  readonly config: ModelConfig;

  constructor(config?: ModelConfig) {
    this.config = config ?? (JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8')) as ModelConfig);
  }

  specFor(tier: string, agentName?: string): TierSpec {
    const tiers = this.config.tiers ?? {};
    if (!(tier in tiers)) throw new Error(`Unknown model tier '${tier}' — define it in ${MODELS_FILE}`);
    let spec: TierSpec = { ...tiers[tier] };
    const seen = new Set([tier]);
    while (spec.tier) {
      const alias = spec.tier;
      if (seen.has(alias)) throw new Error(`Model tier alias cycle at '${alias}'`);
      seen.add(alias);
      const { tier: _tier, ...local } = spec;
      spec = { ...tiers[alias], ...local };
    }
    const override = agentName ? this.config.agent_overrides?.[agentName] : undefined;
    if (override && typeof override === 'object') spec = { ...spec, ...override };
    return spec;
  }

  resolve(tier: string, agentName?: string): ResolvedModel {
    const spec = this.specFor(tier, agentName);
    const provider = spec.provider ?? 'anthropic';
    const modelId = spec.model_id;
    if (!modelId) throw new Error(`Tier '${tier}' has no model_id`);
    const apiKey = spec.apiKeyEnv ? process.env[spec.apiKeyEnv] : undefined;
    // Times out each request and retries 429/5xx with Retry-After backoff — the
    // free-tier upstreams return 429 constantly, so this is what keeps runs alive.
    const fetch = createResilientFetch();
    let model: LanguageModel;
    switch (provider) {
      case 'anthropic':
        model = createAnthropic({ fetch, ...(apiKey ? { apiKey } : {}) })(modelId);
        break;
      case 'openai':
        model = createOpenAI({ fetch, ...(apiKey ? { apiKey } : {}) })(modelId);
        break;
      case 'google':
        model = createGoogleGenerativeAI({
          fetch,
          // @ai-sdk/google reads GOOGLE_GENERATIVE_AI_API_KEY; accept GEMINI_API_KEY too.
          apiKey: apiKey ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY,
        })(modelId);
        break;
      case 'openai-compatible': {
        if (!spec.baseURL) throw new Error(`Tier '${tier}': openai-compatible requires baseURL`);
        model = createOpenAICompatible({
          name: 'openrouter',
          baseURL: spec.baseURL,
          fetch,
          ...(apiKey ? { apiKey } : {}),
        })(modelId);
        break;
      }
      default:
        throw new Error(`Unknown provider '${provider}' (expected anthropic|openai|google|openai-compatible)`);
    }
    const settings: ResolvedModel['settings'] = {};
    if (spec.maxOutputTokens) settings.maxOutputTokens = spec.maxOutputTokens;
    if (spec.temperature !== undefined) settings.temperature = spec.temperature;
    return { model, modelId, settings };
  }

  /** [$ per input MTok, $ per output MTok] or undefined when unknown. */
  pricePerMTok(modelId: string): [number, number] | undefined {
    for (const [key, entry] of Object.entries(this.config.pricing ?? {})) {
      if (typeof entry === 'object' && modelId.includes(key)) {
        return [entry.in ?? 0, entry.out ?? 0];
      }
    }
    const lower = modelId.toLowerCase();
    for (const [needle, cin, cout] of DEFAULT_PRICING) {
      if (lower.includes(needle)) return [cin, cout];
    }
    return undefined;
  }
}
