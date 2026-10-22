// SPDX-License-Identifier: BUSL-1.1
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { onehuman } from '../integrations/express/index.ts';
import { EMPTY_READING } from '../server/signals.ts';

const policy = {
  version: 'test-policy-1',
  enforcement: 'enforce',
  rules: [
    { resource: 'balance.read', title: 'Balance', onAgent: 'block', onArtifact: 'mask', onUnknown: 'allow', onHumanLike: 'allow', actOn: ['verified', 'strong', 'control', 'behavioral'], minScore: 65 },
    { resource: 'transfer.make', title: 'Transfer', onAgent: 'block', onArtifact: 'step_up', onUnknown: 'step_up', onHumanLike: 'allow', actOn: ['verified', 'strong', 'control', 'behavioral'], minScore: 65 },
  ],
};
const early = { startedMs: 0, observedMs: 500, webdriver: false, firstInteractionMs: null, dataDomMs: null, markers: [] as { name: string; atMs: number }[], environment: { codexModelContext: false, modelContextApi: false, clipboardBridge: false, clipboardBridgeAtMs: null, agentGlobals: [], extensionsInstalled: [], focusWhileHiddenMs: null }, focusConflict: { count: 0, firstAtMs: null, peers: 0 }, webmcpInvocations: 0, reading: { ...EMPTY_READING } };

const secret = 'test-secret-test-secret-test-secret-1234';
const oh = await onehuman({ secret, policy: policy as never, db: 'memory', explain: true, identify: (req) => (req.headers['x-user'] as string | undefined) || null });
const app = express();
app.use(express.json());
app.use(oh.middleware());
const account = { balance: 2920.74, iban: 'AZ21NABZ00000000137010001944' };
app.get('/api/balance', oh.protect('balance.read'), (req, res) => oh.send(req, res, account, (a) => ({ ...a, balance: null })));
app.post('/api/transfer', oh.protect('transfer.make'), (req, res) => res.json({ ok: true, decision: req.onehuman!.decision }));
app.get('/api/manual', oh.protect('balance.read', { respond: false }), (req, res) => res.json({ handled: req.onehuman!.decision }));
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => { server.close(); oh.close(); });

const cookieOf = (r: Response) => (r.headers.get('set-cookie') ?? '').split(';')[0]!;

test('serves the SDK next to its API and the SDK derives the endpoint from its own URL', async () => {
  const r = await fetch(`${base}/onehuman/sdk.js`);
  assert.equal(r.status, 200);
  const js = await r.text();
  assert.ok(js.includes("'/signals'"));
  assert.ok(js.includes('sdk-v4'));
});

test('first request creates a session cookie and an unknown actor is allowed by this policy', async () => {
  const r = await fetch(`${base}/api/balance`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie') ?? '', /^oh_sid=[0-9a-f-]{36}; Path=\/; HttpOnly; SameSite=Lax/);
  const d = await r.json();
  assert.equal(d.balance, 2920.74);
  assert.equal(d._onehuman.decision, 'allow');
  assert.ok(r.headers.get('x-oh-decision'));
});

test('identify(): two tabs of one login share one session; an agent marker in one blocks the other', async () => {
  const h = { 'x-user': 'user-42' };
  const a = await fetch(`${base}/api/balance`, { headers: h });
  assert.equal(a.status, 200);
  // tab 2 (no cookie) posts an agent control marker via the SDK endpoint
  const sig = await fetch(`${base}/onehuman/signals`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ early: { ...early, markers: [{ name: 'claude-stop', atMs: 900 }, { name: 'claude-cursor', atMs: 900 }] }, interaction: null }) });
  assert.equal(sig.status, 200);
  assert.equal((await sig.json()).connection.state, 'agent_attached');
  // tab 1 asks again with only its cookie → the login is agent-attached → block with reclaim offer
  const b = await fetch(`${base}/api/balance`, { headers: { cookie: cookieOf(a) } });
  assert.equal(b.status, 403);
  const d = await b.json();
  assert.equal(d.error, 'blocked');
  assert.ok(d.decision.reasonCodes.includes('AGENT_ATTACHED_EARLIER') || d.decision.reasonCodes.includes('AGENT_CONTROL_MARKER'));
  assert.equal(d.stepUp?.reclaim, true);
});

