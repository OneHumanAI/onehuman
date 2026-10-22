// SPDX-License-Identifier: BUSL-1.1
/**
 * The site's own key (ONEHUMAN_DOGFOOD_API_KEY) and the public demos.
 *
 * Reports: the demo apps (bank, CRM, enterprise workspace) and the lab report their decisions to OneHuman's own portal
 * account under this key, as any deployment reports to its owner. The team, and anyone the key is shared with, sees
 * how many people test AI agents on onehuman.ai, with which tools, and what happened. Events are written to the store
 * directly (no HTTP) after the answer; a visitor's session id is hashed, nothing else about them is kept. Visitors are
 * not customers, so nothing here counts towards a plan.
 *
 * Rules: the key's rules in the portal run the demos. The first time, the demos' own rules become the key's version 1
 * (named demo.<app>.<resource>); from then on a rule changed in the portal, by the owner or by someone the key's rules
 * were shared with, is what the demo apps enforce, within a few seconds.
 */
import { createHash } from 'node:crypto';
import type { DecisionRow, Store } from './db.ts';
import type { Policy } from './policy.ts';
import type { SiteStore, TelemetryEvent } from './site-db.ts';
import { APPS } from './apps.ts';
import { hashKey } from './routes/portal.ts';
import { diffPolicy } from '../integrations/policy/common.ts';

export const DEMO_PREFIX = 'demo.';

/** keep a promise alive after the answer: on Vercel through the request's waitUntil, elsewhere it simply runs */
function background(p: Promise<unknown>) {
  const ctx = (globalThis as unknown as Record<symbol, { get?: () => { waitUntil?: (p: Promise<unknown>) => void } | undefined } | undefined>)[Symbol.for('@vercel/request-context')]?.get?.();
  ctx?.waitUntil?.(p);
}

/** The site key's id in the store, looked up once (null: no such key, or revoked). */
export function siteKey(site: SiteStore, apiKey: string | undefined) {
  const ok = !!apiKey && /^oh_live_[a-f0-9]{40}$/.test(apiKey);
  let found: Promise<{ id: string; account: string } | null> | null = null;
  const info = (): Promise<{ id: string; account: string } | null> => (!ok ? Promise.resolve(null) : (found ??= site.apiKeyByHash(hashKey(apiKey!))
    .then((k) => (k && !k.revoked ? { id: k.id, account: k.account } : null))
    .catch(() => { found = null; return null; })));
  return { raw: ok ? apiKey! : null, info, id: async () => (await info())?.id ?? null };
}
export type SiteKey = ReturnType<typeof siteKey>;

/** what one demo decision looks like in the portal: the resource is named after its app, e.g. demo.bank.balance.read */
export function demoEvent(row: DecisionRow, app: string, session: string): TelemetryEvent {
  return {
    at: row.created, session, resource: `${DEMO_PREFIX}${app}.${row.resource}`, decision: row.decision, computed: row.computed, actor: row.actor,
    state: row.connection ?? 'none', tools: (row.tools ?? []).slice(0, 8), reasons: row.reasonCodes.slice(0, 8),
    enforcement: row.enforced ? 'enforce' : 'observe', version: row.signalVersion, eid: row.id, login: false,
  };
}

export function demoReporter(site: SiteStore, engineStore: Store, key: SiteKey): ((row: DecisionRow) => void) | undefined {
  if (!key.raw) return undefined;
  const hash = (id: string) => createHash('sha256').update(key.raw!).update('\0demo\0').update(id).digest('hex').slice(0, 16);
  return (row) => {
    background((async () => {
      const id = await key.id();
      if (!id) return;
      const app = (await engineStore.roomApp(row.room).catch(() => null)) ?? 'demo';
      await site.insertTelemetry(id, [demoEvent(row, app, hash(row.session))], Date.now());
    })().catch((e) => console.warn('onehuman: demo report failed', e)));
  };
}

/** Every demo app's rules under one policy, each resource named demo.<app>.<resource>. */
export function demoPolicy(): Policy {
  return {
    version: 'demo-apps', enforcement: 'enforce',
    rules: Object.entries(APPS).flatMap(([app, def]) => def.policy.rules.map((r) => ({ ...r, resource: `${DEMO_PREFIX}${app}.${r.resource}` }))),
  };
}

/**
 * The demos' rules from the portal: `rulesFor(app, base)` swaps each of the app's rules for the key's rule of the
 * same resource (demo.<app>.<resource>), when there is one. The key's policy is read again every few seconds.
 */
export function demoRules(site: SiteStore, key: SiteKey, opts: { ttlMs?: number; now?: () => number } = {}) {
  const ttl = opts.ttlMs ?? 5000, now = opts.now ?? Date.now;
  let cache: { at: number; rules: Policy['rules'] | null; n: number } | null = null;
  let seeded: Promise<void> | null = null;
  let toldAt = 0, toldN = 0;

  /** the first time: the demos' rules become the key's version 1, and their resources are listed for the rules page */
  async function seed(id: string) {
    const all = demoPolicy();
    await site.noteKeyResources(id, all.rules.map((r) => r.resource));
    if (await site.keyPolicy(id)) return;
    const v1 = { ...all, version: 'portal-v1' };
    await site.putKeyPolicy(id, 1, v1);
    await site.addPolicyChange({ keyId: id, actor: 'onehuman.ai demos', origin: 'install', status: 'applied', fromN: null, toN: 1, body: v1, summary: diffPolicy(null, v1).changes, weakening: [] });
  }

  async function current(): Promise<{ at: number; rules: Policy['rules'] | null; n: number }> {
    if (cache && now() - cache.at < ttl) return cache;
    const id = await key.id();
    if (!id) return (cache = { at: now(), rules: null, n: 0 });
    await (seeded ??= seed(id).catch((e) => { seeded = null; console.warn('onehuman: demo rules seed failed', e); }));
    const kp = await site.keyPolicy(id).catch(() => null);
    const rules = (kp?.body as Policy | undefined)?.rules ?? null;
    // the rules page says which version the app runs, as it does for a customer's server (at most every few minutes)
    if (kp && (kp.n !== toldN || now() - toldAt > 5 * 60_000)) { toldAt = now(); toldN = kp.n; background(site.setKeyPolicySeen(id, `portal-v${kp.n}`, 'portal').catch(() => {})); }
    return (cache = { at: now(), rules, n: kp?.n ?? 0 });
  }

  return {
    async rulesFor(app: string, base: Policy): Promise<Policy> {
      if (!key.raw) return base;
      const { rules, n } = await current();
      if (!rules) return base;
      const mine = new Map(rules.filter((r) => r.resource.startsWith(`${DEMO_PREFIX}${app}.`)).map((r) => [r.resource.slice(DEMO_PREFIX.length + app.length + 1), r]));
      if (!mine.size) return base;
      return { ...base, version: `${base.version}+portal-v${n}`, rules: base.rules.map((r) => { const p = mine.get(r.resource); return p ? { ...p, resource: r.resource } : r; }) };
    },
    /** forget the cached rules (a save in this instance takes effect at once) */
    refresh() { cache = null; },
  };
}
