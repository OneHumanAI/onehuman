// SPDX-License-Identifier: BUSL-1.1
/** Decision proofs: what is signed, that it verifies, and every way a forgery fails. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proverFromSecret, verifyProof, sessionDigest, thumbprint, peekProof } from '../server/proof.ts';
import { Store } from '../server/db.ts';
import { sqliteClient } from '../server/sql.ts';
import { OneHuman } from '../server/engine.ts';
import { verifyChain } from '../server/audit.ts';
import type { Req } from '../server/http.ts';

const secret = Buffer.alloc(32, 7);
const row = {
  id: 'd-1', resource: 'report.export', decision: 'block' as const, computed: 'block' as const, enforced: true, actor: 'agent_likely' as const,
  score: 88, tiers: ['control' as const], reasonCodes: ['AGENT_CONTROL_MARKER'], policyVersion: 'p1', signalVersion: 'assess-v7', branch: 'agent' as const,
  room: 'r', session: 'sess-uuid', latencyMs: 1, dataDelivered: false, simulated: false, assessment: {} as never, created: 1790000000000, prevHash: 'genesis', hash: 'abc',
};

test('the same secret gives the same key on every instance; the key id is its RFC 7638 thumbprint', () => {
  const a = proverFromSecret(secret), b = proverFromSecret(Buffer.from(secret));
  assert.equal(a.jwk.x, b.jwk.x);
  assert.equal(a.jwk.kid, thumbprint(a.jwk.x));
  assert.notEqual(proverFromSecret(Buffer.alloc(32, 8)).jwk.x, a.jwk.x);
  assert.equal('d' in a.jwk, false);
});

test('a proof carries the decision and its audit position, never the raw session id', () => {
  const p = proverFromSecret(secret);
  const jws = p.sign(row, 42);
  const c = verifyProof(jws, [p.jwk]);
  assert.equal(c.valid, true);
  if (!c.valid) return;
  assert.equal(c.payload.jti, 'd-1');
  assert.equal(c.payload.decision, 'block');
  assert.equal(c.payload.delivered, false);
  assert.deepEqual(c.payload.audit, { seq: 42, hash: 'abc', prev: 'genesis' });
  assert.equal(c.payload.sub, sessionDigest('sess-uuid'));
  assert.equal(jws.includes(Buffer.from('sess-uuid').toString('base64url')), false);
  assert.equal(JSON.stringify(peekProof(jws)).includes('sess-uuid'), false);
});

test('forgeries fail: edited payload, swapped signature, wrong key, wrong type, garbage', () => {
  const p = proverFromSecret(secret), other = proverFromSecret(Buffer.alloc(32, 9));
  const jws = p.sign(row, 1);
  const [h, body, sig] = jws.split('.');
  const edited = JSON.parse(Buffer.from(body!, 'base64url').toString()); edited.delivered = true;
  assert.deepEqual(verifyProof(`${h}.${Buffer.from(JSON.stringify(edited)).toString('base64url')}.${sig}`, [p.jwk]), { valid: false, reason: 'bad_signature' });
  assert.deepEqual(verifyProof(`${h}.${body}.${other.sign(row, 1).split('.')[2]}`, [p.jwk]), { valid: false, reason: 'bad_signature' });
  assert.deepEqual(verifyProof(jws, [other.jwk]), { valid: false, reason: 'unknown_key' });
  // a key that claims another key's id is not trusted: the id is recomputed from the key itself
  assert.deepEqual(verifyProof(jws, [{ x: other.jwk.x, kid: p.jwk.kid }]), { valid: false, reason: 'unknown_key' });
  const wrongTyp = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: p.jwk.kid })).toString('base64url');
  assert.equal(verifyProof(`${wrongTyp}.${body}.${sig}`, [p.jwk]).valid, false);
  assert.deepEqual(verifyProof('not.a.proof', [p.jwk]), { valid: false, reason: 'malformed' });
});

test('the engine signs every decision in the same insert, and the hash chain still verifies', async () => {
  const store = await Store.open(await sqliteClient(':memory:'));
  const engine = new OneHuman({ store, secret });
  const room = await store.createRoom(Date.now(), 'bank');
  const session = (await store.getSession((await store.createSession(room, 'unlabelled', null))!))!;
  const req = { method: 'GET', url: '/api/v1/r/balance.read', headers: { host: 'localhost' }, socket: {} } as unknown as Req;
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await engine.decide({ room, session, resource: 'balance.read', request: req, snapshot: null });
    assert.ok(r.proof, 'decide() returns the proof');
    assert.equal(verifyProof(r.proof!, engine.proofKeys().keys).valid, true);
    assert.equal(await store.decisionProof(r.decision.id), r.proof, 'stored with the row');
    ids.push(r.decision.id);
  }
  assert.deepEqual((await verifyChain(store, room)), { ok: true, checked: 3, brokenAt: null }, 'the proof column is not part of the hashed body');
  const all = await store.sessionProofs(session.id);
  assert.deepEqual(all.map((x) => x.id), ids);
  const seqs = all.map((x) => { const c = verifyProof(x.proof, engine.proofKeys().keys); return c.valid ? c.payload.audit.seq : -1; });
  assert.deepEqual(seqs, [1, 2, 3], 'each proof names its place in the chain');
  store.close();
});

test('an existing database that predates proofs is migrated on open, not skipped', async () => {
  const client = await sqliteClient(':memory:');
  await Store.open(client);
  // simulate a database created before this release: the tables exist, the new column does not
  await client.execute('ALTER TABLE decisions DROP COLUMN proof');
  const cols = async (t: string) => (await client.execute(`SELECT name FROM pragma_table_info('${t}')`)).rows.map((r) => r.name);
  assert.equal((await cols('decisions')).includes('proof'), false);
  const store = await Store.open(client);
  assert.equal((await cols('decisions')).includes('proof'), true, 'decisions.proof added');
  store.close();
});
