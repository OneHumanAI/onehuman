// SPDX-License-Identifier: BUSL-1.1
/**
 * The sidecar is the engine for backends that are not Node. These checks drive it the way the Python, C# and Java
 * middlewares do: page traffic forwarded with the browser's headers, and POST /v1/decide before a protected handler.
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startSidecar } from '../integrations/sidecar/index.ts';
import { STRICT_BANK_POLICY } from './strict-policy.ts';
import type { Policy } from '../server/policy.ts';
import { licenseSigner, setTrustedLicenseKeys, trustedLicenseKeys } from '../server/license.ts';

// a deployment serving a real domain runs with a license: here an offline one from a test signer
const signer = licenseSigner(Buffer.from('sidecar-test-license-signer'));
setTrustedLicenseKeys([...trustedLicenseKeys(), { x: signer.jwk.x }]);
const license = signer.issue({ sub: 'offline', account: 'test', plan: 'enterprise', mode: 'enforce', ttlMs: 86_400_000 });

const SITE = 'shop.example';   // the browser's host, carried in X-Forwarded-Host as the app forwards it
const policy: Policy = { ...STRICT_BANK_POLICY, rules: [...STRICT_BANK_POLICY.rules, { resource: 'file.get', title: 'file', onAgent: 'block', onArtifact: 'allow', onUnknown: 'allow', onHumanLike: 'allow', actOn: ['verified', 'strong', 'control', 'behavioral'], minScore: 65 }] };
let sc: Awaited<ReturnType<typeof startSidecar>>;
let locked: Awaited<ReturnType<typeof startSidecar>>;
before(async () => {
  sc = await startSidecar({ secret: 'x'.repeat(40), policy, db: 'memory', port: 0, license });
  locked = await startSidecar({ secret: 'y'.repeat(40), policy, db: 'memory', port: 0, token: 'shared-token', license });
});
after(async () => { await sc.close(); await locked.close(); });

const browser = { 'X-Forwarded-Host': SITE, 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', 'X-Forwarded-Proto': 'https' };
const decide = (resource: string, headers: Record<string, string> = {}) => fetch(`${sc.url}/v1/decide`, { method: 'POST', headers: { ...browser, 'X-OH-Resource': resource, 'X-OH-Method': 'GET', 'X-OH-Url': '/api/balance?x=1', ...headers } }).then(async (r) => ({ status: r.status, body: await r.json() }));
const earlyBase = { startedMs: 0, observedMs: 500, webdriver: false, firstInteractionMs: null, dataDomMs: null, markers: [], environment: { codexModelContext: false, modelContextApi: false, clipboardBridge: false, clipboardBridgeAtMs: null, agentGlobals: [], extensionsInstalled: [], focusWhileHiddenMs: null }, focusConflict: { count: 0, firstAtMs: null, peers: 0 }, webmcpInvocations: 0 };

test('the page script and its API are served through the sidecar', async () => {
  const r = await fetch(`${sc.url}/onehuman/sdk.js`, { headers: browser });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /javascript/);
  assert.equal((await fetch(`${sc.url}/elsewhere`, { headers: browser })).status, 404);
});

test('a first request gets a decision and a session cookie the app hands to the browser', async () => {
  const r = await decide('balance.read');
  assert.equal(r.status, 200);
  assert.equal(r.body.decision, 'allow');
  assert.equal(r.body.status, 200);
  assert.equal(r.body.body, null);
  assert.match(r.body.setCookie[0], /^oh_sid=[0-9a-f-]{36}; Path=\/; HttpOnly; SameSite=Lax; Secure$/, 'Secure because the browser request was https');
  assert.match(r.body.headers['X-OH-Outcome'], /^allow; computed=allow; actor=/);
});

test('an agent attaches in the page: the next decision is the rule for agents, with the body Express would send', async () => {
  const first = await decide('balance.read');
  const cookie = first.body.setCookie[0].split(';')[0];
  const sig = await fetch(`${sc.url}/onehuman/signals`, { method: 'POST', headers: { ...browser, cookie, Origin: `https://${SITE}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ early: { ...earlyBase, markers: [{ name: 'claude-stop', atMs: 900 }] }, interaction: null }) });
  assert.equal(sig.status, 200);
  const r = await decide('balance.read', { cookie });
  assert.equal(r.body.decision, 'block');
  assert.equal(r.body.status, 403);
  assert.equal(r.body.body.error, 'blocked');
  assert.equal(r.body.actor, 'agent_likely', 'the app is told who acted');
  assert.equal(r.body.body.decision.actor, undefined, 'the page learns the outcome, not the verdict');
  assert.equal(r.body.body.decision.reasonCodes, undefined, 'nor the reasons');
  const masked = await decide('profile.read', { cookie });
  assert.equal(masked.body.decision, 'mask');
  assert.equal(masked.body.masked, true);
});

test('identity from the app gives one session per signed-in user, without a cookie', async () => {
  const a = await decide('balance.read', { 'X-OH-Identity': 'user-42' });
  const b = await decide('balance.read', { 'X-OH-Identity': 'user-42' });
  assert.equal(a.body.setCookie[0].split(';')[0], b.body.setCookie[0].split(';')[0]);
});

test('a download token is issued on request and redeems once', async () => {
  const d = await decide('file.get', { 'X-OH-Want-Token': '1' });
  assert.equal(d.body.decision, 'allow');
  assert.ok(d.body.token);
  const cookie = d.body.setCookie[0].split(';')[0];
  const redeem = () => fetch(`${sc.url}/v1/redeem`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: d.body.token, resource: 'file.get' }) });
  assert.equal((await redeem()).status, 200);
  assert.equal((await redeem()).status, 403, 'single use');
});

test('bad input and a missing shared token are refused', async () => {
  assert.equal((await decide('no spaces allowed')).status, 400);
  assert.equal((await fetch(`${locked.url}/v1/health`)).status, 401);
  const ok = await fetch(`${locked.url}/v1/health`, { headers: { 'X-OH-Sidecar-Token': 'shared-token' } });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).policy.enforcement, 'enforce');
});
