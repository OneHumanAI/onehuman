// SPDX-License-Identifier: BUSL-1.1
/**
 * WebAuthn step-up: proof of a present, verified person.
 *
 * Why WebAuthn and not a code in a dialog: a browser agent can read a code off
 * the screen and type it. It cannot press Touch ID, enter the device PIN or tap
 * a hardware key. With `userVerification: "required"` the authenticator itself
 * attests that a person was verified (UV flag), and the signature binds that to
 * our challenge, our origin and our RP id. Everything is checked on the server.
 *
 * This module is dependency-free and deliberately narrow:
 *   - registration (attestation "none"): parse authenticatorData, keep the
 *     COSE public key (ES256 or RS256 or EdDSA), credential id, sign count
 *   - assertion: verify clientDataJSON (type, challenge, origin), rpIdHash,
 *     UP+UV flags, sign count, and the signature over authData || sha256(clientDataJSON)
 *   - challenges are single-use and short-lived; grants are single-use per resource
 *
 * Not handled: attestation statement verification, extensions, multiple RP ids.
 */
import { createHash, createPublicKey, randomBytes, verify as nodeVerify, type KeyObject } from 'node:crypto';

export type StoredCredential = {
  id: string; // base64url credential id
  publicKeyJwk: JsonWebKey;
  alg: number; // COSE alg: -7 ES256, -257 RS256, -8 EdDSA
  signCount: number;
  createdAt: number;
  label: string;
};

