// SPDX-License-Identifier: BUSL-1.1
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyConnection } from '../server/connection.ts';
import { EMPTY_READING, EMPTY_SURFACE, type EarlySignal, type ServerSignal } from '../server/signals.ts';

const early = (over: Partial<EarlySignal> = {}): EarlySignal => ({
  startedMs: 0, observedMs: 1000, webdriver: false, firstInteractionMs: null, dataDomMs: null, markers: [],
  environment: { codexModelContext: false, modelContextApi: false, clipboardBridge: false, clipboardBridgeAtMs: null, agentGlobals: [], extensionsInstalled: [], focusWhileHiddenMs: null },
  focusConflict: { count: 0, firstAtMs: null, peers: 0 }, webmcpInvocations: 0, reading: { ...EMPTY_READING }, surface: { ...EMPTY_SURFACE }, ...over,
});
const env = (over: Partial<EarlySignal['environment']>): EarlySignal => { const e = early(); return { ...e, environment: { ...e.environment, ...over } }; };
const server = (over: Partial<ServerSignal> = {}): ServerSignal => ({ signature: { status: 'absent', reason: '', operator: null, present: { signature: false, signatureInput: false, signatureAgent: false } }, secFetch: { site: null, mode: null, dest: null, user: null }, uaMajor: 153, environment: { agentAppToken: null, clientHints: true }, checkedMs: 1, ...over });

test('nothing observed → no_indication (not "human")', () => {
  const c = classifyConnection(server(), early());
  assert.equal(c.state, 'no_indication');
  assert.equal(c.atMs, null);
});

test('Claude in Chrome control markers → agent_attached at the marker time', () => {
  const c = classifyConnection(server(), early({ markers: [{ name: 'claude-stop', atMs: 26113 }, { name: 'claude-cursor', atMs: 26113 }, { name: 'claude-styles', atMs: 26113 }] }));
  assert.equal(c.state, 'agent_attached');
  assert.equal(c.atMs, 26113);
  assert.deepEqual(c.tools, ['claude-chrome']);
  assert.ok(c.evidence.some((e) => e.code === 'AGENT_CONTROL_MARKER'));
});

test('Codex overlay → agent_attached; favicon badge alone → environment', () => {
  assert.equal(classifyConnection(server(), early({ markers: [{ name: 'codex-overlay', atMs: 215 }] })).state, 'agent_attached');
  const badge = classifyConnection(server(), early({ markers: [{ name: 'codex-badge', atMs: 300 }] }));
  assert.equal(badge.state, 'agent_environment');
  assert.deepEqual(badge.tools, ['codex-chrome']);
});

test('Claude desktop pane: UA token alone is agent_environment, even for a person', () => {
  const c = classifyConnection(server({ environment: { agentAppToken: 'Claude/2.2553.1', clientHints: false } }), early());
  assert.equal(c.state, 'agent_environment');
  assert.equal(c.atMs, 0);
  assert.deepEqual(c.tools, ['claude-app']);
});

test('Codex in-app browser: model-context global alone is agent_environment', () => {
  const c = classifyConnection(server({ uaMajor: 152 }), env({ codexModelContext: true, modelContextApi: true, agentGlobals: ['__codexWebMcpModelContext'] }));
  assert.equal(c.state, 'agent_environment');
  assert.deepEqual(c.tools, ['codex-app']);
  assert.ok(!c.evidence.some((e) => e.code === 'AGENT_PAGE_GLOBALS'), 'model-context global is not double counted');
});

test('installed extensions → agent_environment with tool names', () => {
  const c = classifyConnection(server(), env({ extensionsInstalled: ['claude-chrome', 'codex-chrome'] }));
  assert.equal(c.state, 'agent_environment');
  assert.deepEqual(c.tools.sort(), ['claude-chrome', 'codex-chrome']);
});

test('focus while hidden or webdriver → agent_attached without any click', () => {
  assert.equal(classifyConnection(server(), env({ focusWhileHiddenMs: 900 })).state, 'agent_attached');
  assert.equal(classifyConnection(server(), early({ webdriver: true })).state, 'agent_attached');
});

