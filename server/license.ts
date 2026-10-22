// SPDX-License-Identifier: BUSL-1.1
/**
 * The engine's license. Every deployment that serves real users runs with a license from OneHuman Inc.:
 *
 *   an API key        the server asks the portal for a signed license token every few hours (the free plan included)
 *   a license file    an offline token from OneHuman Inc. for deployments that may not call out (enterprise)
 *
 * Without one, requests to a real host pass through untouched (the app never breaks, nothing is protected) and the
 * server says why. Development and tests on a local host (localhost, 127.0.0.1, ::1, *.localhost, *.test, *.local)
 * need no license: a request counts as local only when its Host, any proxy's X-Forwarded-Host and the browser's own
 * Origin and Referer all name a local host, and not on a server started for production (NODE_ENV=production). The
 * engine also caps unlicensed local use at a development's size (DEV_SESSIONS_PER_DAY).
 *
 * The license object cannot be changed from outside: its state is in private fields and the object is frozen, and
 * there is no switch that turns the check off (onehuman.ai itself runs with a license file like any other site).
 *
 * A token is a compact JWS (EdDSA, typ onehuman-license+jws) whose payload is
 *   { v: 1, iss: 'onehuman-license', sub: <the API key's tag> | 'offline', account, plan, mode, iat, exp, note? }
 * signed with a key whose public half is built into this package: a token signed by anyone else is refused, and a
 * portal of one's own cannot issue one. `mode` is what the plan allows now: 'enforce', or 'observe' (decisions are
 * computed and recorded, nothing is enforced) for an account past its free limit after the grace period.
 *
 * Removing or working around this check is not allowed by the licence (LICENSE-BSL, Additional Use Grant).
 */
import { createPrivateKey, createPublicKey, hkdfSync, sign, verify, type KeyObject } from 'node:crypto';
import type { Req } from './http.ts';

export const LICENSE_TYP = 'onehuman-license+jws';
export type LicenseMode = 'enforce' | 'observe' | 'off';
export type LicensePayload = { v: 1; iss: 'onehuman-license'; sub: string; account: string; plan: string; mode: 'enforce' | 'observe'; iat: number; exp: number; note?: string };
export type LicenseStatus = {
  state: 'licensed' | 'unlicensed' | 'expired';
  plan: string | null; mode: 'enforce' | 'observe' | null; expires: number | null; source: 'portal' | 'cache' | 'file' | null; problem: string | null;
};

/** OneHuman Inc.'s license-signing keys (the portal derives the private half from its secret). */
let TRUSTED: { x: string }[] = [{ x: 'QBI5U2xNMMEt0dRJeynp3-XMRFpVx0QxoAeg_Avr2yc' }];   // https://onehuman.ai/api/v1/license/keys
export const trustedLicenseKeys = () => TRUSTED;
/** for tests and for a deployment whose license comes from a different signer by contract */
export function setTrustedLicenseKeys(keys: { x: string }[]) { TRUSTED = keys; }

/** a request to a machine of one's own: development and tests, never a real user */
export const LOCAL_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1|0\.0\.0\.0|[a-z0-9-]+\.localhost|(?:[a-z0-9-]+\.)+(?:test|local|localhost))(?::\d+)?$/i;
/** the host part of an Origin or Referer header ('' when there is none or it is not a URL) */
const hostOf = (v: unknown) => { try { return v ? new URL(String(Array.isArray(v) ? v[0] : v)).host : ''; } catch { return ''; } };
/**
 * A local host, through any proxy in front of it, as the browser itself sees it (Origin, Referer), and not a server
 * started for production (NODE_ENV=production). A proxy that rewrites Host to localhost in front of a real domain
 * still carries the real page in the browser's Origin and Referer.
 */
export const isLocalRequest = (req: Pick<Req, 'headers'>) => {
  if (process.env.NODE_ENV === 'production') return false;
  const fwd = req.headers['x-forwarded-host'];
  if (!LOCAL_HOST.test(String(req.headers.host ?? ''))) return false;
  if (fwd && !LOCAL_HOST.test(String(Array.isArray(fwd) ? fwd[0] : fwd).split(',')[0]!.trim())) return false;
  for (const h of [hostOf(req.headers.origin), hostOf(req.headers.referer)]) if (h && !LOCAL_HOST.test(h)) return false;
  return true;
};
/** how many sessions a day an unlicensed deployment may protect on a local host: plenty for development, not a site */
export const DEV_SESSIONS_PER_DAY = 300;

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const keyCache = new Map<string, KeyObject>();

