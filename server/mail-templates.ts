// SPDX-License-Identifier: BUSL-1.1
/**
 * The e-mails of the free 30-day AI agent report, as HTML and plain text.
 *
 * Built for mail clients, not browsers: tables for layout, inline styles, no scripts, no web fonts, no SVG, one
 * hosted PNG (the wordmark). Every mail has a plain-text twin, a preheader, the reason it was sent and a one-click
 * way to stop it. The voice is a person's (they come from Arif and a reply reaches him), the words are plain.
 */
import type { Report } from '../integrations/report/build.ts';

export type Mail = { subject: string; preheader: string; html: string; text: string };
export type MailContext = {
  /** https://onehuman.ai, without a trailing slash */
  base: string;
  email: string;
  unsubscribeUrl: string;
};

const CAL = 'https://cal.com/onehumanai';
const FG = '#0b0c0f', FG2 = '#374151', FG3 = '#6b7280', LINE = '#e5e7eb', ACCENT = '#3d8180';
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 1000) / 10}%` : '0%');
const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;
export const longDate = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });

// ------------------------------------------------------------------------------------------------ building blocks
type Block = { html: string; text: string };
const p = (s: string, text = s): Block => ({ html: `<p style="margin:0 0 16px;font:15px/1.6 ${FONT};color:${FG2}">${s}</p>`, text: strip(text) });
const h1 = (s: string): Block => ({ html: `<h1 style="margin:0 0 16px;font:600 22px/1.3 ${FONT};color:${FG};letter-spacing:-0.01em">${esc(s)}</h1>`, text: `${s}\n${'='.repeat(Math.min(60, s.length))}` });
const h2 = (s: string): Block => ({ html: `<h2 style="margin:24px 0 10px;font:600 15px/1.4 ${FONT};color:${FG}">${esc(s)}</h2>`, text: `\n${s}` });
const button = (label: string, href: string): Block => ({
  html: `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px"><tr><td style="border-radius:8px;background:${FG}"><a href="${esc(href)}" style="display:inline-block;padding:12px 20px;font:600 15px/1 ${FONT};color:#ffffff;text-decoration:none;border-radius:8px">${esc(label)}</a></td></tr></table>`,
  text: `${label}: ${href}`,
});
const link = (label: string, href: string) => `<a href="${esc(href)}" style="color:${ACCENT};text-decoration:underline">${esc(label)}</a>`;
const code = (s: string) => `<code style="font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;background:#f3f4f6;border:1px solid ${LINE};border-radius:6px;padding:2px 6px;color:${FG}">${esc(s)}</code>`;
const steps = (items: [string, string][]): Block => ({
  html: `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:4px 0 20px">${items.map(([title, body], i) => `<tr><td valign="top" width="36" style="padding:0 0 14px"><div style="width:26px;height:26px;border-radius:13px;background:#eef6f5;color:${ACCENT};font:600 13px/26px ${FONT};text-align:center">${i + 1}</div></td><td valign="top" style="padding:2px 0 14px;font:15px/1.55 ${FONT};color:${FG2}"><b style="color:${FG}">${title}</b><br>${body}</td></tr>`).join('')}</table>`,
  text: items.map(([title, body], i) => `${i + 1}. ${strip(title)}: ${strip(body)}`).join('\n'),
});
/** two-by-two figures, the core of every report mail */
const kpis = (items: [string, string][]): Block => {
  const cell = ([v, l]: [string, string]) => `<td width="50%" valign="top" style="padding:6px"><div style="border:1px solid ${LINE};border-radius:10px;padding:14px 16px"><div style="font:600 24px/1.2 ${FONT};color:${FG};letter-spacing:-0.01em">${esc(v)}</div><div style="font:13px/1.4 ${FONT};color:${FG3};margin-top:4px">${esc(l)}</div></div></td>`;
  const rows: string[] = [];
  for (let i = 0; i < items.length; i += 2) rows.push(`<tr>${cell(items[i]!)}${items[i + 1] ? cell(items[i + 1]!) : '<td width="50%"></td>'}</tr>`);
  return { html: `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 16px">${rows.join('')}</table>`, text: items.map(([v, l]) => `- ${l}: ${v}`).join('\n') };
};
/** a short ranked list: name on the left, number on the right */
const list = (rows: [string, string][]): Block => ({
  html: `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 16px">${rows.map(([name, n], i) => `<tr><td style="padding:9px 0;${i ? `border-top:1px solid ${LINE};` : ''}font:14px/1.4 ${FONT};color:${FG}">${esc(name)}</td><td align="right" style="padding:9px 0;${i ? `border-top:1px solid ${LINE};` : ''}font:600 14px/1.4 ${FONT};color:${FG}">${esc(n)}</td></tr>`).join('')}</table>`,
  text: rows.map(([name, n]) => `- ${name}: ${n}`).join('\n'),
});
const note = (s: string): Block => ({ html: `<div style="margin:0 0 20px;padding:12px 14px;border-radius:10px;background:#f6f7f9;font:14px/1.55 ${FONT};color:${FG2}">${s}</div>`, text: strip(s) });
const sign = (): Block => ({
  html: `<p style="margin:24px 0 0;font:15px/1.6 ${FONT};color:${FG2}">Arif<br><span style="color:${FG3};font-size:13px">OneHuman</span></p>`,
  text: '\nArif\nOneHuman',
});
function strip(s: string) {
  return s.replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g, (_m, href, label) => `${label} (${href.replace(/&amp;/g, '&')})`).replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

