// SPDX-License-Identifier: Apache-2.0
/**
 * Agent signature updates — the format both sides agree on.
 *
 * AI agent products change how they show themselves every few weeks. A signature bundle tells engines that are
 * already installed what to look for now, without a package release. It is signed with OneHuman's signatures
 * key, which is kept offline — not on the portal — so neither the portal nor the network can forge one. The
 * public half ships in this package. A bundle only ever ADDS to what the engine knows; it cannot remove a
 * built-in check, so even a stolen key could not switch detection off.
 *
 *   compact JWS, EdDSA, typ 'oh-signatures'
 *   payload { v: 1, iss: 'onehuman-signatures', seq, issued, minEngine, note?, rules }
 *   seq     only a higher seq replaces the one in use: an old bundle can never be replayed over a newer one
 */
import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { thumbprint } from '../proof/verify.ts';

export const SIGNATURES_TYP = 'oh-signatures';

/** What a bundle can add. Every list is additive to the engine's built-in knowledge. */
export type SignatureRules = {
  /** DOM traces an agent tool leaves: the page script looks for `selector`; the server maps `name` to `tool` */
  markers?: { name: string; selector: string; tool: string; control: boolean }[];
  /** global names an agent tool injects into the page */
  globals?: { name: string; tool: string; control: boolean }[];
  /** prefixes of global names the page script should report */
  globalPrefixes?: string[];
  /** tokens in the User-Agent of AI applications' built-in browsers */
  appUserAgents?: { token: string; tool: string }[];
};
export type SignatureBundle = { v: 1; iss: 'onehuman-signatures'; seq: number; issued: number; minEngine: string; note?: string; rules: SignatureRules };

/** OneHuman's signatures public keys (Ed25519 `x`). A new key is added here before a rotation. */
let TRUSTED: { x: string }[] = [{ x: 'tqPdOdA6Nsk5WfFtFw_azfanhnQvgcT4g7HGEmGJT5I' }];
export const trustedSignatureKeys = () => TRUSTED;
/** for tests and self-hosted forks only: trust other keys */
export function setTrustedSignatureKeys(keys: { x: string }[]) { TRUSTED = keys; }

const ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
const SELECTOR = /^[#.\[]?[A-Za-z0-9_\-#.\[\]="':* >]{1,160}$/;
const GLOBAL = /^[A-Za-z_$][A-Za-z0-9_$]{2,63}$/;
const TOKEN = /^[A-Za-z][A-Za-z0-9 ._-]{1,39}$/;

/** Check a bundle's rules strictly; anything outside the schema rejects the whole bundle. */
export function validateRules(x: unknown): SignatureRules | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const out: SignatureRules = {};
  const list = (k: string, max: number) => (o[k] === undefined ? [] : Array.isArray(o[k]) && (o[k] as unknown[]).length <= max ? (o[k] as unknown[]) : null);
  const m = list('markers', 50), g = list('globals', 100), p = list('globalPrefixes', 20), u = list('appUserAgents', 50);
  if (!m || !g || !p || !u) return null;
  for (const it of m) { const r = it as Record<string, unknown>; if (!r || typeof r.name !== 'string' || !ID.test(r.name) || typeof r.selector !== 'string' || !SELECTOR.test(r.selector) || typeof r.tool !== 'string' || !ID.test(r.tool) || typeof r.control !== 'boolean') return null; }
  for (const it of g) { const r = it as Record<string, unknown>; if (!r || typeof r.name !== 'string' || !GLOBAL.test(r.name) || typeof r.tool !== 'string' || !ID.test(r.tool) || typeof r.control !== 'boolean') return null; }
  for (const it of p) if (typeof it !== 'string' || !/^__[A-Za-z][A-Za-z0-9_]{1,30}$/.test(it)) return null;
  for (const it of u) { const r = it as Record<string, unknown>; if (!r || typeof r.token !== 'string' || !TOKEN.test(r.token) || typeof r.tool !== 'string' || !ID.test(r.tool)) return null; }
  if (m.length) out.markers = m.map((r) => { const x = r as Record<string, unknown>; return { name: String(x.name), selector: String(x.selector), tool: String(x.tool), control: x.control === true }; });
  if (g.length) out.globals = g.map((r) => { const x = r as Record<string, unknown>; return { name: String(x.name), tool: String(x.tool), control: x.control === true }; });
  if (p.length) out.globalPrefixes = p.map(String);
  if (u.length) out.appUserAgents = u.map((r) => { const x = r as Record<string, unknown>; return { token: String(x.token), tool: String(x.tool) }; });
  return out;
}

export type BundleCheck = { ok: true; bundle: SignatureBundle; kid: string } | { ok: false; reason: 'malformed' | 'wrong_type' | 'unknown_key' | 'bad_signature' | 'bad_rules' };
const keyCache = new Map<string, KeyObject>();

/** Verify a signed bundle against the trusted keys and check its rules. */
export function verifySignatureBundle(jws: unknown, keys: { x: string }[] = TRUSTED): BundleCheck {
  if (typeof jws !== 'string' || jws.length > 64_000) return { ok: false, reason: 'malformed' };
  const parts = jws.split('.');
  if (parts.length !== 3 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) return { ok: false, reason: 'malformed' };
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: string; typ?: string; kid?: string }, payload: SignatureBundle;
  try { header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')); payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch { return { ok: false, reason: 'malformed' }; }
  if (header.alg !== 'EdDSA' || header.typ !== SIGNATURES_TYP || payload?.iss !== 'onehuman-signatures' || payload.v !== 1) return { ok: false, reason: 'wrong_type' };
  const key = keys.find((k) => thumbprint(k.x) === header.kid);
  if (!key) return { ok: false, reason: 'unknown_key' };
  let pub = keyCache.get(key.x);
  if (!pub) { try { pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.x }, format: 'jwk' }); } catch { return { ok: false, reason: 'unknown_key' }; } keyCache.set(key.x, pub); }
  if (!verify(null, Buffer.from(`${h}.${p}`), pub, Buffer.from(s, 'base64url'))) return { ok: false, reason: 'bad_signature' };
  const rules = validateRules(payload.rules);
  if (!rules || !Number.isInteger(payload.seq) || payload.seq < 1 || typeof payload.minEngine !== 'string') return { ok: false, reason: 'bad_rules' };
  return { ok: true, bundle: { ...payload, rules }, kid: header.kid! };
}

/** '0.6.1' ≥ '0.6.0'; a development build ('0.0.0-dev') accepts everything */
export function engineAtLeast(engine: string, min: string): boolean {
  if (engine.startsWith('0.0.0')) return true;
  const a = engine.split(/[.-]/).slice(0, 3).map(Number), b = min.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0); }
  return true;
}
