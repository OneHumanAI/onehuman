// SPDX-License-Identifier: BUSL-1.1
/** End-to-end API tests against a real server on a random port. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.ts';
import { signRequest } from '../server/web-bot-auth.ts';
import { pinStrictPolicy } from './strict-policy.ts';

let base = '';
let app: Awaited<ReturnType<typeof createApp>>;

before(async () => {
  app = await createApp({ labOperator: true });
  pinStrictPolicy(app);
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
after(() => { app.server.close(); app.store.close(); });

const earlyBase = { startedMs: 0, observedMs: 500, webdriver: false, firstInteractionMs: null, dataDomMs: null, markers: [], environment: { codexModelContext: false, modelContextApi: false, clipboardBridge: false, clipboardBridgeAtMs: null, agentGlobals: [], extensionsInstalled: [], focusWhileHiddenMs: null }, focusConflict: { count: 0, firstAtMs: null, peers: 0 }, webmcpInvocations: 0 };
const atomic = () => ({ atMs: 1, webdriver: false, click: { trusted: true, pointer: 'mouse', detail: 1, holdMs: 3, moves: 0, path: 0, travelMs: 0 }, keys: 0, keyIntervals: [], inputEvents: 0, paste: false });
const organic = () => ({ atMs: 1, webdriver: false, click: { trusted: true, pointer: 'mouse', detail: 1, holdMs: 120, moves: 20, path: 300, travelMs: 500 }, keys: 0, keyIntervals: [], inputEvents: 0, paste: false });

/** Open the page like a browser would: get a room + session cookie. */
async function open(label?: 'human' | 'agent') {
  const first = await fetch(`${base}/bank`, { redirect: 'manual' });
  assert.equal(first.status, 302);
  const location = first.headers.get('location')!;
  const url = new URL(location, base);
  if (label) url.searchParams.set('as', label);
  const page = await fetch(url, { redirect: 'manual' });
  assert.equal(page.status, 200);
  const cookie = page.headers.get('set-cookie')!.split(';')[0]!;
  const room = url.searchParams.get('room')!;
  const session = cookie.split('=')[1]!;
  return { room, cookie, session, q: `?room=${room}` };
}

const withSample = (sample: unknown) => ({ 'X-OH-Sample': JSON.stringify(sample) });

test('page has no account data; profile endpoint decides', async () => {
  const s = await open();
  const html = await (await fetch(`${base}/bank${s.q}`)).text();
  assert.ok(!/GB\d\dNRST/.test(html), 'no IBAN in bundle');
  const r = await fetch(`${base}/api/v1/account/profile${s.q}`, { headers: { cookie: s.cookie } });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.decision.decision, 'allow');
  assert.equal(d.decision.branch, 'unknown');
  assert.ok(d.profile.iban.startsWith('GB'));
  assert.ok(d.assessment.reasons.some((x: { code: string }) => x.code === 'NO_CLIENT_TELEMETRY'));
});

test('no session cookie → 401, never data', async () => {
  const s = await open();
  const r = await fetch(`${base}/api/v1/account/balance${s.q}`);
  assert.equal(r.status, 401);
});