function layout(ctx: MailContext, subject: string, preheader: string, blocks: Block[], why: string): Mail {
  const body = blocks.map((b) => b.html).join('\n');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(subject)}</title><style>@media (max-width:620px){.px{padding-left:20px!important;padding-right:20px!important}.outer{padding:16px 8px!important}}</style></head>
<body style="margin:0;padding:0;background:#f4f5f7;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(preheader)}${'&nbsp;&zwnj;'.repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f5f7"><tr><td align="center" class="outer" style="padding:32px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid ${LINE};border-radius:12px">
<tr><td class="px" style="padding:28px 36px 4px"><a href="${esc(ctx.base)}" style="text-decoration:none"><img src="${esc(ctx.base)}/email-logo.png" width="134" height="22" alt="OneHuman" style="display:block;border:0;width:134px;height:22px"></a></td></tr>
<tr><td class="px" style="padding:20px 36px 32px">
${body}
</td></tr></table>
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px"><tr><td class="px" style="padding:18px 36px 0;font:12px/1.6 ${FONT};color:${FG3}">
${esc(why)} Sent to ${esc(ctx.email)}.<br>
Reply to this e-mail and it reaches Arif directly.${ctx.unsubscribeUrl ? ` ${link('Stop these e-mails', ctx.unsubscribeUrl)}.` : ''}<br>
OneHuman Inc. · access control for your customers' AI agents · <a href="${esc(ctx.base)}" style="color:${FG3}">onehuman.ai</a>
</td></tr></table>
</td></tr></table></body></html>`;
  const text = `${blocks.map((b) => b.text).join('\n\n')}\n\n--\n${why} Sent to ${ctx.email}.\nReply to this e-mail and it reaches Arif directly.\n${ctx.unsubscribeUrl ? `Stop these e-mails: ${ctx.unsubscribeUrl}\n` : ''}OneHuman Inc. · ${ctx.base}\n`;
  return { subject, preheader, html, text };
}

const WHY_SIGNUP = 'You are getting this because you created a OneHuman account for the free AI agent report.';
const WHY_REPORT = 'You are getting this because your app reports to OneHuman.';

// ------------------------------------------------------------------------------------------------ the mails

/** right after sign-up */
export function welcomeMail(ctx: MailContext): Mail {
  return layout(ctx, 'Your free AI agent report starts here', 'One command, then OneHuman watches your app for 30 days. Nothing is blocked.', [
    h1('Welcome to OneHuman'),
    p('Thanks for signing up. For the next 30 days OneHuman watches your app and shows you which AI agents log in as your customers, and what they touch.'),
    p('<b style="color:#0b0c0f">Nothing is blocked while it watches.</b> Your users will not notice anything. At the end you get a report you can forward to your team.', 'Nothing is blocked while it watches. Your users will not notice anything. At the end you get a report you can forward to your team.'),
    h2('Three steps, about 10 minutes'),
    steps([
      ['Create an API key', 'In your dashboard, one click.'],
      ['Run one command in your app', `${code('npx onehumanai init')} asks three questions and shows every change before it writes anything.`],
      ['Deploy', 'Your 30 days start with the first report from your app.'],
    ]),
    button('Set it up', `${ctx.base}/portal#integrate`),
    p(`Would you rather do it together? ${link('Book 15 minutes with us', CAL)} and we set it up with you on the call.`),
    p('If anything is unclear, just reply. This e-mail comes from me, and I read every answer.'),
    sign(),
  ], WHY_SIGNUP);
}

