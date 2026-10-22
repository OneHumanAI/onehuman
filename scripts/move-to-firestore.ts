// SPDX-License-Identifier: BUSL-1.1
/**
 * Move onehuman.ai's data from Turso (libSQL) to Cloud Firestore, and its password accounts to Firebase Authentication.
 *
 *   TURSO_DATABASE_URL=… TURSO_AUTH_TOKEN=… FIREBASE_PROJECT_ID=onehuman-ai GOOGLE_ACCESS_TOKEN=$(gcloud auth print-access-token) \
 *     node scripts/move-to-firestore.ts [--count] [--copy] [--new-only] [--auth] [--verify]
 *
 *   --count     how many rows each table holds, nothing written
 *   --copy      every row → its document (the same ids server/fire-store.ts uses); safe to repeat
 *   --new-only  with --copy: only documents that do not exist yet (the catch-up pass at the switch: newer Firestore
 *               writes are never overwritten by an older row)
 *   --auth      password accounts → Firebase Authentication with their scrypt hashes (the same password keeps working);
 *               the Firebase user id is the account id
 *   --verify    rows per table against documents per collection
 *
 * Rows become documents with the same column names and values. Short-lived rows that have already expired (sessions of
 * the portal, challenges, nonces, rate limits) are not copied.
 */
import { createHash } from 'node:crypto';
import { Firestore, type DocumentReference } from '@google-cloud/firestore';
import { OAuth2Client } from 'google-auth-library';
import { libsqlClient, type Row } from '../server/sql.ts';
import { docId, safe } from '../server/fire-store.ts';

const args = new Set(process.argv.slice(2));
const env = process.env;
const project = env.FIREBASE_PROJECT_ID ?? 'onehuman-ai';
if (!env.TURSO_DATABASE_URL || !env.GOOGLE_ACCESS_TOKEN) { console.error('TURSO_DATABASE_URL, TURSO_AUTH_TOKEN and GOOGLE_ACCESS_TOKEN are needed'); process.exit(2); }
const sql = await libsqlClient(env.TURSO_DATABASE_URL, env.TURSO_AUTH_TOKEN);
const authClient = new OAuth2Client();
authClient.setCredentials({ access_token: env.GOOGLE_ACCESS_TOKEN });
const db = new Firestore({ projectId: project, authClient, ignoreUndefinedProperties: true } as ConstructorParameters<typeof Firestore>[0]);
const now = Date.now();

/** table → how a row becomes a document (null: leave the row behind) */
type Plan = { id: (r: Row) => string; keep?: (r: Row) => boolean; extra?: (r: Row) => Record<string, unknown> };
const byId: Plan = { id: (r) => safe(String(r.id)) };
const byRowId: Plan = { id: (r) => String(r.id) };
const PLANS: Record<string, Plan> = {
  rooms: byId,
  sessions: byId,
  events: byRowId,
  decisions: { id: (r) => docId(String(r.id)) },
  anchors: { id: (r) => docId(String(r.room), Number(r.seq)) },
  policies: { id: (r) => docId(String(r.room), String(r.version)), extra: (r) => ({ n: Number(r._rowid) }) },
  nonces: { id: (r) => docId(String(r.key)), keep: (r) => Number(r.expires) > now },
  policy_cache: { id: (r) => docId(String(r.tag)) },
  stepups: { ...byId, keep: (r) => Number(r.expires) > now },
  credentials: { id: (r) => docId(String(r.id)) },
  challenges: { id: (r) => docId(String(r.id)), keep: (r) => Number(r.expires) > now },
  agent_access: { id: (r) => docId(String(r.scope), String(r.resource)) },
  portal_alerts: byRowId,
  accounts: { ...byId, extra: (r) => ({ firebase_uid: r.firebase_uid ?? null }) },
  portal_sessions: { ...byId, keep: (r) => Number(r.expires) > now },
  api_keys: byId,
  admin_keys: byId,
  telemetry: { id: (r) => (r.eid ? docId(String(r.key_id), String(r.eid)) : String(r.id)), extra: (r) => ({ agent: r.actor === 'agent_likely' || r.tools !== '[]' ? 1 : 0 }) },
  key_policies: { id: (r) => safe(String(r.key_id)) },
  policy_changes: byRowId,
  key_resources: { id: (r) => docId(String(r.key_id), String(r.resource)) },
  signature_bundles: { id: (r) => String(r.seq) },
  assist_log: { id: (r) => String(r._rowid) },
  samples: byRowId,
  training_sessions: byRowId,
  visits: byRowId,
  account_meta: { id: (r) => safe(String(r.account)) },
  email_log: { id: (r) => docId(String(r.account), String(r.kind), String(r.ref)) },
};

