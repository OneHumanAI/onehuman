// SPDX-License-Identifier: Apache-2.0
/**
 * A person's confirmation covers the one request it was given for. When an AI agent's request waits for the owner's
 * passkey, the approval lets that request through once (same method, path and body) and nothing else: not the same
 * action with another recipient or amount, not an action nobody asked for. Reported by Marco (marcologs.com),
 * 2026-10-05; his two cases are the first two tests, with the outcome they should have.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { onehuman } from '../integrations/express/index.ts';
import { b64u, SoftAuthenticator } from './soft-authenticator.ts';

const ACT = ['verified', 'strong', 'control', 'behavioral'];
const policy = { version: 'lab', enforcement: 'enforce', rules: [
  { resource: 'transfer.create', title: 'Transfer', onAgent: 'step_up', onArtifact: 'step_up', onUnknown: 'step_up', onHumanLike: 'allow', actOn: ACT, minScore: 65 },
  { resource: 'report.export', title: 'Export', onAgent: 'step_up', onArtifact: 'step_up', onUnknown: 'step_up', onHumanLike: 'allow', actOn: ACT, minScore: 65 },
] };
const oh = await onehuman({ secret: 'lab-secret-lab-secret-lab-secret-lab-secret', policy: policy as never, db: 'memory', identify: (req) => (req as { user?: { id: string } }).user?.id ?? null });
const app = express();
app.use(express.json());
app.use((req, _res, next) => { const u = req.headers['x-user']; (req as { user?: { id: string } }).user = typeof u === 'string' ? { id: u } : undefined; next(); });
app.use(oh.middleware());
app.post('/api/transfer', oh.protect('transfer.create', { describe: (req) => `Send ${req.body?.amount} EUR to ${req.body?.to}` }), (req, res) => res.json({ ok: true, executed: req.body }));
app.get('/api/export', oh.protect('report.export'), (req, res) => res.json({ ok: true, rows: req.query.rows }));
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => { server.close(); oh.close(); });

const early = (markers: { name: string; atMs: number }[]) => ({ startedMs: 0, observedMs: 800, webdriver: false, firstInteractionMs: null, dataDomMs: null, markers, environment: { codexModelContext: false, modelContextApi: false, clipboardBridge: false, clipboardBridgeAtMs: null, agentGlobals: [], extensionsInstalled: [], focusWhileHiddenMs: null }, focusConflict: { count: 0, firstAtMs: null, peers: 0 }, webmcpInvocations: 0 });

function browser(user: string) {
  const jar = new Map<string, string>();
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const take = (r: Response) => { for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv!.indexOf('='); jar.set(kv!.slice(0, i), kv!.slice(i + 1)); } return r; };
  const headers = { origin: base, 'x-user': user, 'content-type': 'application/json' };
  return {
    get: (p: string) => fetch(base + p, { headers: { ...headers, cookie: cookie() } }).then(take),
    post: (p: string, body: unknown) => fetch(base + p, { method: 'POST', headers: { ...headers, cookie: cookie() }, body: JSON.stringify(body) }).then(take),
  };
}

/** a signed-in user with a passkey, and (unless `agent` is false) an AI agent attached to the tab */
async function setup(user: string, agent = true) {
  const b = browser(user);
  await b.get('/onehuman/webauthn/status');
  const auth = new SoftAuthenticator();
  const o = await (await b.post('/onehuman/webauthn/register/options', {})).json();
  assert.equal((await b.post('/onehuman/webauthn/register', { challengeId: o.challengeId, id: b64u(auth.credId), ...auth.register(o.challengeId, base, '127.0.0.1') })).status, 201);
  if (agent) assert.equal((await b.post('/onehuman/signals', { early: early([{ name: 'claude-stop', atMs: 600 }]), interaction: null })).status, 200);
  return { b, auth };
}

async function approve(b: ReturnType<typeof browser>, auth: SoftAuthenticator, ask: Record<string, unknown>) {
  const r = await b.post('/onehuman/webauthn/assert/options', { purpose: 'approve', ...ask });
  if (r.status !== 200) return { status: r.status, body: await r.json() };
  const o = await r.json();
  const a = await b.post('/onehuman/webauthn/assert', { challengeId: o.challengeId, ...auth.assert(o.challengeId, base, '127.0.0.1') });
  return { status: a.status, body: { ...o, ...(await a.json()) } };
}

