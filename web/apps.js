// SPDX-License-Identifier: BUSL-1.1
/* The three demo apps (bank, CRM, workspace): a card each, and a button that opens the live demo in a new tab. Used on the homepage and the product page. */
(async () => {
  const box = document.getElementById('apps'); if (!box) return;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let apps = [];
  try { apps = (await (await fetch('/api/v1/apps', { cache: 'no-store' })).json()).apps; } catch {}
  // one small picture per demo app, drawn like the homepage cells
  const ILL = {
    bank: '<div class="bk"><i class="chip"></i><span class="num">•••• •••• •••• 4821</span><span class="bal"><em>balance</em><b>$4,939.10</b></span></div>',
    crm: '<div class="cr">' + [['AL', 'Ada Lindqvist', 'a•••@example.com', 'Proposal'], ['OH', 'Omar Haddad', 'o•••@example.com', 'Lead'], ['PC', 'Priya Chen', 'p•••@example.com', 'Won']].map(([i, n, e, t]) => `<div class="cr-row"><i class="av">${i}</i><span><b>${n}</b><em>${e}</em></span><span class="tag">${t}</span></div>`).join('') + '</div>',
    enterprise: '<div class="ws"><div class="ws-side"><i></i><i></i><i></i><i></i></div><div class="ws-main"><div class="ws-top"><i></i><span class="ws-btn">+ invite</span></div>' + ['admin', 'member', 'member'].map((r) => `<div class="ws-row"><b></b><i></i><em>${r}</em></div>`).join('') + '</div></div>',
  };
  box.innerHTML = apps.map((a) => {
    return `<div class="app">
      <h3>${esc(a.name)}</h3>
      <p>${esc(a.tagline)}</p>
      <div class="ill ill-app" aria-hidden="true">${ILL[a.id] || ''}</div>
      <div class="row"><a class="btn primary" href="/${esc(a.id)}" target="_blank" rel="noopener">Open live demo <span class="arrow">↗</span></a></div>
    </div>`;
  }).join('') || '<div class="app"><p>Demo apps are offline right now.</p></div>';
})();
