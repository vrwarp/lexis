/**
 * The Claude Code runtime the Agent SDK drives, and signing it in with a
 * Claude subscription from the browser (ported from knifes' GM console).
 *
 * `claude auth login` drives cleanly over pipes: it prints a URL, waits at a
 * "paste code" prompt, and exits 0 once the pasted code is accepted. The user
 * opens the link, approves on Claude's site, and pastes the code back; nobody
 * needs a shell in the container. The app password already gates who can do
 * this.
 *
 * Each attempt signs in against a staging directory and only a successful one
 * replaces the credentials the SDK reads, so a failed or abandoned attempt
 * never breaks a working login.
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { detectCredential, env } from './env.js';
import { sdk } from './sdk.js';

const LOGIN_TIMEOUT_MS = 10 * 60_000;
const URL_TIMEOUT_MS = 60_000;
const CODE_TIMEOUT_MS = 2 * 60_000;

/**
 * The Claude Code binary the SDK ships in a per-platform optional package.
 * Resolved explicitly so the same file serves the SDK, the auth probe, and
 * `claude auth login` inside the container.
 */
export function findClaudeBinary(): string | null {
  if (process.env.CLAUDE_BINARY) return process.env.CLAUDE_BINARY;
  const require = createRequire(import.meta.url);
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const candidates =
    process.platform === 'darwin'
      ? [`darwin-${arch}`]
      : process.platform === 'win32'
        ? [`win32-${arch}`]
        : [`linux-${arch}`, `linux-${arch}-musl`];
  for (const platform of candidates) {
    try {
      const manifest = require.resolve(`@anthropic-ai/claude-agent-sdk-${platform}/package.json`);
      return path.join(path.dirname(manifest), process.platform === 'win32' ? 'claude.exe' : 'claude');
    } catch {
      continue;
    }
  }
  return null;
}

/** The environment every Claude Code process this app starts runs with. */
export function claudeEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    CLAUDE_CONFIG_DIR: env.claudeConfigDir,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_AGENT_SDK_CLIENT_APP: 'lexis/0.2.0',
  };
}

export type AuthState = 'ok' | 'needs_login' | 'unknown';
let authCache: { at: number; state: AuthState } | null = null;

/** Whether Claude Code has a usable credential. Spawns `claude auth status` for a login file, so cached for a minute. */
export async function probeAuth(force = false): Promise<AuthState> {
  if (!force && authCache && Date.now() - authCache.at < 60_000) return authCache.state;
  const source = detectCredential();
  let state: AuthState;
  if (source === 'none') state = 'needs_login';
  else if (source !== 'login') state = 'ok';
  else {
    const binary = findClaudeBinary();
    if (!binary) state = 'unknown';
    else {
      state = await new Promise<AuthState>((resolve) => {
        execFile(binary, ['auth', 'status'], { timeout: 15_000, env: claudeEnv() }, (err) => {
          if (!err) return resolve('ok');
          const code = (err as { code?: number | string }).code;
          if (code === 1) return resolve('needs_login');
          console.error('[lexis] claude auth status failed', code, err.message);
          resolve('unknown');
        });
      });
    }
  }
  authCache = { at: Date.now(), state };
  return state;
}

export interface Account {
  email?: string;
  organization?: string;
  subscriptionType?: string;
}

/** Ask Claude Code which account it is signed in as. Costs no tokens. */
export async function readAccount(): Promise<Account | null> {
  const binary = findClaudeBinary();
  const idle = (async function* () {
    await new Promise(() => {});
    yield undefined as never;
  })();
  const q = sdk.query({
    prompt: idle as never,
    options: {
      tools: [],
      settingSources: [],
      cwd: env.dataDir,
      ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
      env: claudeEnv(),
    },
  }, { tools: [] });
  try {
    const init = await Promise.race([
      q.initializationResult(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), 30_000)),
    ]);
    const a = (init as { account?: Account }).account;
    return a ? { email: a.email, organization: a.organization, subscriptionType: a.subscriptionType } : null;
  } catch {
    return null;
  } finally {
    await q.return(undefined as never).catch(() => undefined);
  }
}

/** Environment-supplied credentials outrank a login file, so a web sign-in would be ignored. */
export function envCredentialShadowsLogin(): boolean {
  const source = detectCredential();
  return source === 'auth_token' || source === 'api_key' || source === 'oauth_token';
}

export interface LoginResult {
  ok: boolean;
  error?: string;
  account?: Account | null;
}

export class LoginError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

interface Pending {
  id: string;
  url: string;
  child: ChildProcessWithoutNullStreams;
  dir: string;
  stderr: string;
  timer: NodeJS.Timeout;
  done: Promise<{ code: number | null }>;
  codeSent: boolean;
}

const credentialsFile = (dir: string) => path.join(dir, '.credentials.json');

export class ClaudeLogin {
  private pending: Pending | null = null;

