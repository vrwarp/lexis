import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

function int(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
function effort(name: string, fallback: Effort): Effort {
  const v = str(name, fallback) as Effort;
  return EFFORTS.includes(v) ? v : fallback;
}

const dataDir = path.resolve(str('LEXIS_DATA_DIR', str('DATA_DIR', path.join(ROOT, 'data'))));

/**
 * Model tiers. The strong model does the actual translation; the cheaper one
 * does everything else (docs/LESSONS.md §1: never put a cheap model on the
 * translation task). Each tier is a full model ID so a deployment pins exactly
 * what runs, and each can be overridden from the environment.
 */
const translationModel = str('LEXIS_TRANSLATION_MODEL', 'claude-opus-5-5');
const mechanicalModel = str('LEXIS_MECHANICAL_MODEL', 'claude-sonnet-5-5');

const translationTimeoutMin = int('LEXIS_STEP_TIMEOUT_MIN', 60);

export const env = {
  root: ROOT,
  port: int('PORT', 4700),
  dataDir,
  projectsDir: path.join(dataDir, 'projects'),
  claudeConfigDir: path.resolve(str('CLAUDE_CONFIG_DIR', path.join(dataDir, 'claude'))),
  authDir: path.join(dataDir, 'auth'),
  /** The password: the first way in, and always the backup once passkeys exist. */
  password: str('LEXIS_PASSWORD', ''),
  /** e.g. https://lexis.example.com. Pins the passkey origin and the allowed request origin. */
  publicUrl: str('LEXIS_PUBLIC_URL', '').replace(/\/+$/, ''),
  /** Express `trust proxy`: set to the number of reverse proxies in front (usually 1). */
  trustProxy: trustProxy(str('LEXIS_TRUST_PROXY', '0')),
  cookieSecure: str('COOKIE_SECURE', '0') === '1',
  debug: Boolean(process.env.LEXIS_DEBUG),
  models: {
    translation: translationModel,
    mechanical: mechanicalModel,
    /** The chat assistant (LEXIS_ORCHESTRATOR_MODEL is the old name). */
    assistant: str('LEXIS_ASSISTANT_MODEL', str('LEXIS_ORCHESTRATOR_MODEL', mechanicalModel)),
  },
  effort: {
    translation: effort('LEXIS_TRANSLATION_EFFORT', 'high'),
    mechanical: effort('LEXIS_MECHANICAL_EFFORT', 'medium'),
    assistant: effort('LEXIS_ASSISTANT_EFFORT', effort('LEXIS_ORCHESTRATOR_EFFORT', 'medium')),
  },
  /** How the engine runs a book. Fixed for a run (and recorded in it); concurrency can be changed live. */
  pipeline: {
    /** Agent runs in flight at once. Chapters are independent in extraction and production. */
    concurrency: Math.min(8, int('LEXIS_CONCURRENCY', 3)),
    /** Draft/omission and stray/fix rounds per chapter (LESSONS.md: bounded loops). */
    maxLoopRounds: int('LEXIS_LOOP_ROUNDS', 3),
    /** Tries per agent run before the step is marked failed. */
    maxAttempts: int('LEXIS_STEP_ATTEMPTS', 2),
    /** Wall-clock caps per agent run, by tier. */
    stepTimeoutMs: {
      translation: translationTimeoutMin * 60_000,
      mechanical: int('LEXIS_MECHANICAL_TIMEOUT_MIN', Math.max(10, Math.round(translationTimeoutMin / 2))) * 60_000,
    },
    /** A dollar cap per agent run, as a safety net against a looping agent. */
    stepBudgetUsd: Number(str('LEXIS_STEP_BUDGET_USD', '25')) || 25,
    /** A turn cap per agent run, for the same reason. */
    maxTurns: int('LEXIS_STEP_MAX_TURNS', 80),
  },
};

function trustProxy(v: string): boolean | number | string {
  if (v === 'true') return true;
  if (v === 'false') return false;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : v;
}

export type Tier = 'translation' | 'mechanical';

export function ensureDirs(): void {
  for (const d of [env.dataDir, env.projectsDir, env.claudeConfigDir]) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(env.authDir, { recursive: true, mode: 0o700 });
}

/**
 * Where Claude Code will find a credential, in the CLI's own precedence order:
 * bearer token, API key, long-lived subscription token from `claude setup-token`,
 * then a `.credentials.json` written by `claude auth login` into CLAUDE_CONFIG_DIR.
 */
export type CredentialSource = 'auth_token' | 'api_key' | 'oauth_token' | 'login' | 'none';

export function detectCredential(e: NodeJS.ProcessEnv = process.env, configDir = env.claudeConfigDir): CredentialSource {
  if (e.ANTHROPIC_AUTH_TOKEN?.trim()) return 'auth_token';
  if (e.ANTHROPIC_API_KEY?.trim()) return 'api_key';
  if (e.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return 'oauth_token';
  try {
    if (fs.existsSync(path.join(configDir, '.credentials.json'))) return 'login';
  } catch {
    // an unreadable config dir counts as no credential
  }
  return 'none';
}

export const CREDENTIAL_LABEL: Record<CredentialSource, string> = {
  auth_token: 'bearer token (ANTHROPIC_AUTH_TOKEN)',
  api_key: 'API key (ANTHROPIC_API_KEY)',
  oauth_token: 'subscription token (CLAUDE_CODE_OAUTH_TOKEN)',
  login: 'subscription sign-in',
  none: 'none',
};
