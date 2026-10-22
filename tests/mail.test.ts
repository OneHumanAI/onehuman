// SPDX-License-Identifier: BUSL-1.1
/**
 * The free 30-day report's e-mails: the right mail at the right moment, each one exactly once, never to an address
 * that cannot receive it, never after the person said stop, and never at the cost of a sign-up or an ingest.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.ts';
import { SiteStore, type TelemetryEvent } from '../server/site-db.ts';
import { mailer, previewMail, type Outgoing, type Transport } from '../server/mail.ts';
import { MAIL_KINDS } from '../server/mail-templates.ts';
import { sampleReport } from '../server/sample-report.ts';

const DAY = 86_400_000;
const secret = Buffer.from('mail-test-secret-mail-test-secret-0123');

function fakeTransport() {
  const sent: Outgoing[] = [];
  let failNext = 0;
  const t: Transport & { sent: Outgoing[]; fail(n: number): void } = {
    name: 'fake', sent,
    fail(n) { failNext = n; },
    async send(m) { if (failNext > 0) { failNext--; throw new Error('provider down'); } sent.push(m); return { id: `id-${sent.length}` }; },
  };
  return t;
}
const ev = (over: Partial<TelemetryEvent> = {}): TelemetryEvent => ({ at: Date.now(), session: 'abcdef0123456789', resource: 'customers.read', decision: 'allow', computed: 'allow', actor: 'human_like', state: 'no_indication', tools: [], reasons: [], enforcement: 'observe', version: 'v', ...over });

/** a store with one account and one key, and a clock the test moves */
async function world(email = 'owner@acme.io') {
  const store = await SiteStore.open();
  const transport = fakeTransport();
  let clock = Date.UTC(2026, 9, 1, 9);
  const mail = mailer(store, { secret, base: 'https://onehuman.ai', transport, now: () => clock, log: () => {} });
  const account = (await store.createAccount(email, 'x', clock))!;
  const keyId = await store.createApiKey(account, { name: 'Acme Billing', prefix: 'oh_live_abc', hash: `h-${account}` }, clock);
  return { store, transport, mail, account, keyId, email, at: (t: number) => { clock = t; }, now: () => clock };
}

test('sign-up: one welcome mail, from Arif, with a working way to stop it', async () => {
  const w = await world();
  await w.mail.onSignup(w.account, w.email, 'report');
  await w.mail.onSignup(w.account, w.email, 'report');
  assert.equal(w.transport.sent.length, 1, 'the welcome goes out once');
  const m = w.transport.sent[0]!;
  assert.equal(m.kind, 'welcome'); assert.equal(m.to, 'owner@acme.io');
  assert.match(m.subject, /free AI agent report/i);
  assert.match(m.html, /npx onehumanai init/); assert.match(m.text, /npx onehumanai init/);
  assert.ok(m.html.includes(m.unsubscribeUrl.replace(/&/g, '&amp;')), 'the stop link is in the mail');
  const u = new URL(m.unsubscribeUrl);
  assert.ok(w.mail.checkUnsubscribe(u.searchParams.get('a')!, u.searchParams.get('t')!));
  assert.ok(!w.mail.checkUnsubscribe(u.searchParams.get('a')!, 'x'.repeat(32)), 'a made-up token does not work');
  const meta = await w.store.accountMeta(w.account);
  assert.equal(meta?.legacy, false); assert.equal(meta?.source, 'report');
});

test('the first report starts the 30 days; the first AI agent gets its own mail; neither repeats', async () => {
  const w = await world();
  await w.mail.onSignup(w.account, w.email, null);
  const t0 = w.now();
  await w.store.insertTelemetry(w.keyId, [ev({ at: t0 })]);
  await w.mail.onIngest(w.account, 'Acme Billing', [ev({ at: t0 })]);
  assert.deepEqual(w.transport.sent.map((m) => m.kind), ['welcome', 'connected']);
  assert.match(w.transport.sent[1]!.html, /Acme Billing/);
  assert.equal((await w.store.accountMeta(w.account))?.connectedAt, t0);

  const agent = [ev({ at: t0 + 60_000, session: 'fedcba9876543210', actor: 'agent_likely', tools: ['claude-chrome'], resource: 'customers.export', computed: 'step_up' })];
  await w.store.insertTelemetry(w.keyId, agent);
  await w.mail.onIngest(w.account, 'Acme Billing', agent);
  await w.mail.onIngest(w.account, 'Acme Billing', agent);
  const kinds = w.transport.sent.map((m) => m.kind);
  assert.deepEqual(kinds, ['welcome', 'connected', 'first_agent']);
  const fa = w.transport.sent[2]!;
  assert.equal(fa.subject, 'First AI agent in your app: Claude in Chrome');
  assert.match(fa.text, /customers\.export/); assert.match(fa.text, /would have asked the account owner first/);
});