test('verified signature → signed_agent, dominates everything', () => {
  const c = classifyConnection(server({ signature: { status: 'verified', reason: 'ok', operator: 'https://chatgpt.com', present: { signature: true, signatureInput: true, signatureAgent: true } } }), early({ markers: [{ name: 'claude-stop', atMs: 5 }] }));
  assert.equal(c.state, 'signed_agent');
  assert.deepEqual(c.tools, ['https://chatgpt.com']);
});

const reading = (over: Partial<EarlySignal['reading']>): EarlySignal => { const e = early(); return { ...e, reading: { ...e.reading, ...over } }; };
const claudePane = () => server({ uaMajor: 152, environment: { agentAppToken: 'Claude/2.2553.1', clientHints: false } });

test('Claude pane: whole-document text extraction by an evaluated script → agent_attached, no click', () => {
  const c = classifyConnection(claudePane(), reading({ loadedHidden: true, textExtracts: 4, firstTextExtractMs: 3156 }));
  assert.equal(c.state, 'agent_attached');
  assert.equal(c.atMs, 3156);
  assert.ok(c.evidence.some((e) => e.code === 'MAIN_WORLD_TEXT_EXTRACT'));
  assert.ok(c.tools.includes('claude-app'));
});

test('Claude pane: DOM read burst + accessibility-tree globals → agent_attached with tool name', () => {
  const e = reading({ readBursts: 1, firstReadBurstMs: 3158, lastReadBurstReads: 150, readBurstAnonymous: true });
  e.environment.agentGlobals = ['__claudeElementMap', '__claudeElementReverseMap', '__claudeRefCounter', '__generateAccessibilityTree'];
  const c = classifyConnection(claudePane(), e);
  assert.equal(c.state, 'agent_attached');
  assert.ok(c.evidence.some((x) => x.code === 'MAIN_WORLD_READ_BURST'));
  assert.ok(c.evidence.some((x) => x.code === 'AGENT_TOOL_GLOBALS'));
  assert.ok(c.tools.includes('claude-tools'));
  assert.ok(!c.evidence.some((x) => x.code === 'AGENT_PAGE_GLOBALS'), 'tool-injected globals are not double counted as environment');
});

test('a read burst that is NOT anonymous (page/framework code) is ignored', () => {
  const c = classifyConnection(server(), reading({ readBursts: 3, firstReadBurstMs: 500, lastReadBurstReads: 150, readBurstAnonymous: false }));
  assert.equal(c.state, 'no_indication');
});

test('Claude pane: synthetic first click (pressure 0, no travel, ≤12 ms) → agent_attached at that click', () => {
  const c = classifyConnection(claudePane(), reading({ firstClick: { atMs: 10411, trusted: true, pointer: 'mouse', holdMs: 1, moves: 0, pressure: 0, hidden: true } }));
  assert.equal(c.state, 'agent_attached');
  assert.equal(c.atMs, 10411);
  assert.ok(c.evidence.some((e) => e.code === 'SYNTHETIC_FIRST_CLICK'));
});

test('Claude pane: a human first click (pressure 0.5, pointer travel) stays agent_environment', () => {
  const c = classifyConnection(claudePane(), reading({ firstClick: { atMs: 5074, trusted: true, pointer: 'mouse', holdMs: 116, moves: 65, pressure: 0.5, hidden: false } }));
  assert.equal(c.state, 'agent_environment');
});

test('plain Chrome: a zero-pressure first click on a visible document is not decisive alone', () => {
  const c = classifyConnection(server(), reading({ firstClick: { atMs: 900, trusted: true, pointer: 'mouse', holdMs: 3, moves: 0, pressure: 0, hidden: false } }));
  assert.equal(c.state, 'no_indication');
});

test('render-while-hidden and loaded-hidden are environment only', () => {
  const c = classifyConnection(server(), reading({ loadedHidden: true, renderWhileHiddenMs: 484 }));
  assert.equal(c.state, 'agent_environment');
  assert.ok(c.evidence.some((e) => e.code === 'RENDER_WHILE_HIDDEN'));
});