export function verifyLicense(token: unknown, keys: { x: string }[] = TRUSTED, now = Date.now()): { ok: true; payload: LicensePayload } | { ok: false; reason: string } {
  if (typeof token !== 'string' || token.length > 4000) return { ok: false, reason: 'malformed' };
  const parts = token.trim().split('.');
  if (parts.length !== 3 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) return { ok: false, reason: 'malformed' };
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: string; typ?: string; kid?: string }, payload: LicensePayload;
  try { header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')); payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch { return { ok: false, reason: 'malformed' }; }
  if (header.alg !== 'EdDSA' || header.typ !== LICENSE_TYP || payload?.iss !== 'onehuman-license' || payload.v !== 1) return { ok: false, reason: 'wrong_type' };
  let good = false;
  for (const k of keys) {
    let pub = keyCache.get(k.x);
    if (!pub) { try { pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: k.x }, format: 'jwk' }); keyCache.set(k.x, pub); } catch { continue; } }
    if (verify(null, Buffer.from(`${h}.${p}`), pub, Buffer.from(s, 'base64url'))) { good = true; break; }
  }
  if (!good) return { ok: false, reason: 'bad_signature' };
  if (payload.mode !== 'enforce' && payload.mode !== 'observe') return { ok: false, reason: 'wrong_type' };
  if (!Number.isFinite(payload.exp) || payload.exp * 1000 <= now) return { ok: false, reason: 'expired' };
  return { ok: true, payload };
}

/** The license signer (the portal): an Ed25519 key derived from the deployment secret, the same on every instance. */
export function licenseSigner(secret: Buffer) {
  const seed = Buffer.from(hkdfSync('sha256', secret, 'onehuman', 'portal-license-ed25519', 32));
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const x = (createPublicKey(priv).export({ format: 'jwk' }) as { x: string }).x;
  const header = b64u(JSON.stringify({ alg: 'EdDSA', typ: LICENSE_TYP }));
  return {
    jwk: { kty: 'OKP' as const, crv: 'Ed25519' as const, x, use: 'sig' as const, alg: 'EdDSA' as const },
    issue(p: { sub: string; account: string; plan: string; mode: 'enforce' | 'observe'; ttlMs: number; note?: string }, now = Date.now()): string {
      const payload: LicensePayload = { v: 1, iss: 'onehuman-license', sub: p.sub, account: p.account, plan: p.plan, mode: p.mode, iat: Math.floor(now / 1000), exp: Math.floor((now + p.ttlMs) / 1000), ...(p.note ? { note: p.note } : {}) };
      const input = `${header}.${b64u(JSON.stringify(payload))}`;
      return `${input}.${b64u(sign(null, Buffer.from(input), priv))}`;
    },
  };
}

/**
 * What the engine may do: the newest valid token decides, and a request to a local host is served in full (up to
 * DEV_SESSIONS_PER_DAY, which the engine counts). Private fields and a frozen object: nothing outside can change it.
 */
export class License {
  #payload: LicensePayload | null = null;
  #source: LicenseStatus['source'] = null;
  #problem: string | null = null;
  readonly #keyTag: string | null;
  readonly #now: () => number;
  constructor(opts: { keyTag?: string | null; now?: () => number } = {}) {
    this.#keyTag = opts.keyTag ?? null;
    this.#now = opts.now ?? Date.now;
    Object.freeze(this);
  }

  /** offer a token (from the portal, the saved copy, or a license file); kept only when genuine, current and for this key */
  set(token: string, source: 'portal' | 'cache' | 'file'): { ok: boolean; reason?: string } {
    const v = verifyLicense(token, TRUSTED, this.#now());
    if (!v.ok) { this.#problem = `the license ${source === 'file' ? 'file' : source === 'cache' ? 'saved copy' : 'from the portal'} was not accepted (${v.reason})`; return { ok: false, reason: v.reason }; }
    if (v.payload.sub !== 'offline' && this.#keyTag && v.payload.sub !== this.#keyTag) { this.#problem = 'the license is for another API key'; return { ok: false, reason: 'wrong_key' }; }
    // a newer token wins; an offline file is not replaced by a shorter one
    if (this.#payload && this.#source === 'file' && source !== 'file' && this.#payload.exp > v.payload.exp) return { ok: true };
    this.#payload = v.payload; this.#source = source; this.#problem = null;
    return { ok: true };
  }
  get token(): LicensePayload | null { const p = this.#payload; return p && p.exp * 1000 > this.#now() ? p : null; }

  /** what a request may get: everything on a local host; otherwise what the license says, or nothing */
  mode(req?: Pick<Req, 'headers'> | null): LicenseMode {
    const t = this.token;
    if (t) return t.mode;
    return req && isLocalRequest(req) ? 'enforce' : 'off';
  }
  /** whether this request is served only because it is local (the engine then counts it against the development cap) */
  localOnly(req?: Pick<Req, 'headers'> | null): boolean { return !this.token && !!req && isLocalRequest(req); }

  status(): LicenseStatus {
    const t = this.#payload;
    if (!t) return { state: 'unlicensed', plan: null, mode: null, expires: null, source: null, problem: this.#problem };
    const expired = t.exp * 1000 <= this.#now();
    return { state: expired ? 'expired' : 'licensed', plan: t.plan, mode: expired ? null : t.mode, expires: t.exp * 1000, source: this.#source, problem: this.#problem };
  }
}
Object.freeze(License.prototype);
Object.freeze(License);
