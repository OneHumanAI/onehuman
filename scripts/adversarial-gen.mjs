// SPDX-License-Identifier: BUSL-1.1
/**
 * Adversarial agent trajectories: what a "humanised" automation library produces.
 * Uses ghost-cursor's Bezier path generator (the library Puppeteer/Playwright bots use to look human),
 * replayed with the timing such tools actually dispatch: near-uniform intervals, a plausible hold, pressure 0.5,
 * a landing point randomised inside the target. Stored as label=agent, source=ghost-cursor-synthetic so the
 * evaluation can report this class separately. Nothing here is a real browser event.
 *   node scripts/adversarial-gen.mjs [count=300]
 */
import { readFileSync, existsSync } from 'node:fs';
if (!process.env.ONEHUMAN_DB && existsSync('.env.local')) for (const line of readFileSync('.env.local', 'utf8').split('\n')) { const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const { path } = await import('ghost-cursor');
const { clientFromEnv } = await import('../server/sql.ts');
const { SiteStore: Store } = await import('../server/site-db.ts');
const { clickFeatures, judgeClick } = await import('../server/kinematics.ts');

const count = Number(process.argv[2] ?? 300);
const store = await Store.open((await clientFromEnv()).client);
const rnd = (a, b) => a + Math.random() * (b - a);
let n = 0;
const stamp = Date.now().toString(36);
const FLAVOURS = ['naive', 'slow', 'spread', 'noisy1', 'noisy2', 'noisy3'];
for (let i = 0; i < count; i++) {
  const from = { x: rnd(40, 1200), y: rnd(60, 760) };
  const tw = rnd(44, 180), th = rnd(30, 80);
  const centre = { x: rnd(120, 1100), y: rnd(120, 700) };
  const to = { x: centre.x + rnd(-tw * 0.3, tw * 0.3), y: centre.y + rnd(-th * 0.3, th * 0.3) };
  // three flavours of adversary: default ghost-cursor, "slow" (moveSpeed), and one with overshoot spread
  const flavour = i % FLAVOURS.length; const name = FLAVOURS[flavour];
  const pts = path(from, to, flavour === 1 ? { moveSpeed: rnd(0.5, 2) } : flavour === 2 ? { spreadOverride: rnd(10, 40) } : flavour >= 3 ? { moveSpeed: rnd(0.6, 1.8) } : undefined);
  // dispatch timing: libraries step at a fixed cadence (Puppeteer mouse.move steps) with little jitter; the
  // "noisy" flavours are a next-generation adversary: Gaussian jitter on every point (σ 0.5 / 1.5 / 3 px) + 20 % timing jitter
  const dt = rnd(6, 18); const jitter = flavour >= 2 ? 0.2 : 0.05; const sigma = flavour === 3 ? 0.5 : flavour === 4 ? 1.5 : flavour === 5 ? 3 : 0;
  const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  let t = 0; const traj = [];
  for (const q of pts) { traj.push([t, Math.round(q.x + gauss() * sigma), Math.round(q.y + gauss() * sigma)]); t += dt * (1 + rnd(-jitter, jitter)); }
  const hold = flavour === 0 ? rnd(1, 4) : rnd(60, 130); // naive vs "humanised" hold
  const end = traj[traj.length - 1];
  const click = { trusted: true, pointer: 'mouse', detail: 1, holdMs: Math.round(hold), moves: traj.length, path: 0, travelMs: Math.round(t), pressure: 0.5, hidden: false, traj: traj.map(([tt, x, y]) => [Math.round((tt - t - hold) * 10) / 10, x, y]), downMs: -Math.round(hold), target: { w: Math.round(tw), h: Math.round(th), dx: Math.round((to.x - centre.x) * 10) / 10, dy: Math.round((to.y - centre.y) * 10) / 10 }, coalesced: traj.length, at: [end[1], end[2]] };
  const f = clickFeatures(click.traj, { holdMs: click.holdMs, pressure: click.pressure, pointer: 'mouse', target: click.target, downMs: click.downMs, coalesced: click.coalesced, at: click.at });
  const j = judgeClick(f);
  const client = `synthetic-ghost-${name}-${i % 4}-${stamp}`;
  await store.addSample({ client, label: 'agent', source: `ghost-cursor-synthetic-${name}`, task: 'synthetic', ua: 'synthetic:ghost-cursor@1.4.2', click, features: f, verdict: j.verdict });
  n++;
}
console.log(`inserted ${n} adversarial samples (${FLAVOURS.length * 4} pseudo-clients, stamp ${stamp})`);
store.close();
