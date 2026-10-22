// SPDX-License-Identifier: BUSL-1.1
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueToken, verifyToken } from '../server/tokens.ts';
import { Store } from '../server/db.ts';
import { appendDecision, verifyChain } from '../server/audit.ts';
import type { DecisionRow } from '../server/db.ts';
import { getRow, setRow } from './rows.ts';

const secret = Buffer.from('test-secret-test-secret-test-secret');

test('token binds session, resource and expiry', () => {
  const t = issueToken(secret, { session: 's1', resource: 'report.export', decision: 'allow', decisionId: 'd1' }, 1000, 1000);
  assert.equal(verifyToken(secret, t, { session: 's1', resource: 'report.export' }, 1500).ok, true);
  assert.equal((verifyToken(secret, t, { session: 's2', resource: 'report.export' }, 1500) as { reason: string }).reason, 'wrong_session');
  assert.equal((verifyToken(secret, t, { session: 's1', resource: 'balance.read' }, 1500) as { reason: string }).reason, 'wrong_resource');
  assert.equal((verifyToken(secret, t, { session: 's1', resource: 'report.export' }, 3000) as { reason: string }).reason, 'expired');
  assert.equal((verifyToken(Buffer.from('other'), t, { session: 's1', resource: 'report.export' }, 1500) as { reason: string }).reason, 'bad_signature');
  assert.equal((verifyToken(secret, 'garbage', { session: 's1', resource: 'report.export' }, 1500) as { reason: string }).reason, 'malformed');
});

function decision(room: string, session: string, n: number): Omit<DecisionRow, 'prevHash' | 'hash'> {
  return {
    id: `d${n}`, resource: 'balance.read', decision: 'allow', computed: 'allow', enforced: true, actor: 'unknown', score: null, tiers: [], reasonCodes: [], policyVersion: 'p', signalVersion: 's', branch: 'unknown',
    room, session, latencyMs: 1, dataDelivered: true, simulated: false, created: 1000 + n,
    assessment: { version: 's', actor: 'unknown', score: null, tiers: [], reasons: [], metrics: { actions: 0, atomic: 0, organic: 0, untrusted: 0, keys: 0, markers: 0, focusConflicts: 0, hiddenClicks: 0, zeroPressure: 0 } },
  };
}

test('audit chain verifies and detects tampering', async () => {
  const store = await Store.open();
  const room = await store.createRoom();
  const session = (await store.createSession(room, 'unlabelled', null))!;
  for (let i = 1; i <= 5; i++) await appendDecision(store, decision(room, session, i));
  assert.deepEqual(await verifyChain(store, room), { ok: true, checked: 5, brokenAt: null });
  const body = JSON.parse(String((await getRow(store, 'decisions', 'd3'))!.body));
  body.decision = 'block';
  await setRow(store, 'decisions', 'd3', { body: JSON.stringify(body) });
  const r = await verifyChain(store, room);
  assert.equal(r.ok, false);
  assert.equal(r.brokenAt, 3);
});

test('nonce store consumes once', async () => {
  const store = await Store.open();
  assert.equal(await store.consumeNonce('a', 1000, 0), true);
  assert.equal(await store.consumeNonce('a', 1000, 10), false);
  assert.equal(await store.consumeNonce('a', 1000, 5000), true);
});
