// SPDX-License-Identifier: BUSL-1.1
/**
 * What a fresh install met (2026-09-30):
 * - the page script reports before the login is known; that evidence must reach the login's session before its first
 *   decision, or an agent attached at page load reads the first protected answer;
 * - an agent in a session must not be able to add a passkey (a virtual authenticator would then approve its own actions);
 * - a login's passkeys are its own: another user's passkey neither shows up nor verifies.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { onehuman } from '../integrations/express/index.ts';
import { b64u, SoftAuthenticator } from './soft-authenticator.ts';

const ACT = ['verified', 'strong', 'control', 'behavioral'];
const policy = { version: 'fresh-install', enforcement: 'enforce', rules: [{ resource: 'balance.read', title: 'Balance', onAgent: 'block', onArtifact: 'allow', onUnknown: 'allow', onHumanLike: 'allow', actOn: ACT, minScore: 65 }] };
const oh = await onehuman({ secret: 'identity-passkeys-secret-identity-passkeys', policy: policy as never, db: 'memory', identify: (req) => (req as unknown as { user?: { id: string } }).user?.id ?? null });
const app = express();
app.use(express.json());
// as `init` used to write it: OneHuman before the app's login middleware, so identify() sees no login on /onehuman/*
app.use(oh.middleware());
app.use((req, _res, next) => { const u = req.headers['x-user']; (req as unknown as { user?: { id: string } }).user = typeof u === 'string' ? { id: u } : undefined; next(); });
app.get('/api/balance', oh.protect('balance.read'), (_req, res) => res.json({ balance: 100 }));
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => { server.close(); oh.close(); });

const early = (markers: { name: string; atMs: number }[]) => ({ startedMs: 0, observedMs: 800, webdriver: false, firstInteractionMs: null, dataDomMs: null, markers, environment: { codexModelContext: false, modelContextApi: false, clipboardBridge: false, clipboardBridgeAtMs: null, agentGlobals: [], extensionsInstalled: [], focusWhileHiddenMs: null }, focusConflict: { count: 0, firstAtMs: null, peers: 0 }, webmcpInvocations: 0 });

function browser(user: string | null) {
  const jar = new Map<string, string>();
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const take = (r: Response) => { for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv!.indexOf('='); jar.set(kv!.slice(0, i), kv!.slice(i + 1)); } return r; };
  const headers = (json = false) => ({ cookie: cookie(), origin: base, ...(user ? { 'x-user': user } : {}), ...(json ? { 'content-type': 'application/json' } : {}) });
  return {
    get: (p: string) => fetch(base + p, { headers: headers() }).then(take),
    post: (p: string, body: unknown, asUser = true) => fetch(base + p, { method: 'POST', headers: asUser ? headers(true) : { cookie: cookie(), origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(take),
    jar,
  };
}

async function registerPasskey(b: ReturnType<typeof browser>) {
  const auth = new SoftAuthenticator();
  const o = await (await b.post('/onehuman/webauthn/register/options', {})).json();
  const r = await b.post('/onehuman/webauthn/register', { challengeId: o.challengeId, id: b64u(auth.credId), ...auth.register(o.challengeId, base, '127.0.0.1') });
  assert.equal(r.status, 201);
  return auth;
}

test('an agent seen before the login is known is still seen at the first protected request', async () => {
  const b = browser('ada');
  // the page script's first report: no login visible to OneHuman yet (its middleware runs before the login's)
  assert.equal((await b.post('/onehuman/signals', { early: early([{ name: 'claude-stop', atMs: 600 }]), interaction: null }, false)).status, 200);
  const first = await b.get('/api/balance');
  assert.equal(first.status, 403, 'the very first protected answer already knows about the agent');
  // a person on another login, same kind of page, is not affected
  const p = browser('bob');
  await p.post('/onehuman/signals', { early: early([]), interaction: null }, false);
  assert.equal((await p.get('/api/balance')).status, 200);
});

test('a passkey cannot be added while an agent is in the session; a person adds one', async () => {
  const agent = browser('carol');
  await agent.get('/api/balance');
  await agent.post('/onehuman/signals', { early: early([{ name: 'claude-glow', atMs: 500 }]), interaction: null });
  const refused = await agent.post('/onehuman/webauthn/register/options', {});
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error, 'agent_present');

  const person = browser('dave');
  await person.get('/api/balance');
  await registerPasskey(person);
  const st = await (await person.get('/onehuman/webauthn/status')).json();
  assert.equal(st.credentials.length, 1);
});

test("a login's passkeys are its own: another user's is neither offered nor accepted", async () => {
  const a = browser('erin');
  await a.get('/api/balance');
  const erinKey = await registerPasskey(a);
  const b = browser('frank');
  await b.get('/api/balance');
  const none = await b.post('/onehuman/webauthn/assert/options', { resource: 'balance.read' });
  assert.equal(none.status, 404, 'frank has no passkey, and erin\'s is not offered to him');
  // frank registers his own; erin's credential still does not verify in his session
  await registerPasskey(b);
  const o = await (await b.post('/onehuman/webauthn/assert/options', { resource: 'balance.read' })).json();
  assert.equal(o.publicKey.allowCredentials.length, 1, 'only his own');
  const forged = await b.post('/onehuman/webauthn/assert', { challengeId: o.challengeId, ...erinKey.assert(o.challengeId, base, '127.0.0.1') });
  assert.equal(forged.status, 404);
  assert.equal((await forged.json()).error, 'unknown_credential');
});

test('inside an AI browser, a passkey request with no click behind it is refused too', async () => {
  const ua = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Claude/2.2553.1 Chrome/152.0.0.0 Safari/537.36';
  const h = { 'x-user': 'gina', origin: base, 'content-type': 'application/json', 'user-agent': ua };
  const first = await fetch(`${base}/api/balance`, { headers: h });
  const cookie = first.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const r = await fetch(`${base}/onehuman/webauthn/register/options`, { method: 'POST', headers: { ...h, cookie }, body: '{}' });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'agent_present');
});