test('the daily run: a nudge on day 1, help on day 4, never both, never twice, nothing for a legacy account', async () => {
  const w = await world();
  await w.mail.onSignup(w.account, w.email, null);
  const start = w.now();
  // a legacy account (from before these mails) with no app connected: no reminders after the fact
  const old = (await w.store.createAccount('old@acme.io', 'x', start - 90 * DAY))!;

  w.at(start + 2 * 3600e3); assert.equal((await w.mail.runDaily()).sent, 0, 'too early for a nudge');
  w.at(start + 1 * DAY); assert.equal((await w.mail.runDaily()).sent, 1);
  w.at(start + 1 * DAY + 3600e3); assert.equal((await w.mail.runDaily()).sent, 0, 'the same day again: nothing');
  w.at(start + 4 * DAY); assert.equal((await w.mail.runDaily()).sent, 1);
  w.at(start + 9 * DAY); assert.equal((await w.mail.runDaily()).sent, 0, 'after the last reminder: quiet');
  assert.deepEqual(w.transport.sent.map((m) => m.kind), ['welcome', 'setup_nudge', 'setup_help']);
  assert.equal((await w.store.accountMeta(old))?.legacy, true);
  assert.ok(!w.transport.sent.some((m) => m.to === 'old@acme.io'));
});

