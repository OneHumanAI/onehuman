// SPDX-License-Identifier: BUSL-1.1
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assess } from '../server/assess.ts';
import { EMPTY_READING, EMPTY_SURFACE, type EarlySignal, type InteractionSample, type ServerSignal } from '../server/signals.ts';

const early = (over: Partial<EarlySignal> = {}): EarlySignal => ({
  startedMs: 0, observedMs: 1000, webdriver: false, firstInteractionMs: null, dataDomMs: null, markers: [],
  environment: { codexModelContext: false, modelContextApi: false, clipboardBridge: false, clipboardBridgeAtMs: null, agentGlobals: [], extensionsInstalled: [], focusWhileHiddenMs: null },
  focusConflict: { count: 0, firstAtMs: null, peers: 0 }, webmcpInvocations: 0, reading: { ...EMPTY_READING }, surface: { ...EMPTY_SURFACE }, ...over,
});
const envOf = (e: EarlySignal, over: Partial<EarlySignal['environment']>): EarlySignal => ({ ...e, environment: { ...e.environment, ...over } });
const atomicClick = (): InteractionSample => ({ atMs: 1, webdriver: false, click: { trusted: true, pointer: 'mouse', detail: 1, holdMs: 4, moves: 0, path: 0, travelMs: 0, pressure: null, hidden: null }, keys: 0, keyIntervals: [], inputEvents: 0, paste: false });
const organicClick = (): InteractionSample => ({ atMs: 1, webdriver: false, click: { trusted: true, pointer: 'mouse', detail: 1, holdMs: 90, moves: 18, path: 240, travelMs: 400, pressure: null, hidden: null }, keys: 0, keyIntervals: [], inputEvents: 0, paste: false });
const untrustedClick = (): InteractionSample => ({ ...atomicClick(), click: { ...atomicClick().click!, trusted: false } });
const server = (status: ServerSignal['signature']['status']): ServerSignal => ({ signature: { status, reason: '', operator: 'https://x', present: { signature: true, signatureInput: true, signatureAgent: true } }, secFetch: { site: null, mode: null, dest: null, user: null }, uaMajor: null, checkedMs: 1 });

test('no telemetry is unknown, never human', () => {
  const a = assess({ server: null, early: null, interactions: [], current: null });
  assert.equal(a.actor, 'unknown');
  assert.equal(a.score, null);
  assert.ok(a.reasons.some((r) => r.code === 'NO_CLIENT_TELEMETRY'));
});

test('one atomic click is not enough', () => {
  const a = assess({ server: null, early: early(), interactions: [atomicClick()], current: null });
  assert.equal(a.actor, 'unknown');
  assert.deepEqual(a.tiers, []);
});

test('three atomic clicks → behavioral agent_likely', () => {
  const a = assess({ server: null, early: early(), interactions: [atomicClick(), atomicClick(), atomicClick()], current: null });
  assert.equal(a.actor, 'agent_likely');
  assert.ok(a.tiers.includes('behavioral'));
  assert.ok((a.score ?? 0) >= 65);
});

test('organic clicks → human_like with disclaimer', () => {
  const a = assess({ server: null, early: early(), interactions: [organicClick(), organicClick(), organicClick()], current: null });
  assert.equal(a.actor, 'human_like');
  assert.ok((a.score ?? 100) <= 25);
});

test('webdriver is strong evidence even with organic clicks', () => {
  const a = assess({ server: null, early: early({ webdriver: true }), interactions: [organicClick(), organicClick(), organicClick()], current: null });
  assert.equal(a.actor, 'agent_likely');
  assert.ok(a.tiers.includes('strong'));
});

test('untrusted click is strong evidence', () => {
  const a = assess({ server: null, early: early(), interactions: [untrustedClick()], current: null });
  assert.equal(a.actor, 'agent_likely');
  assert.ok(a.reasons.some((r) => r.code === 'UNTRUSTED_EVENT'));
});

test('verified operator signature dominates', () => {
  const a = assess({ server: server('verified'), early: early(), interactions: [organicClick(), organicClick(), organicClick()], current: null });
  assert.equal(a.actor, 'agent_likely');
  assert.equal(a.score, 100);
  assert.ok(a.tiers.includes('verified'));
});

