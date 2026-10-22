// SPDX-License-Identifier: BUSL-1.1
/* Site chrome shared by every public page: the mobile menu, the bar's border on scroll, and the GitHub star count. */
(() => {
  const nav = document.getElementById('nav'); if (!nav) return;

  const btn = document.getElementById('nav-menu');
  if (btn) {
    const set = (open) => { nav.classList.toggle('open', open); btn.setAttribute('aria-expanded', String(open)); };
    btn.addEventListener('click', () => set(!nav.classList.contains('open')));
    nav.querySelectorAll('#nav-links a').forEach((a) => a.addEventListener('click', () => set(false)));
    addEventListener('keydown', (e) => { if (e.key === 'Escape') set(false); });
    matchMedia('(min-width:821px)').addEventListener('change', (e) => { if (e.matches) set(false); });
  }

  // signed in: "Log in" becomes the way back to the dashboard; "Book a demo" stays
  const chip = document.getElementById('nav-portal');
  if (chip) fetch('/api/v1/portal/me?probe=1', { credentials: 'same-origin', cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((d) => {
    const email = d?.account?.email; if (!email) return;
    const signin = document.getElementById('nav-signin'); if (signin) signin.hidden = true;
    document.querySelectorAll('.m-signin').forEach((a) => { a.textContent = 'Dashboard'; });
    document.getElementById('nav-av').textContent = email[0].toUpperCase();
    chip.title = email; chip.hidden = false;
  }).catch(() => {});

  const onScroll = () => nav.classList.toggle('scrolled', scrollY > 8);
  addEventListener('scroll', onScroll, { passive: true }); onScroll();

  // content pages (trust, scorecard, measurements): blocks rise in as they reach the screen, like the homepage
  const blocks = [...document.querySelectorAll('main.trust > *, main.sc > *')];
  if (blocks.length && 'IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -6% 0px' });
    blocks.forEach((el) => { el.classList.add('rv'); io.observe(el); });
  }

  // cookie choices: essential storage is always on; the YouTube player (the one optional item) loads only with a yes.
  // The choice lives in this browser's local storage; the footer link opens the settings again.
  window.ohConsent = (() => {
    const KEY = 'oh_consent', V = 1;
    let state = null;
    try { state = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { /* blocked storage: ask again next page */ }
    if (state && state.v !== V) state = null;
    const box = document.createElement('aside');
    box.className = 'ck'; box.hidden = true;
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-labelledby', 'ck-title');
    box.innerHTML = `<p class="ck-eyebrow">Cookies</p>
      <h2 class="ck-title" id="ck-title">Your privacy choices</h2>
      <p class="ck-text">We use essential cookies to keep the site working and remember your preferences. Optional cookies stay off unless you allow them.</p>
      <div class="ck-set" hidden>
        <label class="ck-row"><span><b>Essential</b><small>Sign-in, security and your preferences. Always on.</small></span><input class="ck-sw" type="checkbox" checked disabled aria-label="Essential, always on"></label>
        <label class="ck-row"><span><b>Embedded videos</b><small>Videos played by YouTube, which may store data in your browser.</small></span><input class="ck-sw" type="checkbox" id="ck-media" aria-label="Embedded videos"></label>
      </div>
      <a class="ck-link" href="/cookies">Read the cookie policy</a>
      <div class="ck-btns"><button class="ck-b" type="button" data-ck="reject">Reject optional</button><button class="ck-b pri" type="button" data-ck="accept">Accept all</button><button class="ck-b" type="button" data-ck="settings">Cookie settings</button></div>`;
    document.body.append(box);
    const set = box.querySelector('.ck-set'), media = box.querySelector('#ck-media'), third = box.querySelector('[data-ck="settings"]');
    const close = () => { box.hidden = true; };
    const open = (settings) => {
      set.hidden = !settings; media.checked = !!state?.media;
      third.textContent = settings ? 'Save choices' : 'Cookie settings';
      box.hidden = false;
    };
    const save = (m) => {
      state = { v: V, media: m, at: new Date().toISOString().slice(0, 10) };
      try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* the choice lasts this page */ }
      close();
    };
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ck]'); if (!b) return;
      if (b.dataset.ck === 'reject') save(false);
      else if (b.dataset.ck === 'accept') save(true);
      else if (set.hidden) open(true);
      else save(media.checked);
    });
    // every footer gets the policy and the settings; any [data-ck-open] (the policy page has one) opens the settings
    const foot = document.querySelector('.foot nav');
    if (foot) foot.insertAdjacentHTML('beforeend', '<a href="/cookies">Cookie policy</a><a href="#cookie-settings" role="button" data-ck-open>Cookie settings</a>');
    document.addEventListener('click', (e) => { if (e.target.closest('[data-ck-open]')) { e.preventDefault(); open(true); } });
    if (!state) open(false);
    return { media: () => !!state?.media, allowMedia: () => save(true) };
  })();

  // below 100 a small number reads as weak proof, so only the icon shows
  const count = nav.querySelector('.gh-count');
  if (count) fetch('/api/v1/stars').then((r) => (r.ok ? r.json() : null)).then((d) => {
    if (!d || typeof d.stars !== 'number' || d.stars < 100) return;
    count.textContent = d.stars >= 1000 ? `${(d.stars / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(d.stars);
    count.hidden = false;
  }).catch(() => {});
})();