/** a day after sign-up, when the app has not reported yet */
export function setupNudgeMail(ctx: MailContext): Mail {
  return layout(ctx, 'One step left to start your report', 'Your account is ready. Your 30 days start when your app sends its first report.', [
    h1('Your report has not started yet'),
    p('Your account is ready, but your app has not reported to OneHuman yet. The 30 days start from the first report, so nothing is lost by waiting.'),
    p(`It usually takes about 10 minutes. In your app's folder, run ${code('npx onehumanai init')}, then deploy. Watch-only mode is the default: nothing is blocked.`, "It usually takes about 10 minutes. In your app's folder, run npx onehumanai init, then deploy. Watch-only mode is the default: nothing is blocked."),
    note(`<b style="color:#0b0c0f">Use a coding agent?</b> Your dashboard has a ready prompt for Claude Code, Codex or Cursor under Set up. Paste it and the agent does the whole thing, then shows you the changes.`),
    button('Open Set up', `${ctx.base}/portal#integrate`),
    p('Stuck somewhere? Reply and tell me where. I will help you get it running.'),
    sign(),
  ], WHY_SIGNUP);
}

/** four days after sign-up, still not connected: the last reminder */
export function setupHelpMail(ctx: MailContext): Mail {
  return layout(ctx, 'Want us to set it up with you?', 'A 15-minute call, and your 30-day report starts the same day.', [
    h1('Want us to set it up with you?'),
    p('Your app is not connected to OneHuman yet. Most teams finish it in one short call with us: you share your screen, we run the command together and check the first report.'),
    button('Book 15 minutes', CAL),
    p('If now is not the right time, that is fine. This is the last reminder. Your account stays ready, and your 30 days start whenever your app sends its first report.'),
    sign(),
  ], WHY_SIGNUP);
}

/** the first report from the app */
export function connectedMail(ctx: MailContext, d: { app: string; start: number }): Mail {
  const end = d.start + 30 * 86_400_000;
  return layout(ctx, 'OneHuman is connected. Your 30 days start today', `Your report will be ready on ${longDate(end)}.`, [
    h1('Your app is connected'),
    p(`We received the first report from ${d.app ? `<b style="color:#0b0c0f">${esc(d.app)}</b>` : 'your app'}. From today until ${esc(longDate(end))}, OneHuman watches and records.`, `We received the first report from ${d.app || 'your app'}. From today until ${longDate(end)}, OneHuman watches and records.`),
    h2('What happens next'),
    steps([
      ['When the first AI agent shows up', 'we e-mail you what it was and what it touched.'],
      ['Every week', 'a short summary: sessions, agents, what OneHuman would have done.'],
      [`On ${esc(longDate(end))}`, 'your full 30-day report, ready to forward to your team.'],
    ]),
    note('Watch-only mode: nothing is blocked and your users see no difference. You decide later whether to turn protection on.'),
    button('Open your dashboard', `${ctx.base}/portal`),
    sign(),
  ], WHY_REPORT);
}

const DECISION_WORD: Record<string, string> = { mask: 'hidden the private data', step_up: 'asked the account owner first', block: 'refused it', allow: 'let it through' };

/** the first AI agent in the app */
export function firstAgentMail(ctx: MailContext, d: { agent: string; at: number; actions: { resource: string; computed: string }[]; observe: boolean }): Mail {
  const would = d.actions.filter((a) => a.computed !== 'allow');
  const rows: [string, string][] = d.actions.slice(0, 5).map((a) => [a.resource, d.observe ? (a.computed === 'allow' ? 'allowed' : `would have ${DECISION_WORD[a.computed] ?? a.computed}`) : DECISION_WORD[a.computed] ?? a.computed]);
  return layout(ctx, `First AI agent in your app: ${d.agent}`, `${d.agent} was inside one of your customers' sessions.`, [
    h1(`${d.agent} just used your app`),
    p(`On ${esc(longDate(d.at))}, <b style="color:#0b0c0f">${esc(d.agent)}</b> was inside one of your customers' sessions. It was logged in as that customer, so to your app it looked exactly like them.`, `On ${longDate(d.at)}, ${d.agent} was inside one of your customers' sessions. It was logged in as that customer, so to your app it looked exactly like them.`),
    ...(rows.length ? [h2('What it asked for'), list(rows)] : []),
    d.observe
      ? note(would.length ? `Watch-only mode let it through. With protection on, OneHuman would have stepped in ${would.length === 1 ? 'once' : `${fmt(would.length)} times`}.` : 'Watch-only mode let it through. Your current rules would have allowed these actions too.')
      : note('Protection is on: your rules were applied.'),
    button('See what it did', `${ctx.base}/portal#agents`),
    p('This is usually the first of many. Your weekly summary shows how often it happens.'),
    sign(),
  ], WHY_REPORT);
}

