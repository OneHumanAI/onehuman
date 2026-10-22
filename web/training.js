// SPDX-License-Identifier: BUSL-1.1
/* Təlim mühiti: 13 tapşırıq, hər klik xam trayektoriya + kontekst ilə yazılır; sonda real qərar mühərriki addım-addım işlədilir. */
(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const params = new URLSearchParams(location.search);
  const client = (() => { const k = 'oh-training-client'; try { const v = sessionStorage.getItem(k); if (v) return v; } catch {} const id = 't-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36); try { sessionStorage.setItem(k, id); } catch {} return id; })();
  let label = params.get('as') === 'agent' ? 'agent' : params.get('as') === 'human' ? 'human' : null;
  const isAgentApp = /\bClaude\/\d|\bCodex\/\d|ChatGPT/i.test(navigator.userAgent);
  const t0 = performance.now();
  const now = () => Math.round(performance.now() - t0);

  const labKey = document.querySelector('meta[name="oh-lab-key"]')?.content || '';
  const labUrl = (path) => `${location.origin}${path}?as=agent${labKey ? `&key=${encodeURIComponent(labKey)}` : ''}`;
  const PROMPTS = {
    claude: `Brauzer alətinlə ${labUrl('/training')} səhifəsini aç. Səhifədə hər dəfə bir tapşırıq yazılır (məsələn "nömrəli düyməyə kliklə", "sahəyə mətn yaz və Göndər düyməsinə bas", "aşağı sürüşüb düyməni tap", "kartı sürüklə"). Tapşırığı olduğu kimi yerinə yetir; hər tapşırıqdan sonra növbətisi çıxır. Hamısı bitəndə "bitdi" yazısı və kod görünür — kodu mənə yaz. İlişsən, keç bilmirsənsə, nə ilişdiyini yaz və dayan.`,
    codex: `${labUrl('/training')} səhifəsini brauzerdə aç və ekranda yazılan tapşırıqları sırayla yerinə yetir (klik, mətn yazma, sürüşmə, seçim, sürükləmə). Hər tapşırıqdan sonra növbətisi görünür. Sonda "bitdi" və bir kod çıxır — kodu mənə göndər. Tapşırığı edə bilməsən, hansı olduğunu yaz.`,
    comet: `Open ${labUrl('/training')}. The page shows one task at a time (click a numbered button, type text and press Send, scroll down and click, choose from a list, drag a card). Do exactly what each task says; the next task appears after each one. When "bitdi" and a code appear, send me the code. If you get stuck, tell me which task and stop.`,
    generic: `Open ${labUrl('/training')} in your browser tool. Complete the on-screen tasks one by one (clicks, typing, scrolling, selecting, dragging). When the page says "bitdi" and shows a code, report the code.`,
  };
  let agentKind = 'claude';
  const setPrompt = () => { $('#agent-prompt').value = PROMPTS[agentKind]; };
  setPrompt();
  $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-agent]'); if (!b) return; agentKind = b.dataset.agent; $('#tabs').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); setPrompt(); });
  $('#copy-prompt').onclick = async () => { try { await navigator.clipboard.writeText($('#agent-prompt').value); $('#copy-prompt').textContent = 'Kopyalandı ✓'; setTimeout(() => ($('#copy-prompt').textContent = 'Promptu kopyala'), 1800); } catch {} };
  $('#restart').onclick = () => { try { sessionStorage.removeItem('oh-training-client'); sessionStorage.removeItem('oh-training-steps'); } catch {} location.href = location.pathname + (label ? `?as=${label}` : ''); };

  // ------------------------------------------------------------ raw capture (page-wide)
  const scene = $('#stage');            // the framed session: bar, sidebar, header
  const stage = $('#stage-body');       // where each task renders
  let points = [], down = null, coalesced = 0, lastClickAt = null, hoverSince = null, hoverEl = null;
  let keys = 0, lastKey = 0, keyIntervals = [], inputEvents = 0, pasted = false, scrolls = 0, lastScroll = 0, wheelDeltas = 0;
  // The hand's approach survives a reload of this tab: a person who refreshes and clicks without moving still
  // arrived here by hand. Kept 60 s at most, in this tab only (sessionStorage), never across sites.
  try {
    const saved = JSON.parse(sessionStorage.getItem('oh-approach-training') || 'null');
    if (saved && Array.isArray(saved.p) && Date.now() - saved.at < 60000) {
      const shift = performance.now() - (Date.now() - saved.at) - saved.span; // map absolute ages onto this page's clock
      for (const q of saved.p) points.push({ t: shift + q[0], x: q[1], y: q[2] });
    }
    sessionStorage.removeItem('oh-approach-training');
  } catch { /* ignore */ }
  window.addEventListener('pagehide', () => {
    try { const p = points.slice(-60); if (p.length) sessionStorage.setItem('oh-approach-training', JSON.stringify({ at: Date.now(), span: p[p.length - 1].t - p[0].t, p: p.map((q) => [Math.round(q.t - p[0].t), Math.round(q.x), Math.round(q.y)]) })); } catch { /* ignore */ }
  });
  const opts = { capture: true, passive: true };
  document.addEventListener('pointermove', (e) => {
    const t = performance.now();
    points.push({ t, x: e.clientX, y: e.clientY });
    if (typeof e.getCoalescedEvents === 'function') { try { coalesced += e.getCoalescedEvents().length || 1; } catch { coalesced += 1; } } else coalesced += 1;
    if (points.length > 400) points = points.slice(-400);
    const el = e.target instanceof Element ? e.target.closest('button, a, input, select, .card-tile, .tiny, .target') : null;
    if (el !== hoverEl) { hoverEl = el; hoverSince = el ? t : null; }
  }, opts);
  document.addEventListener('pointerdown', (e) => { down = { t: performance.now(), pointer: e.pointerType, pressure: typeof e.pressure === 'number' ? Math.round(e.pressure * 1000) / 1000 : null, hidden: document.visibilityState === 'hidden', button: e.button, width: e.width, height: e.height }; if (e.pointerType === 'mouse') points.push({ t: performance.now(), x: e.clientX, y: e.clientY }); }, opts);
  document.addEventListener('keydown', (e) => { const t = performance.now(); if (lastKey && keyIntervals.length < 80) keyIntervals.push(Math.round(t - lastKey)); lastKey = t; keys++; }, opts);
  document.addEventListener('input', () => { inputEvents++; }, opts);
  document.addEventListener('paste', () => { pasted = true; }, opts);
  document.addEventListener('scroll', () => { scrolls++; lastScroll = performance.now(); }, opts);
  document.addEventListener('wheel', (e) => { wheelDeltas += Math.abs(e.deltaY); }, opts);
  const focusLog = [];
  document.addEventListener('visibilitychange', () => focusLog.push({ t: now(), v: document.visibilityState }));
  window.addEventListener('blur', () => focusLog.push({ t: now(), f: false }));
  window.addEventListener('focus', () => focusLog.push({ t: now(), f: true }));

  function buildClick(e) {
    const t = performance.now();
    const p = points.slice(-240);
    let path = 0; for (let i = 1; i < p.length; i++) path += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
    const el = e.target instanceof Element ? e.target.closest('button, a, input, select, textarea, label, .card-tile, .tiny, .target, [role="button"]') : null;
    const r = el ? el.getBoundingClientRect() : null;
    const click = {
      trusted: e.isTrusted, pointer: (down && down.pointer) || e.pointerType || '', detail: Math.min(10, e.detail),
      holdMs: down ? Math.round(t - down.t) : null, moves: p.length, path: Math.round(path), travelMs: p.length > 1 ? Math.round(p[p.length - 1].t - p[0].t) : 0,
      pressure: down ? down.pressure : null, hidden: down ? down.hidden : document.visibilityState === 'hidden',
      traj: p.map((q) => [Math.round((q.t - t) * 10) / 10, Math.round(q.x), Math.round(q.y)]),
      downMs: down ? Math.round((down.t - t) * 10) / 10 : null,
      target: r && r.width > 0 ? { w: Math.round(r.width), h: Math.round(r.height), dx: Math.round((e.clientX - (r.left + r.width / 2)) * 10) / 10, dy: Math.round((e.clientY - (r.top + r.height / 2)) * 10) / 10 } : null,
      coalesced, at: [Math.round(e.clientX), Math.round(e.clientY)],
    };
    // context: everything else the page can see about this moment (never used by the judge; for learning)
    const early = window.OneHuman ? window.OneHuman.snapshot(false).early : null;
    const context = {
      atMs: now(), sinceLastClickMs: lastClickAt ? Math.round(t - lastClickAt) : null,
      hoverMs: hoverEl && hoverSince && el === hoverEl ? Math.round(t - hoverSince) : null,
      longTraj: points.slice(-400).map((q) => [Math.round((q.t - t) * 10) / 10, Math.round(q.x), Math.round(q.y)]),
      keysRecent: keys, keyIntervals: keyIntervals.slice(-40), inputEvents, pasted, scrolls, wheelDeltas: Math.round(wheelDeltas), sinceScrollMs: lastScroll ? Math.round(t - lastScroll) : null,
      button: down ? down.button : null, contactW: down ? down.width : null, contactH: down ? down.height : null,
      visible: document.visibilityState, hasFocus: document.hasFocus(), focusLog: focusLog.slice(-10),
      viewport: [innerWidth, innerHeight], dpr: devicePixelRatio, scrollY: Math.round(scrollY),
      tag: el ? el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : '') : (e.target && e.target.tagName ? e.target.tagName.toLowerCase() : ''),
      markers: early ? early.markers.map((m) => m.name) : [], globals: early ? early.environment.agentGlobals : [], extensions: early ? early.environment.extensionsInstalled : [],
      readBursts: early ? early.reading.readBursts : 0, focusWhileHiddenMs: early ? early.environment.focusWhileHiddenMs : null,
      touchPoints: navigator.maxTouchPoints, platform: navigator.platform,
    };
    const interaction = { atMs: now(), click, keys, keyIntervals: keyIntervals.slice(), inputEvents, paste: pasted };
    down = null; coalesced = 0; lastClickAt = t; keys = 0; keyIntervals = []; inputEvents = 0; pasted = false; scrolls = 0; wheelDeltas = 0;
    return { click, context, interaction };
  }

  // ------------------------------------------------------------ tasks
  const steps = []; // { task, ...interaction, repeatTarget }
  let lastTargetKey = null;
  async function record(task, e, extra = {}) {
    const { click, context, interaction } = buildClick(e);
    const key = click.target ? `${click.target.w}x${click.target.h}@${click.at.join(',')}` : null;
    const repeatTarget = !!(lastTargetKey && key && (lastTargetKey === key || (click.target && lastTargetKey.startsWith(`${click.target.w}x${click.target.h}`))));
    lastTargetKey = key;
    steps.push({ task, repeatTarget, ...interaction, ...extra });
    try { sessionStorage.setItem('oh-training-steps', JSON.stringify(steps)); } catch {}
    window.OneHumanHud?.trace(click.traj, click.at);
    fetch('/api/v1/sandbox/samples', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client, label, source: $('#source').value, task, repeatTarget, click, context }) })
      .then((r) => (r.ok ? r.json() : null)).then((d) => window.OneHumanHud?.show(d, task)).catch(() => {});
  }
  // steps survive the reload task
  try { const saved = sessionStorage.getItem('oh-training-steps'); if (saved) steps.push(...JSON.parse(saved)); } catch {}

  const rnd = (a, b) => Math.round(a + Math.random() * (b - a));
  const place = (n, size, cls = '') => { const bw = stage.clientWidth, bh = stage.clientHeight; const b = document.createElement('button'); b.className = 'target ' + cls; b.style.width = b.style.height = size + 'px'; b.style.left = rnd(10, Math.max(10, bw - size - 20)) + 'px'; b.style.top = rnd(10, Math.max(10, bh - size - 20)) + 'px'; b.textContent = String(n); b.setAttribute('aria-label', `Düymə ${n}`); return b; };

  const TASKS = [
    { id: 'targets', title: 'Nömrəli düymələr', text: 'Görünən nömrəli düyməyə kliklə. Hər klikdə növbətisi çıxır — 5 dəfə.', run(done) { let i = 0; const next = () => { stage.innerHTML = ''; if (i >= 5) return done(); if (stage.clientWidth < 200) { requestAnimationFrame(next); return; } const b = place(i + 1, rnd(44, 110), Math.random() < .35 ? 'sq' : ''); b.onclick = (e) => { record('targets', e); i++; next(); }; stage.appendChild(b); }; next(); } },
    { id: 'buttons-row', title: 'Ardıcıl düymələr', text: 'Soldan sağa dörd düyməni ardıcıl kliklə: Göstər, Yenilə, Axtar, Bağla.', run(done) { const names = ['Göstər', 'Yenilə', 'Axtar', 'Bağla']; let i = 0; stage.innerHTML = `<div class="row" style="margin-top:120px;justify-content:center">${names.map((n, k) => `<button data-k="${k}" class="${k === 0 ? 'primary' : ''}" style="padding:14px 22px">${n}</button>`).join('')}</div>`; stage.querySelectorAll('button').forEach((b) => { b.onclick = (e) => { if (Number(b.dataset.k) !== i) return; record('buttons-row', e); b.classList.remove('primary'); i++; const nb = stage.querySelector(`[data-k="${i}"]`); if (nb) nb.classList.add('primary'); else done(); }; }); } },
    { id: 'typing', title: 'Mətn yaz', text: 'Sahəyə “ödəniş tarixçəsi” yaz, sonra “Göndər” düyməsinə kliklə.', run(done) { stage.innerHTML = `<div style="margin-top:110px;display:flex;gap:10px;justify-content:center"><input id="ti" placeholder="Buraya yaz…" style="width:320px" autocomplete="off"><button class="primary" id="tb">Göndər</button></div>`; $('#tb').onclick = (e) => { if (($('#ti').value || '').trim().length < 3) { $('#ti').focus(); return; } record('typing', e, { typed: $('#ti').value.length }); done(); }; } },
    { id: 'scroll-click', title: 'Aşağı sürüş', text: 'Səhifəni aşağı sürüşdür, ən altdakı “Təsdiqlə” düyməsini tap və kliklə.', run(done) { stage.classList.add('tall'); scene.classList.add('tall'); stage.innerHTML = `<p style="color:var(--muted)">Uzun hesabat mətni…</p>${'<p style="color:var(--line)">▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬</p>'.repeat(28)}<button class="primary bottom-anchor" id="sc">Təsdiqlə</button>`; $('#sc').onclick = (e) => { record('scroll-click', e); stage.classList.remove('tall'); scene.classList.remove('tall'); window.scrollTo({ top: 0 }); done(); }; } },
    { id: 'dropdown', title: 'Seçim', text: 'Siyahıdan “Son 3 ay” seç, sonra “Tətbiq et” düyməsinə kliklə.', run(done) { stage.innerHTML = `<div style="margin-top:110px;display:flex;gap:10px;justify-content:center;align-items:center"><select id="dd" style="font:inherit;padding:10px 14px;border-radius:12px;border:1px solid var(--line);background:var(--surface)"><option>Son ay</option><option>Son 3 ay</option><option>Son il</option></select><button class="primary" id="db">Tətbiq et</button></div>`; $('#db').onclick = (e) => { if ($('#dd').value !== 'Son 3 ay') return; record('dropdown', e); done(); }; } },
    { id: 'modal', title: 'Pəncərə', text: '“Detallar” düyməsinə kliklə, açılan pəncərəni sağ üstdəki ✕ ilə bağla.', run(done) { stage.innerHTML = `<div style="margin-top:120px;text-align:center"><button class="primary" id="mo">Detallar</button></div>`; $('#mo').onclick = (e) => { record('modal', e); const bg = document.createElement('div'); bg.className = 'modal-bg'; bg.innerHTML = `<div class="modal"><button class="x ghost" id="mx">✕</button><h3>Əməliyyat detalları</h3><p class="sub">Kommunal ödəniş · 42,10 AZN · 18 sentyabr</p></div>`; document.body.appendChild(bg); $('#mx').onclick = (e2) => { record('modal', e2); bg.remove(); done(); }; }; } },
    { id: 'double-click', title: 'İki dəfə klik', text: 'Kartın üstünə iki dəfə (double-click) kliklə.', run(done) { stage.innerHTML = `<div style="margin-top:90px;display:flex;justify-content:center"><div class="card-tile" id="dc" style="width:260px"><b>Yığım hesabı</b><br><span class="sub">•••• 4471</span></div></div>`; let n = 0; $('#dc').addEventListener('click', (e) => { record('double-click', e); n++; if (e.detail >= 2 || n >= 2) { $('#dc').classList.add('on'); setTimeout(done, 300); } }); } },
    { id: 'keyboard', title: 'Klaviatura ilə', text: 'Siçana toxunma: Tab düyməsi ilə “Davam et” düyməsinə keç, Enter bas.', run(done) { stage.innerHTML = `<div style="margin-top:110px;display:flex;gap:10px;justify-content:center"><input placeholder="Ad" style="width:160px"><button id="kb">Davam et</button></div>`; stage.querySelector('input').focus(); $('#kb').onclick = (e) => { record('keyboard', e); done(); }; } },
    { id: 'reload-click', title: 'Səhifəni yenilə', text: '“Yenilə” düyməsinə kliklə — səhifə yenilənəcək. Yenilənən kimi, siçanı tərpətmədən eyni yerdəki düyməyə yenidən kliklə.', run(done) { const after = sessionStorage.getItem('oh-training-reload') === '1'; stage.innerHTML = `<div style="margin-top:120px;text-align:center"><button class="primary" id="rl" style="padding:16px 28px">${after ? 'Balansı göstər' : 'Yenilə'}</button></div>`; $('#rl').onclick = (e) => { if (!after) { record('reload-click', e); try { sessionStorage.setItem('oh-training-reload', '1'); sessionStorage.setItem('oh-training-index', String(taskIndex)); } catch {} setTimeout(() => location.reload(), 150); } else { record('reload-click', e); try { sessionStorage.removeItem('oh-training-reload'); } catch {} done(); } }; } },
    { id: 'hover-dwell', title: 'Gözlə, sonra bas', text: 'Siçanı “Köçür” düyməsinin üstünə gətir, 2 saniyə gözlə, sonra kliklə.', run(done) { stage.innerHTML = `<div style="margin-top:120px;text-align:center"><button class="primary" id="hv" style="padding:16px 28px">Köçür</button></div>`; $('#hv').onclick = (e) => { record('hover-dwell', e); done(); }; } },
    { id: 'slider', title: 'Sürüşdürücü', text: 'Sürüşdürücünü təxminən 70-ə çək, sonra “Təsdiqlə” düyməsinə kliklə.', run(done) { stage.innerHTML = `<div style="margin-top:110px;display:flex;gap:16px;justify-content:center;align-items:center"><input type="range" id="sl" min="0" max="100" value="20"><b id="sv">20</b><button class="primary" id="sb">Təsdiqlə</button></div>`; $('#sl').oninput = () => { $('#sv').textContent = $('#sl').value; }; $('#sb').onclick = (e) => { const v = Number($('#sl').value); if (v < 60 || v > 80) return; record('slider', e, { slider: v }); done(); }; } },
    { id: 'small-target', title: 'Kiçik hədəf', text: 'Mətnin içindəki kiçik “şərtlər” linkinə kliklə.', run(done) { stage.innerHTML = `<p style="margin-top:130px;text-align:center;color:var(--muted)">Davam etməklə siz <span class="tiny" id="tl">şərtlər</span> ilə razılaşırsınız.</p>`; $('#tl').onclick = (e) => { record('small-target', e); done(); }; } },
    { id: 'drag-drop', title: 'Sürüklə', text: 'Kartı tutub sağdakı “Bura at” sahəsinə sürüklə və burax.', run(done) { stage.innerHTML = `<div style="margin-top:90px;display:flex;justify-content:space-between;padding:0 60px"><div class="card-tile" id="dg" style="width:200px;cursor:grab;touch-action:none"><b>Kommunal ödəniş</b><br><span class="sub">42,10 AZN</span></div><div id="dz" style="width:260px;height:110px;border:2px dashed var(--line);border-radius:16px;display:grid;place-items:center;color:var(--muted)">Bura at</div></div>`; const dg = $('#dg'), dz = $('#dz'); let dragging = false, sx = 0, sy = 0, moves = 0; const dragPts = []; dg.addEventListener('pointerdown', (e) => { dragging = true; sx = e.clientX; sy = e.clientY; dragPts.length = 0; try { dg.setPointerCapture(e.pointerId); } catch {} }); dg.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false }); dg.addEventListener('pointercancel', () => { dragging = false; dg.style.transform = ''; }); dg.addEventListener('pointermove', (e) => { if (!dragging) return; moves++; dragPts.push([now(), e.clientX, e.clientY]); dg.style.transform = `translate(${e.clientX - sx}px,${e.clientY - sy}px)`; }); dg.addEventListener('pointerup', (e) => { if (!dragging) return; dragging = false; const r = dz.getBoundingClientRect(); const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom; if (inside) { record('drag-drop', e, { drag: { moves, dur: dragPts.length ? dragPts[dragPts.length - 1][0] - dragPts[0][0] : 0, path: dragPts.slice(-120) } }); dz.textContent = 'Qəbul edildi ✓'; setTimeout(done, 300); } else { dg.style.transform = ''; } }); } },
    { id: 'form-tab', title: 'Forma doldur', text: 'Üç sahəni doldur (ad, məbləğ, qeyd) — sahələr arası Tab ilə keç — sonra “Ödə” düyməsinə kliklə.', run(done) { stage.innerHTML = `<div style="margin-top:70px;display:grid;gap:10px;max-width:360px;margin-left:auto;margin-right:auto"><input id="f1" placeholder="Alıcının adı" autocomplete="off"><input id="f2" placeholder="Məbləğ, AZN" autocomplete="off"><input id="f3" placeholder="Qeyd" autocomplete="off"><button class="primary" id="fb">Ödə</button></div>`; $('#fb').onclick = (e) => { if (!$('#f1').value || !$('#f2').value || !$('#f3').value) { ($('#f1').value ? $('#f2').value ? $('#f3') : $('#f2') : $('#f1')).focus(); return; } record('form-tab', e, { typed: $('#f1').value.length + $('#f2').value.length + $('#f3').value.length }); done(); }; } },
    { id: 'hesitate', title: 'Fikrini dəyiş', text: 'Əvvəl “Aylıq” variantını seç, sonra fikrini dəyişib “İllik” seç, sonra “Davam” düyməsinə kliklə.', run(done) { stage.innerHTML = `<div style="margin-top:90px;display:flex;gap:12px;justify-content:center;align-items:center"><div class="card-tile" data-v="m" style="width:150px;text-align:center">Aylıq</div><div class="card-tile" data-v="y" style="width:150px;text-align:center">İllik</div><button class="primary" id="hb">Davam</button></div>`; const seq = []; stage.querySelectorAll('.card-tile').forEach((c) => { c.onclick = (e) => { stage.querySelectorAll('.card-tile').forEach((x) => x.classList.remove('on')); c.classList.add('on'); seq.push(c.dataset.v); record('hesitate', e, { pick: c.dataset.v }); }; }); $('#hb').onclick = (e) => { if (seq[seq.length - 1] !== 'y') return; record('hesitate', e, { picks: seq.join('') }); done(); }; } },
    { id: 'read-choose', title: 'Oxu və seç', text: 'Mətni oxu, sonra mətndəki məbləğə uyğun düyməyə kliklə.', run(done) { const amounts = [125, 240, 375, 480]; const right = amounts[rnd(0, 3)]; stage.innerHTML = `<p style="margin-top:60px;max-width:620px;margin-left:auto;margin-right:auto;color:var(--muted)">Sentyabr ayı üzrə kommunal ödənişlərinizin cəmi <b style="color:var(--text)">${right} AZN</b> təşkil edir. Ödənişi təsdiqləmək üçün aşağıda həmin məbləği seçin. Səhv seçim əməliyyatı ləğv edir.</p><div class="row" style="justify-content:center;margin-top:20px">${amounts.map((a) => `<button data-a="${a}" style="padding:14px 22px">${a} AZN</button>`).join('')}</div>`; stage.querySelectorAll('button').forEach((b) => { b.onclick = (e) => { record('read-choose', e, { correct: Number(b.dataset.a) === right }); if (Number(b.dataset.a) === right) done(); }; }); } },
    { id: 'near-miss', title: 'Yaxın hədəflər', text: 'Bir-birinə yaxın üç kiçik düymədən ORTADAKINA kliklə.', run(done) { stage.innerHTML = `<div style="margin-top:130px;display:flex;gap:4px;justify-content:center">${['◀', '●', '▶'].map((t, i) => `<button data-i="${i}" style="width:34px;height:30px;padding:0;font-size:12px">${t}</button>`).join('')}</div>`; stage.querySelectorAll('button').forEach((b) => { b.onclick = (e) => { record('near-miss', e, { hit: b.dataset.i === '1' }); if (b.dataset.i === '1') done(); }; }); } },
    { id: 'long-idle', title: 'Uzun fasilə', text: 'Heç nəyə toxunma. Sayğac bitəndə (6 saniyə) “Hazıram” düyməsinə kliklə.', run(done) { stage.innerHTML = `<div style="margin-top:120px;text-align:center"><div class="kpi" id="cd">6</div><button class="primary" id="li" disabled style="margin-top:12px">Hazıram</button></div>`; let n = 6; const iv = setInterval(() => { n--; $('#cd').textContent = String(Math.max(0, n)); if (n <= 0) { clearInterval(iv); $('#li').disabled = false; } }, 1000); $('#li').onclick = (e) => { record('long-idle', e); done(); }; } },
    { id: 'select-text', title: 'Mətni seç', text: 'IBAN nömrəsini siçanla seç (üstündə sürüklə), sonra “Kopyala” düyməsinə kliklə.', run(done) { stage.innerHTML = `<div style="margin-top:110px;text-align:center"><div class="code" id="ib" style="display:inline-block;padding:10px 16px;font-size:16px;user-select:text">AZ21 NABZ 0000 0000 1370 1000 1944</div><div style="margin-top:14px"><button class="primary" id="cp">Kopyala</button></div></div>`; $('#cp').onclick = (e) => { const sel = (getSelection() || '').toString().replace(/\s/g, ''); record('select-text', e, { selected: sel.length }); done(); }; } },
    { id: 'free-move', title: 'Sərbəst hərəkət', text: 'Siçanı 3 saniyə boş sahədə istədiyin kimi gəzdir (heç nəyə klikləmə), sonra “Bitdi” düyməsinə kliklə.', run(done) { stage.innerHTML = `<div style="position:absolute;right:24px;bottom:24px"><button class="primary" id="fm">Bitdi</button></div><p style="color:var(--muted);text-align:center;margin-top:150px">boş sahə</p>`; const start = performance.now(); $('#fm').onclick = (e) => { record('free-move', e, { wanderMs: Math.round(performance.now() - start) }); done(); }; } },
    { id: 'rapid-fire', title: 'Sürətli təkrar', text: 'Eyni düyməyə mümkün qədər sürətlə 5 dəfə kliklə.', run(done) { stage.innerHTML = `<div style="margin-top:120px;text-align:center"><button class="primary" id="rf" style="padding:16px 28px">Bas! <span id="rc">0</span>/5</button></div>`; let n = 0; $('#rf').onclick = (e) => { record('rapid-fire', e); n++; $('#rc').textContent = String(n); if (n >= 5) done(); }; } },
  ];

  // Each task belongs to a part of a real session; the lab announces the part as it changes,
  // so a run reads like a visit to a bank rather than a list of exercises.
  const PHASES = [
    { name: 'Giriş', note: 'hesaba daxil olan adamın ilk hərəkətləri', url: 'bank.example.com/login', title: 'Daxil ol', sub: 'Northstar Bank · şəxsi hesab', ids: ['targets', 'buttons-row', 'typing'] },
    { name: 'Hesab', note: 'balans, siyahı, axtarış', url: 'bank.example.com/accounts', title: 'Cari hesab', sub: 'Balans · əməliyyatlar · axtarış', ids: ['scroll-click', 'dropdown', 'modal', 'double-click', 'keyboard', 'reload-click'] },
    { name: 'Ödəniş', note: 'məbləğ seçimi, forma, təsdiq', url: 'bank.example.com/payments/new', title: 'Yeni ödəniş', sub: 'Alıcı · məbləğ · təsdiq', ids: ['hover-dwell', 'slider', 'small-target', 'drag-drop', 'form-tab', 'hesitate', 'read-choose'] },
    { name: 'Sənəd və fasilə', note: 'oxuma, gözləmə, sürətli təkrar', url: 'bank.example.com/documents', title: 'Sənədlər', sub: 'Çıxarış · şərtlər · IBAN', ids: ['near-miss', 'long-idle', 'select-text', 'free-move', 'rapid-fire'] },
  ];
  const phaseOf = (id) => PHASES.find((p) => p.ids.includes(id)) || PHASES[PHASES.length - 1];

  // ?mode=short → the original 13 tasks; default = every task (~6 minutes)
  const SHORT = new Set(['targets', 'buttons-row', 'typing', 'scroll-click', 'dropdown', 'modal', 'double-click', 'keyboard', 'reload-click', 'hover-dwell', 'slider', 'small-target', 'rapid-fire']);
  if (params.get('mode') === 'short') for (let i = TASKS.length - 1; i >= 0; i--) if (!SHORT.has(TASKS[i].id)) TASKS.splice(i, 1);
  // touch devices: keyboard/drag/select tasks are replaced by touch-friendly wording handled by the same code
  let taskIndex = 0;
  try { const saved = sessionStorage.getItem('oh-training-index'); if (saved !== null && sessionStorage.getItem('oh-training-reload') === '1') taskIndex = Number(saved); } catch {}

  function setWho() {
    const pill = $('#who-pill'); pill.className = 'pill ' + (label === 'agent' ? 'agent' : 'human'); pill.lastElementChild.textContent = label === 'agent' ? 'AI agent işləyir' : 'İnsan işləyir';
    $('#who').hidden = true; $('#run').hidden = false;
    if (label === 'agent') $('#source').innerHTML = `<option value="${isAgentApp ? 'agent-app-browser' : 'agent-chrome'}">${isAgentApp ? 'AI tətbiqinin brauzeri' : 'Chrome (genişləndirmə)'}</option>`;
    else if (isAgentApp) $('#source').value = 'claude-pane-human';
    else if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) $('#source').value = /CriOS/i.test(navigator.userAgent) ? 'iphone-chrome' : 'iphone-safari';
    else if (/Android/i.test(navigator.userAgent)) $('#source').value = 'android-touch';
    else if (navigator.maxTouchPoints > 1) $('#source').value = 'touch';
    else if (/Windows/i.test(navigator.userAgent)) $('#source').value = 'windows-mouse';
    else if (/Firefox/i.test(navigator.userAgent)) $('#source').value = 'firefox';
    else if (/Safari/i.test(navigator.userAgent) && !/Chrome/i.test(navigator.userAgent)) $('#source').value = 'safari';
    const src = params.get('source'); if (src && /^[a-z0-9_.-]{1,40}$/i.test(src)) { const o = document.createElement('option'); o.value = src; o.textContent = src; o.selected = true; $('#source').appendChild(o); }
    runTask();
  }
  $('#as-human').onclick = () => { label = 'human'; history.replaceState(null, '', '?as=human'); setWho(); };
  $('#as-agent').onclick = () => { label = 'agent'; history.replaceState(null, '', '?as=agent'); setWho(); };
  if (label) setWho();

  function runTask() {
    if (taskIndex >= TASKS.length) return finish();
    const t = TASKS[taskIndex];
    $('#t-num').textContent = `Tapşırıq ${taskIndex + 1} / ${TASKS.length}`; $('#t-title').textContent = t.title; $('#t-text').textContent = t.text;
    $('#stepper').innerHTML = TASKS.map((_, i) => `<i class="${i < taskIndex ? 'done' : i === taskIndex ? 'cur' : ''}"></i>`).join('');
    const tk = $('#task'); tk.style.animation = 'none'; void tk.offsetWidth; tk.style.animation = '';
    const ph = phaseOf(t.id); const pe = $('#phase');
    if (pe && pe.dataset.name !== ph.name) {
      pe.dataset.name = ph.name;
      pe.innerHTML = `<b>${ph.name}</b><span>${ph.note}</span>`;
      pe.style.animation = 'none'; void pe.offsetWidth; pe.style.animation = '';
      const w = document.createElement('div'); w.className = 'wipe'; w.innerHTML = `<span>${ph.name}</span>`;
      scene.appendChild(w); setTimeout(() => w.remove(), 900);
      // the framed session moves to the page this phase happens on
      const k = PHASES.indexOf(ph);
      $$('#scene-side i').forEach((el, j) => el.classList.toggle('on', j === k));
      const url = $('#scene-url'); url.classList.remove('nav'); void url.offsetWidth; url.textContent = ph.url; url.classList.add('nav');
      $('#scene-title').textContent = ph.title; $('#scene-sub').textContent = ph.sub;
    }
    const pct = taskIndex / TASKS.length; const ring = $('#ring'); if (ring) { ring.style.strokeDashoffset = String(113 * (1 - pct)); $('#ring-label').textContent = Math.round(pct * 100) + '%'; }
    stage.classList.remove('swap'); void stage.offsetWidth; stage.classList.add('swap');
    scene.classList.remove('tall');
    $('#progress').textContent = `${steps.length} hadisə yazıldı`;
    stage.classList.remove('tall'); stage.innerHTML = '';
    t.run(() => { taskIndex++; try { sessionStorage.setItem('oh-training-index', String(taskIndex)); } catch {} setTimeout(runTask, 250); });
  }

  async function finish() {
    $('#task').innerHTML = `<div class="num">Bitdi</div><h2>Təşəkkür — ${steps.length} hadisə yazıldı</h2><p>Real qərar mühərriki bütün ardıcıllığı addım-addım işlədir…</p>`;
    $('#stepper').innerHTML = TASKS.map(() => '<i class="done"></i>').join('');
    const ring = $('#ring'); if (ring) { ring.style.strokeDashoffset = '0'; $('#ring-label').textContent = '100%'; }
    stage.innerHTML = '<div class="hint">Hesablanır…</div>';
    const early = window.OneHuman ? window.OneHuman.snapshot(false).early : null;
    let d = null;
    try { const r = await fetch('/api/v1/sandbox/assess-run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client, label, source: $('#source').value, early, steps }) }); d = await r.json(); } catch {}
    scene.hidden = true;
    window.OneHumanHud?.hide();
    const res = $('#results'); res.hidden = false;
    if (!d || !d.steps) { res.innerHTML = `<div class="summary bad"><h2>Nəticə alınmadı</h2><p>Kod: <span class="code">${client}</span> — bu kodu göndər, hadisələr artıq yazılıb.</p></div>`; return; }
    const word = (a) => a === 'human_like' ? '<span class="res human">insan</span>' : a === 'agent_likely' ? '<span class="res agent">agent</span>' : '<span class="res unknown">bilinmir</span>';
    const clickWord = (c) => c ? `<span class="res small ${c.verdict}">${c.verdict === 'human' ? 'insan' : c.verdict === 'synthetic' ? 'sintetik' : 'qeyri-müəyyən'} ${c.humanPts}/${c.agentPts}</span>` : '<span class="res small unknown">—</span>';
    const bad = label === 'human' ? d.summary.agentSteps : d.summary.humanSteps;
    const ok = bad === 0;
    const title = label === 'human' ? (ok ? 'Heç bir addımda agent sayılmadın' : `${bad} addımda sistem səni agent sayardı`) : (ok ? 'Agent heç bir addımda insan sayılmadı' : `${bad} addımda agent insan sayıldı`);
    const tiles = `<div class="tiles"><div class="tile g"><b>${d.summary.humanSteps}</b><small>insan sayılan addım</small></div><div class="tile r"><b>${d.summary.agentSteps}</b><small>agent sayılan addım</small></div><div class="tile a"><b>${d.summary.unknownSteps}</b><small>bilinməyən</small></div><div class="tile"><b>${d.summary.firstHumanStep ?? '—'}</b><small>ilk "insan" addımı</small></div></div>`;
    const trace = d.summary.markers.length || d.summary.globals.length ? `<p>Səhifədə agent alətinin izi var idi (<span class="code">${[...d.summary.markers, ...d.summary.globals].slice(0, 3).join(', ')}</span>) — bu tabda agent qoşulu olub.</p>` : `<p>Səhifədə agent alətinin izi yox idi.</p>`;
    const rows = d.steps.map((s, i) => `<div class="step" style="animation-delay:${Math.min(1200, i * 45)}ms"><span class="n">${String(s.step).padStart(2, '0')}</span><span class="task-name">${s.task}</span><span>${word(s.actor)} ${clickWord(s.click)}</span><span class="reasons" title="${(s.reasonCodes || []).join(', ')}">${(s.reasonCodes || []).join(' · ')}</span></div>`).join('');
    res.innerHTML = `<div class="summary ${ok ? 'ok' : 'bad'}"><div class="num" style="font-family:var(--mono);font-size:12px;color:var(--accent);letter-spacing:.06em;text-transform:uppercase">Nəticə · ${d.summary.version || ''}</div><h2>${title}</h2>${tiles}${trace}<p>Kod: <span class="code" id="code">${client}</span> <button class="ghost" id="copy-code" style="padding:6px 12px;margin-left:8px">Kodu kopyala</button></p></div><div class="timeline">${rows}</div>`;
    $('#copy-code').onclick = async () => { try { await navigator.clipboard.writeText(client); $('#copy-code').textContent = 'Kopyalandı ✓'; } catch {} };
    mountReplay(res, d);
    try { sessionStorage.removeItem('oh-training-steps'); sessionStorage.removeItem('oh-training-index'); sessionStorage.removeItem('oh-training-client'); } catch {}
  }
  /**
   * Replay: every trajectory this run recorded, redrawn in order on one canvas and coloured by
   * the verdict the engine gave that click. A human run fills the board with curves; an agent run
   * draws straight lines between dots. It is the clearest picture of what the judge saw.
   */
  const VERDICT_WORD = { human: 'insan', synthetic: 'sintetik', uncertain: 'qeyri-müəyyən' };
  function mountReplay(res, d) {
    const shots = steps.map((st, i) => ({
      task: st.task || (TASKS[i] && TASKS[i].id) || 'click',
      traj: (st.click && st.click.traj) || [],
      at: st.click && st.click.at,
      verdict: (d.steps && d.steps[i] && d.steps[i].click && d.steps[i].click.verdict) || 'uncertain',
    })).filter((s0) => s0.traj.length);
    if (!shots.length) return;
    const card = document.createElement('div');
    card.className = 'replay';
    card.innerHTML = `<div class="replay-top"><b>Qaçışın təkrarı</b><span>${shots.length} klikin əsl kursor yolu, verdiktə görə rənglənib</span><button class="ghost" id="rp-play">Oynat</button></div>
      <canvas id="rp" width="1000" height="300"></canvas>
      <div class="replay-label" id="rp-label">Oynat düyməsinə bas</div>`;
    res.appendChild(card);
    const cv = card.querySelector('#rp'), ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
    const label = card.querySelector('#rp-label'), play = card.querySelector('#rp-play');
    const COLOR = { human: '#7cf0c0', synthetic: '#ff7b7b', uncertain: '#ffb86b' };
    // one frame for the whole run: the union of every recorded path, so the board fills the canvas
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s0 of shots) for (const [, x, y] of s0.traj) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const pad = 24, k = Math.min((W - pad * 2) / Math.max(1, x1 - x0), (H - pad * 2) / Math.max(1, y1 - y0));
    const ox = pad + ((W - pad * 2) - (x1 - x0) * k) / 2 - x0 * k, oy = pad + ((H - pad * 2) - (y1 - y0) * k) / 2 - y0 * k;
    const grid = () => {
      ctx.fillStyle = '#0d0d10'; ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(255,255,255,.04)'; ctx.lineWidth = 1;
      for (let x = 0; x < W; x += 30) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
      for (let y = 0; y < H; y += 30) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    };
    let raf = 0, running = false;
    function run() {
      running = true; play.textContent = 'Dayandır'; grid();
      let i = 0, j = 1;
      const tick = () => {
        if (!running) return;
        const s0 = shots[i]; const pts = s0.traj.map(([, x, y]) => ({ x: ox + x * k, y: oy + y * k }));
        const col = COLOR[s0.verdict] || COLOR.uncertain;
        const per = Math.max(2, Math.round(pts.length / 12));
        const end = Math.min(pts.length, j + per);
        ctx.lineCap = 'round';
        for (; j < end; j++) {
          ctx.strokeStyle = col; ctx.globalAlpha = .85; ctx.lineWidth = 1.6;
          ctx.beginPath(); ctx.moveTo(pts[j - 1].x, pts[j - 1].y); ctx.lineTo(pts[j].x, pts[j].y); ctx.stroke();
        }
        ctx.globalAlpha = 1;
        label.innerHTML = `<span class="res small ${s0.verdict}">${VERDICT_WORD[s0.verdict]}</span> ${i + 1}/${shots.length} · ${s0.task}`;
        if (j >= pts.length) {
          const last = pts[pts.length - 1];
          ctx.beginPath(); ctx.arc(last.x, last.y, 3.5, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
          i++; j = 1;
          if (i >= shots.length) { running = false; play.textContent = 'Yenidən oynat'; label.innerHTML += ' · bitdi'; return; }
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }
    play.onclick = () => { if (running) { running = false; cancelAnimationFrame(raf); play.textContent = 'Davam et'; } else run(); };
    grid();
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) setTimeout(run, 600);
  }
})();
