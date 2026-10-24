import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** A registered passkey. The public key is stored base64url-encoded. */
export interface StoredPasskey {
  id: string;
  publicKey: string;
  counter: number;
  transports?: string[];
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  /** 'multiDevice' passkeys sync (iCloud Keychain, Google Password Manager…); 'singleDevice' ones live on one authenticator. */
  deviceType: string;
  backedUp: boolean;
}

export type AuthMethod = 'password' | 'passkey';

/** A signed-in browser. Only a hash of its cookie token is kept, so the file alone signs nobody in. */
export interface StoredSession {
  id: string;
  method: AuthMethod;
  createdAt: string;
  lastSeenAt: string;
  /** Last time this browser proved who it is (sign-in or step-up). Sensitive changes need it recent. */
  verifiedAt: string;
  userAgent: string;
  ip: string;
}

export interface AuthState {
  version: 1;
  /** The WebAuthn user handle for the one lexis user. */
  userId: string;
  passkeys: StoredPasskey[];
  sessions: StoredSession[];
}

/**
 * The sign-in state of the single lexis user, in one JSON file under
 * DATA_DIR/auth (mode 0600). Writes go to a temp file and are renamed into
 * place, so a crash never leaves a half-written file.
 */
export class AuthStore {
  private _state: AuthState;
  private mtimeMs = 0;

  constructor(readonly file: string) {
    this._state = this.load();
  }

  /** The current state, re-read when another process (the recovery CLI) changed the file. */
  private get state(): AuthState {
    if (this.statMtime() !== this.mtimeMs) this._state = this.load();
    return this._state;
  }

  private statMtime(): number {
    try {
      return fs.statSync(this.file).mtimeMs;
    } catch {
      return 0;
    }
  }

  private load(): AuthState {
    this.mtimeMs = this.statMtime();
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<AuthState>;
      return {
        version: 1,
        userId: typeof raw.userId === 'string' && raw.userId ? raw.userId : newUserId(),
        passkeys: Array.isArray(raw.passkeys) ? raw.passkeys : [],
        sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        // A corrupt file must not silently reopen password sign-in: refuse to start.
        throw new Error(`cannot read ${this.file}: ${(e as Error).message}`);
      }
      return { version: 1, userId: newUserId(), passkeys: [], sessions: [] };
    }
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(this._state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.mtimeMs = this.statMtime();
  }

  get userId(): string {
    return this.state.userId;
  }

  get passkeys(): readonly StoredPasskey[] {
    return this.state.passkeys;
  }

  get sessions(): readonly StoredSession[] {
    return this.state.sessions;
  }

  addPasskey(p: StoredPasskey): void {
    this.state.passkeys.push(p);
    this.save();
  }

  updatePasskey(id: string, patch: Partial<Pick<StoredPasskey, 'counter' | 'lastUsedAt' | 'name' | 'backedUp'>>): void {
    const p = this.state.passkeys.find((x) => x.id === id);
    if (!p) return;
    Object.assign(p, patch);
    this.save();
  }

  removePasskey(id: string): boolean {
    const before = this.state.passkeys.length;
    this._state.passkeys = this.state.passkeys.filter((p) => p.id !== id);
    if (this.state.passkeys.length === before) return false;
    this.save();
    return true;
  }

  addSession(s: StoredSession): void {
    this.state.sessions.push(s);
    this.save();
  }

  updateSession(id: string, patch: Partial<StoredSession>, persist = true): void {
    const s = this.state.sessions.find((x) => x.id === id);
    if (!s) return;
    Object.assign(s, patch);
    if (persist) this.save();
  }

  /** Remove the sessions `drop` selects; returns how many went. */
  removeSessions(drop: (s: StoredSession) => boolean): number {
    const before = this.state.sessions.length;
    this._state.sessions = this.state.sessions.filter((s) => !drop(s));
    const removed = before - this.state.sessions.length;
    if (removed) this.save();
    return removed;
  }

  /** Recovery: forget every passkey and session (e.g. after a device with a passkey is lost). */
  reset(): void {
    this._state = { ...this.state, passkeys: [], sessions: [] };
    this.save();
  }
}

function newUserId(): string {
  return crypto.randomBytes(32).toString('base64url');
}