test('agent-like clicks → balance blocked, profile masked, export blocked', async () => {
  const s = await open('agent');
  const h = { cookie: s.cookie };
  // three atomic clicks through the signals endpoint (what the SDK does)
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${base}/api/v1/signals${s.q}`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ early: earlyBase, interaction: atomic() }) });
    assert.equal(r.status, 200);
  }
  const bal = await fetch(`${base}/api/v1/account/balance${s.q}`, { headers: { ...h, ...withSample({ early: earlyBase, interaction: atomic() }) } });
  assert.equal(bal.status, 403);
  const bd = await bal.json();
  assert.equal(bd.decision.decision, 'block');
  assert.equal(bd.decision.actor, 'agent_likely');
  assert.equal(bd.balance, undefined);

  const prof = await fetch(`${base}/api/v1/account/profile${s.q}`, { headers: h });
  const pd = await prof.json();
  assert.equal(prof.status, 200);
  assert.equal(pd.masked, true);
  assert.ok(pd.profile.iban.includes('••••'));

  const exp = await fetch(`${base}/api/v1/account/export${s.q}`, { method: 'POST', headers: h });
  assert.equal(exp.status, 403);

  const bench = await (await fetch(`${base}/api/v1/benchmark${s.q}`)).json();
  assert.equal(bench.groups.agent.sessions, 1);
  assert.equal(bench.groups.agent.detected, 1);
  assert.equal(bench.groups.agent.detectedBeforeData, 1);
  assert.equal(bench.groups.agent.sensitiveDelivered, 0);
  assert.equal(bench.missedAgentSessions, 0);
});

test('human-like clicks → allowed; export needs no step-up', async () => {
  const s = await open('human');
  const h = { cookie: s.cookie };
  for (let i = 0; i < 3; i++) await fetch(`${base}/api/v1/signals${s.q}`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ early: earlyBase, interaction: organic() }) });
  const exp = await fetch(`${base}/api/v1/account/export${s.q}`, { method: 'POST', headers: { ...h, ...withSample({ early: earlyBase, interaction: organic() }) } });
  assert.equal(exp.status, 200);
  const d = await exp.json();
  assert.equal(d.decision.actor, 'human_like');
  assert.ok(d.downloadUrl);
  const file = await fetch(`${base}${d.downloadUrl}`, { headers: h });
  assert.equal(file.status, 200);
  assert.match(await file.text(), /IBAN/);
  const again = await fetch(`${base}${d.downloadUrl}`, { headers: h });
  assert.equal(again.status, 403);
  assert.equal((await again.json()).reason, 'reused');
  const bench = await (await fetch(`${base}/api/v1/benchmark${s.q}`)).json();
  assert.equal(bench.falseBlockSessions, 0);
});

test('unknown actor → export requires step-up, then allowed once', async () => {
  const s = await open();
  const h = { cookie: s.cookie };
  const exp = await fetch(`${base}/api/v1/account/export${s.q}`, { method: 'POST', headers: h });
  assert.equal(exp.status, 428);
  const d = await exp.json();
  assert.equal(d.decision.decision, 'step_up');
  const wrong = await fetch(`${base}/api/v1/step-up`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: d.stepUp.id, answer: 'NOPE' }) });
  assert.equal(wrong.status, 403);
  const ok = await fetch(`${base}/api/v1/step-up`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: d.stepUp.id, answer: d.stepUp.challenge }) });
  assert.equal(ok.status, 200);
  const retry = await fetch(`${base}/api/v1/account/export${s.q}`, { method: 'POST', headers: h });
  assert.equal(retry.status, 200);
  assert.ok((await retry.json()).decision.reasonCodes.includes('STEP_UP_PASSED'));
  const third = await fetch(`${base}/api/v1/account/export${s.q}`, { method: 'POST', headers: h });
  assert.equal(third.status, 428, 'grant is single-use');
});

test('download token cannot be used by another session', async () => {
  const a = await open('human');
  const b = await open('human');
  for (let i = 0; i < 3; i++) await fetch(`${base}/api/v1/signals${a.q}`, { method: 'POST', headers: { cookie: a.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ early: earlyBase, interaction: organic() }) });
  const d = await (await fetch(`${base}/api/v1/account/export${a.q}`, { method: 'POST', headers: { cookie: a.cookie } })).json();
  const stolen = await fetch(`${base}${d.downloadUrl.replace(a.room, b.room)}`, { headers: { cookie: b.cookie } });
  assert.equal(stolen.status, 403);
});

test('forged telemetry (isTrusted=false) cannot unlock; webdriver → agent', async () => {
  const s = await open();
  const r = await fetch(`${base}/api/v1/account/balance${s.q}`, { headers: { cookie: s.cookie, ...withSample({ early: { ...earlyBase, webdriver: true }, interaction: null }) } });
  assert.equal(r.status, 403);
});

test('malformed telemetry is ignored, not trusted', async () => {
  const s = await open();
  const r = await fetch(`${base}/api/v1/account/profile${s.q}`, { headers: { cookie: s.cookie, 'X-OH-Sample': '{"early":{"webdriver":"no"}}' } });
  assert.equal(r.status, 200);
  assert.ok((await r.json()).assessment.reasons.some((x: { code: string }) => x.code === 'NO_CLIENT_TELEMETRY'));
});

test('verified lab-operator signature → blocked before data; replay rejected', async () => {
  const s = await open();
  const op = app.labOperator!;
  const target = `${base}/api/v1/account/balance${s.q}`;
  const headers = await signRequest(op.privateKey, op.publicJwk, { method: 'GET', url: target, headers: new Headers() }, op.operator, { nonce: 'once' });
  const first = await fetch(target, { headers: { ...headers, cookie: s.cookie } });
  assert.equal(first.status, 403);
  const fd = await first.json();
  assert.ok(fd.decision.tiers.includes('verified'));
  assert.ok(fd.decision.reasonCodes.includes('VERIFIED_OPERATOR_SIGNATURE'));
  const second = await fetch(target, { headers: { ...headers, cookie: s.cookie } });
  assert.equal(second.status, 403);
  assert.ok((await second.json()).decision.reasonCodes.includes('SIGNATURE_REPLAY'));
});

test('observe mode: policy change creates a version and shadows decisions', async () => {
  const s = await open();
  const cur = await (await fetch(`${base}/api/v1/policy${s.q}`)).json();
  const put = await fetch(`${base}/api/v1/policy${s.q}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enforcement: 'observe', rules: cur.policy.rules }) });
  assert.equal(put.status, 200);
  const r = await fetch(`${base}/api/v1/account/balance${s.q}`, { headers: { cookie: s.cookie, ...withSample({ early: { ...earlyBase, webdriver: true }, interaction: null }) } });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.decision.decision, 'allow');
  assert.equal(d.decision.computed, 'block');
  assert.equal(d.decision.enforced, false);
  assert.match(d.decision.policyVersion, /-v1$/);
  const audit = await (await fetch(`${base}/api/v1/audit${s.q}`)).json();
  assert.equal(audit.chain.ok, true);
  assert.ok(audit.decisions.length >= 1);
});

