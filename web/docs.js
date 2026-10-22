// SPDX-License-Identifier: BUSL-1.1
/* Docs: one page at a time, grouped under tabs — theme, routing, search, on-this-page, copy. */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m) => { const t = $('#toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 1600); };

  document.documentElement.dataset.theme = 'dark';


  // ---------------------------------------------------------------- the map of the documentation
  // One entry per page. The tabs, the sidebar, the router, the pager and the search all read this,
  // so a new page is one line here plus its <section> in the HTML.
  const TABS = [
    { id: 'docs', label: 'Docs', icon: 'book' },
    { id: 'api', label: 'API Reference', icon: 'code' },
    { id: 'agent', label: 'Agent protocol', icon: 'bot' },
  ];
  const NAV = [
    { tab: 'docs', group: 'Get started', pages: [['overview', 'Overview', 'compass'], ['glance', 'In 60 seconds', 'alert'], ['concepts', 'Concepts', 'book'], ['how', 'How it works', 'flow'], ['quickstart', 'Quickstart', 'rocket']] },
    { tab: 'docs', group: 'Build', pages: [['policy', 'Policy reference', 'file'], ['masks', 'Masks, blocks, step-up', 'shield'], ['rollout', 'Rollout', 'steps']] },
    { tab: 'docs', group: 'Operate', pages: [['portal', 'Portal & telemetry', 'chart'], ['privacy', 'Privacy & data', 'lock']] },
    { tab: 'docs', group: 'More', pages: [['limits', 'Limits & honest caveats', 'alert'], ['faq', 'FAQ', 'help']] },
    { tab: 'api', group: 'Server', pages: [['api', 'Server API', 'code'], ['endpoints', 'HTTP endpoints', 'plug'], ['owner', 'Owner\'s control', 'key']] },
    { tab: 'api', group: 'Browser', pages: [['sdk', 'Browser SDK', 'window']] },
    { tab: 'api', group: 'Account', pages: [['manage', 'Management API', 'key']] },
    { tab: 'agent', group: 'For AI agents', pages: [['agent', 'Agent protocol', 'bot']] },
  ];
  const ICON = {
    compass: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
    book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H19v3H6.5"/>',
    flow: '<rect x="3" y="4" width="7" height="5" rx="1.5"/><rect x="14" y="15" width="7" height="5" rx="1.5"/><path d="M6.5 9v5.5a2 2 0 0 0 2 2H14"/>',
    rocket: '<path d="M5 15c-1 2-1 5-1 5s3 0 5-1"/><path d="M13.5 4.5C16 2 21 3 21 3s1 5-1.5 7.5L14 16l-6-6z"/><circle cx="15" cy="9" r="1.3"/>',
    file: '<path d="M14 3v5h5"/><path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z"/>',
    shield: '<path d="M12 3l7 3v5.5c0 4.3-2.9 7.7-7 9.5-4.1-1.8-7-5.2-7-9.5V6z"/>',
    steps: '<path d="M4 20h4v-4h4v-4h4V8h4"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    lock: '<rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.01"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.2 2.4c-.6.2-.7.7-.7 1.3M12 16.5v.01"/>',
    code: '<path d="M9 7l-5 5 5 5M15 7l5 5-5 5"/>',
    plug: '<path d="M9 3v5M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v4"/>',
    window: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><circle cx="6.5" cy="6.5" r=".6"/>',
    key: '<circle cx="8" cy="12" r="4"/><path d="M12 12h9M18 12v3M15 12v2"/>',
    bot: '<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 4v4"/><circle cx="9.5" cy="13" r="1"/><circle cx="14.5" cy="13" r="1"/>',
  };
  const svg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[name] || ICON.file}</svg>`;

  const PAGES = NAV.flatMap((g) => g.pages.map(([id, title, icon]) => ({ id, title, icon, tab: g.tab, group: g.group })));
  const byId = (id) => PAGES.find((p) => p.id === id);
  const sections = Object.fromEntries($$('section[id]').map((s) => [s.id, s]));

  // ---------------------------------------------------------------- chrome built from the map
  $('#tabs').innerHTML = TABS.map((t) => `<button data-tab="${t.id}">${svg(t.icon)}${esc(t.label)}</button>`).join('');
  function renderSide(tab) {
    $('#side').innerHTML = NAV.filter((g) => g.tab === tab).map((g) => `<div class="side-group"><b>${esc(g.group)}</b>${
      g.pages.map(([id, title, icon]) => `<a href="#${id}" data-page="${id}">${svg(icon)}<span>${esc(title)}</span></a>`).join('')
    }</div>`).join('');
  }

  // ---------------------------------------------------------------- routing: one page at a time
  let current = '';
  function go(id) {
    const page = byId(id) || PAGES[0];
    current = page.id;
    $$('section[id]').forEach((s) => { s.hidden = s.id !== page.id; });
    $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === page.tab));
    renderSide(page.tab);
    $$('#side a').forEach((a) => a.classList.toggle('on', a.dataset.page === page.id));
    document.title = `${page.title} · OneHuman docs`;
    buildToc(sections[page.id]);
    buildPager(page);
    closeResults();
  }
  function buildToc(sec) {
    const heads = $$('h3', sec);
    heads.forEach((h, i) => { if (!h.id) h.id = `${sec.id}-${i}`; });
    $('#toc-links').innerHTML = heads.map((h) => `<a href="#${sec.id}" data-anchor="${h.id}">${esc(h.textContent)}</a>`).join('');
    $('#toc').hidden = !heads.length;
    $$('#toc-links a').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      const t = document.getElementById(a.dataset.anchor);
      if (t) t.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }));
  }
  function buildPager(page) {
    const i = PAGES.indexOf(page), prev = PAGES[i - 1], next = PAGES[i + 1];
    $('#pager').innerHTML = [
      prev ? `<a class="pg prev" href="#${prev.id}"><span>Previous</span><b>${esc(prev.title)}</b></a>` : '<span></span>',
      next ? `<a class="pg next" href="#${next.id}"><span>Next</span><b>${esc(next.title)}</b></a>` : '<span></span>',
    ].join('');
  }
  const idFromHash = () => (location.hash.replace('#', '') || 'overview');
  addEventListener('hashchange', () => { const id = idFromHash(); if (byId(id)) { go(id); scrollTo({ top: 0 }); } });
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]'); if (!b) return;
    const first = PAGES.find((p) => p.tab === b.dataset.tab);
    if (first) location.hash = first.id;
  });
  // links inside the prose that point at another page route through the same switch
  addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]'); if (!a || a.dataset.anchor) return;
    const id = a.getAttribute('href').slice(1);
    if (byId(id) && id === current) { e.preventDefault(); scrollTo({ top: 0, behavior: 'smooth' }); }
  });

  // ---------------------------------------------------------------- copy: a code block, or the page
  $$('.code').forEach((pre) => {
    const b = document.createElement('button'); b.className = 'copy'; b.textContent = 'Copy';
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(pre.textContent.replace(/(Copy|Copied)$/, '').trim()); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1400); }
      catch { toast('Select the text and copy'); }
    });
    pre.appendChild(b);
  });
  // every page gets the same affordance at the top: take this page away as text
  $$('section[id]').forEach((sec) => {
    const head = sec.querySelector('h1, h2'); if (!head) return;
    const bar = document.createElement('div'); bar.className = 'page-actions';
    const b = document.createElement('button'); b.className = 'btn ghost small'; b.innerHTML = `${svg('file')}Copy page`;
    b.addEventListener('click', async () => {
      const text = [...sec.children].filter((el) => !el.classList.contains('page-actions')).map((el) => el.innerText).join('\n\n').replace(/\n(Copy|Copied)\n/g, '\n');
      try { await navigator.clipboard.writeText(text); b.innerHTML = `${svg('file')}Copied`; setTimeout(() => (b.innerHTML = `${svg('file')}Copy page`), 1500); }
      catch { toast('Select the text and copy'); }
    });
    bar.appendChild(b);
    head.insertAdjacentElement('afterend', bar);
  });

  // ---------------------------------------------------------------- search across every page
  const search = $('#search'), results = $('#results');
  const closeResults = () => { results.hidden = true; results.innerHTML = ''; };
  const snippet = (text, q) => {
    const i = text.toLowerCase().indexOf(q);
    if (i < 0) return text.slice(0, 90);
    const from = Math.max(0, i - 35);
    return (from ? '…' : '') + text.slice(from, from + 110).trim() + '…';
  };
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    if (q.length < 2) return closeResults();
    const hits = PAGES.map((p) => {
      const sec = sections[p.id]; if (!sec) return null;
      const text = sec.innerText.replace(/\s+/g, ' ');
      if (!text.toLowerCase().includes(q) && !p.title.toLowerCase().includes(q)) return null;
      return { ...p, line: snippet(text, q) };
    }).filter(Boolean).slice(0, 8);
    results.innerHTML = hits.length
      ? hits.map((h) => `<a href="#${h.id}">${svg(h.icon)}<span><b>${esc(h.title)}</b><i>${esc(h.line)}</i></span><em>${esc(h.group)}</em></a>`).join('')
      : `<div class="no-hit">Nothing matches “${esc(search.value.trim())}”.</div>`;
    results.hidden = false;
  });
  results.addEventListener('click', () => { search.value = ''; closeResults(); });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { search.value = ''; closeResults(); search.blur(); }
    if (e.key === 'Enter') { const a = results.querySelector('a'); if (a) { location.hash = a.getAttribute('href').slice(1); search.value = ''; closeResults(); search.blur(); } }
  });
  addEventListener('click', (e) => { if (!e.target.closest('.search-wrap')) closeResults(); });
  addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); search.focus(); search.select(); }
    if (e.key === '/' && !/input|textarea/i.test((e.target && e.target.tagName) || '')) { e.preventDefault(); search.focus(); }
  });

  // ---------------------------------------------------------------- on-this-page follows the scroll
  addEventListener('scroll', () => {
    const anchors = $$('#toc-links a'); if (!anchors.length) return;
    const y = scrollY + 140;
    let on = anchors[0];
    for (const a of anchors) { const t = document.getElementById(a.dataset.anchor); if (t && t.offsetTop <= y) on = a; }
    anchors.forEach((a) => a.classList.toggle('on', a === on));
  }, { passive: true });

  go(idFromHash());
  // a deep link opens its page at the top, not wherever the browser's own anchor jump landed
  if (location.hash) { scrollTo({ top: 0 }); addEventListener('load', () => scrollTo({ top: 0 })); }
})();
