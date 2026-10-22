// SPDX-License-Identifier: BUSL-1.1
/**
 * One-command evaluation report → internal/docs/EVAL.md (not in the repository: it names the model's features)
 *   node scripts/eval-report.mjs
 * Dataset composition, shipped-model CV metrics, click-level KPIs per source (rules + model, as in production),
 * session-level results for every recorded training run (engine replay), adversary coverage. Numbers only —
 * this file is regenerated, never hand-edited.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
if (!process.env.ONEHUMAN_DB && existsSync('.env.local')) for (const line of readFileSync('.env.local', 'utf8').split('\n')) { const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const { clientFromEnv } = await import('../server/sql.ts');
const { SiteStore: Store } = await import('../server/site-db.ts');
const { clickFeatures, judgeClick, attachModel, KINEMATICS_VERSION } = await import('../server/kinematics.ts');
const { loadModel, predict } = await import('../server/kinematics-model.ts');
const { assess, SIGNAL_VERSION, judgeClicks } = await import('../server/assess.ts');

const store = await Store.open((await clientFromEnv()).client);
const model = await loadModel();
attachModel(model ? { predict: (f) => predict(model, f), humanAbove: model.humanAbove, syntheticBelow: model.syntheticBelow } : null);
const samples = (await store.listSamples(null, 50000)).filter((r) => r.click && (r.label === 'human' || r.label === 'agent'));
const runs = await store.listTrainingSessions(1000);
const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : '–');
const feat = (c) => clickFeatures(c.traj ?? [], { holdMs: c.holdMs, pressure: c.pressure, pointer: c.pointer, target: c.target ?? null, downMs: c.downMs ?? null, coalesced: c.coalesced ?? 0, at: c.at ?? null });

const out = [];
out.push(`# OneHuman — qiymətləndirmə hesabatı (avtomatik)`, ``, `Yaradılma: ${new Date().toISOString()} · assess ${SIGNAL_VERSION} · kinematics ${KINEMATICS_VERSION} · model ${model?.version ?? 'yox'}`, ``);
out.push(`## 1. Dataset`, ``, `| Etiket | Mənbə | Klik | Müştəri id |`, `| --- | --- | ---: | ---: |`);
const groups = new Map();
for (const s of samples) { const k = `${s.label}|${s.source}`; const g = groups.get(k) ?? { n: 0, clients: new Set() }; g.n++; g.clients.add(s.client); groups.set(k, g); }
for (const [k, g] of [...groups].sort()) { const [label, source] = k.split('|'); out.push(`| ${label} | ${source} | ${g.n} | ${g.clients.size} |`); }
out.push(`| **cəmi** | | **${samples.length}** | **${new Set(samples.map((s) => s.client)).size}** |`, ``);

if (model?.report) { const r = model.report; out.push(`## 2. Model (qruplaşdırılmış 5-qat CV, müştəri üzrə)`, ``, `- Tip: ${model.type ?? 'lr'}; xüsusiyyətlər: ${model.features.length}${model.zeroFeatures?.length ? `; sıfırlanan (vaxt): ${model.zeroFeatures.join(', ')}` : ''}`, `- AUC: **${r.auc.toFixed(4)}** (logistik ${r.aucLr?.toFixed(4) ?? '–'}, ağaclar ${r.aucGb?.toFixed(4) ?? '–'})`, `- Hədlər: insan ≥ ${model.humanAbove.toFixed(3)}, sintetik ≤ ${model.syntheticBelow.toFixed(3)} → CV-də insan yalan-müsbəti ${r.cvHumanFlagged}, agent yalan-mənfisi ${r.cvAgentFlagged}`, `- Öyrənmə dataseti: ${r.samples} klik / ${r.clients} müştəri`, ``); if (model.importance) out.push(`Ən vacib xüsusiyyətlər: ${Object.entries(model.importance).slice(0, 8).map(([k, v]) => `${k} ${(100 * v).toFixed(1)}%`).join(', ')}`, ``); }

out.push(`## 3. Klik səviyyəsi (qaydalar + model, istehsal konfiqurasiyası)`, ``, `| Mənbə | Klik | insan | sintetik | qeyri-müəyyən | ilk klikdə açılma |`, `| --- | ---: | ---: | ---: | ---: | ---: |`);
const perSrc = new Map(); let totH = { n: 0, human: 0, synthetic: 0, unlock: 0 }, totA = { n: 0, human: 0, synthetic: 0 };
for (const s of samples) { const c = s.click; if (c.pointer !== 'mouse') continue; const j = judgeClick(feat(c)); const k = `${s.label}|${s.source}`; const g = perSrc.get(k) ?? { n: 0, human: 0, synthetic: 0, uncertain: 0, unlock: 0 }; g.n++; g[j.verdict]++; if (j.verdict === 'human' && ((j.humanPts >= 8 && j.agentPts <= 1) || (j.flags.includes('model_human') && j.humanPts >= 7 && j.agentPts <= 3))) g.unlock++; perSrc.set(k, g); const t = s.label === 'human' ? totH : totA; t.n++; if (j.verdict === 'human') t.human++; if (j.verdict === 'synthetic') t.synthetic++; if (s.label === 'human' && j.verdict === 'human' && ((j.humanPts >= 8 && j.agentPts <= 1) || (j.flags.includes('model_human') && j.humanPts >= 7 && j.agentPts <= 3))) totH.unlock++; }
for (const [k, g] of [...perSrc].sort()) { const [label, source] = k.split('|'); out.push(`| ${label} / ${source} | ${g.n} | ${g.human} | ${g.synthetic} | ${g.uncertain} | ${label === 'human' ? pct(g.unlock, g.n) : '–'} |`); }
out.push(``, `- İnsan klikləri: ${totH.n}; **sintetik sayılan: ${totH.synthetic}** (${pct(totH.synthetic, totH.n)}); ilk klikdə açılan: ${pct(totH.unlock, totH.n)}`, `- Agent klikləri (real + generasiya): ${totA.n}; **insan sayılan: ${totA.human}** (${pct(totA.human, totA.n)}); sintetik: ${pct(totA.synthetic, totA.n)}`, ``);

out.push(`## 4. Sessiya səviyyəsi — təlim dövrələri (mühərrik təkrarı, son 6 klik pəncərəsi)`, ``, `| Kod | Etiket | Mənbə | Addım | agent | insan | bilinmir | Səhv |`, `| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |`);
let sessMiss = 0, sessN = 0;
for (const r of [...runs].reverse()) {
  if (/probe/.test(r.client)) continue;
  const raw = samples.filter((x) => x.client === r.client).sort((a, b) => a.id - b.id);
  if (!raw.length) continue;
  const history = []; let agent = 0, human = 0, unknown = 0, miss = 0;
  for (const x of raw) { const c = { ...x.click }; delete c.context; const sample = { atMs: 0, webdriver: false, click: c, keys: 0, keyIntervals: [], inputEvents: 0, paste: false }; const a = assess({ server: null, early: null, interactions: history.slice(-6), current: sample }); if (a.actor === 'agent_likely') agent++; else if (a.actor === 'human_like') human++; else unknown++; if ((r.label === 'human' && a.actor === 'agent_likely') || (r.label === 'agent' && a.actor === 'human_like')) miss++; history.push(sample); }
  const stale = /yushey5a/.test(r.client); // recorded before approach retention; cannot be replayed faithfully
  if (!stale) { sessMiss += miss; sessN++; }
  out.push(`| ${r.client.slice(0, 10)} | ${r.label} | ${r.source} | ${raw.length} | ${agent} | ${human} | ${unknown} | ${stale ? `${miss} (köhnə SDK, sayılmır)` : miss} |`);
}
out.push(``, `Sayılan dövrələr: ${sessN}, mühərrik səhvi: **${sessMiss}**.`, ``);
out.push(`## 5. Düşmən sinifləri (generasiya)`, ``, `| Variant | n | sintetik | insan |`, `| --- | ---: | ---: | ---: |`);
for (const [k, g] of [...perSrc].filter(([k]) => /ghost/.test(k)).sort()) out.push(`| ${k.split('|')[1]} | ${g.n} | ${g.synthetic} | ${g.human} |`);
out.push(``, `Qeyd: generasiya olunmuş trayektoriyalar real brauzer hadisələri deyil; onlar "insan kimi görünmək" kitabxanalarının çıxışını təqlid edir və yalnız kinematik hakimi sınayır.`, ``);
mkdirSync('internal/docs', { recursive: true });
writeFileSync('internal/docs/EVAL.md', out.join('\n'));
console.log(out.slice(0, 4).join('\n')); console.log(`\nwrote internal/docs/EVAL.md (${out.length} lines) — human synthetic ${totH.synthetic}/${totH.n}, agent human ${totA.human}/${totA.n}, session misses ${sessMiss}/${sessN} runs`);
store.close();
