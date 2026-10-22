// SPDX-License-Identifier: BUSL-1.1
/**
 * Decision proofs — the signing half (the format and the verifier are open: integrations/proof/verify.ts).
 *
 * Every decision the engine makes is signed the moment it is written, with a key derived from the engine
 * secret (HKDF), so every instance of one deployment signs with the same key; its id is the RFC 7638
 * thumbprint. The payload never carries the session id itself (only a digest), data, or anything the end
 * user typed, and the end user never sees a proof: it is made and kept on the server.
 */
import { createHash, createPrivateKey, createPublicKey, hkdfSync, sign } from 'node:crypto';
import type { DecisionRow } from './db.ts';
import { PROOF_TYP, PROOF_VERSION, thumbprint, type ProofJwk, type ProofPayload } from '../integrations/proof/verify.ts';

export { PROOF_TYP, PROOF_VERSION, peekProof, proofBundle, thumbprint, verifyProof } from '../integrations/proof/verify.ts';
export type { ProofCheck, ProofJwk, ProofPayload } from '../integrations/proof/verify.ts';

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** The session digest a proof carries. Anyone holding the session id can recompute it; nobody can reverse it. */
export function sessionDigest(session: string): string {
  return createHash('sha256').update('oh-proof\0').update(session).digest('hex').slice(0, 32);
}

export type Prover = {
  readonly jwk: ProofJwk;
  sign(row: DecisionRow, seq: number): string;
};

/**
 * A signer whose key is derived from the engine secret: same secret, same key, on every instance. `epoch` rotates
 * it without a new secret (0 is the original key); a deployment keeps publishing the older epochs so every proof
 * it ever made still verifies by its kid.
 */
export function proverFromSecret(secret: Buffer, epoch = 0): Prover {
  const info = epoch === 0 ? 'decision-proof-ed25519' : `decision-proof-ed25519:${epoch}`;
  const seed = Buffer.from(hkdfSync('sha256', secret, 'onehuman', info, 32));
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const x = (createPublicKey(privateKey).export({ format: 'jwk' }) as { x: string }).x;
  const jwk: ProofJwk = { kty: 'OKP', crv: 'Ed25519', x, kid: thumbprint(x), use: 'sig', alg: 'EdDSA' };
  const header = b64u(JSON.stringify({ alg: 'EdDSA', typ: PROOF_TYP, kid: jwk.kid }));
  return {
    jwk,
    sign(row, seq) {
      const payload: ProofPayload = {
        v: PROOF_VERSION, iss: 'onehuman', iat: Math.floor(row.created / 1000), jti: row.id, sub: sessionDigest(row.session),
        resource: row.resource, decision: row.decision, computed: row.computed, enforced: row.enforced, branch: row.branch,
        actor: row.actor, score: row.score, tiers: row.tiers, reasons: row.reasonCodes, delivered: row.dataDelivered,
        policy: row.policyVersion, engine: row.signalVersion, audit: { seq, hash: row.hash, prev: row.prevHash },
      };
      const input = `${header}.${b64u(JSON.stringify(payload))}`;
      return `${input}.${b64u(sign(null, Buffer.from(input), privateKey))}`;
    },
  };
}
