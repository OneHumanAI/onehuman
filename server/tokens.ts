// SPDX-License-Identifier: BUSL-1.1
/**
 * Short-lived, single-use decision tokens.
 *
 * A decision made for `session + resource` is only valid for a few seconds and
 * only once. This is how the export/download path is protected: the decision
 * endpoint issues a token, the file endpoint consumes it. A token cannot be
 * reused for another resource, another session, or after expiry.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type TokenClaims = {
  jti: string;
  session: string;
  resource: string;
  decision: string;
  decisionId: string;
  exp: number;
};

const b64u = (b: Buffer) => b.toString('base64url');

export function issueToken(secret: Buffer, claims: Omit<TokenClaims, 'jti' | 'exp'>, ttlMs: number, now = Date.now()): string {
  const full: TokenClaims = { ...claims, jti: b64u(randomBytes(12)), exp: now + ttlMs };
  const payload = b64u(Buffer.from(JSON.stringify(full)));
  const mac = b64u(createHmac('sha256', secret).update(payload).digest());
  return `${payload}.${mac}`;
}

export type TokenCheck =
  | { ok: true; claims: TokenClaims }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'wrong_session' | 'wrong_resource' };

export function verifyToken(secret: Buffer, token: string, expect: { session: string; resource: string }, now = Date.now()): TokenCheck {
  const parts = token.split('.');
  if (parts.length !== 2 || token.length > 2048) return { ok: false, reason: 'malformed' };
  const [payload, mac] = parts as [string, string];
  const expected = createHmac('sha256', secret).update(payload).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'bad_signature' };
  let claims: TokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof claims.exp !== 'number' || claims.exp < now) return { ok: false, reason: 'expired' };
  if (claims.session !== expect.session) return { ok: false, reason: 'wrong_session' };
  if (claims.resource !== expect.resource) return { ok: false, reason: 'wrong_resource' };
  return { ok: true, claims };
}
