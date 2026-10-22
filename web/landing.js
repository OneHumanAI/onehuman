// SPDX-License-Identifier: BUSL-1.1
/* OneHuman landing */
(async () => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------------------------------------------------------------- toast + copy
  const toastEl = $('#toast'); let toastT;
  const toast = (m) => { toastEl.textContent = m; toastEl.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), 1800); };
  async function copy(text, msg = 'Copied') { try { await navigator.clipboard.writeText(text); toast(msg); } catch { toast('Could not copy'); } }
  $('#copy-npm')?.addEventListener('click', () => copy('npx onehumanai init'));
  $$('[data-copy]').forEach((b) => b.addEventListener('click', () => copy(b.dataset.copy)));

  // ---------------------------------------------------------------- an AI agent in this tab
  // OneHuman's own page script runs here in local mode (it sends nothing): when an agent drives this tab or a side
  // panel opens beside it, the page says so, the way a customer's app would know.
  let noteDismissed = null;
  function agentNote(p) {
    const note = $('#agent-note'); const level = p && p.agent;
    if (!level) { note.hidden = true; return; }
    if (noteDismissed === level) return;
    $('#agent-note-title').textContent = level === 'attached' ? 'OneHuman noticed an AI agent in this tab' : p.panel ? 'OneHuman noticed a side panel beside this tab' : 'OneHuman noticed an AI agent tool in this browser';
    $('#agent-note-text').textContent = level === 'attached'
      ? 'An agent is driving this page right now. In a logged-in app, this is the moment OneHuman hides private data and asks the owner before anything irreversible.'
      : p.panel ? 'An AI assistant there can read this page. In a logged-in app, OneHuman would hide private data on screen until it closes.'
        : 'It is not driving this page. In a logged-in app, OneHuman would hide private data on screen and tell the account owner.';
    note.dataset.level = level; note.hidden = false;
  }
  $('#agent-note-x').addEventListener('click', () => { noteDismissed = $('#agent-note').dataset.level; $('#agent-note').hidden = true; });
  document.addEventListener('onehuman:presence', (e) => agentNote(e.detail));
  addEventListener('load', () => { if (window.OneHuman && window.OneHuman.presence) agentNote(window.OneHuman.presence()); });

  // ---------------------------------------------------------------- comparison table: marks pop in row by row
  (() => {
    const wrap = $('#cmp'); if (!wrap || !('IntersectionObserver' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (wrap.getBoundingClientRect().top < innerHeight) return; // already on screen: leave it at rest
    wrap.classList.add('pre');
    const totals = $$('.cmp-total b', wrap);
    const count = () => totals.forEach((b, i) => { const n = Number(b.dataset.n); if (!n) return; let k = 0; b.textContent = '0'; setTimeout(() => { const t = setInterval(() => { b.textContent = String(++k); if (k >= n) clearInterval(t); }, 45); }, 500 + i * 60); });
    const cio = new IntersectionObserver((es) => { if (!es[0].isIntersecting) return; cio.disconnect(); requestAnimationFrame(() => { wrap.classList.remove('pre'); wrap.classList.add('in'); count(); }); }, { threshold: 0.25 });
    cio.observe(wrap);
  })();

  // ---------------------------------------------------------------- nav shadow
  const nav = $('#nav');
  const onScroll = () => nav.classList.toggle('scrolled', scrollY > 8);
  addEventListener('scroll', onScroll, { passive: true }); onScroll();

  // ---------------------------------------------------------------- hero: rotating verb
  // "Decide what they can see.": the verb cycles through what the policy actually controls
  (function rotator() {
    const rot = $('#rot'); if (!rot) return;
    const words = $$('span', rot); let i = 0;
    const fit = (w) => { rot.style.width = `${w.offsetWidth}px`; };          // the line follows the current word, so the period stays put
    fit(words[0]); if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => fit(words[i]));
    addEventListener('resize', () => fit(words[i]), { passive: true });
    if (reduced) return;
    setInterval(() => {
      const cur = words[i], next = words[(i + 1) % words.length];
      cur.classList.remove('on'); cur.classList.add('out'); setTimeout(() => cur.classList.remove('out'), 600);
      next.classList.add('on'); i = (i + 1) % words.length; fit(next);
    }, 2600);
  })();

  // ---------------------------------------------------------------- scroll line, parallax, marquee, tickers, text reveal
  if (!CSS.supports || !CSS.supports('animation-timeline: scroll()')) {
    const line = $('#scroll-line'); const upd = () => { const h = document.documentElement; line.style.transform = `scaleX(${h.scrollHeight > h.clientHeight ? scrollY / (h.scrollHeight - h.clientHeight) : 0})`; };
    addEventListener('scroll', upd, { passive: true }); upd();
  }
  (function marquee() { const row = $('#marquee-row'); if (!row) return; row.innerHTML += row.innerHTML; })();
  (function tickers() {
    const els = $$('[data-tick]'); if (!els.length) return;
    const run = (el) => { const to = parseFloat(el.dataset.tick), dec = +el.dataset.dec || 0, t0 = performance.now(), dur = 1400; const step = (now) => { const u = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - u, 3); el.textContent = (to * e).toFixed(dec); if (u < 1) requestAnimationFrame(step); }; requestAnimationFrame(step); };
    if (!('IntersectionObserver' in window) || reduced) { els.forEach((el) => { el.textContent = parseFloat(el.dataset.tick).toFixed(+el.dataset.dec || 0); }); return; }
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { run(e.target); io.unobserve(e.target); } }), { threshold: .4 }); els.forEach((el) => io.observe(el));
  })();
  (function textReveal() {
    $$('.tr').forEach((h) => {
      const parts = []; h.childNodes.forEach((n) => { if (n.nodeType === 3) n.textContent.split(/(\s+)/).forEach((w) => parts.push(w)); else parts.push(n.outerHTML); });
      const px = new Set((h.dataset.px || '').split(/\s+/).filter(Boolean));
      const mark = (w) => (px.has(w.replace(/[.,:;]+$/, '')) ? ' px' : '');
      let i = 0; h.innerHTML = parts.map((w) => (/^\s+$/.test(w) || !w ? w : /^</.test(w) ? w : `<span class="tw${mark(w)}" style="--i:${i++}">${w}</span>`)).join('');
    });
    if (!('IntersectionObserver' in window) || reduced) { $$('.tr').forEach((h) => h.classList.add('in')); return; }
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: .3 }); $$('.tr').forEach((h) => io.observe(h));
    setTimeout(() => $$('.tr:not(.in)').forEach((h) => { if (h.getBoundingClientRect().top < innerHeight) h.classList.add('in'); }), 1500);
  })();

  // ---------------------------------------------------------------- reveal on scroll
  $$('.grid3 .feat').forEach((el, i) => el.style.setProperty('--i', i));
  const io = 'IntersectionObserver' in window ? new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -8% 0px', threshold: 0.05 }) : null;
  $$('.reveal').forEach((el) => io ? io.observe(el) : el.classList.add('in'));
  const sweep = () => { const left = $$('.reveal:not(.in)'); left.forEach((el) => { if (el.getBoundingClientRect().top < innerHeight * 1.05) el.classList.add('in'); }); if (!left.length) removeEventListener('scroll', sweep); };
  addEventListener('scroll', sweep, { passive: true }); addEventListener('load', sweep); setTimeout(sweep, 1200);

  // ---------------------------------------------------------------- feature spotlight + frame tilt
  if (matchMedia('(hover:hover) and (pointer:fine)').matches) {
    $$('.feat').forEach((f) => f.addEventListener('pointermove', (e) => { const r = f.getBoundingClientRect(); f.style.setProperty('--mx', `${e.clientX - r.left}px`); f.style.setProperty('--my', `${e.clientY - r.top}px`); }, { passive: true }));
    const tilt = $('#tilt'), bez = tilt && tilt.querySelector('.bezel');
    if (bez) {
      tilt.addEventListener('pointermove', (e) => { if (!bez.classList.contains('in')) return; const r = tilt.getBoundingClientRect(); const x = (e.clientX - r.left) / r.width - .5, y = (e.clientY - r.top) / r.height - .5; bez.style.transform = `rotateX(${(-y * 4).toFixed(2)}deg) rotateY(${(x * 5).toFixed(2)}deg)`; }, { passive: true });
      tilt.addEventListener('pointerleave', () => { bez.style.transform = ''; });
    }
  }

  // ---------------------------------------------------------------- code tabs
  const tabs = $('#code-tabs');
  if (tabs) tabs.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $$('button', tabs).forEach((x) => x.classList.toggle('on', x === b));
    $$('.code').forEach((p) => { p.hidden = p.id !== `code-${b.dataset.tab}`; if (!p.hidden) { p.style.animation = 'none'; void p.offsetWidth; p.style.animation = ''; } });
  });
  $('#copy-code')?.addEventListener('click', () => copy($$('.code').find((p) => !p.hidden).textContent.trim()));

  // ---------------------------------------------------------------- product story: scroll-driven tutorial
  // Four steps on the left; the framed session on the right plays the matching state. Scrolling is
  // the timeline (nothing auto-advances), so the reader controls the pace and can go back.
  const S = {
    steps: $$('#story-steps .ss'), guard: $('#f-guard'), amount: $('#f-amount'), btn: $('#f-btn'), notice: $('#f-notice'),
    agent: $('#f-agent'), ai: $('#f-ai'), passkey: $('#f-passkey'), pointer: $('#f-pointer'), log: $('#f-log'),
    kv: ['#f-name', '#f-iban', '#f-phone'].map((s) => $(s)), frame: $('#frame'), body: $('#frame .frame-body'),
    note: $('#story-note'), noteTitle: $('#note-title'), noteText: $('#note-text'), noteMetric: $('#note-metric'),
  };
  const LOGS = [
    'balance.read → allow · actor=human_like · HUMAN_KINEMATICS',
    'seal · indicators=[overlay_marker, injected_global] · 0.3 s after attach',
    'balance.read → mask · report.export → step_up · actor=agent · sticky',
    'reclaim → webauthn ok · actor=human · 5 min window',
  ];
  let step = -1, timers = [];
  const CANCELLED = Symbol('cancelled');
  // A cancelled step must unwind, not hang: every pending wait rejects, run() catches the symbol and stops.
  const wait = (ms) => new Promise((res, rej) => { const t = setTimeout(res, ms); timers.push({ t, rej }); });
  const cancelRun = () => { const list = timers; timers = []; list.forEach(({ t, rej }) => { clearTimeout(t); rej(CANCELLED); }); };
  // The pointer clicks: it grows and settles once, with a soft ring, so the press is seen.
  function pressPointer() { S.pointer.classList.remove('click'); void S.pointer.offsetWidth; S.pointer.classList.add('click'); }
  // The drawn cursor lives in frame-body coordinates. A hand arrives along a curve that trembles and
  // slows onto the control; an agent's cursor is simply already there. That difference is the demo.
  let px = 0, py = 0, ptrAnim = 0;
  function setPtr(x, y) { px = x; py = y; S.pointer.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`; }
  function movePointer(x, y, agent) {
    cancelAnimationFrame(ptrAnim);
    S.pointer.classList.toggle('agent', !!agent);
    S.pointer.classList.add('show');
    if (agent || reduced) { setPtr(x, y); return; }
    const sx = px, sy = py, dx = x - sx, dy = y - sy, len = Math.hypot(dx, dy);
    if (len < 2) { setPtr(x, y); return; }
    const dur = Math.min(950, 260 + len * 1.6), bow = Math.min(60, len * 0.18);
    const cx = sx + dx * 0.5 - (dy / len) * bow, cy = sy + dy * 0.5 + (dx / len) * bow;
    const t0 = performance.now();
    const frame = (now) => {
      const u = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - u, 3), n = 1 - e;
      const bx = n * n * sx + 2 * n * e * cx + e * e * x, by = n * n * sy + 2 * n * e * cy + e * e * y;
      const tremor = (1 - e) * 1.2;
      setPtr(bx + (Math.random() - 0.5) * tremor, by + (Math.random() - 0.5) * tremor);
      if (u < 1) ptrAnim = requestAnimationFrame(frame);
    };
    ptrAnim = requestAnimationFrame(frame);
  }
  /** put the cursor down somewhere without a journey: the start of a move, not a move */
  function placePointer(x, y) { cancelAnimationFrame(ptrAnim); S.pointer.classList.remove('agent'); setPtr(x, y); S.pointer.classList.add('show'); }
  // The caption beside the frame: what just happened, in words, with the one measurement that decided it.
  function hideNotes() { S.note.classList.remove('show'); }
  function note(title, text, cls, metric) {
    S.noteTitle.textContent = title; S.noteText.textContent = text; S.noteMetric.textContent = metric || '';
    S.note.className = 'story-note ' + (cls || '');
    void S.note.offsetWidth; S.note.classList.add('show');
  }
  // The point where a straight line from `from` meets the edge of `el`, backed off by `gap` px: paths stop
  // there instead of running over the label; the cursor tip lands just inside the same edge.
  function edgeOf(el, from, gap = 8) {
    const fb = S.body.getBoundingClientRect(), r = el.getBoundingClientRect();
    const L = r.left - fb.left, T = r.top - fb.top, R = L + r.width, B = T + r.height, cx = (L + R) / 2, cy = (T + B) / 2;
    const dx = cx - from.x, dy = cy - from.y, len = Math.hypot(dx, dy) || 1;
    let t = 1;
    if (dx) { const tx = ((dx > 0 ? L : R) - from.x) / dx; if (tx > 0 && tx < t && Math.abs(from.y + dy * tx - cy) <= r.height / 2) t = tx; }
    if (dy) { const ty = ((dy > 0 ? T : B) - from.y) / dy; if (ty > 0 && ty < t && Math.abs(from.x + dx * ty - cx) <= r.width / 2) t = ty; }
    if (t >= 1) t = Math.max(0, 1 - 20 / len);
    const ex = from.x + dx * t, ey = from.y + dy * t;
    return { stop: { x: ex - (dx / len) * gap, y: ey - (dy / len) * gap }, tip: { x: ex + (dx / len) * 6, y: ey + (dy / len) * 6 } };
  }
  function targetOf(el) { const fb = S.body.getBoundingClientRect(), r = el.getBoundingClientRect(); return { x: r.left - fb.left + r.width * (0.35 + Math.random() * 0.3), y: r.top - fb.top + r.height * (0.4 + Math.random() * 0.2) }; }
  function placeAgent() {
    if (innerWidth <= 820) return;
    const fb = S.body.getBoundingClientRect(), card = S.body.querySelectorAll('.f-card')[1]; if (!card) return;
    const r = card.getBoundingClientRect(); const w = Math.max(150, Math.round(r.width - 12));
    S.agent.style.left = `${Math.round(r.left - fb.left + 6)}px`; S.agent.style.top = `${Math.round(r.top - fb.top + 6)}px`; S.agent.style.width = `${w}px`;
  }
  function seal(on) { S.amount.classList.toggle('sealed', on); S.kv.forEach((b) => b.classList.toggle('sealed', on)); }
  function notice(text, cls) { S.notice.textContent = text; S.notice.className = 'f-notice show ' + (cls || ''); }
  let logTimer = 0;
  function typeLog(text) {
    clearInterval(logTimer); if (reduced) { S.log.textContent = text; return; }
    const t0 = performance.now(); S.log.textContent = '';
    logTimer = setInterval(() => { const k = Math.min(text.length, Math.round((performance.now() - t0) / 1000 * 140)); S.log.textContent = text.slice(0, k); if (k >= text.length) clearInterval(logTimer); }, 30);
  }
  function aiSay(text, thinkMs = 700) { S.ai.classList.add('typing'); S.ai.textContent = ''; return wait(thinkMs).then(() => { S.ai.classList.remove('typing'); S.ai.textContent = text; }); }
  /** the person types their request to the assistant, character by character */
  async function typePrompt(text) {
    const el = S.body.querySelector('.f-msg.user'); if (!el) return;
    el.classList.add('typing-in'); el.textContent = '';
    if (reduced) { el.textContent = text; el.classList.remove('typing-in'); return; }
    // Driven by elapsed time, not one timer per letter: a throttled background tab catches up in one
    // tick instead of stretching the sentence over half a minute.
    const t0 = performance.now(), cps = 26;
    for (let k = 0; k < text.length;) {
      await wait(40);
      k = Math.min(text.length, Math.round((performance.now() - t0) / 1000 * cps));
      el.textContent = text.slice(0, k);
    }
    el.classList.remove('typing-in');
  }
  function flash(el, cls) { if (!el) return; el.classList.remove('flash-mask', 'flash-block'); void el.offsetWidth; el.classList.add(cls); }
  function setStep(i) {
    if (i === step) return;                      // a step plays once; scrolling back to it replays it
    cancelRun(); step = i;
    S.steps.forEach((el, k) => el.classList.toggle('on', k === i));
    typeLog(LOGS[i]);
    window.OneHumanMorph && window.OneHumanMorph.setState(i === 1 || i === 2 ? 1 : 0);
    run(i).catch((e) => { if (e !== CANCELLED) throw e; });
  }
  async function run(i) {
    hideNotes(); S.pointer.classList.remove('click');
    if (i === 0) {
      S.guard.className = 'f-guard'; S.guard.lastElementChild.textContent = 'Session protected'; S.agent.classList.remove('in'); S.passkey.classList.remove('in');
      seal(false); S.amount.textContent = '$4,939.10'; S.notice.className = 'f-notice'; S.btn.textContent = 'Show balance';
      const c = targetOf(S.btn), a = { x: c.x - 240, y: c.y + 110 }, e = edgeOf(S.btn, a); placePointer(a.x, a.y); await wait(260); movePointer(e.tip.x, e.tip.y); await wait(1000);
      pressPointer(); S.btn.classList.add('pressed'); await wait(140); S.btn.classList.remove('pressed'); notice('Verified: human click', 'ok');
      note('The click came from a hand', 'Before answering, the server looks at how the pointer moved. This path curved, trembled and slowed onto the button, so the real balance comes back.', 'ok', 'curved path · slows onto the button · 118 ms press');
    } else if (i === 1) {
      S.pointer.classList.remove('show'); S.passkey.classList.remove('in'); seal(false); S.amount.textContent = '$4,939.10'; S.notice.className = 'f-notice';
      await wait(300); placeAgent(); S.agent.classList.add('in'); S.ai.classList.add('typing'); S.ai.textContent = '';
      await typePrompt('What’s my balance?');
      await wait(400); S.guard.className = 'f-guard agent'; S.guard.lastElementChild.textContent = 'Agent attached · sealed'; seal(true);
      note('An assistant joined the tab', 'Its browser tool leaves traces the page can see. Within 0.3 s every number already on screen is blurred, before the assistant can read it.', 'warn', 'seal · 0.3 s after attach');
      await wait(400); await aiSay('I can see the account, but the balance field shows •••• .', 600);
    } else if (i === 2) {
      placeAgent(); S.agent.classList.add('in'); S.guard.className = 'f-guard agent'; S.guard.lastElementChild.textContent = 'Agent attached · sealed'; S.passkey.classList.remove('in');
      const fb = S.body.getBoundingClientRect(), ar = S.agent.getBoundingClientRect(); const a = { x: ar.left - fb.left + 4, y: ar.bottom - fb.top - 4 };
      await typePrompt('Download my statement.');
      const e = edgeOf(S.btn, a, 6); movePointer(e.tip.x, e.tip.y, true); await wait(400); pressPointer(); S.btn.classList.add('pressed'); await wait(60); S.btn.classList.remove('pressed');
      await wait(300); S.amount.textContent = '$•,•••.••'; S.amount.classList.remove('sealed'); flash(S.amount, 'flash-mask'); notice('Masked for AI agents · balance.read → mask', 'warn');
      note('The assistant clicks, and the server answers differently', 'No pointer path and an instant press: a program. Your policy says balance → mask, so the same endpoint returns the number hidden.', 'warn', 'no path · jumped to the centre · 2 ms press');
      await wait(1400); await aiSay('Trying “Statement”…', 500); const e2 = edgeOf(S.btn.nextElementSibling, a, 6); movePointer(e2.tip.x, e2.tip.y, true); await wait(500); pressPointer(); await wait(150);
      S.guard.className = 'f-guard block'; S.guard.lastElementChild.textContent = 'Waiting for Ada'; flash(S.btn.nextElementSibling, 'flash-block'); notice('report.export → step_up · Ada approves with her passkey', 'bad');
      note('The export waits for the person', 'A statement export hands over the whole account in one click. The agent may ask; only Ada can approve it, with her passkey. The agent cannot do that step.', 'bad', 'report.export → you approve');
      await wait(500); await aiSay('The download needs your approval. Confirm it with Touch ID.', 600);
    } else {
      S.pointer.classList.remove('show'); S.agent.classList.remove('in'); S.passkey.classList.add('in'); await wait(1800); S.passkey.classList.remove('in');
      S.guard.className = 'f-guard'; S.guard.lastElementChild.textContent = 'You’re back · 5:00';
      seal(false); S.amount.textContent = '$4,939.10'; notice('Presence verified with a passkey · session reclaimed', 'ok');
      note('Ada proves she is there', 'Touch ID cannot be faked by an assistant. For five minutes the session is hers again and the data comes back.', 'ok', 'reclaim · webauthn · 5 min');
    }
  }
  if ('IntersectionObserver' in window && innerWidth > 980) {
    const sio = new IntersectionObserver((es) => {
      const hit = es.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (hit) setStep(+hit.target.dataset.step);
    }, { rootMargin: '-45% 0px -45% 0px', threshold: 0 });
    S.steps.forEach((el) => sio.observe(el));
    setTimeout(() => { if (step < 0) setStep(0); }, 800);
  } else {
    // narrow screens: the steps are cards; tap one to play it, otherwise play through slowly
    S.steps.forEach((el) => el.addEventListener('click', () => setStep(+el.dataset.step)));
    if ('IntersectionObserver' in window) { const fio = new IntersectionObserver((es) => { if (es[0].isIntersecting) { setStep(0); fio.disconnect(); } }, { threshold: .3 }); fio.observe(S.frame); } else setStep(0);
  }

  // ---------------------------------------------------------------- 3D point cloud (WebGL): a fingerprint that becomes a lattice when the agent is in
  (function morph() {
    const cv = $('#morph'); if (!cv || reduced) return;
    const gl = cv.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: true, powerPreference: 'low-power' }); if (!gl) return;
    const N = 2744; // 14³, the lattice; the fingerprint uses the same count so every point has a home in both shapes
    const A = new Float32Array(N * 3), B = new Float32Array(N * 3);
    // A: a fingerprint in 3D: nine oval ridges, staggered breaks, a gentle dome in z
    let i = 0;
    const perRing = Math.floor(N / 9);
    for (let k = 0; k < 9; k++) {
      const rx = 0.08 + 0.1 * k, ry = 0.1 + 0.115 * k, open = k >= 5;
      for (let j = 0; j < perRing; j++) {
        const u = j / perRing, a0 = open ? (-200 + 220 * u) : (-180 + 360 * u), a = a0 * Math.PI / 180;
        const gap = Math.sin(a * 3 + k * 1.7) > 0.93;                            // ridge breaks
        const r = gap ? 0 : 1;
        A[i * 3] = rx * Math.cos(a) * r; A[i * 3 + 1] = ry * Math.sin(a) * r * 0.9; A[i * 3 + 2] = (0.25 - (rx * rx + ry * ry) * 0.18) * r; i++;
      }
    }
    for (; i < N; i++) { A[i * 3] = 0; A[i * 3 + 1] = 0; A[i * 3 + 2] = 0.26; }
    // B: a cubic lattice, the shape of a program
    i = 0; for (let x = 0; x < 14; x++) for (let y = 0; y < 14; y++) for (let z = 0; z < 14; z++) { B[i * 3] = (x / 13 - .5) * 1.2; B[i * 3 + 1] = (y / 13 - .5) * 1.2; B[i * 3 + 2] = (z / 13 - .5) * 1.2; i++; }
    const VS = `attribute vec3 a;attribute vec3 b;uniform float m;uniform float t;uniform vec2 R;uniform float dpr;varying float vz;varying float vm;
      void main(){float mm=smoothstep(0.,1.,m);vec3 p=mix(a,b,mm);
        float cy=cos(t*.25),sy=sin(t*.25);p=vec3(p.x*cy+p.z*sy,p.y,-p.x*sy+p.z*cy);
        float cx=cos(.35),sx=sin(.35);p=vec3(p.x,p.y*cx-p.z*sx,p.y*sx+p.z*cx);
        float d=2.6+p.z;vec2 s=p.xy/d*vec2(R.y/R.x,1.)*2.4;gl_Position=vec4(s,0.,1.);
        gl_PointSize=(3.6-p.z*1.6)*dpr*(1.-mm*.2);vz=p.z;vm=mm;}`;
    const FS = `precision mediump float;varying float vz;varying float vm;
      void main(){vec2 c=gl_PointCoord-.5;float d=dot(c,c);if(d>.25)discard;float e=smoothstep(.25,.05,d);
        vec3 mint=vec3(.486,.941,.753),blue=vec3(.541,.706,1.);vec3 col=mix(mint,blue,vm);
        float depth=clamp(.6+vz*.7,.35,1.);gl_FragColor=vec4(col*depth*e,e*depth);}`;
    const sh = (t, src) => { const o = gl.createShader(t); gl.shaderSource(o, src); gl.compileShader(o); return gl.getShaderParameter(o, gl.COMPILE_STATUS) ? o : null; };
    const vs = sh(gl.VERTEX_SHADER, VS), fs = sh(gl.FRAGMENT_SHADER, FS); if (!vs || !fs) return;
    const prog = gl.createProgram(); gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog); if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    gl.useProgram(prog);
    const buf = (data, name) => { const bo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, bo); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); const loc = gl.getAttribLocation(prog, name); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0); };
    buf(A, 'a'); buf(B, 'b');
    const uM = gl.getUniformLocation(prog, 'm'), uT = gl.getUniformLocation(prog, 't'), uR = gl.getUniformLocation(prog, 'R'), uD = gl.getUniformLocation(prog, 'dpr');
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    let target = 0, m = 0, live = false, t0 = performance.now();
    const dpr = Math.min(2, devicePixelRatio || 1);
    const size = () => { const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr); if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; gl.viewport(0, 0, w, h); } };
    addEventListener('resize', size, { passive: true });
    function frame(now) {
      if (!live || document.visibilityState !== 'visible') return;
      size(); m += (target - m) * .045;
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(uM, m); gl.uniform1f(uT, (now - t0) / 1000); gl.uniform2f(uR, cv.width, cv.height); gl.uniform1f(uD, dpr);
      gl.drawArrays(gl.POINTS, 0, N); requestAnimationFrame(frame);
    }
    window.OneHumanMorph = { setState: (v) => { target = v; } };
    const mio = 'IntersectionObserver' in window ? new IntersectionObserver((es) => { live = es[0].isIntersecting; if (live) requestAnimationFrame(frame); }, { threshold: 0 }) : null;
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && live) requestAnimationFrame(frame); });
    if (mio) mio.observe(cv); else { live = true; requestAnimationFrame(frame); }
  })();

  // ---------------------------------------------------------------- cursor physics demo (canvas)
  const cv = $('#cursors'); const ctx = cv.getContext('2d'); const W = cv.width, H = cv.height;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const ease = (x) => 10 * x ** 3 - 15 * x ** 4 + 6 * x ** 5; // minimum-jerk
  function humanPath(a, b) { const pts = []; const n = 70 + Math.floor(rnd(0, 30)); const bulge = rnd(-1, 1) * 0.04; let x = a.x, y = a.y; for (let i = 0; i <= n; i++) { const u = i / n, e = ease(u); const tx = a.x + (b.x - a.x) * e + Math.sin(u * Math.PI) * (b.y - a.y) * bulge, ty = a.y + (b.y - a.y) * e - Math.sin(u * Math.PI) * (b.x - a.x) * bulge; const sp = Math.hypot(tx - x, ty - y); x = tx + gauss() * (0.6 + sp * 0.12) * (Math.random() < 0.15 ? 3 : 1); y = ty + gauss() * (0.6 + sp * 0.12) * (Math.random() < 0.15 ? 3 : 1); pts.push({ x, y }); } for (let k = 0; k < 4; k++) pts.push({ x: b.x + gauss() * 0.8, y: b.y + gauss() * 0.8 }); return pts; }
  function bezierPath(a, b) { const c1 = { x: a.x + (b.x - a.x) * rnd(0.1, 0.4), y: a.y + rnd(-34, 34) }, c2 = { x: a.x + (b.x - a.x) * rnd(0.6, 0.9), y: b.y + rnd(-34, 34) }; const pts = []; const n = 60; for (let i = 0; i <= n; i++) { const u = i / n, v = 1 - u; pts.push({ x: v ** 3 * a.x + 3 * v * v * u * c1.x + 3 * v * u * u * c2.x + u ** 3 * b.x, y: v ** 3 * a.y + 3 * v * v * u * c1.y + 3 * v * u * u * c2.y + u ** 3 * b.y }); } return pts; }
  const lanes = [{ y: 70, color: '#7df0c0', kind: 'human' }, { y: 180, color: '#8ab4ff', kind: 'agent' }, { y: 290, color: '#ff7b7b', kind: 'bot' }];
  const runs = lanes.map((l) => ({ ...l, t: 0, pts: [], target: null, phase: 'move', hold: 0 }));
  function newRun(r) { tctx.clearRect(0, r.y - 55, W, 110); const a = { x: rnd(150, 210), y: r.y + rnd(-10, 10) }, b = { x: rnd(820, 980), y: r.y + rnd(-10, 10) }; r.target = b; r.pts = r.kind === 'human' ? humanPath(a, b) : r.kind === 'bot' ? bezierPath(a, b) : [a, b]; r.t = 0; r.phase = 'move'; r.hold = 0; r.start = a; }
  const trail = document.createElement('canvas'); trail.width = W; trail.height = H; const tctx = trail.getContext('2d');
  runs.forEach(newRun);
  let last = performance.now(), running = false;
  function frame(now) {
    if (!running) return;
    const dt = Math.min(50, now - last); last = now;
    ctx.clearRect(0, 0, W, H);
    const mono = getComputedStyle(document.body).getPropertyValue('--mono') || 'monospace';
    for (const r of runs) { ctx.setLineDash([2, 6]); ctx.beginPath(); ctx.moveTo(130, r.y); ctx.lineTo(W - 40, r.y); ctx.strokeStyle = 'rgba(255,255,255,.07)'; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]); ctx.font = '12px ' + mono; ctx.fillStyle = 'rgba(255,255,255,.38)'; ctx.fillText(r.kind === 'human' ? 'human' : r.kind === 'agent' ? 'agent' : 'bot', 30, r.y + 4); }
    ctx.drawImage(trail, 0, 0);
    for (const r of runs) {
      ctx.beginPath(); ctx.arc(r.target.x, r.target.y, 20, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.lineWidth = 1.2; ctx.stroke();
      ctx.beginPath(); ctx.arc(r.target.x, r.target.y, 2.5, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,255,255,.4)'; ctx.fill();
      if (r.phase === 'move') {
        r.t += r.kind === 'agent' ? 1e9 : 0.9 / dt * 16;
        const i = Math.min(r.pts.length - 1, Math.floor(r.t)); const p = r.pts[i];
        if (i > 0) { const q = r.pts[i - 1]; tctx.beginPath(); tctx.moveTo(q.x, q.y); tctx.lineTo(p.x, p.y); tctx.strokeStyle = r.color; tctx.lineWidth = 1.8; tctx.globalAlpha = .9; tctx.stroke(); tctx.globalAlpha = 1; }
        if (r.kind === 'agent') { tctx.setLineDash([3, 7]); tctx.beginPath(); tctx.moveTo(r.start.x, r.start.y); tctx.lineTo(r.target.x, r.target.y); tctx.strokeStyle = 'rgba(138,180,255,.35)'; tctx.lineWidth = 1; tctx.stroke(); tctx.setLineDash([]); }
        ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.fillStyle = r.color; ctx.shadowColor = r.color; ctx.shadowBlur = 14; ctx.fill(); ctx.shadowBlur = 0;
        if (i >= r.pts.length - 1) { r.phase = 'hold'; r.hold = r.kind === 'human' ? rnd(90, 200) : r.kind === 'agent' ? 3 : 90; r.holdT = 0; }
      } else if (r.phase === 'hold') {
        r.holdT += dt; const p = r.target;
        ctx.beginPath(); ctx.arc(p.x, p.y, 6 + Math.min(10, r.holdT / 12), 0, Math.PI * 2); ctx.strokeStyle = r.color; ctx.lineWidth = 2.5; ctx.stroke();
        if (r.holdT >= r.hold) { r.phase = 'verdict'; r.holdT = 0; }
      } else {
        r.holdT += dt; const p = r.target; const label = r.kind === 'human' ? 'allow' : r.kind === 'agent' ? 'mask' : 'block';
        const mono = getComputedStyle(document.body).getPropertyValue('--mono') || 'monospace'; ctx.font = '12px ' + mono; const tw = ctx.measureText(label).width; const bx = p.x + 32, by = p.y - 12;
        ctx.globalAlpha = Math.min(1, r.holdT / 200); ctx.beginPath(); ctx.roundRect(bx, by, tw + 16, 24, 4); ctx.fillStyle = r.color + '14'; ctx.fill(); ctx.strokeStyle = r.color + '66'; ctx.lineWidth = 1; ctx.stroke(); ctx.fillStyle = r.color; ctx.fillText(label, bx + 8, p.y + 4); ctx.globalAlpha = 1;
        if (r.holdT > 1600) newRun(r);
      }
    }
    requestAnimationFrame(frame);
  }
  if (!reduced) {
    const cio = 'IntersectionObserver' in window ? new IntersectionObserver((es) => { const v = es[0].isIntersecting; if (v && !running) { running = true; last = performance.now(); requestAnimationFrame(frame); } else if (!v) running = false; }, { threshold: 0.1 }) : null;
    if (cio) cio.observe(cv); else { running = true; requestAnimationFrame(frame); }
  }
})();
