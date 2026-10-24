import crypto from 'node:crypto';

/**
 * A software passkey authenticator (ES256, "none" attestation, user verified)
 * that answers WebAuthn options JSON the way a browser plus platform
 * authenticator would, so the server's real verification runs in tests.
 */

// ---------- minimal CBOR encoder (only what attestation objects need) ----------

type Cbor = number | string | Uint8Array | Map<Cbor, Cbor> | Cbor[];

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

export function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') {
    const b = Buffer.from(v, 'utf8');
    return Buffer.concat([head(3, b.length), b]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  const parts = [head(5, v.size)];
  for (const [k, val] of v) parts.push(cbor(k), cbor(val));
  return Buffer.concat(parts);
}

const sha256 = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest();
const b64u = (b: Buffer) => b.toString('base64url');

interface CreationOptions {
  challenge: string;
  rp: { id?: string };
  user: { id: string };
  excludeCredentials?: { id: string }[];
}
interface RequestOptions {
  challenge: string;
  rpId?: string;
}

export class SoftAuthenticator {
  readonly credentialId = crypto.randomBytes(16);
  private readonly keys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  private counter = 0;
  private userHandle = '';
  private rpId = '';
  /** Flip to test that the server insists on user verification. */
  userVerified = true;

  constructor(readonly origin: string) {}

  get id(): string {
    return b64u(this.credentialId);
  }

  private flags(attested: boolean): number {
    // UP | UV? | BE | BS | AT?
    return 0x01 | (this.userVerified ? 0x04 : 0) | 0x08 | 0x10 | (attested ? 0x40 : 0);
  }

  private clientData(type: string, challenge: string, origin = this.origin): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** Answer navigator.credentials.create(). */
  create(options: CreationOptions, overrides: { origin?: string; challenge?: string } = {}) {
    const rpId = options.rp.id ?? new URL(this.origin).hostname;
    this.rpId = rpId;
    this.userHandle = options.user.id;
    const jwk = this.keys.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const coseKey = new Map<Cbor, Cbor>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(jwk.x, 'base64url')],
      [-3, Buffer.from(jwk.y, 'base64url')],
    ]);
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([sha256(rpId), Buffer.from([this.flags(true)]), counter, Buffer.alloc(16), idLen, this.credentialId, cbor(coseKey)]);
    const attestationObject = cbor(new Map<Cbor, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64u(this.clientData('webauthn.create', overrides.challenge ?? options.challenge, overrides.origin)),
        attestationObject: b64u(attestationObject),
        transports: ['internal', 'hybrid'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** Answer navigator.credentials.get(). */
  get(options: RequestOptions, overrides: { origin?: string; challenge?: string; rpId?: string; counter?: number } = {}) {
    this.counter = overrides.counter ?? this.counter + 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha256(overrides.rpId ?? options.rpId ?? this.rpId), Buffer.from([this.flags(false)]), counter]);
    const clientDataJSON = this.clientData('webauthn.get', overrides.challenge ?? options.challenge, overrides.origin);
    const signature = crypto.sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), this.keys.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        userHandle: this.userHandle,
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }
}
