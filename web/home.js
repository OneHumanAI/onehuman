// SPDX-License-Identifier: BUSL-1.1
/* OneHuman site chrome for the short pages (home, compare): copy button, the "an agent is here" note, the nav, reveal on scroll,
   and the homepage's motion: the hero background, headings that blur in, the three steps lighting up in turn, the typed command. */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = matchMedia('(hover:hover) and (pointer:fine)').matches;

  // ---------------------------------------------------------------- toast + copy
  const toastEl = $('#toast'); let toastT;
  const toast = (m) => { toastEl.textContent = m; toastEl.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), 1800); };
  async function copy(text, msg = 'Copied') { try { await navigator.clipboard.writeText(text); toast(msg); } catch { toast('Could not copy'); } }
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

  // ---------------------------------------------------------------- hero: requests arriving, and the decision on each one
  // Lanes of traffic crossing the hero. Each square is one request. At the decision line the rule for it applies, and
  // it leaves as one of the three answers the product gives: it passes (mint), it goes on with the private fields
  // hidden (hollow), or it waits for the person (blue, stopped) and continues once they approve. Small and slow
  // enough to read past; the text sits in a hole punched through it by the mask in landing.css.
  (function heroFlow() {
    const cv = $('#hero-flow'); if (!cv) return;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    const MINT = '125,240,192', BLUE = '138,180,255';
    const SIZE = 5, GAP = 430, HOLD_MS = 1400, EXT = 205, SPACING = 52, FADE = 320;   // the lanes run EXT past the hero and dissolve over the last FADE px, so none of them ends on a hard edge
    let W = 0, H = 0, lanes = [], decisionX = 0, live = true, last = 0, raf = 0;

    // what the rule says about this request: most pass, some keep going with fields hidden, a few wait for a person
    const verdict = () => { const r = Math.random(); return r < 0.55 ? 'allow' : r < 0.85 ? 'hide' : 'hold'; };

    function layout() {
      const w = cv.clientWidth, h = cv.clientHeight; if (!w || !h) return false;
      const dpr = Math.min(2, devicePixelRatio || 1);
      W = w; H = h;
      decisionX = Math.round(w * (w < 1100 ? 0.68 : 0.62));
      const panel = $('.hero-side:not([hidden])'), head = $('.home .h1'), box = cv.getBoundingClientRect();
      if (panel && head) {
        const pr = panel.getBoundingClientRect(), hr = head.getBoundingClientRect();
        if (pr.top < hr.bottom) decisionX = Math.round((hr.right + pr.left) / 2 - box.left);   // side by side
        cv.style.setProperty('--mx', `${(((hr.left + hr.right) / 2 - box.left) / w * 100).toFixed(1)}%`);
        cv.style.setProperty('--my', `${(((hr.top + hr.bottom) / 2 - box.top) / h * 100).toFixed(1)}%`);
      }
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const first = Math.round((h - EXT) * 0.17);
      const count = Math.max(3, Math.floor((h - 40 - first) / SPACING) + 1);
      lanes = Array.from({ length: count }, (_, i) => {
        const reqs = [];
        for (let x = -((i * 151) % GAP); x < w + SIZE; x += GAP) reqs.push({ x, v: x > decisionX ? verdict() : null, held: 0 });
        return { y: first + i * SPACING + 0.5, speed: 16 + (i % 3) * 5, reqs };
      });
      return true;
    }

    function step(dt) {
      for (const l of lanes) {
        for (const r of l.reqs) {
          if (r.held > 0) { r.held -= dt; if (r.held <= 0) { r.held = 0; r.v = 'allow'; } continue; }
          const nx = r.x + l.speed * dt / 1000;
          if (r.v === null && nx >= decisionX) { r.x = decisionX; r.v = verdict(); if (r.v === 'hold') r.held = HOLD_MS; }
          else r.x = nx;
          // off the right edge: back to the start of its own lane, keeping the spacing
          if (r.x > W + SIZE) { r.x = Math.min(...l.reqs.map((o) => o.x)) - GAP; r.v = null; }
        }
      }
    }

    function draw() {
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, W, H);
      ctx.lineWidth = 1;
      // the rules fade out at the left and right edges, so they read strongest behind the middle of the hero
      const lineFade = ctx.createLinearGradient(0, 0, W, 0);
      lineFade.addColorStop(0, 'rgba(255,255,255,0)'); lineFade.addColorStop(.5, 'rgba(255,255,255,.1)'); lineFade.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.strokeStyle = lineFade;
      ctx.beginPath();
      for (const l of lanes) { ctx.moveTo(0, l.y); ctx.lineTo(W, l.y); }
      ctx.stroke();
      for (const l of lanes) {
        for (const r of l.reqs) {
          const edge = Math.min(1, r.x / 80, (W - r.x) / 80); if (edge <= 0) continue;
          const x = r.x - SIZE / 2, y = l.y - SIZE / 2;
          ctx.globalAlpha = edge;
          if (r.held > 0) {                                   // waiting for the person
            const t = 1 - r.held / HOLD_MS;
            ctx.strokeStyle = `rgba(${BLUE},${.5 * (1 - (t * 2 % 1))})`;
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.arc(r.x, l.y, SIZE / 2 + 3 + (t * 2 % 1) * 5, 0, 6.284); ctx.stroke();
            ctx.fillStyle = `rgb(${BLUE})`; ctx.fillRect(x, y, SIZE, SIZE);
          } else if (r.v === 'allow') {
            ctx.fillStyle = `rgba(${MINT},.85)`; ctx.fillRect(x, y, SIZE, SIZE);
          } else if (r.v === 'hide') {                        // through, but its private fields are not in it
            ctx.strokeStyle = `rgba(${BLUE},.6)`; ctx.lineWidth = 1;
            ctx.strokeRect(x + .5, y + .5, SIZE - 1, SIZE - 1);
          } else {
            ctx.fillStyle = 'rgba(255,255,255,.34)'; ctx.fillRect(x, y, SIZE, SIZE);
          }
        }
      }
      ctx.globalAlpha = 1;
      // dissolve towards the bottom, so nothing is cut off where the hero ends
      ctx.globalCompositeOperation = 'destination-out';
      const fade = ctx.createLinearGradient(0, H - FADE, 0, H);
      for (let i = 0; i <= 8; i++) { const t = i / 8; fade.addColorStop(t, `rgba(0,0,0,${(t * t * (3 - 2 * t)).toFixed(3)})`); }
      ctx.fillStyle = fade; ctx.fillRect(0, H - FADE, W, FADE);
      ctx.globalCompositeOperation = 'source-over';
    }

    function frame(now) {
      raf = 0;
      if (!live || document.visibilityState !== 'visible') return;
      const dt = Math.min(64, now - last || 16); last = now;
      step(dt); draw();
      raf = requestAnimationFrame(frame);
    }
    const start = () => { if (!raf && live && !reduced) { last = performance.now(); raf = requestAnimationFrame(frame); } };

    if (!layout()) return;
    if (reduced) { draw(); return; }                          // at rest: the lanes, the decision line, the requests where they stand
    addEventListener('resize', () => { if (layout()) draw(); }, { passive: true });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') start(); });
    if ('IntersectionObserver' in window) new IntersectionObserver((es) => { live = es[0].isIntersecting; start(); }, { threshold: 0 }).observe(cv);
    start();
  })();

  // ---------------------------------------------------------------- headings: words blur in when they scroll into view
  (function textReveal() {
    const hs = $$('.tr'); if (!hs.length) return;
    hs.forEach((h) => {
      // data-px lists the words to set in the pixel stylistic set; the heading is rebuilt here, so they cannot be spans in the markup
      const px = new Set((h.dataset.px || '').split(/\s+/).filter(Boolean));
      const mark = (w) => (px.has(w.replace(/[.,:;]+$/, '')) ? ' px' : '');
      let i = 0;
      const words = (t) => t.split(/(\s+)/).map((w) => (/^\s*$/.test(w) ? w : `<span class="tw${mark(w)}" style="--i:${i++}">${w}</span>`)).join('');
      h.innerHTML = [...h.childNodes].map((n) => (n.nodeType === 1 ? `<span class="${n.className}">${words(n.textContent)}</span>` : words(n.textContent))).join('');
    });
    if (!('IntersectionObserver' in window) || reduced) { hs.forEach((h) => h.classList.add('in')); return; }
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: .3 });
    hs.forEach((h) => io.observe(h));
  })();

  // ---------------------------------------------------------------- cards: rise in with a stagger, a soft light follows the pointer
  $$('.grid3').forEach((g) => $$('.feat', g).forEach((el, i) => el.style.setProperty('--i', i)));
  if (finePointer) $$('.feat').forEach((f) => f.addEventListener('pointermove', (e) => { const r = f.getBoundingClientRect(); f.style.setProperty('--mx', `${e.clientX - r.left}px`); f.style.setProperty('--my', `${e.clientY - r.top}px`); }, { passive: true }));

  // ---------------------------------------------------------------- how it works: spot → rules → proof, one step at a time while in view
  (function flow() {
    const grid = $('#flow'); if (!grid || reduced || !('IntersectionObserver' in window)) return;
    const steps = $$('.feat', grid), STEP = 2600; let k = -1, timer = null;
    grid.style.setProperty('--step', `${STEP}ms`);
    const next = () => { steps.forEach((s) => s.classList.remove('on')); k = (k + 1) % steps.length; void steps[k].offsetWidth; steps[k].classList.add('on'); };
    new IntersectionObserver((es) => {
      if (es[0].isIntersecting && !timer) { next(); timer = setInterval(next, STEP); }
      else if (!es[0].isIntersecting && timer) { clearInterval(timer); timer = null; }
    }, { threshold: .5 }).observe(grid);
  })();

  // ---------------------------------------------------------------- hero video: the poster until play, then the no-cookie player with sound
  (function heroVideo() {
    const b = $('#hero-video .hv-play'); if (!b) return;
    // pressing play is the visitor's own choice to load the player: no second question, and the stored cookie choices are not changed
    const ask = $('#hero-video .hv-ask');
    b.addEventListener('click', play);
    function play() {
      if (ask) ask.remove();
      const f = document.createElement('iframe');
      f.src = `https://www.youtube-nocookie.com/embed/${b.dataset.yt}?autoplay=1&rel=0&modestbranding=1&playsinline=1`;
      f.title = 'OneHuman demo';
      f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
      f.allowFullscreen = true;
      f.referrerPolicy = 'strict-origin-when-cross-origin';   // the page sends no referrer; YouTube's player needs one
      b.replaceWith(f);
    }
  })();

  // ---------------------------------------------------------------- hero panel: the same record, for a person and for an AI agent
  (function heroPanel() {
    const p = $('#hero-panel'); if (!p) return;
    const tabs = $$('[role="tab"]', p); let who = 'person', timer = null;
    const set = (w) => { who = w; p.dataset.who = w; tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.who === w))); };
    tabs.forEach((t) => t.addEventListener('click', () => { clearInterval(timer); timer = null; set(t.dataset.who); }));
    if (!reduced) timer = setInterval(() => set(who === 'person' ? 'agent' : 'person'), 3600);
  })();

  // ---------------------------------------------------------------- demo scene: a person works the list, then an AI agent takes over
  (function scene() {
    const sc = $('#scene'), stage = $('#sc-stage'); if (!sc || !stage) return;
    const human = $('#sc-human'), agent = $('#sc-agent'), log = $('#sc-log'), exp = $('#sc-export'), rows = $$('tbody tr', stage);
    const at = (cur, el, fx = 0.5, fy = 0.5) => {
      const s = stage.getBoundingClientRect(), r = el.getBoundingClientRect();
      cur.style.transform = `translate(${Math.round(r.left - s.left + r.width * fx)}px, ${Math.round(r.top - s.top + r.height * fy)}px)`;
    };
    const cell = (row, col) => rows[row].children[col];
    const click = (cur, el) => { cur.classList.remove('click'); void cur.offsetWidth; cur.classList.add('click'); if (el) { el.classList.add('press'); setTimeout(() => el.classList.remove('press'), 350); } };
    const hit = (i) => rows.forEach((r, k) => r.classList.toggle('hit', k === i));
    const say = (t) => { log.textContent = t; };
    const state = (s) => { sc.dataset.state = s; };
    const final = () => { state('wait'); human.classList.remove('show'); agent.classList.add('show'); at(agent, exp, .8, .7); say('contacts.export → ask the person first · signed'); };
    if (reduced) { final(); return; }
    // [time, step] — one pass is about nine seconds, then it starts again
    const script = [
      [0, () => { state('person'); hit(-1); agent.classList.remove('show'); human.classList.add('show'); at(human, cell(3, 1), .3, 1.4); at(agent, stage, 1.02, 0.02); say('contacts.read → allow · signed'); }],
      [500, () => at(human, cell(0, 0), .6, .6)],
      [1500, () => { click(human); hit(0); }],
      [1900, () => at(human, cell(0, 2), .5, .6)],
      [3000, () => { human.classList.remove('show'); agent.classList.add('show'); state('agent'); hit(-1); say('contacts.read → private fields hidden · signed'); }],
      [3200, () => at(agent, cell(1, 2), .45, .6)],
      [4300, () => at(agent, cell(2, 3), .5, .6)],
      [5300, () => at(agent, exp, .6, .6)],
      [6300, () => { click(agent, exp); state('wait'); say('contacts.export → ask the person first · signed'); }],
    ];
    const LOOP = 9400; let timers = [], running = false;
    const run = () => { timers.forEach(clearTimeout); timers = script.map(([t, f]) => setTimeout(f, t)); timers.push(setTimeout(() => running && run(), LOOP)); };
    const stop = () => { running = false; timers.forEach(clearTimeout); timers = []; };
    if (!('IntersectionObserver' in window)) { running = true; run(); return; }
    new IntersectionObserver((es) => { if (es[0].isIntersecting && !running) { running = true; run(); } else if (!es[0].isIntersecting && running) stop(); }, { threshold: .35 }).observe(sc);
  })();

  // ---------------------------------------------------------------- install: pick a step, see its code
  (function codebox() {
    const box = $('#codebox'); if (!box) return;
    const tabs = $$('[data-code]', box), copyBtn = $('#cb-copy');
    const set = (k) => {
      tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.code === k)));
      $$('.cb-pane', box).forEach((p) => { p.hidden = p.dataset.pane !== k; });
      const code = $(`.cb-pane[data-pane="${k}"] code`, box).textContent.split('\n').filter((l) => !l.startsWith('#')).join('\n').trim();
      copyBtn.dataset.copy = code;
    };
    tabs.forEach((t) => t.addEventListener('click', () => set(t.dataset.code)));
  })();

  // ---------------------------------------------------------------- hero: the agent name rotates
  (function rotator() {
    const rot = $('#rot'); if (!rot) return;
    const words = $$('span', rot); let i = 0;
    const h1 = rot.closest('h1'), line = rot.closest('.rot-line'), br1 = line.querySelector('.m-br1'), br2 = line.querySelector('.m-br2');
    const fit = (w) => { rot.style.width = `${w.offsetWidth}px`; };
    const width = (from, to) => { const r = document.createRange(); r.setStartBefore(from); r.setEndAfter(to); return r.getBoundingClientRect().width; };
    // one decision for the widest name, so the lines never re-break while the names rotate:
    // "Your customers send <name> into your app." on one line, else broken after "send", else after the name too
    const layout = () => {
      h1.classList.remove('stack', 'stack2');
      const lead = width(line.firstChild, br1), tail = width(br2, line.lastChild), max = h1.getBoundingClientRect().width;
      const widest = Math.max(...words.map((w) => w.offsetWidth));
      const stack = lead + widest + tail + 12 > max;
      h1.classList.toggle('stack', stack);
      h1.classList.toggle('stack2', stack && widest + tail + 12 > max);
      fit(words[i]);
    };
    layout(); if (document.fonts && document.fonts.ready) document.fonts.ready.then(layout);
    addEventListener('resize', layout, { passive: true });
    if (reduced) return;
    setInterval(() => {
      if (document.hidden) return;
      const cur = words[i], next = words[(i + 1) % words.length];
      cur.classList.remove('on'); cur.classList.add('out'); setTimeout(() => cur.classList.remove('out'), 600);
      next.classList.add('on'); i = (i + 1) % words.length; fit(next);
    }, 2800);
  })();

  // ---------------------------------------------------------------- count-up stats
  (() => {
    const nums = $$('.ev b[data-count]');
    if (!nums.length) return;
    const animate = (el) => {
      const target = parseFloat(el.dataset.count);
      const suffix = el.dataset.suffix || '';
      if (reduced) { el.textContent = target.toLocaleString('en-US') + suffix; return; }
      const dur = 800, start = performance.now();
      const step = (now) => {
        const p = Math.min((now - start) / dur, 1);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.round(target * eased).toLocaleString('en-US') + suffix;
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };
    if ('IntersectionObserver' in window) {
      const io2 = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { animate(e.target); io2.unobserve(e.target); } }), { threshold: 0.4 });
      nums.forEach((el) => io2.observe(el));
    } else nums.forEach((el) => { el.textContent = parseFloat(el.dataset.count).toLocaleString('en-US') + (el.dataset.suffix || ''); });
  })();

  // ---------------------------------------------------------------- reveal on scroll
  const io = 'IntersectionObserver' in window ? new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -8% 0px', threshold: 0.05 }) : null;
  $$('.reveal').forEach((el) => io ? io.observe(el) : el.classList.add('in'));
  const sweep = () => { const left = $$('.reveal:not(.in)'); left.forEach((el) => { if (el.getBoundingClientRect().top < innerHeight * 1.05) el.classList.add('in'); }); if (!left.length) removeEventListener('scroll', sweep); };
  addEventListener('scroll', sweep, { passive: true }); addEventListener('load', sweep); setTimeout(sweep, 1200);
})();
