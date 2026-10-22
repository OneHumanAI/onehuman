// SPDX-License-Identifier: BUSL-1.1
/* Shared live engine readout for the lab pages (training + sandbox).
   Every click the lab records comes back from the server with the real features and the real
   per-click verdict; this renders it while the run is still going — the trajectory as it was
   measured, the physics the judge used, and the flags that argued each way. */
(() => {
  const $ = (s) => document.querySelector(s);
// ------------------------------------------------------------ live engine readout
// Every recorded click comes back from the server with the real features and the real
// per-click verdict. Showing it live is the point of the lab: you see *why* you looked
// like a hand (or did not) while you are still moving.
const HUD = {
  el: $('#hud'), verdict: $('#hud-verdict'), meters: $('#hud-meters'), flags: $('#hud-flags'),
  tally: $('#hud-tally'), spark: $('#spark'), sub: $('#hud-sub'), canvas: $('#trace'),
  counts: { human: 0, synthetic: 0, uncertain: 0 },
};
const VERDICT_WORD = { human: 'insan', synthetic: 'sintetik', uncertain: 'qeyri-müəyyən' };
const FLAG_WORDS = {
  // hand-shaped
  curved_path: 'əyri yol', tremor: 'titrəyiş', sub_movements: 'düzəlişlər', decelerates: 'hədəfdə yavaşıma',
  off_centre: 'mərkəzdən kənar', short_hold: 'qısa basma', travel_time: 'yol müddəti', irregular_timing: 'qeyri-bərabər ölçmə',
  repeat_click: 'təkrar klik', model_human: 'model: insan', sparse_sampling: 'seyrək ölçmə', batched_points: 'paketlənmiş nöqtələr',
  // program-shaped
  teleport: 'sıçrayış', no_trajectory: 'yol yoxdur', dead_centre: 'tam mərkəz', pressure_0: 'təzyiq yoxdur',
  straight_line: 'düz xətt', smooth_curve: 'hamar əyri', generated_curve: 'generasiya olunmuş əyri', white_noise_path: 'ağ küy yolu',
  no_tremor: 'titrəyiş yoxdur', no_deceleration: 'yavaşıma yoxdur', flat_profile: 'düz sürət profili', single_ballistic: 'tək atış',
  uniform_timing: 'bərabər ölçmə', stale_approach: 'köhnə yaxınlaşma', aimed_dwell: 'nişan alıb gözləyib',
  model_synthetic: 'model: sintetik', keyboard_activation: 'klaviatura ilə',
  centre_tap: 'tam mərkəzə toxunuş', centre_tap_soft: 'mərkəzə yaxın (əl təzyiqi ilə)',
  instant_release: 'ani buraxılış', tap_release: 'tap-to-click buraxılışı',
  held_press: 'əl basması (təzyiqlə)', hold_normal: 'normal basma müddəti',
};
const flagWord = (f) => FLAG_WORDS[f] || f.replace(/_/g, ' ');
const METERS = [
  { key: 'straightness', label: 'düzlük', fmt: (v) => v.toFixed(3), norm: (v) => v, warn: (v) => v > 0.985, hint: 'proqram düz xətt çəkir' },
  { key: 'tremor', label: 'titrəyiş', fmt: (v) => v.toFixed(2) + ' px', norm: (v) => Math.min(1, v / 3), warn: (v) => v < 0.15 || v > 8 },
  { key: 'subMovements', label: 'düzəliş', fmt: (v) => String(v), norm: (v) => Math.min(1, v / 6), warn: (v) => v === 0 },
  { key: 'holdMs', label: 'basma', fmt: (v) => v + ' ms', norm: (v) => Math.min(1, v / 250), warn: (v) => v !== null && v < 20 },
  { key: 'endSlow', label: 'yavaşıma', fmt: (v) => v.toFixed(2), norm: (v) => Math.min(1, v), warn: (v) => v > 0.85 },
  { key: 'n', label: 'yol nöqtəsi', fmt: (v) => String(v), norm: (v) => Math.min(1, v / 60), warn: (v) => v < 8 },
];
function drawTrace(traj, at) {
  const cv = HUD.canvas; if (!cv) return;
  const ctx = cv.getContext('2d'); const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,.05)'; ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 28) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y < H; y += 28) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  const pts = (traj || []).filter((q) => Array.isArray(q) && q.length >= 3);
  if (pts.length < 2) {
    ctx.fillStyle = '#6b6b74'; ctx.font = '12px ' + getComputedStyle(document.body).fontFamily;
    ctx.fillText('bu klikdə yol yoxdur — kursor hədəfə sıçrayıb', 16, H / 2);
    if (at) { ctx.beginPath(); ctx.arc(W / 2, H / 2, 7, 0, Math.PI * 2); ctx.fillStyle = '#ff7b7b'; ctx.fill(); }
    return;
  }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [, x, y] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const pad = 18, sx = (W - pad * 2) / Math.max(1, maxX - minX), sy = (H - pad * 2) / Math.max(1, maxY - minY);
  const k = Math.min(sx, sy), ox = pad + ((W - pad * 2) - (maxX - minX) * k) / 2, oy = pad + ((H - pad * 2) - (maxY - minY) * k) / 2;
  const P = pts.map(([t, x, y]) => ({ t, x: ox + (x - minX) * k, y: oy + (y - minY) * k }));
  let maxV = 0; const v = [0];
  for (let i = 1; i < P.length; i++) { const dt = Math.max(1, P[i].t - P[i - 1].t); const s = Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y) / dt; v.push(s); maxV = Math.max(maxV, s); }
  ctx.lineCap = 'round';
  let i = 1;
  const step = () => {
    const end = Math.min(P.length, i + Math.max(1, Math.round(P.length / 26)));
    for (; i < end; i++) {
      const u = maxV ? Math.min(1, v[i] / maxV) : 0;              // slow = mint, fast = blue-white
      ctx.strokeStyle = `rgba(${124 + u * 110}, ${240 - u * 30}, ${192 + u * 60}, .95)`;
      ctx.lineWidth = 1.2 + (1 - u) * 2.2;
      ctx.beginPath(); ctx.moveTo(P[i - 1].x, P[i - 1].y); ctx.lineTo(P[i].x, P[i].y); ctx.stroke();
    }
    if (i < P.length) requestAnimationFrame(step);
    else {
      const last = P[P.length - 1];
      ctx.beginPath(); ctx.arc(last.x, last.y, 6, 0, Math.PI * 2); ctx.fillStyle = '#f2f2f3'; ctx.fill();
      ctx.beginPath(); ctx.arc(last.x, last.y, 13, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(242,242,243,.35)'; ctx.lineWidth = 1.5; ctx.stroke();
    }
  };
  requestAnimationFrame(step);
}
function showJudgement(payload, task) {
  if (!payload || !payload.judgement || !HUD.el) return;
  HUD.el.hidden = false;
  const j = payload.judgement, f = payload.features || {};
  HUD.counts[j.verdict] = (HUD.counts[j.verdict] || 0) + 1;
  HUD.verdict.innerHTML = `<span class="res ${j.verdict}">${VERDICT_WORD[j.verdict] || j.verdict} · ${j.humanPts}/${j.agentPts}</span>`;
  HUD.sub.textContent = `${task} · ${payload.version}`;
  HUD.meters.innerHTML = METERS.map((m) => {
    const raw = f[m.key];
    if (raw === null || raw === undefined) return `<div class="meter"><span>${m.label}</span><span class="bar"><i style="width:0"></i></span><span class="v">—</span></div>`;
    const w = Math.round(Math.max(0.02, Math.min(1, m.norm(raw))) * 100);
    return `<div class="meter ${m.warn(raw) ? 'warn' : ''}"><span>${m.label}</span><span class="bar"><i style="width:${w}%"></i></span><span class="v">${m.fmt(raw)}</span></div>`;
  }).join('');
  const agentish = /teleport|no_trajectory|dead_centre|pressure_0|centre_tap$|instant_release|straight_line|smooth_curve|generated_curve|white_noise|no_tremor|no_deceleration|flat_profile|single_ballistic|uniform_timing|stale_approach|aimed_dwell|model_synthetic/;
  HUD.flags.innerHTML = (j.flags || []).map((fl) => `<span class="${agentish.test(fl) ? 'a' : 'h'}">${flagWord(fl)}</span>`).join('');
  HUD.tally.innerHTML = `<b class="g">${HUD.counts.human} insan</b><b class="r">${HUD.counts.synthetic} sintetik</b><b class="a">${HUD.counts.uncertain} qeyri-müəyyən</b>`;
  const dot = document.createElement('i'); dot.className = j.verdict; HUD.spark.appendChild(dot);
  if (HUD.spark.children.length > 60) HUD.spark.firstElementChild.remove();
}

  window.OneHumanHud = {
    get ready() { return !!HUD.el; },
    trace: (traj, at) => drawTrace(traj, at),
    show: (payload, task) => showJudgement(payload, task),
    hide: () => { if (HUD.el) HUD.el.hidden = true; },
  };
})();