  get inProgress(): { id: string; url: string } | null {
    return this.pending ? { id: this.pending.id, url: this.pending.url } : null;
  }

  /** Start a sign-in and return the link to open. Replaces any half-finished one. */
  async start(): Promise<{ id: string; url: string }> {
    const binary = findClaudeBinary();
    if (!binary) throw new LoginError('Claude Code is not installed here.', 500);
    this.cancel();

    const id = randomUUID();
    const dir = path.join(env.dataDir, 'claude-login', id);
    fs.mkdirSync(dir, { recursive: true });
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CLAUDE_CONFIG_DIR: dir,
      // Nothing to open in a container: the CLI prints the URL instead.
      BROWSER: '/bin/true',
    };
    // An ambient credential would make the CLI skip the flow being driven here.
    delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;
    delete childEnv.ANTHROPIC_API_KEY;
    delete childEnv.ANTHROPIC_AUTH_TOKEN;

    const child = spawn(binary, ['auth', 'login', '--claudeai'], { env: childEnv });
    const entry: Pending = {
      id,
      url: '',
      child,
      dir,
      stderr: '',
      codeSent: false,
      timer: setTimeout(() => this.cancel(id), LOGIN_TIMEOUT_MS),
      done: new Promise((resolve) => child.once('exit', (code) => resolve({ code }))),
    };
    this.pending = entry;
    child.stderr.on('data', (d: Buffer) => (entry.stderr += d.toString()));

    try {
      entry.url = await new Promise<string>((resolve, reject) => {
        let out = '';
        const deadline = setTimeout(() => reject(new Error('Claude Code did not offer a sign-in link.')), URL_TIMEOUT_MS);
        child.stdout.on('data', (d: Buffer) => {
          out += d.toString();
          const m = /https:\/\/\S+/.exec(out);
          if (m) {
            clearTimeout(deadline);
            resolve(m[0].replace(/[.,)]+$/, ''));
          }
        });
        child.once('error', (e) => {
          clearTimeout(deadline);
          reject(e);
        });
        child.once('exit', (code) => {
          clearTimeout(deadline);
          reject(new Error(entry.stderr.trim() || `Claude Code exited (${code}) before offering a link.`));
        });
      });
    } catch (e) {
      this.cancel(id);
      throw new LoginError(e instanceof Error ? e.message : String(e), 502);
    }
    console.log('[lexis] Claude sign-in started');
    return { id, url: entry.url };
  }

  /** Hand the pasted code to the waiting CLI; on success, make the new login the one the SDK uses. */
  async submit(id: string, code: string): Promise<LoginResult> {
    const entry = this.pending;
    if (!entry || entry.id !== id) return { ok: false, error: 'That sign-in has expired. Start again.' };
    if (entry.codeSent) return { ok: false, error: 'That code was already used. Start again.' };
    const clean = code.trim();
    if (!clean) return { ok: false, error: 'Paste the code Claude showed you.' };
    entry.codeSent = true;
    entry.child.stdin.write(`${clean}\n`);

    const outcome = await Promise.race([
      entry.done,
      new Promise<{ code: null; timedOut: true }>((r) => setTimeout(() => r({ code: null, timedOut: true }), CODE_TIMEOUT_MS)),
    ]);
    if (outcome.code !== 0 || !fs.existsSync(credentialsFile(entry.dir))) {
      const failure = /Login failed:?\s*(.*)/i.exec(entry.stderr)?.[1]?.trim();
      this.cancel(id);
      return {
        ok: false,
        error:
          'timedOut' in outcome
            ? 'Claude did not answer in time. Start again.'
            : failure || 'The code was not accepted. Start again and copy the newest code.',
      };
    }

    // Promote the staged credentials atomically into the directory the SDK reads.
    fs.mkdirSync(env.claudeConfigDir, { recursive: true });
    const target = credentialsFile(env.claudeConfigDir);
    const tmp = `${target}.${id}`;
    fs.writeFileSync(tmp, fs.readFileSync(credentialsFile(entry.dir)), { mode: 0o600 });
    fs.renameSync(tmp, target);
    this.cleanup(entry);
    await probeAuth(true);
    console.log('[lexis] Claude sign-in completed');
    return { ok: true, account: await readAccount() };
  }

  cancel(id?: string): void {
    const entry = this.pending;
    if (!entry || (id && entry.id !== id)) return;
    entry.child.kill('SIGKILL');
    this.cleanup(entry);
  }

  /** Remove the login file. Credentials supplied through the environment are untouched. */
  async signOut(): Promise<void> {
    this.cancel();
    fs.rmSync(credentialsFile(env.claudeConfigDir), { force: true });
    await probeAuth(true);
  }

  private cleanup(entry: Pending): void {
    clearTimeout(entry.timer);
    if (this.pending === entry) this.pending = null;
    fs.rmSync(entry.dir, { recursive: true, force: true });
  }
}
