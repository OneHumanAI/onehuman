// SPDX-License-Identifier: BUSL-1.1
/**
 * Customer portal + telemetry ingest.
 *
 * A customer signs up, creates API keys (one per project), puts a key into `onehuman({ apiKey })`,
 * and the middleware reports every decision here — metadata only: hashed session, resource, decision,
 * actor, connection state, detected tools, reason codes. The portal turns that into the one number a
 * security team has never had: how many of their logged-in sessions had an AI agent in them.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { OneHuman } from '../engine.ts';
import { cookies, json, readJson, sameOrigin, url, type Req, type Res } from '../http.ts';
import { proofBundle, thumbprint, verifyProof, type ProofJwk } from '../proof.ts';
import { newsSince } from '../agent-news.ts';
import { policyRoutes } from './policy-portal.ts';
import { clientIp, type limiter } from '../limits.ts';
import { buildReport } from '../../integrations/report/build.ts';
import { verifySignatureBundle } from '../../integrations/signatures/common.ts';
import { renderReportHtml } from '../../integrations/report/html.ts';
import { siteOf, type TelemetryEvent, type TelemetryHealth } from '../site-db.ts';
import type { Mailer } from '../mail.ts';
import { PLANS, PLAN_IDS, SIGNATURE_DELAY_MS, type Billing } from '../billing.ts';
import { licenseSigner } from '../license.ts';
import { verifyFirebaseToken, type FirebaseUser } from '../firebase-auth.ts';

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const SHORT = /^[a-zA-Z0-9_.:\-\/ ]{1,80}$/;
const NAME = /^[^\x00-\x1f\x7f<>]{1,80}$/;   // key names: any printable text, no angle brackets
const TOKEN = /^[a-z0-9_]{1,40}$/i;
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const COOKIE = 'oh_portal';
const RANGES: Record<string, { since: number; bucket: number }> = {
  '24h': { since: 24 * 3600e3, bucket: 3600e3 },
  '7d': { since: 7 * 24 * 3600e3, bucket: 6 * 3600e3 },
  '30d': { since: 30 * 24 * 3600e3, bucket: 24 * 3600e3 },
};

export function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${scryptSync(pw, salt, 32).toString('hex')}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const a = scryptSync(pw, salt, 32), b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
export const hashKey = (raw: string) => createHash('sha256').update(raw).digest('hex');
/** `oh_live_` + 40 hex chars; the prefix (first 15 chars) is what the portal shows afterwards */
export function newApiKey(): { raw: string; prefix: string; hash: string } {
  const raw = `oh_live_${randomBytes(20).toString('hex')}`;
  return { raw, prefix: raw.slice(0, 15), hash: hashKey(raw) };
}
/** `oh_admin_` + 40 hex chars: administers the account over HTTP, so an agent or a CI job can do everything the portal can. */
export function newAdminKey(): { raw: string; prefix: string; hash: string } {
  const raw = `oh_admin_${randomBytes(20).toString('hex')}`;
  return { raw, prefix: raw.slice(0, 16), hash: hashKey(raw) };
}
const EXPIRY_DAYS = new Set([0, 7, 30, 90, 365]);
const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_r, rej) => setTimeout(() => rej(new Error(`timed out after ${ms} ms`)), ms).unref?.())]);
const ENVS = new Set(['production', 'staging', 'development']);

