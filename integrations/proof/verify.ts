// SPDX-License-Identifier: Apache-2.0
/**
 * OneHuman decision proofs — the open half: the format, and how to check one.
 *
 * A proof is a compact JWS (EdDSA / Ed25519), header { alg: "EdDSA", typ: "oh-proof", kid }, whose payload
 * states one decision: what was decided and why, whether data was delivered, and its place in the
 * hash-chained audit log. Anyone can verify a proof with this file, any JOSE library, or
 * `npx onehumanai verify-proof`. The signing side lives in the engine; checking needs nothing from it.
 */
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';

export const PROOF_VERSION = 1;
export const PROOF_TYP = 'oh-proof';

export type ProofJwk = { kty: 'OKP'; crv: 'Ed25519'; x: string; kid: string; use: 'sig'; alg: 'EdDSA' };

export type ProofPayload = {
  v: number;
  iss: 'onehuman';
  /** issued at, seconds */
  iat: number;
  /** the decision id — unique, the handle an auditor asks about */
  jti: string;
  /** digest of the session the decision was made for; the raw id stays in the business's own records */
  sub: string;
  resource: string;
  /** what the response did: allow, mask, step_up, block */
  decision: string;
  /** what the policy computed (differs from `decision` only in observe mode) */
  computed: string;
  enforced: boolean;
  branch: string;
  actor: string;
  score: number | null;
  tiers: string[];
  reasons: string[];
  /** whether the protected data left the server in this response (masked data counts as not delivered) */
  delivered: boolean;
  policy: string;
  engine: string;
  /** the decision's place in the tamper-evident audit chain */
  audit: { seq: number; hash: string; prev: string };
};

const fromB64u = (s: string) => Buffer.from(s, 'base64url');

/** RFC 7638 thumbprint of an Ed25519 public key: the key's stable id. */
export function thumbprint(x: string): string {
  return createHash('sha256').update(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x })).digest('base64url');
}

export type ProofCheck =
  | { valid: true; payload: ProofPayload; kid: string }
  | { valid: false; reason: 'malformed' | 'unknown_key' | 'bad_signature' | 'wrong_type' };

const JWS = /^[A-Za-z0-9_-]{10,200}\.[A-Za-z0-9_-]{20,6000}\.[A-Za-z0-9_-]{80,90}$/;
const keyCache = new Map<string, KeyObject>();

/**
 * Check a proof against one or more public keys (JWKs). Pure: no network, no database.
 * A valid proof says exactly one thing: the holder of this key signed this payload, and not a byte
 * of it has changed since.
 */
export function verifyProof(jws: string, keys: { x: string; kid?: string }[]): ProofCheck {
  if (typeof jws !== 'string' || !JWS.test(jws)) return { valid: false, reason: 'malformed' };
  const [h, p, s] = jws.split('.') as [string, string, string];
  let header: { alg?: string; typ?: string; kid?: string };
  let payload: ProofPayload;
  try { header = JSON.parse(fromB64u(h).toString('utf8')); payload = JSON.parse(fromB64u(p).toString('utf8')); } catch { return { valid: false, reason: 'malformed' }; }
  if (header.alg !== 'EdDSA' || header.typ !== PROOF_TYP || payload?.iss !== 'onehuman') return { valid: false, reason: 'wrong_type' };
  const key = keys.find((k) => (k.kid ?? thumbprint(k.x)) === header.kid && thumbprint(k.x) === header.kid);
  if (!key) return { valid: false, reason: 'unknown_key' };
  let pub = keyCache.get(key.x);
  if (!pub) {
    try { pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.x }, format: 'jwk' }); } catch { return { valid: false, reason: 'unknown_key' }; }
    if (keyCache.size > 200) keyCache.clear();
    keyCache.set(key.x, pub);
  }
  if (!verify(null, Buffer.from(`${h}.${p}`), pub, fromB64u(s))) return { valid: false, reason: 'bad_signature' };
  return { valid: true, payload, kid: header.kid! };
}

/** Read a proof's payload without checking it — for display only. Never base a decision on this. */
export function peekProof(jws: string): ProofPayload | null {
  try { const p = jws.split('.')[1]; return p ? (JSON.parse(fromB64u(p).toString('utf8')) as ProofPayload) : null; } catch { return null; }
}

/** The file a business hands an auditor: the proofs, the key that signed them, and how to check them. */
export function proofBundle<M extends Record<string, unknown>>(proofs: string[], keys: ProofJwk[], meta: M = {} as M) {
  return {
    format: 'onehuman-proof-bundle/1',
    created: new Date().toISOString(),
    ...meta,
    keys,
    proofs,
    verify: 'Each proof is a compact JWS (EdDSA / Ed25519). Check it with the matching key in `keys` using any JOSE library, or run: npx onehumanai verify-proof <this file>',
  };
}
