import crypto from 'node:crypto';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { env } from '../env.js';
import { FailureLimiter } from './limiter.js';
import { PasskeyError, Passkeys, type RelyingParty } from './passkeys.js';
import { Sessions } from './sessions.js';
import { AuthStore, type StoredSession } from './store.js';

/** `__Host-` pins the cookie to this exact host over https; plain http (local use) cannot carry the prefix. */
export const SESSION_COOKIE = env.cookieSecure ? '__Host-lexis' : 'lexis_session';
const COOKIE_SECONDS = 30 * 24 * 60 * 60;

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    let v = part.slice(i + 1).trim();
    try {
      v = decodeURIComponent(v);
    } catch {
      // another app on the host may set a cookie that is not URI-encoded
    }
    if (k) out[k] = v;
  }
  return out;
}

export function sessionCookie(token: string, maxAgeSec = COOKIE_SECONDS): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${env.cookieSecure ? '; Secure' : ''}`;
}

function safeEqual(a: string, b: string): boolean {
  // Compare digests so neither the length nor the content leaks through timing.
  const da = crypto.createHash('sha256').update(a).digest();
  const db = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(da, db);
}

/**
 * The origin the browser is on, as far as this server is concerned: the
 * configured public URL, or else the request's own host. A request whose
 * Origin header names any other site is refused before it reaches a route.
 */
export function expectedOrigin(req: Request): string | null {
  if (env.publicUrl) return env.publicUrl;
  const host = req.get('host');
  if (!host) return null;
  const origin = req.get('origin');
  // Behind a TLS-terminating proxy without trust proxy, req.protocol says http while the
  // browser is on https: accept the browser's scheme as long as the host is ours.
  if (origin) {
    try {
      const u = new URL(origin);
      if (u.host === host) return u.origin;
    } catch {
      return null;
    }
  }
  return `${req.protocol}://${host}`;
}

export function relyingParty(req: Request): RelyingParty | null {
  const origin = expectedOrigin(req);
  if (!origin) return null;
  return { origin, rpID: new URL(origin).hostname };
}

/** Refuse cross-site writes (and WebSocket upgrades): the Origin must be this site when a browser sends one. */
export function originAllowed(originHeader: string | undefined, req: Request | { headers: Record<string, string | string[] | undefined> }): boolean {
  if (!originHeader) return true; // not a browser cross-site request: browsers always send Origin on those
  let origin: URL;
  try {
    origin = new URL(originHeader);
  } catch {
    return false;
  }
  if (env.publicUrl) return origin.origin === new URL(env.publicUrl).origin;
  const host = req.headers.host;
  return typeof host === 'string' && origin.host === host;
}

/** Security headers for every response. The UI is same-origin only; nothing may frame it. */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      // The UI sets a few style attributes (progress bars) through innerHTML.
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "frame-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  if (env.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

type Authed = Response<unknown, { session: StoredSession }>;

/**
 * Sign-in for the single lexis user. Passkeys are the primary way in; the
 * password always works too, as the backup (and to set up the first passkey),
 * behind per-address and overall attempt limits.
 */
export class Auth {
  readonly store: AuthStore;
  readonly sessions: Sessions;
  readonly passkeys: Passkeys;
  /** Password guesses: 5 per address and 20 overall per 15 minutes. */
  private perClient = new FailureLimiter(5, 15 * 60 * 1000);
  private overall = new FailureLimiter(20, 15 * 60 * 1000);
  /** Failed passkey sign-ins are cheap to make too; cap them per address. */
  private passkeyFailures = new FailureLimiter(20, 15 * 60 * 1000);

  constructor() {
    this.store = new AuthStore(path.join(env.authDir, 'auth.json'));
    this.sessions = new Sessions(this.store);
    this.passkeys = new Passkeys(this.store);
  }

  /** The session behind a request's cookie, if it is live. */
  session(cookieHeader: string | undefined): StoredSession | null {
    return this.sessions.resolve(parseCookies(cookieHeader)[SESSION_COOKIE]);
  }

