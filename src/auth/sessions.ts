import crypto from 'node:crypto';
import type { AuthMethod, AuthStore, StoredSession } from './store.js';

/** A session ends after this long without use… */
export const IDLE_MS = 14 * 24 * 60 * 60 * 1000;
/** …and in any case this long after sign-in. */
export const ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
/** How recently a browser must have proved itself before adding or removing a passkey. */
export const STEP_UP_MS = 10 * 60 * 1000;
/** lastSeenAt is written at most this often, so reads don't rewrite the file. */
const TOUCH_MS = 60 * 1000;

const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/** Server-side sessions: the cookie carries a random token, the store only its hash. */
export class Sessions {
  constructor(private readonly store: AuthStore) {}

  create(method: AuthMethod, meta: { userAgent?: string; ip?: string }): { token: string; session: StoredSession } {
    this.prune();
    const token = crypto.randomBytes(32).toString('base64url');
    const now = new Date().toISOString();
    const session: StoredSession = {
      id: hash(token),
      method,
      createdAt: now,
      lastSeenAt: now,
      verifiedAt: now,
      userAgent: (meta.userAgent ?? '').slice(0, 300),
      ip: (meta.ip ?? '').slice(0, 100),
    };
    this.store.addSession(session);
    return { token, session };
  }

  /** The live session a cookie token names, or null. Expired sessions are dropped on sight. */
  resolve(token: string | undefined, now = Date.now()): StoredSession | null {
    if (!token || token.length > 200) return null;
    const id = hash(token);
    const s = this.store.sessions.find((x) => x.id === id);
    if (!s) return null;
    if (expired(s, now)) {
      this.store.removeSessions((x) => x.id === id);
      return null;
    }
    if (now - Date.parse(s.lastSeenAt) > TOUCH_MS) this.store.updateSession(id, { lastSeenAt: new Date(now).toISOString() });
    return s;
  }

  markVerified(id: string): void {
    this.store.updateSession(id, { verifiedAt: new Date().toISOString() });
  }

  isFresh(s: StoredSession, now = Date.now()): boolean {
    return now - Date.parse(s.verifiedAt) < STEP_UP_MS;
  }

  revoke(id: string): boolean {
    return this.store.removeSessions((s) => s.id === id) > 0;
  }

  revokeAllExcept(id: string | null): number {
    return this.store.removeSessions((s) => s.id !== id);
  }

  prune(now = Date.now()): void {
    this.store.removeSessions((s) => expired(s, now));
  }
}

function expired(s: StoredSession, now: number): boolean {
  return now - Date.parse(s.lastSeenAt) > IDLE_MS || now - Date.parse(s.createdAt) > ABSOLUTE_MS;
}
