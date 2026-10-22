// SPDX-License-Identifier: Apache-2.0
/**
 * The report as one printable HTML page (print → PDF). Self-contained: no scripts, no requests, fonts from the
 * system. Every section renders an empty state, so an empty report is the template a design partner sees first.
 */
import type { Report } from './build.ts';

const LOGO = '<svg viewBox="0 0 436.59 72" height="22" fill="#0b0c0f" role="img" aria-label="OneHuman"><path d="M72 72L53.6 40.31C49.22 45.04 42.95 48 36 48C29.05 48 22.78 45.04 18.4 40.31L0 72L72 72"/><path d="M53.6 40.31C57.57 36.03 60 30.3 60 24C60 10.75 49.25 0 36 0C22.74 0 12 10.75 12 24C12 30.3 14.43 36.03 18.4 40.31L36 10L53.6 40.31"/><path d="M101.36 36C101.36 39.49 102.34 42.2 104.3 44.14C106.27 46.07 109.04 47.04 112.61 47.04C116.13 47.04 118.87 46.07 120.85 44.14C122.83 42.2 123.82 39.49 123.82 36C123.82 32.48 122.84 29.76 120.88 27.84C118.91 25.92 116.16 24.96 112.61 24.96C109.07 24.96 106.31 25.93 104.33 27.86C102.35 29.8 101.36 32.51 101.36 36ZM92.59 36C92.59 32.29 93.4 29.09 95.03 26.4C96.66 23.71 98.98 21.64 101.98 20.18C104.98 18.73 108.54 18 112.66 18C116.78 18 120.33 18.73 123.3 20.18C126.27 21.64 128.56 23.71 130.17 26.4C131.78 29.09 132.59 32.29 132.59 36C132.59 39.71 131.77 42.91 130.15 45.6C128.52 48.29 126.2 50.36 123.2 51.82C120.2 53.27 116.64 54 112.52 54C108.43 54 104.89 53.27 101.91 51.82C98.92 50.36 96.62 48.29 95.01 45.6C93.4 42.91 92.59 39.71 92.59 36"/><path d="M140.16 18.86L147.77 18.86L166.79 41.76L166.79 18.86L174.84 18.86L174.84 53.14L167.22 53.14L148.21 30.19L148.21 53.14L140.16 53.14L140.16 18.86"/><path d="M184.04 18.86L213.07 18.86L213.07 25.3L192.37 25.3L192.37 32.45L212.06 32.45L212.06 38.83L192.37 38.83L192.37 46.7L214.17 46.7L213.26 53.14L184.04 53.14L184.04 18.86"/><path d="M247.46 39.07L229.74 39.07L229.74 53.14L221.31 53.14L221.31 18.86L229.74 18.86L229.74 31.82L247.46 31.82L247.46 18.86L255.89 18.86L255.89 53.14L247.46 53.14L247.46 39.07"/><path d="M264.71 38.54L264.71 18.86L273.14 18.86L273.14 39.12C273.14 41.84 273.84 43.84 275.22 45.12C276.61 46.4 278.79 47.04 281.76 47.04C284.7 47.04 286.87 46.4 288.25 45.12C289.64 43.84 290.34 41.84 290.34 39.12L290.34 18.86L298.77 18.86L298.77 38.54C298.77 43.92 297.32 47.84 294.41 50.3C291.5 52.77 287.29 54 281.76 54C276.21 54 271.97 52.77 269.07 50.3C266.16 47.84 264.71 43.92 264.71 38.54"/><path d="M307.58 18.86L317.31 18.86L328.95 44.06L340.54 18.86L350.03 18.86L350.03 53.14L342.17 53.14L342.17 30.48L331.92 53.14L325.55 53.14L315.3 30.53L315.3 53.14L307.58 53.14L307.58 18.86"/><path d="M375.85 25.63L370.05 39.41L381.69 39.41L375.85 25.63ZM364.4 53.14L355.73 53.14L371.15 18.86L380.83 18.86L396.25 53.14L387.34 53.14L384.18 45.84L367.42 45.84L364.4 53.14"/><path d="M401.91 18.86L409.52 18.86L428.54 41.76L428.54 18.86L436.59 18.86L436.59 53.14L428.97 53.14L409.95 30.19L409.95 53.14L401.91 53.14L401.91 18.86"/></svg>';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const fmt = (n: number) => n.toLocaleString('en-US');
const date = (t: number) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const pct = (n: number, of: number) => (of ? `${(Math.round((n / of) * 1000) / 10).toLocaleString('en-US')}%` : '—');
const empty = (what: string) => `<p class="empty">${esc(what)}</p>`;

