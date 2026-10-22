// SPDX-License-Identifier: BUSL-1.1
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clickFeatures, judgeClick, attachModel, type TrajPoint } from '../server/kinematics.ts';
import { MODEL_FEATURES, predict, vectorize, type Model } from '../server/kinematics-model.ts';

const model = JSON.parse(readFileSync(new URL('../server/kinematics-model.json', import.meta.url), 'utf8')) as Model;

function humanTraj(): TrajPoint[] {
  let s = 3; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const pts: TrajPoint[] = []; let t = -520;
  for (let tau = 0; tau <= 1.0001;) { const e = 10 * tau ** 3 - 15 * tau ** 4 + 6 * tau ** 5; pts.push([Math.round(t * 10) / 10, Math.round(120 + 520 * e + Math.sin(tau * Math.PI) * 18 + (rnd() - 0.5) * 2), Math.round(400 - 220 * e + (rnd() - 0.5) * 2)]); const dt = 6 + rnd() * 12; t += dt; tau += dt / 440; }
  return pts;
}
/** a smooth cubic Bezier sampled at uniform parameter with near-uniform timing: what a humanised bot dispatches
 *  (ghost-cursor emits 60–120 points for a screen-wide move) */
function bezierTraj(n = 96): TrajPoint[] {
  const P = [[100, 500], [260, 120], [480, 620], [700, 200]]; const pts: TrajPoint[] = [];
  for (let i = 0; i <= n; i++) { const u = i / n, v = 1 - u; const x = v ** 3 * P[0]![0]! + 3 * v * v * u * P[1]![0]! + 3 * v * u * u * P[2]![0]! + u ** 3 * P[3]![0]!; const y = v ** 3 * P[0]![1]! + 3 * v * v * u * P[1]![1]! + 3 * v * u * u * P[2]![1]! + u ** 3 * P[3]![1]!; pts.push([Math.round((-(n - i) * 9 - 90) * 10) / 10, Math.round(x), Math.round(y)]); }
  return pts;
}

test('model file matches the feature vector and separates a hand from a generated curve', () => {
  assert.equal(model.features.length, MODEL_FEATURES.length);
  const dims = vectorize(clickFeatures([], { holdMs: null, pressure: null, pointer: 'mouse', target: null, downMs: null, coalesced: 0, at: null })).length;
  assert.equal(model.features.length, dims);
  if (model.type === 'gbdt') assert.ok(model.trees && model.trees.length > 10, 'boosted model carries trees');
  else assert.equal(model.weights.length, dims);
  const h = clickFeatures(humanTraj(), { holdMs: 96, pressure: 0.5, pointer: 'mouse', target: { w: 120, h: 44, dx: 14, dy: -6 }, downMs: -96, coalesced: 0, at: [640, 180] });
  const b = clickFeatures(bezierTraj(), { holdMs: 90, pressure: 0.5, pointer: 'mouse', target: { w: 120, h: 44, dx: 8, dy: 4 }, downMs: -90, coalesced: 0, at: [700, 200] });
  assert.ok(h.residualRms! > 0.8, `human residual ${h.residualRms}`);
  assert.ok(b.residualRms! < h.residualRms!, `bezier residual ${b.residualRms} vs hand ${h.residualRms}`);
  assert.ok(predict(model, h) > predict(model, b), `p(human)=${predict(model, h)} p(bezier)=${predict(model, b)}`);
});

test('with the model attached the judge flags a generated curve and never calls it human', () => {
  attachModel({ predict: (f) => predict(model, f), humanAbove: model.humanAbove, syntheticBelow: model.syntheticBelow });
  try {
    const b = clickFeatures(bezierTraj(), { holdMs: 90, pressure: 0.5, pointer: 'mouse', target: { w: 120, h: 44, dx: 8, dy: 4 }, downMs: -90, coalesced: 0, at: [700, 200] });
    const j = judgeClick(b);
    assert.notEqual(j.verdict, 'human', JSON.stringify(j));
    assert.ok(j.flags.includes('model_synthetic') || j.flags.includes('generated_curve'), JSON.stringify(j));
    const h = clickFeatures(humanTraj(), { holdMs: 96, pressure: 0.5, pointer: 'mouse', target: { w: 120, h: 44, dx: 14, dy: -6 }, downMs: -96, coalesced: 0, at: [640, 180] });
    assert.equal(judgeClick(h).verdict, 'human');
  } finally { attachModel(null); }
});

// A coarse Bezier (48 points, 90 ms hold, hardware pressure) used to pass the rules as human; the curvature-free
// roughness rule (kin-v11) makes any long generated curve synthetic regardless of how human its press looks.
test('coarse humanised Bezier with a real-looking press is synthetic', () => {
  const b = clickFeatures(bezierTraj(48), { holdMs: 90, pressure: 0.5, pointer: 'mouse', target: { w: 120, h: 44, dx: 8, dy: 4 }, downMs: -90, coalesced: 0, at: [700, 200] });
  assert.equal(judgeClick(b).verdict, 'synthetic', JSON.stringify(judgeClick(b)));
});
