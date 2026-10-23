import crypto from 'node:crypto';
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

export const env = {
  root: ROOT,
  port: int('PORT', 4700),
  dataDir,
  projectsDir: path.join(dataDir, 'projects'),
  claudeConfigDir: path.resolve(str('CLAUDE_CONFIG_DIR', path.join(dataDir, 'claude'))),
  password: str('LEXIS_PASSWORD', ''),
  sessionSecret: str('SESSION_SECRET', ''),
  cookieSecure: str('COOKIE_SECURE', '0') === '1',
  debug: Boolean(process.env.LEXIS_DEBUG),
  models: {
    translation: translationModel,
    mechanical: mechanicalModel,
    orchestrator: str('LEXIS_ORCHESTRATOR_MODEL', mechanicalModel),
  },
  effort: {
    translation: effort('LEXIS_TRANSLATION_EFFORT', 'high'),
    mechanical: effort('LEXIS_MECHANICAL_EFFORT', 'medium'),
    orchestrator: effort('LEXIS_ORCHESTRATOR_EFFORT', 'medium'),
  },
};

export type Tier = 'translation' | 'mechanical';

export function ensureDirs(): void {
  for (const d of [env.dataDir, env.projectsDir, env.claudeConfigDir]) fs.mkdirSync(d, { recursive: true });
}

/**
 * SESSION_SECRET when set; otherwise a key made once and kept in the data
 * directory, so a container restart does not sign the browser out.
 */
let secretCache: string | null = null;
export function sessionSecret(): string {
  if (secretCache) return secretCache;
  if (env.sessionSecret) return (secretCache = env.sessionSecret);
  const file = path.join(env.dataDir, 'session-secret');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved.length >= 32) return (secretCache = saved);
  } catch {
    // not made yet
  }
  const fresh = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(env.dataDir, { recursive: true });
    fs.writeFileSync(file, fresh, { mode: 0o600 });
  } catch (err) {
    console.warn('[lexis] could not keep the session secret in the data directory; logins end at the next restart', err);
  }
  return (secretCache = fresh);
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
