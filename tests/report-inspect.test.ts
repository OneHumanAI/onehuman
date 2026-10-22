// SPDX-License-Identifier: Apache-2.0
/**
 * The design-partner report and `onehuman inspect`, on a real app with a real database: in observe mode the
 * report counts what the rules would have done; inspect prints what the page sent, byte for byte with recordRaw.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { onehuman } from '../integrations/express/index.ts';
import { buildReport } from '../integrations/report/build.ts';
import { renderReportHtml } from '../integrations/report/html.ts';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'oh-report-'));
const db = `sqlite:${join(dir, 'onehuman.db')}`;
const rules = [
  { resource: 'balance.read', title: 'Balance', onAgent: 'mask', onArtifact: 'mask', onUnknown: 'allow', onHumanLike: 'allow', actOn: ['verified', 'strong', 'control', 'behavioral'], minScore: 65 },
  { resource: 'report.export', title: 'Export', onAgent: 'block', onArtifact: 'step_up', onUnknown: 'step_up', onHumanLike: 'allow', actOn: ['verified', 'strong', 'control', 'behavioral'], minScore: 65 },
];
const oh = await onehuman({ secret: 'test-secret-test-secret-test-secret-rprt', policy: { version: 'r1', enforcement: 'observe', rules } as never, db, recordRaw: true });
const app = express();
app.use(oh.middleware());
app.get('/api/balance', oh.protect('balance.read'), (_q, r) => { r.json({ balance: 1 }); });
app.get('/api/export', oh.protect('report.export'), (_q, r) => { r.json({ ok: true }); });
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(async () => { server.close(); await oh.close(); });

const early = { startedMs: 0, observedMs: 500, webdriver: false, firstInteractionMs: null, dataDomMs: null, markers: [{ name: 'claude-stop', atMs: 100 }, { name: 'claude-cursor', atMs: 100 }], environment: { codexModelContext: false, modelContextApi: false, clipboardBridge: false, clipboardBridgeAtMs: null, agentGlobals: [], extensionsInstalled: [], focusWhileHiddenMs: null }, focusConflict: { count: 0, firstAtMs: null, peers: 0 }, webmcpInvocations: 0, reading: { loadedHidden: false, readBursts: 0, firstReadBurstMs: null, lastReadBurstReads: 0, readBurstAnonymous: false, textExtracts: 0, firstTextExtractMs: null, visibilityFlickers: 0, firstFlickerMs: null, flickerResize: null, renderWhileHiddenMs: null, firstClick: null } };
const CLI = fileURLToPath(new URL('../integrations/cli/index.ts', import.meta.url));
const cli = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args, '--db', db], { encoding: 'utf8' });

test('observe mode: nothing is blocked, and the report says what protect mode would have done', async () => {
  // a visitor with nothing to go on
  const plain = await fetch(`${base}/api/export`);
  assert.equal(plain.status, 200, 'observe: nothing blocked');
  // an agent attaches (its tool traces arrive through the page script), then asks for data
  const first = await fetch(`${base}/api/balance`);
  const cookie = first.headers.get('set-cookie')!.split(';')[0]!;
  const body = JSON.stringify({ early, interaction: null });
  const sig = await fetch(`${base}/onehuman/signals`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin: base }, body });
  assert.equal(sig.status, 200);
  for (const p of ['/api/balance', '/api/export']) assert.equal((await fetch(`${base}${p}`, { headers: { cookie } })).status, 200);

  const r = await oh.report({ days: 1 });
  assert.equal(r.mode, 'observe');
  assert.equal(r.sessions.withAgent, 1);
  assert.ok(r.agents.some((a) => a.id === 'claude-chrome' && a.name === 'Claude in Chrome'), JSON.stringify(r.agents));
  assert.equal(r.agentRequests.wouldBlock, 1, 'the export would have been refused');
  assert.equal(r.agentRequests.wouldMask, 1, 'the balance would have been hidden');
  assert.equal(r.decisions.applied.block ?? 0, 0, 'nothing was actually blocked');
  assert.ok(r.notes.some((n) => /would have been refused, hidden or sent to a passkey/.test(n)), r.notes.join(' | '));

  // the CLI builds the same report from the database file
  const out = join(dir, 'r.html');
  const c = cli('report', '--days', '1', '--out', out);
  assert.equal(c.status, 0, c.stderr);
  const html = readFileSync(out, 'utf8');
  assert.match(html, /Claude in Chrome/);
  assert.match(html, /Observe mode: nothing was blocked/);

  // inspect: what the page sent, exactly as received
  const i = cli('inspect');
  assert.equal(i.status, 0, i.stderr);
  assert.ok(i.stdout.includes(body), 'the POST body is printed byte for byte');
  assert.match(i.stdout, /Never sent: page text, what was typed/);
  const list = cli('inspect', '--sessions');
  assert.match(list.stdout, /agent attached/);
});

test('an empty report is the template: every section says what will appear', () => {
  const now = Date.now();
  const html = renderReportHtml(buildReport([], { from: now - 30 * 86_400_000, to: now, source: 'server' }));
  assert.match(html, /Want help going live\? .*cal\.com\/onehumanai/, 'the report ends with the offer to help');
  for (const s of ['Which AI agents', 'Which endpoints they touched', 'Effect on real people', 'Evidence', 'Sessions per day']) assert.ok(html.includes(s), s);
  assert.equal((html.match(/class="empty"/g) ?? []).length, 5);
  assert.doesNotMatch(html, /<script/i, 'no scripts in the report');
});

test('a person refused by a rule is called out', () => {
  const now = Date.now();
  const row = { session: 's', created: now - 1000, resource: 'x.read', decision: 'allow', computed: 'block', actor: 'human_like', tools: [], signed: true, enforced: false };
  const r = buildReport([row], { from: now - 86_400_000, to: now, source: 'server' });
  assert.equal(r.people.wouldBeStopped, 1);
  assert.ok(r.notes.some((n) => /Check those rules before switching on/.test(n)));
});
