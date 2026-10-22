// SPDX-License-Identifier: BUSL-1.1
/**
 * onehuman.ai runs OneHuman on its own portal. Inside the account nothing is blocked: for an AI agent in a portal
 * session — driving the tab or only open in a side panel beside it — the answer hides secrets (account e-mail, key
 * prefixes, a freshly created key), the owner is told an agent was connected, and every change it makes raises an
 * alert. Signing in or up is the one thing an agent may not do.
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.ts';

let app: Awaited<ReturnType<typeof createApp>>;
let base = '';
before(async () => {
  app = await createApp({ labOperator: false });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
after(() => { app.server.close(); app.store.close(); });

const earlyBase = { startedMs: 0, observedMs: 500, webdriver: false, firstInteractionMs: null, dataDomMs: null, markers: [] as { name: string; atMs: number }[], environment: { codexModelContext: false, modelContextApi: false, clipboardBridge: false, clipboardBridgeAtMs: null, agentGlobals: [], extensionsInstalled: [], focusWhileHiddenMs: null }, focusConflict: { count: 0, firstAtMs: null, peers: 0 }, webmcpInvocations: 0 };

/** A browser: keeps cookies, sends same-origin requests. */
function browser() {
  const jar = new Map<string, string>();
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const take = (r: Response) => { for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv!.indexOf('='); jar.set(kv!.slice(0, i), kv!.slice(i + 1)); } return r; };
  return {
    get: (p: string) => fetch(base + p, { headers: { cookie: cookie() } }).then(take),
    post: (p: string, body: unknown) => fetch(base + p, { method: 'POST', headers: { cookie: cookie(), 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) }).then(take),
    jar,
  };
}

test('a person sees everything; once an AI agent attaches, secrets are masked, changes go through and raise alerts', async () => {
  const b = browser();
  assert.equal((await b.post('/api/v1/portal/signup', { email: 'owner@corp.example', password: 'long-enough-password' })).status, 201);
  const mine = await (await b.get('/api/v1/portal/me')).json();
  assert.equal(mine.account.email, 'owner@corp.example');
  assert.equal(mine._masked, undefined);
  assert.ok(b.jar.has('oh_portal_sid'), 'the portal has its own OneHuman session');
  const human = await (await b.post('/api/v1/portal/keys', { name: 'by hand' })).json();
  assert.match(human.key, /^oh_live_/);
  assert.equal((await (await b.get('/api/v1/portal/alerts')).json()).alerts.length, 0, 'a person making changes raises nothing');

  // an AI agent attaches to the portal tab
  assert.equal((await b.post('/onehuman/signals', { early: { ...earlyBase, markers: [{ name: 'claude-stop', atMs: 900 }] }, interaction: null })).status, 200);
  const seen = await (await b.get('/api/v1/portal/me')).json();
  assert.equal(seen._masked, true);
  assert.equal(seen.account.email, 'o•••@corp.example');
  assert.ok(seen.keys.every((k: { prefix: string }) => k.prefix.endsWith('••••')), 'key prefixes hidden');

  const made = await b.post('/api/v1/portal/keys', { name: 'by agent' });
  assert.equal(made.status, 201, 'not blocked');
  const madeBody = await made.json();
  assert.equal(madeBody.key, '••••', 'the new key never reaches the agent');
  const pw = await b.post('/api/v1/portal/account/password', { current: 'long-enough-password', next: 'another-long-password' });
  assert.ok(pw.status < 400, `password change allowed (${pw.status})`);

  // the alert is written right after the answer goes out: give a slower database a moment
  let alerts: { action: string; tools: string[]; seen: boolean }[] = [];
  for (let i = 0; i < 20 && alerts.length < 3; i++) {
    alerts = (await (await b.get('/api/v1/portal/alerts')).json()).alerts;
    if (alerts.length < 3) await new Promise((r) => setTimeout(r, 100));
  }
  assert.deepEqual(alerts.map((a: { action: string }) => a.action).sort(), ['changed the password', 'created an API key', 'was connected to your signed-in tab']);
  assert.ok(alerts.every((a: { tools: string[] }) => a.tools.includes('claude-chrome')));
  assert.ok(alerts.every((a: { seen: boolean }) => !a.seen));
  assert.equal((await b.post('/api/v1/portal/alerts/seen', {})).status, 200);
  assert.ok((await (await b.get('/api/v1/portal/alerts')).json()).alerts.every((a: { seen: boolean }) => a.seen));

  // the key the agent created exists; its owner can rotate it to see a value
  const keys = (await (await b.get('/api/v1/portal/me')).json()).keys;
  assert.ok(keys.some((k: { name: string }) => k.name === 'by agent'));
});