/** the figures every report mail shares */
function reportBlocks(r: Report): Block[] {
  const a = r.agentRequests;
  const stepped = a.wouldBlock + a.wouldMask + a.wouldStepUp;
  const would = r.mode === 'enforce' ? '' : 'would have been ';
  const blocks: Block[] = [kpis([
    [fmt(r.sessions.total), 'customer sessions'],
    [pct(r.sessions.withAgent, r.sessions.total), `had an AI agent in them (${fmt(r.sessions.withAgent)})`],
    [fmt(r.agents.length), r.agents.length === 1 ? 'AI agent product seen' : 'AI agent products seen'],
    [fmt(stepped), `agent requests ${r.mode === 'enforce' ? 'were ' : would}hidden, refused or sent to the owner`],
  ])];
  if (r.agents.length) blocks.push(h2('Which AI agents'), list(r.agents.slice(0, 5).map((x) => [x.name, plural(x.sessions, 'session')])));
  const eps = r.endpoints.filter((e) => e.agentRequests > 0).slice(0, 5);
  if (eps.length) blocks.push(h2('What they reached for'), list(eps.map((e) => [e.resource, plural(e.agentRequests, 'request')])));
  blocks.push(note(r.people.wouldBeStopped
    ? `${plural(r.people.wouldBeStopped, 'request')} by real people ${r.mode === 'enforce' ? 'were' : 'would have been'} refused. Look at those rules before you turn protection on.`
    : `<b style="color:#0b0c0f">No real person ${r.mode === 'enforce' ? 'was' : 'would have been'} stopped.</b> That is the number to keep at zero.`));
  return blocks;
}

/** every week: during the 30 days, and after them while the app keeps reporting */
export function weeklyMail(ctx: MailContext, d: { report: Report; day: number | null }): Mail {
  const r = d.report;
  const agents = r.sessions.withAgent;
  const subject = agents ? `This week: AI agents in ${plural(agents, 'customer session')}` : 'This week: no AI agents in your app';
  const pre = d.day != null && d.day < 30 ? `Day ${d.day} of 30. ${r.notes[0] ?? ''}` : r.notes[0] ?? 'Your weekly OneHuman summary.';
  return layout(ctx, subject, pre, [
    h1(d.day != null && d.day < 30 ? `Your week with AI agents · day ${d.day} of 30` : 'Your week with AI agents'),
    p(`${esc(longDate(r.period.from))} to ${esc(longDate(r.period.to))}${r.app ? ` · ${esc(r.app)}` : ''}. ${r.mode === 'enforce' ? 'Protection is on.' : 'Watch-only mode: nothing was blocked.'}`, `${longDate(r.period.from)} to ${longDate(r.period.to)}${r.app ? ` · ${r.app}` : ''}. ${r.mode === 'enforce' ? 'Protection is on.' : 'Watch-only mode: nothing was blocked.'}`),
    ...reportBlocks(r),
    button('Open the full report', `${ctx.base}/portal#weekly`),
    sign(),
  ], WHY_REPORT);
}

/** day 30: the report the trial was for */
export function reportReadyMail(ctx: MailContext, d: { report: Report }): Mail {
  const r = d.report;
  const headline = r.sessions.withAgent
    ? `AI agents were inside ${fmt(r.sessions.withAgent)} of your customers' sessions (${pct(r.sessions.withAgent, r.sessions.total)}).`
    : 'No AI agent was seen in your app in these 30 days.';
  return layout(ctx, 'Your 30-day AI agent report is ready', headline, [
    h1('Your 30-day report is ready'),
    p(`<b style="color:#0b0c0f">${esc(headline)}</b>`, headline),
    ...reportBlocks(r),
    button('Open the report', `${ctx.base}/portal#report`),
    h2('What you can do now'),
    steps([
      ['Turn protection on', 'Your rules start to apply. Private data is hidden from agents, and risky actions wait for the owner\'s passkey.'],
      ['Or keep watching', 'Nothing changes. You keep getting the weekly summary.'],
      ['Talk it through with us', `${link('Book 15 minutes', CAL)} and we go through your report together, or get help going live.`],
    ]),
    sign(),
  ], WHY_REPORT);
}

