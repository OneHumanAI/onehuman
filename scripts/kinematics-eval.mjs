// SPDX-License-Identifier: BUSL-1.1
/**
 * Evaluate the kinematics judge on the sandbox dataset.
 *   node scripts/kinematics-eval.mjs            # uses TURSO_* or ONEHUMAN_DB from the environment / .env.local
 * Prints a confusion matrix per label and source, feature quantiles per label, and every
 * misjudged sample with its features, so thresholds in server/kinematics.ts can be tuned.
 */
import { readFileSync, existsSync } from 'node:fs';
if (!process.env.ONEHUMAN_DB && existsSync('.env.local')) for (const line of readFileSync('.env.local', 'utf8').split('\n')) { const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const { clientFromEnv } = await import('../server/sql.ts');
const { SiteStore: Store } = await import('../server/site-db.ts');
const { clickFeatures, judgeClick } = await import('../server/kinematics.ts');

const store = await Store.open((await clientFromEnv()).client);
const rows = await store.listSamples(null, 20000);
console.log(`samples: ${rows.length}`);
const q = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const groups = new Map();
const wrong = [];
for (const r of rows) {
  const c = r.click;
  const f = clickFeatures(c.traj ?? [], { holdMs: c.holdMs, pressure: c.pressure, pointer: c.pointer, target: c.target ?? null, downMs: c.downMs ?? null, coalesced: c.coalesced ?? 0, at: c.at ?? null });
  const j = c.pointer === 'mouse' && c.trusted ? judgeClick(f) : { verdict: 'uncertain', flags: ['non-mouse'] };
  const key = `${r.label} | ${r.source}`;
  const g = groups.get(key) ?? { human: 0, synthetic: 0, uncertain: 0, feats: [] };
  g[j.verdict]++; g.feats.push(f); groups.set(key, g);
  if ((r.label === 'human' && j.verdict === 'synthetic') || (r.label === 'agent' && j.verdict === 'human')) wrong.push({ id: r.id, label: r.label, source: r.source, verdict: j.verdict, flags: j.flags, f });
  if ((r.label === 'human' && (j.agentPts >= 2 || j.verdict !== 'human')) || (r.label === 'agent' && (j.humanPts >= 2 || j.verdict !== 'synthetic'))) console.log(`  borderline #${r.id} ${r.label}/${r.source} ${j.humanPts}/${j.agentPts} ${j.verdict} [${j.flags.join(',')}] n=${f.n} hold=${f.holdMs} pr=${f.pressure} off=${f.centreOffset} jump=${f.jumpPx} maxSeg=${f.maxSegment}`);
}
console.log('\n== confusion (rows = label|source, cols = judge) ==');
for (const [k, g] of groups) console.log(k.padEnd(40), `human ${String(g.human).padStart(4)}  synthetic ${String(g.synthetic).padStart(4)}  uncertain ${String(g.uncertain).padStart(4)}`);
const FEATS = ['n', 'durationMs', 'pathLen', 'chord', 'peakV', 'meanV', 'straightness', 'perpRms', 'dirChanges', 'peakPos', 'velCv', 'subMovements', 'dtMean', 'dtCv', 'dtZeroFrac', 'tremor', 'residualRms', 'roughness', 'endSlow', 'pauseBeforeDownMs', 'holdMs', 'pressure', 'centreOffset', 'coalescedPerMove'];
console.log('\n== feature quantiles p10 / p50 / p90 per label ==');
for (const label of ['human', 'agent']) {
  const feats = [...groups].filter(([k]) => k.startsWith(label + ' |')).flatMap(([, g]) => g.feats);
  if (!feats.length) continue;
  console.log(`-- ${label} (${feats.length})`);
  for (const name of FEATS) { const v = feats.map((f) => f[name]).filter((x) => typeof x === 'number'); if (v.length) console.log(`  ${name.padEnd(18)} ${String(q(v, .1)).padStart(9)} ${String(q(v, .5)).padStart(9)} ${String(q(v, .9)).padStart(9)}   (${v.length})`); }
}
console.log('\n== points distribution (humanPts/agentPts → count) per label ==');
for (const label of ['human', 'agent']) { const m = new Map(); for (const r of rows) { if (r.label !== label) continue; const c = r.click; const f = clickFeatures(c.traj ?? [], { holdMs: c.holdMs, pressure: c.pressure, pointer: c.pointer, target: c.target ?? null, downMs: c.downMs ?? null, coalesced: c.coalesced ?? 0, at: c.at ?? null }); const j = judgeClick(f); const k = `${j.humanPts}/${j.agentPts}`; m.set(k, (m.get(k) ?? 0) + 1); } console.log(`  ${label}: ${[...m].sort().map(([k, v]) => `${k}→${v}`).join('  ')}`); }
const realWrong = wrong.filter((w) => !/synthetic/.test(w.source)), synthWrong = wrong.filter((w) => /synthetic/.test(w.source));
console.log(`\n== misjudged: ${wrong.length} (real browsers ${realWrong.length}, generated adversarial trajectories ${synthWrong.length}) ==`);
for (const w of [...realWrong, ...synthWrong].slice(0, 40)) console.log(`#${w.id} ${w.label}/${w.source} → ${w.verdict} [${w.flags.join(',')}] n=${w.f.n} straight=${w.f.straightness} dtCv=${w.f.dtCv} dt0=${w.f.dtZeroFrac} tremor=${w.f.tremor} subs=${w.f.subMovements} endSlow=${w.f.endSlow} hold=${w.f.holdMs} pr=${w.f.pressure} off=${w.f.centreOffset} dur=${w.f.durationMs}`);
store.close();