test('another account sees none of these alerts, and signed-out calls stay closed', async () => {
  const other = browser();
  await other.post('/api/v1/portal/signup', { email: 'other@corp.example', password: 'long-enough-password' });
  assert.deepEqual((await (await other.get('/api/v1/portal/alerts')).json()).alerts, []);
  assert.equal((await fetch(`${base}/api/v1/portal/alerts`)).status, 401);
  assert.equal((await fetch(`${base}/onehuman/sdk.js`)).status, 200, 'the portal page script is served');
});

const panel = (open: boolean) => ({ panelOpenedMs: 1200, panelWidthPx: 420, panelClosedMs: open ? null : 5200, panelAtLoad: false, scans: 0, firstScanMs: null, longestScanMs: 0, scanAfterPanelMs: null });

test('a side panel beside the signed-in tab (Claude in Chrome only looking): masked while open, one alert, back when it closes', async () => {
  const b = browser();
  await b.post('/api/v1/portal/signup', { email: 'panel@corp.example', password: 'long-enough-password' });
  assert.equal((await (await b.get('/api/v1/portal/me')).json()).account.email, 'panel@corp.example');
  assert.equal((await b.post('/onehuman/signals', { early: { ...earlyBase, surface: panel(true) }, interaction: null })).status, 200);
  const seen = await (await b.get('/api/v1/portal/me')).json();
  assert.equal(seen._masked, true, 'the decision allows, the answer is still masked');
  assert.equal(seen.account.email, 'p•••@corp.example');
  await b.get('/api/v1/portal/me');
  const alerts = (await (await b.get('/api/v1/portal/alerts')).json()).alerts;
  assert.deepEqual(alerts.map((a: { action: string }) => a.action), ['was open beside your signed-in tab'], 'one alert per session, not per request');
  assert.equal((await b.post('/onehuman/signals', { early: { ...earlyBase, observedMs: 6000, surface: panel(false) }, interaction: null })).status, 200);
  const back = await (await b.get('/api/v1/portal/me')).json();
  assert.equal(back._masked, undefined);
  assert.equal(back.account.email, 'panel@corp.example');
});

test('sign-in and sign-up: a person goes through; an agent in the tab, or a side panel with nobody typing, gets 403', async () => {
  const person = browser();
  assert.equal((await person.post('/api/v1/portal/signup', { email: 'login@corp.example', password: 'long-enough-password' })).status, 201);

  const agent = browser();
  await agent.post('/onehuman/signals', { early: { ...earlyBase, markers: [{ name: 'claude-glow', atMs: 700 }] }, interaction: null });
  for (const path of ['/api/v1/portal/login', '/api/v1/portal/signup']) {
    const r = await agent.post(path, { email: path.endsWith('login') ? 'login@corp.example' : 'new@corp.example', password: 'long-enough-password' });
    assert.equal(r.status, 403, path);
    assert.equal((await r.json()).error, 'agent_login_blocked');
  }
  assert.ok(!agent.jar.has('oh_portal'), 'no portal session was issued');

  const beside = browser();
  await beside.post('/onehuman/signals', { early: { ...earlyBase, surface: panel(true) }, interaction: null });
  assert.equal((await beside.post('/api/v1/portal/login', { email: 'login@corp.example', password: 'long-enough-password' })).status, 403);
  await beside.post('/onehuman/signals', { early: { ...earlyBase, observedMs: 6000, surface: panel(false) }, interaction: null });
  assert.equal((await beside.post('/api/v1/portal/login', { email: 'login@corp.example', password: 'long-enough-password' })).status, 200, 'panel closed: the person signs in');
});