test('agent-app UA token is an environment artifact, never decisive alone', async () => {
  const s = await open();
  const first = await fetch(`${base}/bank`, { redirect: 'manual' });
  const url = new URL(first.headers.get('location')!, base);
  const page = await fetch(url, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Claude/2.2553.1 Chrome/152.0.0.0 Safari/537.36' } });
  const cookie = page.headers.get('set-cookie')!.split(';')[0]!;
  const r = await fetch(`${base}/api/v1/account/balance?room=${url.searchParams.get('room')}`, { headers: { cookie } });
  assert.equal(r.status, 200, 'artifact tier does not block by default');
  const d = await r.json();
  assert.equal(d.decision.actor, 'unknown');
  assert.equal(d.decision.branch, 'artifact');
  assert.equal(d.decision.decision, 'mask', 'default onArtifact for balance is mask');
  assert.equal(d.balance.available, null);
  assert.ok(d.decision.reasonCodes.includes('AGENT_APP_BROWSER'));
  void s;
});

test('active-control marker at page load blocks before any click (Claude in Chrome pattern)', async () => {
  const s = await open('agent');
  const early = { ...earlyBase, markers: [{ name: 'claude-stop', atMs: 123 }, { name: 'claude-cursor', atMs: 123 }] };
  // SDK pushes the passive snapshot first…
  await fetch(`${base}/api/v1/signals${s.q}`, { method: 'POST', headers: { cookie: s.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ early, interaction: null }) });
  // …then the very first protected request is decided
  const r = await fetch(`${base}/api/v1/account/balance${s.q}`, { headers: { cookie: s.cookie, ...withSample({ early, interaction: null }) } });
  assert.equal(r.status, 403);
  const d = await r.json();
  assert.ok(d.decision.tiers.includes('control'));
  assert.ok(d.decision.reasonCodes.includes('AGENT_CONTROL_MARKER'));
  const bench = await (await fetch(`${base}/api/v1/benchmark${s.q}`)).json();
  assert.equal(bench.groups.agent.detectedBeforeData, 1);
});

test('installed extension alone is environment only: no artifact tier, balance stays open', async () => {
  const s = await open('human');
  const early = { ...earlyBase, environment: { ...earlyBase.environment, extensionsInstalled: ['claude-chrome', 'codex-chrome'] } };
  const r = await fetch(`${base}/api/v1/account/balance${s.q}`, { headers: { cookie: s.cookie, ...withSample({ early, interaction: null }) } });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.decision.branch, 'unknown');
  assert.equal(d.decision.decision, 'allow');
  assert.ok(!d.decision.tiers.includes('artifact'));
  assert.ok(d.decision.reasonCodes.includes('AGENT_EXTENSION_INSTALLED'));
  assert.equal(d.masked, false);
  const bench = await (await fetch(`${base}/api/v1/benchmark${s.q}`)).json();
  assert.equal(bench.falseBlockSessions, 0);
});