test('an approval lets the held request through once, and not the same action with other arguments', async () => {
  const { b, auth } = await setup('ada');
  const held = await b.post('/api/transfer', { to: 'alice', amount: 10 });
  assert.equal(held.status, 428);
  const { stepUp } = await held.json();
  assert.equal(stepUp.approve, true);
  // the person sees what they approve: the rule's title, the app's own words, the request
  assert.deepEqual(stepUp.summary, { title: 'Transfer', request: 'POST /api/transfer', detail: 'Send 10 EUR to alice' });
  // an older page that names only the resource still approves the one request held for it
  const ok = await approve(b, auth, { resource: 'transfer.create' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.approving.stepUpId, stepUp.id);
  assert.equal(ok.body.approving.summary.detail, 'Send 10 EUR to alice');

  const swapped = await b.post('/api/transfer', { to: 'mallory', amount: 10000 });
  assert.equal(swapped.status, 428, 'another recipient and amount wait for their own approval');
  const same = await b.post('/api/transfer', { amount: 10, to: 'alice' });   // the same request (key order does not matter)
  assert.equal(same.status, 200);
  assert.deepEqual((await same.json()).executed, { amount: 10, to: 'alice' });
  assert.equal((await b.post('/api/transfer', { to: 'alice', amount: 10 })).status, 428, 'once only');
});

test('nothing can be approved before a request is held', async () => {
  const { b, auth } = await setup('bea');
  const r = await approve(b, auth, { resource: 'transfer.create' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'nothing_to_approve');
  assert.equal((await b.post('/api/transfer', { to: 'mallory', amount: 10000 })).status, 428);
});

test('with two requests waiting, the approval names one by its id; a resource alone is not enough', async () => {
  const { b, auth } = await setup('cem');
  const first = (await (await b.post('/api/transfer', { to: 'alice', amount: 10 })).json()).stepUp;
  const second = (await (await b.post('/api/transfer', { to: 'mallory', amount: 9000 })).json()).stepUp;
  assert.notEqual(first.id, second.id);
  const vague = await approve(b, auth, { resource: 'transfer.create' });
  assert.equal(vague.status, 409);
  assert.equal(vague.body.error, 'ambiguous');
  const exact = await approve(b, auth, { stepUpId: first.id });
  assert.equal(exact.status, 200);
  assert.equal((await b.post('/api/transfer', { to: 'mallory', amount: 9000 })).status, 428, 'the one not approved still waits');
  assert.equal((await b.post('/api/transfer', { to: 'alice', amount: 10 })).status, 200);
});

test("another session's held request cannot be approved from here, and an approved id cannot be approved twice", async () => {
  const one = await setup('dan');
  const two = await setup('eve');
  const held = (await (await one.b.post('/api/transfer', { to: 'alice', amount: 10 })).json()).stepUp;
  assert.equal((await approve(two.b, two.auth, { stepUpId: held.id })).status, 404);
  assert.equal((await approve(one.b, one.auth, { stepUpId: held.id })).status, 200);
  assert.equal((await approve(one.b, one.auth, { stepUpId: held.id })).status, 404, 'already approved');
});

test('the query is part of the request: an approved export of 10 rows does not export everything', async () => {
  const { b, auth } = await setup('fay');
  const held = await b.get('/api/export?rows=10');
  assert.equal(held.status, 428);
  const { stepUp } = await held.json();
  assert.equal(stepUp.summary.request, 'GET /api/export', 'the query is not shown, only bound');
  assert.equal((await approve(b, auth, { stepUpId: stepUp.id })).status, 200);
  assert.equal((await b.get('/api/export?rows=all')).status, 428);
  assert.equal((await b.get('/api/export?rows=10')).status, 200);
});

test('a code confirmation (no agent proven) also covers only the request it was shown for', async () => {
  const b = browser('gus');
  await b.get('/onehuman/webauthn/status');
  const held = await b.post('/api/transfer', { to: 'alice', amount: 10 });
  assert.equal(held.status, 428);
  const { stepUp } = await held.json();
  assert.ok(stepUp.challenge, 'a code, since no agent is proven');
  const ok = await b.post('/onehuman/step-up', { id: stepUp.id, answer: stepUp.challenge });
  assert.equal(ok.status, 200);
  assert.equal((await b.post('/api/transfer', { to: 'mallory', amount: 10000 })).status, 428);
  assert.equal((await b.post('/api/transfer', { to: 'alice', amount: 10 })).status, 200);
});

test("an app's own verification may still grant the resource as a whole (grantStepUp, documented)", async () => {
  const { b } = await setup('hal');
  const held = await b.post('/api/transfer', { to: 'alice', amount: 10 });
  assert.equal(held.status, 428);
  const s = await oh.engine.store.getStepUp((await held.json()).stepUp.id);
  await oh.engine.store.grantStepUp(s!.session, 'transfer.create', 60_000);
  assert.equal((await b.post('/api/transfer', { to: 'bob', amount: 5 })).status, 200, 'any one request, as the app chose');
  assert.equal((await b.post('/api/transfer', { to: 'bob', amount: 5 })).status, 428);
});
