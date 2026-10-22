// SPDX-License-Identifier: BUSL-1.1
/** A software WebAuthn authenticator (P-256) for tests: builds clientDataJSON, attestationObject and authenticatorData the way a browser would. */
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

export const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

// --- minimal CBOR encoder for the attestation object -----------------------
function cbor(v: unknown): Buffer {
  if (typeof v === 'number') {
    if (v >= 0) return cborUint(0, v);
    return cborUint(1, -1 - v);
  }
  if (Buffer.isBuffer(v)) return Buffer.concat([cborUint(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([cborUint(3, b.length), b]); }
  if (v instanceof Map) { const parts = [cborUint(5, v.size)]; for (const [k, val] of v) parts.push(cbor(k), cbor(val)); return Buffer.concat(parts); }
  throw new Error('cbor enc: unsupported');
}
function cborUint(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
}

export class SoftAuthenticator {
  priv: KeyObject; pub: KeyObject; credId = Buffer.from('cred-' + Math.random().toString(36).slice(2)); counter = 0;
  constructor() { const kp = generateKeyPairSync('ec', { namedCurve: 'P-256' }); this.priv = kp.privateKey; this.pub = kp.publicKey; }
  authData(rpId: string, flags: number, withCred: boolean): Buffer {
    const rpIdHash = createHash('sha256').update(rpId).digest();
    const head = Buffer.alloc(37); rpIdHash.copy(head, 0); head[32] = flags; head.writeUInt32BE(this.counter, 33);
    if (!withCred) return head;
    const jwk = this.pub.export({ format: 'jwk' }) as { x: string; y: string };
    const cose = new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]);
    const credLen = Buffer.alloc(2); credLen.writeUInt16BE(this.credId.length);
    return Buffer.concat([head, Buffer.alloc(16), credLen, this.credId, cbor(cose)]);
  }
  register(challenge: string, origin: string, rpId: string, flags = 0x45) {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin }));
    const att = new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', this.authData(rpId, flags, true)]]);
    return { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(cbor(att)) };
  }
  assert(challenge: string, origin: string, rpId: string, flags = 0x05) {
    this.counter++;
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin }));
    const authenticatorData = this.authData(rpId, flags, false);
    const signature = sign('sha256', Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()]), { key: this.priv, dsaEncoding: 'der' });
    return { credentialId: b64u(this.credId), id: b64u(this.credId), clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authenticatorData), signature: b64u(signature) };
  }
}

