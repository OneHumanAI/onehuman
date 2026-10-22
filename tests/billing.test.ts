// SPDX-License-Identifier: BUSL-1.1
/**
 * Plans and usage: a company pays for its signed-in customers in whose sessions an AI agent acted, once a month each.
 * Free covers 100; past it (or out of a prepaid balance) only fresh signatures are held back, never protection; the
 * owner is told once; a paid plan is a request the team switches on after payment, and what was open is settled.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.ts';
import { PLANS, monthOf, billing } from '../server/billing.ts';
import type { Outgoing, Transport } from '../server/mail.ts';

const sent: Outgoing[] = [];
const transport: Transport = { name: 'fake', async send(m) { sent.push(m); return { id: String(sent.length) }; } };
const app = await createApp({ labOperator: false, dogfood: false, firebase: null, mailTransport: transport, chatModel: null });
await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
after(() => { app.server.close(); app.store.close(); });

const H = (cookie = '') => ({ 'Content-Type': 'application/json', Origin: base, 'X-Forwarded-For': '203.0.113.50', ...(cookie ? { Cookie: cookie } : {}) });
const owner = await fetch(`${base}/api/v1/portal/signup`, { method: 'POST', headers: H(), body: JSON.stringify({ email: 'cto@fintech.io', password: 'long-enough-password' }) });
const cookie = owner.headers.get('set-cookie')!.split(';')[0]!;
const account = (await app.store.accountByEmail('cto@fintech.io'))!.id;
const key = await (await fetch(`${base}/api/v1/portal/keys`, { method: 'POST', headers: H(cookie), body: JSON.stringify({ name: 'production' }) })).json();
// what the team does after payment (an operator action, kept out of this repository): set a plan or add to a balance
const adjust = (change: { plan?: 'free' | 'payg' | 'growth' | 'enterprise'; addCents?: number; note?: string | null }) => billing(app.store).adjust(account, change, 'admin');

let n = 0;
const session = () => (++n).toString(16).padStart(16, '0');
const event = (s: string, o: Record<string, unknown> = {}) => ({ at: Date.now(), session: s, resource: 'transfer.create', decision: 'step_up', actor: 'agent_likely', state: 'agent_attached', tools: ['claude-chrome'], reasons: ['AGENT_ATTACHED'], enforcement: 'enforce', version: 't', login: true, ...o });
async function ingest(events: unknown[]) {
  const r = await fetch(`${base}/api/v1/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.key}` }, body: JSON.stringify({ events }) });
  assert.equal(r.status, 202);
}
const plan = async () => (await fetch(`${base}/api/v1/portal/plan`, { headers: H(cookie) })).json();
const notices = () => sent.filter((m) => m.kind === 'plan').map((m) => m.subject);

test('only signed-in customers with an agent count, once a month each', async () => {
  const s = session();
  await ingest([
    event(s), event(s), event(s),                                            // the same customer three times: one
    event(session(), { login: false }),                                       // a visitor who is not signed in: none
    event(session(), { actor: 'human_like', state: 'no_indication' }),        // a person, no agent: none
    event(session(), { login: undefined }),                                   // an older reporter that does not say: counted
  ]);
  const p = await plan();
  assert.equal(p.plan.id, 'free');
  assert.equal(p.usage.total, 2);
  assert.equal(p.month, monthOf(Date.now()));
  assert.equal(p.liveSignatures, false, 'Free gets signatures 30 days after release');
  assert.equal(p.plans.length, 4);
});

test('Free: told at 80, at the limit the plan is over, protection is never part of it', async () => {
  await ingest(Array.from({ length: 77 }, () => event(session())));   // 79 so far
  assert.deepEqual(notices(), []);
  await ingest([event(session())]);                                      // 80
  assert.deepEqual(notices(), ['80 of your 100 free agent-active customers this month']);
  await ingest(Array.from({ length: 21 }, () => event(session())));   // 101
  const p = await plan();
  assert.equal(p.usage.total, 101);
  assert.equal(p.usage.kinds.over, 1);
  assert.equal(p.over, true);
  assert.equal(p.estimateCents, 0, 'Free never charges');
  assert.deepEqual(notices().slice(1), ['Your free plan reached its limit this month']);
  const mail = sent.find((m) => m.subject === 'Your free plan reached its limit this month')!;
  assert.match(mail.text, /keep protecting in full until/);
  assert.match(mail.text, /switches to watch-only/);
  await ingest([event(session())]);
  assert.equal(notices().length, 2, 'once a month per notice');
});

test('a paid plan is a request the team confirms; then what was over is settled from the balance', async () => {
  const r = await fetch(`${base}/api/v1/portal/plan`, { method: 'POST', headers: H(cookie), body: JSON.stringify({ plan: 'payg', note: 'invoice to finance@' }) });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual([body.applied, body.requested], [false, 'payg']);
  assert.equal(body.view.plan.id, 'free', 'nothing changes before payment');
  const team = sent.filter((m) => m.kind === 'team');
  assert.equal(team.length, 1);
  assert.equal(team[0]!.to, 'arif@onehuman.ai');
  assert.match(team[0]!.subject, /cto@fintech\.io wants Pay as you go/);

  // payment arrived: Pay as you go with $1.00; the two customers past 100 are paid from it
  const st = await adjust({ plan: 'payg', addCents: 100, note: 'bank transfer #1' });
  assert.deepEqual([st.plan.id, st.over, st.billing.balanceCents], ['payg', false, 0]);
  const p = await plan();
  assert.equal(p.usage.kinds.paid, 2);
  assert.equal(p.usage.cents, 2 * PLANS.payg.unitCents!);
  assert.equal(p.liveSignatures, true);
  assert.equal(p.requested, null);
  assert.equal(p.ledger[0].cents, 100);
  assert.equal(p.ledger[0].note, 'bank transfer #1');
});

test('Pay as you go: an empty balance holds back signatures until a top-up settles it', async () => {
  await ingest([event(session()), event(session())]);
  let p = await plan();
  assert.equal(p.usage.kinds.unpaid, 2);
  assert.equal(p.over, true);
  assert.equal(p.liveSignatures, false);
  assert.ok(notices().includes('Your OneHuman balance is used up'));
  await adjust({ addCents: 500 });
  p = await plan();
  assert.equal(p.usage.kinds.unpaid ?? 0, 0);
  assert.equal(p.usage.kinds.paid, 4);
  assert.equal(p.balanceCents, 500 - 2 * 50);
  assert.equal(p.over, false);
});

test('Growth charges a month plus overage; Enterprise is never over; back to Free at once', async () => {
  await adjust({ plan: 'growth' });
  await ingest([event(session())]);
  let p = await plan();
  assert.equal(p.plan.id, 'growth');
  assert.equal(p.over, false);
  assert.equal(p.estimateCents, PLANS.growth.monthlyCents, 'still within the 1,000 included');
  await adjust({ plan: 'enterprise' });
  p = await plan();
  assert.equal(p.estimateCents, null);
  assert.equal(p.liveSignatures, true);
  const down = await (await fetch(`${base}/api/v1/portal/plan`, { method: 'POST', headers: H(cookie), body: JSON.stringify({ plan: 'free' }) })).json();
  assert.equal(down.applied, true);
  assert.equal(down.view.plan.id, 'free');
  assert.equal((await fetch(`${base}/api/v1/portal/plan`, { method: 'POST', headers: H(cookie), body: JSON.stringify({ plan: 'gold' }) })).status, 400);
  assert.equal((await fetch(`${base}/api/v1/portal/plan`)).status, 401);
});
