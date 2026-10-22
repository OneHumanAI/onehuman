// SPDX-License-Identifier: BUSL-1.1
/* Kursor sandbox: 10 hədəf, hər klikdə trayektoriya serverə göndərilir və qiymət geri gəlir. */
(() => {
  const $ = (s) => document.querySelector(s);
  const params = new URLSearchParams(location.search);
  const TOTAL = 10;
  const client = (() => {
    const k = 'oh-sandbox-client';
    try { const v = sessionStorage.getItem(k); if (v) return v; } catch {}
    const id = 'c-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
    try { sessionStorage.setItem(k, id); } catch {}
    return id;
  })();
  let label = params.get('as') === 'agent' ? 'agent' : params.get('as') === 'human' ? 'human' : null;
  let sourceParam = params.get('source');
  const isAgentApp = /\bClaude\/\d|\bCodex\/\d|ChatGPT/i.test(navigator.userAgent);

  const labKey = document.querySelector('meta[name="oh-lab-key"]')?.content || '';
  const promptText = `${location.origin}/sandbox?as=agent${labKey ? `&key=${encodeURIComponent(labKey)}` : ''} səhifəsini aç. Səhifədə bir nömrəli dairəvi düymə görünür. Ona kliklə; klikdən sonra başqa yerdə yeni nömrəli düymə çıxır. Bu şəkildə 1-dən 10-a qədər bütün düymələrə ardıcıl kliklə. Sonda "bitdi" yazısı çıxanda dayan və kodu mənə yaz.`;
  $('#agent-prompt').value = promptText;
  $('#copy-prompt').onclick = async () => { try { await navigator.clipboard.writeText(promptText); $('#copy-prompt').textContent = 'Kopyalandı ✓'; } catch { $('#agent-prompt').select(); } };
  $('#restart').onclick = () => { try { sessionStorage.removeItem('oh-sandbox-client'); } catch {} location.href = location.pathname + (label ? `?as=${label}` : ''); };

  // ------------------------------------------------ capture (same format as the SDK, v3)
  let points = [], down = null, coalesced = 0;
  const board = $('#board');
  // The hand's approach survives a reload of this tab: a person who refreshes and clicks without moving still
  // arrived here by hand. Kept 60 s at most, in this tab only (sessionStorage), never across sites.
  try {
    const saved = JSON.parse(sessionStorage.getItem('oh-approach-sandbox') || 'null');
    if (saved && Array.isArray(saved.p) && Date.now() - saved.at < 60000) {
      const shift = performance.now() - (Date.now() - saved.at) - saved.span; // map absolute ages onto this page's clock
      for (const q of saved.p) points.push({ t: shift + q[0], x: q[1], y: q[2] });
    }
    sessionStorage.removeItem('oh-approach-sandbox');
  } catch { /* ignore */ }
  window.addEventListener('pagehide', () => {
    try { const p = points.slice(-60); if (p.length) sessionStorage.setItem('oh-approach-sandbox', JSON.stringify({ at: Date.now(), span: p[p.length - 1].t - p[0].t, p: p.map((q) => [Math.round(q.t - p[0].t), Math.round(q.x), Math.round(q.y)]) })); } catch { /* ignore */ }
  });
  const opts = { capture: true, passive: true };
  board.addEventListener('pointermove', (e) => {
    const t = performance.now();
    points.push({ t, x: e.clientX, y: e.clientY });
    if (typeof e.getCoalescedEvents === 'function') { try { coalesced += e.getCoalescedEvents().length || 1; } catch { coalesced += 1; } } else coalesced += 1;
    if (points.length > 240) points = points.slice(-240);
  }, opts);
  board.addEventListener('pointerdown', (e) => {
    down = { t: performance.now(), pointer: e.pointerType, pressure: typeof e.pressure === 'number' ? Math.round(e.pressure * 1000) / 1000 : null, hidden: document.visibilityState === 'hidden' };
    // the press position closes the approach: on a fast move the last pointermove can lag the press by a frame
    if (e.pointerType === 'mouse') points.push({ t: performance.now(), x: e.clientX, y: e.clientY });
  }, opts);
  function buildClick(e, el) {
    const t = performance.now();
    const p = points.slice(-240);
    let path = 0;
    for (let i = 1; i < p.length; i++) path += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
    const r = el.getBoundingClientRect();
    const click = {
      trusted: e.isTrusted, pointer: (down && down.pointer) || e.pointerType || '', detail: Math.min(10, e.detail),
      holdMs: down ? Math.round(t - down.t) : null, moves: p.length, path: Math.round(path),
      travelMs: p.length > 1 ? Math.round(p[p.length - 1].t - p[0].t) : 0,
      pressure: down ? down.pressure : null, hidden: down ? down.hidden : document.visibilityState === 'hidden',
      traj: p.map((q) => [Math.round((q.t - t) * 10) / 10, Math.round(q.x), Math.round(q.y)]),
      downMs: down ? Math.round((down.t - t) * 10) / 10 : null,
      target: { w: Math.round(r.width), h: Math.round(r.height), dx: Math.round((e.clientX - (r.left + r.width / 2)) * 10) / 10, dy: Math.round((e.clientY - (r.top + r.height / 2)) * 10) / 10 },
      coalesced,
      at: [Math.round(e.clientX), Math.round(e.clientY)],
    };
    down = null; coalesced = 0;
    return click;
  }

  // ------------------------------------------------ flow
  let step = 0, results = [];
  const whoPill = $('#who-pill');
  function setWho() {
    whoPill.className = 'pill ' + (label === 'agent' ? 'agent' : 'human');
    whoPill.lastElementChild.textContent = label === 'agent' ? 'AI agent klikləyir' : 'İnsan klikləyir';
    $('#who').hidden = true; $('#run').hidden = false;
    if (label === 'agent') { $('#source').innerHTML = `<option value="${isAgentApp ? 'agent-app-browser' : 'agent-chrome'}">${isAgentApp ? 'AI tətbiqinin brauzeri' : 'Chrome (genişləndirmə)'}</option>`; }
    else if (isAgentApp) $('#source').value = 'claude-pane-human';
    if (sourceParam && /^[a-z0-9_.-]{1,40}$/i.test(sourceParam)) { const o = document.createElement('option'); o.value = sourceParam; o.textContent = sourceParam; o.selected = true; $('#source').appendChild(o); }
    placeTarget();
  }
  $('#as-human').onclick = () => { label = 'human'; history.replaceState(null, '', '?as=human'); setWho(); };
  $('#as-agent').onclick = () => { label = 'agent'; history.replaceState(null, '', '?as=agent'); setWho(); };
  if (label) setWho();

  function placeTarget() {
    $('#hint').hidden = true;
    const old = board.querySelector('.target'); if (old) old.remove();
    if (step >= TOTAL) return finish();
    const bw = board.clientWidth, bh = board.clientHeight;
    if (bw < 200 || bh < 200) { requestAnimationFrame(placeTarget); return; }
    const size = 44 + Math.round(Math.random() * 70);
    const b = document.createElement('button');
    b.className = 'target' + (Math.random() < 0.35 ? ' sq' : '');
    b.style.width = b.style.height = size + 'px';
    b.style.left = Math.round(10 + Math.random() * Math.max(0, bw - size - 20)) + 'px';
    b.style.top = Math.round(10 + Math.random() * Math.max(0, bh - size - 20)) + 'px';
    b.textContent = String(step + 1);
    b.setAttribute('aria-label', `Düymə ${step + 1}`);
    b.addEventListener('click', (e) => onTarget(e, b), { once: true });
    board.appendChild(b);
    $('#progress').textContent = `${step}/${TOTAL}`;
  }

  async function onTarget(e, el) {
    const click = buildClick(e, el);
    window.OneHumanHud?.trace(click.traj, click.at);
    step++;
    placeTarget();
    const chip = document.createElement('span'); chip.className = 'res'; chip.textContent = `${step} …`; $('#results').appendChild(chip);
    try {
      const r = await fetch('/api/v1/sandbox/samples', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client, label, source: $('#source').value, task: `target-${step}`, click }) });
      const d = await r.json();
      const v = d.judgement ? d.judgement.verdict : 'uncertain';
      results.push({ step, v, d });
      window.OneHumanHud?.show(d, `target-${step}`);
      chip.className = 'res ' + v;
      chip.textContent = `${step} · ${v === 'human' ? 'insan' : v === 'synthetic' ? 'sintetik' : 'qeyri-müəyyən'}`;
      chip.title = `${d.judgement.flags.join(', ')} | n=${d.features.n} straight=${d.features.straightness} dtCv=${d.features.dtCv} tremor=${d.features.tremor} hold=${d.features.holdMs} pr=${d.features.pressure} off=${d.features.centreOffset}`;
    } catch { chip.textContent = `${step} · göndərilmədi`; }
    if (step >= TOTAL) finish();
  }

  function finish() {
    window.OneHumanHud?.hide();
    $('#progress').textContent = `${TOTAL}/${TOTAL} · bitdi`;
    $('#hint').hidden = false; $('#hint').textContent = 'Bitdi. Təşəkkür!';
    const s = $('#summary'); s.hidden = false;
    const h = results.filter((r) => r.v === 'human').length, a = results.filter((r) => r.v === 'synthetic').length, u = results.length - h - a;
    s.className = 'summary ' + ((label === 'human' ? a : h) === 0 ? 'ok' : 'bad');
    s.innerHTML = `<h2>bitdi</h2><div class="tiles"><div class="tile g"><b>${h}</b><small>insan</small></div><div class="tile r"><b>${a}</b><small>sintetik</small></div><div class="tile a"><b>${u}</b><small>qeyri-müəyyən</small></div></div><p>Kod: <span class="code" id="code">${client}</span> <button class="ghost" id="copy-code" style="padding:6px 12px;margin-left:8px">Kodu kopyala</button></p>`;
    $('#copy-code').onclick = async () => { try { await navigator.clipboard.writeText(client); $('#copy-code').textContent = 'Kopyalandı ✓'; } catch {} };
    loadStats();
  }

  async function loadStats() {
    try {
      const d = await (await fetch('/api/v1/sandbox/stats')).json();
      const rows = d.groups.map((g) => `<tr><td>${g.label}</td><td>${g.source}</td><td>${g.verdict}</td><td style="text-align:right">${g.n}</td></tr>`).join('');
      $('#stats').innerHTML = `<b>Toplanan nümunələr (${d.version})</b><table><thead><tr><th>Etiket</th><th>Mənbə</th><th>Qiymət</th><th style="text-align:right">Say</th></tr></thead><tbody>${rows}</tbody></table>`;
    } catch {}
  }
  loadStats();
})();
