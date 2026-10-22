// SPDX-License-Identifier: BUSL-1.1
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clickFeatures, judgeClick, type TrajPoint } from '../server/kinematics.ts';
import { assess } from '../server/assess.ts';
import { EMPTY_READING, EMPTY_SURFACE, type EarlySignal, type InteractionSample } from '../server/signals.ts';

/** Minimum-jerk style human movement: bell velocity, tremor, irregular sampling, decelerating onto the target. */
function humanTraj(seed = 1): TrajPoint[] {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const pts: TrajPoint[] = [];
  const dur = 420; let t = -dur - 60;
  const from = { x: 120, y: 400 }, to = { x: 640, y: 180 };
  for (let tau = 0; tau <= 1.0001; ) {
    const e = 10 * tau ** 3 - 15 * tau ** 4 + 6 * tau ** 5; // minimum-jerk position
    const x = from.x + (to.x - from.x) * e + Math.sin(tau * Math.PI) * 18 + (rnd() - 0.5) * 1.6;
    const y = from.y + (to.y - from.y) * e + (rnd() - 0.5) * 1.6;
    pts.push([Math.round(t * 10) / 10, Math.round(x), Math.round(y)]);
    const dt = 6 + rnd() * 12; t += dt; tau += dt / dur;
  }
  // small correction sub-movement and a dwell before the press
  for (let i = 0; i < 4; i++) { t += 8 + rnd() * 8; pts.push([Math.round(t * 10) / 10, Math.round(to.x + 2 - i * 0.5), Math.round(to.y - 1 + i * 0.3)]); }
  return pts;
}
/** Interpolated straight line with constant timing (a `mouse.move(x, y, {steps})` style agent). */
function linearTraj(steps = 10): TrajPoint[] {
  const pts: TrajPoint[] = [];
  for (let i = 0; i <= steps; i++) pts.push([-(steps - i) * 10 - 5, 120 + (520 * i) / steps, 400 - (220 * i) / steps]);
  return pts;
}

test('human-like trajectory is judged human; interpolated straight line is judged synthetic', () => {
  const h = clickFeatures(humanTraj(), { holdMs: 96, pressure: 0.5, pointer: 'mouse', target: { w: 120, h: 44, dx: 14, dy: -6 }, downMs: -96, coalesced: 0, at: null });
  assert.ok(h.n > 20);
  assert.ok(h.straightness! < 0.99, `straightness ${h.straightness}`);
  assert.ok(h.dtCv! > 0.2);
  const jh = judgeClick(h);
  assert.equal(jh.verdict, 'human', JSON.stringify(jh));

  const l = clickFeatures(linearTraj(), { holdMs: 2, pressure: 0, pointer: 'mouse', target: { w: 120, h: 44, dx: 0, dy: 0 }, downMs: -2, coalesced: 0, at: null });
  assert.equal(l.straightness, 1);
  assert.equal(l.dtCv, 0);
  const jl = judgeClick(l);
  assert.equal(jl.verdict, 'synthetic', JSON.stringify(jl));
  assert.ok(jl.flags.includes('straight_line') && jl.flags.includes('uniform_timing'));
});

test('teleport click (no movement, instant release, pressure 0, dead centre) is synthetic; repeat click without movement is not', () => {
  const tele = clickFeatures([], { holdMs: 2, pressure: 0, pointer: 'mouse', target: { w: 100, h: 40, dx: 0, dy: 0 }, downMs: -2, coalesced: 0, at: null });
  const jt = judgeClick(tele);
  assert.equal(jt.verdict, 'synthetic', JSON.stringify(jt));
  const rep = clickFeatures([], { holdMs: 88, pressure: 0.5, pointer: 'mouse', target: { w: 100, h: 40, dx: 9, dy: 4 }, downMs: -88, coalesced: 0, at: null });
  const jr = judgeClick(rep, { repeatTarget: true });
  assert.notEqual(jr.verdict, 'synthetic', JSON.stringify(jr));
});

