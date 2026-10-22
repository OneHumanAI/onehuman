// SPDX-License-Identifier: BUSL-1.1
/**
 * Pointer kinematics: features of the cursor trajectory that led to a click, and a
 * per-click judgement (human / synthetic / uncertain).
 *
 * Why this exists (2026-09-20): a person was classified as a bot on the live site because of
 * environment traces, while the one thing that actually separates a hand from a program — how
 * the cursor moved — was reduced to "moves ≥ 5". A human trajectory is a bell-shaped
 * velocity profile with tremor, sub-movements, irregular sampling and an off-centre landing;
 * synthetic input is either absent (teleport + click) or a straight line with constant timing
 * that lands on the element centre.
 *
 * Input is untrusted telemetry. Nothing here proves a human; it only says whether the click
 * *looked* like a hand. The trajectory format is the SDK's `click.traj`: points
 * `[tMs, x, y]` with `tMs` relative to the click (≤ 0), oldest first, at most 240 points.
 */

export type TrajPoint = [number, number, number];

export type ClickContext = {
  holdMs: number | null;
  pressure: number | null;
  pointer: string;
  /** click offset from the target element centre, normalised by half width/height */
  target: { w: number; h: number; dx: number; dy: number } | null;
  /** pointerdown time relative to the click (≤ 0) */
  downMs: number | null;
  /** total coalesced pointermove events behind the points (0 = unknown) */
  coalesced: number;
  /** where the click landed (client px); lets the judge see whether the trajectory actually ends there */
  at: [number, number] | null;
};

export type Features = {
  n: number;
  durationMs: number;
  pathLen: number;
  chord: number;
  /** chord / path length; 1 = perfectly straight */
  straightness: number | null;
  perpRms: number | null;
  perpMax: number | null;
  /** heading changes > 30° */
  dirChanges: number;
  /** sum of |Δheading| in degrees */
  turnSum: number;
  peakV: number | null;
  meanV: number | null;
  /** position of the velocity peak along the movement, 0..1 */
  peakPos: number | null;
  velCv: number | null;
  /** velocity minima between accelerations = separate sub-movements */
  subMovements: number;
  dtMean: number | null;
  dtCv: number | null;
  /** fraction of inter-sample intervals equal to 0 ms (batch-dispatched points) */
  dtZeroFrac: number | null;
  /** mean |second difference| of position, px: high-frequency tremor */
  tremor: number | null;
  /** mean speed over the final quarter of points / mean speed (deceleration onto target) */
  endSlow: number | null;
  /** ms between the last move and pointerdown */
  pauseBeforeDownMs: number | null;
  holdMs: number | null;
  pressure: number | null;
  /** distance from element centre in half-sizes; 0 = exact centre */
  centreOffset: number | null;
  targetArea: number | null;
  coalescedPerMove: number | null;
  /** distance from the last trajectory point to the click, px; a hand ends its movement where it clicks */
  jumpPx: number | null;
  /** longest single segment, px: one 8–12 ms sample step of a hand is < 100 px */
  maxSegment: number | null;
  /** RMS deviation of each point from the mean of its 4 neighbours, px: a hand ≥ ~0.8, a Bezier curve ≈ 0 */
  residualRms: number | null;
  /** CV of speed after 3-point smoothing: a hand's speed is irregular even when smoothed */
  smoothVelCv: number | null;
  /** RMS residual of each point from a least-squares parabola over its 5-point window, px: curvature removed, only
   *  roughness remains. Generated curves (ghost-cursor, Bezier) ≤ 0.30 at any density; hands ≥ 0.2 (p1) / 0.26 (p5). */
  roughness: number | null;
  /** Pearson correlation between local speed and |parabola residual|: a hand's tremor grows with speed
   *  (signal-dependent noise, median 0.5–0.7); noise added by a program does not (≈ 0) */
  noiseSpeedCorr: number | null;
  /** lag-1 autocorrelation of raw second differences: white noise gives exactly −2/3; hands −0.45 (Mac), −0.28 (Windows), +0.4 (Safari 30 Hz) */
  d2Ac1: number | null;
  /** kurtosis of |parabola residual|: Gaussian noise ≈ 3, a hand's bursty tremor 12 (median) */
  residKurtosis: number | null;
  /** mean |residual| over the last quarter of points / first quarter: constant noise ≈ 1.0, a hand varies widely */
  roughEndRatio: number | null;
};

