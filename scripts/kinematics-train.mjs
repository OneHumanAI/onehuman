// SPDX-License-Identifier: BUSL-1.1
/**
 * Train the per-click model on the labelled sample store.
 *   node scripts/kinematics-train.mjs            # train + grouped CV report, write server/kinematics-model.json
 *   node scripts/kinematics-train.mjs --dry      # report only
 * Method: logistic regression (L2) on standardised features from server/kinematics-model.ts; 5-fold cross-
 * validation grouped by client (a person's/agent's clicks never appear in both train and test); thresholds
 * picked on out-of-fold probabilities: humanAbove = highest agent probability + margin, syntheticBelow =
 * lowest human probability − margin (clamped), so at the chosen cut-offs the CV false-positive count is 0.
 * Sources tagged synthetic (ghost-cursor) are reported separately.
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
if (!process.env.ONEHUMAN_DB && existsSync('.env.local')) for (const line of readFileSync('.env.local', 'utf8').split('\n')) { const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const { clientFromEnv } = await import('../server/sql.ts');
const { SiteStore: Store } = await import('../server/site-db.ts');
const { clickFeatures } = await import('../server/kinematics.ts');
const { vectorize, MODEL_FEATURES } = await import('../server/kinematics-model.ts');

const dry = process.argv.includes('--dry');
// --no-timing: zero out inter-sample timing features (dtMean, dtCv, dtZeroFrac) — a bot controls its own dispatch
// cadence, so a model that leans on timing is fragile; this experiment measures what remains without it
const noTiming = !process.argv.includes('--timing'); // timing-free is the default since 2026-09-22
const TIMING_IDX = ['dtMean', 'dtCv', 'dtZeroFrac'].map((n) => MODEL_FEATURES.indexOf(n));
const store = await Store.open((await clientFromEnv()).client);
// "cyborg" clicks — an agent pressing where a watching person's hand had just moved the mouse — carry a human
// trajectory and an agent press; they are label noise for a trajectory model and are held out of training
// (still reported below). Session-level layers handle them (markers, hidden-document clicks, dominance rule).
const all = (await store.listSamples(null, 50000)).filter((r) => r.click && r.click.pointer === 'mouse' && r.click.trusted !== false && (r.label === 'human' || r.label === 'agent'));
const rows = all.filter((r) => !/cyborg/.test(r.source));
const cyborg = all.filter((r) => /cyborg/.test(r.source));
const data = rows.map((r) => { const c = r.click; const f = clickFeatures(c.traj ?? [], { holdMs: c.holdMs, pressure: c.pressure, pointer: c.pointer, target: c.target ?? null, downMs: c.downMs ?? null, coalesced: c.coalesced ?? 0, at: c.at ?? null }); const x = vectorize(f); if (noTiming) for (const i of TIMING_IDX) x[i] = 0; return { x, y: r.label === 'human' ? 1 : 0, client: r.client, source: r.source, id: r.id }; });
console.log(`samples: ${data.length} (human ${data.filter((d) => d.y).length}, agent ${data.filter((d) => !d.y).length}), clients ${new Set(data.map((d) => d.client)).size}`);

function standardize(train) { const k = train[0].x.length; const mean = Array(k).fill(0), std = Array(k).fill(0); for (const d of train) d.x.forEach((v, i) => (mean[i] += v)); mean.forEach((m, i) => (mean[i] = m / train.length)); for (const d of train) d.x.forEach((v, i) => (std[i] += (v - mean[i]) ** 2)); std.forEach((s, i) => (std[i] = Math.sqrt(s / train.length) || 1)); return { mean, std }; }
function fit(train, { epochs = 400, lr = 0.05, l2 = 0.02 } = {}) {
  const { mean, std } = standardize(train); const k = mean.length; const w = Array(k).fill(0); let b = 0;
  const X = train.map((d) => d.x.map((v, i) => (v - mean[i]) / std[i]));
  // class balance: weight the minority class up so the boundary is not dragged by the human majority
  const nh = train.filter((d) => d.y).length, na = train.length - nh; const wh = train.length / (2 * nh), wa = train.length / (2 * na);
  for (let e = 0; e < epochs; e++) {
    const g = Array(k).fill(0); let gb = 0;
    for (let j = 0; j < X.length; j++) { const z = X[j].reduce((s, v, i) => s + v * w[i], b); const p = 1 / (1 + Math.exp(-z)); const err = (p - train[j].y) * (train[j].y ? wh : wa); for (let i = 0; i < k; i++) g[i] += err * X[j][i]; gb += err; }
    for (let i = 0; i < k; i++) w[i] -= lr * (g[i] / X.length + l2 * w[i]); b -= lr * (gb / X.length);
  }
  return { mean, std, weights: w, bias: b };
}
const probLr = (m, x) => 1 / (1 + Math.exp(-(x.reduce((s, v, i) => s + ((v - m.mean[i]) / m.std[i]) * m.weights[i], m.bias))));

// ---- gradient-boosted trees (Newton steps on weighted log-loss, depth-limited exact splits) ----
let gainByFeature = {};
let seedState = 12345; const rand = () => { seedState = (seedState * 1664525 + 1013904223) >>> 0; return seedState / 4294967296; };
function buildTree(X, g, h, idx, depth, minLeaf) {
  const leafValue = () => { let sg = 0, sh = 0; for (const i of idx) { sg += g[i]; sh += h[i]; } return { v: sg / (sh + 1.0) }; };
  if (depth === 0 || idx.length < 2 * minLeaf) return leafValue();
  const k = X[0].length; let best = null; let sg = 0, sh = 0; for (const i of idx) { sg += g[i]; sh += h[i]; }
  const parentGain = (sg * sg) / (sh + 1.0);
  for (let f = 0; f < k; f++) {
    const sorted = idx.slice().sort((a, b) => X[a][f] - X[b][f]);
    let lg = 0, lh = 0;
    for (let j = 0; j < sorted.length - 1; j++) {
      const i = sorted[j]; lg += g[i]; lh += h[i];
      if (j + 1 < minLeaf || sorted.length - (j + 1) < minLeaf) continue;
      if (X[sorted[j + 1]][f] === X[i][f]) continue;
      const rg = sg - lg, rh = sh - lh;
      const gain = (lg * lg) / (lh + 1.0) + (rg * rg) / (rh + 1.0) - parentGain;
      if (!best || gain > best.gain) best = { gain, f, t: (X[i][f] + X[sorted[j + 1]][f]) / 2 };
    }
  }
  if (!best || best.gain <= 1e-6) return leafValue();
  gainByFeature[best.f] = (gainByFeature[best.f] ?? 0) + best.gain;
  const L = idx.filter((i) => X[i][best.f] <= best.t), R = idx.filter((i) => X[i][best.f] > best.t);
  return { f: best.f, t: best.t, l: buildTree(X, g, h, L, depth - 1, minLeaf), r: buildTree(X, g, h, R, depth - 1, minLeaf) };
}
const walk = (node, x) => { let n = node; while (!('v' in n)) n = x[n.f] <= n.t ? n.l : n.r; return n.v; };
// defaults from the grouped-CV grid (2026-09-22): shallow trees generalise best across people/devices
function fitGbdt(train, { rounds = 300, depth = 2, shrinkage = 0.1, minLeaf = 8, subsample = 0.8 } = {}) {
  const X = train.map((d) => d.x), y = train.map((d) => d.y);
  const nh = y.filter((v) => v).length, na = y.length - nh; const w = y.map((v) => (v ? y.length / (2 * nh) : y.length / (2 * na)));
  const p0 = nh / y.length; const bias = Math.log(p0 / (1 - p0)); const F = new Array(y.length).fill(bias); const trees = [];
  seedState = 12345;
  for (let m = 0; m < rounds; m++) {
    const p = F.map((z) => 1 / (1 + Math.exp(-z)));
    const g = y.map((v, i) => w[i] * (v - p[i])), h = p.map((pi, i) => w[i] * pi * (1 - pi));
    const idx = []; for (let i = 0; i < y.length; i++) if (rand() < subsample) idx.push(i);
    const tree = buildTree(X, g, h, idx, depth, minLeaf); trees.push(tree);
    for (let i = 0; i < y.length; i++) F[i] += shrinkage * walk(tree, X[i]);
  }
  return { type: 'gbdt', bias, trees, shrinkage, mean: [], std: [], weights: [] };
}
const probGbdt = (m, x) => { let z = m.bias; for (const t of m.trees) z += m.shrinkage * walk(t, x); return 1 / (1 + Math.exp(-z)); };
const prob = (m, x) => (m.type === 'gbdt' ? probGbdt(m, x) : probLr(m, x));
const fitBoth = (train) => ({ lr: fit(train), gbdt: fitGbdt(train) });

// grouped 5-fold CV by client
const clients = [...new Set(data.map((d) => d.client))]; const seed = 7; const shuffled = clients.map((c, i) => [c, Math.sin(i * 12.9898 + seed) * 43758.5453 % 1]).sort((a, b) => a[1] - b[1]).map(([c]) => c);
const folds = Array.from({ length: 5 }, (_, i) => new Set(shuffled.filter((_, j) => j % 5 === i)));
// --tune: grid over boosting hyper-parameters, grouped CV, pick by AUC then zero-FP coverage
if (process.argv.includes('--tune')) {
  const grid = [];
  for (const rounds of [80, 160, 300]) for (const depth of [2, 3, 4]) for (const minLeaf of [4, 8, 16]) grid.push({ rounds, depth, minLeaf });
  const results = [];
  for (const g of grid) {
    const oofT = new Map();
    for (const f of folds) { const train = data.filter((d) => !f.has(d.client)); const test = data.filter((d) => f.has(d.client)); if (!train.length || !test.length) continue; const m = fitGbdt(train, g); for (const d of test) oofT.set(d.id, probGbdt(m, d.x)); }
    const sc = data.filter((d) => oofT.has(d.id)).map((d) => ({ y: d.y, p: oofT.get(d.id) }));
    const pos = sc.filter((d) => d.y).map((d) => d.p), neg = sc.filter((d) => !d.y).map((d) => d.p); let s = 0; for (const a of pos) for (const b of neg) s += a > b ? 1 : a === b ? 0.5 : 0; const aucT = s / (pos.length * neg.length);
    const hA = Math.min(0.995, Math.max(...neg) + 0.01), sB = Math.max(0.002, Math.min(...pos) - 0.01);
    const covH = pos.filter((p) => p >= hA).length / pos.length, covA = neg.filter((p) => p <= sB).length / neg.length;
    results.push({ ...g, auc: aucT, covH, covA });
    console.log(`rounds ${String(g.rounds).padStart(3)} depth ${g.depth} minLeaf ${String(g.minLeaf).padStart(2)}  AUC ${aucT.toFixed(4)}  zero-FP coverage human ${(100 * covH).toFixed(1)}% agent ${(100 * covA).toFixed(1)}%`);
  }
  results.sort((a, b) => b.auc - a.auc || (b.covH + b.covA) - (a.covH + a.covA));
  console.log('\nbest:', JSON.stringify(results[0]));
  store.close(); process.exit(0);
}

const oofLr = new Map(), oofGb = new Map();
for (const f of folds) { const train = data.filter((d) => !f.has(d.client)); const test = data.filter((d) => f.has(d.client)); if (!train.length || !test.length) continue; const { lr, gbdt } = fitBoth(train); for (const d of test) { oofLr.set(d.id, prob(lr, d.x)); oofGb.set(d.id, prob(gbdt, d.x)); } }
const aucOf = (oofMap) => { const sc = data.filter((d) => oofMap.has(d.id)); const pos = sc.filter((d) => d.y).map((d) => oofMap.get(d.id)), neg = sc.filter((d) => !d.y).map((d) => oofMap.get(d.id)); let s = 0; for (const a of pos) for (const b of neg) s += a > b ? 1 : a === b ? 0.5 : 0; return s / (pos.length * neg.length); };
const aucLr = aucOf(oofLr), aucGb = aucOf(oofGb);
const useGb = aucGb >= aucLr;
console.log(`\nmodel comparison (grouped CV): logistic AUC ${aucLr.toFixed(4)}  ·  boosted trees AUC ${aucGb.toFixed(4)}  → using ${useGb ? 'boosted trees' : 'logistic regression'}`);
const oof = useGb ? oofGb : oofLr; const fitChosen = (train) => (useGb ? fitGbdt(train) : fit(train));
const scored = data.filter((d) => oof.has(d.id)).map((d) => ({ ...d, p: oof.get(d.id) }));
const auc = useGb ? aucGb : aucLr;
const humanP = scored.filter((d) => d.y).map((d) => d.p).sort((a, b) => a - b), agentP = scored.filter((d) => !d.y).map((d) => d.p).sort((a, b) => a - b);
const q = (arr, t) => arr[Math.min(arr.length - 1, Math.floor(t * arr.length))];
console.log(`\ngrouped-CV AUC ${auc.toFixed(4)}   human p: min ${humanP[0]?.toFixed(3)} p5 ${q(humanP, .05)?.toFixed(3)} median ${q(humanP, .5)?.toFixed(3)}   agent p: max ${agentP.at(-1)?.toFixed(3)} p95 ${q(agentP, .95)?.toFixed(3)} median ${q(agentP, .5)?.toFixed(3)}`);
// zero false positives on out-of-fold probabilities, with a margin: above the highest agent p, below the lowest human p
const humanAbove = Math.min(0.995, Math.max(0.6, (agentP.at(-1) ?? 0) + 0.01));
const syntheticBelow = Math.max(0.002, Math.min(0.4, (humanP[0] ?? 1) - 0.01));
const fpHuman = scored.filter((d) => d.y && d.p < syntheticBelow).length, fnAgent = scored.filter((d) => !d.y && d.p > humanAbove).length;
const coverH = scored.filter((d) => d.y && d.p >= humanAbove).length, coverA = scored.filter((d) => !d.y && d.p <= syntheticBelow).length;
console.log(`thresholds: humanAbove ${humanAbove.toFixed(3)} syntheticBelow ${syntheticBelow.toFixed(3)} → CV: humans flagged synthetic ${fpHuman}/${humanP.length}, agents flagged human ${fnAgent}/${agentP.length}; coverage human ${coverH}/${humanP.length}, agent ${coverA}/${agentP.length}`);
console.log('\nper source (median p, min, max, n):');
for (const src of [...new Set(scored.map((d) => `${d.y ? 'human' : 'agent'}|${d.source}`))].sort()) { const ps = scored.filter((d) => `${d.y ? 'human' : 'agent'}|${d.source}` === src).map((d) => d.p).sort((a, b) => a - b); console.log(`  ${src.padEnd(44)} ${q(ps, .5).toFixed(3)}  ${ps[0].toFixed(3)}–${ps.at(-1).toFixed(3)}  (${ps.length})`); }
const worst = scored.filter((d) => (d.y && d.p < 0.5) || (!d.y && d.p > 0.5)).sort((a, b) => (a.y ? a.p : 1 - a.p) - (b.y ? b.p : 1 - b.p)).slice(0, 12);
if (worst.length) { console.log('\nmisranked (label, source, p):'); for (const d of worst) console.log(`  #${d.id} ${d.y ? 'human' : 'agent'}/${d.source} p=${d.p.toFixed(3)}`); }

// adversary generalisation: hold out each synthetic flavour entirely (trained on humans, real agents, other flavours)
for (const flavour of ['naive', 'slow', 'spread', 'noisy1', 'noisy2', 'noisy3']) {
  const isF = (d) => d.source === `ghost-cursor-synthetic-${flavour}`;
  const test = data.filter(isF); if (!test.length) continue;
  const m = fitChosen(data.filter((d) => !isF(d)));
  const ps = test.map((d) => prob(m, d.x)).sort((a, b) => a - b);
  console.log(`unseen adversary ${flavour.padEnd(6)}: p median ${q(ps, .5).toFixed(3)} max ${ps.at(-1).toFixed(3)} → flagged synthetic ${ps.filter((x) => x <= syntheticBelow).length}/${ps.length}, passed as human ${ps.filter((x) => x >= humanAbove).length}/${ps.length}`);
}

if (cyborg.length) { const m = fitChosen(data); const ps = cyborg.map((r) => { const c = r.click; const f = clickFeatures(c.traj ?? [], { holdMs: c.holdMs, pressure: c.pressure, pointer: c.pointer, target: c.target ?? null, downMs: c.downMs ?? null, coalesced: c.coalesced ?? 0, at: c.at ?? null }); return prob(m, vectorize(f)); }).sort((a, b) => a - b); console.log(`cyborg clicks (agent press on a hand's path, held out): ${cyborg.length}, p median ${q(ps, .5).toFixed(3)}, would pass as human ${ps.filter((x) => x >= humanAbove).length}, flagged synthetic ${ps.filter((x) => x <= syntheticBelow).length} — session layers decide these`); }

// product KPI: with rules + model, how often is the very first click already decisive (unlock for people, catch for agents)?
{
  const { judgeClick: judge, attachModel } = await import('../server/kinematics.ts');
  const { predict } = await import('../server/kinematics-model.ts');
  const m = fitChosen(data); const tmp = { ...m, features: [...MODEL_FEATURES], humanAbove, syntheticBelow, zeroFeatures: noTiming ? ['dtMean', 'dtCv', 'dtZeroFrac'] : [] };
  attachModel({ predict: (f) => predict(tmp, f), humanAbove, syntheticBelow });
  const feats = rows.map((r) => { const c = r.click; return { y: r.label === 'human' ? 1 : 0, source: r.source, j: judge(clickFeatures(c.traj ?? [], { holdMs: c.holdMs, pressure: c.pressure, pointer: c.pointer, target: c.target ?? null, downMs: c.downMs ?? null, coalesced: c.coalesced ?? 0, at: c.at ?? null })) }; });
  const hu = feats.filter((d) => d.y), ag = feats.filter((d) => !d.y);
  const unlock = hu.filter((d) => d.j.verdict === 'human' && ((d.j.humanPts >= 8 && d.j.agentPts <= 1) || (d.j.flags.includes('model_human') && d.j.humanPts >= 7 && d.j.agentPts <= 3))).length, humanSyn = hu.filter((d) => d.j.verdict === 'synthetic').length;
  const caught = ag.filter((d) => d.j.verdict === 'synthetic').length, agentHum = ag.filter((d) => d.j.verdict === 'human').length;
  console.log(`\nKPI (rules + model, in-sample): human clicks unlocking at first click ${unlock}/${hu.length} (${(100 * unlock / hu.length).toFixed(1)}%), humans judged synthetic ${humanSyn}; agent clicks caught ${caught}/${ag.length} (${(100 * caught / ag.length).toFixed(1)}%), agents judged human ${agentHum}`);
  for (const src of [...new Set(feats.map((d) => d.source))].sort()) { const g = feats.filter((d) => d.source === src); const v = { human: 0, synthetic: 0, uncertain: 0 }; for (const d of g) v[d.j.verdict]++; console.log(`  ${src.padEnd(38)} human ${String(v.human).padStart(3)}  synthetic ${String(v.synthetic).padStart(3)}  uncertain ${String(v.uncertain).padStart(3)}`); }
  attachModel(null);
}

// final model on everything
gainByFeature = {};
const full = fitChosen(data);
if (useGb) { const tot = Object.values(gainByFeature).reduce((a, b) => a + b, 0); const imp = Object.entries(gainByFeature).map(([f, g]) => [MODEL_FEATURES[f], g / tot]).sort((a, b) => b[1] - a[1]); console.log('\nfeature importance (share of split gain):', imp.slice(0, 12).map(([n, g]) => `${n} ${(100 * g).toFixed(1)}%`).join(', ')); full.importance = Object.fromEntries(imp.map(([n, g]) => [n, Math.round(g * 1000) / 1000])); }
if (!useGb) { const top = full.weights.map((w, i) => [MODEL_FEATURES[i], w]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 8); console.log('\nstrongest weights (standardised; + → human):', top.map(([n, w]) => `${n} ${w >= 0 ? '+' : ''}${w.toFixed(2)}`).join(', ')); }
if (!dry) {
  const model = { version: `${useGb ? 'gbdt' : 'lr'}-${new Date().toISOString().slice(0, 10)}`, trainedAt: new Date().toISOString(), type: useGb ? 'gbdt' : 'lr', features: [...MODEL_FEATURES], mean: full.mean ?? [], std: full.std ?? [], weights: full.weights ?? [], bias: full.bias, trees: full.trees, shrinkage: full.shrinkage, humanAbove, syntheticBelow, importance: full.importance, zeroFeatures: noTiming ? ['dtMean', 'dtCv', 'dtZeroFrac'] : [], report: { samples: data.length, clients: clients.length, auc, aucLr, aucGb, humanAbove, syntheticBelow, cvHumanFlagged: fpHuman, cvAgentFlagged: fnAgent } };
  writeFileSync('server/kinematics-model.json', JSON.stringify(model, null, 1) + '\n');
  console.log('\nwrote server/kinematics-model.json');
}
store.close();
