// SPDX-License-Identifier: BUSL-1.1
/* OneHuman portal: workspace with Overview, API Keys, Activity, Integration, Settings. */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Calls go through OneHuman's own page script (onehuman.ai protects its portal with OneHuman): the click that
  // caused a call travels with it, so a person is told apart from an AI agent operating this session.
  let maskedNoted = false;
  const api = async (path, opts = {}) => {
    const f = (window.OneHuman && window.OneHuman.fetch) || fetch;
    const r = await f(path, { credentials: 'same-origin', ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d.message || d.error || String(r.status)), { status: r.status, data: d });
    if (d && d._masked && !maskedNoted) { maskedNoted = true; setTimeout(() => toast('An AI agent is in this session: secrets are hidden'), 0); }
    return d;
  };
  const MASK = '••••';
  // ---------------------------------------------------------------- theme
  const applyTheme = (t) => { document.documentElement.dataset.theme = t === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : t; $$('#theme button').forEach((b) => b.classList.toggle('on', b.dataset.themeSet === t)); };
  let theme = 'system'; try { theme = localStorage.getItem('oh-theme') || 'system'; } catch {}
  applyTheme(theme);
  $$('#theme button').forEach((b) => b.addEventListener('click', () => { theme = b.dataset.themeSet; try { localStorage.setItem('oh-theme', theme); } catch {} applyTheme(theme); if (currentView() === 'activity') loadStats(); }));
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (theme === 'system') { applyTheme('system'); if (currentView() === 'activity') loadStats(); } });
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  let toastT; const toast = (m) => { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1800); };
  // Every confirmation and every rename happens in the portal's own dialog: the browser's prompt()
  // and confirm() look like a different product and cannot be styled or typed into by a screen reader
  // in the same way. Resolves to the typed value, true, or null when the person backs out.
  function ask({ title, body = '', hint = '', label = '', value = '', ok = 'Confirm', danger = false, password = false, list = null }) {
    const el = $('#ask');
    $('#ask-title').textContent = title;
    $('#ask-body').textContent = body; $('#ask-body').hidden = !body;
    $('#ask-hint').textContent = hint; $('#ask-hint').hidden = !hint;
    $('#ask-label').hidden = !label; $('#ask-label-text').textContent = label; $('#ask-input').value = value;
    $('#ask-input').type = password ? 'password' : 'text'; $('#ask-input').maxLength = password ? 200 : 80; $('#ask-input').autocomplete = password ? 'current-password' : 'off';
    $('#ask-list').innerHTML = (list || []).map((x) => `<li>${esc(x)}</li>`).join(''); $('#ask-list').hidden = !(list && list.length);
    const btn = $('#ask-ok'); btn.textContent = ok; btn.classList.toggle('danger', danger);
    el.hidden = false;
    setTimeout(() => (label ? $('#ask-input') : btn).focus(), 50);
    return new Promise((resolve) => {
      const done = (v) => { el.hidden = true; $('#ask-input').value = ''; btn.onclick = null; $('#ask-cancel').onclick = null; el.onclick = null; removeEventListener('keydown', key); resolve(v); };
      const key = (e) => { if (e.key === 'Escape') done(null); if (e.key === 'Enter' && label) { e.preventDefault(); accept(); } };
      const accept = () => { const v = label ? (password ? $('#ask-input').value : $('#ask-input').value.trim()) : true; done(label && !v ? null : v); };
      btn.onclick = accept;
      $('#ask-cancel').onclick = () => done(null);
      el.onclick = (e) => { if (e.target === el) done(null); };
      addEventListener('keydown', key);
    });
  }

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]'); if (!b) return;
    const el = $(b.dataset.copy); if (!el) return;
    try { await navigator.clipboard.writeText(el.textContent); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1400); } catch { toast('Select the text and copy'); }
  });
  const ago = (t) => { if (!t) return 'never'; const s = Math.max(0, (Date.now() - t) / 1000); if (s < 60) return 'just now'; if (s < 3600) return `${Math.round(s / 60)} min ago`; if (s < 86400) return `${Math.round(s / 3600)} h ago`; const d = Math.round(s / 86400); return d === 1 ? 'yesterday' : `${d} days ago`; };
  const day = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const PALETTE = ['#7cf0c0', '#8ab4ff', '#ffb86b', '#ff7b7b', '#d7a6ff', '#f2f2f3'];
  const colorOf = (i) => PALETTE[i % PALETTE.length];

  // ------------------------------------------------------------------ auth
  let mode = 'signup';
  const setMode = (m) => {
    mode = m;
    $('#auth-title').textContent = m === 'signup' ? 'Start your free AI agent report' : 'Welcome back';
    $('#auth-lead').textContent = m === 'signup' ? 'See which AI agents log in as your customers. 30 days, nothing blocked, no card.' : 'Sign in to your OneHuman dashboard.';
    $('#auth-submit').textContent = m === 'signup' ? 'Start my free report' : 'Sign in';
    $('#switch-text').textContent = m === 'signup' ? 'Already have an account?' : 'New here?';
    $('#switch').textContent = m === 'signup' ? 'Sign in' : 'Create an account';
    $('#password').autocomplete = m === 'signup' ? 'new-password' : 'current-password';
    $('#auth-err').textContent = '';
  };
  $('#switch').addEventListener('click', (e) => { e.preventDefault(); setMode(mode === 'signup' ? 'login' : 'signup'); });
  // Firebase signs people in when the page names a project (onehuman.ai); otherwise this server checks the password
  const fbConfig = (() => { try { return JSON.parse(document.querySelector('meta[name="oh-firebase"]')?.content || 'null'); } catch { return null; } })();
  const fb = fbConfig && window.OneHumanAuth ? window.OneHumanAuth.start(fbConfig) : null;
  const source = () => new URLSearchParams(location.search).get('start') || 'portal';
  /** the Firebase ID token becomes a portal session */
  const openSession = async (idToken) => { await api('/api/v1/portal/session', { method: 'POST', body: JSON.stringify({ idToken, source: source() }) }); await boot(); };
  const authError = (err) => { if (!err.quiet) $('#auth-err').textContent = err.message; };
  if (fb) {
    $('#auth-alt').hidden = false;
    $('#auth-google').addEventListener('click', async () => {
      const b = $('#auth-google'); b.disabled = true; $('#auth-err').textContent = '';
      try { await openSession(await fb.google()); } catch (err) { authError(err); } finally { b.disabled = false; }
    });
    $('#auth-forgot').addEventListener('click', async (e) => {
      e.preventDefault();
      const email = $('#email').value.trim();
      if (!email) { $('#auth-err').textContent = 'Enter your e-mail above, then press "Forgot your password?" again.'; $('#email').focus(); return; }
      try { await fb.reset(email); $('#auth-err').textContent = ''; toast('If that address has an account, a reset link is on its way'); } catch (err) { authError(err); }
    });
  }
  const syncForgot = () => { $('#auth-forgot-row').hidden = !fb || mode !== 'login'; };
  $('#switch').addEventListener('click', syncForgot);
  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault(); const b = $('#auth-submit'); b.disabled = true; $('#auth-err').textContent = '';
    const email = $('#email').value.trim(), password = $('#password').value;
    try {
      if (fb) {
        if (mode === 'signup' && password.length < 8) throw new Error('Use at least 8 characters.');
        await openSession(await (mode === 'signup' ? fb.signup(email, password) : fb.login(email, password)));
      } else {
        await api(`/api/v1/portal/${mode}`, { method: 'POST', body: JSON.stringify({ email, password, ...(mode === 'signup' ? { source: source() } : {}) }) }); await boot();
      }
    } catch (err) { authError(err); } finally { b.disabled = false; }
  });
  // sidebar: collapse on desktop, slide in on phones; the user menu (theme, links, sign out) opens from the footer
  $('#side-toggle').addEventListener('click', () => { if (matchMedia('(max-width: 900px)').matches) document.body.classList.toggle('side-open'); else { document.body.classList.toggle('side-collapsed'); try { localStorage.setItem('oh-side', document.body.classList.contains('side-collapsed') ? 'collapsed' : ''); } catch {} } });
  try { if (localStorage.getItem('oh-side') === 'collapsed') document.body.classList.add('side-collapsed'); } catch {}
  $('#side-scrim').addEventListener('click', () => document.body.classList.remove('side-open'));
  $('#user-more').addEventListener('click', (e) => { e.stopPropagation(); $('#user-menu').hidden = !$('#user-menu').hidden; });
  document.addEventListener('click', (e) => { if (!$('#user-menu').hidden && !$('#user-menu').contains(e.target)) $('#user-menu').hidden = true; });
  $('#logout').addEventListener('click', async (e) => { e.preventDefault(); await api('/api/v1/portal/logout', { method: 'POST', body: '{}' }).catch(() => {}); location.hash = ''; location.reload(); });

  // ------------------------------------------------------------------ state + routing
  let me = null, keyId = null, range = '7d', ovRange = '7d', timer = 0, overview = null;
  const liveKeys = () => (me?.keys || []).filter((k) => !k.revoked);
  /** keys this account owns (the rest were shared with it: their statistics, and the rules when the owner said so) */
  const ownKeys = () => liveKeys().filter((k) => k.role === 'owner');
  /** keys whose rules this account manages: its own, and those shared with it as an editor */
  const ruleKeys = () => liveKeys().filter((k) => k.role === 'owner' || k.role === 'editor');
  const sharedAs = (k) => (k.role === 'editor' ? 'can manage rules' : 'view only');
  const keyLabel = (k) => `${k.name} · ${k.role !== 'owner' ? `shared by ${k.owner}` : `${k.prefix}…`}`;
  const keyName = (id) => (me?.keys || []).find((k) => k.id === id)?.name || 'key';
  function show(view) {
    // #report (the link in the 30-day mail) is the weekly view with the report on top
    const reportLink = view === 'report'; if (reportLink) view = 'weekly';
    $('#report-ready').hidden = !reportLink && !me?.trial?.ready;
    $$('.view').forEach((v) => { v.hidden = v.id !== `view-${view}`; });
    $$('.side-nav a[data-view]').forEach((a) => a.classList.toggle('on', a.dataset.view === view));
    $('#search-wrap').hidden = view !== 'keys' && view !== 'activity';
    // the page's title lives in the top bar; the view keeps its one-line description
    const h = $(`#view-${view} .page-head h1`); $('#top-title').textContent = h ? h.textContent : 'Overview';
    document.body.classList.remove('side-open');
    clearTimeout(timer);
    if (view === 'overview') loadOverview();
    if (view === 'keys') { renderKeyTable(); if (!overview) loadOverview().then(renderKeyTable).catch(() => {}); }
    if (view === 'activity') { renderKeyChips(); loadStats(); }
    if (view === 'integrate') renderIntegration();
    if (view === 'settings') renderSettings();
    if (view === 'weekly') renderWeekly();
    if (view === 'agents') renderAgents();
    if (view === 'policy') renderPolicy();
    if (view === 'plan') renderPlan();
  }
  const currentView = () => (location.hash.replace('#', '') || 'overview');
  addEventListener('hashchange', () => { if (me) show(currentView()); });
  $$('#range-ov button').forEach((b) => b.addEventListener('click', () => { ovRange = b.dataset.r; $('#usage-title').textContent = { '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days' }[ovRange]; $$('#range-ov button').forEach((x) => x.classList.toggle('on', x === b)); loadOverview(); }));
  $$('#range button').forEach((b) => b.addEventListener('click', () => { range = b.dataset.r; $$('#range button').forEach((x) => x.classList.toggle('on', x === b)); loadStats(); }));
  $('#banner-x').onclick = () => { $('#banner').hidden = true; try { localStorage.setItem('oh-portal-banner', '1'); } catch {} };
  try { if (localStorage.getItem('oh-portal-banner')) $('#banner').hidden = true; } catch {}
  $('#search').addEventListener('input', () => { const v = currentView(); if (v === 'keys') { $('#key-search').value = $('#search').value; renderKeyTable(); } if (v === 'activity') filterLog($('#search').value); });
  addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); ($('#search-wrap').hidden ? $('#key-search') : $('#search')).focus(); } });

  // ------------------------------------------------------------------ overview
  // ---------------------------------------------------------------- charts: the NanoTarget dashboard's shadcn
  // (recharts) area chart, drawn as SVG: stacked series on a smooth curve, gradient fills, horizontal grid lines,
  // dates underneath, a legend of small squares and a tooltip that follows the pointer.
  /** monotone cubic through the points (no overshoot below zero), as an SVG path */
  function smoothPath(pts, cont = false) {
    const n = pts.length; if (!n) return '';
    let d = `${cont ? 'L' : 'M'}${pts[0][0]},${pts[0][1]}`; if (n < 2) return d;
    const dx = [], m = [], t = [];
    for (let i = 0; i < n - 1; i++) { dx[i] = pts[i + 1][0] - pts[i][0]; m[i] = dx[i] ? (pts[i + 1][1] - pts[i][1]) / dx[i] : 0; }
    t[0] = m[0]; t[n - 1] = m[n - 2];
    for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (!m[i]) { t[i] = 0; t[i + 1] = 0; continue; }
      const a = t[i] / m[i], b = t[i + 1] / m[i], h = a * a + b * b;
      if (h > 9) { const k = 3 / Math.sqrt(h); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
    }
    for (let i = 0; i < n - 1; i++) { const h = dx[i] / 3; d += `C${pts[i][0] + h},${pts[i][1] + t[i] * h} ${pts[i + 1][0] - h},${pts[i + 1][1] - t[i + 1] * h} ${pts[i + 1][0]},${pts[i + 1][1]}`; }
    return d;
  }
  const fmtBucket = (t, rangeKey) => rangeKey === '24h' ? `${String(new Date(t).getHours()).padStart(2, '0')}:00` : new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  /** who a decision was for, as stacked layers: people at the bottom, then AI agents let through, then what was limited */
  const DECISION_SERIES = [
    { label: 'People', color: 'var(--bluelight)', value: (b) => Math.max(0, b.n - b.agent) },
    { label: 'AI agent', color: 'var(--accent2)', value: (b) => Math.max(0, b.agent - b.gated) },
    { label: 'Limited or stopped', color: 'var(--accent)', value: (b) => b.gated },
  ];
  function areaChart(el, buckets, series, fmtX) {
    el._chart = [buckets, series, fmtX];
    const W = Math.max(280, el.clientWidth || 600), H = 250, pt = 10, pb = 26, px = 4;
    const n = buckets.length, X = (i) => px + (n <= 1 ? (W - 2 * px) / 2 : (W - 2 * px) * i / (n - 1));
    const stacks = buckets.map((b) => { let acc = 0; return series.map((s) => { const lo = acc; acc += Math.max(0, s.value(b) || 0); return [lo, acc]; }); });
    const max = Math.max(1, ...stacks.map((st) => (st.length ? st[st.length - 1][1] : 0))) * 1.12;
    const Y = (v) => pt + (H - pt - pb) * (1 - v / max);
    const id = el.id || 'c';
    const grads = series.map((s, i) => `<linearGradient id="g-${id}-${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" style="stop-color:${s.color};stop-opacity:.8"/><stop offset="95%" style="stop-color:${s.color};stop-opacity:.1"/></linearGradient>`).join('');
    const grid = [0, 1, 2, 3].map((g) => { const y = pt + (H - pt - pb) * g / 3; return `<line x1="0" x2="${W}" y1="${y}" y2="${y}" class="ch-grid"/>`; }).join('');
    const layers = series.map((s, i) => {
      const top = buckets.map((_, k) => [X(k), Y(stacks[k][i][1])]), bot = buckets.map((_, k) => [X(k), Y(stacks[k][i][0])]).reverse();
      return `<path d="${smoothPath(top)}${smoothPath(bot, true)}Z" style="fill:url(#g-${id}-${i})"/><path d="${smoothPath(top)}" class="ch-line" style="stroke:${s.color}"/>`;
    }).join('');
    const step = Math.max(1, Math.ceil(64 / ((W - 2 * px) / Math.max(1, n))));
    let prev = null;
    const ticks = buckets.map((b, k) => { const l = fmtX(b.t); if (k % step || l === prev) return ''; prev = l; return `<text x="${X(k)}" y="${H - 6}" text-anchor="${k === 0 ? 'start' : k === n - 1 ? 'end' : 'middle'}" class="ch-tick">${esc(l)}</text>`; }).join('');
    el.innerHTML = `<svg class="ch-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Chart"><defs>${grads}</defs>${grid}${layers}${ticks}<line class="ch-cursor" x1="0" x2="0" y1="${pt}" y2="${H - pb}" visibility="hidden"/><rect class="ch-hit" x="0" y="0" width="${W}" height="${H - pb}"/></svg>`
      + `<div class="ch-legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join('')}</div><div class="ch-tip" hidden></div>`;
    const svg = el.querySelector('svg'), cur = el.querySelector('.ch-cursor'), tip = el.querySelector('.ch-tip');
    const hide = () => { cur.setAttribute('visibility', 'hidden'); tip.hidden = true; };
    el.querySelector('.ch-hit').addEventListener('mouseleave', hide);
    el.querySelector('.ch-hit').addEventListener('mousemove', (e) => {
      const r = svg.getBoundingClientRect(), xs = (e.clientX - r.left) * W / r.width;
      const k = Math.max(0, Math.min(n - 1, Math.round(n <= 1 ? 0 : (xs - px) / ((W - 2 * px) / (n - 1)))));
      const b = buckets[k]; if (!b) return hide();
      cur.setAttribute('x1', X(k)); cur.setAttribute('x2', X(k)); cur.setAttribute('visibility', 'visible');
      tip.innerHTML = `<b>${esc(fmtX(b.t))}</b>${series.map((s) => `<div><i style="background:${s.color}"></i><span>${esc(s.label)}</span><em>${(s.value(b) || 0).toLocaleString()}</em></div>`).join('')}`;
      tip.hidden = false;
      const left = X(k) * r.width / W; tip.style.left = `${Math.min(r.width - tip.offsetWidth - 4, Math.max(4, left + 12))}px`;
    });
    if (!el._ro && 'ResizeObserver' in window) { let w = el.clientWidth; el._ro = new ResizeObserver(() => { if (Math.abs(el.clientWidth - w) > 8 && el._chart) { w = el.clientWidth; areaChart(el, ...el._chart); } }); el._ro.observe(el); }
  }
  // alerts: what an AI agent changed in this account, raised by the portal's own OneHuman guard
  const TOOL_LABEL = (t) => (typeof toolName === 'function' ? toolName(t) : t);
  async function loadAlerts() {
    const box = $('#alerts');
    let d; try { d = await api('/api/v1/portal/alerts'); } catch { box.hidden = true; return; }
    const fresh = (d.alerts || []).filter((a) => !a.seen);
    if (!fresh.length) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = `<div class="al-head"><b>An AI agent was in this account</b><button class="btn" id="alerts-seen">Mark as seen</button></div><ul>${fresh.slice(0, 6).map((a) => `<li><span class="al-when">${esc(ago(a.at))}</span>${esc(a.tools.length ? a.tools.map(TOOL_LABEL).join(', ') : 'An AI agent')} ${esc(a.action)}</li>`).join('')}</ul><p class="fine">It was allowed, and nothing secret was shown to it. If this was not you, revoke the keys it touched and change your password.</p>`;
    $('#alerts-seen').onclick = async () => { try { await api('/api/v1/portal/alerts/seen', { method: 'POST', body: '{}' }); } catch {} box.hidden = true; };
  }

  // ---------------------------------------------------------------- the free 30-day report: where this account is
  const DAYMS = 864e5;
  const longDay = (t) => new Date(t).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  function renderTrial() {
    const el = $('#trial'), t = me?.trial; if (!el) return;
    if (!t) { el.hidden = true; return; }
    if (t.ready) $('#report-ready-sub').textContent = `What AI agents did in your app from ${longDay(t.connectedAt)} to ${longDay(t.reportUntil)}, and what OneHuman would have done about it. Open it, then save it as a PDF to forward.`;
    const keys = ownKeys().length;
    let html;
    if (t.ready) {
      html = `<div class="tr-main"><span class="tr-tag ok">Ready</span><h3>Your 30-day AI agent report is ready</h3><p>What AI agents did in your app from ${esc(longDay(t.connectedAt))} to ${esc(longDay(t.reportUntil))}, and what OneHuman would have done about it.</p></div>
        <div class="tr-actions"><a class="btn primary" href="#report">Open the report</a><a class="btn" href="#policy">Turn protection on</a><a class="btn ghost" href="https://cal.com/onehumanai" target="_blank" rel="noopener">Talk to us</a></div>`;
    } else if (t.connectedAt) {
      const pctDone = Math.round(Math.min(30, t.day) / 30 * 100);
      const agent = t.firstAgentAt ? `First AI agent seen on ${esc(longDay(t.firstAgentAt))}.` : 'No AI agent yet. We e-mail you when the first one shows up.';
      html = `<div class="tr-main"><span class="tr-tag">30-day AI agent report</span><h3>Day ${t.day} of 30</h3><p>${agent} Your report is ready on ${esc(longDay(t.reportUntil))}${t.emails && t.mail ? ', and we send it to you' : ''}.</p>
        <div class="tr-bar"><i style="width:${pctDone}%"></i></div></div>
        <div class="tr-actions"><a class="btn" href="#agents">AI agents so far</a><a class="btn ghost" href="#weekly">This week</a></div>`;
    } else {
      // before the app connects: a setup checklist, one row per step, the action only on the step that is next
      const n = keys ? 1 : 0;
      const steps = [
        ['Create an API key', 'One key per app.', '<button class="btn primary mint" id="trial-key">Create API key</button>'],
        ['Connect your app', 'Run <code>npx onehumanai init</code> and deploy. Nothing is blocked.', '<a class="btn primary" href="#integrate">Set it up</a>'],
        ['Get your report', 'Ready 30 days after your app connects.', ''],
      ];
      html = `<div class="ck-head"><div><h3>Get your free AI agent report</h3><p>${n} of 3 done</p></div><a class="ck-help" href="https://cal.com/onehumanai" target="_blank" rel="noopener">Set it up with us · 15 min</a></div>
        <div class="ck-bar"><i style="width:${Math.round(n / 3 * 100)}%"></i></div>
        <ol class="ck">${steps.map(([title, sub, act], i) => `<li class="${i < n ? 'done' : i === n ? 'now' : ''}"><i>${i < n ? '✓' : i + 1}</i><div><b>${title}</b><span>${sub}</span></div>${i === n ? act : ''}</li>`).join('')}</ol>`;
    }
    const setup = !t.ready && !t.connectedAt;
    el.classList.toggle('setup', setup);
    // the sidebar shows the same checklist in short until the app connects, then the agent share again
    const done = keys ? 1 : 0;
    $('#side-setup').hidden = !setup; $('#side-card').hidden = setup;
    $('#side-setup-ring').style.setProperty('--p', Math.round(done / 3 * 100));
    $('#side-setup-pct').textContent = `${Math.round(done / 3 * 100)}%`;
    $('#side-setup-sub').textContent = `${done} of 3 complete`;
    el.innerHTML = html; el.hidden = false;
    const b = $('#trial-key'); if (b) b.onclick = openModal;
  }

  async function loadOverview() {
    loadAlerts(); renderTrial();
    try { overview = await api(`/api/v1/portal/overview?range=${ovRange}`); } catch (e) { toast(e.message); return; }
    if (currentView() !== 'overview') return;   // keys view only needs the totals
    const { series, totals, range: rg, now } = overview;
    const buckets = []; for (let t = Math.floor(rg.since / rg.bucketMs) * rg.bucketMs; t <= now; t += rg.bucketMs) buckets.push({ t, n: 0, agent: 0, gated: 0 });
    for (const s of series) { const b = buckets.find((x) => x.t === s.t); if (b) { b.n += s.n; b.agent += s.agent; b.gated += s.gated; } }
    const totN = totals.reduce((a, b) => a + b.n, 0), totS = totals.reduce((a, b) => a + b.sessions, 0), totA = totals.reduce((a, b) => a + b.agentSessions, 0), totG = totals.reduce((a, b) => a + b.gated, 0);
    $('#u-decisions').textContent = totN.toLocaleString(); $('#u-agent').textContent = totS ? `${Math.round(totA / totS * 100)}%` : '0%'; $('#u-gated').textContent = totG.toLocaleString();
    // the sidebar card: the share of sessions with an AI agent in this range
    const share = totS ? Math.round(totA / totS * 100) : 0; $('#side-agent-pct').textContent = `${share}%`; $('#side-agent-bar').style.width = `${share}%`;
    $('#side-agent-sub').textContent = `${totA.toLocaleString()} of ${totS.toLocaleString()} sessions · ${{ '24h': 'last 24 hours', '7d': 'last 7 days', '30d': 'last 30 days' }[ovRange] ?? ovRange}`;
    $('#u-sessions').textContent = totS.toLocaleString();
    areaChart($('#ov-chart'), buckets, DECISION_SERIES, (t) => fmtBucket(t, ovRange));
    $('#ov-empty').hidden = totN > 0; $('#ov-chart').closest('.chart-card').classList.toggle('is-empty', !totN);
  }

  // ------------------------------------------------------------------ keys
  let pastedKeyId = null, showRevoked = false;
  function renderKeyTable() {
    const q = ($('#key-search').value || '').trim().toLowerCase();
    const totals = overview?.totals || [];
    const rows = (me.keys || []).filter((k) => showRevoked || !k.revoked)
      .filter((k) => (pastedKeyId ? k.id === pastedKeyId : !q || k.name.toLowerCase().includes(q) || k.prefix.toLowerCase().includes(q)));
    const now = Date.now();
    $('#key-rows').innerHTML = rows.length ? rows.map((k) => {
      const t = totals.find((x) => x.key === k.id) || { n: 0, sessions: 0, agentSessions: 0, gated: 0 };
      const pct = t.sessions ? Math.round(t.agentSessions / t.sessions * 100) : 0;
      const expired = k.expires && k.expires < now;
      const status = k.revoked ? '<span class="mode warn">revoked</span>'
        : expired ? '<span class="mode warn">expired</span>'
        : k.events ? '<span class="mode observe">reporting</span>' : '<span class="mode">no data yet</span>';
      return `<tr data-id="${esc(k.id)}"${k.revoked ? ' class="gone"' : ''}>
        <td><span class="kname">${esc(k.name)}</span><span class="kpre">${k.role !== 'owner' ? `<span class="shared">shared by ${esc(k.owner)} · ${sharedAs(k)}</span>` : `<span data-oh-sensitive="full">${esc(k.prefix)}…</span>`} · ${esc(k.env || 'production')} · last used ${ago(k.lastSeen)}${k.expires ? ` · ${expired ? 'expired ' + ago(k.expires) : 'expires ' + day(k.expires)}` : ''}</span></td>
        <td>${status}</td>
        <td>${k.events.toLocaleString()}</td>
        <td><div class="prog"><div class="lbl"><span class="muted">${t.agentSessions} of ${t.sessions} sessions</span><b>${pct}%</b></div><div class="track"><i style="width:${pct}%"></i></div></div></td>
        <td style="text-align:right"><button class="dots" data-menu="${esc(k.id)}" aria-label="Key actions">⋮</button></td></tr>`;
    }).join('') : `<tr><td colspan="5" class="empty-cell"><div class="empty-state flat">${emptyIcon('keys')}<h3>${q ? 'No keys match' : 'No API keys yet'}</h3><p>${q ? 'Try another name or prefix.' : 'One key per app. Its decisions show up in Activity.'}</p></div></td></tr>`;
    const dead = (me.keys || []).filter((k) => k.revoked).length;
    $('#key-count').innerHTML = `${rows.length} key${rows.length === 1 ? '' : 's'}${pastedKeyId ? ' · matched the key you pasted' : ''}`
      + (dead ? ` · <button class="linky${showRevoked ? ' on' : ''}" id="toggle-revoked">${showRevoked ? 'hiding' : 'show'} ${dead} revoked</button>` : '');
    const t = $('#toggle-revoked');
    if (t) t.onclick = () => { showRevoked = !showRevoked; renderKeyTable(); };
  }
  // typing a name filters; pasting a whole key asks the server which key it is (the raw key is hashed there)
  let lookupT;
  $('#key-search').addEventListener('input', () => {
    const v = $('#key-search').value.trim();
    pastedKeyId = null;
    clearTimeout(lookupT);
    if (/^oh_(live|admin)_[a-f0-9]{40}$/.test(v)) {
      lookupT = setTimeout(async () => {
        try { const d = await api('/api/v1/portal/keys/lookup', { method: 'POST', body: JSON.stringify({ key: v }) }); pastedKeyId = d.id; toast(d.id ? `That key is "${keyName(d.id)}"` : 'That key does not belong to this account'); }
        catch (e) { toast(e.message); }
        renderKeyTable();
      }, 200);
    }
    renderKeyTable();
  });
  // row menu
  const menu = $('#row-menu'); let menuKey = null;
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-menu]');
    if (b) {
      menuKey = b.dataset.menu;
      // a revoked key can only be restored to the list or removed for good; a live one has the rest
      const k = (me.keys || []).find((x) => x.id === menuKey);
      const dead = !!k?.revoked, viewer = !!k && k.role !== 'owner';
      $$('#row-menu [data-act]').forEach((x) => {
        const a = x.dataset.act;
        x.hidden = a === 'activity' ? false : viewer ? a !== 'leave' : a === 'leave' ? true : a === 'delete' ? !dead : dead;
      });
      const r = b.getBoundingClientRect(); menu.hidden = false;
      menu.style.left = `${Math.min(innerWidth - 190, r.right - 180)}px`; menu.style.top = `${r.bottom + 6}px`;
      e.stopPropagation(); return;
    }
    if (!e.target.closest('#row-menu')) menu.hidden = true;
  });
  menu.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act; if (!act) return; menu.hidden = true;
    const k = (me.keys || []).find((x) => x.id === menuKey); if (!k) return;
    if (act === 'activity') { keyId = k.id; location.hash = 'activity'; }
    if (act === 'setup') { setupKeyId = k.id; location.hash = 'integrate'; }
    if (act === 'copy') { try { await navigator.clipboard.writeText(k.prefix); toast('Prefix copied'); } catch {} }
    if (act === 'share') openShare(k);
    if (act === 'leave') {
      const yes = await ask({ title: `Remove "${k.name}" from your list?`, ok: 'Remove', body: `You stop seeing its statistics. ${k.owner} can invite you again.` });
      if (!yes) return;
      try { await api('/api/v1/portal/keys/unshare', { method: 'POST', body: JSON.stringify({ key: k.id }) }); toast('Removed'); if (keyId === k.id) keyId = null; await refreshKeys(); } catch (e) { toast(e.message); }
    }
    if (act === 'rename') {
      const name = await ask({ title: 'Rename key', label: 'Name', value: k.name, ok: 'Rename' }); if (!name) return;
      try { await api('/api/v1/portal/keys/rename', { method: 'POST', body: JSON.stringify({ id: k.id, name }) }); await refreshKeys(); toast('Renamed'); } catch (e) { toast(e.message); }
    }
    if (act === 'rotate') {
      const yes = await ask({
        title: `Rotate "${k.name}"?`, ok: 'Rotate', danger: true,
        body: 'A new secret is issued for this same key. Its name, environment and history stay; the old secret stops working the moment you confirm.',
        hint: 'Deploy the new secret to your servers right after. Anything still holding the old one stops reporting.',
      });
      if (!yes) return;
      try {
        const d = await api('/api/v1/portal/keys/rotate', { method: 'POST', body: JSON.stringify({ id: k.id }) });
        $('#rotated-title').textContent = k.name; $('#rotated-raw').textContent = d.key === MASK ? 'Hidden: an AI agent is in this session. Rotate it again yourself to see it.' : d.key; $('#rotated').hidden = false;
        await refreshKeys();
      } catch (e) { toast(e.message); }
    }
    if (act === 'revoke') {
      const yes = await ask({ title: `Revoke "${k.name}"?`, ok: 'Revoke', danger: true, body: 'Servers using this key stop reporting immediately. The decisions it already reported stay in Activity.' });
      if (!yes) return;
      try { await api('/api/v1/portal/keys/revoke', { method: 'POST', body: JSON.stringify({ id: k.id }) }); toast('Key revoked'); } catch (e) { return toast(e.message); }
      if (keyId === k.id) keyId = liveKeys()[0]?.id || null;
      await refreshKeys();
    }
    if (act === 'delete') {
      const typed = await ask({
        title: `Delete "${k.name}" for good?`, ok: 'Delete', danger: true, label: `Type the key's name to confirm`,
        body: 'The key and every decision it reported are removed. This cannot be undone.',
      });
      if (typed !== k.name) return void (typed && toast('The name did not match, so nothing was deleted'));
      try { await api('/api/v1/portal/keys/delete', { method: 'POST', body: JSON.stringify({ id: k.id }) }); toast('Key deleted'); await refreshKeys(); await loadOverview().catch(() => {}); renderKeyTable(); } catch (e) { toast(e.message); }
    }
  });
  // ------------------------------------------------------------------ sharing a key's statistics
  let shareKeyId = null;
  async function openShare(k) {
    shareKeyId = k.id;
    $('#share-title').textContent = `Share "${k.name}"`;
    $('#share-email').value = ''; $('#share-msg').textContent = ''; $('#share-msg').className = 'fine'; $('#share-link').hidden = true;
    $('#share-modal').hidden = false; setTimeout(() => $('#share-email').focus(), 50);
    await renderShareList();
  }
  async function renderShareList() {
    const el = $('#share-list'); el.innerHTML = '<p class="fine">Loading…</p>';
    try {
      const d = await api(`/api/v1/portal/keys/access?key=${encodeURIComponent(shareKeyId)}`);
      const rows = [
        ...d.members.map((m) => `<li><span><b>${esc(m.email)}</b><span class="fine">since ${esc(day(m.since))}</span></span><span class="row"><select data-role="${esc(m.account)}" aria-label="What ${esc(m.email)} can do"><option value="editor"${m.role === 'editor' ? ' selected' : ''}>Can manage rules</option><option value="viewer"${m.role === 'viewer' ? ' selected' : ''}>Can view</option></select><button class="btn ghost sm" data-unshare="${esc(m.account)}">Remove</button></span></li>`),
        ...d.invites.map((i) => `<li><span><b>${esc(i.email)}</b><span class="fine">invited · ${i.role === 'viewer' ? 'can view' : 'can manage rules'} · link works until ${esc(day(i.expires))}</span></span><button class="btn ghost sm" data-cancel="${esc(i.id)}">Cancel</button></li>`),
      ];
      el.innerHTML = rows.length ? `<ul class="share-people">${rows.join('')}</ul>` : '<p class="fine">Nobody else sees this key yet.</p>';
      $$('[data-role]', el).forEach((sel) => sel.onchange = async () => { try { await api('/api/v1/portal/keys/share-role', { method: 'POST', body: JSON.stringify({ key: shareKeyId, account: sel.dataset.role, role: sel.value }) }); toast(sel.value === 'editor' ? 'They can manage the rules now' : 'They can only view now'); } catch (e) { toast(e.message); renderShareList(); } });
      $$('[data-unshare]', el).forEach((b) => b.onclick = async () => { try { await api('/api/v1/portal/keys/unshare', { method: 'POST', body: JSON.stringify({ key: shareKeyId, account: b.dataset.unshare }) }); toast('Access removed'); renderShareList(); } catch (e) { toast(e.message); } });
      $$('[data-cancel]', el).forEach((b) => b.onclick = async () => { try { await api('/api/v1/portal/keys/invites/cancel', { method: 'POST', body: JSON.stringify({ key: shareKeyId, id: b.dataset.cancel }) }); toast('Invitation cancelled'); renderShareList(); } catch (e) { toast(e.message); } });
    } catch (e) { el.innerHTML = `<p class="fine bad">${esc(e.message)}</p>`; }
  }
  $('#share-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const b = $('#share-send'), msg = $('#share-msg'); b.disabled = true; msg.className = 'fine'; msg.textContent = '';
    try {
      const d = await api('/api/v1/portal/keys/share', { method: 'POST', body: JSON.stringify({ key: shareKeyId, email: $('#share-email').value, role: $('#share-role').value }) });
      msg.className = 'fine ok';
      msg.textContent = d.mailed === 'sent' ? `Invitation sent to ${d.email}.` : `Invitation ready for ${d.email}. Send them this link:`;
      $('#share-link-url').textContent = d.link; $('#share-link').hidden = false;
      $('#share-email').value = '';
      renderShareList();
    } catch (err) { msg.className = 'fine bad'; msg.textContent = err.message; } finally { b.disabled = false; }
  });
  $('#share-copy').onclick = async () => { try { await navigator.clipboard.writeText($('#share-link-url').textContent); toast('Link copied'); } catch { toast('Select the link and copy it'); } };
  $('#share-done').onclick = () => { $('#share-modal').hidden = true; };
  $('#share-modal').addEventListener('click', (e) => { if (e.target === $('#share-modal')) $('#share-modal').hidden = true; });

  /** ?invite=… in the address: show who shared what before sign-in, accept it after */
  const inviteToken = new URLSearchParams(location.search).get('invite');
  // ------------------------------------------------------------------ connecting an app from the command line
  // `npx onehumanai init` / `connect` opens /portal?connect=CODE: sign in (or up), compare the code, press Connect; the
  // terminal receives the new key by itself.
  let connectCode = (new URLSearchParams(location.search).get('connect') || '').toUpperCase().trim() || null;
  const dropConnect = () => { connectCode = null; const u = new URL(location.href); u.searchParams.delete('connect'); history.replaceState(null, '', u.pathname + u.search + u.hash); };
  function showConnectOnSignIn() {
    if (!connectCode) return;
    $('#auth-invite').hidden = false;
    $('#auth-invite').innerHTML = `Sign in or create a free account to connect your app. Your code: <b class="mono">${esc(connectCode)}</b>`;
  }
  async function openConnect() {
    if (!connectCode) return;
    let d;
    try { d = await api(`/api/v1/portal/connect?code=${encodeURIComponent(connectCode)}`); }
    catch (e) { dropConnect(); await ask({ title: 'This code does not work', body: e.message, ok: 'OK' }); return; }
    if (d.status !== 'pending') { dropConnect(); await ask({ title: 'This code was already used', body: 'Run the command in your terminal again for a new one.', ok: 'OK' }); return; }
    const m = $('#connect-modal');
    $('#connect-name').textContent = d.name;
    $('#connect-meta').textContent = `asked ${ago(d.created)}${d.origin ? ` from ${d.origin}` : ''} · the code works for ${Math.max(1, Math.round((d.expires - Date.now()) / 60000))} more min`;
    $('#connect-code').textContent = d.code;
    $('#connect-ask').hidden = false; $('#connect-done').hidden = true;
    m.hidden = false;
    $('#connect-ok').focus();
  }
  $('#connect-ok').onclick = async () => {
    const b = $('#connect-ok'); b.disabled = true;
    try {
      const r = await api('/api/v1/portal/connect', { method: 'POST', body: JSON.stringify({ code: connectCode, approve: true }) });
      $('#connect-ask').hidden = true; $('#connect-done').hidden = false;
      $('#connect-key').textContent = `${r.key.name} · ${r.key.prefix}…`;
      dropConnect();
      me = await api('/api/v1/portal/me'); keyId = r.key.id; renderWorkspace();
    } catch (e) { toast(e.message); } finally { b.disabled = false; }
  };
  $('#connect-no').onclick = async () => {
    try { await api('/api/v1/portal/connect', { method: 'POST', body: JSON.stringify({ code: connectCode, approve: false }) }); } catch {}
    dropConnect(); $('#connect-modal').hidden = true; toast('Not connected. Nothing was created.');
  };
  $('#connect-close').onclick = () => { $('#connect-modal').hidden = true; location.hash = 'integrate'; };
  const dropInvite = () => { const u = new URL(location.href); u.searchParams.delete('invite'); history.replaceState(null, '', u.pathname + u.search + u.hash); };
  async function showInviteOnSignIn() {
    if (!inviteToken) return;
    try {
      const d = await api(`/api/v1/portal/invites/peek?token=${encodeURIComponent(inviteToken)}`);
      $('#auth-invite').hidden = false;
      $('#auth-invite').innerHTML = d.state === 'open'
        ? `<b>${esc(d.inviter)}</b> shared the statistics of <b>${esc(d.app)}</b> with <b>${esc(d.email)}</b>. Sign in or create an account with that address to open them.`
        : d.state === 'used' ? 'This invitation was already used. Sign in to see the keys shared with you.' : 'This invitation no longer works. Ask for a new one.';
      if (d.state === 'open' && !$('#email').value) $('#email').value = d.email;
    } catch (e) { $('#auth-invite').hidden = false; $('#auth-invite').textContent = e.message; }
  }
  async function acceptInvite() {
    if (!inviteToken) return;
    try {
      const d = await api('/api/v1/portal/invites/accept', { method: 'POST', body: JSON.stringify({ token: inviteToken }) });
      dropInvite();
      me = await api('/api/v1/portal/me'); keyId = d.key; renderWorkspace();
      toast(`${d.inviter} shared "${d.app}" with you`);
      location.hash = 'activity';
    } catch (e) {
      if (/already used/.test(e.message)) dropInvite();
      await ask({ title: 'This invitation did not open', body: e.message, ok: 'OK' });
    }
  }

  $('#rotated-done').onclick = () => { $('#rotated').hidden = true; };
  $('#rotated').addEventListener('click', (e) => { if (e.target === $('#rotated')) $('#rotated').hidden = true; });
  /** the key list changed on the server: pull it back and repaint everything that shows it */
  async function refreshKeys() { me = await api('/api/v1/portal/me'); renderKeyTable(); renderWorkspace(); }
  function openModal() { $('#modal').hidden = false; $('#modal-new').hidden = false; $('#modal-show').hidden = true; $('#key-name').value = ''; $('#modal-title').textContent = 'New API key'; setTimeout(() => $('#key-name').focus(), 50); }
  const closeModal = () => { $('#modal').hidden = true; };
  $('#key-add').onclick = openModal; $('#modal-close').onclick = closeModal;
  $('#modal-done').onclick = async () => { closeModal(); me = await api('/api/v1/portal/me'); renderWorkspace(); show(currentView()); };
  $('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) closeModal(); });
  $('#key-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#key-create').click(); });
  let freshKey = null;                                   // the raw key stays in memory only while this page is open
  $('#key-create').onclick = async () => {
    const b = $('#key-create'); b.disabled = true;
    try {
      const d = await api('/api/v1/portal/keys', { method: 'POST', body: JSON.stringify({ name: $('#key-name').value || 'Default', env: $('#key-env').value, expiresInDays: Number($('#key-exp').value) }) });
      keyId = d.id; setupKeyId = d.id; freshKey = { id: d.id, raw: d.key };
      $('#key-raw').textContent = d.key === MASK ? 'Hidden: an AI agent is in this session. Rotate this key yourself to see it.' : d.key; $('#modal-title').textContent = d.name; $('#modal-new').hidden = true; $('#modal-show').hidden = false;
    } catch (err) { toast(err.message); } finally { b.disabled = false; }
  };
  $('#key-setup').onclick = async () => { closeModal(); me = await api('/api/v1/portal/me'); renderWorkspace(); location.hash = 'integrate'; if (currentView() === 'integrate') renderIntegration(); };

  // ------------------------------------------------------------------ activity (per key)
  function renderKeyChips() {
    // open on the key that is actually reporting (most recent event), not on whichever was created first
    const chosenDead = (me?.keys || []).find((k) => k.id === keyId && k.revoked);
    const keys = chosenDead ? [...liveKeys(), chosenDead] : liveKeys(); if (!keyId || !keys.some((k) => k.id === keyId)) keyId = [...keys].sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0) || b.created - a.created)[0]?.id || null;
    $('#keys').innerHTML = keys.map((k) => `<button class="key ${k.id === keyId ? 'on' : ''} ${k.lastSeen ? 'live' : ''}" data-key="${esc(k.id)}"><i class="dot"></i>${esc(k.name)}<span class="pre">${k.role !== 'owner' ? `shared by ${esc(k.owner)}` : `${esc(k.prefix)}…`}</span></button>`).join('');
    $$('[data-key]').forEach((b) => b.addEventListener('click', () => { keyId = b.dataset.key; renderKeyChips(); loadStats(); }));
  }
  const fmtT = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`; };
  const fmtDay = (t) => { const d = new Date(t); return range === '24h' ? `${String(d.getHours()).padStart(2, '0')}:00` : `${d.getDate()}/${d.getMonth() + 1}`; };
  const STATE_WORD = { signed_agent: 'signed agent', agent_attached: 'agent attached', agent_environment: 'agent environment', no_indication: 'no indication' };
  const ACTOR_WORD = { human_like: 'a person', agent_likely: 'an AI agent', unknown: 'not settled yet', allow: 'let through', mask: 'details hidden', block: 'turned away', step_up: 'asked for a passkey' };
  // what a whole session turned out to be (the stats judge each session over all its decisions)
  const VERDICT_WORD = { human: 'a person', agent: 'an AI agent', no_data: 'no browser data', early: 'too early to tell', unclear: 'not enough signals' };
  const VERDICT_BAR = { human: 'People', agent: 'AI agents', no_data: 'No browser data (API or app)', early: 'Too early to tell (1–2 clicks)', unclear: 'Not enough signals' };
  const VERDICT_CLASS = { human: 'human_like', agent: 'agent_likely' };
  /** the word for one row: its own decision when it was clear, else what its session turned out to be */
  const whoWord = (e) => (e.actor !== 'unknown' ? ACTOR_WORD[e.actor] || e.actor : VERDICT_WORD[e.verdict] || ACTOR_WORD.unknown);
  const whoClass = (e) => (e.actor !== 'unknown' ? e.actor : VERDICT_CLASS[e.verdict] || 'unknown');
  /** horizontal bars; `look` names the colour class and the label of a key when they are not the key itself */
  const bars = (el, obj, order, cls, look) => {
    const keys = order.filter((k) => obj[k]).concat(Object.keys(obj).filter((k) => !order.includes(k) && obj[k]));
    const max = Math.max(1, ...keys.map((k) => obj[k]));
    const label = (k) => (look ? look.label(k) : cls === 'tool' ? toolName(k) : (ACTOR_WORD[k] || k.replace('_', ' ')).replace(/^./, (c) => c.toUpperCase()));
    el.innerHTML = keys.length ? keys.map((k) => { const w = Math.max(3, Math.round(obj[k] / max * 100)); return `<div class="hbar ${look ? esc(look.cls(k)) : cls ? cls : esc(k)}${w < 34 ? ' out' : ''}"><div class="hb-track"><i style="width:${w}%"></i><span class="hb-l"${w < 34 ? ` style="left:calc(${w}% + 8px)"` : ''}>${esc(label(k))}</span></div><b class="hb-n">${obj[k].toLocaleString()}</b></div>`; }).join('') : '<div class="fine">nothing yet</div>';
  };
  function drawChart(series, since, bucketMs, now) {
    const buckets = []; for (let t = Math.floor(since / bucketMs) * bucketMs; t <= now; t += bucketMs) buckets.push({ t, n: 0, agent: 0, gated: 0 });
    for (const x of series) { const bk = buckets.find((y) => y.t === x.t); if (bk) Object.assign(bk, x); }
    areaChart($('#act-chart'), buckets, DECISION_SERIES, (t) => fmtBucket(t, range));
  }
  let lastRecent = [], older = [], live = true;
  const shownRows = new Set();
  // A decision the portal verified at ingest carries a seal; clicking it downloads that session's proofs.
  const seal = (e) => e.signed === true
    ? `<button class="seal ok" data-proof-session="${esc(e.session)}" title="Signed and verified. Download this session's proofs">✓</button>`
    : e.signed === false ? '<span class="seal bad" title="A proof came with this decision but did not verify">!</span>' : '<span class="seal none" title="Unsigned (reported by an older middleware)">·</span>';
  // The customer grades a decision in place. This is the only ground truth the product gets from the field.
  const grade = (e) => `<span class="grade" data-grade-id="${e.id}"><button class="${e.feedback === 'correct' ? 'on' : ''}" data-v="correct" title="This decision was right">✓</button><button class="${e.feedback === 'wrong' ? 'on bad' : ''}" data-v="wrong" title="This was wrong: a person stopped, or an agent let through">✗</button></span>`;
  const logRow = (e, fresh = false) => `<div class="e${e.feedback === 'wrong' ? ' wrong' : ''}${fresh ? ' fresh' : ''}" title="session ${esc(e.session.slice(0, 8))} · ${esc(STATE_WORD[e.state] || e.state)} · ${esc(e.reasons.join(', '))}"><span class="t">${seal(e)}${fmtT(e.at)}</span><span class="r" title="${esc(e.resource)}">${esc(e.resource)}</span><span class="chip ${esc(e.decision)}">${esc(ACTOR_WORD[e.decision] || e.decision)}</span><span class="st"><span class="chip ${esc(whoClass(e))}"${e.actor === 'unknown' && VERDICT_CLASS[e.verdict] ? ' title="Judged over the whole session"' : ''}>${esc(whoWord(e))}</span>${e.tools.length ? ` <span class="chip">${esc(toolName(e.tools[0]))}</span>` : ''}</span>${grade(e)}</div>`;
  function filterLog(q) {
    const s = (q || '').toLowerCase();
    // the newest page comes from stats; anything the reader asked for beyond it is appended below
    const seen = new Set(), all = [];
    for (const e of [...lastRecent, ...older]) { const k = `${e.at}|${e.session}|${e.resource}|${e.decision}`; if (!seen.has(k)) { seen.add(k); all.push(e); } }
    const rows = all.filter((e) => !s || [e.resource, e.decision, e.actor, e.state, ...e.tools, ...e.reasons].join(' ').toLowerCase().includes(s));
    // the live refresh redraws the list every few seconds: only rows not shown before slide in
    const key = (e) => `${e.at}|${e.session}|${e.resource}|${e.decision}`;
    const first = !shownRows.size;
    $('#log').innerHTML = rows.length ? rows.map((e) => logRow(e, !first && !shownRows.has(key(e)))).join('') : '<div class="empty-row">No decisions yet.</div>';
    for (const e of rows) shownRows.add(key(e));
    $('#log-more').parentElement.hidden = !rows.length;
  }
  $('#live-toggle').onclick = () => {
    live = !live;
    $('#live-toggle').classList.toggle('on', live);
    $('#live-toggle').textContent = live ? 'live' : 'paused';
    if (live) loadStats(); else clearTimeout(timer);
  };
  $('#log-more').onclick = async () => {
    const b = $('#log-more'); b.disabled = true; b.textContent = 'Loading…';
    try {
      const oldest = [...lastRecent, ...older].reduce((m, e) => (e.id && (!m || e.id < m) ? e.id : m), null);
      const d = await api(`/api/v1/portal/events?key=${encodeURIComponent(keyId)}&range=${range}&limit=100${oldest ? `&before=${oldest}` : ''}`);
      older = older.concat(d.events);
      filterLog($('#search').value);
      b.hidden = !d.more;
      if (!d.events.length) toast('That is the whole range');
    } catch (e) { toast(e.message); } finally { b.disabled = false; b.textContent = 'Load older'; }
  };
  // Proof bundles are built server-side from the proofs that verified at ingest; the file is self-contained.
  async function downloadProofs(session) {
    if (!keyId) return;
    const q = `key=${encodeURIComponent(keyId)}&range=${session ? '30d' : range}${session ? `&session=${encodeURIComponent(session)}` : ''}`;
    try {
      const r = await fetch(`/api/v1/portal/proofs?${q}`, { credentials: 'same-origin' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || String(r.status));
      const blob = await r.blob();
      const n = JSON.parse(await blob.text()).decisions ?? 0;
      if (!n) { toast(session ? 'No signed decisions for this session' : 'No signed decisions in this range yet'); return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `onehuman-proofs-${keyName(keyId).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}${session ? '-' + session.slice(0, 8) : '-' + range}.json`;
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast(`${n.toLocaleString()} signed decision${n === 1 ? '' : 's'} exported`);
    } catch (e) { toast(e.message); }
  }
  $('#export-proofs').onclick = () => downloadProofs(null);
  $('#log').addEventListener('click', (e) => { const b = e.target.closest('[data-proof-session]'); if (b) downloadProofs(b.dataset.proofSession); });
  $('#log').addEventListener('click', async (e) => {
    const b = e.target.closest('.grade button'); if (!b) return;
    const id = Number(b.parentElement.dataset.gradeId), v = b.dataset.v;
    const row = [...lastRecent, ...older].find((x) => x.id === id); if (!row) return;
    const verdict = row.feedback === v ? null : v;                       // clicking the same thumb again clears it
    try {
      await api('/api/v1/portal/feedback', { method: 'POST', body: JSON.stringify({ key: keyId, id, verdict }) });
      row.feedback = verdict; filterLog($('#search').value);
      toast(verdict === 'wrong' ? 'Marked wrong. Thank you, this trains the model' : verdict === 'correct' ? 'Marked correct' : 'Grade cleared');
      loadStats();
    } catch (err) { toast(err.message); }
  });

  // the export walks the range server-side, so it is the log the reader sees, not just the visible page
  $('#export-csv').onclick = async () => {
    if (!keyId) return;
    const btn = $('#export-csv'); btn.disabled = true; btn.textContent = 'exporting…';
    try {
      const rows = []; let before = null;
      for (let page = 0; page < 40; page++) {
        const d = await api(`/api/v1/portal/events?key=${encodeURIComponent(keyId)}&range=${range}&limit=500${before ? `&before=${before}` : ''}`);
        rows.push(...d.events);
        if (!d.more || !d.events.length) break;
        before = d.events[d.events.length - 1].id;
      }
      const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const csv = ['time,session,resource,decision,actor,state,tools,reasons,enforcement']
        .concat(rows.map((e) => [new Date(e.at).toISOString(), e.session, e.resource, e.decision, e.actor, e.state, e.tools.join(' '), e.reasons.join(' '), e.enforcement].map(cell).join(',')))
        .join('\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url; a.download = `onehuman-${keyName(keyId).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${range}.csv`;
      a.click(); URL.revokeObjectURL(url);
      toast(`${rows.length.toLocaleString()} decision${rows.length === 1 ? '' : 's'} exported`);
    } catch (e) { toast(e.message); } finally { btn.disabled = false; btn.textContent = 'export CSV'; }
  };
  let logScope = '';
  async function loadStats() {
    clearTimeout(timer);
    // a different key or range is a different log: drop the pages the reader had loaded for the old one
    const scope = `${keyId}|${range}`;
    if (scope !== logScope) { logScope = scope; older = []; $('#log-more').hidden = false; }
    if (!keyId) { $('#empty').hidden = false; $('#stats').hidden = true; $('#empty h2').textContent = 'No API key yet'; $('#empty p').textContent = 'Create one per app. Its decisions show up here.'; $('#empty-go').textContent = 'Create API key'; $('#empty-go').href = '#keys'; return; }
    let d; try { d = await api(`/api/v1/portal/stats?key=${encodeURIComponent(keyId)}&range=${range}`); } catch (e) { toast(e.message); return; }
    const total = Object.values(d.decisions).reduce((a, b) => a + b, 0);
    const k = (me.keys || []).find((z) => z.id === keyId) || {};
    if (!total && !k.events) {
      $('#empty h2').textContent = 'Waiting for your app to connect'; $('#empty p').textContent = 'The first visit shows up here by itself.'; $('#empty-go').textContent = 'Set it up'; $('#empty-go').href = '#integrate';
      $('#empty').hidden = false; $('#stats').hidden = true;
    } else {
      $('#empty').hidden = true; $('#stats').hidden = false;
      const pct = d.sessions.total ? Math.round(d.sessions.agent / d.sessions.total * 100) : 0;
      $('#pct').textContent = `${pct}%`; $('#sessions').textContent = d.sessions.total; $('#sessions').nextElementSibling.textContent = d.sessions.total === 1 ? 'session' : 'sessions'; $('#agent-sessions').textContent = d.sessions.agent; $('#decisions').textContent = total;
      $('#gated').textContent = (d.decisions.mask || 0) + (d.decisions.block || 0) + (d.decisions.step_up || 0);
      const fb = d.feedback || { reviewed: 0, falseStops: 0, gated: 0 };
      $('#false-stops').textContent = fb.reviewed ? `${fb.falseStops}` : '–';
      $('#false-stops').title = fb.reviewed ? `${fb.reviewed} decision${fb.reviewed === 1 ? '' : 's'} graded · ${fb.falseStops} false stop${fb.falseStops === 1 ? '' : 's'} of ${fb.gated} gated · ${fb.misses} agent${fb.misses === 1 ? '' : 's'} let through` : 'Grade decisions in the log to see this';
      bars($('#bars-decisions'), d.decisions, ['allow', 'mask', 'step_up', 'block']);
      // sessions, each judged over all its decisions: a person once the signals showed one, an agent at any point
      const ppl = d.people || {};
      const who = { human: ppl.human || 0, agent: ppl.agent || 0, no_data: ppl.noData || 0, early: ppl.early || 0, unclear: ppl.unclear || 0 };
      bars($('#bars-actors'), who, ['human', 'agent', 'no_data', 'early', 'unclear'], null, { cls: (k) => VERDICT_CLASS[k] || 'unknown', label: (k) => VERDICT_BAR[k] });
      bars($('#bars-tools'), Object.fromEntries(d.tools.map((t) => [t.tool, t.sessions])), [], 'tool');
      const byRes = {}; for (const r of d.resources) { (byRes[r.resource] ||= {})[r.decision] = r.n; }
      $('#resources').innerHTML = Object.entries(byRes).map(([r, dec]) => [r, dec, Object.values(dec).reduce((a, b) => a + b, 0)]).sort((a, b) => b[2] - a[2]).slice(0, 8)
        .map(([r, dec, n]) => `<div class="tl-row"><div class="tl-t"><b>${esc(titleOf(r))}</b><span title="${esc(r)}">${esc(r)} · ${Object.entries(dec).map(([dd, c]) => `${esc(ACTOR_WORD[dd] || dd)} ${c}`).join(', ')}</span></div><b class="tl-n">${n.toLocaleString()}</b></div>`).join('') || '<div class="fine">nothing yet</div>';
      drawChart(d.series, d.range.since, d.range.bucketMs, d.now);
      lastRecent = d.recent; filterLog($('#search').value);
      loadPeople(keyId, range);
    }
    if (live) timer = setTimeout(loadStats, 10000);
  }
  addEventListener('resize', () => { if (currentView() === 'activity' && !$('#stats').hidden) loadStats(); });

  // the people strip: people blocked (should stay 0), people asked to confirm, agents gated
  const fmt = (n) => Number(n || 0).toLocaleString('en-US');
  async function loadPeople(key, r) {
    let h; try { h = await api(`/api/v1/portal/health?key=${encodeURIComponent(key)}&range=${r}`); } catch { return; }
    if (key !== keyId) return;
    const p = h.people;
    $('#people-stopped').textContent = fmt(p.stopped);
    $('#people-label').textContent = p.stopped === 1 ? 'person blocked' : 'people blocked';
    $('#people').classList.toggle('warn', p.stopped > 0);
    $('#people-stopped').title = p.stopped ? `${p.engineStopped} judged human but still gated by the policy · ${p.gradedWrong} gated decisions you marked wrong. Open the log and filter by human_like.` : 'No decision the engine called human was blocked or masked, and you marked no gated decision wrong.';
    $('#people-sessions').textContent = fmt(p.sessions);
    $('#people-sessions').nextElementSibling.textContent = p.sessions === 1 ? 'session judged human, let through' : 'sessions judged human, all let through';
    $('#people-asked').textContent = fmt(p.askedToConfirm);
    $('#people-agents').textContent = fmt(h.agents.gated);
  }

  // integration check: four lights from what the key reported, plus the self-test command
  let healthTimer = 0;
  async function loadChecks() {
    clearTimeout(healthTimer);
    if (currentView() !== 'integrate' || !setupKeyId) { $('#checks').innerHTML = '<div class="fine">Create a key first.</div>'; return; }
    const key = setupKeyId;
    let h; try { h = await api(`/api/v1/portal/health?key=${encodeURIComponent(key)}&range=7d`); } catch { return; }
    if (key !== setupKeyId) return;
    $('#checks').innerHTML = h.checks.map((c) => `<div class="check ${esc(c.status)}"><i class="dot" aria-label="${esc(c.status)}"></i><div><b>${esc(c.title)}</b><span>${esc(c.detail)}</span></div></div>`).join('');
    const allOk = h.checks.every((c) => c.status === 'ok');
    $('#health-sub').textContent = allOk ? 'everything works' : 'from what this key reported in the last 7 days';
    healthTimer = setTimeout(loadChecks, h.events ? 20000 : 5000);
  }
  const selftest = () => {
    const base = ($('#st-base').value.trim() || 'https://app.yourcompany.com').replace(/\s+/g, '');
    const path = ($('#st-path').value.trim() || '/api/balance').replace(/\s+/g, '');
    $('#cmd-selftest').textContent = `npx onehumanai verify ${base} ${path.startsWith('/') ? path : '/' + path}`;
    try { localStorage.setItem('oh-selftest', JSON.stringify({ base: $('#st-base').value, path: $('#st-path').value })); } catch {}
  };
  try { const saved = JSON.parse(localStorage.getItem('oh-selftest') || 'null'); if (saved) { $('#st-base').value = saved.base || ''; $('#st-path').value = saved.path || ''; } } catch {}
  $('#st-base').addEventListener('input', selftest); $('#st-path').addEventListener('input', selftest); selftest();

  // ------------------------------------------------------------------ integration + settings
  // ------------------------------------------------------------------ setup wizard
  let setupKeyId = null, fw = 'express', waitTimer = 0;
  const FRAMEWORKS = {
    express: (key) => `<span class="c">// server.js</span>\n<span class="k">import</span> { onehuman } <span class="k">from</span> <span class="s">'onehumanai'</span>;\n\n<span class="k">const</span> oh = <span class="k">await</span> onehuman({\n  secret: process.env.ONEHUMAN_SECRET,\n  policy: <span class="s">'./onehuman.policy.json'</span>,\n  apiKey: process.env.ONEHUMAN_API_KEY,\n  identify: (req) =&gt; req.session?.userId ?? <span class="k">null</span>,\n});\napp.use(oh.middleware());\napp.get(<span class="s">'/api/balance'</span>, oh.protect(<span class="s">'balance.read'</span>), (req, res) =&gt;\n  oh.send(req, res, balance, (b) =&gt; ({ ...b, amount: <span class="k">null</span> })));`,
    next: (key) => `<span class="c">// server.mjs (Next.js custom server)</span>\n<span class="k">import</span> next <span class="k">from</span> <span class="s">'next'</span>;\n<span class="k">import</span> express <span class="k">from</span> <span class="s">'express'</span>;\n<span class="k">import</span> { onehuman } <span class="k">from</span> <span class="s">'onehumanai'</span>;\n\n<span class="k">const</span> oh = <span class="k">await</span> onehuman({ secret: process.env.ONEHUMAN_SECRET, policy: <span class="s">'./onehuman.policy.json'</span>, apiKey: process.env.ONEHUMAN_API_KEY });\n<span class="k">const</span> app = express();\napp.use(oh.middleware());                       <span class="c">// before next()</span>\napp.get(<span class="s">'/api/balance'</span>, oh.protect(<span class="s">'balance.read'</span>), handler);\napp.all(<span class="s">'*'</span>, (req, res) =&gt; nextHandle(req, res));`,
    fastify: (key) => `<span class="c">// server.js: Fastify uses the raw request/response</span>\n<span class="k">const</span> oh = <span class="k">await</span> onehuman({ secret: process.env.ONEHUMAN_SECRET, policy: <span class="s">'./onehuman.policy.json'</span>, apiKey: process.env.ONEHUMAN_API_KEY });\n\nfastify.addHook(<span class="s">'onRequest'</span>, (req, reply, done) =&gt; oh.middleware()(req.raw, reply.raw, done));\nfastify.get(<span class="s">'/api/balance'</span>, { onRequest: (req, reply, done) =&gt; oh.protect(<span class="s">'balance.read'</span>)(req.raw, reply.raw, done) },\n  (req, reply) =&gt; oh.send(req.raw, reply.raw, balance, mask));`,
    docker: (key) => `<span class="c"># docker-compose.yml</span>\nservices:\n  api:\n    environment:\n      ONEHUMAN_SECRET: <span class="s">\"\${ONEHUMAN_SECRET}\"</span>\n      ONEHUMAN_API_KEY: <span class="s">\"${esc(key)}\"</span>\n\n<span class="c"># or plain docker</span>\ndocker run -e ONEHUMAN_API_KEY=${esc(key)} -e ONEHUMAN_SECRET=$ONEHUMAN_SECRET my-api`,
  };
  const agentPrompt = (key, admin) => `https://www.npmjs.com/package/onehumanai: install this into my app.\n\n\`npm i onehumanai\` is the only install (one package, the engine is inside). Follow the README protocol: scan the app as if you were an AI browser agent holding a customer's\nlogged-in session, show me the exposure map and what you propose to gate, ask me the nine decisions,\nthen implement the server wiring, the page tags, the policy file and every mask function, verify with\n\`npx onehumanai verify\`, and report what you left open.\n\nReport telemetry to my OneHuman portal: set apiKey: process.env.ONEHUMAN_API_KEY${key ? ` (${key})` : ''}.\n${admin ? `\nYou can administer my account yourself with the management API:\n  curl -H "Authorization: Bearer ${admin}" ${location.origin}/api/v1/manage/me\nGET /api/v1/manage/keys · POST /api/v1/manage/keys {name, expiresInDays, env} · DELETE /api/v1/manage/keys/:id\nGET /api/v1/manage/overview?range=7d · GET /api/v1/manage/stats?key=:id&range=7d\nGET /api/v1/manage/policy?key=:id · POST /api/v1/manage/policy {key, policy}  (the key's policy lives in the portal; your server reads it from there)` : ''}`;
  function renderIntegration() {
    const keys = ownKeys();
    if (!keys.length) { $('#setup-key').innerHTML = '<option>no keys yet</option>'; }
    else {
      if (!setupKeyId || !keys.some((k) => k.id === setupKeyId)) setupKeyId = [...keys].sort((a, b) => b.created - a.created)[0].id;   // the key you just made
      $('#setup-key').innerHTML = keys.map((k) => `<option value="${esc(k.id)}" ${k.id === setupKeyId ? 'selected' : ''}>${esc(k.name)} · ${esc(k.prefix)}…</option>`).join('');
    }
    const k = keys.find((x) => x.id === setupKeyId);
    const shown = freshKey && freshKey.id === setupKeyId ? freshKey.raw : `${k ? k.prefix : 'oh_live_'}…`;
    $('#cmd-env').textContent = `ONEHUMAN_API_KEY=${shown}\n# a new random secret: run  npx onehumanai secret  and paste its output here\nONEHUMAN_SECRET=`;
    $('#cmd-code').innerHTML = (FRAMEWORKS[fw] || FRAMEWORKS.express)(shown);
    $('#int-prompt').textContent = agentPrompt(freshKey && freshKey.id === setupKeyId ? freshKey.raw : (k ? `${k.prefix}…` : ''), null);
    $$('#fw-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.fw === fw));
    // step 4 watches for the first decision from this key
    clearTimeout(waitTimer);
    const check = async () => {
      if (currentView() !== 'integrate') return;
      try { me = await api('/api/v1/portal/me'); } catch { return; }
      const cur = (me.keys || []).find((x) => x.id === setupKeyId);
      const w = $('#wait');
      if (cur && cur.events) {
        w.className = 'waiting ok'; $('#wait-text').innerHTML = `${cur.events.toLocaleString()} decision${cur.events === 1 ? '' : 's'} received. <a href="#activity" style="text-decoration:underline">Open Activity</a>`;
        $$('.setup .step').forEach((st) => st.classList.add('done'));
      } else {
        w.className = 'waiting'; $('#wait-text').textContent = 'Waiting for the first decision from this key…';
        waitTimer = setTimeout(check, 5000);
      }
    };
    check();
    loadChecks();
  }
  $('#setup-key').addEventListener('change', (e) => { setupKeyId = e.target.value; renderIntegration(); });
  $$('#fw-tabs button').forEach((b) => b.addEventListener('click', () => { fw = b.dataset.fw; renderIntegration(); }));

  // ------------------------------------------------------------------ agent inventory
  let agRange = '30d';
  const OUT_LABEL = { allow: 'Allowed', mask: 'Hidden', step_up: 'Waiting for approval', approved: 'Approved by the owner', block: 'Never shared' };
  async function renderAgents() {
    const body = $('#agents-body');
    let d;
    try { d = await api(`/api/v1/portal/agents?range=${agRange}`); } catch (e) { body.innerHTML = `<div class="fine">${esc(e.message)}</div>`; return; }
    const t = d.totals; const pctS = t.sessions ? Math.round((t.agentSessions / t.sessions) * 100) : 0;
    const days = { '24h': 'the last 24 hours', '7d': 'the last 7 days', '30d': 'the last 30 days' }[d.range];
    if (!d.agents.length) {
      body.innerHTML = t.sessions
        ? emptyState(`No AI agent in ${days}`, `${fmt(t.sessions)} session${t.sessions === 1 ? '' : 's'} reported, none with an agent in it.`, '<a class="btn" href="#activity">View Activity</a>')
        : emptyState('No AI agents yet', 'Connect your app. The first agents usually show up within days.', '<a class="btn primary" href="#integrate">Set it up</a>');
      return;
    }
    const unnamed = d.agents.find((a) => a.tool === 'unnamed');
    const head = `<div class="ag-hero"><div><b>${fmt(t.agentSessions)}</b><span>customer session${t.agentSessions === 1 ? '' : 's'} had an AI agent in them${t.sessions ? `, ${pctS}% of ${fmt(t.sessions)}` : ''}</span></div><div><b>${fmt(t.products)}</b><span>named agent product${t.products === 1 ? '' : 's'}${unnamed ? `, plus ${fmt(unnamed.sessions)} session${unnamed.sessions === 1 ? '' : 's'} where only behaviour gave it away` : ''}</span></div><div><b>${fmt(d.agents.reduce((n, a) => n + a.actions, 0))}</b><span>protected actions they asked for, in ${days}</span></div></div>`;
    const bar = (o, total) => `<div class="ag-bar">${['allow', 'approved', 'mask', 'step_up', 'block'].filter((k) => o[k]).map((k) => `<i class="${k}" style="flex:${o[k]}" title="${esc(OUT_LABEL[k])}: ${o[k]}"></i>`).join('')}</div><div class="ag-legend">${['allow', 'approved', 'mask', 'step_up', 'block'].filter((k) => o[k]).map((k) => `<span class="${k}">${esc(OUT_LABEL[k])} ${fmt(o[k])}</span>`).join('')}</div>`;
    const cards = d.agents.map((a) => `<article class="ag-card">
      <div class="ag-top"><div><h3>${a.tool === 'unnamed' ? 'Unnamed agent' : esc(toolName(a.tool))}</h3><p>${a.tool === 'unnamed' ? 'No product traces; its behaviour showed a program. ' : ''}${fmt(a.sessions)} session${a.sessions === 1 ? '' : 's'} · ${esc(a.apps.join(', '))} · first seen ${esc(ago(a.first))}, last ${esc(ago(a.last))}</p></div><b class="ag-n">${fmt(a.actions)}<small>actions</small></b></div>
      ${bar(a.outcomes, a.actions)}
      ${a.observe ? `<p class="fine">Observe mode: ${fmt(a.observe)} of these are what your rules would have done. Nothing was enforced.</p>` : ''}
      <table class="ag-res"><tbody>${a.resources.map((r) => `<tr><td><code>${esc(r.resource)}</code></td><td>${fmt(r.n)}</td><td>${['allow', 'approved', 'mask', 'step_up', 'block'].filter((k) => r.outcomes[k]).map((k) => `<span class="chip ${k}">${esc(OUT_LABEL[k])}${r.outcomes[k] > 1 ? ` ×${r.outcomes[k]}` : ''}</span>`).join(' ')}</td></tr>`).join('')}</tbody></table>
    </article>`).join('');
    body.innerHTML = head + `<div class="ag-list">${cards}</div>`;
  }
  $$('#range-ag button').forEach((b) => b.addEventListener('click', () => { agRange = b.dataset.r; $$('#range-ag button').forEach((x) => x.classList.toggle('on', x === b)); renderAgents(); }));

  // ------------------------------------------------------------------ weekly report
  const TOOL_NAMES = { 'claude-chrome': 'Claude in Chrome', 'codex-chrome': 'Codex, Chrome extension', 'claude-app': 'Claude app browser', 'codex-app': 'Codex app browser', 'claude-tools': 'Claude agent tools', 'browser-panel': 'Browser side panel agent', 'cdp-reader': 'Automation script', 'unknown-tool': 'Unknown agent tool', operator: 'Signed agent' };
  const toolName = (t) => TOOL_NAMES[t] || t;
  /** the one empty state: a small icon in a circle, a title, one line, one button */
  const EMPTY_ICON = {
    agents: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>',
    reports: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>',
    keys: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M14 9l2 2"/>',
  };
  const emptyIcon = (name) => `<span class="es-icon" aria-hidden="true"><svg class="ic" viewBox="0 0 24 24">${EMPTY_ICON[name] || EMPTY_ICON.agents}</svg></span>`;
  const emptyState = (title, line, action, icon = 'agents') => `<div class="empty-state">${emptyIcon(icon)}<h3>${esc(title)}</h3><p>${esc(line)}</p>${action}</div>`;
  let weeklyKey = null;
  const keySelect = (sel, cur, keys = liveKeys()) => { if (!keys.length) { sel.innerHTML = '<option>no keys yet</option>'; return null; } const id = cur && keys.some((k) => k.id === cur) ? cur : (keyId && keys.some((k) => k.id === keyId) ? keyId : keys[0].id); sel.innerHTML = keys.map((k) => `<option value="${esc(k.id)}" ${k.id === id ? 'selected' : ''}>${esc(keyLabel(k))}</option>`).join(''); return id; };
  const delta = (a, b, unit = '') => { if (!b && !a) return ''; if (!b) return '<em>new this week</em>'; const d = a - b; return `<em>${d === 0 ? 'same as' : d > 0 ? `+${fmt(d)}${unit} vs` : `${fmt(d)}${unit} vs`} last week</em>`; };
  async function renderWeekly() {
    weeklyKey = keySelect($('#weekly-key'), weeklyKey);
    // the report buttons need data: a key that has reported at least once
    const hasData = !!(me.keys || []).find((k) => k.id === weeklyKey)?.events;
    $('#weekly-30').disabled = $('#weekly-print').disabled = !hasData;
    if (!weeklyKey) { $('#weekly-body').innerHTML = emptyState('No reports yet', 'Create an API key and connect your app first.', '<a class="btn primary" href="#keys">Create API key</a>', 'reports'); return; }
    if (!hasData) { $('#weekly-body').innerHTML = emptyState('No reports yet', 'Your first report appears once your app connects.', '<a class="btn primary" href="#integrate">Set it up</a>', 'reports'); return; }
    const key = weeklyKey;
    let w; try { w = await api(`/api/v1/portal/weekly?key=${encodeURIComponent(key)}`); } catch (e) { toast(e.message); return; }
    if (key !== weeklyKey) return;
    const c = w.week, p = w.previous;
    const pct = (x) => (x.sessions ? Math.round((x.agentSessions / x.sessions) * 100) : 0);
    const period = `${day(w.from)} to ${day(w.now)}`;
    const newSet = new Set(w.newAgents);
    const agents = c.tools.length ? `<div class="wk-chips">${c.tools.map((t) => `<span class="${newSet.has(t.tool) ? 'new' : ''}" title="${esc(t.tool)}">${esc(toolName(t.tool))} · ${fmt(t.sessions)} session${t.sessions === 1 ? '' : 's'}${newSet.has(t.tool) ? ' · new' : ''}</span>`).join('')}</div>` : '<p class="fine" style="margin:0">No named agent product was seen this week.</p>';
    const gone = w.goneAgents.length ? `<p class="fine">Not seen this week, seen last week: ${w.goneAgents.map((t) => esc(toolName(t))).join(', ')}.</p>` : '';
    const res = c.agentResources.length ? `<div class="res">${c.agentResources.map((r) => `<div class="row"><span class="r">${esc(r.resource)}</span><span class="chips"><span class="chip">${fmt(r.n)} attempt${r.n === 1 ? '' : 's'}</span><span class="chip block">${fmt(r.gated)} stopped</span></span></div>`).join('')}</div>` : '<p class="fine" style="margin:0">Agents did not reach any protected resource this week.</p>';
    const news = w.news.length ? `<div class="wk-news">${w.news.map((n) => `<article><h4>${esc(n.agent)}<small>${esc(n.date)}</small></h4><p>${esc(n.change)}</p><p>${esc(n.impact)}</p>${n.action ? `<p class="do">What to do: ${esc(n.action)}</p>` : ''}</article>`).join('')}</div>` : '<p class="fine" style="margin:0">No changes in the agents this month.</p>';
    const summary = !c.decisions ? 'No decisions were reported this week.'
      : `${fmt(c.sessions)} signed-in session${c.sessions === 1 ? '' : 's'}; ${pct(c)}% had an AI agent in them. ${c.agentGated ? `Agents were stopped or given masked data ${fmt(c.agentGated)} time${c.agentGated === 1 ? '' : 's'}.` : 'No agent was stopped.'} ${c.peopleStopped ? `${fmt(c.peopleStopped)} decision${c.peopleStopped === 1 ? '' : 's'} stopped a person: review them in Activity.` : 'No person was blocked.'}${w.newAgents.length ? ` New on your site: ${w.newAgents.map(toolName).join(', ')}.` : ''}`;
    $('#weekly-body').innerHTML = `
      <div class="card"><div class="card-head"><h3>${esc(keyName(key))} · ${esc(period)}</h3></div><p style="margin:0;line-height:1.6">${esc(summary)}</p></div>
      <div class="wk-kpis">
        <div class="wk-kpi"><b>${fmt(c.sessions)}</b><span>signed-in sessions</span>${delta(c.sessions, p.sessions)}</div>
        <div class="wk-kpi"><b>${pct(c)}%</b><span>had an AI agent in them</span>${p.sessions ? `<em>${pct(p)}% last week</em>` : ''}</div>
        <div class="wk-kpi"><b>${fmt(c.agentGated)}</b><span>times an agent was stopped or got masked data</span>${delta(c.agentGated, p.agentGated)}</div>
        <div class="wk-kpi good"><b>${fmt(c.peopleStopped)}</b><span>people blocked</span></div>
        <div class="wk-kpi"><b>${fmt(c.stepUps)}</b><span>passkey confirmations asked</span>${delta(c.stepUps, p.stepUps)}</div>
        <div class="wk-kpi"><b>${fmt(c.signed)}</b><span>decisions signed, ready for an auditor</span></div>
      </div>
      <div class="grid2">
        <div class="card"><div class="card-head"><h3>Agents seen on your site</h3><span class="sub">new ones marked</span></div>${agents}${gone}</div>
        <div class="card"><div class="card-head"><h3>What agents reached for</h3></div>${res}</div>
      </div>
      <div class="card"><div class="card-head"><h3>What changed in the agents</h3><span class="sub">last 4 weeks · the same for every customer</span></div>${news}</div>`;
  }
  $('#weekly-key').addEventListener('change', (e) => { weeklyKey = e.target.value; renderWeekly(); });
  // the design-partner report: 30 days, agents, endpoints, what the rules did or would have done, opens printable
  // the free report covers its own 30 days (from the day the app connected), not the last 30 days from today
  $('#report-open').onclick = () => {
    const k = weeklyKey || liveKeys()[0]?.id, t = me?.trial; if (!k) return;
    const period = t?.connectedAt && t.ready ? `from=${t.connectedAt}&to=${t.reportUntil}` : 'days=30';
    open(`/api/v1/portal/report?key=${encodeURIComponent(k)}&${period}&format=html`, '_blank');
  };
  $('#weekly-30').onclick = () => { if (weeklyKey) open(`/api/v1/portal/report?key=${encodeURIComponent(weeklyKey)}&days=30&format=html`, '_blank'); };
  $('#weekly-print').onclick = () => { document.body.classList.add('print-weekly'); addEventListener('afterprint', () => document.body.classList.remove('print-weekly'), { once: true }); print(); };

  // ------------------------------------------------------------------ rules
  // A rule says, for one part of the app, what happens to four kinds of visitor. Each row shows those four outcomes,
  // so nothing hides behind a preset's name; the presets stay as one-click ways to fill a row.
  const OUTCOMES = ['allow', 'mask', 'step_up', 'block'];
  const RULE_OUT = { allow: 'Open', mask: 'Hidden', step_up: 'Passkey', block: 'Refused' };
  const WHO = ['AI agent', 'AI tools', 'Not sure', 'Person'];
  const PRESETS = {
    open: { label: 'Open to everyone', m: ['allow', 'allow', 'allow', 'allow'] },
    mask: { label: 'Hide details from AI', m: ['mask', 'mask', 'allow', 'allow'] },
    block: { label: 'Refuse AI agents', m: ['block', 'mask', 'allow', 'allow'] },
    guard: { label: 'Refuse AI agents, passkey when unsure', m: ['block', 'step_up', 'step_up', 'allow'] },
    passkey: { label: 'Passkey for everyone', m: ['block', 'step_up', 'step_up', 'step_up'] },
  };
  const RES_RE = /^[a-z][a-z0-9_.]{1,60}$/;
  const presetOf = (m) => Object.entries(PRESETS).find(([, p]) => p.m.join() === m.join())?.[0] || null;
  const titleOf = (res) => res.replace(/[._]/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const guessModes = (res) => PRESETS[/export|download|payout|transfer|delete|withdraw|contacts/.test(res) ? 'guard' : /balance|medical|pipeline/.test(res) ? 'block' : 'mask'].m.slice();
  let pol = null, policyKey = null, pv = null, savedCanon = '';
  const addedHere = new Set();
  /** rows the agent just changed: lit up once */
  let flash = new Set();
  const ORIGIN = { install: 'your app, when it first connected', server: "your developers' code", agent: 'an AI coding assistant', portal: 'here, in the portal' };
  const STATUS_WORD = { pending: 'waiting', rejected: 'declined', superseded: 'replaced by a newer change', settings: 'setting' };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const canon = (d) => JSON.stringify([d.enforcement, [...d.rules].map((r) => [r.resource, r.title || '', r.onAgent, r.onArtifact ?? 'allow', r.onUnknown, r.onHumanLike, [...(r.actOn || [])].sort().join(), r.minScore ?? 65]).sort()]);
  const fromDoc = (o) => ({ enforcement: o.enforcement === 'enforce' ? 'enforce' : 'observe', rules: o.rules.slice(0, 50).map((r) => ({
    resource: String(r.resource || ''), title: String(r.title || ''), modes: [r.onAgent, r.onArtifact ?? 'allow', r.onUnknown, r.onHumanLike].map((m) => (OUTCOMES.includes(m) ? m : 'allow')),
    actOn: Array.isArray(r.actOn) ? r.actOn : undefined, minScore: typeof r.minScore === 'number' ? r.minScore : undefined })) });
  /** POST that may answer 403 {error:'confirm'}: ask for the password, showing what is risky, and send again. */
  async function withPassword(path, body) {
    const send = (extra) => api(path, { method: 'POST', body: JSON.stringify({ ...body, ...extra }) });
    try { return await send({}); } catch (e) {
      if (e.status !== 403 || e.data?.error !== 'confirm') throw e;
      for (;;) {
        const pw = await ask({ title: 'Please confirm this change', body: e.data.weakening?.length ? 'This change lowers protection or affects real people:' : e.message, list: e.data.weakening, label: 'Your password', password: true, ok: 'Confirm', danger: true, hint: 'We ask so that one careless edit, or someone using your open laptop, cannot switch protection off.' });
        if (!pw) return null;
        try { return await send({ password: pw }); } catch (e2) { if (e2.status !== 401) throw e2; toast('That password is not right'); }
      }
    }
  }
  async function renderPolicy(reload = false) {
    policyKey = keySelect($('#policy-key'), policyKey, ruleKeys());
    pv = null;
    if (policyKey) { try { pv = await api(`/api/v1/portal/policy?key=${encodeURIComponent(policyKey)}`); } catch (e) { toast(e.message); } }
    if (!pol || reload) {
      addedHere.clear();
      if (pv?.policy) {
        pol = fromDoc(pv.policy); savedCanon = canon(policyDoc().doc);
        $('#policy-src').textContent = `version ${pv.n}`;
      } else {
        let seen = [...(pv?.declared || [])];
        if (policyKey) { try { const d = await api(`/api/v1/portal/stats?key=${encodeURIComponent(policyKey)}&range=30d`); seen = [...new Set([...seen, ...d.resources.map((r) => r.resource)])].filter((r) => RES_RE.test(r)); } catch {} }
        const list = seen.length ? seen : ['profile.read', 'balance.read', 'report.export'];
        pol = { enforcement: 'observe', rules: list.slice(0, 50).map((r) => ({ resource: r, title: titleOf(r), modes: guessModes(r) })) };
        savedCanon = '';
        $('#policy-src').textContent = seen.length ? `suggested from ${plural(seen.length, 'part')} of your app we have seen` : 'an example to start from';
      }
    }
    drawStatus(); drawPending(); drawAgent(); drawUnruled(); drawSettings(); drawHistory(); drawPolicy();
  }
  function drawStatus() {
    const el = $('#pol-status');
    const mode = pol ? `<div class="seg pol-mode" role="group" aria-label="Protection"><button type="button" data-mode="observe" class="${pol.enforcement === 'observe' ? 'on' : ''}" title="Everything is recorded, nobody is blocked">Watch only</button><button type="button" data-mode="enforce" class="${pol.enforcement === 'enforce' ? 'on' : ''}" title="The rules apply">Enforce</button></div>` : '';
    if (!policyKey) { el.innerHTML = '<i class="dot"></i><div class="ps-text"><b>No app connected yet</b><span>Create an API key and give it to your developer. Each app has its own rules.</span></div>'; return; }
    if (!pv?.policy) { el.innerHTML = `<i class="dot"></i><div class="ps-text"><b>No rules yet</b><span>They appear by themselves when your app first connects. Or set them up below and save.</span></div>${mode}`; return; }
    const sv = pv.server, latest = `portal-v${pv.n}`;
    let dot = 'ok', line;
    if (!sv) { dot = 'warn'; line = 'your app has not connected yet'; }
    else if (sv.source === 'cache') { dot = 'warn'; line = 'your app is offline and uses its saved copy'; }
    else if (sv.source === 'file' || sv.source === 'none') { dot = 'warn'; line = 'your app still uses its own file, switching within a minute'; }
    else if (sv.version !== latest) { dot = 'warn'; line = 'your app picks up the latest version within a minute'; }
    else line = `your app uses these rules · checked ${ago(sv.at)}`;
    const on = pv.policy.enforcement === 'enforce';
    el.innerHTML = `<i class="dot ${on ? dot : 'watch'}"></i><div class="ps-text"><b>${on ? 'Protection is on' : 'Just watching'}</b><span>${plural(pv.policy.rules.length, 'part')} covered · version ${pv.n} · ${line}${pv.pending.length ? ` · <b>${plural(pv.pending.length, 'change')} waiting</b>` : ''}</span></div>${mode}`;
  }
  $('#pol-status').addEventListener('click', (e) => { const b = e.target.closest('[data-mode]'); if (!b || !pol) return; pol.enforcement = b.dataset.mode; $$('#pol-status [data-mode]').forEach((x) => x.classList.toggle('on', x === b)); writePolicy(); });
  const changeList = (summary, careful) => `<ul>${summary.map((x) => `<li class="${careful.includes(x) || careful.some((w) => w.startsWith(x)) ? 'weak' : ''}">${esc(x)}</li>`).join('')}</ul>`;
  function drawPending() {
    const list = pv?.pending || [];
    $('#pol-pending-card').hidden = !list.length;
    $('#pol-pending').innerHTML = list.map((c) => `<div class="pol-item" data-id="${c.id}">
      <p class="meta">From ${esc(ORIGIN[c.origin] || c.origin)} · ${ago(c.at)}${c.weakening.length ? '<span class="weak-tag">needs a careful look</span>' : ''}</p>
      ${changeList(c.summary, c.weakening)}
      <div class="row"><button class="btn sm primary" data-decide="1">Accept</button><button class="btn sm ghost" data-decide="0">Decline</button></div></div>`).join('');
  }
  $('#pol-pending').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-decide]'); if (!b) return;
    const id = +b.closest('[data-id]').dataset.id, approve = b.dataset.decide === '1';
    b.disabled = true;
    try {
      const r = await withPassword('/api/v1/portal/policy/decide', { key: policyKey, id, approve });
      if (r) toast(r.status === 'applied' ? 'Accepted. Your app uses it within a minute.' : 'Declined. Nothing changed.');
      await renderPolicy(true);
    } catch (err) { toast(err.message); b.disabled = false; }
  });
  function drawUnruled() {
    const list = (pv?.unruled || []).filter((u) => !addedHere.has(u.resource) && !pol?.rules.some((r) => r.resource === u.resource));
    $('#pol-unruled-card').hidden = !list.length;
    $('#pol-unruled').innerHTML = list.map((u) => `<div class="pol-un" data-res="${esc(u.resource)}">
      <div><b>${esc(titleOf(u.resource))}</b><code>${esc(u.resource)}</code><span>${u.from.includes('code') ? 'in your app\'s code' : 'seen in traffic'} · ${ago(u.lastSeen)}</span></div>
      <button class="btn sm" type="button">Add a rule</button></div>`).join('');
  }
  $('#pol-unruled').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const res = b.closest('[data-res]').dataset.res;
    pol.rules.push({ resource: res, title: titleOf(res), modes: guessModes(res) });
    addedHere.add(res); flash = new Set([res]); drawUnruled(); drawPolicy();
    toast('Added with a suggested rule. Adjust it, then save.');
  });
  function drawSettings() {
    const st = pv?.settings || { requireApproval: false, confirmWeakening: true };
    const none = !pv?.policy, shared = pv?.role === 'editor';
    $('#pol-req').checked = st.requireApproval; $('#pol-weak').checked = st.confirmWeakening;
    // a key shared with this account: its rules are ours to change, its settings stay with the owner
    $('#pol-req').disabled = $('#pol-weak').disabled = none || shared;
    $('#pol-req-hint').textContent = none ? 'Available once your app has connected.' : shared ? `Set by the key's owner (${(me.keys || []).find((k) => k.id === policyKey)?.owner || 'owner'}).` : st.requireApproval
      ? 'On: their changes wait under “Waiting for your OK”. Until you accept, your app keeps the current rules.'
      : 'Off (default): their changes go live by themselves. Every one is listed in History.';
    $('#pol-weak-hint').textContent = st.confirmWeakening
      ? 'On (recommended): a change that lets AI agents see or do more, or that stops real people, needs your OK and your password.'
      : 'Off: risky changes go through like any other. Turning this back on needs no password.';
  }
  const saveSetting = async (patch) => {
    try {
      const r = await withPassword('/api/v1/portal/policy/settings', { key: policyKey, ...patch });
      if (r) toast('Saved');
    } catch (err) { toast(err.message); }
    await renderPolicy();
  };
  $('#pol-req').addEventListener('change', (e) => saveSetting({ requireApproval: e.target.checked }));
  $('#pol-weak').addEventListener('change', (e) => saveSetting({ confirmWeakening: e.target.checked }));
  function drawHistory() {
    const list = pv?.history || [];
    $('#pol-history').innerHTML = list.length ? list.map((c) => {
      const label = c.status === 'applied' && c.toN ? `version ${c.toN}` : STATUS_WORD[c.status] || c.status;
      const who = c.status === 'applied' && c.decidedBy ? `${c.actor} · accepted by ${c.decidedBy}` : c.status === 'rejected' && c.decidedBy ? `${c.actor} · declined by ${c.decidedBy}` : c.actor;
      return `<div class="pol-hist"><span class="when" title="${esc(new Date(c.at).toLocaleString())}">${ago(c.at)}</span>
        <div><span class="chip ${esc(c.status)}">${esc(label)}</span> <span class="who">from ${esc(ORIGIN[c.origin] || c.origin)} · ${esc(who)}</span>${changeList(c.summary, c.weakening)}</div></div>`;
    }).join('') : '<p class="fine" style="margin:0">Nothing yet. Every change is listed here: who made it, when, and what it changed.</p>';
  }
  const cell = (m, j) => `<label class="pr-cell"><span>${WHO[j]}</span><select class="o o-${m}" data-j="${j}" aria-label="${WHO[j]}">${OUTCOMES.map((o) => `<option value="${o}"${o === m ? ' selected' : ''}>${RULE_OUT[o]}</option>`).join('')}</select></label>`;
  function drawPolicy() {
    $('#pol-rows').innerHTML = pol.rules.map((r, i) => `<div class="pol-row${flash.has(r.resource) ? ' flash' : ''}" data-i="${i}">
      <div class="pr-name"><input class="pr-title" data-f="title" value="${esc(r.title)}" maxlength="80" placeholder="What it is, e.g. Card details" aria-label="What it is"><input class="pr-code" data-f="resource" value="${esc(r.resource)}" placeholder="name.in.code" spellcheck="false" aria-label="Name in code"></div>
      ${r.modes.map(cell).join('')}
      <div class="pr-act"><button class="pr-btn" type="button" data-menu="${i}" title="Quick set" aria-label="Quick set"><svg class="ic" viewBox="0 0 24 24"><path d="M4 6h16M4 12h10M4 18h6"/></svg></button><button class="pr-btn pr-del" type="button" data-rm="${i}" title="Remove" aria-label="Remove"><svg class="ic" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
    </div>`).join('') || '<p class="fine pol-empty">No rules yet. Add a part of your app, with the name your developer gave it in code.</p>';
    if (flash.size) setTimeout(() => { flash = new Set(); $$('#pol-rows .flash').forEach((x) => x.classList.remove('flash')); }, 2400);
    writePolicy();
  }
  function policyDoc() {
    const errs = [];
    const seen = new Set();
    const rules = pol.rules.map((r) => {
      if (!RES_RE.test(r.resource)) errs.push(`"${r.resource || '(empty)'}" cannot be used as a name in code: lowercase letters, digits, dots and underscores, starting with a letter.`);
      else if (seen.has(r.resource)) errs.push(`"${r.resource}" is listed twice.`);
      seen.add(r.resource);
      const m = r.modes;
      return { resource: r.resource, title: (r.title || titleOf(r.resource)).slice(0, 80), onAgent: m[0], onArtifact: m[1], onUnknown: m[2], onHumanLike: m[3], actOn: r.actOn || ['verified', 'strong', 'control', 'behavioral'], minScore: r.minScore ?? 65 };
    });
    if (!rules.length) errs.push('Add at least one part of your app.');
    return { errs, doc: { version: pv?.policy ? pv.policy.version : `policy-${new Date().toISOString().slice(0, 10)}`, enforcement: pol.enforcement, rules } };
  }
  function writePolicy() {
    const { errs, doc } = policyDoc();
    const dirty = canon(doc) !== savedCanon;
    $('#pol-err').textContent = errs[0] || '';
    $('#pol-json').textContent = JSON.stringify(doc, null, 2);
    $('#pol-download').disabled = !!errs.length;
    $('#pol-save').disabled = !!errs.length || !policyKey || !dirty;
    $('#pol-discard').hidden = !dirty || !pv?.policy;
    $('#pol-savebar').classList.toggle('dirty', dirty && !errs.length);
    $('#pol-savebar').classList.toggle('bad', !!errs.length);
    $('#pol-save-msg').textContent = !policyKey ? 'Create an API key first' : errs.length ? 'Fix this first' : !pv?.policy ? 'Not saved yet' : dirty ? 'Unsaved changes' : `All saved · version ${pv.n}`;
  }
  $('#pol-rows').addEventListener('input', (e) => {
    const row = e.target.closest('.pol-row'); if (!row) return;
    const r = pol.rules[+row.dataset.i];
    if (e.target.dataset.j !== undefined) { r.modes[+e.target.dataset.j] = e.target.value; e.target.className = `o o-${e.target.value}`; }
    else if (e.target.dataset.f) r[e.target.dataset.f] = e.target.dataset.f === 'resource' ? e.target.value.trim() : e.target.value;
    writePolicy();
  });
  // quick set: one click fills a row's four outcomes
  const pop = document.createElement('div'); pop.className = 'pr-pop'; pop.hidden = true; document.body.appendChild(pop);
  let popRow = -1;
  $('#pol-rows').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { pol.rules.splice(+rm.dataset.rm, 1); drawPolicy(); drawUnruled(); return; }
    const m = e.target.closest('[data-menu]'); if (!m) return;
    popRow = +m.dataset.menu; const cur = presetOf(pol.rules[popRow].modes);
    pop.innerHTML = `<p>Quick set</p>${Object.entries(PRESETS).map(([k, p]) => `<button type="button" data-preset="${k}" class="${k === cur ? 'on' : ''}"><span class="pp-dots">${p.m.map((o) => `<i class="o-${o}"></i>`).join('')}</span>${esc(p.label)}</button>`).join('')}`;
    const r = m.getBoundingClientRect(); pop.hidden = false;
    pop.style.left = `${Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.right - pop.offsetWidth))}px`; pop.style.top = `${Math.min(innerHeight - pop.offsetHeight - 8, r.bottom + 6)}px`;
    e.stopPropagation();
  });
  pop.addEventListener('click', (e) => { const b = e.target.closest('[data-preset]'); if (!b || popRow < 0) return; pol.rules[popRow].modes = PRESETS[b.dataset.preset].m.slice(); pop.hidden = true; drawPolicy(); });
  document.addEventListener('click', (e) => { if (!pop.hidden && !pop.contains(e.target)) pop.hidden = true; });
  addEventListener('scroll', () => { pop.hidden = true; }, true);
  $('#pol-add').onclick = () => { pol.rules.push({ resource: '', title: '', modes: PRESETS.guard.m.slice() }); drawPolicy(); const inputs = $$('#pol-rows .pr-title'); inputs[inputs.length - 1]?.focus(); };
  $('#pol-import-toggle').onclick = () => { $('#pol-import').hidden = !$('#pol-import').hidden; };
  $('#pol-import-go').onclick = () => {
    try {
      const o = JSON.parse($('#pol-import-text').value);
      if (!o || !Array.isArray(o.rules) || !o.rules.length) throw new Error('No "rules" list in that file.');
      pol = fromDoc(o);
      $('#policy-src').textContent = 'loaded from the file you pasted, not saved yet';
      $('#pol-import-msg').textContent = `Loaded ${plural(pol.rules.length, 'rule')}.`;
      drawStatus(); drawPolicy(); drawUnruled();
    } catch (e) { $('#pol-import-msg').textContent = e.message.startsWith('No') ? e.message : 'That is not valid JSON.'; }
  };
  $('#pol-save').onclick = async () => {
    const { errs, doc } = policyDoc(); if (errs.length) return toast(errs[0]);
    $('#pol-save').disabled = true;
    try {
      const r = await withPassword('/api/v1/portal/policy', { key: policyKey, policy: doc });
      if (r) toast(r.status === 'unchanged' ? 'Nothing changed' : 'Saved. Your app uses it within a minute.');
      if (r) await renderPolicy(true); else writePolicy();
    } catch (e) { toast(e.message); writePolicy(); }
  };
  $('#pol-discard').onclick = () => { renderPolicy(true); };
  $('#policy-key').addEventListener('change', (e) => { policyKey = e.target.value; pol = null; agentReset(); renderPolicy(); });
  $('#pol-download').onclick = () => { const { errs, doc } = policyDoc(); if (errs.length) return toast(errs[0]); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2) + '\n'], { type: 'application/json' })); a.download = 'onehuman.policy.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };

  // ------------------------------------------------------------------ the agent: plain words in, a reviewed change out
  // A conversation beside the rules. Each answer that changes something comes as a card to apply or dismiss; applying
  // only changes the draft on the left (lit up), saving is still the person's step.
  const agent = { turns: [], busy: false, n: 0 };
  const proposals = new Map();
  const greetName = () => {
    const local = (me?.account?.email || '').split('@')[0];
    return /^[a-z]{2,20}$/i.test(local) && !/^(support|info|admin|team|hello|contact|office|sales|dev|test|mail|ops)$/i.test(local) ? local[0].toUpperCase() + local.slice(1).toLowerCase() : '';
  };
  function drawAgent() {
    const on = !!(pv?.assistant && pv?.policy);
    const name = greetName();
    $('#agent-greet').textContent = name ? `What should change, ${name}?` : 'What should change?';
    $('#agent-sub').textContent = !pv?.assistant ? 'Not switched on for this portal yet' : !pv?.policy ? 'Ready once your app has rules' : agent.busy ? 'Thinking…' : 'Edits your rules from plain words';
    $('#agent-msg').disabled = $('#agent-send').disabled = !on || agent.busy;
    $$('#agent-suggest button').forEach((b) => { b.disabled = !on || agent.busy; });
    $('#agent-suggest').hidden = agent.turns.length > 0;
    $('#pol-agent').classList.toggle('off', !on);
    $('#pol-agent').classList.toggle('busy', agent.busy);
  }
  function bubble(role, html, cls = '') {
    const el = document.createElement('div');
    el.className = `msg ${role} ${cls}`.trim();
    el.innerHTML = `${role === 'ai' ? '<span class="agent-orb sm" aria-hidden="true"></span>' : ''}<div class="msg-body">${html}</div>`;
    $('#agent-feed').appendChild(el);
    $('#agent-feed').scrollTop = $('#agent-feed').scrollHeight;
    return el;
  }
  const answerHtml = (a, id) => {
    const careful = (c) => a.careful.includes(c) || a.careful.some((w) => w.startsWith(c));
    return `<p>${esc(a.reply)}</p>`
      + (a.proposed ? `<div class="proposal" data-p="${id}"><div class="proposal-h"><span>Proposed change</span>${a.careful.length ? '<em>asks for your password</em>' : ''}</div>
          <ul>${a.changes.map((c) => `<li class="${careful(c) ? 'weak' : ''}">${esc(c)}</li>`).join('')}</ul>
          <div class="proposal-a"><button class="btn sm primary" type="button" data-apply="${id}">Apply to rules</button><button class="btn sm ghost" type="button" data-skip="${id}">Dismiss</button></div></div>` : '')
      + (a.refused?.length ? `<p class="msg-note">Left out: ${a.refused.map(esc).join('; ')}</p>` : '')
      + (a.needsCode ? `<div class="needs-code"><p>${esc(a.needsCode.why || 'This needs a new rule, and new rules are added in the app\'s code.')} Give this to your developer, or to the AI coding assistant they use:</p><div class="copyable"><pre class="code" id="as-code-${id}">${esc(a.needsCode.prompt)}</pre><button class="copy" data-copy="#as-code-${id}">Copy</button></div></div>` : '');
  };
  const autosize = () => { const t = $('#agent-msg'); t.style.height = 'auto'; t.style.height = `${Math.min(140, t.scrollHeight)}px`; };
  async function agentSay(text) {
    const message = String(text || '').trim();
    if (!message || agent.busy || !pol) return;
    const { errs, doc } = policyDoc();
    if (errs.length) return toast(errs[0]);
    $('#agent-hello').hidden = true;
    bubble('me', esc(message));
    const history = agent.turns.slice(-8);
    agent.turns.push({ role: 'user', text: message });
    agent.busy = true; drawAgent();
    $('#agent-msg').value = ''; autosize();
    const out = bubble('ai', '<span class="typing" aria-label="Thinking"><i></i><i></i><i></i></span>', 'pending');
    try {
      const a = await api('/api/v1/portal/policy/assist', { method: 'POST', body: JSON.stringify({ key: policyKey, message, draft: doc, history }) });
      const id = ++agent.n;
      if (a.proposed) proposals.set(id, a.proposed);
      agent.turns.push({ role: 'assistant', text: a.reply });
      out.querySelector('.msg-body').innerHTML = answerHtml(a, id);
    } catch (e) {
      agent.turns.pop();
      out.querySelector('.msg-body').innerHTML = `<p class="msg-err">${esc(e.message)}</p>`;
    }
    out.classList.remove('pending');
    agent.busy = false; drawAgent();
    $('#agent-feed').scrollTop = $('#agent-feed').scrollHeight;
    $('#agent-msg').focus();
  }
  function agentReset() {
    agent.turns = []; proposals.clear();
    $$('#agent-feed .msg').forEach((m) => m.remove());
    $('#agent-hello').hidden = false;
    drawAgent();
  }
  $('#agent-form').addEventListener('submit', (e) => { e.preventDefault(); agentSay($('#agent-msg').value); });
  $('#agent-msg').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); agentSay($('#agent-msg').value); } });
  $('#agent-msg').addEventListener('input', autosize);
  $('#agent-suggest').addEventListener('click', (e) => { const b = e.target.closest('[data-say]'); if (b) agentSay(b.dataset.say); });
  $('#agent-new').onclick = agentReset;
  $('#agent-feed').addEventListener('click', (e) => {
    const skip = e.target.closest('[data-skip]');
    if (skip) { const card = skip.closest('.proposal'); card.classList.add('done'); card.querySelector('.proposal-a').innerHTML = '<span class="proposal-done">Dismissed</span>'; proposals.delete(+skip.dataset.skip); return; }
    const apply = e.target.closest('[data-apply]'); if (!apply) return;
    const next = proposals.get(+apply.dataset.apply); if (!next) return;
    const before = new Map(pol.rules.map((r) => [r.resource, r.modes.join() + r.title]));
    pol = fromDoc(next);
    flash = new Set(pol.rules.filter((r) => before.get(r.resource) !== r.modes.join() + r.title).map((r) => r.resource));
    drawStatus(); drawPolicy(); drawUnruled();
    const card = apply.closest('.proposal'); card.classList.add('done');
    card.querySelector('.proposal-a').innerHTML = '<span class="proposal-done ok">Applied to your rules. Save when it looks right.</span>';
    proposals.delete(+apply.dataset.apply);
    $('#pol-rows .flash')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  // the agent opens as a drawer on the right
  $('#agent-fab').onclick = () => { document.body.classList.add('agent-open'); setTimeout(() => $('#agent-msg').focus(), 50); };
  $('#agent-close').onclick = () => document.body.classList.remove('agent-open');
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('agent-open')) document.body.classList.remove('agent-open'); });
  // Rules / History / File: one pane at a time
  $$('[data-pol-tab]').forEach((b) => b.addEventListener('click', () => {
    $$('[data-pol-tab]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', String(x === b)); });
    $$('[data-pol-pane]').forEach((p) => { p.hidden = p.dataset.polPane !== b.dataset.polTab; });
  }));

  // ------------------------------------------------------------------ auditor report (print → PDF)
  $('#audit-report').onclick = async () => {
    if (!keyId) return;
    const win = open('', '_blank');   // opened inside the click so it is not treated as a pop-up
    if (!win) return toast('Allow pop-ups for this page to open the report');
    win.document.write('<p style="font:14px system-ui;padding:24px">Checking every signature…</p>');
    try {
      const r = await fetch(`/api/v1/portal/proofs?key=${encodeURIComponent(keyId)}&range=${range}`, { credentials: 'same-origin' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || String(r.status));
      const bundle = await r.json();
      if (!bundle.proofs?.length) { win.close(); return toast('No signed decisions in this range yet'); }
      const results = [];
      for (let i = 0; i < bundle.proofs.length; i += 1000) {
        const v = await api('/api/v1/proof/verify', { method: 'POST', body: JSON.stringify({ keys: bundle.keys, proofs: bundle.proofs.slice(i, i + 1000) }) });
        results.push(...v.results);
      }
      win.document.open(); win.document.write(auditHtml(bundle, results)); win.document.close();
      setTimeout(() => win.print(), 400);
    } catch (e) { win.close(); toast(e.message); }
  };
  function auditHtml(bundle, results) {
    const ok = results.filter((x) => x.valid);
    const count = (f) => ok.reduce((m, x) => ((m[x[f]] = (m[x[f]] || 0) + 1), m), {});
    const list = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${esc(k)} ${fmt(n)}`).join(' · ') || '–';
    const kids = [...new Set(bundle.keys.map((k) => k.kid))];
    const rows = results.map((x, i) => x.valid ? `<tr><td>${esc(x.at.replace('T', ' ').slice(0, 19))}</td><td>${esc(x.resource)}</td><td>${esc(x.verdict)}</td><td>${esc(x.actor)}</td><td>${x.delivered ? 'yes' : 'no'}</td><td class="m">${esc(x.decision)}</td><td>${x.seq ?? ''}</td><td>✓</td></tr>` : `<tr class="bad"><td colspan="7">Proof ${i + 1}: ${esc(x.reason)}</td><td>✗</td></tr>`).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><title>Decision proof report · ${esc(keyName(keyId))}</title><style>
      body{font:12px/1.5 -apple-system,system-ui,sans-serif;color:#111;margin:32px}h1{font-size:20px;margin:0 0 4px}h2{font-size:14px;margin:22px 0 6px}
      .meta{color:#555}.box{border:1px solid #ccc;border-radius:8px;padding:10px 14px;margin:12px 0}.big{font-size:22px;font-weight:600}
      table{width:100%;border-collapse:collapse;margin-top:8px}th,td{text-align:left;padding:4px 6px;border-bottom:1px solid #e5e5e5;vertical-align:top}th{color:#555;font-weight:500}
      td.m,code{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;word-break:break-all}tr.bad td{color:#b00}@media print{body{margin:12mm}}</style></head><body>
      <h1>Decision proof report</h1>
      <div class="meta">Project: ${esc(keyName(keyId))} · Range: ${esc(bundle.range)} · Generated ${esc(new Date().toISOString().replace('T', ' ').slice(0, 19))} UTC</div>
      <div class="box"><div class="big">${fmt(ok.length)} of ${fmt(results.length)} decisions verified</div>
      Every decision below was signed on the company's own server when it was made, with an Ed25519 key only that server holds. Changing any field afterwards breaks the signature.<br>
      Decisions: ${list(count('verdict'))}<br>Acting party: ${list(count('actor'))}<br>Signing key id: <code>${kids.map(esc).join(', ')}</code></div>
      <h2>How to check this report yourself</h2>
      <ol><li>Ask the company for the proof file of this range (the JSON export next to this report in their OneHuman portal).</li>
      <li>Get their public key from their own website, not from the file: <code>https://&lt;their-site&gt;/onehuman/proof-keys</code>.</li>
      <li>Run <code>npx onehumanai verify-proof proofs.json --keys https://&lt;their-site&gt;/onehuman/proof-keys</code>. It needs no account and sends nothing anywhere. Any standard JOSE library works too.</li></ol>
      <p class="meta">Actor values: human_like = acted like a person · agent_likely = an AI agent · unknown = not settled at that moment (too few actions, or no browser data: an API call or an app); the policy decides, often a passkey. In the dashboard a session is judged over all its decisions. Delivered = whether the data was actually returned.</p>
      <h2>Signed decisions</h2>
      <table><thead><tr><th>Time (UTC)</th><th>Resource</th><th>Decision</th><th>Actor</th><th>Delivered</th><th>Decision id</th><th>Log #</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      </body></html>`;
  }

  // ------------------------------------------------------------------ settings + management keys
  let adminKeys = [], freshAdmin = null;
  $('#set-mails').addEventListener('change', async (e) => {
    const on = e.target.checked;
    try { await api('/api/v1/portal/email', { method: 'POST', body: JSON.stringify({ reports: on }) }); if (me.trial) me.trial.emails = on; toast(on ? 'E-mails on' : 'E-mails off'); }
    catch (err) { e.target.checked = !on; toast(err.message); }
  });
  // ---------------------------------------------------------------- plan & usage
  const usd = (c) => (c == null ? 'by contract' : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`);
  const monthName = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const priceLine = (p) => p.id === 'free' ? '$0' : p.id === 'payg' ? `${usd(p.unitCents)} <small>per customer after ${p.included}</small>` : p.id === 'growth' ? `${usd(p.monthlyCents)} <small>a month</small>` : 'Custom <small>annual</small>';
  async function renderPlan() {
    const body = $('#plan-body');
    let v;
    try { v = await api('/api/v1/portal/plan'); } catch (e) { body.innerHTML = `<div class="fine">Could not load your plan: ${esc(e.message)}</div>`; return; }
    const used = v.usage.total, inc = v.plan.included;
    const pct = inc ? Math.min(100, Math.round((used / inc) * 100)) : 0;
    const kinds = v.usage.kinds || {};
    const until = v.observeFrom ? new Date(v.observeFrom).toLocaleDateString(undefined, { day: 'numeric', month: 'long' }) : '';
    const status = v.licenseMode === 'observe'
      ? `<div class="plan-alert"><b>OneHuman is watching only.</b> The grace period ended, so it records every AI agent and what protection would have done, and enforces nothing. Your app works as before. Choose a plan${v.plan.prepaid ? ' or top up' : ''} to turn protection back on at once.</div>`
      : v.over
        ? `<div class="plan-alert"><b>${v.plan.id === 'payg' ? 'Your balance ran out this month.' : 'You are past the free limit this month.'}</b> Full protection continues until <b>${esc(until)}</b>. If the month is not covered by then, OneHuman switches to watch-only (it records, it does not enforce) until it is. Your app is never affected.</div>`
        : '';
    body.innerHTML = `
      ${status}
      <div class="sec-h-row"><h2 class="sec-h">${esc(monthName(v.month))}</h2><span class="fine">${esc(v.plan.name)} plan</span></div>
      <div class="card">
        <div class="plan-now">
          <div><div class="plan-big">${used.toLocaleString()}${inc ? ` <small>of ${inc.toLocaleString()} included</small>` : ''}</div><div class="fine">customers who used an AI agent in your app this month</div>
            ${inc ? `<div class="meter${v.over ? ' over' : ''}"><i style="width:${pct}%"></i></div>` : ''}</div>
          <div class="kv">
            <span>This month so far</span><b>${usd(v.estimateCents)}</b>
            ${v.plan.prepaid || v.balanceCents ? `<span>Balance</span><b>${usd(v.balanceCents)}</b>` : ''}
            <span>Agent signatures</span><b>${v.liveSignatures ? 'the day they are released' : '30 days after release'}</b>
            <span>Protection</span><b>${v.licenseMode === 'observe' ? 'watch-only' : v.over ? `full, until ${esc(until)}` : 'full'}</b>
          </div>
        </div>
        <p class="fine" style="margin:14px 0 0">A customer counts once a month: one of your signed-in users in whose session an AI agent acted, however often they come back. Visitors who are not signed in, and bots, never count. Your API key is also your app's license: keep it in <code>ONEHUMAN_API_KEY</code> on every server.</p>
      </div>
      ${v.requested ? `<div class="card plan-requested"><b>You asked for ${esc(v.plans.find((p) => p.id === v.requested)?.name || v.requested)}.</b> We e-mail payment details within a working day and switch it on as soon as it is paid. Nothing changes until then.</div>` : ''}
      <h2 class="sec-h">Plans</h2>
      <div class="plan-grid">
        ${v.plans.map((p) => {
          const current = p.id === v.plan.id, asked = p.id === v.requested;
          const btn = current ? '<button class="btn" disabled>Your plan</button>'
            : asked ? '<button class="btn" disabled>Requested</button>'
            : p.id === 'enterprise' ? '<a class="btn" href="https://cal.com/onehumanai" target="_blank" rel="noopener">Talk to us</a>'
            : `<button class="btn${p.id === 'payg' || p.id === 'growth' ? ' primary' : ''}" data-plan="${p.id}">${p.id === 'free' ? 'Switch to Free' : `Choose ${esc(p.name)}`}</button>`;
          return `<div class="plan-card${current ? ' on' : ''}"><h3>${esc(p.name)}</h3><div class="plan-price">${priceLine(p)}</div><p class="fine">${esc(p.summary)}</p><ul>${p.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>${btn}</div>`;
        }).join('')}
      </div>
      ${v.history.length ? `<h2 class="sec-h">Earlier months</h2><div class="card"><div class="kv">${v.history.map((h) => `<span>${esc(monthName(h.month))}</span><b>${h.total.toLocaleString()} customers · ${usd(h.cents)}</b>`).join('')}</div></div>` : ''}
      ${v.ledger.length ? `<div class="sec-h-row"><h2 class="sec-h">Balance</h2><span class="fine">top-ups and adjustments</span></div><div class="card"><div class="kv">${v.ledger.map((l) => `<span>${esc(day(l.at))}</span><b>${l.cents > 0 ? '+' : ''}${usd(l.cents)}${l.note ? ` · ${esc(l.note)}` : ''}</b>`).join('')}</div></div>` : ''}`;
    $$('[data-plan]', body).forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.plan, name = v.plans.find((p) => p.id === id)?.name;
      const toFree = id === 'free';
      if (!await ask({ title: toFree ? 'Switch to Free?' : `Choose ${name}?`, ok: toFree ? 'Switch' : 'Send request',
        body: toFree ? 'It applies at once. Your servers keep protecting; new agent signatures reach them 30 days after release. Any balance stays yours.'
          : 'We e-mail you payment details (card or bank transfer) within a working day and switch the plan on once it is paid. Nothing changes until then.' })) return;
      b.disabled = true;
      try { await api('/api/v1/portal/plan', { method: 'POST', body: JSON.stringify({ plan: id }) }); toast(toFree ? 'You are on Free' : 'Request sent. We will e-mail you.'); renderPlan(); }
      catch (e) { toast(e.message); b.disabled = false; }
    }));
  }

  async function renderSettings() {
    $('#set-mails').checked = me.trial ? me.trial.emails : true;
    $('#set-email').textContent = me.account.email; $('#set-since').textContent = day(me.account.created); $('#pw-reset-email').textContent = me.account.email;
    const owned = (me.keys || []).filter((k) => k.role === 'owner');
    $('#set-keys').textContent = `${ownKeys().length} active · ${owned.filter((k) => k.revoked).length} revoked`;
    try { adminKeys = (await api('/api/v1/portal/admin-keys')).keys.filter((k) => !k.revoked); } catch { adminKeys = []; }
    const keyTile = '<span class="stile" aria-hidden="true"><svg class="ic" viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M14 9l2 2"/></svg></span>';
    $('#admin-rows').innerHTML = adminKeys.length ? adminKeys.map((k) => `<div class="srow admin-row">${keyTile}<div class="srow-t"><b>${esc(k.name)}</b><span class="meta">${esc(k.prefix)}… · created ${day(k.created)} · ${k.calls.toLocaleString()} call${k.calls === 1 ? '' : 's'} · last used ${ago(k.lastSeen)}</span></div><button class="btn danger sm" data-admin-revoke="${esc(k.id)}">Revoke</button></div>`).join('')
      : `<div class="srow">${keyTile}<div class="srow-t"><b>No management keys yet</b><span>Create one to let an agent or a CI job manage this account.</span></div></div>`;
    $$('[data-admin-revoke]').forEach((b) => b.addEventListener('click', async () => {
      const name = adminKeys.find((x) => x.id === b.dataset.adminRevoke)?.name || 'this key';
      if (!await ask({ title: `Revoke "${name}"?`, ok: 'Revoke', danger: true, body: 'Anything using this management key (an agent, a CI job) stops working immediately.' })) return;
      await api('/api/v1/portal/admin-keys/revoke', { method: 'POST', body: JSON.stringify({ id: b.dataset.adminRevoke }) });
      toast('Management key revoked'); renderSettings();
    }));
  }
  $('#admin-add').onclick = () => { $('#admin-modal').hidden = false; $('#admin-new').hidden = false; $('#admin-show').hidden = true; $('#admin-name').value = ''; setTimeout(() => $('#admin-name').focus(), 50); };
  $('#admin-cancel').onclick = () => { $('#admin-modal').hidden = true; };
  // settings sub-nav: one section at a time
  $$('[data-set-tab]').forEach((b) => b.addEventListener('click', () => {
    $$('[data-set-tab]').forEach((x) => { x.classList.toggle('on', x === b); if (x === b) x.setAttribute('aria-current', 'true'); else x.removeAttribute('aria-current'); });
    $$('[data-set-pane]').forEach((p) => { p.hidden = p.dataset.setPane !== b.dataset.setTab; });
  }));
  // with Firebase sign-in the password is changed from a link Firebase e-mails (it also covers "set one" after Google)
  if (fb) {
    $('#pw-form').hidden = true; $('#pw-reset').hidden = false;
    $('#pw-reset-send').addEventListener('click', async () => {
      const b = $('#pw-reset-send'), msg = $('#pw-reset-msg'); b.disabled = true; msg.className = 'fine'; msg.textContent = '';
      try { await fb.reset(me.account.email); msg.className = 'fine ok'; msg.textContent = 'Sent. Check your inbox.'; }
      catch (err) { msg.className = 'fine bad'; msg.textContent = err.message; } finally { b.disabled = false; }
    });
  }
  $('#pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const b = $('#pw-save'), msg = $('#pw-msg');
    b.disabled = true; msg.className = 'fine'; msg.textContent = '';
    try {
      await api('/api/v1/portal/account/password', { method: 'POST', body: JSON.stringify({ current: $('#pw-current').value, next: $('#pw-next').value }) });
      $('#pw-form').reset(); msg.className = 'fine ok'; msg.textContent = 'Password changed.'; toast('Password changed');
    } catch (err) { msg.className = 'fine bad'; msg.textContent = err.message; } finally { b.disabled = false; }
  });

  $('#admin-done').onclick = () => { $('#admin-modal').hidden = true; renderSettings(); };
  $('#admin-modal').addEventListener('click', (e) => { if (e.target === $('#admin-modal')) $('#admin-modal').hidden = true; });
  $('#admin-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#admin-create').click(); });
  $('#admin-create').onclick = async () => {
    const b = $('#admin-create'); b.disabled = true;
    try {
      const d = await api('/api/v1/portal/admin-keys', { method: 'POST', body: JSON.stringify({ name: $('#admin-name').value || 'Management key' }) });
      freshAdmin = d.key; $('#admin-raw').textContent = d.key; $('#admin-title').textContent = d.name; $('#admin-new').hidden = true; $('#admin-show').hidden = false;
      $('#admin-prompt-copy').onclick = async () => { try { await navigator.clipboard.writeText(agentPrompt(liveKeys()[0]?.prefix ? `${liveKeys()[0].prefix}…` : '', freshAdmin)); toast('Agent prompt copied'); } catch { toast('Could not copy'); } };
    } catch (err) { toast(err.message); } finally { b.disabled = false; }
  };
  function renderWorkspace() {
    const email = me.account.email; $('#who').textContent = email; $('#av').textContent = email[0].toUpperCase();
    // the top bar's status: a key that reported in the last day means OneHuman is live in an app
    const live = ownKeys().some((k) => k.lastSeen && Date.now() - k.lastSeen < 864e5);
    $('#status-pill').classList.toggle('live', live); $('#status-text').textContent = live ? 'Live' : ownKeys().length ? 'Waiting' : 'No key yet';
    $('#ws-name').textContent = email.split('@')[1] ? `${email.split('@')[1].split('.')[0]} workspace` : 'Workspace'; $('#ws-sub').textContent = `${liveKeys().length} key${liveKeys().length === 1 ? '' : 's'} · ${email}`;
  }

  // ------------------------------------------------------------------ boot
  async function boot() {
    try { me = await api('/api/v1/portal/me?probe=1'); } catch { me = null; }
    if (!me?.account) me = null;
    // the loading screen the server showed for a signed-in visitor goes once we know which view it is
    const loaded = () => document.getElementById('boot')?.remove();
    if (!me) { $('#auth').hidden = false; $('#shell').hidden = true; $('#me-chip').hidden = true; $('#search-wrap').hidden = true; loaded(); showInviteOnSignIn(); showConnectOnSignIn(); return; }
    $('#auth').hidden = true; $('#shell').hidden = false; $('#me-chip').hidden = false;
    renderWorkspace();
    if (!location.hash) location.hash = 'overview';
    show(currentView());
    loaded();
    acceptInvite();
    openConnect();
  }
  // ------------------------------------------------------------------ an AI agent in or beside this tab
  // OneHuman's page script says when an agent drives this tab or a side panel opens beside it (where an assistant
  // can read the page). Then: what is already on screen is hidden in place, a bar says why, and the view is loaded
  // again so the server answers with its masked variant. When the panel closes, the view comes back.
  let agentShown = null;
  async function onPresence(p) {
    const state = p && p.agent ? p.agent : null;
    if (state === agentShown) return;
    agentShown = state;
    const bar = $('#agent-bar');
    if (state) {
      $$('[data-oh-sensitive="sealed"]').forEach((el) => el.setAttribute('data-oh-sensitive', 'full'));
      try { window.OneHuman.seal('portal_presence'); } catch {}
      $('#agent-bar-text').textContent = state === 'attached'
        ? 'An AI agent is controlling this tab. Keys, e-mail and proofs are hidden, sign-in is turned off, and changes it makes are reported to the account owner.'
        : p.panel ? 'A side panel is open beside this tab: an AI assistant there can read the page. Keys, e-mail and proofs are hidden until it closes.'
          : 'An AI agent tool is present in this browser. Keys, e-mail and proofs are hidden, and the account owner is told.';
      bar.dataset.level = state; bar.hidden = false;
    } else bar.hidden = true;
    try { await window.OneHuman.flush(); } catch {}
    if (me) { try { me = await api('/api/v1/portal/me'); renderWorkspace(); show(currentView()); } catch {} }
  }
  if (window.OneHuman && window.OneHuman.presence) {
    document.addEventListener('onehuman:presence', (e) => onPresence(e.detail));
    onPresence(window.OneHuman.presence());
  }
  boot();
})();
