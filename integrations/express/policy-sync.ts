// SPDX-License-Identifier: Apache-2.0
/**
 * Keeps this server's policy in step with the portal.
 *
 *   first start      the portal has no policy for this key → the policy file is sent and becomes version 1
 *   every minute     the server asks the portal for its policy (a 304 when nothing changed) and runs what it gets
 *   file edited      a developer or their coding agent changed onehuman.policy.json → it is proposed to the portal,
 *                    which applies it or holds it for approval, as the key's owner decided
 *   portal down      the server keeps running on the last policy it accepted, saved in its own database
 *
 * The server accepts only a policy the portal signed, for this API key. It pins the portal's key the first time it
 * sees it and refuses any other afterwards. Where the policy running now came from — portal, saved copy, file —
 * is logged on every change and reported in `oh.health()` and to the portal.
 */
import { readFile } from 'node:fs/promises';
import { keyTag, policyHash, verifyPolicyEnvelope, type PolicyLike } from '../policy/common.ts';

export type PolicySource = 'portal' | 'cache' | 'file' | 'none';

type StoreLike = {
  policyCache(tag: string): Promise<{ envelope: string; pinnedKey: string; fetched: number; pushedFileHash: string | null } | null>;
  putPolicyCache(tag: string, c: { envelope: string; pinnedKey: string; fetched: number }): Promise<void>;
  setPolicyCachePushed(tag: string, fileHash: string, pinnedKey: string): Promise<void>;
};

export type PolicySyncOptions<P extends PolicyLike> = {
  store: StoreLike;
  apiKey: string;
  portalUrl: string;
  /** the policy file's path (re-read on every check), or null */
  filePath: string | null;
  /** the policy given in code as an object, or the file as read at startup */
  initialFile: P | null;
  /** validate an untrusted policy document; the second argument is the version string to give it */
  parse: (raw: unknown, version: string) => P | null;
  log?: (msg: string) => void;
  checkEveryMs?: number;
  /** how long startup waits for the portal before running on the saved copy or the file (default 4 s) */
  startupWaitMs?: number;
};

export type PolicyStatus = {
  version: string;
  source: PolicySource;
  /** the portal's version number, when the policy came from the portal (now or earlier) */
  n: number | null;
  /** when the portal last confirmed this policy (ms), or null */
  confirmedAt: number | null;
  lastCheckAt: number | null;
  portalReachable: boolean | null;
  /** the last proposal of the policy file: applied, waiting for approval, or unchanged */
  lastProposal: { status: string; reason?: string; at: number } | null;
  problem: string | null;
};

const EMPTY = { version: 'none', enforcement: 'observe' as const, rules: [] };