  /** Route guard: a live session or 401. */
  readonly require = (req: Request, res: Response, next: NextFunction): void => {
    const s = this.session(req.headers.cookie);
    if (!s) {
      res.status(401).json({ error: 'sign-in required' });
      return;
    }
    res.locals.session = s;
    next();
  };

  /** Route guard for changes to how you sign in: the browser must have proved itself in the last 10 minutes. */
  private readonly requireFresh = (_req: Request, res: Authed, next: NextFunction): void => {
    if (!this.sessions.isFresh(res.locals.session)) {
      res.status(403).json({ error: 'Confirm it is you first.', stepUp: this.passkeys.count ? 'passkey' : 'password' });
      return;
    }
    next();
  };

  private signIn(req: Request, res: Response, method: 'password' | 'passkey'): void {
    const { token } = this.sessions.create(method, { userAgent: req.get('user-agent'), ip: req.ip });
    res.setHeader('Set-Cookie', sessionCookie(token));
  }

  /** Check the password with rate limits; answers the request itself on failure. */
  private checkPassword(req: Request, res: Response): boolean {
    const client = `ip:${req.ip ?? '?'}`;
    const wait = Math.max(this.perClient.retryAfter(client), this.overall.retryAfter('all'));
    if (wait) {
      res.setHeader('Retry-After', String(wait));
      res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.` });
      return false;
    }
    const given = (req.body as { password?: unknown } | undefined)?.password;
    if (typeof given !== 'string' || !env.password || !safeEqual(given.slice(0, 1000), env.password)) {
      this.perClient.fail(client);
      this.overall.fail('all');
      res.status(401).json({ error: 'Wrong password' });
      return false;
    }
    this.perClient.clear(client);
    return true;
  }

  private rp(req: Request, res: Response): RelyingParty | null {
    const rp = relyingParty(req);
    if (!rp) res.status(400).json({ error: 'Cannot tell which site this is. Set LEXIS_PUBLIC_URL.' });
    return rp;
  }

  router(): express.Router {
    const r = express.Router();
    const body = (req: Request) => (req.body ?? {}) as Record<string, unknown>;
    const passkeyFail = (req: Request, res: Response, e: unknown) => {
      if (!(e instanceof PasskeyError)) throw e;
      this.passkeyFailures.fail(`ip:${req.ip ?? '?'}`);
      res.status(400).json({ error: e.message });
    };

    // ---------- signed out ----------

    r.get('/state', (req, res) => {
      res.json({
        signedIn: Boolean(this.session(req.headers.cookie)),
        passwordSet: Boolean(env.password),
        passkeys: this.passkeys.count > 0,
      });
    });

    r.post('/password', (req, res) => {
      if (!env.password) {
        res.status(503).json({ error: 'LEXIS_PASSWORD is not set on the server.' });
        return;
      }
      if (!this.checkPassword(req, res)) return;
      this.signIn(req, res, 'password');
      res.json({ ok: true, passkeys: this.passkeys.count });
    });

    r.post('/passkey/options', async (req, res) => {
      const wait = this.passkeyFailures.retryAfter(`ip:${req.ip ?? '?'}`);
      if (wait) {
        res.setHeader('Retry-After', String(wait));
        res.status(429).json({ error: 'Too many attempts. Try again later.' });
        return;
      }
      if (!this.passkeys.count) {
        res.status(404).json({ error: 'No passkey is set up yet. Sign in with the password.' });
        return;
      }
      const rp = this.rp(req, res);
      if (rp) res.json(await this.passkeys.authenticationOptions(rp));
    });

    r.post('/passkey/verify', async (req, res) => {
      try {
        await this.passkeys.authenticate(String(body(req).challengeId ?? ''), body(req).response as never);
      } catch (e) {
        return passkeyFail(req, res, e);
      }
      this.signIn(req, res, 'passkey');
      res.json({ ok: true });
    });

    r.post('/logout', (req, res) => {
      const s = this.session(req.headers.cookie);
      if (s) this.sessions.revoke(s.id);
      res.setHeader('Set-Cookie', sessionCookie('', 0));
      res.json({ ok: true });
    });

    // ---------- signed in ----------

    r.use(this.require);

    r.get('/security', (_req, res: Authed) => {
      const current = res.locals.session;
      res.json({
        passwordSet: Boolean(env.password),
        fresh: this.sessions.isFresh(current),
        passkeys: this.store.passkeys.map(({ id, name, createdAt, lastUsedAt, deviceType, backedUp }) => ({ id, name, createdAt, lastUsedAt, deviceType, backedUp })),
        sessions: [...this.store.sessions]
          .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
          .map((s) => ({ id: s.id.slice(0, 16), method: s.method, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, userAgent: s.userAgent, ip: s.ip, current: s.id === current.id })),
      });
    });

    // Step-up: prove it is you again before changing how you sign in (a passkey, or the password as backup).
    r.post('/stepup/password', (req, res: Authed) => {
      if (!env.password) {
        res.status(503).json({ error: 'LEXIS_PASSWORD is not set on the server.' });
        return;
      }
      if (!this.checkPassword(req, res)) return;
      this.sessions.markVerified(res.locals.session.id);
      res.json({ ok: true });
    });
    r.post('/stepup/passkey/options', async (req, res: Authed) => {
      const rp = this.rp(req, res);
      if (rp) res.json(await this.passkeys.authenticationOptions(rp, res.locals.session.id));
    });
    r.post('/stepup/passkey/verify', async (req, res: Authed) => {
      try {
        await this.passkeys.authenticate(String(body(req).challengeId ?? ''), body(req).response as never, res.locals.session.id);
      } catch (e) {
        return passkeyFail(req, res, e);
      }
      this.sessions.markVerified(res.locals.session.id);
      res.json({ ok: true });
    });

    r.post('/passkeys/options', this.requireFresh, async (req, res: Authed) => {
      const rp = this.rp(req, res);
      if (rp) res.json(await this.passkeys.registrationOptions(rp, res.locals.session.id));
    });
    r.post('/passkeys/verify', this.requireFresh, async (req, res: Authed) => {
      let passkey;
      try {
        passkey = await this.passkeys.register(String(body(req).challengeId ?? ''), body(req).response as never, res.locals.session.id, String(body(req).name ?? ''));
      } catch (e) {
        if (e instanceof PasskeyError) return void res.status(400).json({ error: e.message });
        throw e;
      }
      res.json({ ok: true, passkey: { id: passkey.id, name: passkey.name } });
    });
    r.post('/passkeys/:id/rename', (req, res) => {
      if (!this.passkeys.rename(String(req.params.id), String(body(req).name ?? ''))) {
        res.status(400).json({ error: 'Unknown passkey or empty name.' });
        return;
      }
      res.json({ ok: true });
    });
    r.delete('/passkeys/:id', this.requireFresh, (req, res) => {
      if (!this.passkeys.remove(String(req.params.id))) {
        res.status(404).json({ error: 'Unknown passkey.' });
        return;
      }
      res.json({ ok: true, remaining: this.passkeys.count });
    });

    r.delete('/sessions/:id', (req, res: Authed) => {
      const prefix = String(req.params.id);
      const target = this.store.sessions.find((s) => s.id.slice(0, 16) === prefix);
      if (!target || prefix.length !== 16) {
        res.status(404).json({ error: 'Unknown session.' });
        return;
      }
      this.sessions.revoke(target.id);
      if (target.id === res.locals.session.id) res.setHeader('Set-Cookie', sessionCookie('', 0));
      res.json({ ok: true });
    });
    r.post('/sessions/revoke-others', (_req, res: Authed) => {
      res.json({ ok: true, signedOut: this.sessions.revokeAllExcept(res.locals.session.id) });
    });

    return r;
  }
}