export function portalRoutes(engine: OneHuman, opts: { secure: (req: Req) => boolean; limits?: ReturnType<typeof limiter>; mail?: Mailer;
  /** plans and usage (server/billing.ts); without it every account is treated as before plans existed */
  billing?: Billing | null;
  /** where a plan request is announced (the team) */
  teamEmail?: string;
  /** sign-in through Firebase Authentication (production): the project id, and the token check (tests pass their own) */
  firebase?: { projectId: string; verify?: (token: string) => Promise<FirebaseUser> } | null;
  /** told when a key's rules changed in the portal (the site's demos read their key's rules again) */
  onPolicyChange?: (keyId: string) => void }) {
  const store = siteOf(engine.store);
  /** with the portal on app.<domain>, the sign-in is shared with <domain> (the site's "Dashboard" link sees it) */
  const cookieDomain = (req: Req) => {
    const app = process.env.ONEHUMAN_APP_URL ? new URL(process.env.ONEHUMAN_APP_URL).hostname : '';
    const parent = app.split('.').slice(1).join('.');
    const host = String(req.headers.host ?? '').split(':')[0]!.toLowerCase();
    return parent.includes('.') && (host === parent || host.endsWith(`.${parent}`)) ? `; Domain=${parent}` : '';
  };
  const setSession = (req: Req, res: Res, id: string | null) =>
    res.setHeader('Set-Cookie', id
      ? `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${cookieDomain(req)}${opts.secure(req) ? '; Secure' : ''}`
      : `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieDomain(req)}`);
  const accountOf = async (req: Req): Promise<string | null> => {
    const sid = cookies(req)[COOKIE];
    return sid ? store.portalSession(sid) : null;
  };

  // the portal-managed policy (./policy-portal.ts): the server authenticates with its API key, the page with the cookie
  const pol = policyRoutes(engine, {
    accountOf,
    onPolicyChange: opts.onPolicyChange,
    checkPassword: async (account, password) => {
      const email = (await store.accountById(account))?.email;
      const acc = email ? await store.accountByEmail(email) : null;
      return !!acc && verifyPassword(password, acc.pass);
    },
    serverKey: async (req, res) => {
      const auth = (req.headers.authorization ?? '').toString();
      const raw = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      if (!/^oh_live_[a-f0-9]{40}$/.test(raw)) { json(res, 401, { error: 'bad_key' }); return null; }
      const hash = hashKey(raw);
      const key = await store.apiKeyByHash(hash);
      if (!key || key.revoked) { json(res, 401, { error: 'bad_key' }); return null; }
      if (key.expires && key.expires < Date.now()) { json(res, 401, { error: 'expired', message: 'This key expired; create a new one in the portal.' }); return null; }
      return { id: key.id, account: key.account, tag: hash.slice(0, 16) };
    },
  });
  // ---------------------------------------------------------------- licenses
  // A customer's server asks with its API key every few hours and gets a signed token: what its plan allows now
  // (enforce, or observe once an overrun's grace is over), valid 7 days so a portal outage changes nothing.
  const licensing = licenseSigner(engine.secret);
  const LICENSE_TTL_MS = 7 * 86_400_000;
  const licenseGet = async (req: Req, res: Res) => {
    const auth = (req.headers.authorization ?? '').toString();
    const raw = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const key = /^oh_live_[a-f0-9]{40}$/.test(raw) ? await store.apiKeyByHash(hashKey(raw)) : null;
    if (!key || key.revoked) return json(res, 401, { error: 'bad_key', message: 'This API key is not valid. Create one at https://onehuman.ai/portal.' });
    if (key.expires && key.expires < Date.now()) return json(res, 401, { error: 'expired', message: 'This key expired; create a new one in the portal.' });
    const st = opts.billing ? await opts.billing.status(key.account) : null;
    const mode = opts.billing ? await opts.billing.licenseMode(key.account) : 'enforce';
    const token = licensing.issue({ sub: hashKey(raw).slice(0, 16), account: key.account, plan: st?.plan.id ?? 'free', mode, ttlMs: LICENSE_TTL_MS });
    json(res, 200, { token, mode, plan: st?.plan.id ?? 'free', observeFrom: st?.observeFrom ?? null }, { 'Cache-Control': 'no-store' });
  };
  /** the license-signing key's public half: what the package trusts (copied into server/license.ts) */
  const licenseKeys = async (_req: Req, res: Res) => json(res, 200, { keys: [licensing.jwk] }, { 'Cache-Control': 'public, max-age=300' });

  // ---------------------------------------------------------------- agent signature bundles
  // A customer's server asks with its API key. A plan with live signatures gets the newest bundle; Free, or a plan past
  // its limit or out of balance, gets the newest one released 30 days ago or earlier.
  const signatureBundleFor = async (account: string) => {
    if (!opts.billing) return store.latestSignatureBundle();
    const st = await opts.billing.status(account);
    return st.liveSignatures ? store.latestSignatureBundle() : store.signatureBundleIssuedBefore(Date.now() - SIGNATURE_DELAY_MS);
  };
  const signaturesGet = async (req: Req, res: Res) => {
    const auth = (req.headers.authorization ?? '').toString();
    const raw = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const key = /^oh_live_[a-f0-9]{40}$/.test(raw) ? await store.apiKeyByHash(hashKey(raw)) : null;
    if (!key || key.revoked || (key.expires && key.expires < Date.now())) return json(res, 401, { error: 'bad_key' });
    const b = await signatureBundleFor(key.account);
    if (!b) return json(res, 404, { error: 'none', message: 'No signature bundle published yet; the built-in signatures are in use.' });
    const etag = `"sigs-${b.seq}"`;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); res.end(); return; }
    res.setHeader('ETag', etag);
    json(res, 200, { seq: b.seq, issued: b.issued, envelope: b.jws });
  };
  // Publishing needs no account: only a bundle signed with OneHuman's offline signatures key is accepted,
  // and only one newer than the newest stored. The signature is the permission.
  const signaturesPost = async (req: Req, res: Res) => {
    const body = (await readJson(req, 64_000).catch(() => null)) as { envelope?: unknown } | null | undefined;
    const c = verifySignatureBundle(body?.envelope);
    if (!c.ok) return json(res, 400, { error: c.reason });
    const latest = await store.latestSignatureBundle();
    if (latest && c.bundle.seq <= latest.seq) return json(res, 409, { error: 'not_newer', message: `seq ${c.bundle.seq} is not newer than ${latest.seq}` });
    await store.addSignatureBundle(c.bundle.seq, body!.envelope as string, c.bundle.issued);
    json(res, 201, { ok: true, seq: c.bundle.seq });
  };

  // a small in-memory rate limit per key for ingest (serverless instances each have their own; fine)
  const ingestWindow = new Map<string, { n: number; at: number }>();

  const TOO_MANY = { error: 'rate_limited', message: 'Too many attempts. Wait a few minutes and try again.' };
  const L = opts.limits;

  /** with Firebase sign-in, passwords live there: the old password routes are closed, the page uses /session */
  const MOVED = { error: 'moved', message: 'Sign in on onehuman.ai/portal.' };
  const signup = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    if (opts.firebase) return json(res, 410, MOVED);
    if (L && (await L.over('signup', L.client(req), 20, 3600e3))) return json(res, 429, TOO_MANY);
    const b = (await readJson(req, 4000).catch(() => null)) as Record<string, unknown> | null | undefined;
    const email = typeof b?.email === 'string' ? b.email.trim().toLowerCase() : '';
    const password = typeof b?.password === 'string' ? b.password : '';
    if (!EMAIL.test(email)) return json(res, 400, { error: 'bad_email', message: 'Enter a valid e-mail address.' });
    if (password.length < 8 || password.length > 200) return json(res, 400, { error: 'bad_password', message: 'Use at least 8 characters.' });
    const id = await store.createAccount(email, hashPassword(password));
    if (!id) return json(res, 409, { error: 'exists', message: 'An account with this e-mail already exists — sign in instead.' });
    setSession(req, res, await store.createPortalSession(id, SESSION_TTL_MS));
    // the report starts now; the welcome mail must never hold up or break the sign-up
    const source = typeof b?.source === 'string' && /^[a-z0-9-]{1,24}$/.test(b.source) ? b.source : null;
    await store.ensureAccountMeta(id, { started: Date.now(), legacy: false, source }).catch(() => {});
    if (opts.mail) await withTimeout(opts.mail.onSignup(id, email, source), 6000).catch((e) => console.warn('onehuman mail: welcome failed', e));
    json(res, 201, { ok: true, account: { email } });
  };

  const login = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    if (opts.firebase) return json(res, 410, MOVED);
    const b = (await readJson(req, 4000).catch(() => null)) as Record<string, unknown> | null | undefined;
    const email = typeof b?.email === 'string' ? b.email.trim().toLowerCase() : '';
    const password = typeof b?.password === 'string' ? b.password : '';
    if (L && ((await L.over('login', L.client(req), 60, 600e3)) || (EMAIL.test(email) && (await L.over('login-email', email, 10, 600e3))))) return json(res, 429, TOO_MANY);
    const acc = EMAIL.test(email) ? await store.accountByEmail(email) : null;
    if (!acc || !verifyPassword(password, acc.pass)) return json(res, 401, { error: 'invalid', message: 'E-mail or password is wrong.' });
    setSession(req, res, await store.createPortalSession(acc.id, SESSION_TTL_MS));
    json(res, 200, { ok: true, account: { email: acc.email } });
  };

  /**
   * POST /api/v1/portal/session { idToken, source? } — the page signed in with Firebase (e-mail and password, or Google);
   * its ID token opens a portal session. The account is found by its Firebase user (accounts copied from before keep
   * their id as that user's id); an address that already has an account joins it only when Google or Firebase verified
   * it. A new address is a sign-up: the free report starts and the welcome mail goes out.
   */
  const session = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    const fb = opts.firebase;
    if (!fb) return json(res, 404, { error: 'not_found' });
    if (L && (await L.over('session', L.client(req), 60, 600e3))) return json(res, 429, TOO_MANY);
    const b = (await readJson(req, 12_000).catch(() => null)) as Record<string, unknown> | null | undefined;
    const token = typeof b?.idToken === 'string' ? b.idToken : '';
    let u: FirebaseUser;
    try { u = await (fb.verify ?? ((t: string) => verifyFirebaseToken(t, fb.projectId)))(token); }
    catch { return json(res, 401, { error: 'bad_token', message: 'The sign-in did not finish. Try again.' }); }
    if (!EMAIL.test(u.email)) return json(res, 400, { error: 'bad_email', message: 'This sign-in has no usable e-mail address.' });
    let acc = (await store.accountByFirebaseUid(u.uid)) ?? (await store.accountById(u.uid));
    let created = false;
    if (!acc) {
      const existing = await store.accountByEmail(u.email);
      if (existing) {
        if (!u.emailVerified) return json(res, 409, { error: 'exists', message: 'An account with this e-mail already exists. Sign in with its password, or continue with Google.' });
        await store.linkFirebaseUid(existing.id, u.uid);
        acc = existing;
      } else {
        const id = await store.createAccount(u.email, '');
        if (!id) return json(res, 409, { error: 'exists', message: 'An account with this e-mail was just created. Sign in instead.' });
        await store.linkFirebaseUid(id, u.uid);
        acc = (await store.accountById(id))!;
        created = true;
        const source = typeof b?.source === 'string' && /^[a-z0-9-]{1,24}$/.test(b.source) ? b.source : null;
        await store.ensureAccountMeta(id, { started: Date.now(), legacy: false, source }).catch(() => {});
        if (opts.mail) await withTimeout(opts.mail.onSignup(id, u.email, source), 6000).catch((e) => console.warn('onehuman mail: welcome failed', e));
      }
    }
    setSession(req, res, await store.createPortalSession(acc.id, SESSION_TTL_MS));
    json(res, created ? 201 : 200, { ok: true, created, account: { email: acc.email } });
  };

  const logout = async (req: Req, res: Res) => {
    const sid = cookies(req)[COOKIE];
    if (sid) await store.deletePortalSession(sid);
    setSession(req, res, null);
    json(res, 200, { ok: true });
  };

  const me = async (req: Req, res: Res) => {
    const account = await accountOf(req);
    // ?probe=1: public pages ask "signed in?" without a red 401 in every visitor's console
    if (!account) return /[?&]probe=1(&|$)/.test(req.url ?? '') ? json(res, 200, { account: null }) : json(res, 401, { error: 'unauthenticated' });
    const acc = await store.accountById(account);
    const [own, shared] = await Promise.all([store.listApiKeys(account), store.sharedKeys(account)]);
    json(res, 200, { account: acc ? { email: acc.email, created: acc.created } : null, keys: [...own.map((k) => ({ ...k, role: 'owner' })), ...shared.map(({ owner, role, ...k }) => ({ ...k, role, owner }))], trial: acc ? await trialOf(account, acc.created) : null });
  };
  /** the free 30-day report: where this account is in it */
  async function trialOf(account: string, created: number) {
    let m = await store.accountMeta(account);
    if (!m) { await store.ensureAccountMeta(account, { started: created, legacy: true }); m = await store.accountMeta(account); }
    if (m && m.connectedAt == null) {
      const f = await store.accountFirsts(account);
      if (f.first != null) { await store.markAccountConnected(account, f.first); if (f.firstAgent != null) await store.markAccountFirstAgent(account, f.firstAgent); m = await store.accountMeta(account); }
    }
    if (!m) return null;
    const now = Date.now();
    const day = m.connectedAt == null ? null : Math.min(30, Math.floor((now - m.connectedAt) / 86_400_000) + 1);
    return { started: m.started, connectedAt: m.connectedAt, firstAgentAt: m.firstAgentAt, day, ready: m.connectedAt != null && now - m.connectedAt >= 30 * 86_400_000, reportUntil: m.connectedAt == null ? null : m.connectedAt + 30 * 86_400_000, emails: !m.emailOff, mail: !!opts.mail?.configured };
  }
  /** POST /api/v1/portal/email { reports: boolean } — the report mails on or off */
  const emailPrefs = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    const account = await accountOf(req);
    if (!account) return json(res, 401, { error: 'unauthenticated' });
    const b = (await readJson(req, 1000).catch(() => null)) as Record<string, unknown> | null | undefined;
    if (typeof b?.reports !== 'boolean') return json(res, 400, { error: 'bad_body', message: 'Send { reports: true | false }.' });
    const acc = await store.accountById(account);
    await store.ensureAccountMeta(account, { started: acc?.created ?? Date.now(), legacy: true });
    await store.setEmailOff(account, !b.reports);
    json(res, 200, { ok: true, reports: b.reports });
  };

  const createKey = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    const account = await accountOf(req);
    if (!account) return json(res, 401, { error: 'unauthenticated' });
    const b = (await readJson(req, 4000).catch(() => null)) as Record<string, unknown> | null | undefined;
    const made = await makeKey(account, b);
    if ('error' in made) return json(res, 400, made);
    json(res, 201, made);
  };

  /** shared by the portal and the management API */
  async function makeKey(account: string, b: Record<string, unknown> | null | undefined) {
    const name = typeof b?.name === 'string' && NAME.test(b.name.trim()) ? b.name.trim() : 'Default';
    const days = typeof b?.expiresInDays === 'number' && EXPIRY_DAYS.has(b.expiresInDays) ? b.expiresInDays : 0;
    const env = typeof b?.env === 'string' && ENVS.has(b.env) ? b.env : 'production';
    if ((await store.listApiKeys(account)).filter((k) => !k.revoked).length >= 20) return { error: 'too_many', message: 'Revoke a key before creating another (limit 20).' };
    const k = newApiKey();
    const expires = days ? Date.now() + days * 86400e3 : null;
    const id = await store.createApiKey(account, { name, prefix: k.prefix, hash: k.hash, expires, env });
    // the raw key is returned exactly once; only its hash is stored
    return { id, name, prefix: k.prefix, env, expires, key: k.raw };
  }

  const renameKey = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    const account = await accountOf(req);
    if (!account) return json(res, 401, { error: 'unauthenticated' });
    const b = (await readJson(req, 4000).catch(() => null)) as Record<string, unknown> | null | undefined;
    const id = typeof b?.id === 'string' ? b.id : '';
    const name = typeof b?.name === 'string' && NAME.test(b.name.trim()) ? b.name.trim() : '';
    if (!name) return json(res, 400, { error: 'bad_name', message: 'Give the key a name.' });
    json(res, 200, { ok: await store.renameApiKey(id, account, name) });
  };

  /** "paste a key" search: which of my keys is this string? The raw key is hashed here and never stored. */
  const lookupKey = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    const account = await accountOf(req);
    if (!account) return json(res, 401, { error: 'unauthenticated' });
    const b = (await readJson(req, 4000).catch(() => null)) as Record<string, unknown> | null | undefined;
    const raw = typeof b?.key === 'string' ? b.key.trim() : '';
    if (!/^oh_(live|admin)_[a-f0-9]{40}$/.test(raw)) return json(res, 400, { error: 'bad_key', message: 'That is not a OneHuman key.' });
    json(res, 200, { id: await store.apiKeyIdByHash(hashKey(raw), account) });
  };

  // --- management keys (the portal side) ---
  const listAdminKeys = async (req: Req, res: Res) => {
    const account = await accountOf(req);
    if (!account) return json(res, 401, { error: 'unauthenticated' });
    json(res, 200, { keys: await store.listAdminKeys(account) });
  };
  const createAdminKey = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    const account = await accountOf(req);
    if (!account) return json(res, 401, { error: 'unauthenticated' });
    const b = (await readJson(req, 4000).catch(() => null)) as Record<string, unknown> | null | undefined;
    const name = typeof b?.name === 'string' && NAME.test(b.name.trim()) ? b.name.trim() : 'Management key';
    if ((await store.listAdminKeys(account)).filter((k) => !k.revoked).length >= 5) return json(res, 400, { error: 'too_many', message: 'Revoke a management key before creating another (limit 5).' });
    const k = newAdminKey();
    const id = await store.createAdminKey(account, name, k.prefix, k.hash);
    json(res, 201, { id, name, prefix: k.prefix, key: k.raw });
  };
  const revokeAdminKey = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    const account = await accountOf(req);
    if (!account) return json(res, 401, { error: 'unauthenticated' });
    const b = (await readJson(req, 2000).catch(() => null)) as Record<string, unknown> | null | undefined;
    json(res, 200, { ok: await store.revokeAdminKey(typeof b?.id === 'string' ? b.id : '', account) });
  };

  const revokeKey = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    const account = await accountOf(req);
    if (!account) return json(res, 401, { error: 'unauthenticated' });
    const b = (await readJson(req, 2000).catch(() => null)) as Record<string, unknown> | null | undefined;
    const id = typeof b?.id === 'string' ? b.id : '';
    json(res, 200, { ok: await store.revokeApiKey(id, account) });
  };

  /** rotate: the key keeps its name, environment and history; the old secret stops working at once */
  const rotateKey = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    const account = await accountOf(req);
    if (!account) return json(res, 401, { error: 'unauthenticated' });
    const b = (await readJson(req, 2000).catch(() => null)) as Record<string, unknown> | null | undefined;
    const rotated = await rotate(account, typeof b?.id === 'string' ? b.id : '');
    return 'error' in rotated ? json(res, 404, rotated) : json(res, 200, rotated);
  };

  /** shared by the portal and the management API */
  async function rotate(account: string, id: string) {
    const k = newApiKey();
    if (!(await store.rotateApiKey(id, account, k.prefix, k.hash))) return { error: 'not_found', message: 'No live key with that id.' };
    return { id, prefix: k.prefix, key: k.raw };
  }

  /** deleting is for revoked keys only, and it takes their reported decisions with them */
  const deleteKey = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    const account = await accountOf(req);
    if (!account) return json(res, 401, { error: 'unauthenticated' });
    const b = (await readJson(req, 2000).catch(() => null)) as Record<string, unknown> | null | undefined;
    const ok = await store.deleteApiKey(typeof b?.id === 'string' ? b.id : '', account);
    if (!ok) return json(res, 400, { error: 'not_revoked', message: 'Revoke the key first — then it can be deleted.' });
    json(res, 200, { ok });
  };

  const changePassword = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    if (opts.firebase) return json(res, 410, { error: 'moved', message: 'Use "Send me a link" to set a new password.' });
    const account = await accountOf(req);
    if (!account) return json(res, 401, { error: 'unauthenticated' });
    const b = (await readJson(req, 4000).catch(() => null)) as Record<string, unknown> | null | undefined;
    const current = typeof b?.current === 'string' ? b.current : '';
    const next = typeof b?.next === 'string' ? b.next : '';
    if (L && (await L.over('password', account, 10, 600e3))) return json(res, 429, TOO_MANY);
    const acc = await store.accountByEmail((await store.accountById(account))?.email ?? '');
    if (!acc || !verifyPassword(current, acc.pass)) return json(res, 401, { error: 'invalid', message: 'Current password is wrong.' });
    if (next.length < 8 || next.length > 200) return json(res, 400, { error: 'bad_password', message: 'Use at least 8 characters.' });
    await store.setAccountPassword(account, hashPassword(next));
    await store.deleteOtherPortalSessions(account, cookies(req)[COOKIE] ?? '');   // a stolen cookie ends with the old password
    json(res, 200, { ok: true });
  };

  /** the decision log, paged — the portal's "load more" and its CSV export read the same rows */
  const events = async (req: Req, res: Res) => {
    const account = await accountOf(req);
    if (!account) return json(res, 401, { error: 'unauthenticated' });
    const u = url(req);
    const key = u.searchParams.get('key') ?? '';
    if (!(await store.keyRole(key, account))) return json(res, 404, { error: 'not_found' });   // the owner, or an account it was shared with
    const rows = await eventPage(key, u);
    json(res, 200, { key, events: rows, more: rows.length === pageSize(u) });
  };

  /**
   * GET /api/v1/portal/proofs?key=&range=30d[&session=] — the file a business hands an auditor: every signed
   * decision in range (or for one session) plus the keys that verify them. Only proofs that checked out at
   * ingest are included; the auditor re-checks them anyway.
   */
  const proofs = async (req: Req, res: Res) => {
    const account = await accountOf(req);
    if (!account) return json(res, 401, { error: 'unauthenticated' });
    const u = url(req);
    const key = u.searchParams.get('key') ?? '';
    if (!(await store.keyRole(key, account))) return json(res, 404, { error: 'not_found' });   // the owner, or an account it was shared with
    const bundle = await bundleFor(key, u);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="onehuman-proofs-${bundle.range}${bundle.session ? '-' + bundle.session : ''}.json"`, 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(bundle, null, 2));
  };
  async function bundleFor(key: string, u: URL) {
    const rangeName = RANGES[u.searchParams.get('range') ?? '30d'] ? (u.searchParams.get('range') ?? '30d') : '30d';
    const range = RANGES[rangeName]!;
    const sessionRaw = u.searchParams.get('session');
    const session = sessionRaw && /^[a-f0-9]{8,32}$/.test(sessionRaw) ? sessionRaw : null;
    const rows = (await store.telemetryProofs(key, Date.now() - range.since, session)).filter((r) => r.ok);
    const keys = (await store.proofKeysFor(key)).map(({ kty, crv, x, kid }) => ({ kty, crv, x, kid, use: 'sig' as const, alg: 'EdDSA' as const }));
    return proofBundle(rows.map((r) => r.proof), keys, { range: rangeName, session, decisions: rows.length });
  }

  /** POST /api/v1/proof/verify — stateless check of a bundle (or { proofs, keys }). No account, nothing stored. */
  const verifyBundle = async (req: Req, res: Res) => {
    if (L && (await L.over('verify', L.client(req), 30, 600e3))) return json(res, 429, TOO_MANY);
    const b = (await readJson(req, 1_000_000).catch(() => null)) as Record<string, unknown> | null | undefined;
    const list = Array.isArray(b?.proofs) ? (b!.proofs as unknown[]).slice(0, 2000) : null;
    const keys = parseProofKeys(b?.keys);
    if (!list || !keys.length) return json(res, 400, { error: 'bad_body', message: 'Send a proof bundle: { keys: [...], proofs: [...] }.' });
    let valid = 0;
    const results = list.map((p) => {
      const c = verifyProof(typeof p === 'string' ? p : '', keys);
      if (c.valid) valid++;
      return c.valid ? { valid: true, decision: c.payload.jti, resource: c.payload.resource, verdict: c.payload.decision, actor: c.payload.actor, delivered: c.payload.delivered, at: new Date(c.payload.iat * 1000).toISOString(), kid: c.kid, seq: c.payload.audit?.seq ?? null } : { valid: false, reason: c.reason };
    });
    json(res, 200, { checked: list.length, valid, invalid: list.length - valid, results });
  };

  const pageSize = (u: URL) => Math.min(500, Math.max(1, Number(u.searchParams.get('limit')) || 100));
  const eventPage = (key: string, u: URL) => {
    const range = RANGES[u.searchParams.get('range') ?? '7d'] ?? RANGES['7d']!;
    const before = Number(u.searchParams.get('before'));
    return store.telemetryEvents(key, Date.now() - range.since, Number.isFinite(before) && before > 0 ? before : null, pageSize(u));
  };

  const stats = async (req: Req, res: Res) => {
    const account = await accountOf(req);
    if (!account) return json(res, 401, { error: 'unauthenticated' });
    const u = url(req);
    const key = u.searchParams.get('key') ?? '';
    const range = RANGES[u.searchParams.get('range') ?? '7d'] ?? RANGES['7d']!;
    if (!(await store.keyRole(key, account))) return json(res, 404, { error: 'not_found' });   // the owner, or an account it was shared with
    const now = Date.now();
    json(res, 200, { key, range: { since: now - range.since, bucketMs: range.bucket }, now, ...(await store.telemetryStats(key, now - range.since, range.bucket)), feedback: await store.telemetryFeedback(key, now - range.since) });
  };

  /**
   * GET /api/v1/portal/health?key=&range=7d — the integration check: four lights (server reporting, browser
   * signals, signatures verify, policy enforcing) and the "people stopped" counter. Everything comes from what
   * the key already reported; nothing is sent to the customer's site.
   */
  const health = async (req: Req, res: Res) => {
    const account = await accountOf(req);
    if (!account) return json(res, 401, { error: 'unauthenticated' });
    const u = url(req);
    const key = u.searchParams.get('key') ?? '';
    if (!(await store.keyRole(key, account))) return json(res, 404, { error: 'not_found' });   // the owner, or an account it was shared with
    json(res, 200, await healthFor(key, u));
  };
  async function healthFor(key: string, u: URL) {
    const rangeName = RANGES[u.searchParams.get('range') ?? '7d'] ? (u.searchParams.get('range') ?? '7d') : '7d';
    const now = Date.now();
    const h = await store.telemetryHealth(key, now - RANGES[rangeName]!.since);
    return { key, range: rangeName, now, ...h, checks: integrationChecks(h, now) };
  }

  /**
   * GET /api/v1/portal/weekly?key= — the weekly report: this week against last week for one key, the agents
   * that are new on this site, and what changed in the agents themselves (the same for every customer).
   */
  const weekly = async (req: Req, res: Res) => {
    const account = await accountOf(req);
    if (!account) return json(res, 401, { error: 'unauthenticated' });
    const key = url(req).searchParams.get('key') ?? '';
    if (!(await store.keyRole(key, account))) return json(res, 404, { error: 'not_found' });   // the owner, or an account it was shared with
    json(res, 200, await weeklyFor(key));
  };
  /** The design-partner report for one key, from what its server reported (same builder as `npx onehumanai report`). */
  async function reportFor(key: string, days: number, account: string, now = Date.now(), range?: { from: number; to: number }) {
    const to = range ? range.to : now;
    const from = range ? range.from : now - days * 86_400_000;
    const name = (await store.apiKeyById(key, account))?.name ?? (await store.sharedKeys(account)).find((k) => k.id === key)?.name ?? '';
    return buildReport(await store.telemetryDecisions(key, from, to), { from, to, now, source: 'portal', app: name });
  }
  const report = async (req: Req, res: Res) => {
    const account = await accountOf(req);
    if (!account) return json(res, 401, { error: 'unauthenticated' });
    const u = url(req);
    const key = u.searchParams.get('key') ?? '';
    if (!(await store.keyRole(key, account))) return json(res, 404, { error: 'not_found' });   // the owner, or an account it was shared with
    const days = Math.min(90, Math.max(1, Number(u.searchParams.get('days') ?? 30) || 30));
    // an exact period (the 30 days of the free report, from the day the app connected): at most 90 days, not in the future
    const now = Date.now();
    const qFrom = Number(u.searchParams.get('from')), qTo = Number(u.searchParams.get('to'));
    const range = qFrom > 0 && qTo > qFrom ? { to: Math.min(qTo, now), from: Math.max(qFrom, Math.min(qTo, now) - 90 * 86_400_000) } : undefined;
    const r = await reportFor(key, days, account, now, range && range.to > range.from ? range : undefined);
    if (u.searchParams.get('format') !== 'html') return json(res, 200, r);
    // a line on screen only (not on paper): how to pass it on
    const html = renderReportHtml(r).replace('<div class="page">', '<style>@media print{.fwd{display:none}}</style><div class="fwd" style="max-width:820px;margin:24px auto 0;padding:10px 14px;border-radius:8px;background:#0b0c0f;color:#fff;font:13px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">To forward this report, save it as a PDF: <b>⌘P</b> on a Mac, <b>Ctrl+P</b> on Windows, then choose “Save as PDF”.</div><div class="page">');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(html) });
    res.end(html);
  };
  async function weeklyFor(key: string, now = Date.now()) {
    const WEEK = 7 * 24 * 3600e3;
    const [cur, prev] = await Promise.all([store.telemetryWeek(key, now - WEEK, now + 60_000), store.telemetryWeek(key, now - 2 * WEEK, now - WEEK)]);
    const seenBefore = new Set(prev.tools.map((t) => t.tool));
    return {
      key, now, from: now - WEEK, week: cur, previous: prev,
      newAgents: cur.tools.filter((t) => !seenBefore.has(t.tool)).map((t) => t.tool),
      goneAgents: prev.tools.filter((t) => !cur.tools.some((c) => c.tool === t.tool)).map((t) => t.tool),
      news: newsSince(now - 4 * WEEK, now),
    };
  }

  /** POST /api/v1/portal/feedback { key, id, verdict: 'correct'|'wrong'|null, note? } — the customer grades one decision. */
  const feedback = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    const account = await accountOf(req);
    if (!account) return json(res, 401, { error: 'unauthenticated' });
    const b = (await readJson(req, 4000).catch(() => null)) as Record<string, unknown> | null | undefined;
    const key = typeof b?.key === 'string' ? b.key : '';
    const id = typeof b?.id === 'number' && Number.isInteger(b.id) && b.id > 0 ? b.id : 0;
    const verdict = b?.verdict === 'correct' || b?.verdict === 'wrong' ? b.verdict : b?.verdict === null ? null : undefined;
    const note = typeof b?.note === 'string' ? b.note.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) : null;
    if (!id || verdict === undefined || !(await store.apiKeyOwned(key, account))) return json(res, 400, { error: 'bad_feedback', message: 'Send { key, id, verdict: "correct" | "wrong" | null }.' });
    json(res, 200, { ok: await store.setTelemetryFeedback(key, id, verdict, note) });
  };

  /**
   * GET /api/v1/portal/agents?range=30d — the agent inventory: every AI agent product seen in the account's customer
   * sessions (or "unnamed" when only behaviour gave it away), where it went and what the rules did or would do.
   */
  const agents = async (req: Req, res: Res) => {
    const account = await accountOf(req);
    if (!account) return json(res, 401, { error: 'unauthenticated' });
    const rangeName = RANGES[url(req).searchParams.get('range') ?? '30d'] ? (url(req).searchParams.get('range') ?? '30d') : '30d';
    const now = Date.now();
    const since = now - RANGES[rangeName]!.since;
    const [events, ov, own, shared] = await Promise.all([store.telemetryAgentEvents(account, since), store.telemetryOverview(account, since, RANGES[rangeName]!.bucket), store.listApiKeys(account), store.sharedKeys(account)]);
    const keys = [...own, ...shared];
    const keyNames = new Map(keys.map((k) => [k.id, k.name]));
    // a session's agent is named by any tool seen in it; a session with agent behaviour and no tool is "unnamed"
    const sessionTools = new Map<string, Set<string>>();
    for (const e of events) { const set = sessionTools.get(e.session) ?? new Set<string>(); for (const t of e.tools) set.add(t); sessionTools.set(e.session, set); }
    type Out = { allow: number; mask: number; step_up: number; block: number; approved: number };
    const zero = (): Out => ({ allow: 0, mask: 0, step_up: 0, block: 0, approved: 0 });
    const by = new Map<string, { tool: string; sessions: Set<string>; apps: Set<string>; first: number; last: number; actions: number; observe: number; outcomes: Out; resources: Map<string, { n: number; outcomes: Out }> }>();
    for (const e of events) {
      const tools = [...(sessionTools.get(e.session) ?? [])];
      for (const tool of tools.length ? tools : ['unnamed']) {
        const a = by.get(tool) ?? { tool, sessions: new Set<string>(), apps: new Set<string>(), first: e.at, last: e.at, actions: 0, observe: 0, outcomes: zero(), resources: new Map() };
        a.sessions.add(e.session); a.apps.add(keyNames.get(e.key) ?? 'app'); a.first = Math.min(a.first, e.at); a.last = Math.max(a.last, e.at); a.actions++;
        const outcome = e.reasons.includes('STEP_UP_PASSED') ? 'approved' : (e.computed as keyof Out) in a.outcomes ? (e.computed as keyof Out) : 'allow';
        if (e.computed !== e.decision) a.observe++;
        a.outcomes[outcome]++;
        const r = a.resources.get(e.resource) ?? { n: 0, outcomes: zero() };
        r.n++; r.outcomes[outcome]++; a.resources.set(e.resource, r);
        by.set(tool, a);
      }
    }
    const list = [...by.values()].sort((x, y) => y.sessions.size - x.sessions.size || y.actions - x.actions).map((a) => ({
      tool: a.tool, sessions: a.sessions.size, apps: [...a.apps], first: a.first, last: a.last, actions: a.actions, observe: a.observe, outcomes: a.outcomes,
      resources: [...a.resources.entries()].sort((x, y) => y[1].n - x[1].n).slice(0, 8).map(([resource, r]) => ({ resource, ...r })),
    }));
    const sessions = ov.totals.reduce((n, t) => n + t.sessions, 0);
    const agentSessions = new Set(events.map((e) => e.session)).size;
    json(res, 200, { range: rangeName, since, now, totals: { sessions, agentSessions, products: list.filter((a) => a.tool !== 'unnamed').length }, agents: list });
  };

  const overview = async (req: Req, res: Res) => {
    const account = await accountOf(req);
    if (!account) return json(res, 401, { error: 'unauthenticated' });
    const range = RANGES[url(req).searchParams.get('range') ?? '7d'] ?? RANGES['7d']!;
    const now = Date.now();
    const [own, shared] = await Promise.all([store.listApiKeys(account), store.sharedKeys(account)]);
    json(res, 200, { range: { since: now - range.since, bucketMs: range.bucket }, now, keys: [...own, ...shared], ...(await store.telemetryOverview(account, now - range.since, range.bucket)) });
  };

  // ---------------------------------------------------------------- connecting an app from the command line
  // `npx onehumanai init` (or `connect`) asks for a short code and opens the portal; the person signs in, checks the
  // code against the one in the terminal and presses Connect; the CLI, polling with its secret token, receives the new
  // key once. Until then the raw key is kept sealed with a key derived from the deployment secret (minutes at most).
  const CONNECT_TTL = 10 * 60_000;
  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O or 1/I: read aloud, typed, compared at a glance
  const sealKey = Buffer.from(hkdfSync('sha256', engine.secret, 'onehuman', 'cli-connect-seal', 32));
  const seal = (raw: string) => { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', sealKey, iv); const ct = Buffer.concat([c.update(raw, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url'); };
  const unseal = (sealed: string) => { const b = Buffer.from(sealed, 'base64url'); const d = createDecipheriv('aes-256-gcm', sealKey, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'); };
  const connectId = (token: string) => createHash('sha256').update(`connect:${token}`).digest('hex');
  const newCode = () => { const b = randomBytes(8); const c = [...b].map((x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join(''); return `${c.slice(0, 4)}-${c.slice(4)}`; };

  /** POST /api/v1/connect/start { name? } — the CLI asks to connect an app: a code to show, a token to poll with */
  const connectStart = async (req: Req, res: Res) => {
    if (L && (await L.over('connect', clientIp(req), 30, 3600e3))) return json(res, 429, TOO_MANY);
    const b = (await readJson(req, 2000).catch(() => null)) as Record<string, unknown> | null | undefined;
    const name = typeof b?.name === 'string' && NAME.test(b.name.trim()) ? b.name.trim() : 'My app';
    const token = randomBytes(32).toString('base64url'), code = newCode(), expires = Date.now() + CONNECT_TTL;
    const origin = [req.headers['x-vercel-ip-city'], req.headers['x-vercel-ip-country']].filter(Boolean).map((x) => decodeURIComponent(String(x))).join(', ') || null;
    await store.createConnect({ id: connectId(token), code, name, origin, expires });
    // the link goes back to the portal the CLI asked (onehuman.ai, or a local copy while developing)
    json(res, 201, { code, token, expires, interval: 2, url: `${url(req).origin}/portal?connect=${encodeURIComponent(code)}` });
  };
  /** GET /api/v1/connect/poll  (Authorization: Bearer <token>) — 202 while waiting; the key once when approved */
  const connectPoll = async (req: Req, res: Res) => {
    const auth = String(req.headers.authorization ?? '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) return json(res, 401, { error: 'bad_token' });
    const id = connectId(token);
    const c = await store.connectById(id);
    if (!c) return json(res, 404, { error: 'not_found' });
    if (c.status === 'denied') return json(res, 410, { error: 'denied', message: 'The connection was declined in the portal.' });
    if (c.status === 'used') return json(res, 410, { error: 'used', message: 'This key was already handed over.' });
    if (c.status === 'pending') return c.expires > Date.now() ? json(res, 202, { status: 'pending' }) : json(res, 410, { error: 'expired', message: 'The code expired. Run the command again.' });
    const taken = await store.takeConnect(id);
    if (!taken?.sealed) return json(res, 410, { error: 'used' });
    const acc = taken.account ? await store.accountById(taken.account) : null;
    json(res, 200, { key: unseal(taken.sealed), name: taken.name, account: acc?.email ?? null });
  };
  /** GET /api/v1/portal/connect?code= — what the portal shows before the person decides */
  const connectPeek = async (req: Req, res: Res) => {
    const account = await accountOf(req);
    if (!account) return json(res, 401, { error: 'unauthenticated' });
    const code = (url(req).searchParams.get('code') ?? '').toUpperCase().trim();
    const c = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code) ? await store.connectByCode(code) : null;
    if (!c) return json(res, 404, { error: 'not_found', message: 'This code is not valid any more. Run the command in your terminal again.' });
    json(res, 200, { code: c.code, name: c.name, origin: c.origin, created: c.created, expires: c.expires, status: c.status });
  };
  /** POST /api/v1/portal/connect { code, approve } — the person connects the app (a new key on this account) or declines */
  const connectDecide = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    const account = await accountOf(req);
    if (!account) return json(res, 401, { error: 'unauthenticated' });
    const b = (await readJson(req, 2000).catch(() => null)) as Record<string, unknown> | null | undefined;
    const code = typeof b?.code === 'string' ? b.code.toUpperCase().trim() : '';
    const c = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code) ? await store.connectByCode(code) : null;
    if (!c || c.status !== 'pending') return json(res, 404, { error: 'not_found', message: 'This code is not valid any more. Run the command in your terminal again.' });
    if (b?.approve !== true) { await store.decideConnect(c.id, { status: 'denied', account }); return json(res, 200, { status: 'denied' }); }
    const made = await makeKey(account, { name: c.name });
    if ('error' in made) return json(res, 400, made);
    if (!(await store.decideConnect(c.id, { status: 'approved', account, keyId: made.id, sealed: seal(made.key) }))) {
      await store.revokeApiKey(made.id, account).catch(() => false);
      return json(res, 409, { error: 'not_pending', message: 'This code was already used or expired.' });
    }
    json(res, 200, { status: 'approved', key: { id: made.id, name: made.name, prefix: made.prefix } });
  };

  // ---------------------------------------------------------------- sharing a key by e-mail: its statistics, and if the owner says so its rules
  const INVITE_TTL = 14 * 86_400_000;
  const inviteHash = (raw: string) => createHash('sha256').update(`invite:${raw}`).digest('hex');
  /** the account that owns `key`, or a reply saying why not */
  async function ownerOf(req: Req, res: Res, key: string): Promise<string | null> {
    if (!sameOrigin(req)) { json(res, 403, { error: 'origin' }); return null; }
    const account = await accountOf(req);
    if (!account) { json(res, 401, { error: 'unauthenticated' }); return null; }
    if (!(await store.apiKeyOwned(key, account))) { json(res, 404, { error: 'not_found', message: 'Only the owner of this key can share it.' }); return null; }
    return account;
  }
  const shareRole = (v: unknown): 'viewer' | 'editor' => (v === 'viewer' ? 'viewer' : 'editor');
  /** POST /api/v1/portal/keys/share { key, email, role? } — invite an address: 'editor' (default) sees the statistics and manages the rules, 'viewer' only sees */
  const shareKey = async (req: Req, res: Res) => {
    const b = (await readJson(req, 4000).catch(() => null)) as Record<string, unknown> | null | undefined;
    const key = typeof b?.key === 'string' ? b.key : '';
    const account = await ownerOf(req, res, key);
    if (!account) return;
    const email = typeof b?.email === 'string' ? b.email.trim().toLowerCase() : '';
    if (!EMAIL.test(email)) return json(res, 400, { error: 'bad_email', message: 'Enter a valid e-mail address.' });
    if (L && (await L.over('invite', account, 30, 3600e3))) return json(res, 429, TOO_MANY);
    const me = await store.accountById(account);
    if (me?.email === email) return json(res, 400, { error: 'self', message: 'That is your own address: you already see this key.' });
    const [members, pending] = await Promise.all([store.keyShares(key), store.keyInvites(key)]);
    if (members.some((m) => m.email === email)) return json(res, 409, { error: 'member', message: 'This address already sees this key.' });
    if (members.length + pending.length >= 20) return json(res, 400, { error: 'too_many', message: 'A key is shared with at most 20 people. Remove someone first.' });
    // a second invitation to the same address replaces the first (its link stops working)
    for (const i of pending.filter((x) => x.email === email)) await store.cancelKeyInvite(key, i.id);
    const raw = randomBytes(24).toString('base64url');
    const id = inviteHash(raw), expires = Date.now() + INVITE_TTL;
    await store.createKeyInvite({ id, keyId: key, email, role: shareRole(b?.role), invitedBy: account, expires });
    const app = (await store.apiKeyById(key, account))?.name ?? 'an app';
    const link = `${opts.mail?.base ?? 'https://onehuman.ai'}/portal?invite=${raw}`;
    const mailed = opts.mail ? await withTimeout(opts.mail.sendInvite(email, { inviteId: id, inviter: me?.email ?? 'A OneHuman user', app, link, expires }), 8000).catch((e) => { console.warn('onehuman mail: invite failed', e); return 'failed' as const; }) : 'off';
    json(res, 201, { ok: true, email, expires, link, mailed });
  };
  /** GET /api/v1/portal/keys/access?key= — who sees this key, and who is invited */
  const keyAccess = async (req: Req, res: Res) => {
    const account = await accountOf(req);
    if (!account) return json(res, 401, { error: 'unauthenticated' });
    const key = url(req).searchParams.get('key') ?? '';
    if (!(await store.apiKeyOwned(key, account))) return json(res, 404, { error: 'not_found' });
    const [members, invites] = await Promise.all([store.keyShares(key), store.keyInvites(key)]);
    json(res, 200, { key, members: members.map((m) => ({ account: m.account, email: m.email, role: m.role, since: m.created })), invites: invites.map((i) => ({ id: i.id, email: i.email, role: i.role, sent: i.created, expires: i.expires })) });
  };
  /** POST /api/v1/portal/keys/share-role { key, account, role } — the owner lets someone manage the rules, or only see */
  const shareRoleSet = async (req: Req, res: Res) => {
    const b = (await readJson(req, 4000).catch(() => null)) as Record<string, unknown> | null | undefined;
    const key = typeof b?.key === 'string' ? b.key : '';
    const account = await ownerOf(req, res, key);
    if (!account) return;
    const who = typeof b?.account === 'string' ? b.account : '';
    if (!(await store.keyShares(key)).some((m) => m.account === who)) return json(res, 404, { error: 'not_member' });
    const role = shareRole(b?.role);
    await store.addKeyShare(key, who, role, account);
    json(res, 200, { ok: true, role });
  };
  /** POST /api/v1/portal/keys/unshare { key, account } — the owner removes someone; anyone may remove themselves */
  const unshareKey = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    const account = await accountOf(req);
    if (!account) return json(res, 401, { error: 'unauthenticated' });
    const b = (await readJson(req, 4000).catch(() => null)) as Record<string, unknown> | null | undefined;
    const key = typeof b?.key === 'string' ? b.key : '';
    const who = typeof b?.account === 'string' ? b.account : account;
    if (who !== account && !(await store.apiKeyOwned(key, account))) return json(res, 404, { error: 'not_found' });
    json(res, (await store.removeKeyShare(key, who)) ? 200 : 404, { ok: true });
  };
  /** POST /api/v1/portal/keys/invites/cancel { key, id } */
  const cancelInvite = async (req: Req, res: Res) => {
    const b = (await readJson(req, 4000).catch(() => null)) as Record<string, unknown> | null | undefined;
    const key = typeof b?.key === 'string' ? b.key : '';
    if (!(await ownerOf(req, res, key))) return;
    const id = typeof b?.id === 'string' ? b.id : '';
    json(res, (await store.cancelKeyInvite(key, id)) ? 200 : 404, { ok: true });
  };
  /** an invitation's state from its link: what it is for, whether it still works */
  async function inviteState(raw: string) {
    const i = /^[A-Za-z0-9_-]{20,64}$/.test(raw) ? await store.keyInvite(inviteHash(raw)) : null;
    if (!i) return null;
    const [inviter, owned] = await Promise.all([store.accountById(i.invitedBy), store.apiKeyById(i.keyId, i.invitedBy)]);
    return { i, inviter: inviter?.email ?? '', app: owned?.name ?? 'an app', state: i.acceptedAt != null ? 'used' : i.expires <= Date.now() ? 'expired' : !owned || owned.revoked ? 'gone' : 'open' };
  }
  /** GET /api/v1/portal/invites/peek?token= — for the sign-in screen: who invited which address to what */
  const peekInvite = async (req: Req, res: Res) => {
    const s = await inviteState(url(req).searchParams.get('token') ?? '');
    if (!s) return json(res, 404, { error: 'not_found', message: 'This invitation link does not work. Ask for a new one.' });
    json(res, 200, { email: s.i.email, inviter: s.inviter, app: s.app, state: s.state, expires: s.i.expires });
  };
  /** POST /api/v1/portal/invites/accept { token } — the invited address, signed in, now sees the key */
  const acceptInvite = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    const account = await accountOf(req);
    if (!account) return json(res, 401, { error: 'unauthenticated' });
    const b = (await readJson(req, 4000).catch(() => null)) as Record<string, unknown> | null | undefined;
    const s = await inviteState(typeof b?.token === 'string' ? b.token : '');
    if (!s) return json(res, 404, { error: 'not_found', message: 'This invitation link does not work. Ask for a new one.' });
    if (s.state === 'used') return json(res, 410, { error: 'used', message: 'This invitation was already used.' });
    if (s.state === 'expired') return json(res, 410, { error: 'expired', message: 'This invitation expired. Ask for a new one.' });
    if (s.state === 'gone') return json(res, 410, { error: 'gone', message: 'The key behind this invitation no longer exists.' });
    const me = await store.accountById(account);
    // the link was sent to one address: it opens the key for that address only
    if (me?.email !== s.i.email) return json(res, 403, { error: 'other_email', message: `This invitation is for ${s.i.email}. Sign in with that address.` });
    if (s.i.invitedBy === account) return json(res, 400, { error: 'self', message: 'You own this key.' });
    if (!(await store.acceptKeyInvite(s.i.id, account))) return json(res, 410, { error: 'used', message: 'This invitation was already used.' });
    await store.addKeyShare(s.i.keyId, account, s.i.role, s.i.invitedBy);
    json(res, 200, { ok: true, key: s.i.keyId, app: s.app, inviter: s.inviter });
  };

  /** POST /api/v1/ingest — Authorization: Bearer oh_live_…; body { events: [...] } */
  const ingest = async (req: Req, res: Res) => {
    const auth = (req.headers.authorization ?? '').toString();
    const raw = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!/^oh_live_[a-f0-9]{40}$/.test(raw)) return json(res, 401, { error: 'bad_key' });
    const key = await store.apiKeyByHash(hashKey(raw));
    if (!key || key.revoked) return json(res, 401, { error: 'bad_key' });
    const now = Date.now();
    if (key.expires && key.expires < now) return json(res, 401, { error: 'expired', message: 'This key expired; create a new one in the portal.' });
    const w = ingestWindow.get(key.id);
    if (w && now - w.at < 60_000) { if (w.n >= 120) return json(res, 429, { error: 'rate_limited' }); w.n++; } else ingestWindow.set(key.id, { n: 1, at: now });
    const b = (await readJson(req, 400_000).catch(() => null)) as Record<string, unknown> | null | undefined;
    const list = Array.isArray(b?.events) ? (b!.events as unknown[]).slice(0, 200) : null;
    if (!list) return json(res, 400, { error: 'bad_body', message: 'Send { events: [...] }.' });
    const reported = parseProofKeys(b?.keys);
    if (reported.length) await store.rememberProofKeys(key.id, reported);
    const keys = [...reported, ...(await store.proofKeysFor(key.id))];
    const events: TelemetryEvent[] = [];
    let signed = 0;
    for (const e of list) {
      const ev = parseEvent(e, now);
      if (!ev) continue;
      if (ev.proof) {
        // a valid signature is not enough: the proof must be about *this* event, or a deployment could
        // attach one real proof to many made-up events
        const check = verifyProof(ev.proof, keys);
        ev.proofKid = check.valid ? check.kid : null;
        ev.proofOk = check.valid && check.payload.resource === ev.resource && check.payload.decision === ev.decision && check.payload.actor === ev.actor;
        if (ev.proofOk) signed++;
      }
      events.push(ev);
    }
    const stored = await store.insertTelemetry(key.id, events, now);
    // the customers in whose sessions an agent acted, once a month each, for the owner's plan
    if (opts.billing) await withTimeout(opts.billing.meter(key.account, key.id, events), 5000).catch((e) => console.warn('onehuman billing: meter failed', e));
    // the first report and the first AI agent each get a mail; never at the cost of the ingest answer
    if (stored && opts.mail) {
      const name = (await store.apiKeyById(key.id, key.account))?.name ?? '';
      await withTimeout(opts.mail.onIngest(key.account, name, events), 5000).catch((e) => console.warn('onehuman mail: ingest hook failed', e));
    }
    json(res, 202, { accepted: events.length, stored, duplicates: events.length - stored, dropped: list.length - events.length, signed });
  };

  /**
   * Management API — everything the portal can do, over HTTP, with `Authorization: Bearer oh_admin_…`.
   * This is what lets a coding agent set OneHuman up end to end without a human opening the portal.
   */
  const manage = async (req: Req, res: Res) => {
    const auth = (req.headers.authorization ?? '').toString();
    const raw = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!/^oh_admin_[a-f0-9]{40}$/.test(raw)) return json(res, 401, { error: 'bad_key', message: 'Send Authorization: Bearer oh_admin_… (create one in the portal under Management keys).' });
    const admin = await store.adminKeyByHash(hashKey(raw));
    if (!admin || admin.revoked) return json(res, 401, { error: 'bad_key' });
    void store.touchAdminKey(admin.id).catch(() => {});
    const account = admin.account;
    const u = url(req);
    const path = u.pathname.replace(/^\/api\/v1\/manage\/?/, '').replace(/\/$/, '');
    const method = req.method ?? 'GET';
    const body = method === 'GET' ? null : ((await readJson(req, 8000).catch(() => null)) as Record<string, unknown> | null | undefined);

    if (path === '' || path === 'me') {
      const acc = await store.accountById(account);
      return json(res, 200, { account: acc ? { email: acc.email, created: acc.created } : null, endpoints: MANAGE_ENDPOINTS });
    }
    if (path === 'keys' && method === 'GET') return json(res, 200, { keys: await store.listApiKeys(account) });
    if (path === 'keys' && method === 'POST') {
      const made = await makeKey(account, body);
      return 'error' in made ? json(res, 400, made) : json(res, 201, made);
    }
    if (path.endsWith('/rotate') && method === 'POST') {
      const rotated = await rotate(account, path.slice(5, -7));
      return 'error' in rotated ? json(res, 404, rotated) : json(res, 200, rotated);
    }
    if (path.startsWith('keys/') && method === 'DELETE') {
      const id = path.slice(5);
      return json(res, 200, { ok: await store.revokeApiKey(id, account) });
    }
    if (path === 'overview' && method === 'GET') {
      const range = RANGES[u.searchParams.get('range') ?? '7d'] ?? RANGES['7d']!;
      const now = Date.now();
      return json(res, 200, { range: { since: now - range.since, bucketMs: range.bucket }, now, keys: await store.listApiKeys(account), ...(await store.telemetryOverview(account, now - range.since, range.bucket)) });
    }
    if (path === 'stats' && method === 'GET') {
      const key = u.searchParams.get('key') ?? '';
      const range = RANGES[u.searchParams.get('range') ?? '7d'] ?? RANGES['7d']!;
      if (!(await store.apiKeyOwned(key, account))) return json(res, 404, { error: 'not_found', message: 'No key with that id in this account. List them with GET /api/v1/manage/keys.' });
      const now = Date.now();
      return json(res, 200, { key, range: { since: now - range.since, bucketMs: range.bucket }, now, ...(await store.telemetryStats(key, now - range.since, range.bucket)) });
    }
    if (path === 'feedback' && method === 'POST') {
      const key = typeof body?.key === 'string' ? body.key : '';
      const id = typeof body?.id === 'number' && Number.isInteger(body.id) ? body.id : 0;
      const verdict = body?.verdict === 'correct' || body?.verdict === 'wrong' ? body.verdict : null;
      if (!id || !(await store.apiKeyOwned(key, account))) return json(res, 400, { error: 'bad_feedback' });
      return json(res, 200, { ok: await store.setTelemetryFeedback(key, id, verdict, typeof body?.note === 'string' ? body.note.slice(0, 200) : null) });
    }
    if (path === 'proofs' && method === 'GET') {
      const key = u.searchParams.get('key') ?? '';
      if (!(await store.apiKeyOwned(key, account))) return json(res, 404, { error: 'not_found' });
      return json(res, 200, await bundleFor(key, u));
    }
    if (path === 'health' && method === 'GET') {
      const key = u.searchParams.get('key') ?? '';
      if (!(await store.apiKeyOwned(key, account))) return json(res, 404, { error: 'not_found' });
      return json(res, 200, await healthFor(key, u));
    }
    if (path === 'report' && method === 'GET') {
      const key = u.searchParams.get('key') ?? '';
      if (!(await store.apiKeyOwned(key, account))) return json(res, 404, { error: 'not_found' });
      return json(res, 200, await reportFor(key, Math.min(90, Math.max(1, Number(u.searchParams.get('days') ?? 30) || 30)), account));
    }
    if (path === 'weekly' && method === 'GET') {
      const key = u.searchParams.get('key') ?? '';
      if (!(await store.apiKeyOwned(key, account))) return json(res, 404, { error: 'not_found' });
      return json(res, 200, await weeklyFor(key));
    }
    if (path === 'events' && method === 'GET') {
      const key = u.searchParams.get('key') ?? '';
      if (!(await store.apiKeyOwned(key, account))) return json(res, 404, { error: 'not_found' });
      const rows = await eventPage(key, u);
      return json(res, 200, { key, events: rows, more: rows.length === pageSize(u) });
    }
    const adminName = (await store.listAdminKeys(account)).find((k) => k.id === admin.id)?.name ?? 'key';
    if (await pol.manage(path, method, account, adminName, u, body, res)) return;
    return json(res, 404, { error: 'unknown_endpoint', endpoints: MANAGE_ENDPOINTS });
  };

  // ---------------------------------------------------------------- plan and usage (the Plan page)
  const planView = async (account: string) => {
    const st = await opts.billing!.status(account);
    const months: string[] = [];
    const d = new Date(`${st.month}-01T00:00:00Z`);
    for (let i = 1; i <= 5; i++) months.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
    const history = await Promise.all(months.map(async (m) => ({ month: m, ...(await store.usageCounts(account, m)) })));
    return {
      plan: st.plan, plans: PLAN_IDS.map((id) => PLANS[id]), month: st.month, usage: st.usage, over: st.over, liveSignatures: st.liveSignatures, licenseMode: st.licenseMode, observeFrom: st.observeFrom,
      estimateCents: st.estimateCents, balanceCents: st.billing.balanceCents, requested: st.billing.requested, requestedAt: st.billing.requestedAt,
      history: history.filter((h) => h.total > 0), ledger: await store.billingLedger(account, 10),
    };
  };
  const planGet = async (req: Req, res: Res) => {
    const account = await accountOf(req);
    if (!account) return json(res, 401, { error: 'unauthenticated' });
    if (!opts.billing) return json(res, 404, { error: 'not_found' });
    json(res, 200, await planView(account), { 'Cache-Control': 'no-store' });
  };
  /** Free applies at once; a paid plan is a request: the team sends payment details and switches it on */
  const planPost = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    const account = await accountOf(req);
    if (!account) return json(res, 401, { error: 'unauthenticated' });
    if (!opts.billing) return json(res, 404, { error: 'not_found' });
    const b = (await readJson(req, 2000).catch(() => null)) as { plan?: unknown; note?: unknown } | null | undefined;
    const id = PLAN_IDS.find((x) => x === b?.plan);
    if (!id) return json(res, 400, { error: 'bad_plan', message: `Choose one of: ${PLAN_IDS.join(', ')}.` });
    const acc = await store.accountById(account);
    const r = await opts.billing.choose(account, id, acc?.email ?? 'owner');
    if (r.requested && opts.mail) {
      const note = typeof b?.note === 'string' ? b.note.slice(0, 500) : '';
      const st = await opts.billing.status(account);
      await withTimeout(opts.mail.sendTeamNotice(opts.teamEmail ?? 'arif@onehuman.ai', `${acc?.email ?? account} wants ${PLANS[id].name}`, [
        ['Account', acc?.email ?? account], ['Wants', PLANS[id].name], ['Now on', st.plan.name],
        ['Agent-active customers this month', String(st.usage.total)], ['Note', note || '—'],
      ], `${opts.mail.base}/admin-panel#billing`), 5000).catch((e) => console.warn('onehuman billing: team notice failed', e));
    }
    json(res, 200, { ...r, view: await planView(account) });
  };

  return { licenseGet, licenseKeys, planGet, planPost, policy: pol, accountOf, emailPrefs, signup, login, session, logout, me, connectStart, connectPoll, connectPeek, connectDecide, shareKey, shareRoleSet, keyAccess, unshareKey, cancelInvite, peekInvite, acceptInvite, createKey, renameKey, lookupKey, revokeKey, rotateKey, deleteKey, changePassword, events, proofs, verifyBundle, feedback, health, weekly, agents, report, signaturesGet, signaturesPost, listAdminKeys, createAdminKey, revokeAdminKey, stats, overview, ingest, manage };
}