export function createPolicySync<P extends PolicyLike>(o: PolicySyncOptions<P>) {
  const log = o.log ?? ((m: string) => console.log(`onehuman: ${m}`));
  const tag = keyTag(o.apiKey);
  const base = o.portalUrl.replace(/\/$/, '');
  const auth = { Authorization: `Bearer ${o.apiKey}` };
  const every = o.checkEveryMs ?? 60_000;

  let active: P = (o.initialFile ?? (o.parse(EMPTY, 'none') as P));
  let source: PolicySource = o.initialFile ? 'file' : 'none';
  let n: number | null = null;
  let confirmedAt: number | null = null;
  let lastCheckAt: number | null = null;
  let portalReachable: boolean | null = null;
  let pinned: string | null = null;
  let pushedFileHash: string | null = null;
  let lastProposal: PolicyStatus['lastProposal'] = null;
  let problem: string | null = null;
  let inflight: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let said = '';

  const describe: Record<PolicySource, string> = {
    portal: 'from the portal',
    cache: 'from the saved copy — the portal could not be reached',
    file: 'from the policy file in your code',
    none: 'none yet — observe mode, nothing is gated',
  };
  function activate(p: P, src: PolicySource, num: number | null) {
    active = p; source = src; n = num;
    const line = `policy ${p.version} (${p.enforcement}, ${p.rules.length} rule${p.rules.length === 1 ? '' : 's'}) ${describe[src]}`;
    if (line !== said) { said = line; log(line); }
  }
  function warn(msg: string) { if (problem !== msg) { problem = msg; log(msg); } }

  /** Accept a signed envelope from the portal (or from the saved copy) if it is genuine and for this key. */
  function accept(envelope: string, key: string, src: 'portal' | 'cache'): boolean {
    const check = verifyPolicyEnvelope(envelope, [{ x: key }], tag);
    if (!check.ok) { warn(`a policy from the ${src === 'cache' ? 'saved copy' : 'portal'} failed its check (${check.reason}) and was not used`); return false; }
    const p = o.parse(check.payload.policy, `portal-v${check.payload.n}`);
    if (!p) { warn('a signed policy from the portal did not validate and was not used'); return false; }
    activate(p, src, check.payload.n);
    return true;
  }

  async function call(path: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
    return fetch(`${base}${path}`, { ...init, headers: { ...auth, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(8000) });
  }

  /** The portal's key is pinned the first time; a different key later is refused rather than trusted. */
  function pinFrom(keys: unknown): string | null {
    const x = Array.isArray(keys) && keys[0] && typeof (keys[0] as { x?: unknown }).x === 'string' ? (keys[0] as { x: string }).x : null;
    if (!x) return null;
    if (!pinned) pinned = x;
    if (pinned !== x) { warn('the portal presented a different signing key than the one this server pinned; its policy was refused (delete the saved copy to trust the new key)'); return null; }
    return pinned;
  }

  async function readFilePolicy(): Promise<{ policy: P; hash: string } | null> {
    if (!o.filePath) return o.initialFile ? { policy: o.initialFile, hash: policyHash(o.initialFile) } : null;
    try {
      const raw = JSON.parse(await readFile(o.filePath, 'utf8'));
      const p = o.parse(raw, typeof raw?.version === 'string' ? raw.version : 'file');
      if (!p) { warn(`${o.filePath} is not a valid policy; it was not sent to the portal`); return null; }
      return { policy: p, hash: policyHash(p) };
    } catch { return o.initialFile ? { policy: o.initialFile, hash: policyHash(o.initialFile) } : null; }
  }

  async function fetchPolicy(): Promise<'ok' | 'none' | 'unreachable'> {
    let r: Response;
    try {
      const headers: Record<string, string> = { 'X-OH-Policy-Version': active.version, 'X-OH-Policy-Source': source };
      if (n !== null && (source === 'portal' || source === 'cache')) headers['If-None-Match'] = `"portal-v${n}"`;
      r = await call('/api/v1/key-policy', { headers });
    } catch { return 'unreachable'; }
    if (r.status === 401) { warn('the portal refused this API key for the policy (revoked or expired); running on what this server has'); return 'unreachable'; }
    if (r.status === 304) {
      confirmedAt = Date.now();
      if (source === 'cache') activate(active, 'portal', n);
      return 'ok';
    }
    const body = await r.json().catch(() => null) as { envelope?: string; keys?: unknown; error?: string } | null;
    if (r.status === 404 && body?.error === 'no_policy') { pinFrom(body.keys); return 'none'; }
    if (!r.ok || !body?.envelope) return 'unreachable';
    const key = pinFrom(body.keys);
    if (!key) return 'unreachable';
    if (accept(body.envelope, key, 'portal')) {
      confirmedAt = Date.now();
      await o.store.putPolicyCache(tag, { envelope: body.envelope, pinnedKey: key, fetched: confirmedAt }).catch(() => {});
    }
    return 'ok';
  }

  /** Send the policy file to the portal when it changed since this server (or any other instance) last sent it. */
  async function proposeFile(file: { policy: P; hash: string }, origin: 'install' | 'code'): Promise<boolean> {
    if (file.hash === pushedFileHash) return false;
    let r: Response;
    try {
      r = await call('/api/v1/key-policy/propose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ policy: file.policy, fileHash: file.hash, origin }) });
    } catch { return false; }
    const body = await r.json().catch(() => ({})) as { status?: string; reason?: string; message?: string };
    if (!r.ok && r.status !== 202) { warn(`the portal did not take the policy file: ${body.message ?? r.status}`); return false; }
    pushedFileHash = file.hash;
    if (pinned) await o.store.setPolicyCachePushed(tag, file.hash, pinned).catch(() => {});
    lastProposal = { status: body.status ?? 'unknown', reason: body.reason, at: Date.now() };
    if (body.status === 'created') log('the policy file was sent to the portal and is now version 1 there');
    else if (body.status === 'applied') log('the edited policy file was sent to the portal and applied');
    else if (body.status === 'pending') log(`the edited policy file is waiting for approval in the portal (${body.reason === 'weakens_protection' ? 'it weakens protection' : body.reason === 'affects_people' ? 'it makes real people confirm or be refused' : 'this key requires approval'}); the current policy stays in force`);
    return body.status === 'created' || body.status === 'applied';
  }

  async function refresh(): Promise<void> {
    lastCheckAt = Date.now();
    const state = await fetchPolicy();
    portalReachable = state !== 'unreachable';
    if (state === 'unreachable') {
      if (source === 'cache' || source === 'portal') { if (source === 'portal') activate(active, 'cache', n); warn(`the portal could not be reached; running on the saved copy (${active.version})`); }
      else warn(`the portal could not be reached; running on ${source === 'file' ? 'the policy file' : 'no policy'}`);
      return;
    }
    if (problem && problem.startsWith('the portal could not be reached')) { problem = null; log('the portal is reachable again'); }
    const file = await readFilePolicy();
    if (state === 'none') {
      if (file && (await proposeFile(file, 'install'))) await fetchPolicy();
      return;
    }
    if (file && (await proposeFile(file, 'code'))) await fetchPolicy();
  }

  function refreshOnce(): Promise<void> {
    if (!inflight) inflight = refresh().catch(() => {}).finally(() => { inflight = null; });
    return inflight;
  }

  // ---------------------------------------------------------------- declared resources
  const declared = new Set<string>();
  let declaredSent = '';
  let declareTimer: NodeJS.Timeout | null = null;
  async function sendDeclared() {
    const list = [...declared].sort();
    const key = list.join(',');
    if (!list.length || key === declaredSent) return;
    try {
      const r = await call('/api/v1/key-policy/resources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resources: list }) });
      if (r.ok) declaredSent = key;
    } catch { /* next check retries */ }
  }

  return {
    async init() {
      const cache = await o.store.policyCache(tag).catch(() => null);
      if (cache) {
        pinned = cache.pinnedKey || null;
        pushedFileHash = cache.pushedFileHash;
        if (cache.envelope && pinned) {
          if (accept(cache.envelope, pinned, 'cache')) confirmedAt = cache.fetched;
        }
      }
      if (source === 'none' && o.initialFile) activate(o.initialFile, 'file', null);
      else if (source === 'none') activate(active, 'none', null);
      const wait = new Promise<void>((r) => { const t = setTimeout(r, o.startupWaitMs ?? 4000); t.unref?.(); });
      await Promise.race([refreshOnce(), wait]);
      timer = setInterval(() => { void refreshOnce(); void sendDeclared(); }, every);
      timer.unref?.();
    },
    /** the policy to decide with, right now */
    get policy(): P { return active; },
    get source(): PolicySource { return source; },
    /** called on requests: on a platform that freezes between requests the interval never fires, so a stale check is started here */
    maybeRefresh() { if (!inflight && (lastCheckAt === null || Date.now() - lastCheckAt > every)) void refreshOnce(); },
    refresh: refreshOnce,
    /** every oh.protect(resource) registers here, so the portal can show endpoints that have no rule */
    declare(resource: string) {
      if (declared.has(resource)) return;
      declared.add(resource);
      if (declareTimer) clearTimeout(declareTimer);
      declareTimer = setTimeout(() => { void sendDeclared(); }, 1500);
      declareTimer.unref?.();
    },
    status(): PolicyStatus {
      return { version: active.version, source, n, confirmedAt, lastCheckAt, portalReachable, lastProposal, problem };
    },
    close() { if (timer) clearInterval(timer); if (declareTimer) clearTimeout(declareTimer); timer = null; },
  };
}