function chart(r: Report): string {
  const d = r.daily;
  if (!d.some((x) => x.sessions)) return empty('Sessions per day appear here once there is traffic.');
  const W = 680, H = 150, max = Math.max(...d.map((x) => x.sessions), 1), bw = W / d.length;
  const bars = d.map((x, i) => {
    const h = (x.sessions / max) * (H - 20), ha = (x.agentSessions / max) * (H - 20);
    return `<rect x="${(i * bw + 1).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${h.toFixed(1)}" fill="#d9dde3"/>`
      + (ha ? `<rect x="${(i * bw + 1).toFixed(1)}" y="${(H - ha).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${ha.toFixed(1)}" fill="#c2700a"/>` : '');
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H + 18}" width="100%" role="img" aria-label="Sessions per day, with the sessions that had an AI agent">${bars}<text x="0" y="${H + 14}" font-size="10" fill="#6b7280">${esc(date(d[0]!.day))}</text><text x="${W}" y="${H + 14}" font-size="10" fill="#6b7280" text-anchor="end">${esc(date(d[d.length - 1]!.day))}</text></svg>
  <p class="legend"><i style="background:#d9dde3"></i>all sessions <i style="background:#c2700a"></i>sessions with an AI agent</p>`;
}

export function renderReportHtml(r: Report, opts: { title?: string } = {}): string {
  const would = r.mode === 'enforce' ? '' : 'would have been ';
  const stopped = r.agentRequests.wouldBlock + r.agentRequests.wouldMask + r.agentRequests.wouldStepUp;
  const modeLine = r.mode === 'observe' ? 'Observe mode: nothing was blocked. The figures show what the rules would have done in protect mode.'
    : r.mode === 'enforce' ? 'Protect mode: the rules were applied.' : r.mode === 'mixed' ? 'Part of the period in observe mode, part in protect mode.' : 'No traffic yet.';
  // page one opens with the one number a partner did not know: how many of their customers' sessions had an agent
  const a = r.agentRequests;
  const shock = r.sessions.withAgent
    ? `<section class="shock"><p class="big">AI agents were inside <b>${fmt(r.sessions.withAgent)}</b> of your customers' sessions <span>(${pct(r.sessions.withAgent, r.sessions.total)} of ${fmt(r.sessions.total)})</span>.</p>
<p>${r.agents.length ? `${fmt(r.agents.length)} agent product${r.agents.length === 1 ? '' : 's'}: ${esc(r.agents.slice(0, 4).map((x) => x.name).join(', '))}${r.agents.length > 4 ? ' and more' : ''}. ` : ''}They asked for ${fmt(a.total)} protected action${a.total === 1 ? '' : 's'}; your rules ${r.mode === 'enforce' ? 'hid' : 'would have hidden'} private data ${fmt(a.wouldMask)} time${a.wouldMask === 1 ? '' : 's'}, sent ${fmt(a.wouldStepUp)} to the account owner for approval and kept ${fmt(a.wouldBlock)} closed.</p></section>`
    : `<section class="shock none"><p class="big">No AI agent seen in these ${r.period.days} days.</p><p>When one arrives, this line says how many of your customers' sessions it was in and what it asked for.</p></section>`;
  const agentRows = r.agents.length
    ? `<table><tr><th>AI agent</th><th class="n">Sessions</th><th class="n">Requests</th></tr>${r.agents.map((a) => `<tr><td>${esc(a.name)}</td><td class="n">${fmt(a.sessions)}</td><td class="n">${fmt(a.requests)}</td></tr>`).join('')}</table>`
    : empty('No AI agent seen yet. Each one appears here by product name, with how many sessions it was in.');
  const epRows = r.endpoints.length
    ? `<table><tr><th>Endpoint</th><th class="n">All requests</th><th class="n">By an agent</th><th class="n">${r.mode === 'enforce' ? 'Refused' : 'Would refuse'}</th><th class="n">${r.mode === 'enforce' ? 'Hidden' : 'Would hide'}</th><th class="n">${r.mode === 'enforce' ? 'Passkey asked' : 'Would ask passkey'}</th></tr>${r.endpoints.slice(0, 25).map((e) => `<tr><td><code>${esc(e.resource)}</code></td><td class="n">${fmt(e.requests)}</td><td class="n">${fmt(e.agentRequests)}</td><td class="n">${fmt(e.wouldBlock)}</td><td class="n">${fmt(e.wouldMask)}</td><td class="n">${fmt(e.wouldStepUp)}</td></tr>`).join('')}</table>`
    : empty('No protected endpoint has been called yet. Each one appears here with what agents asked of it and what the rules decided.');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(opts.title ?? `OneHuman report — ${r.period.days} days`)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root{--fg:#0b0c0f;--fg2:#4b5563;--fg3:#6b7280;--line:#e5e7eb;--accent:#0f9d6a;--amber:#c2700a}
  *{box-sizing:border-box}body{margin:0;background:#f3f4f6;color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif}
  .page{max-width:820px;margin:24px auto;background:#fff;padding:40px 48px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
  header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;border-bottom:1px solid var(--line);padding-bottom:18px;margin-bottom:22px}
  header .meta{text-align:right;color:var(--fg3);font-size:12.5px;white-space:nowrap}
  h1{font-size:24px;letter-spacing:-.02em;margin:18px 0 4px}h2{font-size:15px;margin:30px 0 10px;letter-spacing:-.01em}
  .mode{display:inline-block;font-size:12px;line-height:1.45;padding:5px 10px;border-radius:8px;max-width:520px;background:#ecfdf5;color:var(--accent);border:1px solid #a7f3d0}
  .shock{border:1px solid #f1d9b0;background:#fff8ec;border-radius:12px;padding:18px 20px;margin:4px 0 8px}.shock.none{border-color:var(--line);background:#fafafa}
  .shock p{margin:0;color:var(--fg2);font-size:13.5px}.shock .big{font-size:20px;line-height:1.35;letter-spacing:-.015em;color:var(--fg);margin-bottom:6px}.shock .big b{color:var(--amber)}.shock .big span{color:var(--fg3);font-size:15px}
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:18px 0 6px}.kpi{border:1px solid var(--line);border-radius:10px;padding:12px 14px}
  .kpi b{display:block;font-size:24px;letter-spacing:-.02em;font-variant-numeric:tabular-nums}.kpi span{color:var(--fg2);font-size:12.5px;line-height:1.35;display:block}
  table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line)}th{color:var(--fg3);font-weight:500;font-size:12px}
  .n{text-align:right;font-variant-numeric:tabular-nums}code{font:12.5px ui-monospace,Menlo,monospace}
  .notes li{margin:5px 0}.empty{color:var(--fg3);font-style:italic;border:1px dashed var(--line);border-radius:8px;padding:12px 14px;margin:0}
  .legend{color:var(--fg3);font-size:12px;margin:4px 0 0}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin:0 5px 0 12px;vertical-align:-1px}.legend i:first-child{margin-left:0}
  .people{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.fine{color:var(--fg3);font-size:12px}
  footer{margin-top:30px;padding-top:14px;border-top:1px solid var(--line);color:var(--fg3);font-size:11.5px}
  @media (max-width:680px){.page{margin:0;padding:22px 18px;border-radius:0}header{flex-direction:column}header .meta{text-align:left;white-space:normal}.kpis{grid-template-columns:1fr 1fr}.people{grid-template-columns:1fr}table{font-size:12px}th,td{padding:6px 4px}}
  @media print{body{background:#fff}.page{box-shadow:none;margin:0;max-width:none;padding:0}h2{break-after:avoid}table,.kpis,.people{break-inside:avoid}}
</style></head><body><div class="page">
<header><div>${LOGO}<h1>${r.period.days}-day report${r.app ? ` — ${esc(r.app)}` : ''}</h1><span class="mode">${esc(modeLine)}</span></div>
<div class="meta">${esc(date(r.period.from))} – ${esc(date(r.period.to))}<br>generated ${esc(date(r.generated))}<br>from ${r.source === 'server' ? 'your server’s audit log' : 'the OneHuman portal'}</div></header>

${shock}

<div class="kpis">
  <div class="kpi"><b>${fmt(r.sessions.total)}</b><span>sessions on protected endpoints</span></div>
  <div class="kpi"><b>${pct(r.sessions.withAgent, r.sessions.total)}</b><span>had an AI agent in them (${fmt(r.sessions.withAgent)})</span></div>
  <div class="kpi"><b>${fmt(stopped)}</b><span>agent requests ${would}refused, hidden or sent to a passkey</span></div>
  <div class="kpi"><b>${fmt(r.people.wouldBeStopped)}</b><span>requests by people ${would}refused</span></div>
</div>

<h2>What we noticed</h2>
<ul class="notes">${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>

<h2>Sessions per day</h2>
${chart(r)}

<h2>Which AI agents</h2>
${agentRows}

<h2>Which endpoints they touched, and what the rules ${r.mode === 'enforce' ? 'did' : 'would have done'}</h2>
${epRows}

<h2>Effect on real people</h2>
${r.people.decisions ? `<div class="people">
  <div class="kpi"><b>${fmt(r.people.sessions)}</b><span>sessions by people only</span></div>
  <div class="kpi"><b>${fmt(r.people.askedPasskey)}</b><span>times a person ${r.mode === 'enforce' ? 'was' : 'would have been'} asked for a passkey</span></div>
  <div class="kpi"><b>${fmt(r.people.wouldBeStopped)}</b><span>requests by a person ${would}refused</span></div>
</div>` : empty('How many real people were asked for a passkey or refused appears here — the number to keep at zero.')}

<h2>Evidence</h2>
${r.decisions.total ? `<p>${fmt(r.decisions.signed)} of ${fmt(r.decisions.total)} decisions carry a signed proof (Ed25519), made on ${r.source === 'server' ? 'this' : 'your'} server. An auditor checks them without trusting OneHuman: export the proofs, then run <code>npx onehumanai verify-proof proofs.json --keys https://&lt;your-site&gt;/onehuman/proof-keys</code>.</p>` : empty('The number of signed decisions, and how an auditor checks them, appears here.')}

<footer>Agent sessions: a session in which OneHuman saw an AI agent act, or an agent tool attached. "${r.mode === 'enforce' ? 'Refused' : 'Would refuse'}" counts what the rules chose for each request. Method and known limits: https://onehuman.ai/measurements · Generated by OneHuman from ${r.source === 'server' ? 'the local audit log; nothing was sent anywhere to make it' : 'the decision metadata your server reported'}.</footer>
<p class="cta" style="margin:14px 0 0;font-size:13px">Want help going live? <a href="https://cal.com/onehumanai" style="color:inherit">Book 15 min: cal.com/onehumanai</a></p>
</div></body></html>`;
}
