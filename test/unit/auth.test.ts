import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { freshEnv, restoreEnv } from '../support/boot.js';
import { SoftAuthenticator } from '../support/authenticator.js';

afterEach(restoreEnv);

async function load(vars: Record<string, string | undefined> = {}) {
  const dataDir = freshEnv(vars);
  const { AuthStore } = await import('../../src/auth/store.js');
  const { Sessions, IDLE_MS, ABSOLUTE_MS, STEP_UP_MS } = await import('../../src/auth/sessions.js');
  const { Passkeys, PasskeyError } = await import('../../src/auth/passkeys.js');
  const { FailureLimiter } = await import('../../src/auth/limiter.js');
  const file = path.join(dataDir, 'auth', 'auth.json');
  const store = new AuthStore(file);
  return { dataDir, file, store, sessions: new Sessions(store), passkeys: new Passkeys(store), AuthStore, PasskeyError, FailureLimiter, IDLE_MS, ABSOLUTE_MS, STEP_UP_MS };
}

const RP = { origin: 'https://lexis.example.com', rpID: 'lexis.example.com' };
const DAY = 24 * 60 * 60 * 1000;

describe('AuthStore', () => {
  it('starts empty, writes the file 0600 atomically, and survives a reload', async () => {
    const { store, file, AuthStore } = await load();
    expect(store.passkeys).toEqual([]);
    store.addSession({ id: 'a', method: 'password', createdAt: 'x', lastSeenAt: 'x', verifiedAt: 'x', userAgent: '', ip: '' });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['auth.json']);
    const again = new AuthStore(file);
    expect(again.userId).toBe(store.userId);
    expect(again.sessions.map((s) => s.id)).toEqual(['a']);
  });

  it('refuses to start on a corrupt file rather than silently forgetting passkeys', async () => {
    const { file, AuthStore } = await load();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{broken');
    expect(() => new AuthStore(file)).toThrow(/cannot read/);
  });

  it('picks up changes another process (the recovery CLI) wrote', async () => {
    const { store, file, AuthStore } = await load();
    store.addSession({ id: 'a', method: 'password', createdAt: 'x', lastSeenAt: 'x', verifiedAt: 'x', userAgent: '', ip: '' });
    await new Promise((r) => setTimeout(r, 15));
    new AuthStore(file).reset();
    expect(store.sessions).toEqual([]);
  });
});

describe('Sessions', () => {
  it('stores only a hash of the cookie token and resolves it back', async () => {
    const { sessions, file } = await load();
    const { token, session } = sessions.create('password', { userAgent: 'UA', ip: '1.2.3.4' });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fs.readFileSync(file, 'utf8')).not.toContain(token);
    expect(sessions.resolve(token)?.id).toBe(session.id);
    expect(sessions.resolve('nope')).toBeNull();
    expect(sessions.resolve(undefined)).toBeNull();
    expect(sessions.resolve('x'.repeat(500))).toBeNull();
  });

  it('expires a session when idle too long or past its absolute lifetime', async () => {
    const { sessions, store, IDLE_MS, ABSOLUTE_MS } = await load();
    const a = sessions.create('passkey', {});
    expect(sessions.resolve(a.token, Date.now() + IDLE_MS + 1000)).toBeNull();
    expect(store.sessions).toHaveLength(0);

    const b = sessions.create('passkey', {});
    // Used every 10 days, it stays alive until the absolute limit.
    for (let t = 10 * DAY; t < ABSOLUTE_MS; t += 10 * DAY) expect(sessions.resolve(b.token, Date.now() + t)).not.toBeNull();
    expect(sessions.resolve(b.token, Date.now() + ABSOLUTE_MS + 1000)).toBeNull();
  });

  it('tracks how recently the browser proved itself', async () => {
    const { sessions, STEP_UP_MS } = await load();
    const { session } = sessions.create('password', {});
    expect(sessions.isFresh(session)).toBe(true);
    expect(sessions.isFresh(session, Date.now() + STEP_UP_MS + 1)).toBe(false);
  });

  it('revokes one, or all but one', async () => {
    const { sessions, store } = await load();
    const a = sessions.create('password', {});
    const b = sessions.create('passkey', {});
    sessions.create('passkey', {});
    expect(sessions.revoke(a.session.id)).toBe(true);
    expect(sessions.revoke(a.session.id)).toBe(false);
    expect(sessions.revokeAllExcept(b.session.id)).toBe(1);
    expect(store.sessions.map((s) => s.id)).toEqual([b.session.id]);
  });
});