test('a missed week sends only the current mail, not a backlog; weekly mails skip quiet weeks; day 30 sends the report', async () => {
  const w = await world();
  await w.mail.onSignup(w.account, w.email, null);
  const t0 = w.now();
  await w.store.insertTelemetry(w.keyId, [ev({ at: t0 })]);
  await w.mail.onIngest(w.account, 'Acme Billing', [ev({ at: t0 })]);
  // traffic in week 2 only, with an agent
  const wk2 = [ev({ at: t0 + 10 * DAY }), ev({ at: t0 + 10 * DAY + 1000, session: '1111222233334444', actor: 'agent_likely', tools: ['codex-chrome'], computed: 'mask' })];
  await w.store.insertTelemetry(w.keyId, wk2);

  w.at(t0 + 7 * DAY + 3600e3); await w.mail.runDaily();
  assert.ok(!w.transport.sent.some((m) => m.kind === 'weekly'), 'week 1 was quiet after the first report: no mail');
  w.at(t0 + 14 * DAY + 3600e3); await w.mail.runDaily();
  const weekly = w.transport.sent.filter((m) => m.kind === 'weekly');
  assert.equal(weekly.length, 1, 'one weekly mail for week 2, nothing for the missed week 1');
  assert.match(weekly[0]!.subject, /AI agents in 1 customer session/);
  assert.match(weekly[0]!.html, /Codex/);
  w.at(t0 + 30 * DAY + 3600e3); await w.mail.runDaily();
  w.at(t0 + 31 * DAY); await w.mail.runDaily();
  const ready = w.transport.sent.filter((m) => m.kind === 'report_ready');
  assert.equal(ready.length, 1);
  assert.match(ready[0]!.subject, /30-day AI agent report is ready/);
  assert.match(ready[0]!.html, /portal#report/);
});

test('stop means stop; addresses that cannot receive mail are never tried; a failed send is retried, at most three times', async () => {
  const w = await world();
  await w.mail.onSignup(w.account, w.email, null);
  await w.store.setEmailOff(w.account, true);
  w.at(w.now() + 1 * DAY); await w.mail.runDaily();
  assert.equal(w.transport.sent.length, 1, 'only the welcome, sent before the stop');

  const x = await world('someone@company.example');
  await x.mail.onSignup(x.account, x.email, null);
  assert.equal(x.transport.sent.length, 0);

  const f = await world('flaky@acme.io');
  f.transport.fail(1);
  await f.mail.onSignup(f.account, f.email, null);
  assert.equal(f.transport.sent.length, 0);
  f.at(f.now() + 1 * DAY);
  f.transport.fail(5);
  await f.mail.runDaily(); await f.mail.runDaily(); await f.mail.runDaily(); await f.mail.runDaily();
  const log = await f.store.recentEmails();
  const nudge = log.find((e) => e.kind === 'setup_nudge')!;
  assert.equal(nudge.status, 'failed'); assert.equal(nudge.attempts, 3, 'tried three times, then left alone');
});

test('every mail renders as HTML and plain text, with no unfilled placeholder', () => {
  const ctx = { base: 'https://onehuman.ai', email: 'you@company.com', unsubscribeUrl: 'https://onehuman.ai/email/unsubscribe?a=x&t=y' };
  for (const kind of MAIL_KINDS) {
    const m = previewMail(kind, ctx, sampleReport());
    assert.ok(m.subject.length > 10 && m.subject.length < 80, `${kind}: subject`);
    assert.ok(m.preheader.length > 10, `${kind}: preheader`);
    for (const body of [m.html, m.text]) {
      assert.ok(!/undefined|NaN|\[object|\$\{|\{\{/.test(body), `${kind}: nothing unfilled`);
      assert.ok(body.includes('unsubscribe'), `${kind}: the stop link`);
    }
    assert.match(m.html, /email-logo\.png/);
  }
});

test('over HTTP: sign-up still works with mail, the stop page asks before it stops, the cron needs its secret, /report is filled', async () => {
  const transport = fakeTransport();
  process.env.CRON_SECRET = 'cron-secret-for-the-test-0123456789';
  const app = await createApp({ labOperator: false, mailTransport: transport, secret });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  after(() => { app.server.close(); app.store.close(); delete process.env.CRON_SECRET; });

  const r = await fetch(`${base}/api/v1/portal/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ email: 'cto@startup.io', password: 'longenough1', source: 'report' }) });
  assert.equal(r.status, 201);
  const cookie = r.headers.get('set-cookie')!.split(';')[0]!;
  assert.equal(transport.sent.length, 1);
  const me = await (await fetch(`${base}/api/v1/portal/me`, { headers: { Cookie: cookie } })).json();
  assert.equal(me.trial.connectedAt, null); assert.equal(me.trial.emails, true); assert.equal(me.trial.mail, true);

  const unsub = new URL(transport.sent[0]!.unsubscribeUrl);
  const local = `${base}${unsub.pathname}${unsub.search}`;
  const page = await fetch(local);
  assert.equal(page.status, 200); assert.match(await page.text(), /<form method="post"/);
  assert.equal((await fetch(`${base}/api/v1/portal/me`, { headers: { Cookie: cookie } }).then((x) => x.json())).trial.emails, true, 'opening the link changes nothing');
  const done = await fetch(local, { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(done.status, 200);
  assert.equal((await fetch(`${base}/api/v1/portal/me`, { headers: { Cookie: cookie } }).then((x) => x.json())).trial.emails, false);
  const bad = await fetch(`${base}/email/unsubscribe?a=${unsub.searchParams.get('a')}&t=${'x'.repeat(32)}`, { method: 'POST' });
  assert.equal(bad.status, 400);
  // back on from the dashboard
  const on = await fetch(`${base}/api/v1/portal/email`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie }, body: JSON.stringify({ reports: true }) });
  assert.equal(on.status, 200);

  assert.equal((await fetch(`${base}/api/cron/email`)).status, 404);
  assert.equal((await fetch(`${base}/api/cron/email`, { headers: { Authorization: 'Bearer wrong' } })).status, 404);
  const run = await fetch(`${base}/api/cron/email`, { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } });
  assert.equal(run.status, 200); assert.equal((await run.json()).transport, 'fake');

  // the 30-day report covers an exact period when asked (the free report's own 30 days): never the future, at most 90 days
  const acc = (await app.store.accountByEmail('cto@startup.io'))!.id;
  const keyId = await app.store.createApiKey(acc, { name: 'Shop', prefix: 'oh_live_tst', hash: 'h-report-range' }, Date.now());
  const rep = (q: string) => fetch(`${base}/api/v1/portal/report?key=${keyId}&${q}`, { headers: { Cookie: cookie } }).then((x) => x.json());
  const from = Date.now() - 40 * DAY, to = from + 30 * DAY;
  const exact = await rep(`from=${from}&to=${to}`);
  assert.equal(exact.period.from, from); assert.equal(exact.period.to, to);
  assert.ok((await rep(`from=${Date.now() - DAY}&to=${Date.now() + 10 * DAY}`)).period.to <= Date.now(), 'not into the future');
  const long = await rep(`from=1&to=${to}`);
  assert.equal(long.period.to - long.period.from, 90 * DAY, 'at most 90 days');
  const printable = await fetch(`${base}/api/v1/portal/report?key=${keyId}&from=${from}&to=${to}&format=html`, { headers: { Cookie: cookie } }).then((x) => x.text());
  assert.match(printable, /save it as a PDF/);

  const report = await (await fetch(`${base}/report`)).text();
  assert.ok(!report.includes('{{'), 'every sample figure is filled');
  assert.match(report, /Start my free report/);
  assert.equal((await fetch(`${base}/report/sample`)).status, 200);
});

test('a provider that hangs or fails never breaks the sign-up', async () => {
  const slow: Transport = { name: 'slow', send: () => new Promise((_r, rej) => setTimeout(() => rej(new Error('down')), 200)) };
  const app = await createApp({ labOperator: false, mailTransport: slow, secret });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  after(() => { app.server.close(); app.store.close(); });
  const r = await fetch(`${base}/api/v1/portal/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ email: 'dev@shop.io', password: 'longenough1' }) });
  assert.equal(r.status, 201);
});