/**
 * Someone shared one app's statistics with this address. Sent once, when the owner asks; nothing else follows, so it
 * carries no stop link: ignoring it is enough.
 */
export function inviteMail(ctx: MailContext, d: { inviter: string; app: string; link: string; expires: number }): Mail {
  return layout(ctx, `${d.inviter} shared OneHuman statistics with you`, `See what AI agents do in ${d.app}: sessions, agents, and what OneHuman did about them.`, [
    h1(`${d.app}: AI agent statistics`),
    p(`<b style="color:#0b0c0f">${esc(d.inviter)}</b> invited you to see the OneHuman statistics of <b style="color:#0b0c0f">${esc(d.app)}</b>: which AI agents log in as its customers, what they reach for, and what OneHuman did or would have done.`, `${d.inviter} invited you to see the OneHuman statistics of ${d.app}: which AI agents log in as its customers, what they reach for, and what OneHuman did or would have done.`),
    p(`You can look, not change anything. Sign in or create a free account with ${esc(ctx.email)} to open it.`, `You can look, not change anything. Sign in or create a free account with ${ctx.email} to open it.`),
    button('Open the statistics', d.link),
    note(`The link works once and until ${esc(longDate(d.expires))}. If you did not expect this e-mail, ignore it: nothing happens without you.`),
    sign(),
  ], `You are getting this because ${d.inviter} invited ${ctx.email}.`);
}

/** to the team: something in the website chat wants a person's eyes */
export function chatAlertMail(ctx: MailContext, d: { what: 'new' | 'lead' | 'human' | 'waiting'; detail: string; page: string | null; country: string | null; email: string | null; link: string }): Mail {
  const quote = d.detail.length > 70 ? `${d.detail.slice(0, 70)}…` : d.detail;
  const subject = d.what === 'new' ? `New chat on onehuman.ai: “${quote}”`
    : d.what === 'lead' ? `Lead in the chat: ${d.email ?? 'an e-mail address'}`
    : d.what === 'human' ? 'A visitor asks for a person in the chat'
    : 'A message is waiting for you in the chat';
  const lead = d.what === 'new' ? 'Someone started a chat on onehuman.ai. The assistant is answering; you can step in any time.'
    : d.what === 'lead' ? 'A visitor left an e-mail address in the chat.'
    : d.what === 'human' ? 'A visitor asked to talk to a person. The assistant told them a founder will reply in the chat.'
    : 'You took this chat over and the visitor wrote again.';
  const facts: [string, string][] = [['Page', d.page ?? '—'], ['Country', d.country ?? '—'], ['E-mail', d.email ?? 'not given yet']];
  return layout(ctx, subject, quote, [
    h1(d.what === 'lead' ? 'New lead from the chat' : d.what === 'new' ? 'New chat' : 'The chat needs you'),
    p(lead),
    note(`“${esc(d.detail.slice(0, 600))}”`),
    list(facts),
    button('Open the chat', d.link),
    p('Reply in the chat window there: the assistant goes quiet while you are in, and you can hand the chat back to it.'),
  ], 'You are getting this because you answer the chat on onehuman.ai.');
}

/** an account's plan needs the owner: close to or past Free's limit, a balance low or used up, watch-only from today */
export function planNoticeMail(ctx: MailContext, d: { kind: 'near' | 'limit' | 'low' | 'empty' | 'observe'; plan: string; used: number; included: number | null; balanceCents: number; observeFrom?: number | null; link: string }): Mail {
  const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
  const on = d.observeFrom ? new Date(d.observeFrom).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' }) : 'in 14 days';
  const subject = d.kind === 'near' ? `${d.used} of your ${d.included} free agent-active customers this month`
    : d.kind === 'limit' ? 'Your free plan reached its limit this month'
    : d.kind === 'low' ? `Your OneHuman balance is low (${usd(d.balanceCents)})`
    : d.kind === 'empty' ? 'Your OneHuman balance is used up'
    : 'OneHuman is watching only until your plan covers this month';
  const lead = d.kind === 'near' ? `This month ${d.used} of your signed-in customers used an AI agent in your app. The free plan covers ${d.included}.`
    : d.kind === 'limit' ? `This month more than ${d.included} of your signed-in customers used an AI agent in your app, past what the free plan covers.`
    : d.kind === 'low' ? `Your prepaid balance is ${usd(d.balanceCents)}. Each agent-active customer past the first ${d.included} this month takes $0.50 from it.`
    : d.kind === 'empty' ? 'Your prepaid balance ran out, so new agent-active customers this month are not covered.'
    : 'The grace period ended. OneHuman keeps watching and recording every AI agent, and no longer hides data, asks for passkeys or blocks.';
  const what = d.kind === 'near' ? 'Nothing changes yet. Past the limit you have 14 days of full protection to choose a plan.'
    : d.kind === 'observe' ? 'Your app keeps working exactly as before. Protection comes back the moment a plan or a top-up covers this month, or when the next month starts.'
    : `Your servers keep protecting in full until ${on}. If the month is not covered by then, OneHuman switches to watch-only: it records what agents do but stops enforcing. Your app is never affected.`;
  return layout(ctx, subject, lead, [
    h1(d.kind === 'near' ? 'Close to the free limit' : d.kind === 'limit' ? 'Free limit reached' : d.kind === 'low' ? 'Balance running low' : d.kind === 'empty' ? 'Balance used up' : 'Watching only'),
    p(lead),
    p(what),
    button(d.kind === 'low' || d.kind === 'empty' ? 'Top up' : 'See plans', d.link),
    p('Questions about plans or invoices: reply to this e-mail.'),
  ], 'You are getting this because you own a OneHuman account.');
}

