// SPDX-License-Identifier: BUSL-1.1
/**
 * Local adversarial harness — drives a REAL Chrome through evasion strategies against a running
 * OneHuman app, and reports whether each one is detected and whether a sensitive resource leaks.
 *
 * This is a local red-team and data-collection tool. It is NOT part of the server, is never served,
 * and is never published (scripts/ is excluded from the npm package and the Vercel bundle). Point it
 * only at a target you own; it defaults to the local dev server.
 *
 *   node scripts/redteam.mjs                       # 12 runs of every strategy against http://localhost:8787/bank
 *   node scripts/redteam.mjs --runs 20             # more iterations
 *   node scripts/redteam.mjs --url http://localhost:8787/bank --resource balance.read
 *   node scripts/redteam.mjs --only evasive        # one strategy
 *   node scripts/redteam.mjs --capture             # POST the adversarial trajectories into the sandbox
 *                                                  #   dataset (label=agent, source=cdp-*) to grow the corpus
 *   node scripts/redteam.mjs --headful             # watch it drive (slower, and closer to the real threat)
 *
 * Needs Chrome and puppeteer-core:  npm i -D puppeteer-core
 *
 * Why these strategies: a determined operator does not use `page.click()`. They patch navigator.webdriver,
 * drive the mouse with CDP `Input.dispatchMouseEvent` (which can forge `force`/pressure), draw a curved,
 * decelerating path, and locate elements through the CDP box model so the page's own read traps never fire.
 * The point of this harness is to keep measuring how close that gets, honestly, over time.
 */
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name, def = false) => { const i = args.indexOf(`--${name}`); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : def; };
const TARGET = String(flag('url', 'http://localhost:8787/bank'));
const RESOURCE = String(flag('resource', 'balance.read'));
const RUNS = Number(flag('runs', 12));
const ONLY = flag('only', null);
const CAPTURE = !!flag('capture', false);
const HEADFUL = !!flag('headful', false);

if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/)/.test(TARGET) && !flag('force-remote', false)) {
  console.error(`Refusing to point the harness at a non-local target (${TARGET}). Pass --force-remote if you own it.`);
  process.exit(1);
}

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((p) => { try { return existsSync(p); } catch { return false; } });
if (!CHROME) { console.error('No Chrome found. Set CHROME_PATH=/path/to/Chrome.'); process.exit(1); }

let puppeteer;
try { puppeteer = (await import('puppeteer-core')).default; }
catch { console.error('puppeteer-core is not installed.\n  npm i -D puppeteer-core'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);

/** A curved, decelerating, trembling path — what a stealth bot draws instead of teleporting to the target. */
function humanPath(x0, y0, x1, y1, n, noise) {
  const cx = x0 + (x1 - x0) * 0.4 - (y1 - y0) * rnd(0.1, 0.25);
  const cy = y0 + (y1 - y0) * 0.4 + (x1 - x0) * rnd(0.1, 0.25);
  const p = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n, e = 1 - Math.pow(1 - u, 3), b = 1 - e; // ease-out: slows onto the target
    let x = b * b * x0 + 2 * b * e * cx + e * e * x1;
    let y = b * b * y0 + 2 * b * e * cy + e * e * y1;
    const tr = noise(e);
    x += (Math.random() - 0.5) * tr; y += (Math.random() - 0.5) * tr;
    p.push([x, y]);
  }
  return p;
}
const NOISE = {
  taper: (e) => (1 - e) * 1.4 + 0.3,   // tremor that fades onto the target
  flat: () => 1.0,                     // constant additive noise
  none: () => 0,                       // a clean generated curve
};

async function newPage(browser, stealth) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  if (stealth) await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }); });
  // record the pointermoves the page sees, so a captured trajectory can be added to the training corpus
  await page.evaluateOnNewDocument(() => { window.__cap = []; addEventListener('pointermove', (e) => { window.__cap.push([Math.round(performance.now() * 10) / 10, e.clientX, e.clientY, e.pressure]); }, { capture: true, passive: true }); });
  await page.goto(TARGET, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.OneHuman && document.querySelector('button[data-res]'), { timeout: 12000 });
  return page;
}

async function readVerdict(page, resource) {
  await sleep(500);
  return page.evaluate(async (res) => {
    try { await window.OneHuman.flush(); } catch {}
    const r = await window.OneHuman.fetch(`/api/v1/r/${res}`, { method: 'GET' });
    const d = await r.json().catch(() => ({}));
    return { status: r.status, leaked: r.status === 200 && !d.masked, masked: !!d.masked,
             actor: window.OneHuman?.lastAssessment?.actor ?? null, conn: window.OneHuman?.lastConnection?.state ?? null,
             reasons: (window.OneHuman?.lastAssessment?.reasons ?? []).map((x) => x.code) };
  }, resource);
}

async function centre(page, res) {
  const el = await page.$(`button[data-res="${res}"]`);
  if (!el) return null;
  const box = await el.boundingBox();   // CDP box model — not the page's getBoundingClientRect
  return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
}

