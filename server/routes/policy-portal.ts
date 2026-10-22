// SPDX-License-Identifier: BUSL-1.1
/**
 * The portal-managed policy.
 *
 * The portal is where a key's policy lives. On the first start, the customer's server sends the policy file its
 * coding agent wrote and the portal takes it as version 1, no questions asked. From then on the server reads the
 * policy from here, signed, and keeps its own copy for when the portal cannot be reached.
 *
 * Later edits to the file (by a developer or an agent) arrive as proposals: applied at once by default, or held
 * for approval when the key's owner turned that on. A change that weakens protection is held unless the owner
 * turned that check off; weakening from the portal itself needs the account password. Every step is journalled.
 *
 * Endpoints for the customer's server (Authorization: Bearer oh_live_…):
 *   GET  /api/v1/key-policy          the signed policy (304 when the server already runs it)
 *   POST /api/v1/key-policy/propose  { policy, fileHash, origin }   the policy file changed
 *   POST /api/v1/key-policy/resources { resources }                 every oh.protect() the server registered
 *   GET  /api/v1/policy-keys         the portal's public key (JWK Set)
 * For the portal (cookie): GET/POST /api/v1/portal/policy, POST …/policy/settings, POST …/policy/decide.
 */
import { createPrivateKey, createPublicKey, hkdfSync, sign } from 'node:crypto';
import type { OneHuman } from '../engine.ts';
import { json, readJson, sameOrigin, url, type Req, type Res } from '../http.ts';
import { parsePolicy, type Policy } from '../policy.ts';
import { thumbprint } from '../proof.ts';
import { assistEnabled, assistPolicy, cleanHistory } from '../policy-assist.ts';
import { diffPolicy, POLICY_TYP, type PolicyDiff, type PolicyEnvelopePayload, type PolicyLike } from '../../integrations/policy/common.ts';
import { siteOf } from '../site-db.ts';

const RES_RE = /^[a-z][a-z0-9_.]{1,60}$/;
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const portalVersion = (n: number) => `portal-v${n}`;
/** changes that need a careful look: they lower protection, or make real people confirm or be refused */
const careful = (d: PolicyDiff) => [...d.weakening, ...d.affectsPeople];
const CONFIRM = 'This change lowers protection or affects real people. Confirm with your password.';

/** The portal's policy-signing key, derived from the deployment secret: the same on every instance. */
export function policySigner(secret: Buffer) {
  const seed = Buffer.from(hkdfSync('sha256', secret, 'onehuman', 'portal-policy-ed25519', 32));
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const x = (createPublicKey(priv).export({ format: 'jwk' }) as { x: string }).x;
  const jwk = { kty: 'OKP' as const, crv: 'Ed25519' as const, x, kid: thumbprint(x), use: 'sig' as const, alg: 'EdDSA' as const };
  const header = b64u(JSON.stringify({ alg: 'EdDSA', typ: POLICY_TYP, kid: jwk.kid }));
  return {
    jwk,
    envelope(kh: string, n: number, policy: PolicyLike): string {
      const payload: PolicyEnvelopePayload = { v: 1, iss: 'onehuman-portal', kh, n, iat: Math.floor(Date.now() / 1000), policy };
      const input = `${header}.${b64u(JSON.stringify(payload))}`;
      return `${input}.${b64u(sign(null, Buffer.from(input), priv))}`;
    },
  };
}

type Deps = {
  accountOf: (req: Req) => Promise<string | null>;
  /** checks the account password (the second confirmation for weakening changes) */
  checkPassword: (account: string, password: string) => Promise<boolean>;
  /** resolves `Authorization: Bearer oh_live_…` to a live key, or answers 401 itself */
  serverKey: (req: Req, res: Res) => Promise<{ id: string; account: string; tag: string } | null>;
  /** told when a key's rules changed, so anything in this process that runs them reads them again */
  onPolicyChange?: (keyId: string) => void;
};

