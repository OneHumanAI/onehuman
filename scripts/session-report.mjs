// SPDX-License-Identifier: BUSL-1.1
/**
 * Session timeline report — what a person or agent did on the live site and what the system decided.
 *
 *   node scripts/session-report.mjs                 # every session with activity in the last 60 minutes
 *   node scripts/session-report.mjs 90              # last 90 minutes
 *   node scripts/session-report.mjs fe533913        # one session (id prefix) or a room id prefix
 *   ONEHUMAN_DB=data/lab.db node scripts/session-report.mjs   # local database instead of Turso
 *
 * For each session: arrival (browser, agent-app token), then a merged timeline of attach, seal, every
 * click with its kinematic judgement (exactly as the assessment computes it, repeat-click aware) and every
 * decision with actor/score/tiers/reasons and the notice the UI showed for it.
 */
import { readFileSync, existsSync } from 'node:fs';
if (!process.env.ONEHUMAN_DB && existsSync('.env.local')) for (const line of readFileSync('.env.local', 'utf8').split('\n')) { const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const { clientFromEnv } = await import('../server/sql.ts');
const { judgeClicks } = await import('../server/assess.ts');

const arg = process.argv[2];
const { client } = await clientFromEnv();
const q = async (sql, args = []) => (await client.execute(sql, args)).rows;
const t = (ms) => new Date(Number(ms)).toLocaleTimeString('az-AZ', { hour12: false });
const rel = (ms, base) => `+${((Number(ms) - Number(base)) / 1000).toFixed(1)}s`;

let sessions;
if (arg && /^[0-9a-f]{6,}/i.test(arg)) sessions = await q("SELECT * FROM sessions WHERE id LIKE ? OR room LIKE ? ORDER BY created", [`${arg}%`, `${arg}%`]);
else { const minutes = Number(arg) || 60; sessions = await q('SELECT * FROM sessions WHERE last_seen > ? ORDER BY created', [Date.now() - minutes * 60000]); }

const NOTICE = { allow: 'açıldı', mask: '🔒 "Bəzi məlumatlar gizlədilib…"', block: '⛔ "Bu məlumat qorunur… bloklandı"', step_up: '🔐 təsdiq istənildi' };
let shown = 0;
for (const s of sessions) {
  const decisions = await q('SELECT body, created FROM decisions WHERE session = ? ORDER BY seq', [s.id]);
  const events = await q("SELECT kind, payload, created FROM events WHERE session = ? AND kind IN ('interaction','attach','seal') ORDER BY id", [s.id]);
  if (!decisions.length && !events.some((e) => e.kind !== 'interaction')) continue;
  shown++;
  const arr = s.arrival ? JSON.parse(s.arrival) : null;
  const app = (await q('SELECT app FROM rooms WHERE id = ?', [s.room]))[0]?.app;
  const lastSig = (await q("SELECT payload FROM events WHERE session = ? AND kind = 'signal' ORDER BY id DESC LIMIT 1", [s.id]))[0];
  const sig = lastSig ? JSON.parse(lastSig.payload) : null;
  const browser = arr?.environment?.agentAppToken ? `AI tətbiqinin brauzeri (${arr.environment.agentAppToken})` : arr?.uaMajor ? `Chrome/Safari ${arr.uaMajor}` : 'naməlum brauzer';
  console.log(`\n━━ ${s.id.slice(0, 8)}  ${app ?? '?'}  ${t(s.created)}  label=${s.label}${s.scenario ? ` scenario=${s.scenario}` : ''}  ${browser}`);
  console.log(`   agent qoşuldu: ${s.agent_attached_at ? rel(s.agent_attached_at, s.created) : 'yox'}   insan təsdiqi (passkey): ${s.human_verified_at ? rel(s.human_verified_at, s.created) : 'yox'}`);
  if (sig) console.log(`   siqnallar: markers=${(sig.markers ?? []).map((m) => m.name).join(',') || '-'} globals=${(sig.environment?.agentGlobals ?? []).length} ext=${(sig.environment?.extensionsInstalled ?? []).join(',') || '-'} readBursts=${sig.reading?.readBursts ?? 0} textExtracts=${sig.reading?.textExtracts ?? 0} focusWhileHidden=${sig.environment?.focusWhileHiddenMs ?? '-'} seal=${sig.reading?.seal ? `${sig.reading.seal.reason}@${sig.reading.seal.atMs}ms` : '-'}`);

  // judge clicks in order, the way assess does (window semantics aside), so repeat clicks are recognised
  const clicks = events.filter((e) => e.kind === 'interaction').map((e) => ({ created: e.created, click: JSON.parse(e.payload).click })).filter((x) => x.click);
  const judged = judgeClicks(clicks.map((x) => x.click));
  let ji = 0;
  const rows = [];
  for (const e of events) {
    if (e.kind === 'attach') { const p = JSON.parse(e.payload); rows.push([e.created, `AGENT QOŞULDU  ${p.state}  ${p.evidence.map((x) => x.code).join(',')}`]); }
    else if (e.kind === 'seal') { const p = JSON.parse(e.payload); rows.push([e.created, `EKRAN MÖHÜRLƏNDİ  səbəb=${p.reason}  redaktə=${p.redacted}`]); }
    else if (e.kind === 'interaction') {
      const c = JSON.parse(e.payload).click; if (!c) continue;
      const eligible = c.traj && c.trusted && c.pointer === 'mouse' && c.detail !== 0;
      const j = eligible ? judged[ji++] : null;
      rows.push([e.created, `KLİK  ${j ? `${j.verdict.toUpperCase()} ${j.humanPts}/${j.agentPts} [${j.flags.join(',')}]` : `(${c.pointer || 'keyboard'}${c.trusted ? '' : ', untrusted'})`}  n=${c.traj?.length ?? c.moves} hold=${c.holdMs}ms pr=${c.pressure}${c.hidden ? ' HIDDEN' : ''}`]);
    }
  }
  for (const d of decisions) { const x = JSON.parse(d.body); rows.push([d.created, `QƏRAR  ${x.resource}  → ${x.decision.toUpperCase()}  ${NOTICE[x.decision] ?? ''}  actor=${x.actor} score=${x.score} tiers=${x.tiers.join('+') || '-'}  səbəblər: ${x.reasonCodes.join(', ')}`]); }
  rows.sort((a, b) => Number(a[0]) - Number(b[0]));
  for (const [at, line] of rows) console.log(`   ${t(at)} ${rel(at, s.created).padStart(8)}  ${line}`);
}
console.log(`\n${shown} sessiya göstərildi (${sessions.length} tapıldı).`);
client.close?.();
