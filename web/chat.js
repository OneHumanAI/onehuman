// SPDX-License-Identifier: BUSL-1.1
// The chat on onehuman.ai's public pages. An assistant answers at once (streamed from /api/v1/chat/send); a founder can
// step in from the admin panel and the visitor sees it here. Everything is same-origin and lives in a shadow root, so the page's
// styles and the widget's never touch. The chat is the visitor's by a token kept in this browser only.
(() => {
  if (window.__ohChat) return;
  window.__ohChat = true;
  const CALL = 'https://cal.com/onehumanai';
  const KEY = 'oh-chat-v1';
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null') || {}; } catch { return {}; } };
  const save = (s) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode: the chat lasts this page */ } };
  let state = load();                // { chat, token, last, seenTeaser }

  // the visitor's language for the few words the widget itself says; the assistant follows whatever they write
  const lang = (navigator.language || 'en').slice(0, 2).toLowerCase();
  const T = {
    en: { ask: 'Ask OneHuman', hi: 'Hi, glad you stopped by. Ask me anything about OneHuman. What are you building?', status: 'AI assistant · answers instantly', human: 'is in the chat', thinking: 'Thinking', placeholder: 'Ask anything about OneHuman…', send: 'Send', call: 'Book a 15-min call', callSub: 'with a founder · cal.com', teaser: 'Do your customers send AI agents into your app? Ask me, I answer instantly.', chips: ['How does it work?', 'Is it free to try?', 'Does it work with my stack?', 'Talk to a founder'], foot: 'AI assistant · a founder can join', error: 'That did not send. Check your connection and try again.', close: 'Close chat', newMsg: 'New message' },
    az: { ask: 'OneHuman-a sual ver', hi: 'Salam, xoş gəlmisiniz. OneHuman haqqında nə maraqlıdırsa, soruşun. Siz nə üzərində işləyirsiniz?', status: 'AI köməkçi · dərhal cavab verir', human: 'çatdadır', thinking: 'Düşünür', placeholder: 'OneHuman haqqında soruşun…', send: 'Göndər', call: '15 dəqiqəlik zəng təyin et', callSub: 'təsisçi ilə · cal.com', teaser: 'Müştəriləriniz tətbiqinizə AI agentlərlə girir? Soruşun, dərhal cavab verirəm.', chips: ['Necə işləyir?', 'Pulsuz sınamaq olar?', 'Mənim stack-imlə işləyir?', 'Təsisçi ilə danışmaq'], foot: 'AI köməkçi · təsisçi qoşula bilər', error: 'Göndərilmədi. İnterneti yoxlayıb yenidən cəhd edin.', close: 'Çatı bağla', newMsg: 'Yeni mesaj' },
    ru: { ask: 'Спросить OneHuman', hi: 'Здравствуйте! Спрашивайте про OneHuman что угодно. А вы над чем работаете?', status: 'AI-ассистент · отвечает сразу', human: 'в чате', thinking: 'Думаю', placeholder: 'Спросите что угодно об OneHuman…', send: 'Отправить', call: 'Звонок на 15 минут', callSub: 'с основателем · cal.com', teaser: 'Ваши клиенты заходят в продукт через AI-агентов? Спросите — отвечу сразу.', chips: ['Как это работает?', 'Можно попробовать бесплатно?', 'Подходит для моего стека?', 'Поговорить с основателем'], foot: 'AI-ассистент · основатель может подключиться', error: 'Не отправилось. Проверьте связь и попробуйте снова.', close: 'Закрыть чат', newMsg: 'Новое сообщение' },
    tr: { ask: "OneHuman'a sor", hi: "Merhaba, hoş geldiniz. OneHuman hakkında ne merak ediyorsanız sorun. Siz ne üzerinde çalışıyorsunuz?", status: 'AI asistan · anında yanıtlar', human: 'sohbette', thinking: 'Düşünüyor', placeholder: 'OneHuman hakkında her şeyi sorun…', send: 'Gönder', call: '15 dakikalık görüşme ayarla', callSub: 'bir kurucuyla · cal.com', teaser: 'Müşterileriniz uygulamanıza AI ajanlarla mı giriyor? Sorun, anında yanıtlayayım.', chips: ['Nasıl çalışıyor?', 'Ücretsiz denenebilir mi?', 'Benim altyapımla çalışır mı?', 'Bir kurucuyla konuşmak'], foot: 'AI asistan · bir kurucu katılabilir', error: 'Gönderilemedi. Bağlantınızı kontrol edip tekrar deneyin.', close: 'Sohbeti kapat', newMsg: 'Yeni mesaj' },
  };
  const t = T[lang] || T.en;

  const LOGO = '<svg viewBox="0 0 1080 1080" aria-hidden="true"><path d="M940,940l-204.44-352.1c-48.71,52.52-118.28,85.43-195.56,85.43s-146.84-32.91-195.56-85.43l-204.44,352.1h800Z"/><path d="M735.55,587.9c44.11-47.58,71.11-111.23,71.11-181.23,0-147.27-119.39-266.67-266.67-266.67s-266.67,119.4-266.67,266.67c0,70,27.01,133.66,71.12,181.23l195.54-336.79,195.56,336.79Z"/></svg>';
  const I = {
    send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    cal: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 10h17M8 3v4M16 3v4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  };

  const CSS = `
  :host{all:initial}
  *{box-sizing:border-box}
  [hidden]{display:none!important}
  .root{--bg:#0d0f12;--glass:rgba(16,18,22,.9);--line:rgba(255,255,255,.09);--fg:#eef1f0;--fg2:#a7b0ad;--fg3:#6f7975;--mint:#7df0c0;--mint2:#3ddc97;font:14.5px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fg);-webkit-font-smoothing:antialiased}
  /* launcher: a pill with a light that runs around its edge */
  .launch{position:fixed;right:20px;bottom:20px;z-index:2147483000;display:flex;align-items:center;gap:10px;height:48px;padding:0 18px 0 8px;border:0;border-radius:999px;cursor:pointer;color:var(--fg);background:var(--glass);box-shadow:0 10px 40px rgba(0,0,0,.45),0 0 0 1px var(--line);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);font:600 14px/1 inherit;font-family:inherit;transition:transform .2s ease,box-shadow .2s ease;isolation:isolate}
  .launch:hover{transform:translateY(-2px);box-shadow:0 14px 48px rgba(0,0,0,.5),0 0 0 1px rgba(125,240,192,.35)}
  .launch::before{content:"";position:absolute;inset:-1px;border-radius:inherit;padding:1px;background:conic-gradient(from var(--a,0deg),transparent 0 70%,var(--mint) 82%,transparent 94%);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;animation:beam 4s linear infinite;z-index:-1}
  @property --a{syntax:"<angle>";initial-value:0deg;inherits:false}
  @keyframes beam{to{--a:360deg}}
  .orb{position:relative;width:32px;height:32px;border-radius:50%;display:grid;place-items:center;background:radial-gradient(circle at 35% 30%,#b8ffe2,var(--mint) 45%,#22a877 100%);box-shadow:0 0 18px rgba(125,240,192,.45)}
  .orb svg{width:16px;height:16px;fill:#0a0a0b}
  .badge{position:absolute;top:-3px;right:-3px;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#ff5d5d;color:#fff;font:700 11px/18px inherit;font-family:inherit;text-align:center;box-shadow:0 0 0 2px var(--bg)}
  .teaser{position:fixed;right:20px;bottom:80px;z-index:2147483000;max-width:290px;padding:12px 34px 12px 14px;border-radius:14px;background:var(--glass);box-shadow:0 10px 40px rgba(0,0,0,.45),0 0 0 1px var(--line);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);color:var(--fg);font-size:13.5px;cursor:pointer;animation:rise .35s cubic-bezier(.2,.8,.2,1)}
  .teaser .x{position:absolute;top:6px;right:6px;width:22px;height:22px;border:0;border-radius:6px;background:transparent;color:var(--fg3);cursor:pointer;padding:3px}
  .teaser .x svg{width:16px;height:16px}
  @keyframes rise{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}
  /* the panel */
  .panel{position:fixed;right:20px;bottom:20px;z-index:2147483001;width:396px;height:min(640px,calc(100vh - 40px));display:flex;flex-direction:column;border-radius:20px;overflow:hidden;background:var(--glass);box-shadow:0 24px 80px rgba(0,0,0,.55),0 0 0 1px var(--line);backdrop-filter:blur(22px) saturate(140%);-webkit-backdrop-filter:blur(22px) saturate(140%);animation:rise .3s cubic-bezier(.2,.8,.2,1)}
  .panel::after{content:"";position:absolute;inset:0;pointer-events:none;border-radius:inherit;background:radial-gradient(600px 220px at 85% -10%,rgba(125,240,192,.12),transparent 60%)}
  .head{position:relative;display:flex;align-items:center;gap:12px;padding:14px 14px 14px 16px;border-bottom:1px solid var(--line)}
  .head .who{flex:1;min-width:0}
  .head b{display:block;font-size:15px;letter-spacing:-.01em}
  .head .st{display:flex;align-items:center;gap:6px;color:var(--fg2);font-size:12.5px}
  .head .dot{width:7px;height:7px;border-radius:50%;background:var(--mint);box-shadow:0 0 0 3px rgba(125,240,192,.18);animation:pulse 2.4s ease-in-out infinite}
  @keyframes pulse{50%{box-shadow:0 0 0 6px rgba(125,240,192,0)}}
  .icon{width:34px;height:34px;display:grid;place-items:center;border:0;border-radius:10px;background:transparent;color:var(--fg2);cursor:pointer}
  .icon:hover{background:rgba(255,255,255,.06);color:var(--fg)}
  .icon svg{width:18px;height:18px}
  .log{position:relative;flex:1;overflow-y:auto;padding:16px 14px 8px;overscroll-behavior:contain}
  .log::-webkit-scrollbar{width:6px}.log::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:3px}
  .row{display:flex;gap:8px;margin:0 0 10px;align-items:flex-end;animation:rise .25s ease}
  .row.me{justify-content:flex-end}
  .av{flex:none;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;background:var(--mint)}
  .av svg{width:13px;height:13px;fill:#0a0a0b}
  .av.p{background:#2a3330;color:var(--mint);font:700 12px/1 inherit;font-family:inherit}
  .col{display:flex;flex-direction:column;align-items:flex-start;gap:4px;max-width:82%;min-width:0}
  .me .col{align-items:flex-end}
  .bub{max-width:100%;padding:9px 12px;border-radius:16px 16px 16px 6px;background:rgba(255,255,255,.065);border:1px solid rgba(255,255,255,.06);white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere}
  .me .bub{border-radius:16px 16px 6px 16px;background:var(--mint);color:#08130e;border-color:transparent}
  .adm .bub{border-color:rgba(125,240,192,.35)}
  .name{display:block;margin:0 0 2px;color:var(--mint);font-size:11.5px;font-weight:600}
  .bub a{color:var(--mint);text-decoration:underline;text-underline-offset:2px}
  .me .bub a{color:#08130e}
  .sys{margin:6px auto 12px;text-align:center;color:var(--fg3);font-size:12px}
  .cta{display:flex;align-items:center;gap:10px;margin:2px 0 12px 34px;padding:10px 12px;border-radius:14px;text-decoration:none;color:var(--fg);background:linear-gradient(135deg,rgba(125,240,192,.16),rgba(125,240,192,.04));border:1px solid rgba(125,240,192,.32);transition:transform .15s ease,border-color .15s ease;max-width:82%}
  .cta:hover{transform:translateY(-1px);border-color:var(--mint)}
  .cta .ci{width:32px;height:32px;border-radius:9px;display:grid;place-items:center;background:var(--mint);color:#08130e;flex:none}
  .cta .ci svg{width:17px;height:17px}
  .cta b{display:block;font-size:13.5px}.cta span{display:block;color:var(--fg2);font-size:12px}
  /* thinking: an orb that breathes and a word that shimmers */
  .think{display:flex;align-items:center;gap:8px;margin:0 0 10px;color:var(--fg2);font-size:13px;animation:rise .25s ease}
  .think .o{flex:none;width:26px;height:26px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#d9fff0,var(--mint) 40%,rgba(61,220,151,.15) 72%,transparent 74%);animation:breathe 1.4s ease-in-out infinite;filter:drop-shadow(0 0 10px rgba(125,240,192,.55))}
  @keyframes breathe{0%,100%{transform:scale(.82);opacity:.75}50%{transform:scale(1.08);opacity:1}}
  .think span{background:linear-gradient(90deg,var(--fg3) 0%,var(--fg) 50%,var(--fg3) 100%);background-size:200% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:shimmer 1.6s linear infinite}
  @keyframes shimmer{to{background-position:-200% 0}}
  .caret::after{content:"";display:inline-block;width:7px;height:14px;margin-left:2px;vertical-align:-2px;border-radius:2px;background:var(--mint);animation:blink 1s step-end infinite}
  @keyframes blink{50%{opacity:0}}
  .chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 14px 10px}
  .chip{border:1px solid var(--line);background:rgba(255,255,255,.03);color:var(--fg);border-radius:999px;padding:7px 11px;font:13px/1 inherit;font-family:inherit;cursor:pointer;transition:border-color .15s ease,background .15s ease}
  .chip:hover{border-color:rgba(125,240,192,.5);background:rgba(125,240,192,.08)}
  .compose{position:relative;margin:0 12px 10px;padding:6px 6px 6px 14px;display:flex;align-items:flex-end;gap:8px;border-radius:16px;background:rgba(255,255,255,.05);border:1px solid var(--line);transition:border-color .15s ease,box-shadow .15s ease}
  .compose:focus-within{border-color:rgba(125,240,192,.55);box-shadow:0 0 0 4px rgba(125,240,192,.1)}
  textarea{flex:1;min-height:24px;max-height:120px;padding:8px 0;border:0;outline:0;resize:none;background:transparent;color:var(--fg);font:14.5px/1.45 inherit;font-family:inherit}
  textarea::placeholder{color:var(--fg3)}
  .send{flex:none;width:38px;height:38px;border:0;border-radius:12px;display:grid;place-items:center;cursor:pointer;background:var(--mint);color:#08130e;transition:transform .15s ease,opacity .15s ease}
  .send:disabled{opacity:.35;cursor:default}
  .send:not(:disabled):hover{transform:scale(1.05)}
  .send svg{width:18px;height:18px}
  .foot{padding:0 16px 12px;color:var(--fg3);font-size:11.5px;text-align:center}
  .err{margin:0 14px 8px;color:#ff9b9b;font-size:12.5px}
  .hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}
  @media (max-width:520px){.panel{right:0;bottom:0;width:100vw;height:100dvh;border-radius:0}.launch{right:14px;bottom:14px;width:52px;height:52px;padding:0;justify-content:center}.launch .lt{display:none}.launch .orb{width:36px;height:36px}textarea{font-size:16px}.teaser{right:14px;bottom:76px}}
  @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
  `;

  const host = document.createElement('div');
  host.id = 'onehuman-chat';
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${CSS}</style><div class="root"></div>`;
  const ui = root.querySelector('.root');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  /** plain text → safe HTML: links become links, **bold** stays bold, nothing else is markup */
  const render = (text) => esc(text)
    .replace(/\*\*([^*\n]{1,120})\*\*/g, '<b>$1</b>')
    .replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u.replace(/^https?:\/\//, '')}</a>`);

  let open = false, busy = false, unread = 0, pollT = 0, status = 'ai', who = null, lastId = state.last || 0, booted = false;
  const shown = new Set();

  const launcher = document.createElement('button');
  launcher.className = 'launch';
  launcher.setAttribute('aria-label', t.ask);
  launcher.innerHTML = `<span class="orb">${LOGO}</span><span class="lt">${esc(t.ask)}</span>`;
  ui.appendChild(launcher);

  const panel = document.createElement('section');
  panel.className = 'panel';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'OneHuman chat');
  panel.innerHTML = `
    <div class="head"><span class="orb">${LOGO}</span><div class="who"><b>OneHuman</b><span class="st"><i class="dot"></i><span class="stt">${esc(t.status)}</span></span></div>
      <a class="icon" href="${CALL}" target="_blank" rel="noopener" title="${esc(t.call)}" aria-label="${esc(t.call)}">${I.cal}</a>
      <button class="icon x" title="${esc(t.close)}" aria-label="${esc(t.close)}">${I.close}</button></div>
    <div class="log" aria-live="polite"></div>
    <div class="chips"></div>
    <p class="err" hidden></p>
    <form class="compose"><input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
      <textarea rows="1" placeholder="${esc(t.placeholder)}" aria-label="${esc(t.placeholder)}" maxlength="1500"></textarea>
      <button class="send" type="submit" aria-label="${esc(t.send)}" disabled>${I.send}</button></form>
    <div class="foot">${esc(t.foot)}</div>`;
  ui.appendChild(panel);
  const $ = (s) => panel.querySelector(s);
  const log = $('.log'), input = $('textarea'), sendBtn = $('.send'), chips = $('.chips'), err = $('.err');

  const scroll = () => { log.scrollTop = log.scrollHeight; follow = true; };
  let follow = true;   // false once the visitor scrolls up to read; back on when they return to the bottom or send
  const nearBottom = () => follow || log.scrollHeight - log.scrollTop - log.clientHeight < 120;
  /** the language a message is written in, for the widget's own few words (the assistant follows the visitor anyway) */
  const langOf = (s) => (/[əƏ]/.test(s) ? 'az' : /[а-яё]/i.test(s) ? 'ru' : /[ğşıİĞŞ]/.test(s) ? 'tr' : null);
  const words = (s) => T[langOf(s || '')] || t;
  function cta(L = t) {
    const a = document.createElement('a');
    a.className = 'cta'; a.href = CALL; a.target = '_blank'; a.rel = 'noopener';
    a.innerHTML = `<span class="ci">${I.cal}</span><span><b>${esc(L.call)}</b><span>${esc(L.callSub)}</span></span>`;
    return a;
  }
  /** a message's bubbles: the assistant's and a founder's split at blank lines, like two quick messages in a row */
  function fill(row, m, text, typing = false) {
    const parts = m.role === 'visitor' ? [text] : (text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean));
    if (!parts.length) parts.push('');
    const name = m.role === 'admin' ? `<span class="name">${esc(m.author || 'OneHuman')}</span>` : '';
    row.querySelector('.col').innerHTML = parts.map((p, i) => `<div class="bub">${i === 0 ? name : ''}<span class="tx${typing && i === parts.length - 1 ? ' caret' : ''}">${render(p)}</span></div>`).join('');
  }
  /** one message on screen (once per id) */
  function add(m) {
    if (m.id && shown.has(m.id)) return null;
    if (m.id) shown.add(m.id);
    const stick = nearBottom();
    if (m.role === 'system') {
      const p = document.createElement('p'); p.className = 'sys'; p.textContent = m.text; log.appendChild(p);
    } else {
      const row = document.createElement('div');
      row.className = `row ${m.role === 'visitor' ? 'me' : m.role === 'admin' ? 'adm' : ''}`;
      const av = m.role === 'visitor' ? '' : m.role === 'admin' ? `<span class="av p">${esc((m.author || 'O')[0])}</span>` : `<span class="av">${LOGO}</span>`;
      row.innerHTML = `${av}<div class="col"></div>`;
      fill(row, m, m.text || '');
      log.appendChild(row);
      if (m.role !== 'visitor' && /cal\.com\/onehumanai/.test(m.text || '')) log.appendChild(cta(words(m.text)));
    }
    if (stick || m.role === 'visitor') scroll();
    return log.lastElementChild;
  }
  function setStatus(s, name) {
    status = s;
    if (name) who = name;
    $('.stt').textContent = s === 'human' ? `${who || 'OneHuman'} ${t.human}` : t.status;
  }
  function setChips(on) {
    chips.innerHTML = on ? t.chips.map((c) => `<button class="chip" type="button">${esc(c)}</button>`).join('') : '';
    chips.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => send(b.textContent)));
  }
  const setBadge = (n) => {
    unread = n;
    let b = launcher.querySelector('.badge');
    if (!n) { b && b.remove(); return; }
    if (!b) { b = document.createElement('span'); b.className = 'badge'; launcher.querySelector('.orb').appendChild(b); }
    b.textContent = String(n);
  };

  async function history() {
    if (booted) return;
    booted = true;
    if (!state.chat) { add({ role: 'ai', text: t.hi }); setChips(true); return; }
    try {
      const r = await fetch(`/api/v1/chat/poll?chat=${encodeURIComponent(state.chat)}&token=${encodeURIComponent(state.token)}&after=0`, { cache: 'no-store' });
      if (r.status === 404) { state = {}; save(state); add({ role: 'ai', text: t.hi }); setChips(true); return; }
      const d = await r.json();
      add({ role: 'ai', text: t.hi });
      for (const m of d.messages) { add(m); lastId = Math.max(lastId, m.id); }
      const lastAdmin = [...d.messages].reverse().find((m) => m.role === 'admin');
      setStatus(d.status, lastAdmin && lastAdmin.author);
      setChips(!d.messages.length);
      state.last = lastId; save(state);
    } catch { add({ role: 'ai', text: t.hi }); setChips(true); }
  }

  /** a founder's replies: often while the panel is open, now and then while it is closed */
  async function poll() {
    clearTimeout(pollT);
    if (state.chat && !busy && !document.hidden) {
      try {
        const r = await fetch(`/api/v1/chat/poll?chat=${encodeURIComponent(state.chat)}&token=${encodeURIComponent(state.token)}&after=${lastId}`, { cache: 'no-store' });
        if (r.ok) {
          const d = await r.json();
          for (const m of d.messages) {
            lastId = Math.max(lastId, m.id);
            if (m.role === 'visitor') { shown.add(m.id); continue; }
            if (open) add(m); else if (m.role !== 'system') { setBadge(unread + 1); shown.delete(m.id); }
            if (m.role === 'admin') setStatus('human', m.author);
          }
          if (d.status !== status) setStatus(d.status);
          state.last = lastId; save(state);
        }
      } catch { /* offline for a moment */ }
    }
    if (state.chat) pollT = setTimeout(poll, open ? (status === 'human' ? 2500 : 5000) : 20000);
  }

  /** send, then show the answer as it arrives, after a short "thinking" so it never feels abrupt */
  async function send(text) {
    text = String(text || '').trim();
    if (!text || busy) return;
    busy = true; err.hidden = true; setChips(false);
    input.value = ''; autosize(); sendBtn.disabled = true;
    const mine = add({ role: 'visitor', text });
    const L = words(text);
    const think = document.createElement('div');
    think.className = 'think'; think.innerHTML = `<i class="o"></i><span>${esc(L.thinking)}…</span>`;
    const started = Date.now();
    let row = null, queue = '', streamed = '', done = false, finalMsg = null, waiting = false, lastT = 0;
    const showThink = setTimeout(() => { log.appendChild(think); scroll(); }, 120);
    // reveal the text smoothly, a few characters a frame, once the thinking pause is over (at least ~1.8 s)
    const reveal = () => {
      if (Date.now() - started < 1800) return requestAnimationFrame(reveal);
      if (queue && !row) {
        clearTimeout(showThink); think.remove();
        row = add({ role: 'ai', text: '' });
      }
      if (queue && row) {
        // by time, not by frame: ~110 characters a second, faster when a lot is waiting, the same in a throttled tab
        const now = Date.now(), n = Math.max(2, Math.ceil(((now - (lastT || now - 16)) / 1000) * 110), Math.ceil(queue.length / 12));
        lastT = now;
        streamed += queue.slice(0, n); queue = queue.slice(n);
        fill(row, { role: 'ai' }, streamed, true);
        if (nearBottom()) scroll();
      }
      if (queue || !done) return requestAnimationFrame(reveal);
      if (row) fill(row, { role: 'ai' }, finalMsg ? finalMsg.text : streamed);
      if (finalMsg) { shown.add(finalMsg.id); lastId = Math.max(lastId, finalMsg.id); if (/cal\.com\/onehumanai/.test(finalMsg.text)) { log.appendChild(cta(words(finalMsg.text))); scroll(); } }
      state.last = lastId; save(state);
      busy = false; sendBtn.disabled = !input.value.trim();
      poll();
    };
    try {
      const r = await fetch('/api/v1/chat/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat: state.chat || null, token: state.token || null, text, page: location.pathname, website: $('.hp').value }),
      });
      if (!r.ok || !r.body) { const d = await r.json().catch(() => ({})); throw new Error(d.message || t.error); }
      requestAnimationFrame(reveal);
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const ln = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!ln.trim()) continue;
          const ev = JSON.parse(ln);
          if (ev.type === 'chat') { state = { chat: ev.id, token: ev.token, last: 0 }; save(state); }
          else if (ev.type === 'ack') { shown.add(ev.message.id); lastId = Math.max(lastId, ev.message.id); }
          else if (ev.type === 'delta') queue += ev.text;
          else if (ev.type === 'done') finalMsg = ev.message;
          else if (ev.type === 'waiting') { waiting = true; setStatus('human'); }
        }
      }
      done = true;
      if (waiting && !queue && !row) { clearTimeout(showThink); think.remove(); }
    } catch (e) {
      done = true; clearTimeout(showThink); think.remove();
      if (mine) mine.style.opacity = '.55';
      err.textContent = e.message || t.error; err.hidden = false;
      busy = false; sendBtn.disabled = !input.value.trim();
    }
  }

  log.addEventListener('wheel', (e) => { if (e.deltaY < 0) follow = false; }, { passive: true });
  log.addEventListener('touchmove', () => { follow = false; }, { passive: true });
  log.addEventListener('scroll', () => { if (log.scrollHeight - log.scrollTop - log.clientHeight < 40) follow = true; }, { passive: true });
  function autosize() { input.style.height = 'auto'; input.style.height = `${Math.min(120, input.scrollHeight)}px`; }
  input.addEventListener('input', () => { autosize(); sendBtn.disabled = busy || !input.value.trim(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); } });
  $('.compose').addEventListener('submit', (e) => { e.preventDefault(); send(input.value); });

  let teaser = null;
  function show(on) {
    open = on;
    panel.hidden = !on; launcher.hidden = on;
    if (teaser) { teaser.remove(); teaser = null; }
    if (on) { setBadge(0); history().then(() => { scroll(); poll(); }); setTimeout(() => input.focus(), 60); }
    else poll();
  }
  launcher.addEventListener('click', () => show(true));
  $('.x').addEventListener('click', () => show(false));
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) show(false); });

  // once per browser: a short line after a few seconds, never on a phone mid-scroll
  if (!state.seenTeaser && !state.chat && innerWidth > 520) {
    setTimeout(() => {
      if (open) return;
      teaser = document.createElement('div');
      teaser.className = 'teaser';
      teaser.innerHTML = `${esc(t.teaser)}<button class="x" aria-label="${esc(t.close)}">${I.close}</button>`;
      teaser.addEventListener('click', (e) => { if (e.target.closest('.x')) { teaser.remove(); teaser = null; } else show(true); });
      ui.appendChild(teaser);
      state.seenTeaser = true; save(state);
    }, 7000);
  }
  if (state.chat) poll();
})();