// A CDP click along `path` with a forged press force and a humanized hold.
async function cdpClick(client, path, { force = 0.5, hold = 100 } = {}) {
  for (const [x, y] of path) { await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, force }); await sleep(rnd(6, 16)); }
  const [px, py] = path[path.length - 1];
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', buttons: 1, clickCount: 1, force });
  await sleep(hold);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', buttons: 0, clickCount: 1, force });
}

const STRATEGIES = {
  // the control: unstealthed automation. Should be caught cold.
  naive: async (browser) => {
    const page = await newPage(browser, false);
    await page.click(`button[data-res="${RESOURCE}"]`);
    return { page };
  },
  // webdriver patched, mouse still teleports with pressure 0. Kinematics should still catch it.
  teleport: async (browser) => {
    const page = await newPage(browser, true);
    const c = await centre(page, RESOURCE); const client = await page.target().createCDPSession();
    await cdpClick(client, [[c.x, c.y]], { force: 0, hold: 2 });
    return { page };
  },
  // the one that matters: stealth + forged force + curved decelerating path + protocol-level reads.
  evasive: async (browser) => {
    const page = await newPage(browser, true);
    const c = await centre(page, RESOURCE); const client = await page.target().createCDPSession();
    const path = humanPath(c.x - rnd(200, 320), c.y + rnd(110, 200), c.x, c.y, 40 + Math.floor(Math.random() * 14), NOISE.taper);
    await cdpClick(client, path, { force: 0.5, hold: rnd(80, 150) });
    return { page };
  },
  // same, but reads the page with an evaluated script first (like a general LLM agent). Should trip the read traps.
  reader: async (browser) => {
    const page = await newPage(browser, true);
    await page.evaluate(() => { const t = document.body.innerText; let s = 0; for (const el of document.querySelectorAll('*')) s += el.getBoundingClientRect().width; return [t.length, s]; });
    const c = await centre(page, RESOURCE); const client = await page.target().createCDPSession();
    await cdpClick(client, humanPath(c.x - 240, c.y + 150, c.x, c.y, 44, NOISE.taper), { force: 0.5, hold: 100 });
    return { page };
  },
};

async function captureSample(page, source) {
  const cap = await page.evaluate(() => window.__cap);
  if (!cap || cap.length < 10) return;
  const clickT = cap[cap.length - 1][0];
  const traj = cap.map(([t, x, y]) => [Math.round((t - clickT) * 10) / 10, Math.round(x), Math.round(y)]);
  const at = [traj[traj.length - 1][1], traj[traj.length - 1][2]];
  const click = { trusted: true, pointer: 'mouse', detail: 1, holdMs: 100, moves: traj.length, path: 0, travelMs: 0, pressure: 0.5, hidden: false, traj, downMs: -5, target: { w: 150, h: 44, dx: 0, dy: 0 }, coalesced: 1, at };
  const origin = new URL(TARGET).origin;
  await page.evaluate(async (o, c, src) => {
    await fetch(`${o}/api/v1/sandbox/samples`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ client: `redteam-${src}`, label: 'agent', source: src, task: 'redteam', click: c }) }).catch(() => {});
  }, origin, click, source);
}

const chosen = ONLY ? { [ONLY]: STRATEGIES[ONLY] } : STRATEGIES;
if (ONLY && !STRATEGIES[ONLY]) { console.error(`Unknown strategy "${ONLY}". Options: ${Object.keys(STRATEGIES).join(', ')}`); process.exit(1); }

const browser = await puppeteer.launch({ executablePath: CHROME, headless: HEADFUL ? false : 'shell', args: ['--no-first-run', '--window-size=1280,900', '--disable-blink-features=AutomationControlled'] });
console.log(`target ${TARGET}  resource ${RESOURCE}  runs ${RUNS}  ${HEADFUL ? 'headful' : 'headless'}${CAPTURE ? '  capturing→sandbox' : ''}\n`);
try {
  for (const [name, run] of Object.entries(chosen)) {
    let leaked = 0, caught = 0; const seen = {};
    for (let k = 0; k < RUNS; k++) {
      const { page } = await run(browser);
      const v = await readVerdict(page, RESOURCE);
      if (v.leaked) leaked++;
      if (v.actor === 'agent_likely') caught++;
      seen[v.actor] = (seen[v.actor] ?? 0) + 1;
      if (CAPTURE && name !== 'naive') await captureSample(page, `cdp-${name}`);
      await page.close();
    }
    const pad = name.padEnd(9);
    console.log(`${pad}  leaked ${RESOURCE}: ${leaked}/${RUNS}   detected as agent: ${caught}/${RUNS}   actors: ${JSON.stringify(seen)}`);
  }
} finally { await browser.close(); }
console.log('\nA high "leaked" with low "detected as agent" is an evasion worth a look — see the research log (internal/docs/HESABAT.md §22).');
