// SPDX-License-Identifier: BUSL-1.1
/**
 * E-mail for the free 30-day AI agent report: who gets which mail, when, and how it is sent.
 *
 *   right away   welcome (sign-up) · connected (the app's first report) · first_agent (the first AI agent)
 *   daily run    setup_nudge (a day after sign-up, nothing reported) · setup_help (day 4, the last reminder)
 *                weekly (days 7, 14, 21 of the 30, then every 7 days while the app reports) · report_ready (day 30)
 *
 * The daily run is a Vercel cron (GET /api/cron/email with CRON_SECRET) or, on a long-running server, a timer.
 * Every mail is claimed in email_log before it is sent, so two runs never send it twice; a failed send is retried by
 * the next run, at most three times. At most one scheduled mail per account per run, and only the one due now: a
 * missed day never sends a backlog.
 *
 * Provider: Resend over HTTPS (RESEND_API_KEY). Sender: ONEHUMAN_MAIL_FROM, default "Arif from OneHuman
 * <arif@onehuman.ai>"; replies go to ONEHUMAN_MAIL_REPLY_TO (default arif@onehuman.ai). Without a key nothing is
 * sent and nothing is recorded (once the key is set, the schedule picks up where it is); a local server writes each
 * mail to data/outbox/ instead, to look at.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildReport, agentName } from '../integrations/report/build.ts';
import type { SiteStore, TelemetryEvent } from './site-db.ts';
import * as T from './mail-templates.ts';
import type { Mail, MailKind } from './mail-templates.ts';

const DAY = 86_400_000;
export type Outgoing = Mail & { to: string; kind: MailKind | 'invite' | 'chat' | 'plan' | 'team' | 'scan'; idempotencyKey: string; unsubscribeUrl: string; unsubscribePost: string };
export type Transport = { name: string; send(m: Outgoing): Promise<{ id: string | null }> };

/** Resend's HTTP API; no SDK, one request per mail. */
export function resendTransport(apiKey: string, from: string, replyTo: string): Transport {
  return {
    name: 'resend',
    async send(m) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': m.idempotencyKey },
        body: JSON.stringify({
          from, to: [m.to], reply_to: replyTo, subject: m.subject, html: m.html, text: m.text,
          // one-off mails a person asked for (an invitation) have nothing to stop
          ...(m.unsubscribePost ? { headers: { 'List-Unsubscribe': `<${m.unsubscribePost}>, <mailto:${replyTo}?subject=unsubscribe>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } } : {}),
          tags: [{ name: 'kind', value: m.kind }],
        }),
        signal: AbortSignal.timeout(8000),
      });
      const body = (await r.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
      if (!r.ok) throw new Error(`resend ${r.status}: ${body.message ?? body.name ?? 'error'}`);
      return { id: body.id ?? null };
    },
  };
}

/** a local server without a provider: each mail lands in data/outbox/ as .html and .txt */
export function outboxTransport(dir: string): Transport {
  return {
    name: 'outbox',
    async send(m) {
      await mkdir(dir, { recursive: true });
      const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${m.kind}`;
      await writeFile(join(dir, `${name}.html`), m.html);
      await writeFile(join(dir, `${name}.txt`), `To: ${m.to}\nSubject: ${m.subject}\n\n${m.text}`);
      return { id: name };
    },
  };
}

export function transportFromEnv(opts: { serverless: boolean; root: string }): Transport | null {
  const from = process.env.ONEHUMAN_MAIL_FROM || 'Arif from OneHuman <arif@onehuman.ai>';
  const replyTo = process.env.ONEHUMAN_MAIL_REPLY_TO || 'arif@onehuman.ai';
  // a key pasted with a stray space or line break still works
  const key = (process.env.RESEND_API_KEY ?? '').trim();
  if (key) return resendTransport(key, from, replyTo);
  if (!opts.serverless && process.env.ONEHUMAN_MAIL_OUTBOX !== '0') return outboxTransport(process.env.ONEHUMAN_MAIL_OUTBOX || join(opts.root, 'data', 'outbox'));
  return null;
}

/** addresses that can never receive mail (tests, examples): never sent to, so bounces never hurt the sender */
const NO_MAIL = /@(?:[^@]+\.)?(?:example\.(?:com|org|net)|[^@]+\.(?:test|example|invalid|localhost|local))$/i;

export type Mailer = ReturnType<typeof mailer>;

export function mailer(store: SiteStore, opts: { secret: Buffer; base?: string; transport: Transport | null; now?: () => number; log?: (msg: string) => void }) {
  const base = (opts.base ?? process.env.ONEHUMAN_PUBLIC_URL ?? 'https://onehuman.ai').replace(/\/$/, '');
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((m: string) => console.warn(m));
  const tokenFor = (account: string) => createHmac('sha256', opts.secret).update(`unsubscribe:${account}`).digest('base64url').slice(0, 32);
  const unsubscribeUrl = (account: string) => `${base}/email/unsubscribe?a=${encodeURIComponent(account)}&t=${tokenFor(account)}`;
  const ctxFor = (account: string, email: string): T.MailContext => ({ base, email, unsubscribeUrl: unsubscribeUrl(account) });
  /** accounts whose connected and first-agent moments are both behind them: the ingest hook skips them */
  const settled = new Set<string>();

  function checkUnsubscribe(account: string, token: string): boolean {
    const a = Buffer.from(tokenFor(account)), b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** claim → render → send → record. Returns what happened, for the run's summary and the tests. */
  async function deliver(account: string, email: string, kind: MailKind, ref: string, render: (ctx: T.MailContext) => Mail): Promise<'sent' | 'skipped' | 'failed' | 'taken' | 'off'> {
    if (!opts.transport) return 'off';
    if (NO_MAIL.test(email)) return 'skipped';
    if (!(await store.claimEmail(account, kind, ref, now()))) return 'taken';
    try {
      const mail = render(ctxFor(account, email));
      const r = await opts.transport.send({ ...mail, to: email, kind, idempotencyKey: `${account}:${kind}:${ref}`, unsubscribeUrl: unsubscribeUrl(account), unsubscribePost: unsubscribeUrl(account) });
      await store.finishEmail(account, kind, ref, 'sent', r.id, null);
      return 'sent';
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`onehuman mail: ${kind} to account ${account} failed: ${msg}`);
      await store.finishEmail(account, kind, ref, 'failed', null, msg).catch(() => {});
      return 'failed';
    }
  }

  /** sign-up: the account starts its report now, and gets the welcome mail */
  async function onSignup(account: string, email: string, source: string | null): Promise<void> {
    await store.ensureAccountMeta(account, { started: now(), legacy: false, source });
    await deliver(account, email, 'welcome', 'once', (ctx) => T.welcomeMail(ctx));
  }

  /**
   * After a batch from the account's app was stored: the first report starts the 30 days, the first AI agent is worth
   * a mail of its own. One cheap read per batch until both happened, then nothing (`settled`).
   */
  async function onIngest(account: string, keyName: string, events: TelemetryEvent[]): Promise<void> {
    if (settled.has(account) || !events.length) return;
    let meta = await store.accountMeta(account);
    if (!meta) {
      // an account from before these mails: take what already happened as known, and send nothing about the past
      const firsts = await store.accountFirsts(account);
      await store.ensureAccountMeta(account, { started: now(), legacy: true });
      if (firsts.first != null) await store.markAccountConnected(account, firsts.first);
      if (firsts.firstAgent != null) await store.markAccountFirstAgent(account, firsts.firstAgent);
      meta = await store.accountMeta(account);
      if (!meta) return;
    }
    const acc = await store.accountById(account);
    if (!acc) return;
    const at = Math.min(...events.map((e) => e.at));
    if (meta.connectedAt == null && (await store.markAccountConnected(account, at)) && !meta.emailOff) {
      await deliver(account, acc.email, 'connected', 'once', (ctx) => T.connectedMail(ctx, { app: keyName, start: at }));
    }
    const agentEvents = events.filter((e) => e.actor === 'agent_likely' || e.tools.length > 0);
    if (meta.firstAgentAt == null && agentEvents.length) {
      const first = agentEvents[0]!;
      if ((await store.markAccountFirstAgent(account, first.at)) && !meta.emailOff) {
        const session = agentEvents.filter((e) => e.session === first.session);
        const tool = session.flatMap((e) => e.tools)[0];
        await deliver(account, acc.email, 'first_agent', 'once', (ctx) => T.firstAgentMail(ctx, {
          agent: tool ? agentName(tool) : 'An AI agent', at: first.at,
          actions: dedupe(session.map((e) => ({ resource: e.resource, computed: e.computed ?? e.decision }))),
          observe: session.every((e) => e.enforcement !== 'enforce'),
        }));
      }
    }
    if ((meta.connectedAt != null || events.length) && (meta.firstAgentAt != null || agentEvents.length)) settled.add(account);
  }

  /** what one account is due today, if anything: [kind, ref] */
  function due(a: { created: number; meta: NonNullable<Awaited<ReturnType<SiteStore['accountMeta']>>> }, t: number): [MailKind, string][] {
    const m = a.meta;
    if (m.connectedAt == null) {
      if (m.legacy) return [];
      const age = t - m.started;
      if (age >= 4 * DAY && age < 14 * DAY) return [['setup_help', 'once']];
      if (age >= 20 * 3600e3 && age < 4 * DAY) return [['setup_nudge', 'once']];
      return [];
    }
    const day = Math.floor((t - m.connectedAt) / DAY);
    if (day >= 30 && day < 37) return [['report_ready', 'r30']];
    if (day >= 7 && day < 28) return [['weekly', `w${Math.floor(day / 7)}`]];
    if (day >= 37) return [['weekly', `p${Math.floor((day - 30) / 7)}`]];
    return [];
  }

  /** the daily run: every account, at most one scheduled mail each */
  async function runDaily(opts2: { limit?: number; budgetMs?: number } = {}): Promise<{ accounts: number; sent: number; skipped: number; failed: number; due: number }> {
    const out = { accounts: 0, sent: 0, skipped: 0, failed: 0, due: 0 };
    if (!opts.transport) return out;
    const t = now();
    const limit = opts2.limit ?? 60;
    // the function has 15 seconds; whatever is left over is due tomorrow too (refs are per week, not per day)
    const started = Date.now();
    for (const a of await store.lifecycleAccounts()) {
      if (out.sent + out.failed >= limit || Date.now() - started > (opts2.budgetMs ?? 10_000)) break;
      out.accounts++;
      let meta = a.meta;
      if (!meta) {
        // older than these mails: no welcome or reminders after the fact, but the weekly summary and the report
        const firsts = await store.accountFirsts(a.id);
        await store.ensureAccountMeta(a.id, { started: t, legacy: true });
        if (firsts.first != null) await store.markAccountConnected(a.id, firsts.first);
        if (firsts.firstAgent != null) await store.markAccountFirstAgent(a.id, firsts.firstAgent);
        meta = await store.accountMeta(a.id);
        if (!meta) continue;
      }
      if (meta.emailOff || NO_MAIL.test(a.email)) continue;
      // a key that reported while the ingest hook could not mark it (an older deployment): catch up quietly
      if (meta.connectedAt == null) {
        const firsts = await store.accountFirsts(a.id);
        if (firsts.first != null) { await store.markAccountConnected(a.id, firsts.first); meta = { ...meta, connectedAt: firsts.first }; }
      }
      for (const [kind, ref] of due({ created: a.created, meta }, t)) {
        out.due++;
        const r = await sendScheduled(a.id, a.email, kind, ref, meta.connectedAt, t);
        if (r === 'sent') out.sent++; else if (r === 'failed') out.failed++; else if (r === 'skipped') out.skipped++;
      }
    }
    return out;
  }

  async function sendScheduled(account: string, email: string, kind: MailKind, ref: string, connectedAt: number | null, t: number) {
    if (kind === 'setup_nudge') return deliver(account, email, kind, ref, (ctx) => T.setupNudgeMail(ctx));
    if (kind === 'setup_help') return deliver(account, email, kind, ref, (ctx) => T.setupHelpMail(ctx));
    const days = kind === 'report_ready' ? 30 : 7;
    const to = kind === 'report_ready' && connectedAt != null ? Math.min(t, connectedAt + 30 * DAY) : t;
    const from = to - days * DAY;
    const { rows, apps } = await store.accountDecisions(account, from, to);
    // a quiet week is not worth a mail; the 30-day report goes out either way
    if (kind === 'weekly' && !rows.length) return 'skipped';
    const report = buildReport(rows, { from, to, now: t, source: 'portal', app: apps.length === 1 ? apps[0]! : '' });
    const day = connectedAt != null ? Math.floor((t - connectedAt) / DAY) : null;
    if (kind === 'weekly') return deliver(account, email, kind, ref, (ctx) => T.weeklyMail(ctx, { report, day }));
    return deliver(account, email, kind, ref, (ctx) => T.reportReadyMail(ctx, { report }));
  }

  /** the operators' check that mail really leaves: one preview mail to the operator's own address, nothing recorded */
  async function sendTest(account: string, email: string, kind: MailKind, report: import('../integrations/report/build.ts').Report): Promise<{ id: string | null }> {
    if (!opts.transport) throw new Error('no mail provider configured (RESEND_API_KEY is not set)');
    const mail = previewMail(kind, ctxFor(account, email), report, now());
    return opts.transport.send({ ...mail, subject: `[test] ${mail.subject}`, to: email, kind, idempotencyKey: `test:${account}:${kind}:${now()}`, unsubscribeUrl: unsubscribeUrl(account), unsubscribePost: unsubscribeUrl(account) });
  }

  /** an owner shared a key's statistics with `to`: the invitation, once. 'off' without a provider, 'skipped' for a test address. */
  async function sendInvite(to: string, d: { inviteId: string; inviter: string; app: string; link: string; expires: number }): Promise<'sent' | 'skipped' | 'off'> {
    if (!opts.transport) return 'off';
    if (NO_MAIL.test(to)) return 'skipped';
    const mail = T.inviteMail({ base, email: to, unsubscribeUrl: '' }, d);
    await opts.transport.send({ ...mail, to, kind: 'invite', idempotencyKey: `invite:${d.inviteId}`, unsubscribeUrl: '', unsubscribePost: '' });
    return 'sent';
  }

  /** the full map of a repository scan, to the address that unlocked it */
  async function sendScanMap(to: string, d: { scanId: string; repo: string; findings: { kind: string; title: string; why: string; method: string; path: string; file: string; line: number }[]; routes: number; filesScanned: number; frameworks: string[] }): Promise<'sent' | 'skipped' | 'off'> {
    if (!opts.transport) return 'off';
    if (NO_MAIL.test(to)) return 'skipped';
    const mail = T.scanMapMail({ base, email: to, unsubscribeUrl: '' }, { ...d, link: `${base}/scan` });
    await opts.transport.send({ ...mail, to, kind: 'scan', idempotencyKey: `scan-map:${d.scanId}`, unsubscribeUrl: '', unsubscribePost: '' });
    return 'sent';
  }

  /** the team hears about an inbound lead from the scan */
  async function sendScanLead(to: string, d: { scanId: string; email: string; repo: string; findings: { title: string }[]; country: string | null }): Promise<'sent' | 'off'> {
    if (!opts.transport) return 'off';
    const mail = T.scanLeadMail({ base, email: to, unsubscribeUrl: '' }, { ...d, link: `https://github.com/${d.repo}` });
    await opts.transport.send({ ...mail, to, kind: 'scan', idempotencyKey: `scan-lead:${d.scanId}`, unsubscribeUrl: '', unsubscribePost: '' });
    return 'sent';
  }

  /** the team hears about the website chat (server/chat.ts) */
  async function sendChatAlert(to: string, d: { chatId: string; what: 'new' | 'lead' | 'human' | 'waiting'; detail: string; page: string | null; country: string | null; email: string | null }): Promise<'sent' | 'off'> {
    if (!opts.transport) return 'off';
    const mail = T.chatAlertMail({ base, email: to, unsubscribeUrl: '' }, { ...d, link: `${base}/admin-panel#chats/${encodeURIComponent(d.chatId)}` });
    await opts.transport.send({ ...mail, to, kind: 'chat', idempotencyKey: `chat:${d.chatId}:${d.what}:${now()}`, unsubscribeUrl: '', unsubscribePost: '' });
    return 'sent';
  }

  /** an account's plan: near or at its free limit, a balance running low or used up (server/billing.ts) */
  async function sendPlanNotice(to: string, d: { kind: 'near' | 'limit' | 'low' | 'empty' | 'observe'; plan: string; used: number; included: number | null; balanceCents: number; observeFrom?: number | null }): Promise<'sent' | 'off' | 'skipped'> {
    if (!opts.transport) return 'off';
    if (NO_MAIL.test(to)) return 'skipped';
    const mail = T.planNoticeMail({ base, email: to, unsubscribeUrl: '' }, { ...d, link: `${base}/portal#plan` });
    await opts.transport.send({ ...mail, to, kind: 'plan', idempotencyKey: `plan:${to}:${d.kind}:${new Date(now()).toISOString().slice(0, 7)}`, unsubscribeUrl: '', unsubscribePost: '' });
    return 'sent';
  }
  /** a short note to the team (a plan request from the portal) */
  async function sendTeamNotice(to: string, subject: string, lines: [string, string][], link: string): Promise<'sent' | 'off'> {
    if (!opts.transport) return 'off';
    const mail = T.teamNoticeMail({ base, email: to, unsubscribeUrl: '' }, { subject, lines, link });
    await opts.transport.send({ ...mail, to, kind: 'team', idempotencyKey: `team:${subject}:${now()}`, unsubscribeUrl: '', unsubscribePost: '' });
    return 'sent';
  }

  return { onSignup, onIngest, runDaily, sendTest, sendInvite, sendScanMap, sendScanLead, sendChatAlert, sendPlanNotice, sendTeamNotice, checkUnsubscribe, unsubscribeUrl, ctxFor, base, configured: !!opts.transport, transport: opts.transport?.name ?? null };
}

function dedupe(xs: { resource: string; computed: string }[]) {
  const seen = new Set<string>();
  return xs.filter((x) => { const k = `${x.resource}|${x.computed}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** every mail with made-up numbers, for the operators' preview and the tests */
export function previewMail(kind: MailKind, ctx: T.MailContext, report: import('../integrations/report/build.ts').Report, now = Date.now()): Mail {
  switch (kind) {
    case 'welcome': return T.welcomeMail(ctx);
    case 'setup_nudge': return T.setupNudgeMail(ctx);
    case 'setup_help': return T.setupHelpMail(ctx);
    case 'connected': return T.connectedMail(ctx, { app: 'Acme Billing', start: now });
    case 'first_agent': return T.firstAgentMail(ctx, { agent: 'Claude in Chrome', at: now, observe: true, actions: [{ resource: 'customers.read', computed: 'mask' }, { resource: 'invoices.read', computed: 'mask' }, { resource: 'customers.export', computed: 'step_up' }] });
    case 'weekly': {
      const DAY7 = 7 * DAY;
      return T.weeklyMail(ctx, { report: { ...report, period: { from: report.period.to - DAY7, to: report.period.to, days: 7 } }, day: 14 });
    }
    case 'report_ready': return T.reportReadyMail(ctx, { report });
  }
}