test('hidden-document click in the sample is strong evidence', async () => {
  const s = await open();
  const click = { trusted: true, pointer: 'mouse', detail: 1, holdMs: 2, moves: 0, path: 0, travelMs: 0, pressure: 0, hidden: true };
  const r = await fetch(`${base}/api/v1/account/balance${s.q}`, { headers: { cookie: s.cookie, ...withSample({ early: earlyBase, interaction: { ...atomic(), click } }) } });
  assert.equal(r.status, 403);
  assert.ok((await r.json()).decision.reasonCodes.includes('HIDDEN_DOCUMENT_CLICK'));
});

test('connection endpoint flips to agent_attached the moment a control marker is reported, before any action', async () => {
  const s = await open('agent');
  const h = { cookie: s.cookie, 'Content-Type': 'application/json' };
  const idle = await (await fetch(`${base}/api/v1/connection${s.q}`, { headers: h })).json();
  assert.equal(idle.connection.state, 'no_indication');
  assert.equal(idle.attachedAt, null);
  // page open for a while, then the agent attaches to the tab: the SDK reports the marker
  await fetch(`${base}/api/v1/signals${s.q}`, { method: 'POST', headers: h, body: JSON.stringify({ early: earlyBase, interaction: null }) });
  const r = await fetch(`${base}/api/v1/signals${s.q}`, { method: 'POST', headers: h, body: JSON.stringify({ early: { ...earlyBase, observedMs: 26200, markers: [{ name: 'claude-stop', atMs: 26113 }] }, interaction: null }) });
  const d = await r.json();
  assert.equal(d.connection.state, 'agent_attached');
  const after = await (await fetch(`${base}/api/v1/connection${s.q}`, { headers: h })).json();
  assert.equal(after.connection.state, 'agent_attached');
  assert.equal(after.attachedClientMs, 26113);
  assert.ok(after.attachedAt > 0);
  const bench = await (await fetch(`${base}/api/v1/benchmark${s.q}`)).json();
  assert.equal(bench.groups.agent.attached, 1);
  assert.equal(bench.groups.agent.attachedBeforeFirstAction, 1);
  assert.equal(bench.falseAttachSessions, 0);
});