test('absent signature contributes nothing', () => {
  const a = assess({ server: server('absent'), early: early(), interactions: [], current: null });
  assert.equal(a.actor, 'unknown');
  assert.ok(!a.tiers.includes('verified'));
});

test('trace artifacts alone stay unknown but are reported', () => {
  const a = assess({ server: null, early: envOf(early({ markers: [{ name: 'claude-styles', atMs: 200 }, { name: 'codex-badge', atMs: 300 }], focusConflict: { count: 4, firstAtMs: 1500, peers: 1 } }), { codexModelContext: true, modelContextApi: true, clipboardBridge: true, clipboardBridgeAtMs: 5, extensionsInstalled: ['codex-chrome'], agentGlobals: ['__codexChromeExtensionHostFetch'] }), interactions: [], current: null });
  assert.equal(a.actor, 'unknown');
  assert.deepEqual(a.tiers, ['artifact']);
  for (const code of ['DOM_MARKER', 'CLIPBOARD_BRIDGE', 'FOCUS_CONFLICT', 'AGENT_EXTENSION_INSTALLED', 'AGENT_PAGE_GLOBALS']) assert.ok(a.reasons.some((r) => r.code === code), code);
});

test('active-control markers are decisive without any click', () => {
  const a = assess({ server: null, early: early({ markers: [{ name: 'claude-stop', atMs: 123 }, { name: 'claude-cursor', atMs: 123 }] }), interactions: [], current: null });
  assert.equal(a.actor, 'agent_likely');
  assert.deepEqual(a.tiers, ['control']);
  assert.ok(a.reasons.some((r) => r.code === 'AGENT_CONTROL_MARKER'));
  const codex = assess({ server: null, early: early({ markers: [{ name: 'codex-overlay', atMs: 215 }] }), interactions: [], current: null });
  assert.equal(codex.actor, 'agent_likely');
});

test('an earlier attach is sticky control evidence even when the marker is gone', () => {
  const a = assess({ server: null, early: early(), interactions: [organicClick(), organicClick(), organicClick()], current: null, attachedEarlierMs: 26113 });
  assert.equal(a.actor, 'agent_likely');
  assert.ok(a.tiers.includes('control'));
  assert.ok(a.reasons.some((r) => r.code === 'AGENT_ATTACHED_EARLIER'));
});

test('focus while hidden is strong, passive evidence', () => {
  const a = assess({ server: null, early: envOf(early(), { focusWhileHiddenMs: 900 }), interactions: [], current: null });
  assert.equal(a.actor, 'agent_likely');
  assert.ok(a.tiers.includes('strong'));
  assert.ok(a.reasons.some((r) => r.code === 'FOCUS_WHILE_HIDDEN'));
});

test('codex environment global alone is not evidence', () => {
  const a = assess({ server: null, early: envOf(early(), { codexModelContext: true, modelContextApi: true }), interactions: [], current: null });
  assert.equal(a.actor, 'unknown');
  assert.deepEqual(a.tiers, []);
});

test('human → agent handover: window re-evaluates', () => {
  const a = assess({ server: null, early: early(), interactions: [organicClick(), organicClick(), atomicClick(), atomicClick(), atomicClick()], current: null });
  assert.equal(a.actor, 'agent_likely');
});

test('click on a hidden document is strong evidence', () => {
  const c = organicClick();
  c.click = { ...c.click!, hidden: true };
  const a = assess({ server: null, early: early(), interactions: [c], current: null });
  assert.equal(a.actor, 'agent_likely');
  assert.ok(a.reasons.some((r) => r.code === 'HIDDEN_DOCUMENT_CLICK'));
});

test('zero-pressure pointer needs repetition and three actions', () => {
  const zp = (): InteractionSample => { const c = organicClick(); c.click = { ...c.click!, pressure: 0 }; return c; };
  const one = assess({ server: null, early: early(), interactions: [zp()], current: null });
  assert.equal(one.actor, 'unknown');
  const three = assess({ server: null, early: early(), interactions: [zp(), zp(), zp()], current: null });
  assert.equal(three.actor, 'agent_likely');
  assert.ok(three.tiers.includes('behavioral'));
  assert.ok(three.reasons.some((r) => r.code === 'ZERO_PRESSURE_POINTER'));
});