export const MANAGE_ENDPOINTS = [
  'GET    /api/v1/manage/me                     — whose account this key administers',
  'GET    /api/v1/manage/keys                   — list project keys',
  'POST   /api/v1/manage/keys                   — create one {name, expiresInDays?: 0|7|30|90|365, env?: production|staging|development} → returns the raw key once',
  'POST   /api/v1/manage/keys/:id/rotate        — new secret for the same key → returns the raw key once',
  'DELETE /api/v1/manage/keys/:id               — revoke one',
  'GET    /api/v1/manage/overview?range=7d      — usage across every key',
  'GET    /api/v1/manage/report?key=:id&days=30 — the design-partner report: agents, endpoints, what the rules did or would have done',
  'GET    /api/v1/manage/stats?key=:id&range=7d — one key: sessions, agents, resources, recent decisions',
  'GET    /api/v1/manage/events?key=:id&range=7d&before=:id&limit=100 — the decision log, paged',
  'GET    /api/v1/manage/proofs?key=:id&range=30d[&session=:hash] — signed decision proofs + verifying keys (auditor bundle)',
  'GET    /api/v1/manage/health?key=:id&range=7d — integration check (reporting, browser signals, signatures, enforcement) + people stopped',
  'GET    /api/v1/manage/weekly?key=:id           — weekly report: this week vs last, new agents, what changed in the agents',
  'POST   /api/v1/manage/feedback                — {key, id, verdict: correct|wrong, note?} grade one reported decision (false-stop rate)',
  'GET    /api/v1/manage/policy?key=:id          — policy of one key: settings, changes waiting for approval, endpoints without a rule',
  'POST   /api/v1/manage/policy                  — {key, policy} propose a policy: applied at once, or held when the key requires approval or it weakens protection',
];

