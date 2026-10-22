// SPDX-License-Identifier: BUSL-1.1
(() => {
  const $ = (s) => document.querySelector(s);
  const room = new URL(location.href).searchParams.get('room');
  const q = `?room=${encodeURIComponent(room)}`;
  const MODES = ['allow', 'mask', 'step_up', 'block'];
  const DEC = { allow: 'İcazə', mask: 'Maskala', step_up: 'Step-up', block: 'Blok' };
  const TIERS = ['verified', 'strong', 'control', 'behavioral', 'artifact'];
  const TIER = { verified: 'imza', strong: 'güclü', control: 'aktiv idarə', behavioral: 'davranış', artifact: 'mühit izi' };
  const ACTOR = { agent_likely: 'Agent ehtimalı', human_like: 'İnsanabənzər', unknown: 'Naməlum' };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const time = (t) => new Date(t).toLocaleTimeString('az-AZ', { hour12: false });
  $('#lab-link').href = `/${q}`; $('#back').href = `/${q}`;

  let policy = null;

  const sel = (name, value) => `<select data-k="${name}">${MODES.map((m) => `<option value="${m}" ${m === value ? 'selected' : ''}>${DEC[m]}</option>`).join('')}</select>`;

  function renderRules() {
    $('#enforcement').value = policy.enforcement;
    $('#policy-version').textContent = policy.version;
    $('#rules tbody').innerHTML = policy.rules.map((r, i) => `<tr data-i="${i}">
      <td><input data-k="resource" value="${esc(r.resource)}" size="18" pattern="[a-z][a-z0-9_.]{1,60}"></td>
      <td><input data-k="title" value="${esc(r.title)}" size="16"></td>
      <td>${sel('onAgent', r.onAgent)}</td><td>${sel('onArtifact', r.onArtifact || 'allow')}</td><td>${sel('onUnknown', r.onUnknown)}</td><td>${sel('onHumanLike', r.onHumanLike)}</td>
      <td>${TIERS.map((t) => `<label class="small"><input type="checkbox" data-t="${t}" ${r.actOn.includes(t) ? 'checked' : ''}> ${TIER[t]}</label> `).join('')}</td>
      <td><input data-k="minScore" type="number" min="0" max="100" value="${r.minScore}" style="width:64px"></td>
      <td><button class="ghost small" data-del="${i}">sil</button></td></tr>`).join('');
  }

  function readRules() {
    const rules = [...document.querySelectorAll('#rules tbody tr')].map((tr) => ({
      resource: tr.querySelector('[data-k=resource]').value.trim(),
      title: tr.querySelector('[data-k=title]').value.trim(),
      onAgent: tr.querySelector('[data-k=onAgent]').value,
      onArtifact: tr.querySelector('[data-k=onArtifact]').value,
      onUnknown: tr.querySelector('[data-k=onUnknown]').value,
      onHumanLike: tr.querySelector('[data-k=onHumanLike]').value,
      actOn: TIERS.filter((t) => tr.querySelector(`[data-t=${t}]`).checked),
      minScore: Number(tr.querySelector('[data-k=minScore]').value),
    }));
    return { enforcement: $('#enforcement').value, rules };
  }

  async function load() {
    const p = await fetch(`/api/v1/policy${q}`).then((r) => r.json());
    if (p.error) { document.body.innerHTML = '<main><p>Otaq tapılmadı.</p></main>'; return; }
    policy = p.policy;
    renderRules();
    $('#history').innerHTML = p.history.map((h) => `<li><code>${esc(h.version)}</code> · ${h.enforcement} · ${time(h.created)}</li>`).join('') || `<li class="muted">Hələ dəyişiklik yoxdur; defolt qayda işləyir.</li>`;
    await refresh();
  }

  async function refresh() {
    const [b, a] = await Promise.all([
      fetch(`/api/v1/benchmark${q}`).then((r) => r.json()),
      fetch(`/api/v1/audit${q}`).then((r) => r.json()),
    ]);
    if (b.error || a.error) return;
    const g = b.groups;
    $('#bench tbody').innerHTML = ['human', 'agent', 'unlabelled'].map((k) => `<tr><td>${k}</td><td>${g[k].sessions}</td><td>${g[k].completed}</td><td>${g[k].detected}</td><td>${g[k].detectedBeforeData}</td><td>${g[k].blocked}</td><td>${g[k].stepUp}</td><td>${g[k].masked}</td><td>${g[k].sensitiveDelivered}</td><td>${g[k].unknownFinal}</td><td>${g[k].medianLatencyMs ?? '—'} ms</td><td>${g[k].medianFirstDecisionMs != null ? (g[k].medianFirstDecisionMs / 1000).toFixed(1) + ' s' : '—'}</td></tr>`).join('');
    $('#bench-facts').innerHTML = ['human', 'agent', 'unlabelled'].map((k) => `<div><strong>${g[k].attached} / ${g[k].sessions}</strong><span>${k}: “agent qoşulub” · əməliyyatdan əvvəl ${g[k].attachedBeforeFirstAction} · mühit ${g[k].environmentOnly}</span></div>`).join('') +
      `<div><strong>${b.falseAttachSessions}</strong><span>insan etiketli, “agent qoşulub” sayılan</span></div><div><strong>${b.falseBlockSessions}</strong><span>insan etiketli, bloklanmış (yanlış blok namizədi)</span></div><div><strong>${b.missedAgentSessions}</strong><span>agent etiketli, məlumat alıb aşkarlanmayan (buraxılmış)</span></div>`;
    $('#bench-note').textContent = b.note;
    $('#chain').textContent = a.chain.ok ? `zəncir bütövdür · ${a.chain.checked} qeyd` : `ZƏNCİR POZULUB · #${a.chain.brokenAt}`;
    $('#chain').className = `tag ${a.chain.ok ? 'human' : 'agent'}`;
    $('#audit tbody').innerHTML = a.decisions.map((d) => `<tr><td>${d.seq}</td><td class="mono">${time(d.created)}</td><td><code>${d.session.slice(0, 8)}</code></td><td><code>${esc(d.resource)}</code></td><td><span class="decision ${d.decision}${d.enforced ? '' : ' shadow'}">${DEC[d.decision]}</span>${d.enforced ? '' : ` <span class="small muted">(${DEC[d.computed]})</span>`}</td><td>${ACTOR[d.actor]}${d.score != null ? ' · ' + d.score : ''}</td><td class="small">${d.reasonCodes.map((c) => `<code>${esc(c)}</code>`).join(' ')}</td><td class="small mono">${esc(d.policyVersion)}<br>${esc(d.signalVersion)}</td><td class="mono small" title="${esc(d.hash)}">${d.hash.slice(0, 10)}…</td></tr>`).join('') || '<tr><td colspan="9" class="muted">Hələ qərar yoxdur.</td></tr>';
  }

  $('#add-rule').addEventListener('click', () => { policy = { ...policy, rules: [...readRules().rules, { resource: 'new.resource', title: 'Yeni resurs', onAgent: 'block', onArtifact: 'allow', onUnknown: 'allow', onHumanLike: 'allow', actOn: ['verified', 'strong', 'control', 'behavioral'], minScore: 65 }] }; renderRules(); });
  $('#rules').addEventListener('click', (e) => { const b = e.target.closest('[data-del]'); if (!b) return; const r = readRules().rules; r.splice(Number(b.dataset.del), 1); policy = { ...policy, rules: r }; renderRules(); });
  $('#save').addEventListener('click', async () => {
    const body = readRules();
    const r = await fetch(`/api/v1/policy${q}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    $('#save-status').textContent = r.ok ? `Saxlanıldı: ${d.policy.version}` : `Xəta: ${d.message || d.error}`;
    if (r.ok) load();
  });
  $('#reset').addEventListener('click', async () => {
    const r = await fetch('/api/v1/policy-default').then((x) => x.json()).catch(() => null);
    if (!r) return;
    const { version, ...rest } = r.policy;
    const s = await fetch(`/api/v1/policy${q}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rest) });
    $('#save-status').textContent = s.ok ? 'Defolt qayda yeni versiya kimi saxlanıldı.' : 'Xəta.';
    load();
  });
  load();
  setInterval(() => refresh().catch(() => {}), 5000);
})();