export function policyRoutes(engine: OneHuman, deps: Deps) {
  const store = siteOf(engine.store);
  const signer = policySigner(engine.secret);

  /** Validate an untrusted policy document and stamp it with the portal version it would become. */
  const parse = (raw: unknown, n: number): Policy | null => parsePolicy(raw, portalVersion(n));
  const keyName = async (keyId: string, account: string) => (await store.apiKeyById(keyId, account))?.name ?? 'key';

  /**
   * A policy arriving from outside the portal UI: the server's policy file, or an agent through the management API.
   * The first one becomes version 1 with no questions; later ones follow the key's approval settings.
   */
  async function propose(keyId: string, raw: unknown, meta: { actor: string; origin: 'server' | 'agent'; fileHash?: string | null }) {
    const current = await store.keyPolicy(keyId);
    const next = parse(raw, (current?.n ?? 0) + 1);
    if (!next) return { code: 400, body: { error: 'bad_policy', message: 'The policy is not valid (see docs → Policy reference).' } };
    if (!current) {
      await store.putKeyPolicy(keyId, 1, next);
      deps.onPolicyChange?.(keyId);
      if (meta.fileHash) await store.setKeyPolicyFileHash(keyId, meta.fileHash);
      await store.addPolicyChange({ keyId, actor: meta.actor, origin: 'install', status: 'applied', fromN: null, toN: 1, body: next, summary: diffPolicy(null, next).changes, weakening: [] });
      return { code: 201, body: { status: 'created', n: 1 } };
    }
    if (meta.fileHash && current.lastFileHash === meta.fileHash) return { code: 200, body: { status: 'unchanged', n: current.n } };
    if (meta.fileHash) await store.setKeyPolicyFileHash(keyId, meta.fileHash);
    const diff = diffPolicy(current.body as PolicyLike, next);
    if (diff.same) return { code: 200, body: { status: 'unchanged', n: current.n } };
    const hold = current.requireApproval ? 'approval_required' : current.confirmWeakening && careful(diff).length ? (diff.weakening.length ? 'weakens_protection' : 'affects_people') : null;
    if (hold) {
      // only the newest proposal matters: older ones still waiting are superseded by it
      for (const p of await store.policyChanges(keyId, { status: 'pending' })) if (p.origin === meta.origin) await store.decidePolicyChange(keyId, p.id, 'superseded', meta.actor, null);
      const id = await store.addPolicyChange({ keyId, actor: meta.actor, origin: meta.origin, status: 'pending', fromN: current.n, toN: null, body: next, summary: diff.changes, weakening: careful(diff) });
      return { code: 202, body: { status: 'pending', id, reason: hold, n: current.n, weakening: careful(diff) } };
    }
    const n = current.n + 1;
    await store.putKeyPolicy(keyId, n, { ...next, version: portalVersion(n) });
    deps.onPolicyChange?.(keyId);
    await store.addPolicyChange({ keyId, actor: meta.actor, origin: meta.origin, status: 'applied', fromN: current.n, toN: n, body: next, summary: diff.changes, weakening: careful(diff) });
    return { code: 200, body: { status: 'applied', n } };
  }

  /** Everything the Policy page shows for one key. */
  async function view(keyId: string) {
    const kp = await store.keyPolicy(keyId);
    const rules = new Set(((kp?.body as PolicyLike | undefined)?.rules ?? []).map((r) => r.resource));
    const declared = await store.keyResources(keyId);
    const traffic = await store.telemetryResources(keyId, Date.now() - 30 * 24 * 3600e3);
    const unruled = new Map<string, { resource: string; from: string[]; lastSeen: number }>();
    for (const d of declared) if (!rules.has(d.resource)) unruled.set(d.resource, { resource: d.resource, from: ['code'], lastSeen: d.lastSeen });
    for (const t of traffic) if (!rules.has(t.resource) && RES_RE.test(t.resource)) {
      const u = unruled.get(t.resource);
      if (u) { u.from.push('traffic'); u.lastSeen = Math.max(u.lastSeen, t.last); } else unruled.set(t.resource, { resource: t.resource, from: ['traffic'], lastSeen: t.last });
    }
    return {
      policy: kp ? kp.body : null,
      n: kp?.n ?? 0,
      updated: kp?.updated ?? null,
      settings: { requireApproval: kp?.requireApproval ?? false, confirmWeakening: kp?.confirmWeakening ?? true },
      server: kp?.seen ?? null,
      pending: kp ? await store.policyChanges(keyId, { status: 'pending' }) : [],
      history: kp ? await store.policyChanges(keyId, { limit: 40 }) : [],
      unruled: [...unruled.values()].sort((a, b) => b.lastSeen - a.lastSeen),
      declared: declared.map((d) => d.resource),
      assistant: assistEnabled(),
    };
  }

  // ---------------------------------------------------------------- for the customer's server
  const getForServer = async (req: Req, res: Res) => {
    const k = await deps.serverKey(req, res); if (!k) return;
    const kp = await store.keyPolicy(k.id);
    const version = String(req.headers['x-oh-policy-version'] ?? '');
    const source = String(req.headers['x-oh-policy-source'] ?? '');
    if (kp && version) await store.setKeyPolicySeen(k.id, version, /^(portal|cache|file|none)$/.test(source) ? source : 'unknown');
    if (!kp) return json(res, 404, { error: 'no_policy', message: 'No policy for this key yet: the server proposes its policy file on first start.', keys: [signer.jwk] });
    const etag = `"${portalVersion(kp.n)}"`;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); res.end(); return; }
    res.setHeader('ETag', etag);
    json(res, 200, { n: kp.n, envelope: signer.envelope(k.tag, kp.n, kp.body as PolicyLike), keys: [signer.jwk] });
  };

  const proposeFromServer = async (req: Req, res: Res) => {
    const k = await deps.serverKey(req, res); if (!k) return;
    const b = (await readJson(req, 64_000).catch(() => null)) as Record<string, unknown> | null | undefined;
    const fileHash = typeof b?.fileHash === 'string' && /^[a-f0-9]{8,64}$/.test(b.fileHash) ? b.fileHash : null;
    const r = await propose(k.id, b?.policy, { actor: `your server · ${await keyName(k.id, k.account)}`, origin: 'server', fileHash });
    json(res, r.code, r.body);
  };

  const resourcesFromServer = async (req: Req, res: Res) => {
    const k = await deps.serverKey(req, res); if (!k) return;
    const b = (await readJson(req, 16_000).catch(() => null)) as Record<string, unknown> | null | undefined;
    const list = Array.isArray(b?.resources) ? (b!.resources as unknown[]).filter((x): x is string => typeof x === 'string' && RES_RE.test(x)).slice(0, 200) : [];
    await store.noteKeyResources(k.id, [...new Set(list)]);
    json(res, 200, { ok: true, noted: list.length });
  };

  const publicKeys = async (_req: Req, res: Res) => json(res, 200, { keys: [signer.jwk] }, { 'Cache-Control': 'public, max-age=60, s-maxage=600, stale-while-revalidate=86400' });

  // ---------------------------------------------------------------- for the portal page
  /** the account, when it may manage this key's rules: the owner, or someone the owner shared them with (an editor) */
  async function owned(req: Req, res: Res, keyId: string, ownerOnly = false): Promise<string | null> {
    const account = await deps.accountOf(req);
    if (!account) { json(res, 401, { error: 'unauthenticated' }); return null; }
    const role = keyId ? await store.keyRole(keyId, account) : null;
    if (!(role === 'owner' || (role === 'editor' && !ownerOnly))) { json(res, 404, { error: 'not_found' }); return null; }
    return account;
  }
  const actorOf = async (account: string) => (await store.accountById(account))?.email ?? 'you';

  const portalGet = async (req: Req, res: Res) => {
    const key = url(req).searchParams.get('key') ?? '';
    const account = await owned(req, res, key); if (!account) return;
    json(res, 200, { ...(await view(key)), role: await store.keyRole(key, account) });
  };

  /** An edit made in the portal. Weakening asks for the account password when the key's check is on. */
  const portalSave = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    const b = (await readJson(req, 64_000).catch(() => null)) as Record<string, unknown> | null | undefined;
    const key = typeof b?.key === 'string' ? b.key : '';
    const account = await owned(req, res, key); if (!account) return;
    const current = await store.keyPolicy(key);
    const n = (current?.n ?? 0) + 1;
    const next = parse(b?.policy, n);
    if (!next) return json(res, 400, { error: 'bad_policy', message: 'The policy is not valid.' });
    const diff = diffPolicy((current?.body as PolicyLike | undefined) ?? null, next);
    if (current && diff.same) return json(res, 200, { status: 'unchanged', n: current.n });
    if (current && current.confirmWeakening && careful(diff).length) {
      const pw = typeof b?.password === 'string' ? b.password : '';
      if (!pw) return json(res, 403, { error: 'confirm', message: CONFIRM, weakening: careful(diff) });
      if (!(await deps.checkPassword(account, pw))) return json(res, 401, { error: 'wrong_password', message: 'That password is not right.' });
    }
    await store.putKeyPolicy(key, n, next);
    deps.onPolicyChange?.(key);
    await store.addPolicyChange({ keyId: key, actor: await actorOf(account), origin: 'portal', status: 'applied', fromN: current?.n ?? null, toN: n, body: next, summary: diff.changes, weakening: careful(diff) });
    json(res, 200, { status: current ? 'applied' : 'created', n });
  };

  const portalSettings = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    const b = (await readJson(req, 4000).catch(() => null)) as Record<string, unknown> | null | undefined;
    const key = typeof b?.key === 'string' ? b.key : '';
    // who must approve what, and whether risky changes need a password, stays with the owner
    const account = await owned(req, res, key, true); if (!account) return;
    const kp = await store.keyPolicy(key);
    if (!kp) return json(res, 409, { error: 'no_policy', message: 'There is no policy yet. It appears when your server starts, or when you save one here.' });
    const requireApproval = typeof b?.requireApproval === 'boolean' ? b.requireApproval : undefined;
    const confirmWeakening = typeof b?.confirmWeakening === 'boolean' ? b.confirmWeakening : undefined;
    // switching the weakening check off is itself a weakening step
    if (confirmWeakening === false && kp.confirmWeakening) {
      const pw = typeof b?.password === 'string' ? b.password : '';
      if (!pw) return json(res, 403, { error: 'confirm', message: 'Turning this off lets changes that lower protection or affect real people go through without a second step. Confirm with your password.' });
      if (!(await deps.checkPassword(account, pw))) return json(res, 401, { error: 'wrong_password', message: 'That password is not right.' });
    }
    await store.setKeyPolicySettings(key, { requireApproval, confirmWeakening });
    const said: string[] = [];
    if (requireApproval !== undefined && requireApproval !== kp.requireApproval) said.push(requireApproval ? 'Changes from your developers now wait for your OK' : 'Changes from your developers now go live by themselves');
    if (confirmWeakening !== undefined && confirmWeakening !== kp.confirmWeakening) said.push(confirmWeakening ? 'Risky changes now need your OK and password' : 'Risky changes no longer need your OK and password');
    if (said.length) await store.addPolicyChange({ keyId: key, actor: await actorOf(account), origin: 'portal', status: 'settings', fromN: kp.n, toN: kp.n, body: null, summary: said, weakening: confirmWeakening === false ? said.filter((s) => s.startsWith('Risky')) : [] });
    json(res, 200, { ok: true, settings: { requireApproval: requireApproval ?? kp.requireApproval, confirmWeakening: confirmWeakening ?? kp.confirmWeakening } });
  };

  const portalDecide = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    const b = (await readJson(req, 4000).catch(() => null)) as Record<string, unknown> | null | undefined;
    const key = typeof b?.key === 'string' ? b.key : '';
    const account = await owned(req, res, key); if (!account) return;
    const id = typeof b?.id === 'number' && Number.isInteger(b.id) ? b.id : 0;
    const change = (await store.policyChanges(key, { status: 'pending', limit: 200 })).find((c) => c.id === id);
    if (!change) return json(res, 404, { error: 'not_pending', message: 'That change is no longer waiting.' });
    const who = await actorOf(account);
    if (b?.approve !== true) {
      await store.decidePolicyChange(key, id, 'rejected', who, null);
      return json(res, 200, { status: 'rejected' });
    }
    const kp = await store.keyPolicy(key);
    const n = (kp?.n ?? 0) + 1;
    const next = parse(change.body, n);
    if (!next) return json(res, 400, { error: 'bad_policy' });
    // measured against what runs now, not against what ran when it was proposed
    const diff = diffPolicy((kp?.body as PolicyLike | undefined) ?? null, next);
    if (kp?.confirmWeakening && careful(diff).length) {
      const pw = typeof b?.password === 'string' ? b.password : '';
      if (!pw) return json(res, 403, { error: 'confirm', message: CONFIRM, weakening: careful(diff) });
      if (!(await deps.checkPassword(account, pw))) return json(res, 401, { error: 'wrong_password', message: 'That password is not right.' });
    }
    await store.putKeyPolicy(key, n, next);
    deps.onPolicyChange?.(key);
    await store.decidePolicyChange(key, id, 'applied', who, n);
    json(res, 200, { status: 'applied', n });
  };

  /**
   * The assistant: a message in plain words → edits of the existing rules, returned as a draft to review.
   * It saves nothing. The draft is the unsaved editor state when given, else the saved policy.
   */
  const ASSIST_PER_DAY = 40;
  /** every account together, per day: the OpenRouter bill has a ceiling even if accounts are mass-created */
  const ASSIST_ALL_PER_DAY = 400;
  const portalAssist = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    const b = (await readJson(req, 64_000).catch(() => null)) as Record<string, unknown> | null | undefined;
    const key = typeof b?.key === 'string' ? b.key : '';
    const account = await owned(req, res, key); if (!account) return;
    if (!assistEnabled()) return json(res, 503, { error: 'assistant_off', message: 'The assistant is not switched on for this portal yet.' });
    const message = typeof b?.message === 'string' ? b.message.trim() : '';
    if (!message || message.length > 1000) return json(res, 400, { error: 'bad_message', message: 'Write what you want in up to 1000 characters.' });
    const kp = await store.keyPolicy(key);
    const draft = b?.draft !== undefined ? parse(b.draft, kp?.n ?? 0) : kp ? parse(kp.body, kp.n) : null;
    if (!draft) return json(res, 409, { error: 'no_policy', message: 'There are no rules yet. They appear when your app first connects.' });
    // counted before the call, so parallel requests cannot all slip under the limit; one ceiling for the whole portal too
    await store.noteAssist(account);
    const day = Date.now() - 24 * 3600e3;
    if ((await store.assistCount(account, day)) > ASSIST_PER_DAY) return json(res, 429, { error: 'limit', message: `The assistant answers up to ${ASSIST_PER_DAY} requests a day. Try again tomorrow, or change the rules by hand.` });
    if ((await store.assistCountAll(day)) > ASSIST_ALL_PER_DAY) return json(res, 429, { error: 'limit', message: 'The assistant is busy today. Try again tomorrow.' });
    try {
      json(res, 200, await assistPolicy(draft, message, cleanHistory(b?.history)));
    } catch (e) {
      const err = e as Error & { code?: string };
      json(res, err.code === 'assistant_off' ? 503 : 502, { error: err.code ?? 'assistant_error', message: err.message });
    }
  };

  // ---------------------------------------------------------------- for agents (management API)
  async function manage(path: string, method: string, account: string, adminName: string, u: URL, body: Record<string, unknown> | null | undefined, res: Res): Promise<boolean> {
    if (path === 'policy' && method === 'GET') {
      const key = u.searchParams.get('key') ?? '';
      if (!(await store.apiKeyOwned(key, account))) { json(res, 404, { error: 'not_found' }); return true; }
      const v = await view(key);
      json(res, 200, { policy: v.policy, n: v.n, settings: v.settings, pending: v.pending.map((p) => ({ id: p.id, summary: p.summary, weakening: p.weakening })), unruled: v.unruled });
      return true;
    }
    if (path === 'policy' && method === 'POST') {
      const key = typeof body?.key === 'string' ? body.key : '';
      if (!(await store.apiKeyOwned(key, account))) { json(res, 404, { error: 'not_found' }); return true; }
      const r = await propose(key, body?.policy, { actor: `agent · management key ${adminName}`, origin: 'agent' });
      json(res, r.code, r.body);
      return true;
    }
    return false;
  }

  return { getForServer, proposeFromServer, resourcesFromServer, publicKeys, portalGet, portalSave, portalSettings, portalDecide, portalAssist, manage, signerKey: signer.jwk };
}