export type Check = { id: 'reporting' | 'browser' | 'signed' | 'enforcing'; status: 'ok' | 'warn' | 'off'; title: string; detail: string };

/** Plain-language lights for the integration page. Pure, so it is tested directly. */
export function integrationChecks(h: TelemetryHealth, now: number): Check[] {
  const ago = (t: number) => { const s = Math.max(0, Math.round((now - t) / 1000)); return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`; };
  const checks: Check[] = [];
  if (!h.last) checks.push({ id: 'reporting', status: 'off', title: 'Server reporting', detail: 'No decision from this key yet. Put the key in ONEHUMAN_API_KEY and make one request to a protected endpoint.' });
  else if (now - h.last > 24 * 3600e3) checks.push({ id: 'reporting', status: 'warn', title: 'Server reporting', detail: `Last decision ${ago(h.last)}. If the app is live, check that ONEHUMAN_API_KEY is still set on the server.` });
  else checks.push({ id: 'reporting', status: 'ok', title: 'Server reporting', detail: `Last decision ${ago(h.last)} · ${h.events.toLocaleString('en-US')} in range.` });

  if (!h.sessions) checks.push({ id: 'browser', status: 'off', title: 'Browser signals', detail: 'Waits for the first session.' });
  else if (!h.sdkSessions) checks.push({ id: 'browser', status: 'warn', title: 'Browser signals', detail: 'The server decides, but no page sent browser signals, so agents can only be judged by their requests. Add <script src="/onehuman/sdk.js"></script> to the signed-in pages.' });
  else {
    const share = Math.round((h.sdkSessions / h.sessions) * 100);
    checks.push({ id: 'browser', status: share >= 50 ? 'ok' : 'warn', title: 'Browser signals', detail: share >= 50 ? `${share}% of sessions sent browser signals.` : `Only ${share}% of sessions sent browser signals. Some signed-in pages are missing the script tag, or API clients call protected endpoints directly.` });
  }

  if (!h.events) checks.push({ id: 'signed', status: 'off', title: 'Signed decisions', detail: 'Waits for the first decision.' });
  else if (!h.proofs) checks.push({ id: 'signed', status: 'warn', title: 'Signed decisions', detail: 'Decisions arrive without a signature. Update to the latest onehumanai.' });
  else if (h.proofsOk < h.proofs) checks.push({ id: 'signed', status: 'warn', title: 'Signed decisions', detail: `${h.proofs - h.proofsOk} of ${h.proofs} signatures did not verify. Every server instance must use the same ONEHUMAN_SECRET.` });
  else checks.push({ id: 'signed', status: 'ok', title: 'Signed decisions', detail: `${h.proofsOk.toLocaleString('en-US')} decisions signed and verified. Export them for an auditor from Activity.` });

  if (!h.enforcement) checks.push({ id: 'enforcing', status: 'off', title: 'Policy mode', detail: 'Waits for the first decision.' });
  else if (h.enforcement === 'observe') checks.push({ id: 'enforcing', status: 'warn', title: 'Policy mode', detail: 'Observe mode: every decision is recorded, nothing is blocked yet. Set "enforcement": "enforce" in the policy when the numbers look right.' });
  else checks.push({ id: 'enforcing', status: 'ok', title: 'Policy mode', detail: 'Enforcing: agents get the answer your policy gives them.' });
  return checks;
}

const DECISIONS = new Set(['allow', 'mask', 'block', 'step_up']);
const ACTORS = new Set(['human_like', 'agent_likely', 'unknown']);
const STATES = new Set(['signed_agent', 'agent_attached', 'agent_environment', 'no_indication']);
const ENFORCEMENT = new Set(['observe', 'enforce']);

export function parseEvent(x: unknown, now: number): TelemetryEvent | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const at = typeof o.at === 'number' && Number.isFinite(o.at) ? Math.min(now + 60_000, Math.max(now - 30 * 24 * 3600e3, Math.round(o.at))) : now;
  const session = typeof o.session === 'string' && /^[a-f0-9]{8,32}$/.test(o.session) ? o.session : null;
  const resource = typeof o.resource === 'string' && SHORT.test(o.resource) ? o.resource : null;
  const decision = typeof o.decision === 'string' && DECISIONS.has(o.decision) ? o.decision : null;
  const computed = typeof o.computed === 'string' && DECISIONS.has(o.computed) ? o.computed : decision;
  const actor = typeof o.actor === 'string' && ACTORS.has(o.actor) ? o.actor : 'unknown';
  const state = typeof o.state === 'string' && STATES.has(o.state) ? o.state : 'no_indication';
  const enforcement = typeof o.enforcement === 'string' && ENFORCEMENT.has(o.enforcement) ? o.enforcement : 'enforce';
  const version = typeof o.version === 'string' && SHORT.test(o.version) ? o.version : 'unknown';
  const tools = Array.isArray(o.tools) ? o.tools.filter((t): t is string => typeof t === 'string' && /^[a-z0-9_.\-]{1,40}$/i.test(t)).slice(0, 8) : [];
  const reasons = Array.isArray(o.reasons) ? o.reasons.filter((t): t is string => typeof t === 'string' && TOKEN.test(t)).slice(0, 8) : [];
  if (!session || !resource || !decision) return null;
  const proof = typeof o.proof === 'string' && o.proof.length <= 6000 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(o.proof) ? o.proof : null;
  const eid = typeof o.eid === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(o.eid) ? o.eid : null;
  const login = typeof o.login === 'boolean' ? o.login : null;
  return { at, session, resource, decision, computed, actor, state, tools, reasons, enforcement, version, proof, eid, login };
}

/** Public keys a deployment reports with its events. The id is recomputed from the key, never trusted. */
export function parseProofKeys(x: unknown): ProofJwk[] {
  if (!Array.isArray(x)) return [];
  const out: ProofJwk[] = [];
  for (const k of x.slice(0, 4)) {
    if (!k || typeof k !== 'object') continue;
    const o = k as Record<string, unknown>;
    if (o.kty !== 'OKP' || o.crv !== 'Ed25519' || typeof o.x !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(o.x) || 'd' in o) continue;
    out.push({ kty: 'OKP', crv: 'Ed25519', x: o.x, kid: thumbprint(o.x), use: 'sig', alg: 'EdDSA' });
  }
  return out;
}
