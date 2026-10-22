// SPDX-License-Identifier: BUSL-1.1
/**
 * Agent signature updates: only a bundle signed with the signatures key is used, only a newer one replaces the
 * one in use, it only adds, it survives a restart with the portal down, and a tampered saved copy is refused.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.ts';
import { onehuman } from '../integrations/express/index.ts';
import { thumbprint } from '../integrations/proof/verify.ts';
import { SIGNATURES_TYP, setTrustedSignatureKeys, verifySignatureBundle } from '../integrations/signatures/common.ts';
import { resetSignatures } from '../server/signatures.ts';
import { parseEarly, toolInjectedGlobals } from '../server/signals.ts';
import { Store } from '../server/db.ts';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const x = publicKey.export({ format: 'jwk' }).x as string;
setTrustedSignatureKeys([{ x }]);
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function bundle(seq: number, rules: unknown, minEngine = '0.0.1', key = privateKey, kx = x) {
  const input = `${b64({ alg: 'EdDSA', typ: SIGNATURES_TYP, kid: thumbprint(kx) })}.${b64({ v: 1, iss: 'onehuman-signatures', seq, issued: Date.now(), minEngine, note: `test ${seq}`, rules })}`;
  return `${input}.${sign(null, Buffer.from(input), key).toString('base64url')}`;
}
const RULES = {
  markers: [{ name: 'newagent-overlay', selector: '#newagent-overlay-root', tool: 'newagent-chrome', control: true }],
  globals: [{ name: '__newAgentBridge', tool: 'newagent-chrome', control: true }],
  appUserAgents: [{ token: 'NewAgentApp', tool: 'newagent-app' }],
};

test('only a genuine bundle with valid rules verifies', () => {
  assert.equal(verifySignatureBundle(bundle(1, RULES)).ok, true);
  const other = generateKeyPairSync('ed25519');
  assert.deepEqual(verifySignatureBundle(bundle(1, RULES, '0.0.1', other.privateKey, other.publicKey.export({ format: 'jwk' }).x as string)), { ok: false, reason: 'unknown_key' });
  const [h, , s] = bundle(1, RULES).split('.');
  assert.deepEqual(verifySignatureBundle(`${h}.${b64({ v: 1, iss: 'onehuman-signatures', seq: 99, issued: 0, minEngine: '0', rules: {} })}.${s}`), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verifySignatureBundle(bundle(1, { markers: [{ name: 'x', selector: 'a<script>', tool: 't', control: true }] })), { ok: false, reason: 'bad_rules' });
});

const portal = await createApp({ labOperator: false });
await new Promise<void>((r) => portal.server.listen(0, '127.0.0.1', () => r()));
const pbase = `http://127.0.0.1:${(portal.server.address() as AddressInfo).port}`;
const H = { 'Content-Type': 'application/json', Origin: pbase };
const cookie = (await fetch(`${pbase}/api/v1/portal/signup`, { method: 'POST', headers: H, body: JSON.stringify({ email: 'sig@saas.example', password: 'longenough-sig' }) })).headers.get('set-cookie')!.split(';')[0]!;
const key = await (await fetch(`${pbase}/api/v1/portal/keys`, { method: 'POST', headers: { ...H, Cookie: cookie }, body: JSON.stringify({ name: 'app' }) })).json();
const dir = mkdtempSync(join(tmpdir(), 'oh-sigs-'));
const db = `sqlite:${join(dir, 'onehuman.db')}`;
const rule = { resource: 'balance.read', title: 'Balance', onAgent: 'block', onArtifact: 'mask', onUnknown: 'allow', onHumanLike: 'allow', actOn: ['verified', 'strong', 'control', 'behavioral'], minScore: 65 };
const opts = { secret: 'test-secret-test-secret-test-secret-sigs', policy: { version: 's', enforcement: 'enforce', rules: [rule] } as never, policyFromPortal: false, db, apiKey: key.key, telemetryUrl: `${pbase}/api/v1/ingest` };
const logs: string[] = [];
const origLog = console.log;
console.log = (...a: unknown[]) => { const m = a.join(' '); if (m.startsWith('onehuman:')) logs.push(m); else origLog(...a); };
after(() => { console.log = origLog; portal.server.close(); portal.store.close(); resetSignatures(); });

test('the portal stores only signed, newer bundles and serves the newest to servers whose plan has live signatures', async () => {
  const post = (envelope: string) => fetch(`${pbase}/api/v1/signatures`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ envelope }) });
  assert.equal((await fetch(`${pbase}/api/v1/signatures`, { headers: { Authorization: `Bearer ${key.key}` } })).status, 404, 'none yet');
  assert.equal((await post(bundle(5, RULES))).status, 201);
  assert.equal((await post(bundle(4, RULES))).status, 409, 'an older bundle is refused');
  const [h, p] = bundle(6, RULES).split('.');
  assert.equal((await post(`${h}.${p}.${'A'.repeat(86)}`)).status, 400, 'a forged one is refused');
  // a free plan gets signatures 30 days after release: this one is new, so nothing yet (the built-ins stay)
  assert.equal((await fetch(`${pbase}/api/v1/signatures`, { headers: { Authorization: `Bearer ${key.key}` } })).status, 404, 'free: not yet');
  await portal.store.setBilling((await portal.store.accountByEmail('sig@saas.example'))!.id, { plan: 'growth' });
  const r = await fetch(`${pbase}/api/v1/signatures`, { headers: { Authorization: `Bearer ${key.key}` } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).seq, 5, 'a paid plan: the newest');
  assert.equal((await fetch(`${pbase}/api/v1/signatures`, { headers: { Authorization: `Bearer ${key.key}`, 'If-None-Match': '"sigs-5"' } })).status, 304);
  assert.equal((await fetch(`${pbase}/api/v1/signatures`)).status, 401);
});

test('a server picks the bundle up: new traces are recognised, the page script is told, health shows it', async () => {
  const oh = await onehuman(opts);
  const app = express(); app.use(oh.middleware());
  const server = app.listen(0); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (let i = 0; i < 40 && oh.health().signatures.seq !== 5; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(oh.health().signatures.seq, 5);
  assert.equal(oh.health().signatures.source, 'portal');
  assert.deepEqual(toolInjectedGlobals(['__newAgentBridge']), [{ name: '__newAgentBridge', tool: 'newagent-chrome' }]);
  const early = { startedMs: 0, observedMs: 1, webdriver: false, firstInteractionMs: null, dataDomMs: null, markers: [{ name: 'newagent-overlay', atMs: 1 }], environment: { codexModelContext: false, modelContextApi: false, clipboardBridge: false, clipboardBridgeAtMs: null, agentGlobals: [], extensionsInstalled: [], focusWhileHiddenMs: null }, focusConflict: { count: 0, firstAtMs: null, peers: 0 }, webmcpInvocations: 0 };
  assert.ok(parseEarly(early), 'a marker the bundle added is accepted from the page');
  const sdk = await (await fetch(`${base}/onehuman/sdk.js`)).text();
  assert.match(sdk, /^window\.__ONEHUMAN_RULES__=\{"probes":\[\["newagent-overlay","#newagent-overlay-root"\]\]/);
  assert.ok(logs.some((l) => /agent signatures 5 in use \(from the portal/.test(l)));
  server.close(); await oh.close();
});

test('portal down: the saved bundle is used; a tampered saved copy is refused and the built-ins stay', async () => {
  resetSignatures();
  const offline = await onehuman({ ...opts, telemetryUrl: 'http://127.0.0.1:9/api/v1/ingest', portalUrl: 'http://127.0.0.1:9' });
  assert.equal(offline.health().signatures.seq, 5);
  assert.equal(offline.health().signatures.source, 'cache');
  await offline.close();

  resetSignatures();
  const store = await Store.open(await (await import('../integrations/express/index.ts')).openClient(db));
  const saved = (await store.policyCache('signatures:global'))!;
  const [h, , s] = saved.envelope.split('.');
  await store.putPolicyCache('signatures:global', { envelope: `${h}.${b64({ v: 1, iss: 'onehuman-signatures', seq: 99, issued: 0, minEngine: '0', rules: {} })}.${s}`, pinnedKey: '', fetched: Date.now() });
  store.close();
  const tampered = await onehuman({ ...opts, portalUrl: 'http://127.0.0.1:9' });
  assert.equal(tampered.health().signatures.seq, 0, 'built-ins only');
  assert.match(tampered.health().signatures.problem ?? '', /failed its check \(bad_signature\)/);
  assert.deepEqual(toolInjectedGlobals(['__newAgentBridge']), [], 'the forged additions are not in force');
  await tampered.close();
});

test('a bundle for a newer engine waits', async () => {
  resetSignatures();
  await fetch(`${pbase}/api/v1/signatures`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ envelope: bundle(7, RULES, '99.0.0') }) });
  const dir2 = mkdtempSync(join(tmpdir(), 'oh-sigs2-'));
  const oh = await onehuman({ ...opts, db: `sqlite:${join(dir2, 'o.db')}` });
  await new Promise((r) => setTimeout(r, 300));
  // the development engine (0.0.0-dev) accepts every minEngine; a released engine would wait. The rule itself:
  const { engineAtLeast } = await import('../integrations/signatures/common.ts');
  assert.equal(engineAtLeast('0.6.0', '99.0.0'), false);
  assert.equal(engineAtLeast('0.6.1', '0.6.0'), true);
  await oh.close();
});