test('SSE stream delivers the attach event live, and the attach is sticky for later decisions', async () => {
  const s = await open('agent');
  const h = { cookie: s.cookie, 'Content-Type': 'application/json' };
  const ctrl = new AbortController();
  const resp = await fetch(`${base}/api/v1/stream${s.q}`, { signal: ctrl.signal });
  assert.equal(resp.headers.get('content-type'), 'text/event-stream');
  const reader = resp.body!.getReader();
  const received: string[] = [];
  const waitFor = (needle: string) => new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${needle}: ${received.join('|')}`)), 3000);
    (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value).toString('utf8');
        received.push(chunk);
        if (received.join('').includes(needle)) { clearTimeout(t); resolve(); return; }
      }
    })().catch(reject);
  });
  await fetch(`${base}/api/v1/signals${s.q}`, { method: 'POST', headers: h, body: JSON.stringify({ early: { ...earlyBase, observedMs: 500, markers: [{ name: 'codex-overlay', atMs: 215 }] }, interaction: null }) });
  await waitFor('event: attach');
  const attach = JSON.parse(received.join('').split('event: attach\ndata: ')[1]!.split('\n')[0]!);
  assert.equal(attach.connection.state, 'agent_attached');
  assert.deepEqual(attach.connection.tools, ['codex-chrome']);
  ctrl.abort();
  // agent detaches: the marker is gone from the next snapshot, but the session stays flagged
  const r = await fetch(`${base}/api/v1/account/balance${s.q}`, { headers: { cookie: s.cookie, ...withSample({ early: { ...earlyBase, observedMs: 9000 }, interaction: null }) } });
  assert.equal(r.status, 403);
  const d = await r.json();
  assert.ok(d.decision.reasonCodes.includes('AGENT_ATTACHED_EARLIER'));
  assert.ok(d.decision.tiers.includes('control'));
});

test('reading-time evidence blocks the first protected request with no click at all', async () => {
  const s = await open('agent');
  const h = { cookie: s.cookie, 'Content-Type': 'application/json' };
  const early = { ...earlyBase, reading: { loadedHidden: true, readBursts: 1, firstReadBurstMs: 3158, lastReadBurstReads: 150, readBurstAnonymous: true, textExtracts: 0, firstTextExtractMs: null, visibilityFlickers: 0, firstFlickerMs: null, flickerResize: null, renderWhileHiddenMs: 484, firstClick: null } };
  const sig = await fetch(`${base}/api/v1/signals${s.q}`, { method: 'POST', headers: h, body: JSON.stringify({ early, interaction: null }) });
  assert.equal((await sig.json()).connection.state, 'agent_attached');
  const r = await fetch(`${base}/api/v1/account/balance${s.q}`, { headers: { cookie: s.cookie, ...withSample({ early, interaction: null }) } });
  assert.equal(r.status, 403);
  const d = await r.json();
  assert.ok(d.decision.reasonCodes.includes('MAIN_WORLD_READ_BURST'));
  const bench = await (await fetch(`${base}/api/v1/benchmark${s.q}`)).json();
  assert.equal(bench.groups.agent.attachedBeforeFirstAction, 1);
  assert.equal(bench.groups.agent.sensitiveDelivered, 0);
});

test('two tabs in one profile: the page-bound session header keeps signals apart', async () => {
  // tab A (agent) opens the page; tab B (human) opens it later → the shared cookie now names B
  const a = await open('agent');
  const b = await open('human');
  const pageA = await (await fetch(`${base}/bank${a.q}`, { headers: { cookie: a.cookie } })).text();
  assert.ok(pageA.includes('<meta name="oh-session"'), 'session id is embedded in the page');
  // A keeps reporting with the newer cookie (B's) but with its own embedded session id
  const r = await fetch(`${base}/api/v1/signals${a.q}`, { method: 'POST', headers: { cookie: b.cookie, 'Content-Type': 'application/json', 'X-OH-Session': a.session }, body: JSON.stringify({ early: { ...earlyBase, markers: [{ name: 'codex-overlay', atMs: 138 }] }, interaction: null }) });
  assert.equal(r.status, 200);
  const jb = await (await fetch(`${base}/api/v1/connection${b.q}`, { headers: { cookie: b.cookie, 'X-OH-Session': b.session } })).json();
  assert.equal(jb.connection.state, 'no_indication', 'B is untouched by A\'s signals');
  const ja = await (await fetch(`${base}/api/v1/connection${a.q}`, { headers: { cookie: b.cookie, 'X-OH-Session': a.session } })).json();
  assert.equal(ja.connection.state, 'agent_attached');
  const bench = await (await fetch(`${base}/api/v1/benchmark${a.q}`)).json();
  assert.equal(bench.falseAttachSessions, 0);
});

test('Codex-style app browser: a synthetic first click on a visible document is decisive', async () => {
  const s = await open('agent');
  const early = { ...earlyBase, environment: { ...earlyBase.environment, codexModelContext: true, modelContextApi: true, agentGlobals: ['__codexWebMcpModelContext'] }, reading: { loadedHidden: false, readBursts: 0, firstReadBurstMs: null, lastReadBurstReads: 0, readBurstAnonymous: false, textExtracts: 0, firstTextExtractMs: null, visibilityFlickers: 0, firstFlickerMs: null, flickerResize: null, renderWhileHiddenMs: null, firstClick: { atMs: 14000, trusted: true, pointer: 'mouse', holdMs: 1, moves: 1, pressure: 0, hidden: false } } };
  const r = await fetch(`${base}/api/v1/account/profile${s.q}`, { headers: { cookie: s.cookie, ...withSample({ early, interaction: null }) } });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.masked, true, 'profile is masked on the very first click');
  assert.ok(d.decision.reasonCodes.includes('SYNTHETIC_FIRST_CLICK'));
});

test('lab signature simulation is excluded from benchmark statistics', async () => {
  const s = await open('human');
  const sim = await fetch(`${base}/api/v1/simulate/signed${s.q}`, { method: 'POST', headers: { cookie: s.cookie } });
  assert.equal(sim.status, 200);
  const bench = await (await fetch(`${base}/api/v1/benchmark${s.q}`)).json();
  assert.equal(bench.groups.human.detected, 0);
  assert.equal(bench.groups.human.blocked, 0);
  assert.equal(bench.falseAttachSessions, 0);
  const j = await (await fetch(`${base}/api/v1/journal${s.q}`)).json();
  assert.ok(j.decisions.some((d: { simulated: boolean }) => d.simulated), 'decisions are still audited, flagged simulated');
});

test('cross-room cookie is rejected', async () => {
  const a = await open();
  const b = await open();
  const r = await fetch(`${base}/api/v1/account/profile${b.q}`, { headers: { cookie: a.cookie } });
  assert.equal(r.status, 401);
});
