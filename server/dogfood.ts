// SPDX-License-Identifier: BUSL-1.1
/**
 * OneHuman on onehuman.ai itself: the portal is a signed-in web app like any customer's, so it runs the same
 * middleware. Inside the account nothing is blocked. When an AI agent is in a portal session — driving the tab, or
 * only open beside it in a side panel where it can read the page — secrets never reach it (the account e-mail, key
 * prefixes, proofs and any freshly created key are masked in the answer), the owner gets one alert that an agent was
 * connected, and every change it makes to the account (keys, password, rules) is allowed and raised as an alert.
 * The one thing an agent may not do is sign in or sign up: credentials are typed by a person.
 */
import { hkdfSync } from 'node:crypto';
import { onehuman, type OneHumanInstance, type Req as OhReq } from '../integrations/express/index.ts';
import type { Policy } from './policy.ts';
import type { SqlClient } from './sql.ts';
import type { SiteStore } from './site-db.ts';
import type { Store } from './db.ts';
import { json, type Req, type Res } from './http.ts';

const ACT: Policy['rules'][number]['actOn'] = ['verified', 'strong', 'control', 'behavioral'];
const rule = (resource: string, title: string, agent: 'mask' | 'allow'): Policy['rules'][number] =>
  // traces without a driver (a side panel, a passive marker) are handled from the live connection in guard(), not from the
  // assessment, which remembers a panel for two minutes after it closed
  ({ resource, title, onAgent: agent, onArtifact: 'allow', onUnknown: 'allow', onHumanLike: 'allow', actOn: ACT, minScore: 65 });

export const DOGFOOD_POLICY: Policy = {
  version: 'onehuman-portal-1',
  enforcement: 'enforce',
  rules: [
    rule('portal.account.read', 'Account and API keys', 'mask'),
    rule('portal.proofs.read', 'Decision proofs', 'mask'),
    rule('portal.adminkeys.read', 'Management keys', 'mask'),
    rule('portal.keys.lookup', 'Find a key by its value', 'mask'),
    rule('portal.keys.write', 'Create, rotate, revoke or delete API keys', 'mask'),
    rule('portal.adminkeys.write', 'Create or revoke management keys', 'mask'),
    rule('portal.password.write', 'Change the password', 'allow'),
    rule('portal.policy.write', 'Change the rules', 'allow'),
    { resource: 'portal.login', title: 'Sign in or sign up', onAgent: 'block', onArtifact: 'allow', onUnknown: 'allow', onHumanLike: 'allow', actOn: ACT, minScore: 65 },
  ],
};

/** What the owner reads in the alert, per protected route. */
const ACTIONS: Record<string, string> = {
  'POST /api/v1/portal/keys': 'created an API key',
  'POST /api/v1/portal/connect': 'connected an app from the command line (a new API key)',
  'POST /api/v1/portal/keys/revoke': 'revoked an API key',
  'POST /api/v1/portal/keys/rename': 'renamed an API key',
  'POST /api/v1/portal/keys/rotate': 'rotated an API key',
  'POST /api/v1/portal/keys/delete': 'deleted an API key',
  'POST /api/v1/portal/account/password': 'changed the password',
  'POST /api/v1/portal/admin-keys': 'created a management key',
  'POST /api/v1/portal/admin-keys/revoke': 'revoked a management key',
  'POST /api/v1/portal/policy': 'changed the rules',
  'POST /api/v1/portal/policy/settings': 'changed rule settings',
  'POST /api/v1/portal/policy/decide': 'accepted or rejected a rule change',
  'POST /api/v1/portal/policy/assist': 'asked the rules assistant',
};

/** Resources whose answer is masked whenever an agent is present, even when the decision itself was allow. */
const MASKED = new Set(DOGFOOD_POLICY.rules.filter((r) => r.onAgent === 'mask').map((r) => r.resource));
/** Connection states that mean an agent is in, or beside, this tab. */
const PRESENT = new Set(['agent_attached', 'signed_agent', 'agent_environment']);
const ATTACHED = new Set(['agent_attached', 'signed_agent']);

const SECRET_KEYS = /^(key|secret|token|raw|proof|jws|signature)$/i;
/** Walk an answer and hide what an agent must not read: secrets entirely, e-mail local parts, key prefixes past the type. */
export function maskForAgent(v: unknown, key = ''): unknown {
  if (Array.isArray(v)) return v.map((x) => maskForAgent(x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, maskForAgent(x, k)]));
  if (typeof v !== 'string') return v;
  if (SECRET_KEYS.test(key)) return '••••';
  if (/email/i.test(key)) return v.replace(/^(.).*(@.*)$/, '$1•••$2');
  if (key === 'prefix') return v.replace(/^(oh_[a-z]+_).*$/, '$1••••');
  if (/^oh_(live|admin)_[a-f0-9]{8,}$/.test(v)) return v.slice(0, 8) + '••••';
  return v;
}