const early = (): EarlySignal => ({ startedMs: 0, observedMs: 500, webdriver: false, firstInteractionMs: 300, dataDomMs: null, markers: [], environment: { codexModelContext: false, modelContextApi: false, clipboardBridge: false, clipboardBridgeAtMs: null, agentGlobals: [], extensionsInstalled: ['claude-chrome'], focusWhileHiddenMs: null }, focusConflict: { count: 0, firstAtMs: null, peers: 0 }, webmcpInvocations: 0, reading: { ...EMPTY_READING }, surface: { ...EMPTY_SURFACE } });
const withTraj = (traj: TrajPoint[], over: Partial<NonNullable<InteractionSample['click']>>): InteractionSample => ({ atMs: 1000, webdriver: false, keys: 0, keyIntervals: [], inputEvents: 0, paste: false, click: { trusted: true, pointer: 'mouse', detail: 1, holdMs: 96, moves: traj.length, path: 600, travelMs: 480, pressure: 0.5, hidden: false, traj, downMs: -96, target: { w: 120, h: 44, dx: 14, dy: -6 }, coalesced: 0, at: null, ...over } });

test('assess: two kinematically human clicks make the session human_like despite an installed extension', () => {
  const a = assess({ server: null, early: early(), interactions: [withTraj(humanTraj(1), {})], current: withTraj(humanTraj(7), {}) });
  assert.equal(a.actor, 'human_like', JSON.stringify(a.reasons.map((r) => r.code)));
  assert.ok(a.reasons.some((r) => r.code === 'HUMAN_KINEMATICS'));
  assert.ok(!a.tiers.includes('artifact'));
});

test('assess: a single very clear synthetic click already reaches the behavioral tier; two make it stronger', () => {
  const one = assess({ server: null, early: early(), interactions: [], current: withTraj(linearTraj(), { holdMs: 2, pressure: 0, downMs: -2, target: { w: 120, h: 44, dx: 0, dy: 0 } }) });
  assert.ok(one.tiers.includes('behavioral'), JSON.stringify(one.reasons));
  assert.ok(one.reasons.some((r) => r.code === 'SYNTHETIC_KINEMATICS'));
  assert.ok(one.score! >= 65);
  const two = assess({ server: null, early: early(), interactions: [withTraj(linearTraj(8), { holdMs: 1, pressure: 0, downMs: -1, target: { w: 80, h: 80, dx: 0, dy: 0 } })], current: withTraj(linearTraj(), { holdMs: 2, pressure: 0, downMs: -2, target: { w: 120, h: 44, dx: 0, dy: 0 } }) });
  assert.equal(two.actor, 'agent_likely');
  assert.ok(two.score! >= 80);
});

test('a trajectory that ends far from the click is a teleport: judged synthetic even with a human-looking path', () => {
  const traj = humanTraj(3); // ends near (640, 180)
  const f = clickFeatures(traj, { holdMs: 2, pressure: 0.5, pointer: 'mouse', target: { w: 90, h: 90, dx: 0.4, dy: -0.2 }, downMs: -2, coalesced: 0, at: [300, 500] });
  assert.ok(f.jumpPx! > 300);
  const j = judgeClick(f);
  assert.equal(j.verdict, 'synthetic', JSON.stringify(j));
  assert.ok(j.flags.includes('teleport'));
});

test('measured Claude-in-Chrome click (#24: no trajectory, hold 1 ms, pressure 0.5, off-centre) is synthetic', () => {
  const f = clickFeatures([], { holdMs: 1, pressure: 0.5, pointer: 'mouse', target: { w: 60, h: 60, dx: 20, dy: 18 }, downMs: -1, coalesced: 0, at: [400, 300] });
  assert.equal(judgeClick(f).verdict, 'synthetic');
});

test('assess: one unambiguous human click inside an agent-app window is human_like (first-click unlock)', () => {
  const server = { signature: null, secFetch: null, uaMajor: 152, environment: { agentAppToken: 'Claude/2.2553.1', clientHints: false } } as unknown as import('../server/signals.ts').ServerSignal;
  const a = assess({ server, early: early(), interactions: [], current: withTraj(humanTraj(5), {}) });
  assert.equal(a.actor, 'human_like', JSON.stringify(a.reasons.map((r) => r.code)));
  // …but not when the session was attached by an agent earlier
  const b = assess({ server, early: early(), interactions: [], current: withTraj(humanTraj(5), {}), attachedEarlierMs: 4000 });
  assert.equal(b.actor, 'agent_likely');
});