export type Judgement = {
  verdict: 'human' | 'synthetic' | 'uncertain';
  humanPts: number;
  agentPts: number;
  flags: string[];
  /** learned model's P(human) for this click, when a model is loaded */
  p?: number;
};

// The learned model (kinematics-model.ts) is attached at start-up; the judge works without it.
let model: { predict: (f: Features) => number; humanAbove: number; syntheticBelow: number } | null = null;
export function attachModel(m: typeof model) { model = m; }

export const KINEMATICS_VERSION = 'kin-v16';

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const std = (a: number[]) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const r3 = (x: number | null) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);

export function clickFeatures(traj: TrajPoint[], ctx: ClickContext): Features {
  const n = traj.length;
  const empty: Features = {
    n, durationMs: 0, pathLen: 0, chord: 0, straightness: null, perpRms: null, perpMax: null, dirChanges: 0, turnSum: 0,
    peakV: null, meanV: null, peakPos: null, velCv: null, subMovements: 0, dtMean: null, dtCv: null, dtZeroFrac: null, tremor: null,
    endSlow: null, pauseBeforeDownMs: null, holdMs: ctx.holdMs, pressure: ctx.pressure, centreOffset: null, targetArea: null, coalescedPerMove: null,
    jumpPx: null, maxSegment: null, residualRms: null, smoothVelCv: null, roughness: null, noiseSpeedCorr: null, d2Ac1: null, residKurtosis: null, roughEndRatio: null,
  };
  if (ctx.target && ctx.target.w > 0 && ctx.target.h > 0) {
    empty.centreOffset = r3(Math.hypot(ctx.target.dx / (ctx.target.w / 2), ctx.target.dy / (ctx.target.h / 2)));
    empty.targetArea = Math.round(ctx.target.w * ctx.target.h);
  }
  if (n >= 1 && ctx.downMs !== null) empty.pauseBeforeDownMs = Math.max(0, Math.round(ctx.downMs - traj[n - 1]![0]));
  if (n >= 1 && ctx.at) empty.jumpPx = Math.round(Math.hypot(ctx.at[0] - traj[n - 1]![1], ctx.at[1] - traj[n - 1]![2]) * 10) / 10;
  if (n < 2) return empty;

  const f = empty;
  f.durationMs = Math.min(60000, Math.round(traj[n - 1]![0] - traj[0]![0]));
  const seg: number[] = [];
  const dts: number[] = [];
  const vel: number[] = [];
  const headings: number[] = [];
  for (let i = 1; i < n; i++) {
    const [t0, x0, y0] = traj[i - 1]!;
    const [t1, x1, y1] = traj[i]!;
    const d = Math.hypot(x1 - x0, y1 - y0);
    // a rest of more than a second between two samples is a pause, not a slow segment: cap it so timing
    // statistics describe the movement itself
    const dt = Math.min(1000, Math.max(0, t1 - t0));
    seg.push(d); dts.push(dt);
    vel.push(d / Math.max(dt, 1));
    if (d > 0.5) headings.push(Math.atan2(y1 - y0, x1 - x0));
  }
  f.pathLen = Math.round(seg.reduce((s, x) => s + x, 0) * 10) / 10;
  // the first segment often spans the pointer's entry into the observed zone: skip it when there is more
  f.maxSegment = Math.round(Math.max(...(seg.length > 3 ? seg.slice(1) : seg)) * 10) / 10;
  const [, ax, ay] = traj[0]!;
  const [, bx, by] = traj[n - 1]!;
  f.chord = Math.round(Math.hypot(bx - ax, by - ay) * 10) / 10;
  f.straightness = f.pathLen > 0 ? r3(Math.min(1, f.chord / f.pathLen)) : null;

  // perpendicular deviation from the chord
  if (f.chord > 1) {
    const ux = (bx - ax) / f.chord, uy = (by - ay) / f.chord;
    const perp = traj.map(([, x, y]) => Math.abs((x - ax) * uy - (y - ay) * ux));
    f.perpRms = r3(Math.sqrt(mean(perp.map((p) => p * p))));
    f.perpMax = r3(Math.max(...perp));
  }
  // heading changes
  let turn = 0, changes = 0;
  for (let i = 1; i < headings.length; i++) {
    let d = Math.abs(headings[i]! - headings[i - 1]!);
    if (d > Math.PI) d = 2 * Math.PI - d;
    const deg = (d * 180) / Math.PI;
    turn += deg;
    if (deg > 30) changes++;
  }
  f.turnSum = Math.round(turn);
  f.dirChanges = changes;
  // velocity profile
  const mv = mean(vel);
  f.meanV = r3(mv);
  let peakI = 0;
  for (let i = 1; i < vel.length; i++) if (vel[i]! > vel[peakI]!) peakI = i;
  f.peakV = r3(vel[peakI]!);
  f.peakPos = r3(vel.length > 1 ? peakI / (vel.length - 1) : 0);
  f.velCv = mv > 0 ? r3(std(vel) / mv) : null;
  // sub-movements: local minima of a lightly smoothed velocity below 60 % of the peak
  const sm = vel.map((_, i) => mean(vel.slice(Math.max(0, i - 1), Math.min(vel.length, i + 2))));
  let subs = 0;
  for (let i = 1; i < sm.length - 1; i++) if (sm[i]! < sm[i - 1]! && sm[i]! <= sm[i + 1]! && sm[i]! < 0.6 * vel[peakI]! && sm[i]! > 0) subs++;
  f.subMovements = subs;
  // sampling regularity
  f.dtMean = r3(mean(dts));
  f.dtCv = f.dtMean && f.dtMean > 0 ? r3(std(dts) / f.dtMean) : null;
  f.dtZeroFrac = r3(dts.filter((d) => d === 0).length / dts.length);
  // tremor: second differences of position
  if (n >= 3) {
    const sd: number[] = [];
    for (let i = 2; i < n; i++) sd.push(Math.hypot(traj[i]![1] - 2 * traj[i - 1]![1] + traj[i - 2]![1], traj[i]![2] - 2 * traj[i - 1]![2] + traj[i - 2]![2]));
    f.tremor = r3(mean(sd));
  }
  // smoothness: distance of each interior point from the average of its two neighbours on each side —
  // a generated curve (Bezier, spline) is locally almost perfectly smooth, a hand never is
  if (n >= 7) {
    const res: number[] = [];
    for (let i = 2; i < n - 2; i++) {
      const mx = (traj[i - 2]![1] + traj[i - 1]![1] + traj[i + 1]![1] + traj[i + 2]![1]) / 4;
      const my = (traj[i - 2]![2] + traj[i - 1]![2] + traj[i + 1]![2] + traj[i + 2]![2]) / 4;
      res.push(Math.hypot(traj[i]![1] - mx, traj[i]![2] - my));
    }
    f.residualRms = r3(Math.sqrt(mean(res.map((x) => x * x))));
    f.smoothVelCv = mean(sm) > 0 ? r3(std(sm) / mean(sm)) : null;
    if (n >= 9) {
      // parabola a + b·k + c·k² over k = −2..2 fitted per axis; with symmetric k only a and c matter for the centre
      const rr: number[] = [];
      for (let i = 2; i < n - 2; i++) {
        for (const ax of [1, 2] as const) {
          const ys = [-2, -1, 0, 1, 2].map((k) => traj[i + k]![ax]);
          const sy = ys.reduce((a, b) => a + b, 0), sx2y = ys.reduce((a, y, j) => a + (j - 2) * (j - 2) * y, 0);
          const det = 5 * 34 - 10 * 10; const a0 = (34 * sy - 10 * sx2y) / det;
          rr.push(ys[2]! - a0);
        }
      }
      f.roughness = r3(Math.sqrt(mean(rr.map((x) => x * x))));
      if (n >= 16) {
        // per-point residual magnitude (x and y residuals belong to the same point: rr is interleaved x,y)
        const mag: number[] = []; for (let i = 0; i + 1 < rr.length; i += 2) mag.push(Math.hypot(rr[i]!, rr[i + 1]!));
        const spd: number[] = []; for (let i = 2; i < n - 2; i++) spd.push(Math.hypot(traj[i + 1]![1] - traj[i - 1]![1], traj[i + 1]![2] - traj[i - 1]![2]) / (Math.min(1000, Math.max(1, traj[i + 1]![0] - traj[i - 1]![0]))));
        const corr = (a: number[], b: number[]) => { const ma = mean(a), mb = mean(b); let num = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { num += (a[i]! - ma) * (b[i]! - mb); da += (a[i]! - ma) ** 2; db += (b[i]! - mb) ** 2; } return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0; };
        f.noiseSpeedCorr = r3(corr(spd, mag));
        const mk = mean(mag), sk = std(mag);
        f.residKurtosis = sk > 0 ? r3(mean(mag.map((v) => ((v - mk) / sk) ** 4))) : null;
        const qn = Math.floor(mag.length / 4);
        f.roughEndRatio = qn >= 3 ? r3((mean(mag.slice(-qn)) + 1e-6) / (mean(mag.slice(0, qn)) + 1e-6)) : null;
        const d2x: number[] = [], d2y: number[] = [];
        for (let i = 2; i < n; i++) { d2x.push(traj[i]![1] - 2 * traj[i - 1]![1] + traj[i - 2]![1]); d2y.push(traj[i]![2] - 2 * traj[i - 1]![2] + traj[i - 2]![2]); }
        const ac1 = (a: number[]) => { const m = mean(a); let num = 0, den = 0; for (let i = 0; i < a.length; i++) { den += (a[i]! - m) ** 2; if (i + 1 < a.length) num += (a[i]! - m) * (a[i + 1]! - m); } return den > 0 ? num / den : 0; };
        f.d2Ac1 = r3((ac1(d2x) + ac1(d2y)) / 2);
      }
    }
  }
  // deceleration onto the target
  const q = Math.max(1, Math.floor(vel.length / 4));
  const tail = vel.slice(-q);
  f.endSlow = mv > 0 ? r3(mean(tail) / mv) : null;
  if (ctx.coalesced > 0) f.coalescedPerMove = r3(ctx.coalesced / (n));
  return f;
}

