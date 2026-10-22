// SPDX-License-Identifier: BUSL-1.1
/* The AI agent permissions generator (/ai-agent-permissions-generator). Runs only in the browser: what a visitor
   picks never leaves the page; the share link carries it after the #. Rules and HTML come from permissions-core.js,
   the same code that wrote the default result into the page. */
(() => {
  const P = window.OneHumanPermissions;
  const $ = (s) => document.querySelector(s);
  if (!P || !$('#pg-matrix')) return;

  const state = P.initial();

  // ------------------------------------------------------------------ choices: one listener per box
  const on = (sel, attr, fn) => $(sel).addEventListener('click', (e) => { const b = e.target.closest(`button[${attr}]`); if (b) { fn(b.getAttribute(attr)); paint(); } });
  on('#pg-presets', 'data-id', (id) => { state.preset = id; state.on = new Set([...P.PRESETS[id].r, ...state.custom.map((c) => c.id)]); state.edits = {}; });
  on('#pg-stance', 'data-id', (id) => { state.stance = id; state.edits = {}; });
  on('#pg-mode', 'data-id', (id) => { state.mode = id; });
  on('#pg-res', 'data-res', (id) => { state.on.has(id) ? state.on.delete(id) : state.on.add(id); });
  on('#pg-matrix', 'data-cell', (cell) => { const [id, branch] = cell.split(':'); const next = P.nextAnswer(state, id, branch); if (next) state.edits[cell] = next; });

  $('#pg-add').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#pg-add-name'); const title = input.value.trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!title) { input.focus(); return; }
    const cls = $('#pg-add-cls').value;
    const id = P.customId(title, cls);
    if (!id) { toast('Use letters or digits in the name'); return; }
    if (!P.all(state).some((r) => r.id === id)) {
      if (P.all(state).length >= 50) { toast('50 rules at most'); return; }
      state.custom.push({ id, title, cls });
    }
    state.on.add(id); input.value = ''; paint();
  });

  const tabs = [...document.querySelectorAll('.pg-tabs [role="tab"]')];
  tabs.forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; paint(); }));
  $('.pg-tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = tabs.findIndex((t) => t.dataset.tab === state.tab);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]; state.tab = next.dataset.tab; paint(); next.focus();
  });
  $('#pg-reset').addEventListener('click', () => { state.edits = {}; paint(); });
  // the # holds the choices, so the jump to the result scrolls instead of following the link
  $('#pg-jump').addEventListener('click', (e) => { e.preventDefault(); $('#result').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); });

  // ------------------------------------------------------------------ actions
  const toastEl = $('#toast'); let toastT;
  function toast(m) { if (!toastEl) return; toastEl.textContent = m; toastEl.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), 1800); }
  async function copy(text, msg) { try { await navigator.clipboard.writeText(text); toast(msg); } catch { toast('Could not copy'); } }
  $('#pg-copy').addEventListener('click', () => copy(P.output(state, P.rules(state)), 'Copied'));
  $('#pg-share').addEventListener('click', () => copy(location.href, 'Link copied'));
  $('#pg-download').addEventListener('click', () => {
    const list = P.rules(state); if (!list.length) return;
    const [name, type] = P.download(state, list);
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([P.output(state, list) + '\n'], { type })), download: name });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // ------------------------------------------------------------------ the share link: everything after the #
  function save() {
    const q = new URLSearchParams({ p: state.preset, s: state.stance, m: state.mode, r: [...state.on].join(',') });
    if (state.custom.length) q.set('x', state.custom.map((c) => `${c.cls}~${c.title}`).join('|'));
    const e = Object.entries(state.edits); if (e.length) q.set('e', e.map(([k, v]) => `${k}:${v}`).join(','));
    history.replaceState(null, '', `#${q}`);
  }
  function load() {
    const q = new URLSearchParams(location.hash.slice(1)); if (!q.has('p')) return;
    if (P.PRESETS[q.get('p')]) state.preset = q.get('p');
    if (P.STANCES[q.get('s')]) state.stance = q.get('s');
    if (P.MODES[q.get('m')]) state.mode = q.get('m');
    for (const part of (q.get('x') ?? '').split('|').filter(Boolean).slice(0, 34)) {
      const [cls, ...rest] = part.split('~'); const title = rest.join('~').trim().replace(/\s+/g, ' ').slice(0, 60); const id = P.customId(title, cls);
      if (id && !P.all(state).some((r) => r.id === id)) state.custom.push({ id, title, cls });
    }
    const known = new Set(P.all(state).map((r) => r.id));
    state.on = new Set((q.get('r') ?? '').split(',').filter((id) => known.has(id)));
    for (const pair of (q.get('e') ?? '').split(',').filter(Boolean)) {
      const [id, k, v] = pair.split(':');
      if (known.has(id) && P.BRANCHES.some(([b]) => b === k) && P.ANSWER[v]) state.edits[`${id}:${k}`] = v;
    }
  }

  /** The button that had focus, found again after its box is redrawn. */
  function focusKey() {
    const f = document.activeElement; if (!f || f.tagName !== 'BUTTON') return null;
    for (const attr of ['data-cell', 'data-res', 'data-id']) {
      const v = f.getAttribute(attr); const box = f.closest('[id]');
      if (v && box) return `#${CSS.escape(box.id)} [${attr}="${CSS.escape(v)}"]`;
    }
    return null;
  }
  function paint() {
    const refocus = focusKey();
    for (const [id, html] of Object.entries(P.render(state))) { const n = document.getElementById(id); if (n && n.innerHTML !== html) n.innerHTML = html; }
    const list = P.rules(state);
    $('#pg-reset').hidden = !Object.keys(state.edits).length;
    tabs.forEach((b) => { const sel = b.dataset.tab === state.tab; b.setAttribute('aria-selected', String(sel)); b.tabIndex = sel ? 0 : -1; });
    $('#pg-code').setAttribute('aria-labelledby', `tab-${state.tab}`);
    for (const id of ['#pg-copy', '#pg-download']) $(id).disabled = !list.length;
    $('#pg-download').textContent = state.tab === 'json' ? 'Download .json' : 'Download .txt';
    if (refocus) document.querySelector(refocus)?.focus();
    save();
  }

  load();
  paint();
})();
