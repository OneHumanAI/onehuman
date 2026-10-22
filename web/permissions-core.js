// SPDX-License-Identifier: BUSL-1.1
/* The AI agent permissions generator's rules and its HTML, in one place. The page renders with it in the browser
   (web/permissions-generator.js); scripts/seo.mjs renders the default result into the page with it, so crawlers that
   do not run JavaScript read the same rules a visitor sees, and nothing moves while the page loads.
   The balanced defaults are the matrix in AGENTS.md. Every string that reaches HTML goes through esc(): titles of
   custom resources come from the visitor or from a shared link. */
(function (root) {
  /** What a resource is decides its default answers. `act` resources change something; they are never masked. */
  const CLASSES = {
    money: { label: 'Money data', act: false, examples: 'Balances, statements, transactions', why: 'Read-only money. Masking keeps the page usable.' },
    personal: { label: 'Personal data', act: false, examples: 'Names, contact details, ID documents', why: 'Regulated data. Agents summarise it and pass it on.' },
    bulk: { label: 'Lists and search', act: false, examples: 'Customer lists, CRM search', why: 'One pass reads every record.' },
    special: { label: 'Medical or HR data', act: false, examples: 'Medical records, salaries', why: 'The most sensitive data an app holds.' },
    export: { label: 'Files and exports', act: false, examples: 'Documents, CSV exports, downloads', why: 'One click hands over the whole dataset.' },
    secret: { label: 'Keys and passwords', act: false, examples: 'API keys, tokens, recovery codes', why: 'Must never reach a model.' },
    payment: { label: 'Moves money', act: true, examples: 'Transfers, orders, refunds, payout details', why: 'Hard to reverse. A hidden instruction on a web page can trigger it.' },
    admin: { label: 'Deletes or changes settings', act: true, examples: 'Deletes, roles, invites, security settings', why: 'Hard to undo, and it changes who has access.' },
  };
  const RESOURCES = [
    { id: 'balance.read', title: 'Balances and transactions', cls: 'money' },
    { id: 'profile.read', title: 'Profile and contact details', cls: 'personal' },
    { id: 'identity.read', title: 'ID and KYC documents', cls: 'personal' },
    { id: 'customers.search', title: 'Customer lists and search', cls: 'bulk' },
    { id: 'documents.read', title: 'Documents and statements', cls: 'export' },
    { id: 'report.export', title: 'Exports and CSV downloads', cls: 'export' },
    { id: 'health.read', title: 'Medical records', cls: 'special' },
    { id: 'payroll.read', title: 'Salaries and HR records', cls: 'special' },
    { id: 'api_keys.read', title: 'API keys and tokens', cls: 'secret' },
    { id: 'transfer.make', title: 'Transfers and payments', cls: 'payment' },
    { id: 'order.place', title: 'Orders and checkout', cls: 'payment' },
    { id: 'claim.submit', title: 'Claims and refunds', cls: 'payment' },
    { id: 'payout.update', title: 'Payout and bank details', cls: 'payment' },
    { id: 'record.delete', title: 'Deleting records', cls: 'admin' },
    { id: 'members.manage', title: 'Users, roles and invites', cls: 'admin' },
    { id: 'settings.update', title: 'Account and security settings', cls: 'admin' },
  ];
  const PRESETS = {
    saas: { label: 'B2B SaaS or CRM', r: ['customers.search', 'profile.read', 'documents.read', 'report.export', 'api_keys.read', 'record.delete', 'members.manage', 'settings.update'] },
    bank: { label: 'Bank or fintech', r: ['balance.read', 'profile.read', 'identity.read', 'documents.read', 'report.export', 'transfer.make', 'payout.update', 'settings.update'] },
    insurance: { label: 'Insurance', r: ['profile.read', 'identity.read', 'documents.read', 'health.read', 'claim.submit', 'payout.update', 'settings.update'] },
    health: { label: 'Health', r: ['health.read', 'profile.read', 'documents.read', 'report.export', 'members.manage', 'settings.update'] },
    hr: { label: 'HR or payroll', r: ['payroll.read', 'profile.read', 'identity.read', 'report.export', 'payout.update', 'members.manage', 'settings.update'] },
    store: { label: 'Store or marketplace', r: ['order.place', 'profile.read', 'balance.read', 'customers.search', 'payout.update', 'report.export', 'settings.update'] },
  };
  // [AI agent, AI browser, not sure] per class; a person is always allowed
  const STANCES = {
    open: { label: 'Agent-friendly', hint: 'Agents can work. Private fields stay hidden and the owner approves every risky action.', m: {
      money: ['mask', 'allow', 'allow'], personal: ['mask', 'allow', 'allow'], bulk: ['mask', 'allow', 'allow'], special: ['mask', 'mask', 'allow'],
      export: ['step_up', 'step_up', 'allow'], secret: ['block', 'block', 'step_up'], payment: ['step_up', 'step_up', 'step_up'], admin: ['step_up', 'step_up', 'step_up'] } },
    balanced: { label: 'Balanced', hint: 'Agents read with private fields hidden. Risky actions are closed to agents and wait for the owner otherwise.', m: {
      money: ['mask', 'mask', 'allow'], personal: ['mask', 'mask', 'allow'], bulk: ['mask', 'mask', 'allow'], special: ['block', 'mask', 'allow'],
      export: ['block', 'step_up', 'allow'], secret: ['block', 'block', 'step_up'], payment: ['block', 'step_up', 'step_up'], admin: ['block', 'step_up', 'step_up'] } },
    strict: { label: 'Lockdown', hint: 'Agents get nothing. People in an AI browser see private data hidden until their first real click.', m: {
      money: ['block', 'mask', 'allow'], personal: ['block', 'mask', 'allow'], bulk: ['block', 'mask', 'allow'], special: ['block', 'block', 'allow'],
      export: ['block', 'step_up', 'step_up'], secret: ['block', 'block', 'step_up'], payment: ['block', 'step_up', 'step_up'], admin: ['block', 'step_up', 'step_up'] } },
  };
  const MODES = { observe: { label: 'Watch first', hint: 'Nothing is blocked. Every decision is recorded with what would have happened.' }, enforce: { label: 'Protect now', hint: 'The rules apply from the first request.' } };
  const BRANCHES = [['onAgent', 'AI agent'], ['onArtifact', 'AI browser'], ['onUnknown', 'Not sure']];
  const ANSWER = { allow: 'Allow', mask: 'Mask', step_up: 'Ask owner', block: 'Block' };
  const SAY = {
    read: { allow: 'can read it', mask: 'sees it with private fields hidden', step_up: 'waits for the owner\'s passkey', block: 'is refused' },
    act: { allow: 'can do it', mask: 'can do it', step_up: 'can ask; the owner approves each one with a passkey', block: 'is refused' },
  };
  const URL_SELF = 'https://onehuman.ai/ai-agent-permissions-generator';

  const initial = () => ({ preset: 'saas', stance: 'balanced', mode: 'observe', on: new Set(PRESETS.saas.r), custom: [], edits: {}, tab: 'plain' });
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const all = (s) => [...RESOURCES, ...s.custom];
  const isAct = (s, id) => CLASSES[all(s).find((r) => r.id === id).cls].act;
  function rules(s) {
    return all(s).filter((r) => s.on.has(r.id)).map((r) => {
      const base = STANCES[s.stance].m[r.cls];
      const rule = { resource: r.id, title: r.title };
      BRANCHES.forEach(([k], i) => { rule[k] = s.edits[`${r.id}:${k}`] ?? base[i]; });
      return { ...rule, onHumanLike: 'allow', actOn: ['verified', 'strong', 'control', 'behavioral'], minScore: 65 };
    });
  }
  /** The next answer when a cell is tapped. An action is never masked: hiding fields does not stop a write. */
  function nextAnswer(s, id, branch) {
    const now = rules(s).find((r) => r.resource === id)?.[branch]; if (!now) return null;
    const cycle = isAct(s, id) ? ['allow', 'step_up', 'block'] : ['allow', 'mask', 'step_up', 'block'];
    return cycle[(cycle.indexOf(now) + 1) % cycle.length];
  }
  /** A resource id the policy accepts: lower-case letters, digits, "_" and "."; read or act by what it is. */
  function customId(title, cls) {
    const slug = String(title).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[^a-z]+/, '').slice(0, 40);
    return slug.length >= 2 && CLASSES[cls] ? `${slug}.${CLASSES[cls].act ? 'action' : 'read'}` : null;
  }

  // ------------------------------------------------------------------ text outputs
  const policy = (s, list) => ({ version: 'agent-permissions-1', enforcement: s.mode, rules: list });
  // one line per list of words, so a rule reads at a glance
  const json = (s, list) => JSON.stringify(policy(s, list), null, 2).replace(/\[\n\s+("[^\]]*?")\n\s+\]/g, (_, inner) => `[${inner.split(/,\n\s+/).join(', ')}]`);
  function plain(s, list) {
    const lines = [`AI agent permissions · ${PRESETS[s.preset].label} · ${STANCES[s.stance].label} · ${MODES[s.mode].label}`, ''];
    for (const r of list) {
      const say = SAY[isAct(s, r.resource) ? 'act' : 'read'];
      lines.push(r.title, `  AI agent:     ${say[r.onAgent]}`, `  AI browser:   ${say[r.onArtifact]}`, `  Not sure:     ${say[r.onUnknown]}`, `  Person:       ${say.allow}`, '');
    }
    lines.push('AI agent: proven agent activity in the session.', 'AI browser: an AI app\'s browser, no agent action seen yet.', 'Not sure: too little signal, never treated as a person.', '', `Made with ${URL_SELF}`);
    return lines.join('\n');
  }
  function prompt(s, list) {
    return [
      'Add OneHuman (https://onehuman.ai/docs) to this app so my customers\' AI agents follow the rules below.',
      '',
      '1. Run: npm i onehumanai && npx onehumanai init',
      '2. Save the policy at the end as onehuman.policy.json, in place of the draft init writes.',
      '3. Protect the routes behind each resource with oh.protect(\'<resource>\'):',
      ...list.map((r) => `   - ${r.resource}: ${r.title}`),
      '4. Write one mask function per masked resource. Keep the response shape so the page still renders.',
      `5. Keep "enforcement": "${s.mode}"${s.mode === 'observe' ? ' for the first weeks, then switch to "enforce"' : ''}.`,
      '6. Verify: npx onehumanai verify http://localhost:3000 <one protected path>',
      '',
      json(s, list),
    ].join('\n');
  }
  const output = (s, list) => (s.tab === 'json' ? json(s, list) : s.tab === 'prompt' ? prompt(s, list) : plain(s, list));
  const download = (s, list) => (s.tab === 'json' ? ['onehuman.policy.json', 'application/json'] : s.tab === 'prompt' ? ['onehuman-install-prompt.txt', 'text/plain'] : ['ai-agent-permissions.txt', 'text/plain']);

  // ------------------------------------------------------------------ HTML
  const count = (n) => `${n} ${n === 1 ? 'rule' : 'rules'}`;
  const ans = (mode, extra = '') => `<span class="pg-ans m-${mode}${extra}">${ANSWER[mode]}</span>`;
  function choices(items, current, recommended) {
    return Object.entries(items).map(([id, it]) => `<button type="button" data-id="${id}" aria-pressed="${id === current}">${esc(it.label)}${id === recommended ? '<small>Recommended</small>' : ''}</button>`).join('');
  }
  function resources(s) {
    return [['See', false], ['Do', true]].map(([name, act]) => {
      const list = all(s).filter((r) => CLASSES[r.cls].act === act); if (!list.length) return '';
      return `<div class="pg-group"><span class="pg-group-name">${name}</span><div class="pg-chips pg-toggles">${
        list.map((r) => `<button type="button" data-res="${esc(r.id)}" aria-pressed="${s.on.has(r.id)}" title="${esc(r.id)}">${esc(r.title)}</button>`).join('')}</div></div>`;
    }).join('');
  }
  function matrix(s, list) {
    if (!list.length) return '<p class="pg-empty">Pick at least one thing a customer can see or do.</p>';
    const head = `<thead><tr><th scope="col">Resource</th>${BRANCHES.map(([, n]) => `<th scope="col">${n}</th>`).join('')}<th scope="col">Person</th></tr></thead>`;
    const rows = list.map((r) => `<tr><th scope="row"><span>${esc(r.title)}</span><code>${esc(r.resource)}</code></th>${
      BRANCHES.map(([k, n]) => `<td data-label="${n}"><button type="button" class="pg-ans m-${r[k]}" data-cell="${esc(r.resource)}:${k}" aria-label="${esc(r.title)}, ${n}: ${ANSWER[r[k]]}. Change">${ANSWER[r[k]]}</button></td>`).join('')
    }<td data-label="Person">${ans('allow', ' fixed')}</td></tr>`).join('');
    return `<table class="pg-table"><caption class="sr">AI agent permissions for ${esc(PRESETS[s.preset].label)}, ${esc(STANCES[s.stance].label.toLowerCase())}</caption>${head}<tbody>${rows}</tbody></table>`;
  }
  /** The balanced defaults per kind of data, with the reason: the reference table under the tool. */
  function reference() {
    const m = STANCES.balanced.m;
    const rows = Object.entries(CLASSES).map(([id, c]) => `<tr><th scope="row"><span>${esc(c.label)}</span><em>${esc(c.examples)}</em></th>${
      BRANCHES.map(([, n], i) => `<td data-label="${n}">${ans(m[id][i])}</td>`).join('')}<td class="pg-why" data-label="Why">${esc(c.why)}</td></tr>`).join('');
    return `<table class="pg-table"><caption class="sr">Default AI agent permissions by data type. A person is always allowed.</caption><thead><tr><th scope="col">Data or action</th>${
      BRANCHES.map(([, n]) => `<th scope="col">${n}</th>`).join('')}<th scope="col">Why</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  /** Everything that changes with the visitor's choices, by element id. */
  function render(s) {
    const list = rules(s);
    return {
      'pg-presets': choices(PRESETS, s.preset),
      'pg-res': resources(s),
      'pg-stance': choices(STANCES, s.stance, 'balanced'),
      'pg-stance-hint': esc(STANCES[s.stance].hint),
      'pg-mode': choices(MODES, s.mode, 'observe'),
      'pg-mode-hint': esc(MODES[s.mode].hint),
      'pg-count': count(list.length),
      'pg-jump': `See your ${count(list.length)} ↓`,
      'pg-matrix': matrix(s, list),
      'pg-code': list.length ? esc(output(s, list)) : '',
    };
  }
  /** What never changes: the class picker and the reference table. */
  const statics = () => ({
    'pg-add-cls': Object.entries(CLASSES).map(([id, c]) => `<option value="${id}">${esc(c.label)}</option>`).join(''),
    'pg-ref': reference(),
  });

  root.OneHumanPermissions = { CLASSES, RESOURCES, PRESETS, STANCES, MODES, BRANCHES, ANSWER, initial, all, rules, nextAnswer, customId, output, download, render, statics };
})(globalThis);
