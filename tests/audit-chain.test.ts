// SPDX-License-Identifier: BUSL-1.1
/**
 * The tamper-evident audit chain under real traffic: a dashboard loads several protected cards at once, and a
 * serverless deployment runs more than one instance. The chain must stay whole, and its hash must cover the
 * evidence, not only the top-level fields.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store } from '../server/db.ts';
import { appendDecision, appendDecisionOnce, canonical, hashDecision, verifyChain } from '../server/audit.ts';
import type { DecisionRow } from '../server/db.ts';
import { getRow, setRow } from './rows.ts';

async function setup() {
  const store = await Store.open();
  const room = await store.createRoom(Date.now(), 'bank', null);
  const session = (await store.createSession(room, 'human', null, Date.now()))!;
  let n = 0;
  const body = (over: Record<string, unknown> = {}) => ({
    id: crypto.randomUUID(), room, session, created: Date.now(), resource: `card.${++n}`, decision: 'allow', computed: 'allow', enforced: true, branch: 'human_like',
    actor: 'human_like', score: 20, tiers: ['behavioral'], reasonCodes: ['HUMAN_KINEMATICS'], policyVersion: 'p1', signalVersion: 'v7', latencyMs: 3, dataDelivered: true, simulated: false,
    assessment: { actor: 'human_like', score: 20, reasons: [{ code: 'HUMAN_KINEMATICS', detail: 'curved path' }], metrics: { clicks: 3 }, version: 'assess-v7' },
    ...over,
  }) as unknown as Omit<DecisionRow, 'prevHash' | 'hash'>;
  return { store, room, body };
}

test('three cards load at once (and then twenty): one chain, seq 1..N, verifies', async () => {
  const { store, room, body } = await setup();
  await Promise.all([appendDecision(store, body()), appendDecision(store, body()), appendDecision(store, body())]);
  await Promise.all(Array.from({ length: 20 }, () => appendDecision(store, body())));
  const rows = (await store.listDecisions(room, 100)).sort((a, b) => a.seq - b.seq);
  assert.deepEqual(rows.map((r) => r.seq), Array.from({ length: 23 }, (_, i) => i + 1));
  assert.deepEqual(await verifyChain(store, room), { ok: true, checked: 23, brokenAt: null });
});

test('two instances append at the same moment: the unique (room, seq) index and the retry keep one chain', async () => {
  const { store, room, body } = await setup();
  // appendDecisionOnce skips the in-process queue, as two separate server instances would
  await Promise.all(Array.from({ length: 12 }, () => appendDecisionOnce(store, body())));
  const report = await verifyChain(store, room);
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.checked, 12);
});

test('the hash covers the evidence: editing a nested reason or metric breaks the chain', async () => {
  for (const edit of [(b: Record<string, any>) => { b.assessment.reasons[0].detail = 'edited'; }, (b: Record<string, any>) => { b.assessment.metrics.clicks = 99; }, (b: Record<string, any>) => { b.assessment.version = 'x'; }]) {
    const { store, room, body } = await setup();
    const first = await appendDecision(store, body());
    await appendDecision(store, body());
    assert.ok(first.hash.startsWith('v2:'));
    const b = JSON.parse(String((await getRow(store, 'decisions', first.id))!.body)); edit(b);
    await setRow(store, 'decisions', first.id, { body: JSON.stringify(b) });
    assert.deepEqual(await verifyChain(store, room), { ok: false, checked: 2, brokenAt: 1 });
  }
});

test('chains written before v2 still verify, and a v2 row can follow a v1 row', async () => {
  const { store, room, body } = await setup();
  const b1 = body();
  const legacyHash = hashDecision('genesis', b1, 1);
  assert.match(legacyHash, /^[0-9a-f]{64}$/);
  await store.insertDecision({ ...b1, prevHash: 'genesis', hash: legacyHash } as DecisionRow, 1, null);
  const next = await appendDecision(store, body());
  assert.equal(next.prevHash, legacyHash);
  assert.deepEqual(await verifyChain(store, room), { ok: true, checked: 2, brokenAt: null });
});

test('canonical JSON sorts keys at every level and is stable', () => {
  assert.equal(canonical({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null }, u: undefined }), '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  assert.equal(canonical({ x: 1, y: 2 }), canonical({ y: 2, x: 1 }));
  assert.equal(createHash('sha256').update(canonical([1, 'a', true])).digest('hex').length, 64);
});
