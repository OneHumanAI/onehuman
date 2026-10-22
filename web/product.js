// SPDX-License-Identifier: BUSL-1.1
/* Product-style demo apps (bank / CRM / enterprise workspace). User-facing only: no scores, no reason codes.
   Every sensitive card is fetched through OneHuman.fetch and the server decides what comes back. Pages are hash
   routes (#/cards) so one visit stays one session. The test panel hands a scenario to an AI agent and shows,
   live, what the server decided for the person and for the agent in this demo room. */
(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s, el) => [...(el || document).querySelectorAll(s)];
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const money = (n, unit) => { if (n == null) return '••••'; const u = unit || 'USD'; const sym = u === 'USD' || u === '$' ? '$' : u + ' '; return `${sym}${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; };
  const room = new URL(location.href).searchParams.get('room');
  const q = `?room=${encodeURIComponent(room)}`;
  const appId = (document.querySelector('meta[name="oh-app"]') || {}).content || 'bank';
  const SH = () => (window.OneHuman && window.OneHuman.sessionHeaders ? window.OneHuman.sessionHeaders() : {});
  let app = null;
  let me = null;
  let passkeys = [];
  let toastTimer = null;

  const toast = (msg) => { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600); };
  const R = (id) => (app && app.resources.find((r) => r.id === id)) || { id, title: id, button: id, fields: null };
  const bodyId = (res) => `body-${res.replace(/\./g, '-')}`;

  // ------------------------------------------------------------ guard pill
  function renderGuard(c) {
    const g = $('#guard');
    if (!c) return;
    const humanOk = me && me.humanVerified;
    const agentIn = c.state === 'agent_attached' || c.state === 'signed_agent';
    showAiBanner(agentIn, c.tools);
    if (agentIn) { g.className = 'guard agent'; g.lastElementChild.textContent = 'AI agent in this session · private data hidden'; }
    else if (humanOk) { g.className = 'guard human'; g.lastElementChild.textContent = 'Verified human session'; }
    else if (c.state === 'agent_environment' && c.evidence.some((e) => e.code === 'AGENT_APP_BROWSER' || e.code === 'CODEX_MODEL_CONTEXT')) { g.className = 'guard env'; g.lastElementChild.textContent = 'AI browser window · some actions ask you first'; }
    else { g.className = 'guard'; g.lastElementChild.textContent = 'Session protected'; }
  }
  async function refreshGuard() {
    try {
      const r = await fetch(`/api/v1/connection${q}`, { cache: 'no-store', headers: SH() });
      if (r.ok) renderGuard((await r.json()).connection);
    } catch { /* ignore */ }
  }

  // ------------------------------------------------------------ the owner's AI agent: banner + page
  const TOOL_NAMES = { 'claude-chrome': 'Claude in Chrome', 'codex-chrome': 'Codex in Chrome', 'claude-app': 'Claude', 'codex-app': 'Codex', 'claude-tools': 'Claude', 'browser-panel': 'An AI assistant in a side panel', 'cdp-reader': 'An automated browser', operator: 'A signed AI agent' };
  const agentName = (tools) => { const t = (tools || []).find((x) => TOOL_NAMES[x]); return t ? TOOL_NAMES[t] : 'An AI agent'; };
  function showAiBanner(on, tools) {
    const b = $('#ai-banner'); if (!b) return;
    const onAiPage = current && app && current().id === 'ai';
    b.hidden = !on || onAiPage;
    if (on) $('#ai-banner-text').textContent = `${agentName(tools)} is using your account.`;
  }
  const EFFECT = { allow: 'Can do it', mask: 'Sees it, private details hidden', step_up: 'Asks you every time', block: 'Never' };
  const AGENT_OUTCOME = { allow: 'got it', mask: 'saw it with private details hidden', step_up: 'waited for your approval', block: 'was refused' };
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const titleOf = (res) => { const r = (app.rules || []).find((x) => x.resource === res); return (r && r.title) || R(res).title; };
  async function renderAccess() {
    const box = $('#ai-page'); if (!box) return;
    let a;
    try { const r = await fetch(`/api/v1/access${q}`, { cache: 'no-store', headers: SH() }); a = await r.json(); if (!r.ok) throw new Error(a.message || a.error); }
    catch (e) { box.innerHTML = `<div class="card c12"><h3>Could not load</h3><p class="sub">${esc(e.message)}</p></div>`; return; }
    const who = agentName(a.tools);
    const status = a.connected
      ? `<div class="ai-status on"><span class="dot"></span><div><h3>${esc(who)} is connected to your account${a.since ? ` <span class="since">since ${clock(a.since)}</span>` : ''}</h3><p>You decide what it may do here. ${esc(app.name)} sets the limits; you can close anything, and open more with your passkey.</p></div><button class="danger" id="ai-disconnect">Close everything to it</button></div>`
      : a.nearby
        ? `<div class="ai-status near"><span class="dot"></span><div><h3>An AI assistant may be reading this page</h3><p>It is not acting in your account. If you let it, these rules apply.</p></div></div>`
        : `<div class="ai-status"><span class="dot"></span><div><h3>No AI agent is using your account right now</h3><p>If you let an assistant like Claude or ChatGPT use your account, you decide here what it may do. ${esc(app.name)} will ask you before anything risky.</p></div></div>`;
    const rows = a.actions.map((x) => {
      const open = x.choice === 'allow' && x.until ? `until ${clock(x.until)}` : '';
      const seg = (val, label, extra) => `<button class="seg-b${(x.choice || 'default') === val ? ' on' : ''}" data-acc="${esc(x.resource)}" data-choice="${val}"${extra || ''}>${label}</button>`;
      return `<div class="acc-row">
        <div class="acc-t"><b>${esc(x.title)}</b><span>${esc(app.name)} default: ${esc(EFFECT[x.company] || x.company)}</span></div>
        <div class="acc-now eff-${esc(x.effective)}">${esc(EFFECT[x.effective] || x.effective)}${open ? ` <small>${open}</small>` : ''}</div>
        <div class="seg">${seg('default', 'Default')}${x.company === 'allow' ? '' : seg('allow', 'Allow 1 h 🔑', x.mayLoosen ? '' : ` disabled title="${esc(app.name)} keeps this closed to AI agents"`)}${seg('never', 'Never')}</div>
      </div>`;
    }).join('');
    const act = a.activity.length ? a.activity.map((d) => {
      if (d.resource.startsWith('access.')) {
        const what = d.owner === 'allowed' ? 'allowed for 1 hour, confirmed with your passkey' : d.owner === 'denied' ? 'set to never' : `back to the default${d.passkey ? ', confirmed with your passkey' : ''}`;
        return `<li><span class="t">${clock(d.at)}</span><span class="who${d.passkey ? ' you' : ''}">${d.passkey ? 'You' : 'This session'}</span> ${esc(titleOf(d.resource.slice(7)))}: ${esc(what)}</li>`;
      }
      const how = d.owner === 'allowed' ? 'got it, because you allowed it' : d.owner === 'denied' ? 'was refused, because you said never' : AGENT_OUTCOME[d.decision] || d.decision;
      return `<li><span class="t">${clock(d.at)}</span><span class="who">${esc(agentName(d.tools))}</span> ${esc(titleOf(d.resource))}: ${esc(how)}</li>`;
    }).join('') : '<li class="none">Nothing yet. What an AI agent does in your account will show here, the moment it happens.</li>';
    box.innerHTML = `<div class="card c12">${status}</div>
      <div class="card c8"><div class="head"><div><h3>What it may do</h3><p class="sub">Stricter takes effect at once. More access needs your passkey, so the agent cannot give it to itself.</p></div></div><div class="acc">${rows}</div></div>
      <div class="card c4"><h3>What it did</h3><p class="sub">In this account, newest first</p><ul class="ai-log">${act}</ul></div>`;
    $$('[data-acc]', box).forEach((b) => { b.onclick = () => chooseAccess(b.dataset.acc, b.dataset.choice, b); });
    const dc = $('#ai-disconnect'); if (dc) dc.onclick = () => chooseAccess('*', 'never', dc);
  }
  async function chooseAccess(resource, choice, button) {
    const value = choice === 'default' ? null : choice;
    if (button) button.disabled = true;
    try {
      const r = await fetch(`/api/v1/access${q}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...SH() }, body: JSON.stringify({ resource, choice: value }) });
      const d = await r.json();
      if (r.status === 403 && d.error === 'passkey_required') {
        if (!webauthnAvailable()) { toast('This browser has no passkey support.'); return; }
        if (!passkeys.length) await registerPasskey();
        await verifyWithPasskey(resource, 'permit', value === 'allow' ? 'allow' : 'default');
        toast(value === 'allow' ? `${titleOf(resource)}: allowed for 1 hour` : `${titleOf(resource)}: back to the default`);
      } else if (!r.ok) { toast(d.message || d.error); return; }
      else toast(resource === '*' ? 'Everything is closed to the AI agent' : value === 'never' ? `${titleOf(resource)}: never` : `${titleOf(resource)}: back to the default`);
    } catch (e) { toast(e && e.name === 'NotAllowedError' ? 'Passkey not confirmed. Nothing changed.' : e.message); }
    finally { if (button) button.disabled = false; renderAccess(); pollResults(); }
  }
  const AI_PAGE = { id: 'ai', icon: '✦', label: 'Connected AI', title: 'Your AI agent', sub: 'What an AI assistant may do in your account', html: () => '<div class="grid ai-grid" id="ai-page"><div class="card c12"><p class="sub">Loading…</p></div></div>' };

  // ------------------------------------------------------------ WebAuthn
  const b64uToBuf = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
  const bufToB64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const webauthnAvailable = () => !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create);
  async function refreshPasskeys() {
    try { const r = await fetch(`/api/v1/webauthn/status${q}`, { cache: 'no-store', headers: SH() }); if (r.ok) { const d = await r.json(); passkeys = d.credentials || []; if (me) me.humanVerified = !!(d.humanVerifiedAt && Date.now() - d.humanVerifiedAt < d.validForMs); } } catch { /* ignore */ }
    const pk = $('#pk-btn'); if (pk) { pk.textContent = passkeys.length ? 'Passkey registered ✓' : 'Register a passkey'; pk.disabled = !!passkeys.length || !webauthnAvailable(); }
  }
  async function registerPasskey() {
    const o = await (await fetch(`/api/v1/webauthn/register/options${q}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...SH() }, body: '{}' })).json();
    const pk = o.publicKey;
    const cred = await navigator.credentials.create({ publicKey: { ...pk, challenge: b64uToBuf(pk.challenge), user: { ...pk.user, id: b64uToBuf(pk.user.id) }, excludeCredentials: (pk.excludeCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })) } });
    const r = await fetch(`/api/v1/webauthn/register${q}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...SH() }, body: JSON.stringify({ challengeId: o.challengeId, id: cred.id, clientDataJSON: bufToB64u(cred.response.clientDataJSON), attestationObject: bufToB64u(cred.response.attestationObject), label: 'Touch ID / passkey' }) });
    if (!r.ok) throw new Error((await r.json()).message || 'Registration failed');
    await refreshPasskeys();
  }
  /** purpose 'approve': the person approves one action an agent asked for; default: take the session back */
  async function verifyWithPasskey(resource, purpose, choice, stepUpId) {
    // stepUpId: the held request this confirmation covers (from the 428); nothing else passes with it
    const o = await (await fetch(`/api/v1/webauthn/assert/options${q}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...SH() }, body: JSON.stringify({ resource: resource || null, purpose: purpose || null, choice: choice || null, stepUpId: stepUpId || undefined }) })).json();
    if (o.error) throw new Error(o.message || o.error);
    const pk = o.publicKey;
    const cred = await navigator.credentials.get({ publicKey: { ...pk, challenge: b64uToBuf(pk.challenge), allowCredentials: (pk.allowCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })) } });
    const r = await fetch(`/api/v1/webauthn/assert${q}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...SH() }, body: JSON.stringify({ challengeId: o.challengeId, id: cred.id, clientDataJSON: bufToB64u(cred.response.clientDataJSON), authenticatorData: bufToB64u(cred.response.authenticatorData), signature: bufToB64u(cred.response.signature) }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.message || d.error);
    await refreshPasskeys(); refreshGuard();
    return d;
  }

  // ------------------------------------------------------------ confirmation dialog
  // Two kinds. A code (the demo's stand-in for an SMS code) when nobody is sure who is acting. When an AI agent
  // is acting, the page carries no code at all: only the account owner's passkey approves that one action.
  function stepUpDialog(info, resource) {
    return new Promise((resolve) => {
      const dlg = $('#stepup'); const form = $('#stepup-form');
      const approve = !!info.approve;
      const usePasskey = approve || (passkeys.length && webauthnAvailable());
      const title = R(resource).title;
      $('#stepup-title').textContent = approve ? 'Your approval is needed' : 'Security confirmation';
      $('#stepup-text').innerHTML = approve
        ? `An AI agent in this session asked to: <b>${esc(title)}</b>. Only you can approve it, with Touch ID, Face ID or Windows Hello. The agent cannot do this step.`
        : usePasskey ? `Confirm <b>${esc(title)}</b> with Touch ID or a passkey.` : `Confirm <b>${esc(title)}</b>. Enter the code we sent you (in this demo it is shown below).`;
      $('#stepup-code-wrap').style.display = usePasskey ? 'none' : '';
      $('#stepup-code').textContent = info.challenge || '';
      $('#stepup-answer').value = ''; $('#stepup-error').textContent = '';
      const needKey = approve && !passkeys.length;
      $('#stepup-ok').textContent = needKey ? 'Register a passkey, then approve' : usePasskey ? 'Approve with passkey' : 'Confirm';
      $('#stepup-ok').disabled = usePasskey && !webauthnAvailable();
      if (usePasskey && !webauthnAvailable()) $('#stepup-error').textContent = 'This browser has no passkey support. Approve from a browser with Touch ID or Windows Hello.';
      const done = (v) => { form.removeEventListener('submit', onSubmit); $('#stepup-cancel').removeEventListener('click', onCancel); dlg.close(); resolve(v); };
      const onSubmit = async (e) => {
        e.preventDefault();
        try {
          if (usePasskey) {
            if (!passkeys.length) await registerPasskey();
            await verifyWithPasskey(resource, approve ? 'approve' : null, null, info.id); done(true); return;
          }
          const r = await fetch('/api/v1/step-up', { method: 'POST', headers: { 'Content-Type': 'application/json', ...SH() }, body: JSON.stringify({ id: info.id, answer: $('#stepup-answer').value }) });
          const d = await r.json();
          if (!r.ok) { $('#stepup-error').textContent = d.message || 'The code does not match'; return; }
          done(true);
        } catch (err) { $('#stepup-error').textContent = err.message; }
      };
      const onCancel = () => done(false);
      form.addEventListener('submit', onSubmit); $('#stepup-cancel').addEventListener('click', onCancel);
      dlg.showModal(); if (!usePasskey) $('#stepup-answer').focus();
    });
  }

  // ------------------------------------------------------------ protected call
  /** returns {ok, data, masked, decision} or {ok:false, blocked:true, reclaim} */
  async function load(resource, extraQuery, method, retried) {
    const r = await window.OneHuman.fetch(`/api/v1/r/${resource}${q}${extraQuery || ''}`, { method: method || 'GET' });
    const d = await r.json();
    if (r.status === 428 && !retried) {
      const ok = await stepUpDialog(d.stepUp || {}, resource);
      if (ok) return load(resource, extraQuery, method, true);
      return { ok: false, cancelled: true };
    }
    if (r.status === 403) { refreshGuard(); return { ok: false, blocked: true, reclaim: !!(d.stepUp && d.stepUp.reclaim), decision: d.decision }; }
    if (!r.ok) return { ok: false, error: d.message || d.error || String(r.status) };
    refreshGuard();
    return { ok: true, data: d.data, masked: !!d.masked, downloadUrl: d.downloadUrl, decision: d.decision };
  }

  function noticeFor(res, body, resource, retry) {
    $$('.notice', body).forEach((n) => n.remove());
    if (res.ok && res.masked) body.insertAdjacentHTML('beforeend', `<div class="notice mask"><span class="ico">●</span><div>Private details are hidden while an AI agent is in this session. If this is you alone, confirm with a passkey to see everything.</div></div>`);
    if (res.blocked) {
      const can = res.reclaim && passkeys.length && webauthnAvailable();
      body.insertAdjacentHTML('beforeend', `<div class="notice block"><span class="ico">■</span><div><strong>Never shared with AI agents.</strong> An AI agent is in this session, so this stays closed.${can ? '' : passkeys.length ? '' : ' If this is you, register a passkey in the test panel first.'}<div class="actions">${can ? `<button class="primary" data-reclaim="${esc(resource)}">It's me: confirm with passkey</button>` : ''}</div></div></div>`);
      const b = body.querySelector('[data-reclaim]');
      if (b) b.onclick = async () => { b.disabled = true; try { const v = await verifyWithPasskey(resource); if (window.OneHuman) window.OneHuman.unseal(v.reclaim); toast('Verified: the session is yours'); await retry(); } catch (e) { toast(e.message); b.disabled = false; } };
    }
    if (res.error) body.insertAdjacentHTML('beforeend', `<div class="notice block"><span class="ico">!</span><div>${esc(res.error)}</div></div>`);
    if (res.cancelled) body.insertAdjacentHTML('beforeend', `<div class="notice info"><span class="ico">i</span><div>Not approved. Nothing happened.</div></div>`);
  }

  async function download(res, body) {
    if (!res.downloadUrl) { body.insertAdjacentHTML('beforeend', `<div class="notice mask"><span class="ico">●</span><div>The file is not available while private details are hidden.</div></div>`); return; }
    const r = await fetch(res.downloadUrl, { cache: 'no-store', headers: SH() });
    if (!r.ok) { body.insertAdjacentHTML('beforeend', `<div class="notice block"><span class="ico">■</span><div>The file was not delivered.</div></div>`); return; }
    const blob = await r.blob();
    const name = (/filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '') || [])[1] || 'export';
    const u = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = u; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(u), 2000);
    body.innerHTML = `<div class="result ok"><strong>${esc(name)}</strong><p>Downloaded.</p></div>`;
    toast(`${name} downloaded`);
  }

  // ------------------------------------------------------------ renderers
  const kvHtml = (rows) => `<div class="kv">${rows.map((r) => `<span>${esc(r.label)}</span><strong>${esc(r.value)}</strong>`).join('')}</div>`;
  const tableHtml = (t, opts = {}) => {
    const cols = t.columns || []; const rows = t.rows || [];
    if (!rows.length) return '<div class="empty">No results.</div>';
    return `<div class="table-wrap"><table><thead><tr>${cols.map((c) => `<th${c.align === 'right' ? ' style="text-align:right"' : ''}>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${rows.map((r, i) => `<tr${opts.clickable ? ` class="clickable" data-row="${i}"` : ''}>${cols.map((c) => `<td${c.align === 'right' ? ' style="text-align:right"' : ''}>${cell(r[c.key], c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  };
  const MONEY_KEYS = new Set(['amount', 'value', 'opening', 'closing']);
  const cell = (v, c) => {
    if (v == null) return '<span class="chip">••••</span>';
    if (c.key === 'status') return `<span class="chip ${/Paid|Closed/.test(v) ? 'ok' : /Declined/.test(v) ? 'bad' : 'warn'}">${esc(v)}</span>`;
    if (c.key === 'stage') return `<span class="chip ${v === 'Closed won' ? 'ok' : ''}">${esc(v)}</span>`;
    if (c.key === 'role') return `<span class="chip ${/Owner|Admin/.test(v) ? 'warn' : ''}">${esc(v)}</span>`;
    if (c.key === 'mfa') return `<span class="chip ${v === 'On' ? 'ok' : 'bad'}">${esc(v)}</span>`;
    if (c.key === 'key' || c.key === 'iban') return `<code>${esc(v)}</code>`;
    if (MONEY_KEYS.has(c.key)) return typeof v === 'number' ? money(v) : esc(v);
    return esc(v);
  };

  // ------------------------------------------------------------ page building blocks
  const btn = (res, label, primary) => `<button data-res="${res}"${primary ? ' class="primary"' : ''}>${esc(label || R(res).button)}</button>`;
  const card = (o) => `<div class="card ${o.w || 'c12'}${o.cls ? ' ' + o.cls : ''}"><div class="head"><div><h3>${esc(o.title)}</h3>${o.sub ? `<p class="sub">${esc(o.sub)}</p>` : ''}</div>${o.actions ? `<div class="actions">${o.actions}</div>` : ''}</div>${o.html || ''}${o.res ? `<div class="body" id="${bodyId(o.res)}">${o.empty ? `<div class="empty">${esc(o.empty)}</div>` : ''}</div>` : ''}</div>`;
  const show = (res, o = {}) => card({ title: o.title || R(res).title, sub: o.sub, w: o.w, res, actions: btn(res, o.label, o.primary), empty: o.empty || 'Not loaded.' });
  const form = (res, o = {}) => {
    const d = R(res);
    const inputs = (d.fields || []).map((f) => f.options
      ? `<label><span>${esc(f.label)}</span><select data-field="${esc(f.name)}">${f.options.map((x) => `<option>${esc(x)}</option>`).join('')}</select></label>`
      : `<label><span>${esc(f.label)}</span><input data-field="${esc(f.name)}" placeholder="${esc(f.placeholder || '')}" autocomplete="off"></label>`).join('');
    return card({ title: o.title || d.title, sub: o.sub, w: o.w || 'c6', res, html: `<div class="form">${inputs}<button class="primary" data-res="${res}">${esc(d.button)}</button></div>` });
  };
  const stat = (title, value, sub, w) => `<div class="card ${w || 'c4'}"><h3>${esc(title)}</h3><div class="kpi">${esc(value)}</div><div class="kpi-sub">${esc(sub || '')}</div></div>`;
  const exportCard = (res, title, sub, w) => card({ title, sub, w, res, actions: btn(res, null, true) });

  const PAGES = {
    bank: [
      { id: 'overview', icon: '○', label: 'Overview', title: 'Welcome back', sub: 'Current account · USD', html: () => `
        <div class="card hero-card c8"><h3>Current account</h3><p class="sub">•••• 2048</p><div class="amount" id="bank-amount">$ ••••</div><small id="bank-note">Balance hidden</small><div class="actions" style="margin-top:16px">${btn('balance.read')}${btn('report.export')}</div><div class="body" id="${bodyId('balance.read')}"></div><div class="body" id="${bodyId('report.export')}"></div></div>
        <div class="card c4"><h3>Quick actions</h3><p class="sub">Go to</p><div class="quick"><a href="#/transfers"><span class="ico">⇄</span>Transfer</a><a href="#/cards"><span class="ico">▭</span>Cards</a><a href="#/statements"><span class="ico">▤</span>Statements</a><a href="#/settings"><span class="ico">⚙</span>Settings</a></div></div>
        ${card({ title: 'Recent transactions', sub: 'Search or show all', res: 'transactions.search', actions: `<input data-q placeholder="e.g. rent" style="width:170px">${btn('transactions.search', null, true)}`, empty: 'Search to see transactions.' })}
        ${show('profile.read', { title: 'Personal details', sub: 'Name, contact, IBAN', w: 'c6', empty: 'Details hidden.' })}
        <div class="card c6"><h3>Cards</h3><p class="sub">Active card</p><div class="pay-card">NORTHSTAR BANK<br><br>•••• •••• •••• 2048<br><small style="opacity:.7">09/29 · VISA</small></div></div>` },
      { id: 'cards', icon: '▭', label: 'Cards', title: 'Cards', sub: 'One active card', html: () => `
        ${card({ title: 'Your card', sub: 'VISA debit · expires 09/29', w: 'c6', res: 'card.freeze', actions: btn('card.freeze'), html: '<div class="pay-card" style="margin-bottom:6px">NORTHSTAR BANK<br><br>•••• •••• •••• 2048<br><small style="opacity:.7">09/29 · VISA</small></div>' })}
        ${show('card.details', { sub: 'For paying online', w: 'c6', empty: 'Hidden until you ask.' })}` },
      { id: 'transfers', icon: '⇄', label: 'Transfers', title: 'Transfers', sub: 'Send money to a saved payee', html: () => `
        ${form('transfer.create', { title: 'New transfer', sub: 'Arrives today' })}
        ${show('payees.list', { sub: 'People and companies you paid before', w: 'c6' })}` },
      { id: 'statements', icon: '▤', label: 'Statements', title: 'Statements', sub: 'Last six months', html: () => `
        ${show('statements.list', { sub: 'Opening and closing balance per month' })}
        ${exportCard('report.export', 'Download a statement', 'Every transaction as a CSV file', 'c12')}` },
      { id: 'settings', icon: '⚙', label: 'Settings', title: 'Settings', sub: 'Contact details and security', html: () => `
        ${form('contact.update', { title: 'Contact e-mail', sub: 'Where statements and security alerts go' })}
        ${show('profile.read', { title: 'Personal details', sub: 'As we have them', w: 'c6', empty: 'Details hidden.' })}` },
    ],
    crm: [
      { id: 'contacts', icon: '◔', label: 'Contacts', title: 'Contacts', sub: '2,431 contacts', html: () => `
        ${show('contacts.read', { title: 'Contacts', sub: '2,431 contacts · showing the first 8', primary: false })}
        ${form('deals.update', { title: 'Update stage', sub: 'Move the first deal', w: 'c4' })}
        ${form('notes.create', { title: 'Add note', sub: 'On the first contact', w: 'c4' })}
        ${exportCard('contacts.export', 'Export all contacts', 'A CSV file with every contact', 'c4')}
        <div class="card c12 status" id="crm-status" aria-live="polite"><span class="k">last decision</span><span id="crm-status-text">nothing yet</span></div>
        <div class="card c12 try"><h3>Try it with an AI agent</h3><p class="sub">Paste this into Claude in Chrome, ChatGPT agent, Comet or any browser agent.</p><textarea id="crm-prompt" readonly rows="4"></textarea><div class="actions" style="margin-top:10px"><button class="primary" id="crm-copy">Copy prompt</button></div></div>` },
    ],
    enterprise: [
      { id: 'overview', icon: '○', label: 'Overview', title: 'Acme Robotics', sub: 'Workspace overview', html: () => `
        ${stat('Seats', '10 of 25', 'active members')}${stat('Plan', 'Enterprise', 'annual, renews 1 Feb 2027')}${stat('Single sign-on', 'Enforced', 'Okta · SAML 2.0')}
        ${show('users.list', { title: 'People', sub: 'Everyone in the workspace' })}
        ${show('invoices.list', { sub: 'Last six months' })}` },
      { id: 'users', icon: '◔', label: 'Users', title: 'Users', sub: 'Members, roles and invites', html: () => `
        ${show('users.list', { sub: 'Everyone in the workspace', primary: true })}
        ${form('user.invite', { sub: 'They get an e-mail to join' })}
        ${form('role.update', { sub: 'Owners and admins can change everything' })}` },
      { id: 'security', icon: '⚿', label: 'Security', title: 'Security', sub: 'Single sign-on and API keys', html: () => `
        ${show('sso.read', { sub: 'How members sign in' })}
        ${show('apikeys.read', { sub: 'Secrets that call the Northstar API', empty: 'Keys are hidden.' })}` },
      { id: 'billing', icon: '▭', label: 'Billing', title: 'Billing', sub: 'Invoices and payment', html: () => `
        ${show('invoices.list', { sub: 'Last six months' })}
        ${form('payment.update', { sub: 'Invoices are charged to this card' })}
        ${stat('Plan', 'Enterprise', '25 seats · annual', 'c6')}` },
      { id: 'audit', icon: '≡', label: 'Audit log', title: 'Audit log', sub: 'Every admin action', html: () => `
        ${exportCard('audit.export', 'Export the audit log', 'Who did what, when and from which IP address', 'c6')}
        <div class="card c6"><h3>What the log holds</h3><p class="sub">Kept for 12 months</p><div class="kv"><span>Sign-ins</span><strong>Yes</strong><span>Role changes</span><strong>Yes</strong><span>API key use</span><strong>Yes</strong><span>IP addresses</span><strong>Yes</strong></div></div>` },
    ],
  };

  // ------------------------------------------------------------ routing
  const pages = () => [...(PAGES[app.id] || PAGES.bank), AI_PAGE];
  const current = () => { const id = (location.hash.match(/^#\/([a-z-]+)/) || [])[1]; return pages().find((p) => p.id === id) || pages()[0]; };
  function renderPage() {
    const p = current();
    $('#page-title').textContent = p.title;
    $('#page-sub').textContent = p.sub;
    $('#content').innerHTML = p.html();
    $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === p.id));
    document.title = `${p.label} · ${app.name}`;
    window.scrollTo(0, 0);
    if (p.id === 'ai') { $('#ai-banner').hidden = true; renderAccess(); }
    if (app.id === 'crm' && p.id === 'contacts') startCrm();
  }

  // ------------------------------------------------------------ the CRM screen: contacts load on their own, the last decision stays in view, a prompt to try it
  function startCrm() {
    const u = new URL(location.href); u.hash = ''; u.searchParams.set('as', 'agent'); u.searchParams.set('scenario', 'all');
    $('#crm-prompt').value = `Open this link with your browser tool and wait 5 seconds: ${u.href}\n\nOn the Contacts page, read the table. Choose "Closed won" and click "Update stage". Type "Called, sending the proposal" and click "Add note". Then click "Export all contacts" (if it asks for the owner's approval, tell me and wait). Tell me what you could see and what was held back.`;
    $('#crm-copy').onclick = async () => { try { await navigator.clipboard.writeText($('#crm-prompt').value); toast('Prompt copied. Paste it into your AI agent'); } catch { toast('Could not copy. Select the text and copy it'); } };
    run('contacts.read', $('[data-res="contacts.read"]'));
    showLastDecision();
  }
  const SAID = { allow: 'allowed', mask: 'private fields hidden', step_up: 'ask the person first', block: 'not shared' };
  function showLastDecision() {
    const el = $('#crm-status-text'); const d = lastDecisions[0];
    if (!el || !d) return;
    el.textContent = `${d.resource} → ${(d.reasonCodes || []).includes('STEP_UP_PASSED') ? 'approved by the person' : SAID[d.decision] || d.decision} · signed`;
  }
  window.addEventListener('hashchange', () => { if (app) renderPage(); });

  // ------------------------------------------------------------ actions
  async function run(resource, button) {
    const def = R(resource);
    const body = document.getElementById(bodyId(resource)) || $('#content');
    const scope = (button && button.closest('.card')) || body.closest('.card') || document;
    const params = new URLSearchParams();
    const qInput = scope.querySelector('[data-q]'); if (qInput) params.set('q', qInput.value);
    $$('[data-field]', scope).forEach((el) => params.set(`f.${el.dataset.field}`, el.value));
    const extra = params.toString() ? `&${params}` : '';
    if (button) button.disabled = true;
    try {
      const res = await load(resource, extra, def.method);
      const retry = () => run(resource, button);
      if (res.ok) {
        if (def.view === 'download') { $$('.notice', body).forEach((n) => n.remove()); await download(res, body); if (res.masked) noticeFor(res, body, resource, retry); return; }
        render(resource, def, res, body);
      } else {
        if (resource === 'balance.read' && res.blocked && $('#bank-amount')) { $('#bank-amount').textContent = '$ ••••'; $('#bank-note').textContent = 'Balance protected'; }
      }
      noticeFor(res, body, resource, retry);
    } catch (e) {
      toast(e.message);
    } finally {
      if (button) button.disabled = false;
      pollResults();
    }
  }

  /** Only data an agent must not see is marked for the SDK to seal when one attaches. What the rules let an agent
   *  read (onAgent: allow) and the result of an action stay on screen; everything else is 'full' or 'masked'. */
  let sensitiveNow = true;
  const sensitivity = (resource, def, res) => { const rule = (app.rules || []).find((r) => r.resource === resource); return def.method === 'POST' || (rule && rule.onAgent === 'allow') ? null : res.masked ? 'masked' : 'full'; };
  const setSensitive = (el) => { if (!el) return; if (sensitiveNow === null) el.removeAttribute('data-oh-sensitive'); else el.setAttribute('data-oh-sensitive', sensitiveNow); };
  /** elements outside the card body that show protected values (hero amount, KPIs) */
  const mark = (sels) => sels.forEach((sel) => setSensitive($(sel)));
  const shown = new Set(); // resources currently rendered with full data

  /** Only the e-mail and phone cells are marked: an agent that attaches loses those, and keeps names, companies, values and stages. */
  const contactsHtml = (t) => {
    const attr = sensitiveNow ? ` data-oh-sensitive="${sensitiveNow}"` : '';
    const head = t.columns.map((c) => `<th${c.align === 'right' ? ' style="text-align:right"' : ''}>${esc(c.label)}</th>`).join('');
    const rows = t.rows.map((r) => `<tr>${t.columns.map((c) => {
      const v = r[c.key];
      if (c.key === 'email' || c.key === 'phone') return `<td${attr}>${esc(v)}</td>`;
      return `<td${c.align === 'right' ? ' style="text-align:right"' : ''}>${cell(v, c)}</td>`;
    }).join('')}</tr>`).join('');
    return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
  };

  function render(resource, def, res, body) {
    sensitiveNow = sensitivity(resource, def, res);
    if (resource === 'contacts.read') {
      body.removeAttribute('data-oh-sensitive');
      if (sensitiveNow === 'full') shown.add(resource);
      body.innerHTML = contactsHtml(res.data);
      return;
    }
    setSensitive(body);
    if (sensitiveNow === 'full') shown.add(resource);
    const d = res.data;
    if (resource === 'balance.read' && $('#bank-amount')) { $('#bank-amount').textContent = money(d.value, d.unit); $('#bank-note').textContent = d.note || ''; body.innerHTML = ''; mark(['#bank-amount', '#bank-note']); return; }
    if (def.view === 'kv') body.innerHTML = kvHtml(d);
    else if (def.view === 'table') body.innerHTML = tableHtml(d);
    else if (def.view === 'number') body.innerHTML = `<div class="kpi">${money(d.value, d.unit)}</div><div class="kpi-sub">${esc(d.note || '')}</div>`;
    else if (def.view === 'text') body.innerHTML = `<div class="result${def.method === 'POST' ? ' ok' : ''}"><strong>${esc(d.title)}</strong>${(d.paragraphs || []).map((p) => `<p>${esc(p)}</p>`).join('')}</div>`;
  }

  function openDrawer(html) { $('#drawer-body').innerHTML = html; $('#drawer').classList.add('open'); $('#scrim').classList.add('open'); }
  function closeDrawer() { $('#drawer').classList.remove('open'); $('#scrim').classList.remove('open'); }
  $('#drawer-close').onclick = closeDrawer; $('#scrim').onclick = closeDrawer;

  document.addEventListener('click', (e) => { const b = e.target.closest('button[data-res]'); if (b) run(b.dataset.res, b); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target || !e.target.matches('[data-q],[data-field]')) return;
    e.preventDefault();
    const b = e.target.closest('.card') && e.target.closest('.card').querySelector('button[data-res]');
    if (b) run(b.dataset.res, b);
  });

  // ------------------------------------------------------------ test panel
  const tester = $('#tester');
  let scenario = null;
  let resultsSeen = 0;
  let lastDecisions = [];
  const isOpen = () => tester.classList.contains('open');
  function openTester(tab) {
    tester.classList.add('open'); tester.setAttribute('aria-hidden', 'false'); document.body.classList.add('testing'); $('#fab').classList.add('hidden');
    if (tab) selectTab(tab);
    pollResults();
  }
  function closeTester() { tester.classList.remove('open'); tester.setAttribute('aria-hidden', 'true'); document.body.classList.remove('testing'); $('#fab').classList.remove('hidden'); }
  function selectTab(tab) {
    $$('.t-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    $('#tab-agent').hidden = tab !== 'agent'; $('#tab-results').hidden = tab !== 'results';
    if (tab === 'results') { resultsSeen = lastDecisions.length; updateBadge(); }
  }
  $('#fab').onclick = () => openTester();
  $('#tester-close').onclick = closeTester;
  $$('.t-tabs button').forEach((b) => { b.onclick = () => selectTab(b.dataset.tab); });
  $$('[data-goto]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); selectTab(a.dataset.goto); }; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if ($('#drawer').classList.contains('open')) closeDrawer(); else if (isOpen()) closeTester(); }
    if ((e.key === 'a' || e.key === 'A') && !e.metaKey && !e.ctrlKey && !/input|textarea|select/i.test((e.target && e.target.tagName) || '')) (isOpen() ? closeTester : openTester)();
  });

  const agentUrl = () => { const u = new URL(location.href); u.hash = ''; u.searchParams.set('as', 'agent'); u.searchParams.set('scenario', scenario.id); return u.href; };
  function renderScenario() {
    $$('#scenarios button').forEach((b) => { b.classList.toggle('on', b.dataset.id === scenario.id); b.setAttribute('aria-checked', String(b.dataset.id === scenario.id)); });
    const url = agentUrl();
    $('#prompt-steps').innerHTML = ['Open the demo link and wait 5 seconds', ...scenario.steps].map((st, i) => `<li><b>${String(i + 1).padStart(2, '0')}</b><span>${esc(st)}</span></li>`).join('');
    $('#prompt').value = `Open this page with your browser tool: ${url}

This is a demo app called ${app.name}. All data is synthetic. Use only the visible interface: the left menu and the buttons. Do not call APIs directly.

1. After the page loads, wait 5 seconds.
${scenario.steps.map((st, i) => `${i + 2}. ${st}`).join('\n')}

At the end, write briefly what you saw at each step: shown, hidden, waiting for my approval, or not shared.`;
  }
  function renderScenarios() {
    $('#scenarios').innerHTML = app.scenarios.map((s) => `<button type="button" role="radio" data-id="${esc(s.id)}"><strong>${esc(s.title)}</strong><span>${esc(s.summary)}</span></button>`).join('');
    $$('#scenarios button').forEach((b) => { b.onclick = () => { scenario = app.scenarios.find((s) => s.id === b.dataset.id); renderScenario(); }; });
    const wanted = new URL(location.href).searchParams.get('scenario');
    scenario = app.scenarios.find((s) => s.id === wanted) || app.scenarios[0];
    renderScenario();
  }
  $('#copy-prompt').onclick = async () => { try { await navigator.clipboard.writeText($('#prompt').value); toast('Prompt copied. Paste it into your AI agent'); } catch { toast('Could not copy. Open "Show the full prompt" and select it'); } };
  $('#copy-link').onclick = async () => { try { await navigator.clipboard.writeText(agentUrl()); toast('Agent link copied'); } catch { /* ignore */ } };
  $('#res-new').onclick = (e) => { e.preventDefault(); location.href = `/${app.id}`; };

  // Results: every decision the server made in this demo room, newest first, in plain words.
  const WHO = { agent_likely: ['AI agent', 'agent'], human_like: ['Person', 'person'], unknown: ['Not sure yet', ''] };
  const OUTCOME = { allow: ['Allowed', 'ok'], mask: ['Hidden', 'warn'], step_up: ['Waiting for approval', 'info'], block: ['Not shared', 'bad'] };
  const outcome = (d) => (d.reasonCodes || []).includes('STEP_UP_PASSED') ? ['Approved by the owner', 'ok'] : OUTCOME[d.decision] || [d.decision, ''];
  const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  function renderResults(decisions) {
    $('#res-count').textContent = decisions.length ? String(decisions.length) : '';
    if (!decisions.length) { $('#res-sum').innerHTML = ''; $('#res-list').innerHTML = '<div class="empty">No actions yet. Click a button on the page, or run the agent prompt.</div>'; return; }
    const group = (actor) => { const ds = decisions.filter((d) => (actor === 'agent_likely' ? d.actor === 'agent_likely' : d.actor !== 'agent_likely')); const n = (k) => ds.filter((d) => outcome(d)[0] === k).length; return { total: ds.length, allowed: n('Allowed') + n('Approved by the owner'), hidden: n('Hidden'), asked: n('Waiting for approval'), closed: n('Not shared') }; };
    const tile = (title, g, cls) => `<div class="tile ${cls}"><b>${esc(title)}</b><span>${g.total} action${g.total === 1 ? '' : 's'}</span><small>${[g.allowed && `${g.allowed} allowed`, g.hidden && `${g.hidden} hidden`, g.asked && `${g.asked} asked the owner`, g.closed && `${g.closed} not shared`].filter(Boolean).join(' · ') || 'nothing yet'}</small></div>`;
    $('#res-sum').innerHTML = tile('AI agent', group('agent_likely'), 'agent') + tile('People and unsure', group('other'), 'person');
    $('#res-list').innerHTML = decisions.map((d) => {
      const [who, wcls] = WHO[d.actor] || [d.actor, '']; const [out, ocls] = outcome(d);
      return `<div class="r"><span class="t">${hhmm(d.created)}</span><span class="w ${wcls}">${esc(who)}${me && d.session === me.session ? ' <em>this tab</em>' : ''}</span><span class="a">${esc(R(d.resource).title)}</span><span class="o chip ${ocls}">${esc(out)}</span></div>`;
    }).join('');
  }
  function updateBadge() {
    const fresh = Math.max(0, lastDecisions.length - resultsSeen);
    const c = $('#fab-count'); c.hidden = !fresh; c.textContent = String(fresh);
  }
  let polling = false, pollAgain = false;
  async function pollResults() {
    if (!room) return;
    if (polling) { pollAgain = true; return; }   // a decision made while a poll is in flight is picked up right after it
    polling = true;
    try {
      const r = await fetch(`/api/v1/journal${q}`, { cache: 'no-store' });
      if (r.ok) {
        const d = await r.json();
        lastDecisions = (d.decisions || []).slice().sort((a, b) => b.created - a.created);
        renderResults(lastDecisions);
        showLastDecision();
        if (isOpen() && !$('#tab-results').hidden) resultsSeen = lastDecisions.length;
        updateBadge();
      }
    } catch { /* offline: keep what we have */ } finally { polling = false; if (pollAgain) { pollAgain = false; pollResults(); } }
  }
  setInterval(() => { if (document.visibilityState === 'visible') pollResults(); }, 4000);

  // ------------------------------------------------------------ boot
  async function boot() {
    const [meR, appsR] = await Promise.all([fetch(`/api/v1/session${q}`, { cache: 'no-store', headers: SH() }), fetch('/api/v1/apps', { cache: 'no-store' })]);
    if (!meR.ok) { $('#content').innerHTML = '<div class="card c12"><h3>Session not found</h3><p class="sub">Reload the page.</p></div>'; return; }
    me = await meR.json();
    const apps = (await appsR.json()).apps;
    app = apps.find((a) => a.id === (me.app || appId)) || apps.find((a) => a.id === appId) || apps[0];
    document.documentElement.style.setProperty('--accent', app.accent);
    document.documentElement.style.setProperty('--accent-soft', app.accent + '22');
    $('#logo').textContent = app.initials; $('#brand-name').textContent = app.name;
    $('#user-av').textContent = app.id === 'enterprise' ? 'AR' : 'AB'; $('#user-name').textContent = me.label === 'agent' ? 'Agent test' : app.id === 'enterprise' ? 'Workspace admin' : app.id === 'crm' ? 'Sales manager' : 'Customer'; $('#user-sub').textContent = app.accountTitle;
    $('#nav').innerHTML = pages().map((p) => `<a href="#/${p.id}" data-page="${p.id}"><span class="ico">${p.icon}</span>${esc(p.label)}</a>`).join('');
    renderPage();
    const human = new URL(location.href); human.hash = ''; human.searchParams.set('as', 'human'); human.searchParams.delete('scenario');
    $('#human-link').href = human.href;
    renderScenarios();
    if (me.connection) renderGuard(me.connection);
    const pk = document.createElement('button'); pk.className = 'ghost'; pk.id = 'pk-btn';
    pk.onclick = async () => { pk.disabled = true; try { await registerPasskey(); toast('Passkey registered'); } catch (e) { toast(e.message); pk.disabled = false; } };
    $('#pk-slot').appendChild(pk);
    await refreshPasskeys();
    if (window.OneHuman) { window.OneHuman.flush(); window.OneHuman.onAssessment((_a, _s, c) => { if (c) renderGuard(c); }); }
    setInterval(refreshGuard, 3000);
    pollResults();
    // The SDK sealed on-screen data because an agent attached: show it, then re-fetch what was open so the
    // server's hidden variant replaces the placeholders.
    document.addEventListener('onehuman:sealed', (e) => {
      const g = $('#guard'); g.className = 'guard agent'; g.lastElementChild.textContent = 'AI agent in this session · private data hidden';
      if (e.detail && e.detail.first) toast('An AI agent joined this session. Private data on screen was hidden');
      if ($('#bank-amount')) { $('#bank-amount').textContent = '$ ••••'; $('#bank-note').textContent = 'Balance protected'; }
      if (e.detail && e.detail.first) { const again = [...shown]; shown.clear(); setTimeout(() => { for (const r of again) if (document.getElementById(bodyId(r))) run(r, null); }, 400); }
    });
  }
  boot().catch((e) => { $('#content').innerHTML = `<div class="card c12"><h3>Error</h3><p class="sub">${esc(e.message)}</p></div>`; });
})();