test('legacy samples without pressure/hidden fields still assess', () => {
  const a = assess({ server: null, early: early(), interactions: [organicClick(), organicClick(), organicClick()], current: null });
  assert.equal(a.actor, 'human_like');
});

test('webmcp invocation is strong evidence', () => {
  const a = assess({ server: null, early: early({ webmcpInvocations: 1 }), interactions: [], current: null });
  assert.equal(a.actor, 'agent_likely');
});

test('environment traces never override a behaviorally human session (live false positive, 2026-09-20)', () => {
  const env = envOf(early({}), { extensionsInstalled: ['claude-chrome', 'codex-chrome'] });
  const human = { ...organicClick(), click: { ...organicClick().click!, pressure: 0.5, hidden: false } };
  const a = assess({ server: { signature: null, secFetch: null, uaMajor: 153, environment: { agentAppToken: null, clientHints: true } } as unknown as ServerSignal, early: env, interactions: [human, human], current: human });
  assert.equal(a.actor, 'human_like');
  assert.ok(!a.tiers.includes('artifact'));
  assert.ok(a.score !== null && a.score <= 22);
  // the same person inside an agent-app window: environment artifact is reported but the verdict holds
  const inApp = assess({ server: { signature: null, secFetch: null, uaMajor: 152, environment: { agentAppToken: 'Claude/2.2553.1', clientHints: false } } as unknown as ServerSignal, early: env, interactions: [human, human], current: human });
  assert.equal(inApp.actor, 'human_like');
  assert.ok(inApp.reasons.some((r) => r.code === 'AGENT_APP_BROWSER'));
  assert.ok(inApp.score !== null && inApp.score <= 22);
});

test('panel + unattributed main-thread work is control tier; a panel alone stays an artifact', () => {
  const base = { panelOpenedMs: 4000, panelWidthPx: 380, panelClosedMs: null, panelAtLoad: false, scans: 0, firstScanMs: null, longestScanMs: 0, scanAfterPanelMs: null };
  const pair = assess({ server: null, early: early({ surface: { ...base, scans: 1, firstScanMs: 9000, longestScanMs: 240, scanAfterPanelMs: 5000 } }), interactions: [], current: null });
  assert.equal(pair.actor, 'agent_likely', JSON.stringify(pair.reasons));
  assert.ok(pair.reasons.some((r) => r.code === 'PANEL_PAGE_READ' && r.tier === 'control'));

  const alone = assess({ server: null, early: early({ surface: { ...base } }), interactions: [], current: null });
  assert.ok(alone.reasons.some((r) => r.code === 'SIDE_PANEL_OPENED' && r.tier === 'artifact'));
  assert.notEqual(alone.actor, 'agent_likely');
});

test('WebKit taps are not a program: a real iPhone Safari session (2026-09-28) that was blocked stays a person', async () => {
  const { readFileSync } = await import('node:fs');
  const fx = JSON.parse(readFileSync(new URL('./fixtures-ios-safari-taps.json', import.meta.url), 'utf8'));
  const before = assess({ server: { ...fx.arrival, environment: { ...fx.arrival.environment, webkitPointer: false } }, early: null, interactions: fx.interactions, current: null });
  assert.equal(before.actor, 'agent_likely', 'what went wrong: pressure 0 on "mouse" taps read as a program');
  const now = assess({ server: { ...fx.arrival, environment: { ...fx.arrival.environment, webkitPointer: true } }, early: null, interactions: fx.interactions, current: null });
  assert.notEqual(now.actor, 'agent_likely');
  assert.ok(!now.reasons.some((r) => r.code === 'ZERO_PRESSURE_POINTER'));
});

test('real phone users from the first public test are never read as agents, tap by tap', async () => {
  const { readFileSync } = await import('node:fs');
  const fx = JSON.parse(readFileSync(new URL('./fixtures-phones-human.json', import.meta.url), 'utf8')) as Record<string, { arrival: ServerSignal; interactions: InteractionSample[] }>;
  for (const [name, s] of Object.entries(fx)) {
    for (let i = 1; i <= s.interactions.length; i++) {
      const a = assess({ server: s.arrival, early: null, interactions: s.interactions.slice(0, i), current: null });
      assert.notEqual(a.actor, 'agent_likely', `${name}, after tap ${i}`);
    }
  }
});