const b64u = {
  enc: (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url'),
  dec: (s: string) => Buffer.from(s, 'base64url'),
};

export function newChallenge(): string {
  return b64u.enc(randomBytes(32));
}

// ---------------------------------------------------------------------------
// Minimal CBOR decoder (enough for attestation objects and COSE keys)
// ---------------------------------------------------------------------------
function cborDecode(buf: Buffer): unknown {
  let off = 0;
  const readLen = (info: number): number | bigint => {
    if (info < 24) return info;
    if (info === 24) return buf[off++]!;
    if (info === 25) { const v = buf.readUInt16BE(off); off += 2; return v; }
    if (info === 26) { const v = buf.readUInt32BE(off); off += 4; return v; }
    if (info === 27) { const v = buf.readBigUInt64BE(off); off += 8; return v; }
    throw new Error('cbor: unsupported length');
  };
  const item = (): unknown => {
    if (off >= buf.length) throw new Error('cbor: truncated');
    const b = buf[off++]!;
    const major = b >> 5;
    const info = b & 0x1f;
    switch (major) {
      case 0: return Number(readLen(info));
      case 1: return -1 - Number(readLen(info));
      case 2: { const n = Number(readLen(info)); const v = buf.subarray(off, off + n); off += n; return Buffer.from(v); }
      case 3: { const n = Number(readLen(info)); const v = buf.subarray(off, off + n).toString('utf8'); off += n; return v; }
      case 4: { const n = Number(readLen(info)); const a: unknown[] = []; for (let i = 0; i < n; i++) a.push(item()); return a; }
      case 5: { const n = Number(readLen(info)); const m = new Map<unknown, unknown>(); for (let i = 0; i < n; i++) { const k = item(); m.set(k, item()); } return m; }
      case 7: if (info === 20) return false; if (info === 21) return true; if (info === 22) return null; throw new Error('cbor: unsupported simple');
      default: throw new Error('cbor: unsupported major ' + major);
    }
  };
  const v = item();
  return v;
}

// ---------------------------------------------------------------------------
// authenticatorData
// ---------------------------------------------------------------------------
export type AuthData = {
  rpIdHash: Buffer;
  flags: { up: boolean; uv: boolean; at: boolean; ed: boolean };
  signCount: number;
  credentialId?: Buffer;
  cosePublicKey?: Map<unknown, unknown>;
};

export function parseAuthData(data: Buffer): AuthData {
  if (data.length < 37) throw new Error('authData too short');
  const rpIdHash = Buffer.from(data.subarray(0, 32));
  const f = data[32]!;
  const flags = { up: !!(f & 0x01), uv: !!(f & 0x04), at: !!(f & 0x40), ed: !!(f & 0x80) };
  const signCount = data.readUInt32BE(33);
  const out: AuthData = { rpIdHash, flags, signCount };
  if (flags.at) {
    let off = 37;
    off += 16; // aaguid
    const credLen = data.readUInt16BE(off); off += 2;
    out.credentialId = Buffer.from(data.subarray(off, off + credLen)); off += credLen;
    const rest = Buffer.from(data.subarray(off));
    out.cosePublicKey = cborDecode(rest) as Map<unknown, unknown>;
  }
  return out;
}

export function coseToJwk(cose: Map<unknown, unknown>): { jwk: JsonWebKey; alg: number } {
  const kty = cose.get(1) as number;
  const alg = cose.get(3) as number;
  if (kty === 2) {
    const crv = cose.get(-1) as number;
    if (crv !== 1) throw new Error('unsupported EC curve');
    const x = cose.get(-2) as Buffer, y = cose.get(-3) as Buffer;
    return { alg, jwk: { kty: 'EC', crv: 'P-256', x: b64u.enc(x), y: b64u.enc(y) } };
  }
  if (kty === 3) {
    const n = cose.get(-1) as Buffer, e = cose.get(-2) as Buffer;
    return { alg, jwk: { kty: 'RSA', n: b64u.enc(n), e: b64u.enc(e) } };
  }
  if (kty === 1) {
    const crv = cose.get(-1) as number;
    if (crv !== 6) throw new Error('unsupported OKP curve');
    return { alg, jwk: { kty: 'OKP', crv: 'Ed25519', x: b64u.enc(cose.get(-2) as Buffer) } };
  }
  throw new Error('unsupported COSE key type');
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------
export type RegistrationInput = {
  clientDataJSON: string; // base64url
  attestationObject: string; // base64url
};

export function verifyRegistration(input: RegistrationInput, expect: { challenge: string; origin: string; rpId: string }, label = 'passkey'): StoredCredential {
  const client = JSON.parse(b64u.dec(input.clientDataJSON).toString('utf8')) as { type?: string; challenge?: string; origin?: string };
  if (client.type !== 'webauthn.create') throw new Error('clientData.type');
  if (client.challenge !== expect.challenge) throw new Error('challenge mismatch');
  if (client.origin !== expect.origin) throw new Error('origin mismatch');
  const att = cborDecode(b64u.dec(input.attestationObject)) as Map<unknown, unknown>;
  const authData = parseAuthData(att.get('authData') as Buffer);
  if (!authData.rpIdHash.equals(createHash('sha256').update(expect.rpId).digest())) throw new Error('rpIdHash mismatch');
  if (!authData.flags.up) throw new Error('user not present');
  if (!authData.flags.uv) throw new Error('user not verified');
  if (!authData.credentialId || !authData.cosePublicKey) throw new Error('no credential');
  const { jwk, alg } = coseToJwk(authData.cosePublicKey);
  if (alg !== -7 && alg !== -257 && alg !== -8) throw new Error('unsupported alg ' + alg);
  return { id: b64u.enc(authData.credentialId), publicKeyJwk: jwk, alg, signCount: authData.signCount, createdAt: Date.now(), label };
}

// ---------------------------------------------------------------------------
// Assertion
// ---------------------------------------------------------------------------
export type AssertionInput = {
  credentialId: string; // base64url
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
};

export type AssertionResult = { ok: true; newSignCount: number; uv: true } | { ok: false; reason: string };

function keyFor(cred: StoredCredential): KeyObject {
  return createPublicKey({ key: cred.publicKeyJwk as never, format: 'jwk' });
}

function derToRaw(sig: Buffer): Buffer {
  // ES256 signatures from authenticators are DER; Node's verify accepts DER for EC keys by default.
  return sig;
}

export function verifyAssertion(input: AssertionInput, cred: StoredCredential, expect: { challenge: string; origin: string; rpId: string }): AssertionResult {
  try {
    if (input.credentialId !== cred.id) return { ok: false, reason: 'unknown credential' };
    const clientDataJSON = b64u.dec(input.clientDataJSON);
    const client = JSON.parse(clientDataJSON.toString('utf8')) as { type?: string; challenge?: string; origin?: string };
    if (client.type !== 'webauthn.get') return { ok: false, reason: 'clientData.type' };
    if (client.challenge !== expect.challenge) return { ok: false, reason: 'challenge mismatch' };
    if (client.origin !== expect.origin) return { ok: false, reason: 'origin mismatch' };
    const authDataBuf = b64u.dec(input.authenticatorData);
    const authData = parseAuthData(authDataBuf);
    if (!authData.rpIdHash.equals(createHash('sha256').update(expect.rpId).digest())) return { ok: false, reason: 'rpIdHash mismatch' };
    if (!authData.flags.up) return { ok: false, reason: 'user not present' };
    if (!authData.flags.uv) return { ok: false, reason: 'user not verified' };
    if (authData.signCount !== 0 && cred.signCount !== 0 && authData.signCount <= cred.signCount) return { ok: false, reason: 'sign count did not increase (cloned authenticator?)' };
    const signed = Buffer.concat([authDataBuf, createHash('sha256').update(clientDataJSON).digest()]);
    const sig = b64u.dec(input.signature);
    const key = keyFor(cred);
    let valid: boolean;
    if (cred.alg === -7) valid = nodeVerify('sha256', signed, { key, dsaEncoding: 'der' }, derToRaw(sig));
    else if (cred.alg === -257) valid = nodeVerify('sha256', signed, key, sig);
    else if (cred.alg === -8) valid = nodeVerify(null, signed, key, sig);
    else return { ok: false, reason: 'unsupported alg' };
    if (!valid) return { ok: false, reason: 'bad signature' };
    return { ok: true, newSignCount: authData.signCount, uv: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/** Derive the RP id (host without port) and origin from a request URL. */
export function rpFromUrl(u: URL): { rpId: string; origin: string } {
  return { rpId: u.hostname, origin: u.origin };
}