test('environment evidence is kept alongside attached evidence', () => {
  const c = classifyConnection(server(), env({ extensionsInstalled: ['claude-chrome'], focusWhileHiddenMs: 400 }));
  assert.equal(c.state, 'agent_attached');
  assert.ok(c.evidence.some((e) => e.code === 'AGENT_EXTENSION_INSTALLED'));
});

test('an extension side panel that reads the page is attached; either fact alone is only environment', () => {
  // The ChatGPT/Claude side panel reads the DOM from an isolated world: the page never sees the read,
  // only that a panel took viewport width and that the main thread worked with nobody touching the page.
  const panel = { panelOpenedMs: 4000, panelWidthPx: 380, panelClosedMs: null, panelAtLoad: false, scans: 0, firstScanMs: null, longestScanMs: 0, scanAfterPanelMs: null };
  const onlyPanel = classifyConnection(null, early({ surface: { ...panel } }));
  assert.equal(onlyPanel.state, 'agent_environment');
  assert.ok(onlyPanel.evidence.some((e) => e.code === 'SIDE_PANEL_OPENED'));

  const onlyScan = classifyConnection(null, early({ surface: { ...panel, panelOpenedMs: null, panelWidthPx: 0, scans: 2, firstScanMs: 9000, longestScanMs: 240 } }));
  assert.equal(onlyScan.state, 'agent_environment');
  assert.ok(onlyScan.evidence.some((e) => e.code === 'IDLE_PAGE_SCAN'));

  const both = classifyConnection(null, early({ surface: { ...panel, scans: 1, firstScanMs: 9000, longestScanMs: 240, scanAfterPanelMs: 5000 } }));
  assert.equal(both.state, 'agent_attached');
  assert.ok(both.evidence.some((e) => e.code === 'PANEL_PAGE_READ'));
});

test('an agent from an earlier visit does not mark the next one: a pause over 30 minutes starts clean', async () => {
  const { Store, VISIT_IDLE_MS } = await import('../server/db.ts');
  const store = await Store.open();
  const room = await store.createRoom();
  const id = (await store.createSession(room, 'unlabelled', null, 1_000))!;
  assert.ok(await store.markAgentAttached(id, 2_000, 1_000));
  await store.touchSession(id, 3_000);
  assert.equal((await store.getSession(id))!.agentAttachedAt, 2_000, 'within the visit the fact sticks');
  await store.touchSession(id, 3_000 + VISIT_IDLE_MS + 1);
  assert.equal((await store.getSession(id))!.agentAttachedAt, null, 'after a long pause the new visit is clean');
  store.close();
});

test('a recorded click replayed from another session is not a person clicking', async () => {
  const { Store } = await import('../server/db.ts');
  const { OneHuman } = await import('../server/engine.ts');
  const store = await Store.open();
  const engine = new OneHuman({ store, secret: Buffer.alloc(32, 7) });
  const room = await store.createRoom();
  const traj: [number, number, number][] = Array.from({ length: 12 }, (_, i) => [-400 + i * 30, 100 + i * 17 + (i % 3), 200 + i * 9]);
  const click = { trusted: true, pointer: 'mouse' as const, detail: 1, holdMs: 96, moves: 12, path: 300, travelMs: 400, pressure: 0.5, hidden: false, traj, downMs: -96, target: { w: 120, h: 44, dx: 4, dy: -3 }, coalesced: 0, at: [300, 310] as [number, number] };
  const snap = { early: null, interaction: { atMs: 1000, webdriver: false, keys: 0, keyIntervals: [], inputEvents: 0, paste: false, click } };
  const a = (await store.getSession((await store.createSession(room, 'unlabelled', null))!))!;
  const b = (await store.getSession((await store.createSession(room, 'unlabelled', null))!))!;
  await engine.ingest(room, a, snap);
  await engine.ingest(room, a, snap);   // the same page sends it twice: still its own click
  assert.equal((await store.recentSignals(a.id, Date.now(), 120000, 6)).interactions.length, 2);
  await engine.ingest(room, b, snap);   // somebody else's session
  assert.equal((await store.recentSignals(b.id, Date.now(), 120000, 6)).interactions.length, 0, 'the replay is dropped');
  store.close();
});