test('repeat clicks on the same button without movement do not undo a first-click human unlock', () => {
  const first = withTraj(humanTraj(2), { at: [105, 386], target: { w: 148, h: 43, dx: -7, dy: 1 } });
  const again = withTraj([], { moves: 0, path: 0, travelMs: 0, holdMs: 118, downMs: -118, at: [105, 386], target: { w: 148, h: 43, dx: -7, dy: 1 } });
  const server = { signature: null, secFetch: null, uaMajor: 152, environment: { agentAppToken: 'Claude/2.2553.1', clientHints: false } } as unknown as import('../server/signals.ts').ServerSignal;
  const a = assess({ server, early: early(), interactions: [first, again, again], current: again });
  assert.equal(a.actor, 'human_like', JSON.stringify(a.reasons.map((r) => r.code)));
});

test('a held press with 0.5 pressure and no movement (reload, mouse already on the button) is not synthetic', () => {
  const f = clickFeatures([], { holdMs: 108, pressure: 0.5, pointer: 'mouse', target: { w: 148, h: 43, dx: 20, dy: 5 }, downMs: -108, coalesced: 0, at: [200, 300] });
  const j = judgeClick(f);
  assert.notEqual(j.verdict, 'synthetic', JSON.stringify(j));
});

test('trackpad tap-to-click on a target the hand travelled to (rested 20 s, five taps) is human, not atomic', () => {
  // approach ended 20 s before the tap; the SDK keeps it regardless of age
  const traj = humanTraj(4).map(([t, x, y]) => [t - 20000, x, y] as TrajPoint);
  const end = traj[traj.length - 1]!;
  const tap = (holdMs: number): InteractionSample => withTraj(traj, { holdMs, pressure: 0.5, downMs: -holdMs, moves: traj.length, at: [end[1], end[2]], target: { w: 160, h: 48, dx: 12, dy: -6 } });
  const f = clickFeatures(traj, { holdMs: 2, pressure: 0.5, pointer: 'mouse', target: { w: 160, h: 48, dx: 12, dy: -6 }, downMs: -2, coalesced: 0, at: [end[1], end[2]] });
  assert.ok(f.pauseBeforeDownMs! >= 19000);
  const j = judgeClick(f);
  assert.equal(j.verdict, 'human', JSON.stringify(j));
  assert.ok(j.flags.includes('aimed_dwell') && j.flags.includes('tap_release'));
  const a = assess({ server: null, early: early(), interactions: [tap(2), tap(3), tap(1), tap(2)], current: tap(2) });
  assert.equal(a.actor, 'human_like', JSON.stringify(a.reasons.map((r) => r.code)));
  assert.ok(!a.reasons.some((r) => r.code === 'ATOMIC_CLICKS'));
});

test('a click with no approach at all and a 2 ms hold is still atomic/synthetic', () => {
  const c = withTraj([], { moves: 0, holdMs: 2, pressure: 0.5, downMs: -2, at: [400, 300], target: { w: 160, h: 48, dx: 0, dy: 0 } });
  const a = assess({ server: null, early: early(), interactions: [c, c], current: c });
  assert.equal(a.actor, 'agent_likely');
  assert.ok(a.reasons.some((r) => r.code === 'ATOMIC_CLICKS' || r.code === 'SYNTHETIC_KINEMATICS'));
});

test('two approach-less taps after a reload do not outweigh four kinematically human clicks (training run A)', () => {
  const traj = humanTraj(6);
  const end = traj[traj.length - 1]!;
  const human = (hold: number) => withTraj(traj, { holdMs: hold, pressure: 0.5, downMs: -hold, at: [end[1], end[2]], target: { w: 120, h: 44, dx: 10, dy: 3 } });
  const tap = withTraj([], { moves: 0, holdMs: 2, pressure: 0.5, downMs: -2, at: [400, 300], target: { w: 160, h: 48, dx: 9, dy: 2 } });
  const a = assess({ server: null, early: early(), interactions: [human(90), tap, tap, human(1), human(8)], current: human(1) });
  assert.equal(a.actor, 'human_like', JSON.stringify(a.reasons.map((r) => r.code)));
  assert.ok(!a.reasons.some((r) => r.code === 'ATOMIC_CLICKS'));
});

