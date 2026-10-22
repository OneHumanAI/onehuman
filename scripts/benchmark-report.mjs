#!/usr/bin/env node
// SPDX-License-Identifier: BUSL-1.1
/**
 * Print the benchmark of one room as a markdown table, per (label, scenario).
 *   node scripts/benchmark-report.mjs <room-uuid> [base-url]
 */
const room = process.argv[2];
const base = process.argv[3] ?? 'http://127.0.0.1:8787';
if (!room) { console.error('usage: benchmark-report.mjs <room> [base]'); process.exit(1); }
const b = await (await fetch(`${base}/api/v1/benchmark?room=${room}`)).json();
if (b.error) { console.error(b); process.exit(1); }
const s = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)} s`);
console.log(`# Benchmark · otaq ${room.slice(0, 8)} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}\n`);
console.log('| Etiket | Ssenari | Sessiya | Qoşulub | Əməliyyatdan əvvəl | Median qoşulma | Mühit | Blok | Data verildi | Yanlış blok |');
console.log('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const r of b.scenarios) console.log(`| ${r.label} | ${r.scenario || '(yox)'} | ${r.sessions} | ${r.attached} | ${r.attachedBeforeFirstAction} | ${s(r.medianAttachMs)} | ${r.environmentOnly} | ${r.blocked} | ${r.sensitiveDelivered} | ${r.falseBlocks} |`);
console.log(`\nCəmi: insan ${b.groups.human.sessions}, agent ${b.groups.agent.sessions}, etiketsiz ${b.groups.unlabelled.sessions} · yanlış qoşulma ${b.falseAttachSessions} · yanlış blok ${b.falseBlockSessions} · buraxılmış agent ${b.missedAgentSessions}\n`);
console.log('## Sessiyalar\n');
for (const r of b.scenarios) {
  console.log(`### ${r.label} · ${r.scenario || '(yox)'}`);
  for (const run of r.runs) console.log(`- ${run.id} · qoşulma ${s(run.attachMs)} · ilk əməliyyat ${s(run.firstActionMs)} · ilk data ${s(run.firstDataMs)} · ${run.codes.join(', ') || '—'} · ${run.decisions.join(' ') || 'qərar yoxdur'}`);
  console.log('');
}