const tables = (await sql.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")).rows.map((r) => String(r.name));
const unknown = tables.filter((t) => !PLANS[t] && t !== 'rate_limits');
if (unknown.length) console.warn(`tables with no plan (not copied): ${unknown.join(', ')}`);

async function* rowsOf(table: string) {
  let after = -Infinity;
  for (;;) {
    const page = (await sql.execute(`SELECT rowid AS _rowid, * FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT 1000`, [after === -Infinity ? -1 : after])).rows;
    if (!page.length) return;
    yield page;
    after = Number(page[page.length - 1]!._rowid);
  }
}

if (args.has('--count')) {
  for (const t of tables) console.log(t.padEnd(20), (await sql.execute(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0]!.n);
}

const counts: Record<string, number> = {};
if (args.has('--copy')) {
  const newOnly = args.has('--new-only');
  const writer = db.bulkWriter();
  writer.onWriteError((e) => { if (newOnly && e.code === 6) return false; return e.failedAttempts < 5; });   // 6 = exists (new-only)
  const heads = new Map<string, { seq: number; hash: string }>();
  for (const t of tables) {
    const plan = PLANS[t];
    if (!plan) continue;
    let n = 0;
    for await (const page of rowsOf(t)) {
      for (const r of page) {
        if (plan.keep && !plan.keep(r)) continue;
        const { _rowid, ...cols } = r;
        const data = { ...cols, ...(plan.extra?.(r) ?? {}) };
        const ref: DocumentReference = db.collection(t).doc(plan.id(r));
        // new-only: a document that exists already holds the newer state (written by the site); keep it
        if (newOnly) writer.create(ref, data).catch((e) => { if (e.code !== 6) throw e; }); else void writer.set(ref, data);
        n++;
        if (t === 'decisions') {
          const seqRef = db.collection('decision_seq').doc(docId(String(r.room), Number(r.seq)));
          void writer.create(seqRef, { room: r.room, seq: Number(r.seq), id: r.id }).catch(() => {});   // an old duplicate (room, seq) keeps the first
          const h = heads.get(String(r.room));
          if (!h || Number(r.seq) > h.seq) heads.set(String(r.room), { seq: Number(r.seq), hash: String(r.hash) });
        }
        if (t === 'accounts') void writer.create(db.collection('account_emails').doc(docId(String(r.email))), { email: r.email, account: r.id }).catch(() => {});
      }
      process.stdout.write(`\r${t.padEnd(20)} ${n}`);
    }
    counts[t] = n;
    process.stdout.write(`\r${t.padEnd(20)} ${n}\n`);
  }
  for (const [room, h] of heads) void writer.set(db.collection('chain_heads').doc(docId(room)), { room, ...h });
  await writer.close();
  console.log('copied');
}

if (args.has('--auth')) {
  // Node's scryptSync defaults (N=16384, r=8, p=1), 32-byte keys; the salt is the hex text itself, as portal.ts hashes it
  const accounts = (await sql.execute("SELECT id, email, pass, created FROM accounts WHERE pass LIKE 'scrypt$%'")).rows;
  const users = accounts.map((a) => {
    const [, salt, hash] = String(a.pass).split('$');
    return { localId: String(a.id), email: String(a.email), emailVerified: false, passwordHash: Buffer.from(hash!, 'hex').toString('base64url'), salt: Buffer.from(salt!, 'utf8').toString('base64url'), createdAt: String(a.created) };
  });
  for (let i = 0; i < users.length; i += 500) {
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${project}/accounts:batchCreate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.GOOGLE_ACCESS_TOKEN}`, 'x-goog-user-project': project, 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashAlgorithm: 'STANDARD_SCRYPT', cpuMemCost: 16384, blockSize: 8, parallelization: 1, dkLen: 32, users: users.slice(i, i + 500), allowOverwrite: false }),
    });
    const body = (await r.json()) as { error?: { message: string }; error_?: unknown; errors?: unknown };
    if (!r.ok) throw new Error(`auth import: ${r.status} ${JSON.stringify(body).slice(0, 300)}`);
    console.log(`auth: ${Math.min(i + 500, users.length)} of ${users.length} accounts imported`, (body as { error?: unknown[] }).error ?? '');
  }
}

if (args.has('--verify')) {
  let bad = 0;
  for (const t of tables) {
    const plan = PLANS[t];
    if (!plan) continue;
    let rowsN = 0;
    for await (const page of rowsOf(t)) rowsN += page.filter((r) => !plan.keep || plan.keep(r)).length;
    const docs = (await db.collection(t).count().get()).data().count;
    const ok = docs >= rowsN;
    if (!ok) bad++;
    console.log(`${ok ? '✓' : '✗'} ${t.padEnd(20)} rows ${String(rowsN).padStart(7)}  documents ${String(docs).padStart(7)}`);
  }
  // a sample of documents must equal their rows, column by column
  for (const t of ['accounts', 'api_keys', 'telemetry', 'decisions', 'account_meta']) {
    const plan = PLANS[t];
    if (!plan || !tables.includes(t)) continue;
    const sample = (await sql.execute(`SELECT rowid AS _rowid, * FROM ${t} ORDER BY RANDOM() LIMIT 25`)).rows;
    for (const r of sample) {
      const d = await db.collection(t).doc(plan.id(r)).get();
      const { _rowid, ...cols } = r;
      const same = d.exists && Object.entries(cols).every(([k, v]) => (d.get(k) ?? null) === (v ?? null) || Number(d.get(k)) === Number(v));
      if (!same) { bad++; console.log(`✗ ${t} ${createHash('sha256').update(String(r.id ?? r.account ?? r._rowid)).digest('hex').slice(0, 8)} differs`); }
    }
  }
  console.log(bad ? `\n${bad} problems` : '\nevery table and every sampled row matches');
  if (bad) process.exitCode = 1;
}
sql.close();
await db.terminate();
