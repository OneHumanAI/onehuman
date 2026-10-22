// The /scan page: paste a public repository, see two findings at once, an e-mail address shows the rest.
(() => {
  const $ = (s) => document.querySelector(s);
  const LABEL = { 'leaves-behind': 'Leaves something behind', 'bulk-export': 'Bulk export', money: 'Moves money', 'private-data': 'Private data' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let current = null;

  async function post(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || 'Something went wrong. Try again.');
    return j;
  }
  const show = (el, text) => { el.textContent = text || ''; el.hidden = !text; };

  function render(v) {
    current = v;
    $('#sc-result').hidden = false;
    $('#sc-title').textContent = v.total ? `${v.repo}: ${v.total} thing${v.total === 1 ? '' : 's'} an AI agent can do as your customer` : `${v.repo}: nothing stood out`;
    $('#sc-meta').textContent = `${v.filesScanned.toLocaleString('en-US')} files · ${v.routes.toLocaleString('en-US')} entry points · ${v.frameworks.join(', ') || 'no known framework'}`;
    const list = $('#sc-list');
    list.innerHTML = v.total
      ? v.findings.map((f) => `<li class="sc-item sc-k-${esc(f.kind)}"><span class="sc-kind"><i></i>${esc(LABEL[f.kind] || f.kind)}</span><h3>${esc(f.title)}</h3><p>${esc(f.why)}</p><div class="sc-where"><b>${esc(f.method)} ${esc(f.path)}</b>${f.file ? ` · ${esc(f.file)}:${f.line}` : ''}</div></li>`).join('')
      : '<li class="sc-empty">We found no bulk exports, money actions or tokens a signed-in agent could reach in the code we could read. That says little about what is behind them: run <code>npx onehumanai scan</code> in the project for the full picture.</li>';
    const locked = v.locked > 0;
    $('#sc-lock').hidden = !locked || v.unlocked;
    if (locked) $('#sc-lock-title').textContent = `${v.locked} more ${v.locked === 1 ? 'finding' : 'findings'} in the full map`;
    $('#sc-next').hidden = !(v.unlocked || !locked);
    if (v.unlocked) $('#sc-sent').textContent = v.mailed === 'sent' ? 'The full map is on its way to your inbox.' : 'This is the full map.';
    else if (!locked) $('#sc-sent').textContent = 'That is everything we found.';
    $('#sc-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $('#sc-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const go = $('#sc-go'); show($('#sc-err'), '');
    go.disabled = true; go.textContent = 'Scanning…';
    try { render(await post('/api/v1/scan', { repo: $('#sc-repo').value })); }
    catch (err) { show($('#sc-err'), err.message); }
    finally { go.disabled = false; go.textContent = 'Scan'; }
  });

  $('#sc-unlock').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!current) return;
    const btn = e.target.querySelector('button'); show($('#sc-unlock-err'), '');
    btn.disabled = true;
    try { render(await post('/api/v1/scan/unlock', { id: current.id, email: $('#sc-email').value })); }
    catch (err) { show($('#sc-unlock-err'), err.message); }
    finally { btn.disabled = false; }
  });
})();
