// SPDX-License-Identifier: BUSL-1.1
/**
 * Proof keys rotate without breaking old proofs, and the audit chain can be anchored with RFC 3161 timestamps so the
 * deployment's own key is not the only witness of when a chain existed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store, type DecisionRow } from '../server/db.ts';
import { OneHuman } from '../server/engine.ts';
import { verifyProof } from '../server/proof.ts';
import { appendDecision } from '../server/audit.ts';
import { anchorChains, headDigest, timestampStatus } from '../server/anchor.ts';

const secret = Buffer.from('r'.repeat(40));
const row = (over: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(), room: 'r1', session: 's1', created: Date.now(), resource: 'balance.read', decision: 'allow', computed: 'allow', enforced: true, branch: 'human_like',
  actor: 'human_like', score: 20, tiers: [], reasonCodes: [], policyVersion: 'p', signalVersion: 'v', latencyMs: 1, dataDelivered: true, simulated: false, prevHash: 'genesis', hash: 'v2:abc',
  assessment: { actor: 'human_like', score: 20, reasons: [], metrics: {}, version: 'v' }, ...over,
}) as unknown as DecisionRow;

test('rotating the proof key by epoch: new key first, every older proof still verifies', async () => {
  const store = await Store.open();
  const e0 = new OneHuman({ store, secret, proofEpoch: 0 });
  const e2 = new OneHuman({ store, secret, proofEpoch: 2 });
  const old = e0.prover.sign(row(), 1);
  const keys = e2.proofKeys().keys;
  assert.equal(keys.length, 3, 'epochs 2, 1, 0');
  assert.notEqual(keys[0]!.kid, e0.proofKeys().keys[0]!.kid, 'signing key changed');
  assert.ok(keys.some((k) => k.kid === e0.proofKeys().keys[0]!.kid), 'the old key is still published');
  assert.equal(verifyProof(old, keys).valid, true);
  assert.equal(verifyProof(e2.prover.sign(row(), 2), keys).valid, true);
});

test('a new secret with the old public keys kept: old proofs verify, junk keys are dropped', async () => {
  const store = await Store.open();
  const before = new OneHuman({ store, secret });
  const old = before.prover.sign(row(), 1);
  const after = new OneHuman({ store, secret: Buffer.from('n'.repeat(40)), retiredProofKeys: [...before.proofKeys().keys, { kty: 'OKP', crv: 'Ed25519', x: 'not-a-key' } as never] });
  const keys = after.proofKeys().keys;
  assert.equal(keys.length, 2);
  assert.equal(verifyProof(old, keys).valid, true);
});

/** Walk a DER TimeStampReq: version, imprint algorithm (SHA-256) and the digest. */
function readRequest(b: Buffer) {
  const el = (at: number) => { let n = b[at + 1]!, body = at + 2; if (n & 0x80) { const k = n & 0x7f; n = 0; for (let i = 0; i < k; i++) n = (n << 8) | b[at + 2 + i]!; body = at + 2 + k; } return { tag: b[at]!, body, end: body + n }; };
  const outer = el(0); const version = el(outer.body); const imprint = el(version.end); const alg = el(imprint.body); const oid = el(alg.body); const digest = el(alg.end);
  return { outer: outer.tag, version: b[version.body], oid: b.subarray(oid.body, oid.end).toString('hex'), digest: b.subarray(digest.body, digest.end) };
}

test('anchoring: the chain head goes to the TSA as an RFC 3161 request, once per new head; a failing TSA never throws', async () => {
  const store = await Store.open();
  const room = await store.createRoom(Date.now(), 'bank', null);
  const session = (await store.createSession(room, 'human', null, Date.now()))!;
  const body = () => row({ id: crypto.randomUUID(), room, session, created: Date.now() }) as unknown as Omit<DecisionRow, 'prevHash' | 'hash'>;
  await appendDecision(store, body());
  await appendDecision(store, body());
  const seen: ReturnType<typeof readRequest>[] = [];
  let answer = Buffer.from('3005300302010' + '0', 'hex');   // TimeStampResp { PKIStatusInfo { granted } }
  const tsa = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c)).on('end', () => {
      assert.equal(req.headers['content-type'], 'application/timestamp-query');
      seen.push(readRequest(Buffer.concat(chunks)));
      res.writeHead(200, { 'Content-Type': 'application/timestamp-reply' }); res.end(answer);
    });
  });
  await new Promise<void>((r) => tsa.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(tsa.address() as AddressInfo).port}/tsr`;
  try {
    const head = (await store.chainHeads()).find((h) => h.room === room)!;
    assert.equal(head.seq, 2);
    assert.deepEqual(await anchorChains(store, { tsa: url }), [{ room, seq: 2, ok: true }]);
    assert.equal(seen[0]!.outer, 0x30); assert.equal(seen[0]!.version, 1);
    assert.equal(seen[0]!.oid, '608648016503040201', 'SHA-256');
    assert.deepEqual(seen[0]!.digest, headDigest(head.hash), 'the imprint is the chain head, nothing else');
    assert.deepEqual(await anchorChains(store, { tsa: url }), [], 'no new decisions: nothing sent');
    await appendDecision(store, body());
    answer = Buffer.from('3005300302010' + '2', 'hex');   // rejection
    const refused = await anchorChains(store, { tsa: url });
    assert.equal(refused[0]!.ok, false);
    assert.equal((await store.listAnchors()).length, 1, 'a refused timestamp is not stored');
    const down = await anchorChains(store, { tsa: 'http://127.0.0.1:9/tsr' });
    assert.equal(down[0]!.ok, false);
    const [a] = await store.listAnchors();
    assert.equal(a!.seq, 2);
    assert.equal(timestampStatus(Buffer.from(a!.response, 'base64')), 0);
  } finally { tsa.close(); }
});
