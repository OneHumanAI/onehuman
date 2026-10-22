// SPDX-License-Identifier: BUSL-1.1
/**
 * Training-environment evaluation: how the real assessment treated every recorded run, per task.
 *   node scripts/training-eval.mjs                # Turso (.env.local)
 *   ONEHUMAN_DB=data/lab.db node scripts/training-eval.mjs
 *   node scripts/training-eval.mjs t-2yl22gmc     # one run (client id prefix), step by step with features
 * Human runs: every step the engine would have called agent_likely is a false positive → listed with reason codes
 * and the click's kinematic features so the rule that misfired can be named. Agent runs: the inverse.
 */
import { readFileSync, existsSync } from 'node:fs';
if (!process.env.ONEHUMAN_DB && existsSync('.env.local')) for (const line of readFileSync('.env.local', 'utf8').split('\n')) { const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const { clientFromEnv } = await import('../server/sql.ts');
const { SiteStore: Store } = await import('../server/site-db.ts');
const { clickFeatures, judgeClick } = await import('../server/kinematics.ts');

const { assess } = await import('../server/assess.ts');
// mirror production: the shipped model is attached to the judge
{ const { attachModel } = await import('../server/kinematics.ts'); const { loadModel, predict } = await import('../server/kinematics-model.ts'); const m = await loadModel(); attachModel(m ? { predict: (f) => predict(m, f), humanAbove: m.humanAbove, syntheticBelow: m.syntheticBelow } : null); if (m) console.log(`model attached: ${m.version}`); }
const store = await Store.open((await clientFromEnv()).client);
const args = process.argv.slice(2);
const recompute = args.includes('--recompute');
const only = args.find((a) => !a.startsWith('--'));
const runs = (await store.listTrainingSessions(1000)).filter((r) => !only || r.client.startsWith(only));
console.log(`training runs: ${runs.length}`);
const samples = await store.listSamples(null, 20000);
const byClientTask = new Map();
for (const s of samples) { const k = `${s.client}|${s.task}`; if (!byClientTask.has(k)) byClientTask.set(k, []); byClientTask.get(k).push(s); }

const perTask = new Map(); // task → {label → {steps, agent, human, unknown, synthetic, humanClick}}
const misses = [];
for (const r of runs) {
  let steps = r.steps;
  if (recompute) {
    // replay this client's raw clicks (samples table, in order) through the current assess()/judge, engine-style window
    const raw = samples.filter((x) => x.client === r.client).sort((a, b) => a.id - b.id);
    const history = []; steps = []; let last = null;
    for (const x of raw) {
      const c = { ...x.click }; delete c.context;
      const sample = { atMs: x.click.context?.atMs ?? 0, webdriver: false, click: c, keys: x.click.context?.keysRecent ?? 0, keyIntervals: x.click.context?.keyIntervals ?? [], inputEvents: x.click.context?.inputEvents ?? 0, paste: false };
      const a = assess({ server: null, early: null, interactions: history.slice(-6), current: sample });
      const f = clickFeatures(c.traj ?? [], { holdMs: c.holdMs, pressure: c.pressure, pointer: c.pointer, target: c.target ?? null, downMs: c.downMs ?? null, coalesced: c.coalesced ?? 0, at: c.at ?? null });
      const rep = !!(last && ((last.target && c.target && last.target.w === c.target.w && last.target.h === c.target.h) || (last.at && c.at && Math.hypot(last.at[0] - c.at[0], last.at[1] - c.at[1]) <= 3)));
      const j = c.pointer === 'mouse' && c.trusted ? judgeClick(f, { repeatTarget: rep }) : null;
      steps.push({ task: x.task, step: steps.length + 1, actor: a.actor, score: a.score, tiers: a.tiers, reasonCodes: a.reasons.filter((q) => q.kind !== 'neutral').map((q) => q.code), click: j ? { verdict: j.verdict, humanPts: j.humanPts, agentPts: j.agentPts, flags: j.flags } : null });
      history.push(sample); last = c;
    }
  }
  console.log(`\n━━ ${r.client}  ${r.label}/${r.source}  ${new Date(r.created).toLocaleString('az-AZ', { hour12: false })}  steps=${steps.length}  agentSteps=${r.summary.agentSteps} humanSteps=${r.summary.humanSteps}  markers=${(r.summary.markers ?? []).join(',') || '-'} globals=${(r.summary.globals ?? []).length} ext=${(r.summary.extensions ?? []).join(',') || '-'}  ${r.ua.slice(0, 60)}`);
  for (const st of steps) {
    const t = perTask.get(st.task) ?? {}; const l = t[r.label] ?? { steps: 0, agent: 0, human: 0, unknown: 0, synthetic: 0, humanClick: 0 };
    l.steps++; l[st.actor === 'agent_likely' ? 'agent' : st.actor === 'human_like' ? 'human' : 'unknown']++;
    if (st.click?.verdict === 'synthetic') l.synthetic++; if (st.click?.verdict === 'human') l.humanClick++;
    t[r.label] = l; perTask.set(st.task, t);
    const wrong = (r.label === 'human' && st.actor === 'agent_likely') || (r.label === 'agent' && st.actor === 'human_like');
    const softWrong = (r.label === 'human' && st.click?.verdict === 'synthetic') || (r.label === 'agent' && st.click?.verdict === 'human');
    if (wrong || softWrong || only) {
      // features from the stored sample for this client/task (nearest by order)
      const pool = byClientTask.get(`${r.client}|${st.task}`) ?? [];
      const idx = steps.filter((x) => x.task === st.task && x.step <= st.step).length - 1;
      const smp = pool.slice().reverse()[idx];
      let feat = '';
      if (smp) { const c = smp.click; const f = clickFeatures(c.traj ?? [], { holdMs: c.holdMs, pressure: c.pressure, pointer: c.pointer, target: c.target ?? null, downMs: c.downMs ?? null, coalesced: c.coalesced ?? 0, at: c.at ?? null }); const ctx = c.context ?? {}; feat = `n=${f.n} hold=${f.holdMs} pr=${f.pressure} straight=${f.straightness} dtCv=${f.dtCv} subs=${f.subMovements} endSlow=${f.endSlow} off=${f.centreOffset} jump=${f.jumpPx} hover=${ctx.hoverMs ?? '-'} sinceLast=${ctx.sinceLastClickMs ?? '-'} ptr=${c.pointer} detail=${c.detail} hidden=${c.hidden} visible=${ctx.visible ?? '-'} focus=${ctx.hasFocus ?? '-'} markers=${(ctx.markers ?? []).join(',') || '-'}`; }
      const line = `  ${wrong ? '✗' : softWrong ? '~' : ' '} #${st.step} ${st.task.padEnd(13)} ${st.actor.padEnd(12)} score=${String(st.score).padStart(3)} click=${st.click ? `${st.click.verdict} ${st.click.humanPts}/${st.click.agentPts} [${st.click.flags.join(',')}]` : '—'} reasons=${st.reasonCodes.join(',')}  ${feat}`;
      console.log(line);
      if (wrong) misses.push({ client: r.client, label: r.label, source: r.source, step: st.step, task: st.task, reasons: st.reasonCodes });
    }
  }
}
console.log('\n== per task (label: steps · engine agent/human/unknown · click synthetic/human) ==');
for (const [task, t] of [...perTask].sort()) {
  const parts = Object.entries(t).map(([label, l]) => `${label}: ${l.steps} · ${l.agent}/${l.human}/${l.unknown} · ${l.synthetic}/${l.humanClick}`);
  console.log(`  ${task.padEnd(14)} ${parts.join('   |   ')}`);
}
console.log(`\n== engine-level misses: ${misses.length} ==`);
const byReason = new Map();
for (const m of misses) for (const c of m.reasons) byReason.set(c, (byReason.get(c) ?? 0) + 1);
for (const [c, n] of [...byReason].sort((a, b) => b[1] - a[1])) console.log(`  ${c.padEnd(28)} ${n}`);
store.close();
