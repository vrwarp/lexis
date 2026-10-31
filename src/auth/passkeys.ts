import crypto from 'node:crypto';
import {
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { AuthStore, StoredPasskey } from './store.js';

/** The site a passkey is bound to: the browser origin and the RP ID (its host name). */
export interface RelyingParty {
  origin: string;
  rpID: string;
}

const CHALLENGE_MS = 5 * 60 * 1000;

interface Pending {
  challenge: string;
  kind: 'register' | 'authenticate';
  rp: RelyingParty;
  /** For registration and step-up: the session that asked. */
  sessionId: string | null;
  expires: number;
}

export class PasskeyError extends Error {}

/**
 * WebAuthn ceremonies for the one lexis user. Every challenge is single-use,
 * expires in five minutes and is tied to the origin (and, when signed in, the
 * session) that asked for it. User verification (biometric or PIN) is
 * required both to create and to use a passkey.
 */
export class Passkeys {
  private pending = new Map<string, Pending>();

  constructor(private readonly store: AuthStore) {}

  get count(): number {
    return this.store.passkeys.length;
  }

  async registrationOptions(rp: RelyingParty, sessionId: string) {
    const options = await generateRegistrationOptions({
      rpName: 'lexis',
      rpID: rp.rpID,
      userName: 'lexis',
      userDisplayName: 'lexis owner',
      userID: Buffer.from(this.store.userId, 'base64url'),
      attestationType: 'none',
      excludeCredentials: this.store.passkeys.map((p) => ({ id: p.id, transports: p.transports })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    return { challengeId: this.remember({ challenge: options.challenge, kind: 'register', rp, sessionId }), options };
  }

  async register(challengeId: string, response: RegistrationResponseJSON, sessionId: string, name: string): Promise<StoredPasskey> {
    const p = this.take(challengeId, 'register', sessionId);
    let verified;
    try {
      verified = await verifyRegistrationResponse({
        response,
        expectedChallenge: p.challenge,
        expectedOrigin: p.rp.origin,
        expectedRPID: p.rp.rpID,
        requireUserVerification: true,
      });
    } catch (e) {
      throw new PasskeyError(`The passkey could not be verified: ${(e as Error).message}`);
    }
    if (!verified.verified) throw new PasskeyError('The passkey could not be verified.');
    const info = verified.registrationInfo;
    if (this.store.passkeys.some((x) => x.id === info.credential.id)) throw new PasskeyError('That passkey is already registered.');
    const passkey: StoredPasskey = {
      id: info.credential.id,
      publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
      counter: info.credential.counter,
      transports: info.credential.transports ?? response.response.transports,
      name: cleanName(name) || defaultName(info.credentialDeviceType, this.store.passkeys.length),
      createdAt: new Date().toISOString(),
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
    };
    this.store.addPasskey(passkey);
    return passkey;
  }

  async authenticationOptions(rp: RelyingParty, sessionId: string | null = null) {
    const options = await generateAuthenticationOptions({
      rpID: rp.rpID,
      // Discoverable passkeys: the browser offers the right one, nothing reveals which exist.
      allowCredentials: [],
      userVerification: 'required',
    });
    return { challengeId: this.remember({ challenge: options.challenge, kind: 'authenticate', rp, sessionId }), options };
  }

  async authenticate(challengeId: string, response: AuthenticationResponseJSON, sessionId: string | null = null): Promise<StoredPasskey> {
    const p = this.take(challengeId, 'authenticate', sessionId);
    const passkey = this.store.passkeys.find((x) => x.id === response?.id);
    if (!passkey) throw new PasskeyError('That passkey is not registered here.');
    if (response.response?.userHandle && response.response.userHandle !== this.store.userId) {
      throw new PasskeyError('That passkey belongs to another account.');
    }
    let verified;
    try {
      verified = await verifyAuthenticationResponse({
        response,
        expectedChallenge: p.challenge,
        expectedOrigin: p.rp.origin,
        expectedRPID: p.rp.rpID,
        credential: { id: passkey.id, publicKey: Buffer.from(passkey.publicKey, 'base64url'), counter: passkey.counter, transports: passkey.transports },
        requireUserVerification: true,
      });
    } catch (e) {
      throw new PasskeyError(`The passkey could not be verified: ${(e as Error).message}`);
    }
    if (!verified.verified) throw new PasskeyError('The passkey could not be verified.');
    this.store.updatePasskey(passkey.id, {
      counter: verified.authenticationInfo.newCounter,
      backedUp: verified.authenticationInfo.credentialBackedUp,
      lastUsedAt: new Date().toISOString(),
    });
    return passkey;
  }

  rename(id: string, name: string): boolean {
    const clean = cleanName(name);
    if (!clean || !this.store.passkeys.some((p) => p.id === id)) return false;
    this.store.updatePasskey(id, { name: clean });
    return true;
  }

  remove(id: string): boolean {
    return this.store.removePasskey(id);
  }

  private remember(p: Omit<Pending, 'expires'>): string {
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expires < now) this.pending.delete(k);
    if (this.pending.size > 1000) this.pending.delete(this.pending.keys().next().value!);
    const id = crypto.randomBytes(16).toString('base64url');
    this.pending.set(id, { ...p, expires: now + CHALLENGE_MS });
    return id;
  }

  /** Use up a challenge: it must exist, be unexpired, of this kind and for this session. */
  private take(id: string, kind: Pending['kind'], sessionId: string | null): Pending {
    const p = typeof id === 'string' ? this.pending.get(id) : undefined;
    if (p) this.pending.delete(id);
    if (!p || p.kind !== kind || p.expires < Date.now() || p.sessionId !== sessionId) {
      throw new PasskeyError('That passkey request expired. Try again.');
    }
    return p;
  }
}

function cleanName(name: unknown): string {
  return typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) : '';
}

function defaultName(deviceType: string, existing: number): string {
  return `${deviceType === 'multiDevice' ? 'Synced passkey' : 'Security key'} ${existing + 1}`;
}