/** Rewrite the JSON answer a handler writes with json(): masked, marked, and without the old Content-Length. */
function maskAnswer(res: Res) {
  const writeHead = res.writeHead.bind(res) as (...a: unknown[]) => Res;
  const end = res.end.bind(res) as (...a: unknown[]) => Res;
  (res as unknown as { writeHead: (...a: unknown[]) => Res }).writeHead = (status: unknown, ...rest: unknown[]) => {
    const h = rest.find((x) => x && typeof x === 'object') as Record<string, unknown> | undefined;
    if (h) for (const k of Object.keys(h)) if (k.toLowerCase() === 'content-length') delete h[k];
    res.removeHeader('Content-Length');
    return writeHead(status, ...rest);
  };
  (res as unknown as { end: (...a: unknown[]) => Res }).end = (chunk?: unknown, ...rest: unknown[]) => {
    if (chunk !== undefined && chunk !== null && /json/.test(String(res.getHeader('Content-Type') ?? ''))) {
      try { const v = JSON.parse(String(chunk)); chunk = JSON.stringify(v && typeof v === 'object' && !Array.isArray(v) ? { ...(maskForAgent(v) as object), _masked: true } : maskForAgent(v)); } catch { /* not JSON: leave it */ }
    }
    return end(chunk, ...rest);
  };
}

export type Dogfood = {
  oh: OneHumanInstance;
  /** wrap a portal handler: decide for `resource`, mask the answer when the rule says so, alert the owner on writes by an agent */
  guard(resource: string, handler: (req: Req, res: Res) => unknown): (req: Req, res: Res) => Promise<void>;
  /** wrap sign-in / sign-up: an AI agent typing the credentials gets 403, a person goes through */
  guardLogin(handler: (req: Req, res: Res) => unknown): (req: Req, res: Res) => Promise<void>;
};

type Presence = { present: boolean; attached: boolean; tools: string[] };
function presenceOf(d: OhReq['onehuman'] | undefined): Presence {
  const full = d?.full as { branch?: string; connection?: string; tools?: string[] } | null | undefined;
  if (!full) return { present: false, attached: false, tools: [] };
  // the connection is this moment's picture (a side panel closed = gone); the assessment remembers the last two minutes
  const state = full.connection ?? 'none';
  const present = full.branch === 'agent' || PRESENT.has(state);
  return { present, attached: full.branch === 'agent' || ATTACHED.has(state), tools: full.tools ?? [] };
}

export async function startDogfood(opts: { client?: SqlClient; engineStore?: Store; secret?: Buffer; apiKey?: string; store: SiteStore; accountOf: (req: Req) => Promise<string | null>; serverless?: boolean; license?: string }): Promise<Dogfood | null> {
  const secret = opts.secret ? Buffer.from(hkdfSync('sha256', opts.secret, 'onehuman', 'dogfood-portal', 32)).toString('hex') : undefined;
  let oh: OneHumanInstance;
  try {
    oh = await onehuman({
      secret: secret ?? crypto.randomUUID() + crypto.randomUUID(), policy: DOGFOOD_POLICY, store: opts.engineStore, client: opts.client, db: opts.client || opts.engineStore ? undefined : 'memory',
      cookie: 'oh_portal_sid', tenant: 'onehuman-portal', identify: (req) => opts.accountOf(req as Req),
      apiKey: opts.apiKey ?? '', policyFromPortal: false, telemetryImmediate: opts.serverless, license: opts.license,
    });
  } catch (e) {
    console.warn(`onehuman: the portal's own protection did not start (${(e as Error).message}); the portal runs without it`);
    return null;
  }
  return {
    oh,
    guard(resource, handler) {
      return async (req, res) => {
        // signed out: the handler answers 401 (or the landing's probe) and hands out nothing, so there is nothing to decide
        const account = await opts.accountOf(req);
        if (!account) { await handler(req, res); return; }
        await new Promise<void>((done) => { oh.protect(resource, { respond: false })(req as OhReq, res, () => done()); });
        const d = (req as OhReq).onehuman;
        const p = presenceOf(d);
        if (d?.masked || (p.present && MASKED.has(resource))) maskAnswer(res);
        await handler(req, res);
        if (!p.present || !d?.session) return;
        const at = Date.now();
        // once per portal session: the owner learns an agent was connected, even if it only read
        if (await opts.store.consumeNonce(`portal-agent:${d.session.id}`, 12 * 3600e3, at).catch(() => false)) {
          await opts.store.addPortalAlert({ account, at, resource, action: p.attached ? 'was connected to your signed-in tab' : 'was open beside your signed-in tab', tools: p.tools }).catch(() => {});
        }
        const action = ACTIONS[`${req.method} ${(req.url ?? '').split('?')[0]}`];
        if (!action || res.statusCode >= 400) return;
        await opts.store.addPortalAlert({ account, at, resource, action, tools: p.tools }).catch(() => {});
      };
    },
    guardLogin(handler) {
      return async (req, res) => {
        await new Promise<void>((done) => { oh.protect('portal.login', { respond: false })(req as OhReq, res, () => done()); });
        const d = (req as OhReq).onehuman;
        const p = presenceOf(d);
        // driven by an agent, or a side panel open and nothing that looks like a person typing: refuse
        if (d && (d.blocked || p.attached || (p.present && d.actor !== 'human_like'))) {
          json(res, 403, { error: 'agent_login_blocked', message: 'An AI agent is connected to this tab. On onehuman.ai, sign-in and sign-up are typed by a person: close the agent (or its side panel) and enter your password yourself.' });
          return;
        }
        await handler(req, res);
      };
    },
  };
}
