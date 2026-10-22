// SPDX-License-Identifier: BUSL-1.1
/**
 * The site's own key and the demos: a test on onehuman.ai's demo bank shows up in that key's statistics (named after
 * its app, the session hashed and judged as a whole, nothing counted towards a plan); the key's rules in the portal
 * are what the demos enforce; someone the key is shared with as an editor manages those rules, a viewer only reads;
 * the admin panel shows the same figures; and a signed-in visitor of /portal gets a loading screen, not the sign-in form.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.ts';
import { newApiKey } from '../server/routes/portal.ts';
import { monthOf } from '../server/billing.ts';

const key = newApiKey();
process.env.ONEHUMAN_DOGFOOD_API_KEY = key.raw;
const app = await createApp({ labOperator: false, dogfood: false, firebase: null, chatModel: null });
delete process.env.ONEHUMAN_DOGFOOD_API_KEY;
await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
after(() => { app.server.close(); app.store.close(); });
const store = app.store;

const H = (cookie = '') => ({ 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}) });
const signup = async (email: string) => (await fetch(`${base}/api/v1/portal/signup`, { method: 'POST', headers: H(), body: JSON.stringify({ email, password: 'long-enough-password' }) })).headers.get('set-cookie')!.split(';')[0]!;
const get = (cookie: string, path: string) => fetch(`${base}${path}`, { headers: H(cookie) });
const post = (cookie: string, path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: H(cookie), body: JSON.stringify(body) });

// the site's account, and its key (the one the deployment reports under)
const owner = await signup('support@onehuman.example');
const account = (await store.accountByEmail('support@onehuman.example'))!.id;
const keyId = await store.createApiKey(account, { name: 'onehuman.ai', prefix: key.prefix, hash: key.hash });

async function room() {
  const first = await fetch(`${base}/bank`, { redirect: 'manual' });
  const url = new URL(first.headers.get('location')!, base);
  const page = await fetch(url, { redirect: 'manual' });
  return { cookie: page.headers.get('set-cookie')!.split(';')[0]!, q: `?room=${url.searchParams.get('room')}` };
}
async function settled<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  let v = await read();
  for (let i = 0; i < 40 && !ok(v); i++) { await new Promise((r) => setTimeout(r, 50)); v = await read(); }
  return v;
}

test('a visitor trying the demo bank shows up in the site key\'s statistics, judged as a session', async () => {
  const s = await room();
  assert.equal((await fetch(`${base}/api/v1/r/balance.read${s.q}`, { headers: { cookie: s.cookie } })).status, 200);
  const stats = await settled(() => store.telemetryStats(keyId, 0, 3_600_000), (x) => x.resources.length > 0);
  assert.deepEqual(stats.resources.map((r) => r.resource), ['demo.bank.balance.read']);
  assert.equal(stats.sessions.total, 1);
  const ev = stats.recent[0]!;
  assert.match(ev.session, /^[a-f0-9]{16}$/, 'the session id is hashed');
  assert.notEqual(ev.session, s.cookie.split('=')[1]);
  assert.deepEqual([ev.actor, ev.verdict], ['unknown', 'no_data'], 'a call with no browser data is said to be that, not "could not tell"');
  assert.deepEqual(stats.people, { agent: 0, human: 0, noData: 1, early: 0, unclear: 0 });
  assert.equal((await store.usageCounts(account, monthOf(Date.now()))).total, 0, 'visitors never count towards a plan');
});

test('a session is judged over all its decisions: early "unknown" rows become the person or agent it turned out to be', async () => {
  const other = await store.createApiKey(account, { name: 'judged', prefix: 'oh_live_judged0', hash: 'h'.repeat(64) });
  const ev = (session: string, actor: string, reasons: string[], state = 'none') => ({ at: Date.now(), session, resource: 'x.read', decision: 'allow', actor, state, tools: [], reasons, enforcement: 'enforce', version: 't' });
  await store.insertTelemetry(other, [
    ev('aaaaaaaaaaaaaaa1', 'unknown', ['INSUFFICIENT_ACTIONS']), ev('aaaaaaaaaaaaaaa1', 'human_like', []),              // a person, after a few clicks
    ev('aaaaaaaaaaaaaaa2', 'unknown', ['INSUFFICIENT_ACTIONS']), ev('aaaaaaaaaaaaaaa2', 'unknown', [], 'agent_attached'), // an agent took the tab
    ev('aaaaaaaaaaaaaaa3', 'unknown', ['INSUFFICIENT_ACTIONS']),                                                         // left after one click
    ev('aaaaaaaaaaaaaaa4', 'unknown', ['INDISTINGUISHABLE']),
  ]);
  const st = await store.telemetryStats(other, 0, 3_600_000);
  assert.deepEqual(st.people, { agent: 1, human: 1, noData: 0, early: 1, unclear: 1 });
  const first = st.recent.find((r) => r.session === 'aaaaaaaaaaaaaaa1' && r.actor === 'unknown')!;
  assert.equal(first.verdict, 'human', 'the early row says what the session turned out to be');
});

test('the key\'s rules in the portal run the demos: the demos\' own rules are version 1, a change applies at once', async () => {
  const pv = await (await get(owner, `/api/v1/portal/policy?key=${keyId}`)).json();
  assert.equal(pv.n, 1);
  assert.equal(pv.role, 'owner');
  const rule = pv.policy.rules.find((r: { resource: string }) => r.resource === 'demo.bank.balance.read');
  assert.deepEqual([rule.onAgent, rule.onUnknown, rule.onHumanLike], ['mask', 'allow', 'allow'], 'version 1 is the demo bank\'s own rule');
  assert.ok(pv.policy.rules.some((r: { resource: string }) => r.resource.startsWith('demo.crm.')));

  // stricter: turn away anyone who could not be shown to be a person
  const stricter = { ...pv.policy, rules: pv.policy.rules.map((r: { resource: string }) => (r.resource === 'demo.bank.balance.read' ? { ...r, onUnknown: 'block' } : r)) };
  const saved = await post(owner, '/api/v1/portal/policy', { key: keyId, policy: stricter, password: 'long-enough-password' });
  assert.equal(saved.status, 200, await saved.clone().text());
  const s = await room();
  const r = await fetch(`${base}/api/v1/r/balance.read${s.q}`, { headers: { cookie: s.cookie } });
  assert.equal(r.status, 403, 'the demo bank enforces the rule from the portal');
  assert.match((await (await fetch(`${base}/api/v1/policy-default${s.q}`)).json()).policy.version, /\+portal-v2$/, 'the demo page shows the rules it runs');
});

test('shared as an editor: same statistics, and the rules too; the settings stay with the owner; a viewer only reads', async () => {
  const tal = await signup('tal@onehuman.example');
  const shared = await (await post(owner, '/api/v1/portal/keys/share', { key: keyId, email: 'tal@onehuman.example' })).json();
  assert.equal((await post(tal, '/api/v1/portal/invites/accept', { token: new URL(shared.link).searchParams.get('invite') })).status, 200);
  const k = (await (await get(tal, '/api/v1/portal/me')).json()).keys.find((x: { id: string }) => x.id === keyId);
  assert.deepEqual([k.role, k.owner], ['editor', 'support@onehuman.example'], 'shared to manage the rules by default');
  assert.equal((await get(tal, `/api/v1/portal/stats?key=${keyId}`)).status, 200);

  const pv = await (await get(tal, `/api/v1/portal/policy?key=${keyId}`)).json();
  assert.equal(pv.role, 'editor');
  const next = { ...pv.policy, rules: pv.policy.rules.map((r: { resource: string }) => (r.resource === 'demo.bank.card.details' ? { ...r, title: 'Card number (Tal)' } : r)) };
  assert.equal((await post(tal, '/api/v1/portal/policy', { key: keyId, policy: next })).status, 200);
  const after = await (await get(owner, `/api/v1/portal/policy?key=${keyId}`)).json();
  assert.equal(after.n, 3, 'the owner sees the change: one set of rules for both');
  assert.equal(after.history[0].actor, 'tal@onehuman.example', 'and who made it');
  assert.equal((await post(tal, '/api/v1/portal/policy/settings', { key: keyId, requireApproval: true })).status, 404, 'settings stay with the owner');
  assert.equal((await post(tal, '/api/v1/portal/keys/rotate', { id: keyId })).status, 404, 'so does the key');

  // the owner makes it view-only: the rules close, the statistics stay
  const member = (await (await get(owner, `/api/v1/portal/keys/access?key=${keyId}`)).json()).members[0];
  assert.equal(member.role, 'editor');
  assert.equal((await post(tal, '/api/v1/portal/keys/share-role', { key: keyId, account: member.account, role: 'viewer' })).status, 404, 'only the owner changes it');
  assert.equal((await post(owner, '/api/v1/portal/keys/share-role', { key: keyId, account: member.account, role: 'viewer' })).status, 200);
  assert.equal((await get(tal, `/api/v1/portal/policy?key=${keyId}`)).status, 404);
  assert.equal((await get(tal, `/api/v1/portal/stats?key=${keyId}`)).status, 200);
});

test('/portal: a signed-in visitor gets the loading screen, a new one the sign-in form', async () => {
  const signedIn = await (await get(owner, '/portal')).text();
  assert.match(signedIn, /<div class="boot" id="boot" role="status"/);
  assert.match(signedIn, /<main class="auth" id="auth" hidden>/);
  const fresh = await (await fetch(`${base}/portal`)).text();
  assert.match(fresh, /<div class="boot" id="boot" hidden/);
  assert.match(fresh, /<main class="auth" id="auth">/);
});
