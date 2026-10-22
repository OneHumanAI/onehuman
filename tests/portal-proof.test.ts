// SPDX-License-Identifier: BUSL-1.1
/** The portal's side of decision proofs: what it accepts from a reporting middleware, and its own tables' migrations. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proverFromSecret } from '../server/proof.ts';
import { SiteStore } from '../server/site-db.ts';
import { sqliteClient } from '../server/sql.ts';
import { parseEvent, parseProofKeys } from '../server/routes/portal.ts';

const secret = Buffer.alloc(32, 7);
const row = {
  id: 'd-1', resource: 'report.export', decision: 'block' as const, computed: 'block' as const, enforced: true, actor: 'agent_likely' as const,
  score: 88, tiers: ['control' as const], reasonCodes: ['AGENT_CONTROL_MARKER'], policyVersion: 'p1', signalVersion: 'assess-v7', branch: 'agent' as const,
  room: 'r', session: 'sess-uuid', latencyMs: 1, dataDelivered: false, simulated: false, assessment: {} as never, created: 1790000000000, prevHash: 'genesis', hash: 'abc',
};

test('portal ingest: keys are recomputed, never trusted; a proof must belong to its event', () => {
  const p = proverFromSecret(secret);
  assert.equal(parseProofKeys([{ ...p.jwk, kid: 'lies' }])[0]!.kid, p.jwk.kid);
  assert.equal(parseProofKeys([{ ...p.jwk, d: 'secret' }]).length, 0, 'a private key is refused');
  assert.equal(parseProofKeys([{ kty: 'RSA', n: 'x' }]).length, 0);
  const ev = parseEvent({ session: 'abcdef0123456789', resource: 'report.export', decision: 'block', actor: 'agent_likely', proof: p.sign(row, 1) }, Date.now());
  assert.ok(ev?.proof);
  assert.equal(parseEvent({ session: 'abcdef0123456789', resource: 'r.x', decision: 'allow', proof: '<script>' }, Date.now())!.proof, null);
});

test('a portal database that predates the newest telemetry column is migrated on open, not skipped', async () => {
  const client = await sqliteClient(':memory:');
  await SiteStore.open(client);
  // simulate a database created before this release: the tables exist, the new columns do not
  await client.execute('ALTER TABLE decisions DROP COLUMN proof');
  await client.execute('ALTER TABLE telemetry DROP COLUMN computed');
  const cols = async (t: string) => (await client.execute(`SELECT name FROM pragma_table_info('${t}')`)).rows.map((r) => r.name);
  assert.equal((await cols('decisions')).includes('proof'), false);
  const store = await SiteStore.open(client);
  assert.equal((await cols('decisions')).includes('proof'), true, 'decisions.proof added');
  assert.equal((await cols('telemetry')).includes('computed'), true, 'telemetry.computed added');
  store.close();
});
