// SPDX-License-Identifier: BUSL-1.1
/**
 * A deployment serving a real domain needs a license: an API key (the portal hands its server a signed token, the
 * free plan included) or an offline license file. Without one requests pass through untouched (the app never
 * breaks); on a local host everything works without one. A plan past its limit, after 14 days of grace, gets a
 * token that says observe: OneHuman still watches and records, and enforces nothing.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.ts';
import { onehuman } from '../integrations/express/index.ts';
import { OneHuman, type DecideInput } from '../server/engine.ts';
import { Store } from '../server/db.ts';
import { License, licenseSigner, setTrustedLicenseKeys, trustedLicenseKeys, verifyLicense } from '../server/license.ts';
import { billing, monthOf } from '../server/billing.ts';
import type { Req } from '../server/http.ts';

const signer = licenseSigner(Buffer.from('license-test-signer'));
const stranger = licenseSigner(Buffer.from('someone-else'));
setTrustedLicenseKeys([...trustedLicenseKeys(), { x: signer.jwk.x }]);

test('a token verifies only when OneHuman signed it, it is current, and it is a license', () => {
  const t = signer.issue({ sub: 'offline', account: 'a', plan: 'enterprise', mode: 'enforce', ttlMs: 60_000 });
  const v = verifyLicense(t);
  assert.equal(v.ok, true);
  assert.equal(v.ok && v.payload.mode, 'enforce');
  assert.deepEqual(verifyLicense(stranger.issue({ sub: 'offline', account: 'a', plan: 'enterprise', mode: 'enforce', ttlMs: 60_000 })), { ok: false, reason: 'bad_signature' }, 'a portal of one\'s own cannot sign one');
  assert.deepEqual(verifyLicense(signer.issue({ sub: 'offline', account: 'a', plan: 'free', mode: 'enforce', ttlMs: -1000 })), { ok: false, reason: 'expired' });
  const [h, , s] = t.split('.');
  assert.deepEqual(verifyLicense(`${h}.${Buffer.from(JSON.stringify({ v: 1, iss: 'onehuman-license', sub: 'offline', account: 'a', plan: 'enterprise', mode: 'enforce', iat: 0, exp: 9e9 })).toString('base64url')}.${s}`), { ok: false, reason: 'bad_signature' }, 'a changed payload');
  assert.equal(verifyLicense('not a token').ok, false);
  const l = new License({ keyTag: 'aaaa' });
  assert.equal(l.set(signer.issue({ sub: 'bbbb', account: 'a', plan: 'free', mode: 'enforce', ttlMs: 60_000 }), 'portal').reason, 'wrong_key', 'a token for another API key');
});

test('the engine: nothing on a real host without a license, everything on a local one, and observe when the license says so', async () => {
  const store = await Store.open();
  const room = '00000000-0000-4000-8000-000000000001';
  await store.ensureRoom(room, 'tenant:test');
  const engine = new OneHuman({ store, secret: Buffer.from('s'.repeat(40)), defaultPolicy: { version: 't', enforcement: 'enforce', rules: [
    { resource: 'export.csv', title: 'Export', onAgent: 'block', onArtifact: 'block', onUnknown: 'block', onHumanLike: 'block', actOn: ['verified', 'strong', 'control', 'behavioral'], minScore: 65 }] } });
  const session = (await store.getSession((await store.createSession(room, 'unlabelled', null))!))!;
  const ask = (headers: Record<string, string>) => engine.decide({ room, session, resource: 'export.csv', request: { method: 'GET', url: '/export', headers, socket: {} } as unknown as Req, snapshot: null } as DecideInput);

  const off = await ask({ host: 'bank.example' });
  assert.equal(off.decision.id, 'unlicensed');
  assert.equal(off.decision.decision, 'allow', 'the request goes on untouched');
  assert.equal((await store.listDecisions(room)).length, 0, 'nothing is recorded');
  assert.equal((await ask({ host: 'localhost:3000' })).decision.decision, 'block', 'local development needs no license');
  assert.equal((await ask({ host: '127.0.0.1:8080' })).decision.decision, 'block');
  assert.equal((await ask({ host: 'localhost', 'x-forwarded-host': 'bank.example' })).decision.id, 'unlicensed', 'a proxy in front of a real domain is not local');
  assert.equal((await ask({ host: 'localhost:3000', origin: 'https://bank.example' })).decision.id, 'unlicensed', 'Host rewritten to localhost: the browser still names the real site');
  assert.equal((await ask({ host: 'localhost:3000', referer: 'https://bank.example/account' })).decision.id, 'unlicensed');
  assert.equal((await ask({ host: 'localhost:3000', origin: 'http://localhost:3000', referer: 'http://localhost:3000/x' })).decision.decision, 'block', 'a real local page');
  process.env.NODE_ENV = 'production';
  try { assert.equal((await ask({ host: 'localhost' })).decision.id, 'unlicensed', 'a production server is not development'); }
  finally { delete process.env.NODE_ENV; }

  assert.equal(engine.license.set(signer.issue({ sub: 'offline', account: 'bank', plan: 'enterprise', mode: 'enforce', ttlMs: 60_000 }), 'file').ok, true);
  assert.equal((await ask({ host: 'bank.example' })).decision.decision, 'block', 'licensed');
  assert.equal(engine.license.status().state, 'licensed');
  engine.license.set(signer.issue({ sub: 'offline', account: 'bank', plan: 'free', mode: 'observe', ttlMs: 120_000 }), 'file');
  const watched = await ask({ host: 'bank.example' });
  assert.deepEqual([watched.decision.decision, watched.decision.computed], ['allow', 'block'], 'observe: recorded, not enforced');
  // nothing in the app can switch the check off: no option for it, the license cannot be replaced or patched
  const other = new OneHuman({ store, licensor: true } as never);
  assert.equal(other.license.mode({ headers: { host: 'onehuman.ai' } }), 'off', 'there is no licensor switch');
  assert.throws(() => { (other as unknown as { license: unknown }).license = { mode: () => 'enforce' }; }, TypeError);
  assert.throws(() => { (other.license as unknown as { mode: unknown }).mode = () => 'enforce'; }, TypeError);
  assert.throws(() => { (Object.getPrototypeOf(other.license) as { mode: unknown }).mode = () => 'enforce'; }, TypeError);
  assert.equal(other.license.mode({ headers: { host: 'onehuman.ai' } }), 'off');
  store.close();
});

// ------------------------------------------------------------------ the portal hands servers their license
const portal = await createApp({ labOperator: false, dogfood: false, firebase: null, chatModel: null });
await new Promise<void>((r) => portal.server.listen(0, '127.0.0.1', () => r()));
const pbase = `http://127.0.0.1:${(portal.server.address() as AddressInfo).port}`;
after(() => { portal.server.close(); portal.store.close(); });
const H = (cookie = '') => ({ 'Content-Type': 'application/json', Origin: pbase, ...(cookie ? { Cookie: cookie } : {}) });
const cookie = (await fetch(`${pbase}/api/v1/portal/signup`, { method: 'POST', headers: H(), body: JSON.stringify({ email: 'dev@shop.io', password: 'long-enough-password' }) })).headers.get('set-cookie')!.split(';')[0]!;
const account = (await portal.store.accountByEmail('dev@shop.io'))!.id;
const key = await (await fetch(`${pbase}/api/v1/portal/keys`, { method: 'POST', headers: H(cookie), body: JSON.stringify({ name: 'shop' }) })).json();

const rule = { resource: 'export.csv', title: 'Export', onAgent: 'block', onArtifact: 'block', onUnknown: 'block', onHumanLike: 'block', actOn: ['verified', 'strong', 'control', 'behavioral'], minScore: 65 };
async function shop(o: { apiKey?: string; license?: string } = {}) {
  const oh = await onehuman({ secret: 'shop-secret-shop-secret-shop-secret-shop', policy: { version: 's', enforcement: 'enforce', rules: [rule] } as never, policyFromPortal: false, db: 'memory', portalUrl: pbase, telemetryUrl: `${pbase}/api/v1/ingest`, ...o });
  const app = express();
  app.use(oh.middleware());
  app.get('/export', oh.protect('export.csv'), (_req, res) => res.json({ rows: 1000 }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { oh, base, get: (p: string) => fetch(base + p, { headers: { 'X-Forwarded-Host': 'shop.io' } }), close: async () => { server.close(); await oh.close(); } };
}

test('a server with no key, on a real domain: requests pass through, the page hides nothing, the log says why', async () => {
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
  const s = await shop();
  try {
    const r = await s.get('/export');
    assert.equal(r.status, 200, 'the app is not affected');
    assert.equal(r.headers.get('x-oh-decision'), 'unlicensed');
    assert.ok(errors.some((e) => /shop\.io pass through unprotected: no API key/.test(e)));
    assert.match(await (await s.get('/onehuman/sdk.js')).text(), /^window\.__ONEHUMAN_OFF__=1;/);
    assert.equal(s.oh.health().license.state, 'unlicensed');
    assert.equal((await fetch(`${s.base}/export`)).status, 403, 'the same server on its local address protects (development)');
  } finally { console.error = orig; await s.close(); }
});

test('with an API key the portal licenses the server (free plan); past the limit and the grace it watches only', async () => {
  let s = await shop({ apiKey: key.key });
  assert.equal(s.oh.health().license.state, 'licensed');
  assert.equal(s.oh.health().license.plan, 'free');
  assert.equal((await s.get('/export')).status, 403, 'protected on its real domain');
  await s.close();

  // 101 of this account's customers used an agent this month, and the overrun began 15 days ago
  const events = Array.from({ length: 101 }, (_, i) => ({ at: Date.now(), session: (5000 + i).toString(16).padStart(16, '0'), resource: 'export.csv', decision: 'block', actor: 'agent_likely', state: 'agent_attached', tools: [], reasons: [], enforcement: 'enforce', version: 't', login: true }));
  assert.equal((await fetch(`${pbase}/api/v1/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.key}` }, body: JSON.stringify({ events }) })).status, 202);
  let lic = await (await fetch(`${pbase}/api/v1/license`, { headers: { Authorization: `Bearer ${key.key}` } })).json();
  assert.equal(lic.mode, 'enforce', 'within the 14 days of grace');
  assert.ok(lic.observeFrom > Date.now());
  await portal.store.setBilling(account, { over_since: Date.now() - 15 * 86_400_000, over_month: monthOf(Date.now()) });
  lic = await (await fetch(`${pbase}/api/v1/license`, { headers: { Authorization: `Bearer ${key.key}` } })).json();
  assert.equal(lic.mode, 'observe');

  s = await shop({ apiKey: key.key });
  const r = await s.get('/export');
  assert.equal(r.status, 200, 'watch-only: the request goes on');
  assert.equal(r.headers.get('x-oh-outcome'), 'allow; computed=block; actor=unknown', 'and what protection would have done is recorded');
  await s.close();

  // a paid plan covers the month: back to enforcing at once
  await billing(portal.store).adjust(account, { plan: 'growth' }, 'admin');
  lic = await (await fetch(`${pbase}/api/v1/license`, { headers: { Authorization: `Bearer ${key.key}` } })).json();
  assert.equal(lic.mode, 'enforce');

  assert.equal((await fetch(`${pbase}/api/v1/license`, { headers: { Authorization: 'Bearer oh_live_' + '0'.repeat(40) } })).status, 401);
  const keys = await (await fetch(`${pbase}/api/v1/license/keys`)).json();
  assert.equal(keys.keys[0].crv, 'Ed25519');

  // an offline license for a deployment that may not call out
  const token = licenseSigner(portal.engine.secret).issue({ sub: 'offline', account, plan: 'growth', mode: 'enforce', ttlMs: 365 * 86_400_000, note: 'Bank pilot' });
  assert.equal(verifyLicense(token, keys.keys).ok, true);
  const air = await shop({ license: token });
  assert.equal((await air.get('/export')).status, 403, 'protected with no API key and no portal');
  assert.equal(air.oh.health().license.source, 'file');
  await air.close();
});

test('without a license a local host is for development: past DEV_SESSIONS_PER_DAY sessions a day it stops protecting', async () => {
  const { DEV_SESSIONS_PER_DAY } = await import('../server/license.ts');
  const store = await Store.open();
  const room = '00000000-0000-4000-8000-000000000002';
  await store.ensureRoom(room, 'tenant:dev');
  const engine = new OneHuman({ store, secret: Buffer.from('d'.repeat(40)), defaultPolicy: { version: 't', enforcement: 'enforce', rules: [
    { resource: 'export.csv', title: 'Export', onAgent: 'block', onArtifact: 'block', onUnknown: 'block', onHumanLike: 'block', actOn: ['verified', 'strong', 'control', 'behavioral'], minScore: 65 }] } });
  const decide = async () => {
    const session = (await store.getSession((await store.createSession(room, 'unlabelled', null))!))!;
    return engine.decide({ room, session, resource: 'export.csv', request: { method: 'GET', url: '/export', headers: { host: 'localhost:3000' }, socket: {} } as unknown as Req, snapshot: null } as DecideInput);
  };
  assert.equal((await decide()).decision.decision, 'block', 'development: protected');
  for (let i = 0; i < DEV_SESSIONS_PER_DAY; i++) await store.createSession(room, 'unlabelled', null);
  // the count is refreshed at most once a minute: a fresh engine on the same store sees the day's sessions
  const fresh = new OneHuman({ store, secret: Buffer.from('d'.repeat(40)), defaultPolicy: (engine as unknown as { defaultPolicy: never }).defaultPolicy });
  const session = (await store.getSession((await store.createSession(room, 'unlabelled', null))!))!;
  const warn = console.warn; const said: string[] = []; console.warn = (...a: unknown[]) => { said.push(a.join(' ')); };
  try {
    const r = await fresh.decide({ room, session, resource: 'export.csv', request: { method: 'GET', url: '/export', headers: { host: 'localhost:3000' }, socket: {} } as unknown as Req, snapshot: null } as DecideInput);
    assert.equal(r.decision.id, 'unlicensed', 'a site-sized day on localhost without a key is not development');
    assert.ok(said.some((x) => /without a license/.test(x)));
  } finally { console.warn = warn; }
  fresh.license.set(signer.issue({ sub: 'offline', account: 'dev', plan: 'free', mode: 'enforce', ttlMs: 60_000 }), 'file');
  const s2 = (await store.getSession((await store.createSession(room, 'unlabelled', null))!))!;
  assert.equal((await fresh.decide({ room, session: s2, resource: 'export.csv', request: { method: 'GET', url: '/export', headers: { host: 'localhost:3000' }, socket: {} } as unknown as Req, snapshot: null } as DecideInput)).decision.decision, 'block', 'with a license there is no cap');
  store.close();
});