describe('FailureLimiter', () => {
  it('blocks after max failures within the window and frees up after it', async () => {
    const { FailureLimiter } = await load();
    const l = new FailureLimiter(3, 60_000);
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) {
      expect(l.retryAfter('k', t)).toBe(0);
      l.fail('k', t + i);
    }
    expect(l.retryAfter('k', t + 10)).toBe(60);
    expect(l.retryAfter('other', t + 10)).toBe(0);
    expect(l.retryAfter('k', t + 59_999)).toBe(1); // all three still inside the window
    expect(l.retryAfter('k', t + 60_000)).toBe(0); // the first one has aged out
    l.fail('k', t);
    l.clear('k');
    expect(l.retryAfter('k', t)).toBe(0);
  });
});

describe('Passkeys', () => {
  async function registered() {
    const ctx = await load();
    const { sessions, passkeys } = ctx;
    const { session } = sessions.create('password', {});
    const device = new SoftAuthenticator(RP.origin);
    const { challengeId, options } = await passkeys.registrationOptions(RP, session.id);
    const pk = await passkeys.register(challengeId, device.create(options) as never, session.id, ' My  Laptop\u0007 ');
    return { ...ctx, session, device, pk };
  }

  it('asks for a discoverable, user-verified passkey bound to this site and user', async () => {
    const { passkeys, sessions, store } = await load();
    const { session } = sessions.create('password', {});
    const { options } = await passkeys.registrationOptions(RP, session.id);
    expect(options.rp).toEqual({ name: 'lexis', id: 'lexis.example.com' });
    expect(options.user.id).toBe(store.userId);
    expect(options.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
    expect(options.attestation).toBe('none');
  });

  it('registers a passkey and stores its public key, not a secret', async () => {
    const { store, pk, device } = await registered();
    expect(pk).toMatchObject({ id: device.id, name: 'My  Laptop', deviceType: 'multiDevice', backedUp: true, counter: 0 });
    expect(store.passkeys).toHaveLength(1);
  });

  it('signs in with the passkey, advancing the counter', async () => {
    const { passkeys, device, store } = await registered();
    const { challengeId, options } = await passkeys.authenticationOptions(RP);
    expect(options.allowCredentials).toEqual([]);
    expect(options.userVerification).toBe('required');
    const used = await passkeys.authenticate(challengeId, device.get(options) as never);
    expect(used.id).toBe(device.id);
    expect(store.passkeys[0].counter).toBe(1);
    expect(store.passkeys[0].lastUsedAt).toBeTruthy();
  });

  it('rejects a reused, unknown, expired or other-session challenge', async () => {
    const { passkeys, device, PasskeyError, session } = await registered();
    const { challengeId, options } = await passkeys.authenticationOptions(RP);
    await passkeys.authenticate(challengeId, device.get(options) as never);
    await expect(passkeys.authenticate(challengeId, device.get(options) as never)).rejects.toBeInstanceOf(PasskeyError);
    await expect(passkeys.authenticate('made-up', device.get(options) as never)).rejects.toThrow(/expired/);
    const stepUp = await passkeys.authenticationOptions(RP, session.id);
    await expect(passkeys.authenticate(stepUp.challengeId, device.get(stepUp.options) as never, 'another-session')).rejects.toThrow(/expired/);
  });

  it('rejects an assertion for another origin, another challenge, or without user verification', async () => {
    const { passkeys, device } = await registered();
    const a = await passkeys.authenticationOptions(RP);
    await expect(passkeys.authenticate(a.challengeId, device.get(a.options, { origin: 'https://evil.example' }) as never)).rejects.toThrow(/could not be verified/);
    const b = await passkeys.authenticationOptions(RP);
    await expect(passkeys.authenticate(b.challengeId, device.get(b.options, { challenge: 'AAAA' }) as never)).rejects.toThrow(/could not be verified/);
    const c = await passkeys.authenticationOptions(RP);
    await expect(passkeys.authenticate(c.challengeId, device.get(c.options, { rpId: 'evil.example' }) as never)).rejects.toThrow(/could not be verified/);
    device.userVerified = false;
    const d = await passkeys.authenticationOptions(RP);
    await expect(passkeys.authenticate(d.challengeId, device.get(d.options) as never)).rejects.toThrow(/could not be verified/);
  });

  it('rejects a cloned authenticator whose counter went backwards', async () => {
    const { passkeys, device } = await registered();
    const a = await passkeys.authenticationOptions(RP);
    await passkeys.authenticate(a.challengeId, device.get(a.options, { counter: 5 }) as never);
    const b = await passkeys.authenticationOptions(RP);
    await expect(passkeys.authenticate(b.challengeId, device.get(b.options, { counter: 3 }) as never)).rejects.toThrow(/could not be verified/);
  });

  it('rejects a passkey it does not know', async () => {
    const { passkeys } = await registered();
    const stranger = new SoftAuthenticator(RP.origin);
    const reg = await passkeys.authenticationOptions(RP);
    stranger.create({ challenge: 'x', rp: { id: RP.rpID }, user: { id: 'someone' } });
    await expect(passkeys.authenticate(reg.challengeId, stranger.get(reg.options) as never)).rejects.toThrow(/not registered/);
  });

  it('refuses registration without user verification or from another origin', async () => {
    const { passkeys, sessions } = await load();
    const { session } = sessions.create('password', {});
    const device = new SoftAuthenticator(RP.origin);
    device.userVerified = false;
    const a = await passkeys.registrationOptions(RP, session.id);
    await expect(passkeys.register(a.challengeId, device.create(a.options) as never, session.id, '')).rejects.toThrow(/could not be verified/);
    device.userVerified = true;
    const b = await passkeys.registrationOptions(RP, session.id);
    await expect(passkeys.register(b.challengeId, device.create(b.options, { origin: 'https://evil.example' }) as never, session.id, '')).rejects.toThrow(/could not be verified/);
    expect(passkeys.count).toBe(0);
  });

  it('will not register the same passkey twice, and excludes known ones', async () => {
    const { passkeys, session, device } = await registered();
    const again = await passkeys.registrationOptions(RP, session.id);
    expect(again.options.excludeCredentials?.map((c) => c.id)).toEqual([device.id]);
    await expect(passkeys.register(again.challengeId, device.create(again.options) as never, session.id, '')).rejects.toThrow(/already registered/);
  });

  it('names, renames and removes passkeys', async () => {
    const { passkeys, store, pk, session } = await registered();
    const second = new SoftAuthenticator(RP.origin);
    const o = await passkeys.registrationOptions(RP, session.id);
    expect((await passkeys.register(o.challengeId, second.create(o.options) as never, session.id, '')).name).toBe('Synced passkey 2');
    expect(passkeys.rename(pk.id, '  Phone ')).toBe(true);
    expect(passkeys.rename(pk.id, '   ')).toBe(false);
    expect(passkeys.rename('nope', 'x')).toBe(false);
    expect(store.passkeys[0].name).toBe('Phone');
    expect(passkeys.remove(pk.id)).toBe(true);
    expect(passkeys.remove(pk.id)).toBe(false);
    expect(passkeys.count).toBe(1);
  });
});

describe('http helpers', () => {
  const fakeReq = (headers: Record<string, string>, protocol = 'http') =>
    ({ headers, protocol, get: (h: string) => headers[h.toLowerCase()] }) as never;

  it('accepts same-origin and Origin-less requests, refuses other sites', async () => {
    await load();
    const { originAllowed } = await import('../../src/auth/http.js');
    const req = fakeReq({ host: 'lexis.example.com' });
    expect(originAllowed(undefined, req)).toBe(true);
    expect(originAllowed('https://lexis.example.com', req)).toBe(true);
    expect(originAllowed('https://evil.example', req)).toBe(false);
    expect(originAllowed('https://lexis.example.com.evil.example', req)).toBe(false);
    expect(originAllowed('null', req)).toBe(false);
  });

  it('pins the origin to LEXIS_PUBLIC_URL when set', async () => {
    await load({ LEXIS_PUBLIC_URL: 'https://books.example.org/' });
    const { originAllowed, relyingParty } = await import('../../src/auth/http.js');
    const req = fakeReq({ host: 'books.example.org', origin: 'http://books.example.org' });
    expect(originAllowed('https://books.example.org', req)).toBe(true);
    expect(originAllowed('http://books.example.org', req)).toBe(false);
    expect(relyingParty(req)).toEqual({ origin: 'https://books.example.org', rpID: 'books.example.org' });
  });

  it('takes the browser scheme behind a TLS proxy, but only for its own host', async () => {
    await load();
    const { relyingParty } = await import('../../src/auth/http.js');
    expect(relyingParty(fakeReq({ host: 'lexis.example.com', origin: 'https://lexis.example.com' }))).toEqual({ origin: 'https://lexis.example.com', rpID: 'lexis.example.com' });
    expect(relyingParty(fakeReq({ host: 'lexis.example.com', origin: 'https://evil.example' }))).toEqual({ origin: 'http://lexis.example.com', rpID: 'lexis.example.com' });
    expect(relyingParty(fakeReq({}))).toBeNull();
  });

  it('sets a strict, HttpOnly session cookie, __Host- prefixed over https', async () => {
    await load();
    let http = await import('../../src/auth/http.js');
    expect(http.sessionCookie('t')).toBe('lexis_session=t; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000');
    await load({ COOKIE_SECURE: '1' });
    http = await import('../../src/auth/http.js');
    expect(http.sessionCookie('t', 0)).toBe('__Host-lexis=t; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure');
  });

  it('parses cookies leniently', async () => {
    await load();
    const { parseCookies } = await import('../../src/auth/http.js');
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies(' a = 1 ;b=two%20words; x; =v')).toEqual({ a: '1', b: 'two words' });
    expect(parseCookies('progress=100%; lexis_session=t')).toEqual({ progress: '100%', lexis_session: 't' });
  });
});