/**
 * Rule-based judgement (kin-v2). Thresholds come from the sandbox dataset (research log §6):
 * 18 human clicks (mouse, trackpad, Claude pane) vs 22 agent clicks (Claude desktop pane, Claude in
 * Chrome). Human hold 83–158 ms, n ≥ 35 points, dtMean 8–12 ms, ≥ 6 sub-movements, endSlow ≤ 0.37;
 * agent hold 1–4 ms, no trajectory (or 3 sparse points), landing at the element centre.
 * A single click can be judged; the assessment decides how many judgements it needs.
 */
export function judgeClick(f: Features, opts: { repeatTarget?: boolean } = {}): Judgement {
  const flags: string[] = [];
  let human = 0, agent = 0;

  // No pointerdown at all: the click came from the keyboard (Enter/Space on a focused control) or from script.
  // A driver's click always has a pointerdown, so the absence of an approach says nothing here.
  if (f.holdMs === null) { flags.push('keyboard_activation'); return { verdict: 'uncertain', humanPts: 0, agentPts: 0, flags }; }

  // A trajectory that does not end where the click landed belongs to another movement (someone
  // else's mouse, or the cursor parked elsewhere): the click itself arrived by teleport.
  const teleport = f.jumpPx !== null && f.jumpPx > 30;
  if (teleport) { agent += 3; flags.push('teleport'); }

  if (f.n < 2 || teleport) {
    if (f.n < 2 && !opts.repeatTarget) { agent += f.holdMs !== null && f.holdMs <= 5 ? 3 : 1; flags.push('no_trajectory'); }
    // pressing the same button again without moving (reload-and-click, "show" twice) is how people behave
    else if (f.n < 2 && opts.repeatTarget) { human += 1; flags.push('repeat_click'); }
  } else {
    // short hops are naturally straight; only a long, near-perfect line is suspicious (human max 0.986 at p90)
    if (f.straightness !== null && f.n >= 6 && f.pathLen >= 80 && f.straightness >= 0.997) { agent += 2; flags.push('straight_line'); }
    else if (f.straightness !== null && f.straightness <= 0.985 && (f.perpRms ?? 0) > 1.5 && f.n >= 10) { human += 2; flags.push('curved_path'); }
    // human trackpad runs reach dtCv 0.06–0.08 at 120 Hz: only near-zero variance with a straight path is synthetic
    if (f.dtCv !== null && f.n >= 6 && f.dtCv < 0.02 && (f.straightness ?? 0) >= 0.99) { agent += 2; flags.push('uniform_timing'); }
    else if (f.dtCv !== null && f.dtCv > 0.2 && f.n >= 10) { human += 1; flags.push('irregular_timing'); }
    if (f.dtZeroFrac !== null && f.n >= 4 && f.dtZeroFrac >= 0.5) { agent += 2; flags.push('batched_points'); }
    // Safari delivers pointermove at ~30 Hz (dtMean ≈ 29 ms); only far sparser sampling with few points is synthetic
    if (f.dtMean !== null && f.n < 10 && f.dtMean > 60) { agent += 2; flags.push('sparse_sampling'); }
    // (a single very long segment is NOT evidence: a mouse leaving the window and coming back produces one — measured
    // 400–760 px in human runs; maxSegment stays a model feature only)
    if (f.tremor !== null && f.n >= 5) {
      if (f.tremor < 0.05) { agent += 1; flags.push('no_tremor'); }
      else if (f.tremor > 0.3 && f.tremor < 60 && f.n >= 10) { human += 1; flags.push('tremor'); }
    }
    if (f.subMovements >= 2 && f.n >= 10) { human += 1; flags.push('sub_movements'); }
    else if (f.pathLen > 60 && f.n >= 6 && f.subMovements === 0 && (f.dtMean ?? 0) < 20) { agent += 1; flags.push('single_ballistic'); }
    if (f.endSlow !== null && f.n >= 6) {
      if (f.endSlow < 0.7 && f.n >= 10) { human += 1; flags.push('decelerates'); }
      else if (f.endSlow > 1.2) { agent += 1; flags.push('no_deceleration'); }
    }
    if (f.peakPos !== null && f.n >= 6 && (f.peakPos < 0.05 || f.peakPos > 0.95)) { agent += 1; flags.push('flat_profile'); }
    // a generated curve: locally smooth to a fraction of a pixel with no tremor — no hand moves like that
    // (human residual ≥ 0.8 px in every recorded run; ghost-cursor ≤ 0.3)
    // Decisive: a long move (chord ≥ 170 px) whose curvature-free roughness stays under 0.32 px is a generated
    // curve. Measured 2026-09-22: 0 of 426 human clicks (Mac mouse/trackpad/tap, Safari, Windows), 265 of 300
    // ghost-cursor paths. Short smooth moves (< 170 px) exist in human data and are left to the other rules.
    if (f.roughness !== null && f.n >= 12 && f.roughness < 0.32 && f.chord >= 170) { agent += 4; flags.push('generated_curve'); }
    // Generated curve dressed with added noise: the noise is white (lag-1 autocorrelation of second differences at
    // the theoretical −2/3), Gaussian (kurtosis ≈ 3) and speed-independent (correlation ≈ 0). A hand's tremor is
    // none of those. Thresholds set 2026-09-22 against 400 noisy-Bezier paths and 330 human clicks.
    else if (f.n >= 16 && f.chord >= 120 && f.d2Ac1 !== null && f.d2Ac1 < -0.5 && f.residKurtosis !== null && f.residKurtosis < 4.2 && f.noiseSpeedCorr !== null && Math.abs(f.noiseSpeedCorr) < 0.12) { agent += 4; flags.push('white_noise_path'); }
    else if (f.residualRms !== null && f.n >= 12 && f.residualRms < 0.45 && (f.tremor ?? 0) < 1.2) { agent += 3; flags.push('smooth_curve'); }
    if (f.durationMs >= 80 && f.n >= 10) { human += 1; flags.push('travel_time'); }
    // the hand arrived, rested on the target (≥ 300 ms) and then pressed — people aim and wait, programs do not
    if (f.pauseBeforeDownMs !== null && f.pauseBeforeDownMs >= 300 && f.pauseBeforeDownMs <= 60000 && f.n >= 5 && (f.jumpPx === null || f.jumpPx <= 8)) { human += 2; flags.push('aimed_dwell'); }
  }
  // A movement that ends where the click landed (≤ 5 px), has enough samples and is not stale (the SDK keeps
  // the last approach across clicks; after 60 s it says nothing about *this* press) is a hand that arrived there.
  const stale = f.pauseBeforeDownMs !== null && f.pauseBeforeDownMs > 60000;
  if (stale && f.n >= 2) flags.push('stale_approach');
  const arrived = f.n >= 10 && !teleport && !stale && (f.jumpPx === null || f.jumpPx <= 5);
  // An agent clicking exactly on an element's centre with an instant release, even along a hand's earlier path
  // (a person watching moves the mouse, the agent clicks the same spot — "cyborg" sessions, 2026-09-22): people
  // land within 6 % of the centre in < 4 % of clicks and never with a ≤ 5 ms press.
  const handTap = arrived && f.pressure !== null && f.pressure >= 0.4 && f.pressure <= 0.6;
  if (f.centreOffset !== null && f.targetArea !== null && f.targetArea >= 900 && f.centreOffset < 0.06 && f.holdMs !== null && f.holdMs <= 5) {
    // with a fresh hand approach and hardware pressure this can be a person tapping a card's middle: soft evidence only
    agent += handTap ? 1 : 3; flags.push(handTap ? 'centre_tap_soft' : 'centre_tap');
  }
  if (f.holdMs !== null) {
    // Agents release in 1–4 ms, pressed hands in 83–225 ms — but macOS tap-to-click also releases in ~1 ms
    // (measured 2026-09-21). Instant release is therefore only heavy when no movement led to the click.
    // a ≤ 5 ms press without hardware pressure (0 / unknown) is a driver's press, whatever path led to it: no human
    // click in the dataset (426) has hold ≤ 5 with pressure ≠ 0.5 — so along a hand's path it still outweighs the path
    if (f.holdMs <= 5) { agent += handTap ? 0 : arrived ? 4 : 3; flags.push(handTap ? 'tap_release' : 'instant_release'); }
    else if (f.holdMs <= 15) { agent += 1; flags.push('short_hold'); }
    // a held press with the spec's 0.5 button pressure is the pair a hand produces; no agent click in the
    // dataset held longer than 4 ms (Claude in Chrome even reports 0.5 pressure, so pressure alone is weak)
    else if (f.holdMs >= 35 && f.holdMs <= 400) { const hand = f.pressure !== null && f.pressure >= 0.4 && f.pressure <= 0.6; human += hand ? 2 : 1; flags.push(hand ? 'held_press' : 'hold_normal'); }
  }
  if (f.pressure !== null) {
    if (f.pressure === 0) { agent += 1; flags.push('pressure_0'); }
    else if (f.pressure >= 0.4 && f.pressure <= 0.6) { human += 1; flags.push('pressure_0.5'); }
  }
  if (f.centreOffset !== null && f.targetArea !== null && f.targetArea >= 900) {
    if (f.centreOffset < 0.06) { agent += 1; flags.push('dead_centre'); }
    else if (f.centreOffset > 0.15) { human += 1; flags.push('off_centre'); }
  }
  // Learned model: adds evidence only where it is confident (thresholds set for zero CV false positives).
  let p: number | undefined;
  if (model) {
    p = model.predict(f);
    if (p >= model.humanAbove) { human += 2; flags.push('model_human'); }
    // the synthetic threshold is set for zero human false positives in grouped cross-validation, so a confident
    // model verdict weighs as much as a decisive rule: a rich human-looking path cannot outvote it
    else if (p <= model.syntheticBelow) { agent += 4; flags.push('model_synthetic'); }
  }
  const richTrajectory = f.n >= 20 && !teleport;
  let verdict: Judgement['verdict'] = 'uncertain';
  // decisive: a parabola-clean or white-noise path, or a model verdict below the zero-false-positive threshold
  if (flags.includes('generated_curve') || flags.includes('white_noise_path') || flags.includes('model_synthetic')) verdict = 'synthetic';
  // a confident model verdict (threshold = 0 agents above it in grouped CV) on a rich trajectory also tolerates up to
  // 3 soft agent points (short_hold, flat_profile, no_deceleration are common in fast human clicks)
  else if ((human >= 4 && agent <= 1) || (richTrajectory && human >= 6 && agent <= 3) || (richTrajectory && flags.includes('model_human') && human >= 5 && agent <= 3)) verdict = 'human';
  else if ((agent >= 4 && human <= 1) || (agent >= 5 && human <= 2 && !richTrajectory) || (agent >= 7 && human <= 3 && !richTrajectory)) verdict = 'synthetic';
  return p === undefined ? { verdict, humanPts: human, agentPts: agent, flags } : { verdict, humanPts: human, agentPts: agent, flags, p: Math.round(p * 1000) / 1000 };
}
