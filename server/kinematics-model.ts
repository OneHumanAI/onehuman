// SPDX-License-Identifier: BUSL-1.1
/**
 * Learned per-click model: L2-regularised logistic regression over standardised kinematic features.
 * Weights are trained offline by scripts/kinematics-train.mjs (session-grouped cross-validation, threshold
 * chosen for zero human false positives with margin) and shipped as kinematics-model.json. The rule-based
 * judge stays as a guardrail; the model adds evidence only where it is confident.
 */
import type { Features } from './kinematics.ts';

export type TreeNode = { f: number; t: number; l: TreeNode; r: TreeNode } | { v: number };

export type Model = {
  version: string;
  trainedAt: string;
  features: string[];
  /** 'lr' (default) or 'gbdt' */
  type?: 'lr' | 'gbdt';
  mean: number[];
  std: number[];
  weights: number[];
  bias: number;
  /** gbdt: additive trees on the raw (unstandardised) vector; bias is the initial log-odds */
  trees?: TreeNode[];
  shrinkage?: number;
  /** feature names forced to 0 before prediction (e.g. dispatch-timing features a bot controls) */
  zeroFeatures?: string[];
  importance?: Record<string, number>;
  /** probabilities above → human evidence; below → synthetic evidence */
  humanAbove: number;
  syntheticBelow: number;
  report?: unknown;
};

/** Feature vector: nulls become 0 with an indicator, so "no trajectory" is itself informative. */
export const MODEL_FEATURES = ['n', 'durationMs', 'pathLen', 'straightness', 'perpRms', 'dirChanges', 'peakPos', 'velCv', 'subMovements', 'dtMean', 'dtCv', 'dtZeroFrac', 'tremor', 'endSlow', 'pauseBeforeDownMs', 'holdMs', 'pressure', 'centreOffset', 'jumpPx', 'maxSegment', 'residualRms', 'smoothVelCv', 'roughness', 'noiseSpeedCorr', 'd2Ac1', 'residKurtosis', 'roughEndRatio', 'hasTraj', 'hasHold', 'hasPressure', 'logHold', 'logN'] as const;

export function vectorize(f: Features): number[] {
  const v = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? 0 : x);
  const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
  // heavy-tailed quantities enter as log1p so a few huge values do not swamp the standardisation
  const lg = (x: number) => Math.log1p(x);
  return [
    clamp(f.n, 0, 240), lg(clamp(f.durationMs, 0, 60000)), lg(clamp(f.pathLen, 0, 5000)), v(f.straightness), lg(clamp(v(f.perpRms), 0, 500)), clamp(f.dirChanges, 0, 100),
    v(f.peakPos), clamp(v(f.velCv), 0, 10), clamp(f.subMovements, 0, 60), lg(clamp(v(f.dtMean), 0, 1000)), clamp(v(f.dtCv), 0, 10), v(f.dtZeroFrac), lg(clamp(v(f.tremor), 0, 100)), clamp(v(f.endSlow), 0, 5),
    lg(clamp(v(f.pauseBeforeDownMs), 0, 60000)), lg(clamp(v(f.holdMs), 0, 3000)), v(f.pressure), clamp(v(f.centreOffset), 0, 3), lg(clamp(v(f.jumpPx), 0, 3000)), lg(clamp(v(f.maxSegment), 0, 3000)), lg(clamp(v(f.residualRms), 0, 50)), clamp(v(f.smoothVelCv), 0, 10), lg(clamp(v(f.roughness), 0, 100)), clamp(v(f.noiseSpeedCorr), -1, 1), clamp(v(f.d2Ac1), -1, 1), lg(clamp(v(f.residKurtosis), 0, 200)), lg(clamp(v(f.roughEndRatio), 0, 50)),
    f.n >= 2 ? 1 : 0, f.holdMs === null ? 0 : 1, f.pressure === null ? 0 : 1, Math.log1p(clamp(v(f.holdMs), 0, 3000)), Math.log1p(clamp(f.n, 0, 240)),
  ];
}

function leaf(node: TreeNode, x: number[]): number {
  let n = node;
  while (!('v' in n)) n = x[n.f]! <= n.t ? n.l : n.r;
  return n.v;
}

export function predict(model: Model, f: Features): number {
  const x = vectorize(f);
  if (model.zeroFeatures) for (const name of model.zeroFeatures) { const i = model.features.indexOf(name); if (i >= 0) x[i] = 0; }
  let z = model.bias;
  if (model.type === 'gbdt' && model.trees) {
    const k = model.shrinkage ?? 1;
    for (const t of model.trees) z += k * leaf(t, x);
  } else {
    for (let i = 0; i < x.length; i++) z += model.weights[i]! * ((x[i]! - model.mean[i]!) / (model.std[i]! || 1));
  }
  return 1 / (1 + Math.exp(-z));
}

let loaded: Model | null | undefined;
/** The shipped model, or null when none has been trained yet. */
export async function loadModel(): Promise<Model | null> {
  if (loaded !== undefined) return loaded;
  try {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    for (const p of [join(here, 'kinematics-model.json'), join(here, '..', 'server', 'kinematics-model.json'), join(process.env.ONEHUMAN_ROOT ?? process.cwd(), 'server', 'kinematics-model.json')]) {
      try { loaded = JSON.parse(await readFile(p, 'utf8')) as Model; return loaded; } catch { /* next */ }
    }
  } catch { /* ignore */ }
  loaded = null;
  return loaded;
}
export function setModel(m: Model | null) { loaded = m; }
