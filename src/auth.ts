import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env, sessionSecret } from './env.js';

/**
 * A single-user password gate. The app runs agents with full tool access in
 * its container and holds a Claude login, so nothing but /login, /healthz and
 * the login page itself is reachable without the signed cookie.
 */
export const AUTH_COOKIE = 'lexis_auth';
/** A month, renewed at most daily while the app is in use. */
export const LOGIN_SECONDS = 60 * 60 * 24 * 30;
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

function sign(value: string): string {
  return crypto.createHmac('sha256', sessionSecret()).update(value).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

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

export function cookieHeader(value: string, maxAgeSec: number): string {
  return `${AUTH_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${env.cookieSecure ? '; Secure' : ''}`;
}

export function checkPassword(given: string): boolean {
  return Boolean(env.password) && safeEqual(given, env.password);
}

export function makeToken(): string {
  const ts = Date.now().toString(36);
  return `${ts}.${sign(`lexis:${ts}`)}`;
}

export function verifyToken(token: string | undefined): boolean {
  if (!token) return false;
  const i = token.lastIndexOf('.');
  if (i <= 0) return false;
  const ts = parseInt(token.slice(0, i), 36);
  if (!Number.isFinite(ts) || Date.now() - ts > LOGIN_SECONDS * 1000) return false;
  return safeEqual(token.slice(i + 1), sign(`lexis:${token.slice(0, i)}`));
}

export function isSignedIn(cookieHeaderValue: string | undefined): boolean {
  return verifyToken(parseCookies(cookieHeaderValue)[AUTH_COOKIE]);
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = parseCookies(req.headers.cookie)[AUTH_COOKIE];
  if (!verifyToken(token)) {
    res.status(401).json({ error: 'sign-in required' });
    return;
  }
  // Renew on a read at most once a day, never on every request: a reply still
  // in flight after Sign out would otherwise sign the browser straight back in.
  const issued = parseInt(token!.slice(0, token!.lastIndexOf('.')), 36);
  if (req.method === 'GET' && Date.now() - issued > RENEW_AFTER_MS) {
    res.setHeader('Set-Cookie', cookieHeader(makeToken(), LOGIN_SECONDS));
  }
  next();
}
