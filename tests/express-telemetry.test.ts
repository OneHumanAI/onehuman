// SPDX-License-Identifier: BUSL-1.1
/** The middleware reports its decisions to the portal with an API key; the portal shows them per key. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.ts';
import { onehuman } from '../integrations/express/index.ts';

const portal = await createApp({ labOperator: false });
await new Promise<void>((r) => portal.server.listen(0, '127.0.0.1', () => r()));
const pbase = `http://127.0.0.1:${(portal.server.address() as AddressInfo).port}`;

// a customer account with one key
const H = { 'Content-Type': 'application/json', Origin: pbase };
const signup = await fetch(`${pbase}/api/v1/portal/signup`, { method: 'POST', headers: H, body: JSON.stringify({ email: 'cto@fintech.example', password: 'longenough1' }) });
const cookie = signup.headers.get('set-cookie')!.split(';')[0]!;
const key = await (await fetch(`${pbase}/api/v1/portal/keys`, { method: 'POST', headers: { ...H, Cookie: cookie }, body: JSON.stringify({ name: 'staging' }) })).json();

const policy = { version: 'tele-1', enforcement: 'observe', rules: [{ resource: 'balance.read', title: 'Balance', onAgent: 'mask', onArtifact: 'mask', onUnknown: 'allow', onHumanLike: 'allow', actOn: ['verified', 'strong', 'control', 'behavioral'], minScore: 65 }] };
const oh = await onehuman({ secret: 'test-secret-test-secret-test-secret-1234', policy: policy as never, db: 'memory', apiKey: key.key, telemetryUrl: `${pbase}/api/v1/ingest` });
const app = express();
app.use(oh.middleware());
app.get('/api/balance', oh.protect('balance.read'), (req, res) => oh.send(req, res, { balance: 10 }, (a) => ({ ...a, balance: null })));
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(async () => { server.close(); await oh.close(); portal.server.close(); portal.store.close(); });

test('decisions made by the middleware arrive in the portal under the right key', async () => {
  assert.ok(oh.telemetry, 'reporter exists when an apiKey is given');
  const r1 = await fetch(`${base}/api/balance`); assert.equal(r1.status, 200);
  const c = (r1.headers.get('set-cookie') ?? '').split(';')[0]!;
  const r2 = await fetch(`${base}/api/balance`, { headers: { Cookie: c } }); assert.equal(r2.status, 200);
  // the event is queued after an async connection lookup; give it a tick, then push the batch
  await new Promise((r) => setTimeout(r, 150));
  await oh.telemetry!.flush();
  const st = await (await fetch(`${pbase}/api/v1/portal/stats?key=${key.id}&range=24h`, { headers: { Cookie: cookie } })).json();
  assert.equal(st.decisions.allow, 2, JSON.stringify(st.decisions));
  assert.equal(st.sessions.total, 1, 'both requests came from one browser session');
  assert.equal(st.recent[0].resource, 'balance.read');
  assert.equal(st.recent[0].enforcement, 'observe');
  assert.match(st.recent[0].session, /^[a-f0-9]{16}$/, 'session ids are hashed before they leave the server');
  assert.equal(oh.telemetry!.pending, 0);
});

test('without an apiKey nothing is reported and no reporter exists', async () => {
  const quiet = await onehuman({ secret: 'test-secret-test-secret-test-secret-1234', policy: policy as never, db: 'memory' });
  assert.equal(quiet.telemetry, null);
  await quiet.close();
});

test('every decision is signed server-side, reaches the portal verified, and exports as an auditor bundle', async () => {
  // the end user sees nothing new: no proof header, no proof in the body
  const r = await fetch(`${base}/api/balance`);
  const body = await r.json();
  assert.equal(r.headers.get('x-oh-proof'), null, 'no proof is sent to the browser');
  assert.equal(JSON.stringify(body).includes('eyJ'), false, 'no JWS in the response body');

  // the public key is published next to the SDK, for an auditor
  const jwks = await (await fetch(`${base}/onehuman/proof-keys`)).json();
  assert.equal(jwks.keys.length, 1);
  assert.equal(jwks.keys[0].crv, 'Ed25519');
  assert.equal('d' in jwks.keys[0], false, 'never the private part');

  await new Promise((res) => setTimeout(res, 150));
  await oh.telemetry!.flush();
  const st = await (await fetch(`${pbase}/api/v1/portal/stats?key=${key.id}&range=24h`, { headers: { Cookie: cookie } })).json();
  assert.equal(st.recent[0].signed, true, 'the portal checked the signature at ingest');

  // the business downloads the bundle; the portal's stateless verifier (or any JOSE library) accepts it
  const bundle = await (await fetch(`${pbase}/api/v1/portal/proofs?key=${key.id}&range=24h`, { headers: { Cookie: cookie } })).json();
  assert.equal(bundle.format, 'onehuman-proof-bundle/1');
  assert.ok(bundle.proofs.length >= 3);
  assert.equal(bundle.keys[0].x, jwks.keys[0].x, 'the bundle carries the same key the deployment publishes');
  const v = await (await fetch(`${pbase}/api/v1/proof/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bundle) })).json();
  assert.equal(v.invalid, 0);
  assert.equal(v.results[0].resource, 'balance.read');
  assert.equal(v.results[0].delivered, true);

  // one changed byte in one proof, and the verifier says so
  const [h, p, s] = bundle.proofs[0].split('.');
  const forged = JSON.parse(Buffer.from(p, 'base64url').toString()); forged.decision = 'block';
  const bad = { ...bundle, proofs: [`${h}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${s}`] };
  const v2 = await (await fetch(`${pbase}/api/v1/proof/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bad) })).json();
  assert.equal(v2.valid, 0);
  assert.equal(v2.results[0].reason, 'bad_signature');

  // the middleware exposes the same bundle for its own records
  const firstSession = (await oh.store.listSessions(oh.room))[0]!;
  const local = await oh.proofBundle(firstSession.id);
  assert.ok(local.proofs.length >= 1);
  assert.equal(oh.verifyProof(local.proofs[0]!).valid, true);
});

test('a batch sent twice (retry after a timeout) is stored and counted once', async () => {
  const ev = { at: Date.now(), session: 'aaaabbbbccccdddd', resource: 'balance.read', decision: 'allow', actor: 'unknown', state: 'no_indication', tools: [], reasons: [], enforcement: 'observe', version: 'x', eid: 'retry-test-eid-0001' };
  const send = () => fetch(`${pbase}/api/v1/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.key}` }, body: JSON.stringify({ events: [ev, { ...ev, eid: 'retry-test-eid-0002' }] }) }).then((r) => r.json());
  const before = (await (await fetch(`${pbase}/api/v1/portal/me`, { headers: { Cookie: cookie } })).json()).keys.find((k: { id: string }) => k.id === key.id).events;
  const first = await send();
  const second = await send();
  assert.equal(first.stored, 2);
  assert.equal(second.stored, 0, 'the same ids are not stored again');
  assert.equal(second.duplicates, 2);
  const after = (await (await fetch(`${pbase}/api/v1/portal/me`, { headers: { Cookie: cookie } })).json()).keys.find((k: { id: string }) => k.id === key.id).events;
  assert.equal(after - before, 2, 'the key counts each event once');
});

test('immediate mode (serverless) delivers without waiting for the batch timer', async () => {
  const quick = await onehuman({ secret: 'test-secret-test-secret-test-secret-5678', policy: policy as never, db: 'memory', apiKey: key.key, telemetryUrl: `${pbase}/api/v1/ingest`, telemetryImmediate: true });
  const a = express(); a.use(quick.middleware());
  a.get('/api/balance', quick.protect('balance.read'), (req, res) => quick.send(req, res, { balance: 1 }, (x) => x));
  const s = a.listen(0); const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const before = (await (await fetch(`${pbase}/api/v1/portal/me`, { headers: { Cookie: cookie } })).json()).keys.find((k: { id: string }) => k.id === key.id).events;
  await fetch(`${b}/api/balance`);
  // no flush() call: the event must arrive on its own well inside the 3 s batch interval
  let after = before;
  for (let i = 0; i < 20 && after === before; i++) { await new Promise((r) => setTimeout(r, 100)); after = (await (await fetch(`${pbase}/api/v1/portal/me`, { headers: { Cookie: cookie } })).json()).keys.find((k: { id: string }) => k.id === key.id).events; }
  assert.equal(after - before, 1, 'delivered within 2 s without an explicit flush');
  s.close(); await quick.close();
});

test('a customer grades a decision; false stops are counted on the stats', async () => {
  await fetch(`${base}/api/balance`);
  await new Promise((r) => setTimeout(r, 150)); await oh.telemetry!.flush();
  let st = await (await fetch(`${pbase}/api/v1/portal/stats?key=${key.id}&range=24h`, { headers: { Cookie: cookie } })).json();
  const row = st.recent[0];
  assert.equal(row.feedback, null);
  // an allow marked wrong is a miss, not a false stop
  let r = await fetch(`${pbase}/api/v1/portal/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: pbase, Cookie: cookie }, body: JSON.stringify({ key: key.id, id: row.id, verdict: 'wrong', note: 'that was Claude' }) });
  assert.equal((await r.json()).ok, true);
  st = await (await fetch(`${pbase}/api/v1/portal/stats?key=${key.id}&range=24h`, { headers: { Cookie: cookie } })).json();
  assert.equal(st.recent[0].feedback, 'wrong');
  assert.equal(st.feedback.reviewed, 1);
  assert.equal(st.feedback.misses, 1);
  assert.equal(st.feedback.falseStops, 0);
  // clearing it
  r = await fetch(`${pbase}/api/v1/portal/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: pbase, Cookie: cookie }, body: JSON.stringify({ key: key.id, id: row.id, verdict: null }) });
  st = await (await fetch(`${pbase}/api/v1/portal/stats?key=${key.id}&range=24h`, { headers: { Cookie: cookie } })).json();
  assert.equal(st.feedback.reviewed, 0);
  // another account's key cannot be graded
  r = await fetch(`${pbase}/api/v1/portal/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: pbase, Cookie: cookie }, body: JSON.stringify({ key: 'not-mine', id: row.id, verdict: 'wrong' }) });
  assert.equal(r.status, 400);
});

test('health reports the policy and the reporter; a constant identify() flips it to 503 with the reason', async () => {
  let h = await fetch(`${base}/onehuman/health`);
  assert.equal(h.status, 200);
  const body = await h.json();
  assert.equal(body.ok, true);
  // with an API key the policy file went to the portal as version 1 and the server now runs the portal's signed copy
  assert.equal(body.policy.version, 'portal-v1'); assert.equal(body.policy.source, 'portal'); assert.equal(body.telemetry.enabled, true); assert.match(body.proofKey, /^[A-Za-z0-9_-]{43}$/);

  // the footgun: identify() returns the same string for everyone
  const bad = await onehuman({ secret: 'test-secret-test-secret-test-secret-9999', policy: policy as never, db: 'memory', identify: () => 'tenant-a' });
  const a = express(); a.use(bad.middleware()); a.get('/api/balance', bad.protect('balance.read'), (req, res) => bad.send(req, res, { b: 1 }, (x) => x));
  const s = a.listen(0); const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  for (let i = 0; i < 6; i++) await fetch(`${b}/api/balance`, { headers: { 'x-forwarded-for': `10.0.0.${i}`, 'user-agent': `Browser/${i}` } });
  h = await fetch(`${b}/onehuman/health`);
  assert.equal(h.status, 503);
  const hb = await h.json();
  assert.equal(hb.ok, false);
  assert.match(hb.warnings[0], /identify\(\) returned "tenant-a" for \d+ different clients/);
  assert.equal(bad.health().ok, false);
  s.close(); await bad.close();
});

test('the portal builds the 30-day report from what the server reported, as JSON and as a printable page', async () => {
  await fetch(`${base}/api/balance`);
  await new Promise((r) => setTimeout(r, 150)); await oh.telemetry!.flush();
  let r = await fetch(`${pbase}/api/v1/portal/report?key=${key.id}&days=30`, { headers: { Cookie: cookie } });
  assert.equal(r.status, 200);
  const rep = await r.json();
  assert.equal(rep.source, 'portal');
  assert.ok(rep.decisions.total > 0);
  assert.ok(rep.endpoints.some((e: { resource: string }) => e.resource === 'balance.read'));
  r = await fetch(`${pbase}/api/v1/portal/report?key=${key.id}&days=30&format=html`, { headers: { Cookie: cookie } });
  assert.match(r.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await r.text(), /30-day report/);
  assert.equal((await fetch(`${pbase}/api/v1/portal/report?key=${key.id}`)).status, 401, 'signed-in owners only');
});