/** a short note to the team: who, what, and a link */
export function teamNoticeMail(ctx: MailContext, d: { subject: string; lines: [string, string][]; link: string }): Mail {
  return layout(ctx, d.subject, d.subject, [h1(d.subject), list(d.lines), button('Open the admin panel', d.link)], 'You are getting this because you run OneHuman.');
}

export type MailKind = 'welcome' | 'setup_nudge' | 'setup_help' | 'connected' | 'first_agent' | 'weekly' | 'report_ready';
export const MAIL_KINDS: MailKind[] = ['welcome', 'setup_nudge', 'setup_help', 'connected', 'first_agent', 'weekly', 'report_ready'];

/** the full map of a public repository scan, sent to the address that unlocked it */
export function scanMapMail(ctx: MailContext, d: { repo: string; findings: { kind: string; title: string; why: string; method: string; path: string; file: string; line: number }[]; routes: number; filesScanned: number; frameworks: string[]; link: string }): Mail {
  const n = d.findings.length;
  const subject = `${d.repo}: ${n} thing${n === 1 ? '' : 's'} an AI agent can do as your customer`;
  return layout(ctx, subject, `The map of what an AI agent could pull out, move or leave behind in ${d.repo}.`, [
    h1(`What an AI agent can do in ${d.repo}`),
    p(`We read ${fmt(d.filesScanned)} files (${esc(d.frameworks.join(', ') || 'no known framework')}) and found ${fmt(d.routes)} entry points. Nothing was run, and the code was not kept. These are the ${n} that matter most: a customer's AI agent works in their signed-in session, so the server sees the customer.`),
    ...d.findings.flatMap((f, i) => [
      h2(`${i + 1}. ${f.title}`),
      p(esc(f.why)),
      note(`${code(`${f.method} ${f.path}`)}<br>${esc(f.file)}:${f.line}`),
    ]),
    h2('What to do about it'),
    steps([
      ['Hide or confirm', `${code('npx onehumanai init')} proposes a rule for each of these: open, details hidden, the owner's passkey, or refused.`],
      ['Watch first', 'It starts in watch-only mode: nothing is blocked while you see what agents really do.'],
    ]),
    button('Want help going live? Book 15 min', CAL),
    p(`Or run the same scan on your own machine: ${code('npx onehumanai scan')}.`),
    sign(),
  ], `You are getting this because you asked for the full map of ${d.repo} on onehuman.ai.`);
}

/** the team hears that a scan was unlocked with an e-mail address: an inbound lead */
export function scanLeadMail(ctx: MailContext, d: { email: string; repo: string; findings: { title: string }[]; link: string; country: string | null }): Mail {
  return layout(ctx, `Inbound lead: ${d.email} scanned ${d.repo}`, `${d.findings.length} findings. Reply today.`, [
    h1('Inbound lead from the repo scan'),
    p('Someone scanned a public repository on onehuman.ai/scan and left a work e-mail address to see the full map. They have already been sent the map with the 15-minute link. A short personal reply the same day is the next step.'),
    list([['E-mail', d.email], ['Repository', d.repo], ['Country', d.country ?? '—'], ['Top findings', d.findings.slice(0, 3).map((f) => f.title).join(' · ') || '—']]),
    button('Open the repository', d.link),
  ], 'You are getting this because you answer inbound leads on onehuman.ai.');
}