test('artifact-only evidence takes the mask branch and the company mask function is applied', async () => {
  const r = await fetch(`${base}/api/balance`, { headers: { 'x-user': 'user-7', 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Claude/2.2553.1 Chrome/152.0.0.0 Safari/537.36' } });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.balance, null, 'masked by the company function');
  assert.equal(d.iban, account.iban);
  assert.equal(d._onehuman.decision, 'mask');
});

test('step_up answers 428 with a challenge; respond:false hands the decision to the handler', async () => {
  const r = await fetch(`${base}/api/transfer`, { method: 'POST', headers: { 'x-user': 'user-9', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 428);
  const d = await r.json();
  assert.equal(d.error, 'step_up_required');
  assert.match(d.stepUp.challenge, /^[0-9A-F]{6}$/);
  const m = await fetch(`${base}/api/manual`, { headers: { 'x-user': 'user-9' } });
  assert.equal(m.status, 200);
  assert.equal((await m.json()).handled, 'allow');
});

test('policy from a file is validated; a broken file is rejected at start-up', async () => {
  await assert.rejects(onehuman({ secret, policy: { version: 'x', enforcement: 'enforce', rules: [{ resource: 'a' }] } as never, db: 'memory' }), /the policy is invalid: rule 1: resource must be/);
  await assert.rejects(onehuman({ secret: 'short', policy: policy as never, db: 'memory' }), /at least 32 bytes/);
});

test('by default the page learns the outcome, not the reasons (they would teach an agent what to hide)', async () => {
  const quiet = await onehuman({ secret, policy: policy as never, db: 'memory', identify: (req) => (req.headers['x-user'] as string | undefined) || null });
  const app2 = express();
  app2.use(express.json());
  app2.use(quiet.middleware());
  app2.get('/api/balance', quiet.protect('balance.read'), (req, res) => quiet.send(req, res, { amount: 5 }, (b) => ({ ...b, amount: null })));
  const server2 = app2.listen(0);
  const base2 = `http://127.0.0.1:${(server2.address() as AddressInfo).port}`;
  const early = { startedMs: 0, observedMs: 500, webdriver: false, firstInteractionMs: null, dataDomMs: null, markers: [{ name: 'claude-stop', atMs: 100 }], environment: { codexModelContext: false, modelContextApi: false, clipboardBridge: false, clipboardBridgeAtMs: null, agentGlobals: [], extensionsInstalled: [], focusWhileHiddenMs: null }, focusConflict: { count: 0, firstAtMs: null, peers: 0 }, webmcpInvocations: 0 };
  try {
    const quietSig = await fetch(`${base2}/onehuman/signals`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base2, 'x-user': 'quiet-0' }, body: JSON.stringify({ early: { ...early, markers: [] }, interaction: null }) });
    assert.deepEqual(await quietSig.json(), { connection: null }, 'nothing attached: the page learns nothing');
    const sig = await fetch(`${base2}/onehuman/signals`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base2, 'x-user': 'quiet-1' }, body: JSON.stringify({ early, interaction: null }) });
    const s = await sig.json();
    assert.deepEqual(s, { connection: { state: 'agent_attached' } }, 'only what the page script needs to seal: no actor, no evidence');
    const r = await fetch(`${base2}/api/balance`, { headers: { 'x-user': 'quiet-1' } });
    const body = await r.json();
    assert.equal(JSON.stringify(body).includes('reasonCodes'), false);
    assert.equal(JSON.stringify(body).includes('score'), false);
    assert.equal(JSON.stringify(body).includes('actor'), false, 'nor who it looked like');
  } finally { server2.close(); await quiet.close(); }
});

test('the owner\'s screen for their agent is served next to the SDK: what it may do, what it did, stricter at once', async () => {
  const h = { 'x-user': 'user-77', 'Content-Type': 'application/json', Origin: base };
  await fetch(`${base}/onehuman/signals`, { method: 'POST', headers: h, body: JSON.stringify({ early: { ...early, markers: [{ name: 'claude-stop', atMs: 400 }] }, interaction: null }) });
  assert.equal((await fetch(`${base}/api/balance`, { headers: h })).status, 403);
  const v = await (await fetch(`${base}/onehuman/access`, { headers: h })).json();
  assert.equal(v.connected, true);
  assert.deepEqual(v.tools, ['claude-chrome']);
  assert.deepEqual(v.actions.map((a: { resource: string; mayLoosen: boolean }) => [a.resource, a.mayLoosen]), [['balance.read', false], ['transfer.make', false]]);
  assert.ok(v.activity.some((a: { resource: string; decision: string }) => a.resource === 'balance.read' && a.decision === 'block'));
  assert.equal((await (await fetch(`${base}/onehuman/access`, { method: 'POST', headers: h, body: JSON.stringify({ resource: 'balance.read', choice: 'allow' }) })).json()).error, 'not_allowed');
  assert.equal((await fetch(`${base}/onehuman/access`, { method: 'POST', headers: h, body: JSON.stringify({ resource: '*', choice: 'never' }) })).status, 200);
  const other = await (await fetch(`${base}/onehuman/access`, { headers: { 'x-user': 'user-78' } })).json();
  assert.ok(other.actions.every((a: { choice: string | null }) => a.choice === null), 'one login\'s choices are its own');
});