/** a generated curve with Gaussian noise on every point: the next-generation "humanised" bot */
function noisyBezier(sigma = 1.5, n = 80): TrajPoint[] {
  let s = 11; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const gauss = () => { const u = Math.max(1e-9, rnd()), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const P = [[80, 520], [300, 100], [500, 640], [720, 220]]; const pts: TrajPoint[] = []; let t = -n * 10 - 90;
  for (let i = 0; i <= n; i++) { const u = i / n, v = 1 - u; const x = v ** 3 * P[0]![0]! + 3 * v * v * u * P[1]![0]! + 3 * v * u * u * P[2]![0]! + u ** 3 * P[3]![0]!; const y = v ** 3 * P[0]![1]! + 3 * v * v * u * P[1]![1]! + 3 * v * u * u * P[2]![1]! + u ** 3 * P[3]![1]!; pts.push([Math.round(t * 10) / 10, Math.round(x + gauss() * sigma), Math.round(y + gauss() * sigma)]); t += 10 * (1 + (rnd() - 0.5) * 0.4); }
  return pts;
}

test('physics features: added white noise is speed-independent, Gaussian and anti-correlated; a hand is not', () => {
  const b = clickFeatures(noisyBezier(1.5), { holdMs: 90, pressure: 0.5, pointer: 'mouse', target: { w: 120, h: 44, dx: 9, dy: 3 }, downMs: -90, coalesced: 0, at: [720, 220] });
  assert.ok(Math.abs(b.noiseSpeedCorr!) < 0.15, `noise-speed corr ${b.noiseSpeedCorr}`);
  assert.ok(b.residKurtosis! < 4.5, `kurtosis ${b.residKurtosis}`);
  assert.ok(b.d2Ac1! < -0.55, `d2 autocorrelation ${b.d2Ac1}`);
  const j = judgeClick(b);
  assert.equal(j.verdict, 'synthetic', JSON.stringify(j));
  assert.ok(j.flags.includes('white_noise_path'));
  const h = clickFeatures(humanTraj(9), { holdMs: 96, pressure: 0.5, pointer: 'mouse', target: { w: 120, h: 44, dx: 14, dy: -6 }, downMs: -96, coalesced: 0, at: [640, 180] });
  assert.ok(!judgeClick(h).flags.includes('white_noise_path'), JSON.stringify(judgeClick(h)));
});

test('a click without pointerdown (keyboard activation) is neutral, never synthetic', () => {
  const f = clickFeatures([], { holdMs: null, pressure: null, pointer: 'mouse', target: { w: 120, h: 44, dx: 0, dy: 0 }, downMs: null, coalesced: 0, at: [300, 300] });
  const j = judgeClick(f);
  assert.equal(j.verdict, 'uncertain');
  assert.ok(j.flags.includes('keyboard_activation'));
});

test('a session of humanised-bot clicks (noisy generated paths, plausible presses) never becomes human_like', async () => {
  // production always runs with the shipped model attached; rules alone catch ~93 % of these paths
  const { readFileSync } = await import('node:fs');
  const { attachModel } = await import('../server/kinematics.ts');
  const { predict } = await import('../server/kinematics-model.ts');
  type Model = import('../server/kinematics-model.ts').Model;
  const model = JSON.parse(readFileSync(new URL('../server/kinematics-model.json', import.meta.url), 'utf8')) as Model;
  attachModel({ predict: (f) => predict(model, f), humanAbove: model.humanAbove, syntheticBelow: model.syntheticBelow });
  try {
    const click = (i: number) => withTraj(noisyBezier(1.5 + i * 0.3, 60 + i * 5), { holdMs: 80 + i * 7, pressure: 0.5, downMs: -(80 + i * 7), at: [720, 220], target: { w: 120, h: 44, dx: 9 - i, dy: 3 } });
    const a = assess({ server: null, early: early(), interactions: [click(0), click(1), click(2), click(3)], current: click(4) });
    assert.notEqual(a.actor, 'human_like', JSON.stringify(a.reasons.map((r) => r.code)));
    assert.equal(a.actor, 'agent_likely', JSON.stringify(a.reasons.map((r) => r.code)));
  } finally { attachModel(null); }
});
