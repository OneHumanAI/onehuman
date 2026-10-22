// SPDX-License-Identifier: BUSL-1.1
/**
 * The website's storage on Cloud Firestore (onehuman.ai in production). Same methods and the same results as the SQL
 * stores (db.ts, site-db.ts), which stay for local runs, the tests and the npm package.
 *
 * Every SQL table is a collection with the same column names and value types, so a row and a document look alike: the
 * move from Turso copies rows as they are, and nothing else needs a mapping. Writes and look-ups are native Firestore.
 * The figures (counts, distinct sessions, buckets, top lists) load the documents in range into an in-memory SQLite and
 * run the SQL stores' own queries on them: one implementation of every number, whichever database holds the rows.
 *
 * Any method this file does not implement reaches the SQL client below, which throws with the statement it was given:
 * a missed method fails loudly in the tests instead of reading nothing.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { CollectionReference, DocumentData, DocumentSnapshot, Firestore, Query, Transaction, WriteBatch } from '@google-cloud/firestore';
import { ROOM_TTL_MS, VISIT_IDLE_MS, SERVER_LIMITS, safeList, stepUpRow, type AgentAccess, type ChallengeKind, type DecisionRow, type EventRow, type SessionRow, type StoreLimits, Store } from './db.ts';
import { LAB_LIMITS, SiteStore, billingRow, chatRow, chatMessageRow, connectRow, repoScanRow, type RepoScanRow, type BillingPatch, type LedgerRow, type UsageCounts, type ChatMessageRow, type ChatPatch, type ChatRow, type AccountMeta, type ApiKeyRow, type KeyInviteRow, type ConnectRow, type KeyRole, type SharedKeyRow, type KeyPolicyRow, type PolicyChangeRow, type TelemetryEvent, type TelemetryHealth, type TelemetryOverview, type TelemetryStats, type TelemetryApps, type TelemetryWeek } from './site-db.ts';
import { sqliteClient, type Row, type SqlArg, type SqlClient } from './sql.ts';
import { docId, safe } from './doc-ids.ts';
import type { Policy } from './policy.ts';
import type { ClientSnapshot, ServerSignal } from './signals.ts';

/** in place of SQL: any statement that still reaches it names itself */
const NO_SQL: SqlClient = {
  async execute(sql) { throw new Error(`fire-store: not implemented on Firestore: ${sql.replace(/\s+/g, ' ').slice(0, 120)}`); },
  async batch(stmts) { throw new Error(`fire-store: not implemented on Firestore: ${stmts[0]?.sql.replace(/\s+/g, ' ').slice(0, 120)}`); },
  async executeMultiple() { throw new Error('fire-store: no schema on Firestore'); },
  close() { /* nothing to close */ },
};

export { docId, safe };

/** numeric row ids (SQL's AUTOINCREMENT): time-ordered, newer than any row copied from SQL, unique enough to address */
let lastId = 0;
export function newRowId(now = Date.now()): number {
  lastId = Math.max(lastId + 1, now * 4096 + Math.floor(Math.random() * 4096));
  return lastId;
}

const ALREADY_EXISTS = 6, NOT_FOUND = 5;
const code = (e: unknown) => (e as { code?: number })?.code;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const rows = (q: { docs: DocumentSnapshot[] }) => q.docs.map((d) => d.data() as Row);
const n = (v: unknown) => (v == null ? null : Number(v));
/** an agent in a telemetry row, as SiteStore's AGENT_ROW: kept on the document so "the first agent" is one query */
const agentRow = (actor: string, tools: string) => (actor === 'agent_likely' || tools !== '[]' ? 1 : 0);

/** Firestore writes at most 500 operations per batch */
async function inBatches<T>(db: Firestore, items: T[], each: (b: WriteBatch, x: T) => void, size = 400) {
  for (let i = 0; i < items.length; i += size) {
    const b = db.batch();
    for (const x of items.slice(i, i + size)) each(b, x);
    await b.commit();
  }
}
async function deleteAll(db: Firestore, q: Query, max = 20_000): Promise<number> {
  let gone = 0;
  for (;;) {
    const page = await q.limit(400).get();
    if (page.empty) return gone;
    const b = db.batch();
    page.docs.forEach((d) => b.delete(d.ref));
    await b.commit();
    gone += page.size;
    if (page.size < 400 || gone >= max) return gone;
  }
}

function sessionRow(r: Row): SessionRow {
  return {
    id: String(r.id), room: String(r.room), label: r.label as SessionRow['label'], scenario: (r.scenario as string | null) ?? '', created: Number(r.created),
    arrival: r.arrival ? (JSON.parse(String(r.arrival)) as ServerSignal) : null,
    firstDataAt: n(r.first_data_at), firstAgentAt: n(r.first_agent_at), agentAttachedAt: n(r.agent_attached_at),
    agentAttachedClientMs: n(r.agent_attached_client_ms), humanVerifiedAt: n(r.human_verified_at), lastSeen: Number(r.last_seen),
  };
}
function decisionRow(r: Row): DecisionRow & { seq: number } {
  return {
    ...(JSON.parse(String(r.body)) as Omit<DecisionRow, 'room' | 'session' | 'created' | 'prevHash' | 'hash'>),
    room: String(r.room), session: String(r.session), seq: Number(r.seq), created: Number(r.created), prevHash: String(r.prev_hash), hash: String(r.hash),
  };
}
const metaRow = (x: Row): AccountMeta => ({ account: String(x.account), started: Number(x.started), legacy: !!Number(x.legacy), source: x.source == null ? null : String(x.source), connectedAt: n(x.connected_at), firstAgentAt: n(x.first_agent_at), emailOff: !!Number(x.email_off) });
const apiKeyRow = (x: Row): ApiKeyRow => ({ id: String(x.id), name: String(x.name), prefix: String(x.prefix), created: Number(x.created), revoked: n(x.revoked), lastSeen: n(x.last_seen), events: Number(x.events ?? 0), expires: n(x.expires), env: String(x.env ?? 'production') });

/** time column of each table, for loading only what a report covers */
const TIME: Record<string, string> = { visits: 'at', telemetry: 'at', decisions: 'created', sessions: 'created', samples: 'created', assist_log: 'at', events: 'created', email_log: 'at' };

export class FireSiteStore extends SiteStore {
  readonly db: Firestore;
  /** collection name prefix: '' in production; the tests give every store its own */
  readonly prefix: string;
  private counters = { rooms: 0, events: 0, roomTrim: 0, challenges: 0 };

  protected constructor(db: Firestore, prefix: string, limits: StoreLimits) {
    super(NO_SQL, limits);
    this.db = db; this.prefix = prefix;
  }
  /** the site's store on a Firestore database */
  static connect(db: Firestore, opts: { prefix?: string; limits?: StoreLimits } = {}): FireSiteStore {
    return new FireSiteStore(db, opts.prefix ?? '', opts.limits ?? LAB_LIMITS);
  }
  /** the same database with other caps (the portal's own protection keeps every session, like a customer's server) */
  withLimits(limits: StoreLimits): FireSiteStore { return new FireSiteStore(this.db, this.prefix, limits); }

  private c(table: string): CollectionReference { return this.db.collection(this.prefix + table); }
  override close() { /* the Firestore client is shared by every store on it */ }
  override async exec(sqlText: string): Promise<never> { throw new Error(`fire-store: raw SQL is not available on Firestore: ${sqlText.slice(0, 80)}`); }

  /** an in-memory SQLite holding these rows, for the SQL store's own report queries */
  private async scratch(tables: Record<string, Row[]>): Promise<SiteStore> {
    const mem = await SiteStore.open(await sqliteClient(':memory:'));
    // a report loads part of a table (the range it covers): a session whose room is older than the range still counts
    await mem.sql.execute('PRAGMA foreign_keys = OFF');
    for (const [table, list] of Object.entries(tables)) {
      if (!list.length) continue;
      const cols = new Set((await mem.sql.execute(`SELECT name FROM pragma_table_info('${table}')`)).rows.map((r) => String(r.name)));
      const stmts = list.map((r) => {
        const keys = Object.keys(r).filter((k) => cols.has(k));
        return { sql: `INSERT OR IGNORE INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, args: keys.map((k) => r[k]) as SqlArg[] };
      });
      for (let i = 0; i < stmts.length; i += 2000) await mem.sql.batch(stmts.slice(i, i + 2000));
    }
    return mem;
  }
  private async onScratch<T>(tables: Record<string, Row[]>, run: (mem: SiteStore) => Promise<T>): Promise<T> {
    const mem = await this.scratch(tables);
    try { return await run(mem); } finally { mem.close(); }
  }
  /** one key's telemetry from `from` (to `to`), as rows */
  private async telemetryRows(keyId: string, from: number, to?: number): Promise<Row[]> {
    let q: Query = this.c('telemetry').where('key_id', '==', keyId).where('at', '>=', from);
    if (to != null) q = q.where('at', '<', to);
    return rows(await q.orderBy('at').get());
  }

  // =============================================================================================== engine: rooms
  override async createRoom(now = Date.now(), app = 'bank', device: string | null = null): Promise<string> {
    const id = randomUUID();
    if (++this.counters.rooms % 50 === 1) await this.pruneRooms(now - ROOM_TTL_MS).catch((e) => console.warn('fire-store: room prune failed', e));
    await this.c('rooms').doc(safe(id)).set({ id, created: now, app, device });
    return id;
  }
  /** expired short-lived rooms go, children first */
  private async pruneRooms(cut: number) {
    const old = (await this.c('rooms').where('created', '<', cut).orderBy('created').limit(20).get()).docs.filter((d) => !String(d.get('app')).startsWith('tenant:'));
    for (const d of old) {
      const room = d.id;
      for (const s of (await this.c('sessions').where('room', '==', room).select().get()).docs) {
        for (const t of ['challenges', 'stepups']) await deleteAll(this.db, this.c(t).where('session', '==', s.id));
      }
      for (const t of ['events', 'decisions', 'credentials', 'policies', 'sessions', 'anchors']) await deleteAll(this.db, this.c(t).where('room', '==', room));
      await deleteAll(this.db, this.c('decision_seq').where('room', '==', room));
      await this.c('chain_heads').doc(docId(room)).delete();
      await d.ref.delete();
    }
  }
  override async roomExists(id: string, now = Date.now()): Promise<boolean> {
    const r = await this.c('rooms').doc(safe(id)).get();
    return r.exists && (Number(r.get('created')) > now - ROOM_TTL_MS || String(r.get('app')).startsWith('tenant:'));
  }
  override async ensureRoom(id: string, app: string, now = Date.now()): Promise<void> {
    await this.c('rooms').doc(safe(id)).create({ id, created: now, app, device: null }).catch((e) => { if (code(e) !== ALREADY_EXISTS) throw e; });
  }
  override async countSessionsSince(since: number): Promise<number> {
    return (await this.c('sessions').where('created', '>=', since).count().get()).data().count;
  }
  override async roomApp(id: string): Promise<string | null> {
    const r = await this.c('rooms').doc(safe(id)).get();
    return r.exists ? String(r.get('app')) : null;
  }
  override async roomsByDevice(device: string, since: number): Promise<number> {
    return (await this.c('rooms').where('device', '==', device).where('created', '>=', since).count().get()).data().count;
  }

  // =============================================================================================== engine: sessions
  override async createSession(room: string, label: SessionRow['label'], arrival: ServerSignal | null, now = Date.now(), scenario = ''): Promise<string | null> {
    if (this.limits.sessionsPerRoom !== null) {
      const have = (await this.c('sessions').where('room', '==', room).count().get()).data().count;
      if (have >= this.limits.sessionsPerRoom) return null;
    }
    const id = randomUUID();
    await this.c('sessions').doc(safe(id)).set(this.newSession(id, room, label, scenario, arrival, now));
    if (arrival) await this.addEvent(room, id, 'arrival', arrival, now);
    return id;
  }
  private newSession(id: string, room: string, label: string, scenario: string, arrival: ServerSignal | null, now: number) {
    return { id, room, label, scenario, created: now, arrival: arrival ? JSON.stringify(arrival) : null, first_data_at: null, first_agent_at: null, agent_attached_at: null, agent_attached_client_ms: null, human_verified_at: null, last_seen: now };
  }
  override async ensureSession(id: string, room: string, arrival: ServerSignal | null, now = Date.now()): Promise<SessionRow> {
    const existing = await this.getSession(id);
    if (existing) return existing;
    const created = await this.c('sessions').doc(safe(id)).create(this.newSession(id, room, 'unlabelled', '', arrival, now)).then(() => true, (e) => { if (code(e) !== ALREADY_EXISTS) throw e; return false; });
    if (created && arrival) await this.addEvent(room, id, 'arrival', arrival, now);
    return (await this.getSession(id))!;
  }
  override async getSession(id: string): Promise<SessionRow | null> {
    const r = await this.c('sessions').doc(safe(id)).get();
    return r.exists ? sessionRow(r.data() as Row) : null;
  }
  override async listSessions(room: string): Promise<SessionRow[]> {
    return rows(await this.c('sessions').where('room', '==', room).orderBy('created').get()).map(sessionRow);
  }
  override async touchSession(id: string, now = Date.now()) {
    const ref = this.c('sessions').doc(safe(id));
    const r = await ref.get();
    if (!r.exists) return;
    const idle = now - Number(r.get('last_seen')) > VISIT_IDLE_MS;
    await ref.update(idle ? { agent_attached_at: null, agent_attached_client_ms: null, last_seen: now } : { last_seen: now });
  }
  /** set a column once (COALESCE semantics); true when this call set it */
  private async setOnce(table: string, id: string, fields: Record<string, unknown>, unlessSet: string): Promise<boolean> {
    const ref = this.c(table).doc(safe(id));
    return this.db.runTransaction(async (tx: Transaction) => {
      const r = await tx.get(ref);
      if (!r.exists || r.get(unlessSet) != null) return false;
      tx.update(ref, fields);
      return true;
    });
  }
  override async markFirstData(id: string, now: number) { await this.setOnce('sessions', id, { first_data_at: now }, 'first_data_at'); }
  override async markFirstAgent(id: string, now: number) { await this.setOnce('sessions', id, { first_agent_at: now }, 'first_agent_at'); }
  override async markAgentAttached(id: string, now: number, clientMs: number | null): Promise<boolean> {
    return this.setOnce('sessions', id, { agent_attached_at: now, agent_attached_client_ms: clientMs }, 'agent_attached_at');
  }
  override async carryOverEvidence(from: string, to: string, now = Date.now(), windowMs = VISIT_IDLE_MS): Promise<boolean> {
    if (from === to) return false;
    const src = await this.getSession(from);
    const dst = await this.getSession(to);
    if (!src || !dst || src.room !== dst.room) return false;
    const newest = async (s: string) => rows(await this.c('events').where('session', '==', s).where('kind', '==', 'signal').orderBy('id', 'desc').limit(1).get())[0];
    const a = await newest(from);
    const b = await newest(to);
    let moved = false;
    if (a && Number(a.created) > now - windowMs && (!b || Number(a.created) > Number(b.created))) {
      await this.addEvent(dst.room, to, 'signal', JSON.parse(String(a.payload)), Number(a.created));
      moved = true;
    }
    if (src.agentAttachedAt != null && now - src.agentAttachedAt <= windowMs) {
      if (await this.markAgentAttached(to, src.agentAttachedAt, src.agentAttachedClientMs)) { await this.markFirstAgent(to, src.agentAttachedAt); moved = true; }
    }
    return moved;
  }
  override async markHumanVerified(session: string, now = Date.now()) {
    await this.c('sessions').doc(safe(session)).update({ human_verified_at: now }).catch((e) => { if (code(e) !== NOT_FOUND) throw e; });
  }

  // =============================================================================================== engine: events
  override async addEvent(room: string, session: string, kind: EventRow['kind'], payload: unknown, now = Date.now()): Promise<number> {
    const id = newRowId(now);
    await this.c('events').add({ id, room, session, kind, payload: JSON.stringify(payload), created: now });
    const L = this.limits;
    if (L.eventsPerRoom !== null && ++this.counters.roomTrim % 20 === 1) await this.trim(this.c('events').where('room', '==', room), L.eventsPerRoom);
    // per session: a count is one read per thousand events, so every insert checks it, like SQL
    if (L.eventsPerSession !== null) await this.trim(this.c('events').where('session', '==', session), L.eventsPerSession);
    if (L.eventMaxAgeMs !== null && ++this.counters.events % 500 === 1) await deleteAll(this.db, this.c('events').where('created', '<', now - L.eventMaxAgeMs), 2000);
    return id;
  }
  /** keep the newest `keep` documents of a query (ordered by id) */
  private async trim(q: Query, keep: number) {
    const have = (await q.count().get()).data().count;
    if (have <= keep) return;
    const old = await q.orderBy('id', 'desc').offset(keep).limit(Math.min(400, have - keep)).select().get();
    await inBatches(this.db, old.docs, (b, d) => b.delete(d.ref));
  }
  override async hasEvent(session: string, kind: EventRow['kind']): Promise<boolean> {
    return !(await this.c('events').where('session', '==', session).where('kind', '==', kind).limit(1).select().get()).empty;
  }
  override async recentSignals(session: string, now = Date.now(), windowMs = 120000, limit = 5): Promise<{ early: ClientSnapshot['early']; interactions: NonNullable<ClientSnapshot['interaction']>[] }> {
    const list = rows(await this.c('events').where('session', '==', session).where('kind', 'in', ['signal', 'interaction']).orderBy('id', 'desc').limit(60).get())
      .filter((r) => Number(r.created) > now - windowMs);
    let early: ClientSnapshot['early'] = null;
    const interactions: NonNullable<ClientSnapshot['interaction']>[] = [];
    for (const r of list) {
      const p = JSON.parse(String(r.payload));
      if (r.kind === 'signal' && !early) early = p;
      if (r.kind === 'interaction' && interactions.length < limit) interactions.push(p);
    }
    if (!early) {
      const last = rows(await this.c('events').where('session', '==', session).where('kind', '==', 'signal').orderBy('id', 'desc').limit(1).get())[0];
      if (last) early = JSON.parse(String(last.payload));
    }
    return { early, interactions: interactions.reverse() };
  }
  override async listEvents(room: string, limit = 200): Promise<EventRow[]> {
    return rows(await this.c('events').where('room', '==', room).orderBy('id', 'desc').limit(limit).get()).map((r) => ({
      id: Number(r.id), room: String(r.room), session: String(r.session), kind: r.kind as EventRow['kind'], payload: JSON.parse(String(r.payload)), created: Number(r.created),
    }));
  }

  // =============================================================================================== engine: the audit chain
  override async lastDecision(room: string): Promise<{ seq: number; hash: string }> {
    const r = rows(await this.c('decisions').where('room', '==', room).orderBy('seq', 'desc').limit(1).get())[0];
    return r ? { seq: Number(r.seq), hash: String(r.hash) } : { seq: 0, hash: 'genesis' };
  }
  override async chainHeads(): Promise<{ room: string; seq: number; hash: string }[]> {
    return rows(await this.c('chain_heads').get()).map((x) => ({ room: String(x.room), seq: Number(x.seq), hash: String(x.hash) }));
  }
  override async lastAnchor(room: string): Promise<{ seq: number; created: number } | null> {
    const r = rows(await this.c('anchors').where('room', '==', room).orderBy('seq', 'desc').limit(1).get())[0];
    return r ? { seq: Number(r.seq), created: Number(r.created) } : null;
  }
  override async addAnchor(a: { room: string; seq: number; hash: string; tsa: string; request: string; response: string; created: number }) {
    await this.c('anchors').doc(docId(a.room, a.seq)).create(a).catch((e) => { if (code(e) !== ALREADY_EXISTS) throw e; });
  }
  override async listAnchors(limit = 1000) {
    return rows(await this.c('anchors').orderBy('created', 'desc').limit(limit).get()).map((x) => ({ room: String(x.room), seq: Number(x.seq), hash: String(x.hash), tsa: String(x.tsa), request: String(x.request), response: String(x.response), created: Number(x.created) }));
  }
  /** (room, seq) is unique: a second writer of the same position fails like SQL's unique index, and audit.ts retries */
  override async insertDecision(row: DecisionRow, seq: number, proof: string | null = null) {
    const { room, session, created, prevHash, hash, ...body } = row;
    const b = this.db.batch();
    b.create(this.c('decision_seq').doc(docId(room, seq)), { room, seq, id: row.id });
    b.set(this.c('decisions').doc(docId(row.id)), { id: row.id, room, session, seq, body: JSON.stringify(body), created, prev_hash: prevHash, hash, proof });
    b.set(this.c('chain_heads').doc(docId(room)), { room, seq, hash });
    try { await b.commit(); } catch (e) {
      if (code(e) === ALREADY_EXISTS) throw new Error('UNIQUE constraint failed: decisions.room, decisions.seq');
      throw e;
    }
  }
  override async decisionProof(id: string): Promise<string | null> {
    const r = await this.c('decisions').doc(docId(id)).get();
    const p = r.exists ? r.get('proof') : null;
    return typeof p === 'string' ? p : null;
  }
  override async sessionProofs(session: string, limit = 5000): Promise<{ id: string; seq: number; proof: string }[]> {
    return rows(await this.c('decisions').where('session', '==', session).orderBy('created').orderBy('seq').get())
      .filter((x) => typeof x.proof === 'string').slice(0, limit).map((x) => ({ id: String(x.id), seq: Number(x.seq), proof: String(x.proof) }));
  }
  override async decisionsBetween(from: number, to: number, room: string | null = null) {
    let q: Query = this.c('decisions').where('created', '>=', from).where('created', '<', to);
    if (room) q = q.where('room', '==', room);
    const out = [];
    for (const r of rows(await q.orderBy('created').get())) {
      const b = JSON.parse(String(r.body)) as Record<string, unknown>;
      if (b.simulated) continue;
      out.push({
        session: String(r.session), created: Number(r.created), resource: String(b.resource ?? ''), decision: String(b.decision ?? 'allow'),
        computed: String(b.computed ?? b.decision ?? 'allow'), actor: String(b.actor ?? 'unknown'), enforced: b.enforced === true || Number(b.enforced) === 1,
        branch: String(b.branch ?? ''), tools: Array.isArray(b.tools) ? b.tools.map(String) : [], signed: typeof r.proof === 'string', policyVersion: String(b.policyVersion ?? ''),
      });
    }
    return out;
  }
  override async attachToolsBetween(from: number, to: number): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    for (const r of rows(await this.c('events').where('kind', '==', 'attach').where('created', '>=', from).where('created', '<', to).get())) {
      let tools: string[] = [];
      try { const p = JSON.parse(String(r.payload)) as { tools?: unknown }; tools = Array.isArray(p.tools) ? p.tools.map(String) : []; } catch { /* ignore */ }
      out.set(String(r.session), [...new Set([...(out.get(String(r.session)) ?? []), ...tools])]);
    }
    return out;
  }
  override async listDecisions(room: string, limit = 300): Promise<(DecisionRow & { seq: number })[]> {
    return rows(await this.c('decisions').where('room', '==', room).orderBy('seq', 'desc').limit(limit).get()).map(decisionRow);
  }
  override async getDecision(id: string): Promise<(DecisionRow & { seq: number }) | null> {
    const r = await this.c('decisions').doc(docId(id)).get();
    return r.exists ? decisionRow(r.data() as Row) : null;
  }

  // =============================================================================================== engine: policies
  override async savePolicy(room: string, policy: Policy, now = Date.now()) {
    try { await this.c('policies').doc(docId(room, policy.version)).create({ room, version: policy.version, body: JSON.stringify(policy), created: now, n: newRowId(now) }); }
    catch (e) { if (code(e) === ALREADY_EXISTS) throw new Error('UNIQUE constraint failed: policies.room, policies.version'); throw e; }
  }
  override async currentPolicy(room: string): Promise<Policy | null> {
    const r = rows(await this.c('policies').where('room', '==', room).orderBy('created', 'desc').orderBy('n', 'desc').limit(1).get())[0];
    return r ? (JSON.parse(String(r.body)) as Policy) : null;
  }
  override async policyHistory(room: string) {
    return rows(await this.c('policies').where('room', '==', room).orderBy('created', 'desc').orderBy('n', 'desc').limit(50).get())
      .map((r) => ({ version: String(r.version), created: Number(r.created), enforcement: (JSON.parse(String(r.body)) as Policy).enforcement }));
  }
  override async policyCache(tag: string) {
    const r = await this.c('policy_cache').doc(docId(tag)).get();
    if (!r.exists) return null;
    const x = r.data() as Row;
    return { envelope: String(x.envelope), pinnedKey: String(x.pinned_key), fetched: Number(x.fetched), pushedFileHash: x.pushed_file_hash == null ? null : String(x.pushed_file_hash) };
  }
  override async putPolicyCache(tag: string, c: { envelope: string; pinnedKey: string; fetched: number }) {
    await this.c('policy_cache').doc(docId(tag)).set({ tag, envelope: c.envelope, pinned_key: c.pinnedKey, fetched: c.fetched }, { merge: true });
  }
  override async setPolicyCachePushed(tag: string, fileHash: string, pinnedKey: string) {
    const ref = this.c('policy_cache').doc(docId(tag));
    await this.db.runTransaction(async (tx) => {
      const r = await tx.get(ref);
      if (r.exists) tx.update(ref, { pushed_file_hash: fileHash });
      else tx.set(ref, { tag, envelope: '', pinned_key: pinnedKey, fetched: 0, pushed_file_hash: fileHash });
    });
  }

  // =============================================================================================== engine: nonces, passkeys, challenges
  override async consumeNonce(key: string, ttlMs: number, now = Date.now()): Promise<boolean> {
    const ref = this.c('nonces').doc(docId(key));
    return this.db.runTransaction(async (tx) => {
      const r = await tx.get(ref);
      if (r.exists && Number(r.get('expires')) >= now) return false;
      tx.set(ref, { key: key.slice(0, 200), expires: now + ttlMs });
      return true;
    });
  }
  override async saveCredential(room: string, session: string, cred: { id: string }, now = Date.now()) {
    await this.c('credentials').doc(docId(cred.id)).set({ id: cred.id, room, session, body: JSON.stringify(cred), created: now });
  }
  override async credentialsForRoom<T>(room: string): Promise<T[]> {
    return rows(await this.c('credentials').where('room', '==', room).orderBy('created', 'desc').get()).map((r) => JSON.parse(String(r.body)) as T);
  }
  override async credentialsForSession<T>(session: string): Promise<T[]> {
    return rows(await this.c('credentials').where('session', '==', session).orderBy('created', 'desc').get()).map((r) => JSON.parse(String(r.body)) as T);
  }
  override async getCredential<T>(id: string): Promise<T | null> {
    const r = await this.c('credentials').doc(docId(id)).get();
    return r.exists ? (JSON.parse(String(r.get('body'))) as T) : null;
  }
  override async credentialOwner(id: string): Promise<{ room: string; session: string } | null> {
    const r = await this.c('credentials').doc(docId(id)).get();
    return r.exists ? { room: String(r.get('room')), session: String(r.get('session')) } : null;
  }
  override async updateCredential(cred: { id: string }) {
    await this.c('credentials').doc(docId(cred.id)).update({ body: JSON.stringify(cred) }).catch((e) => { if (code(e) !== NOT_FOUND) throw e; });
  }
  override async createChallenge(id: string, session: string, kind: ChallengeKind, resource: string | null, ttlMs: number, now = Date.now()) {
    if (++this.counters.challenges % 50 === 1) await deleteAll(this.db, this.c('challenges').where('expires', '<', now), 2000).catch(() => {});
    await this.c('challenges').doc(docId(id)).set({ id, session, kind, resource, expires: now + ttlMs });
  }
  override async consumeChallenge(id: string, session: string, kind: ChallengeKind | readonly ChallengeKind[], now = Date.now()): Promise<{ resource: string | null; kind: string } | null> {
    const kinds: string[] = typeof kind === 'string' ? [kind] : [...kind];
    const ref = this.c('challenges').doc(docId(id));
    const r = await this.db.runTransaction(async (tx) => {
      const d = await tx.get(ref);
      if (d.exists) tx.delete(ref);
      return d.exists ? (d.data() as Row) : null;
    });
    if (!r || r.session !== session || !kinds.includes(String(r.kind)) || Number(r.expires) < now) return null;
    return { resource: r.resource == null ? null : String(r.resource), kind: String(r.kind) };
  }

  // =============================================================================================== engine: the owner's choices, step-up
  override async agentAccess(scope: string, now = Date.now()): Promise<AgentAccess[]> {
    return rows(await this.c('agent_access').where('scope', '==', scope).orderBy('created', 'desc').get())
      .filter((x) => x.until == null || Number(x.until) > now)
      .map((x) => ({ resource: String(x.resource), choice: String(x.choice) as AgentAccess['choice'], until: n(x.until), by: String(x.by_whom), created: Number(x.created) }));
  }
  override async agentAccessFor(scope: string, resource: string, now = Date.now()): Promise<AgentAccess | null> {
    const r = await this.c('agent_access').doc(docId(scope, resource)).get();
    if (!r.exists) return null;
    const x = r.data() as Row;
    if (x.until != null && Number(x.until) <= now) return null;
    return { resource: String(x.resource), choice: String(x.choice) as AgentAccess['choice'], until: n(x.until), by: String(x.by_whom), created: Number(x.created) };
  }
  override async setAgentAccess(scope: string, resource: string, choice: AgentAccess['choice'] | null, until: number | null, by: string, now = Date.now()) {
    const ref = this.c('agent_access').doc(docId(scope, resource));
    if (choice === null) { await ref.delete(); return; }
    await ref.set({ scope, resource, choice, until, by_whom: by, created: now });
  }
  override async grantStepUp(session: string, resource: string, ttlMs: number, now = Date.now()) {
    const id = randomUUID();
    await this.c('stepups').doc(safe(id)).set({ id, session, resource, challenge: 'webauthn', expires: now + ttlMs, passed: 1 });
  }
  override async createStepUp(session: string, resource: string, challenge: string, ttlMs: number, now = Date.now(), bind: { digest?: string | null; summary?: string | null } = {}): Promise<string> {
    const id = randomUUID();
    await this.c('stepups').doc(safe(id)).set({ id, session, resource, challenge, expires: now + ttlMs, passed: 0, digest: bind.digest ?? null, summary: bind.summary ?? null });
    return id;
  }
  override async getStepUp(id: string) {
    if (!id) return null;
    const r = await this.c('stepups').doc(safe(id)).get();
    return r.exists ? stepUpRow(r.data() as Row) : null;
  }
  override async pendingStepUps(session: string, resource: string, now = Date.now()) {
    return rows(await this.c('stepups').where('session', '==', session).where('resource', '==', resource).where('passed', '==', 0).get())
      .map(stepUpRow).filter((x) => x.expires > now).sort((a, b) => b.expires - a.expires).slice(0, 20);
  }
  override async passStepUp(id: string, until?: number) {
    if (!id) return;
    const ref = this.c('stepups').doc(safe(id));
    await this.db.runTransaction(async (tx) => {
      const r = await tx.get(ref);
      if (!r.exists) return;
      tx.update(ref, until == null ? { passed: 1 } : { passed: 1, expires: Math.max(Number(r.get('expires')), until) });
    });
  }
  override async consumeStepUpGrant(session: string, resource: string, now = Date.now(), digest: string | null = null): Promise<boolean> {
    const q = this.c('stepups').where('session', '==', session).where('resource', '==', resource).where('passed', '==', 1).where('expires', '>', now).orderBy('expires', 'desc').limit(20);
    return this.db.runTransaction(async (tx) => {
      const r = await tx.get(q);
      const hit = r.docs.find((d) => { const x = d.get('digest'); return x == null || x === digest; });
      if (!hit) return false;
      tx.delete(hit.ref);
      return true;
    });
  }

  // =============================================================================================== site: visits, limits, the operators' reports
  override async addVisit(v: { at: number; device: string; account: string | null; method: string; path: string; kind: string; status: number; ms: number; browser: string; os: string; mobile: boolean; bot: boolean; country: string | null; city: string | null; referrer: string | null }, keepMs: number): Promise<void> {
    await this.c('visits').add({ id: newRowId(v.at), ...v, mobile: v.mobile ? 1 : 0, bot: v.bot ? 1 : 0 });
    if (Math.random() < 0.01) await deleteAll(this.db, this.c('visits').where('at', '<', v.at - keepMs), 2000);
  }
  override async hitLimit(key: string, windowMs: number, now = Date.now()): Promise<number> {
    const win = Math.floor(now / windowMs) * windowMs;
    const ref = this.c('rate_limits').doc(docId(key, win));
    const count = await this.db.runTransaction(async (tx) => {
      const r = await tx.get(ref);
      const next = (r.exists ? Number(r.get('n')) : 0) + 1;
      tx.set(ref, { key: key.slice(0, 200), win, n: next });
      return next;
    });
    if (Math.random() < 0.005) await deleteAll(this.db, this.c('rate_limits').where('win', '<', now - 2 * 86400000), 2000).catch(() => {});
    return count;
  }
  /**
   * The admin panel's read-only reports (/admin-panel) run their SQL on the tables they name. Tables with a time column load from
   * `since` on (`since` is the report's start: what it filters on), the small ones whole.
   */
  override async report(sqlText: string, args: SqlArg[] = [], since: number | null = null): Promise<Row[]> {
    const tables = [...new Set([...sqlText.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/gi)].map((m) => m[1]!.toLowerCase()))].filter((t) => t !== 'json_each');
    const data: Record<string, Row[]> = {};
    for (const t of tables) {
      const time = TIME[t];
      const q: Query = time && since != null ? this.c(t).where(time, '>=', since) : this.c(t);
      data[t] = rows(await q.limit(50_000).get());
    }
    return this.onScratch(data, (mem) => mem.report(sqlText, args));
  }
  override async addPortalAlert(a: { account: string; at: number; resource: string; action: string; tools: string[] }) {
    await this.c('portal_alerts').add({ id: newRowId(a.at), account: a.account, at: a.at, resource: a.resource, action: a.action.slice(0, 120), tools: JSON.stringify(a.tools.slice(0, 8)), seen: 0 });
  }
  override async listPortalAlerts(account: string, since: number, limit = 50) {
    return rows(await this.c('portal_alerts').where('account', '==', account).where('at', '>=', since).orderBy('at', 'desc').limit(limit).get())
      .map((x) => ({ id: Number(x.id), at: Number(x.at), resource: String(x.resource), action: String(x.action), tools: safeList(x.tools), seen: Number(x.seen) === 1 }));
  }
  override async markPortalAlertsSeen(account: string) {
    const r = await this.c('portal_alerts').where('account', '==', account).where('seen', '==', 0).get();
    await inBatches(this.db, r.docs, (b, d) => b.update(d.ref, { seen: 1 }));
  }

  // =============================================================================================== site: the lab's samples
  override async addSample(row: { client: string; label: string; source: string; task: string; ua: string; click: unknown; features: unknown; verdict: string }, now = Date.now()): Promise<number> {
    const id = newRowId(now);
    await this.c('samples').add({ id, client: row.client, label: row.label, source: row.source, task: row.task, ua: row.ua, click: JSON.stringify(row.click), features: JSON.stringify(row.features), verdict: row.verdict, created: now });
    return id;
  }
  override async sampleStats() {
    const all = rows(await this.c('samples').select('label', 'source', 'verdict').get());
    const count = new Map<string, number>();
    for (const x of all) { const k = JSON.stringify([String(x.label), String(x.source), String(x.verdict)]); count.set(k, (count.get(k) ?? 0) + 1); }
    return [...count].map(([k, v]) => { const [label, source, verdict] = JSON.parse(k) as string[]; return { label: label!, source: source!, verdict: verdict!, n: v }; })
      .sort((a, b) => cmp(a.label, b.label) || cmp(a.source, b.source) || cmp(a.verdict, b.verdict));
  }
  override async clientSamples(client: string) {
    return rows(await this.c('samples').where('client', '==', client).orderBy('id').get())
      .map((x) => ({ id: Number(x.id), task: String(x.task), verdict: String(x.verdict), features: JSON.parse(String(x.features)), created: Number(x.created) }));
  }
  override async listSamples(label: string | null, limit = 5000) {
    const q = label ? this.c('samples').where('label', '==', label) : this.c('samples');
    return rows(await q.orderBy('id', 'desc').limit(limit).get()).map((x) => ({ id: Number(x.id), client: String(x.client), label: String(x.label), source: String(x.source), task: String(x.task), ua: String(x.ua), click: JSON.parse(String(x.click)), features: JSON.parse(String(x.features)), verdict: String(x.verdict), created: Number(x.created) }));
  }
  override async addTrainingSession(row: { client: string; label: string; source: string; ua: string; early: unknown; steps: unknown; summary: unknown }, now = Date.now()): Promise<number> {
    const id = newRowId(now);
    await this.c('training_sessions').add({ id, client: row.client, label: row.label, source: row.source, ua: row.ua, early: JSON.stringify(row.early), steps: JSON.stringify(row.steps), summary: JSON.stringify(row.summary), created: now });
    return id;
  }
  override async listTrainingSessions(limit = 500) {
    return rows(await this.c('training_sessions').orderBy('id', 'desc').limit(limit).get()).map((x) => ({ id: Number(x.id), client: String(x.client), label: String(x.label), source: String(x.source), ua: String(x.ua), early: JSON.parse(String(x.early)), steps: JSON.parse(String(x.steps)), summary: JSON.parse(String(x.summary)), created: Number(x.created) }));
  }

  // =============================================================================================== site: accounts
  /** e-mail is unique: a lock document per address is created with the account, in one write */
  override async createAccount(email: string, passHash: string, now = Date.now()): Promise<string | null> {
    const id = randomUUID();
    const b = this.db.batch();
    b.create(this.c('account_emails').doc(docId(email)), { email, account: id });
    b.create(this.c('accounts').doc(safe(id)), { id, email, pass: passHash, created: now, firebase_uid: null });
    try { await b.commit(); return id; } catch (e) { if (code(e) === ALREADY_EXISTS) return null; throw e; }
  }
  override async accountByEmail(email: string) {
    const x = rows(await this.c('accounts').where('email', '==', email).limit(1).get())[0];
    return x ? { id: String(x.id), email: String(x.email), pass: String(x.pass), created: Number(x.created) } : null;
  }
  override async setAccountPassword(id: string, passHash: string): Promise<boolean> {
    return this.c('accounts').doc(safe(id)).update({ pass: passHash }).then(() => true, (e) => { if (code(e) === NOT_FOUND) return false; throw e; });
  }
  override async accountByFirebaseUid(uid: string) {
    const x = rows(await this.c('accounts').where('firebase_uid', '==', uid).limit(1).get())[0];
    return x ? { id: String(x.id), email: String(x.email), created: Number(x.created) } : null;
  }
  override async linkFirebaseUid(id: string, uid: string): Promise<void> {
    await this.c('accounts').doc(safe(id)).update({ firebase_uid: uid }).catch((e) => { if (code(e) !== NOT_FOUND) throw e; });
  }
  override async accountById(id: string) {
    if (!id) return null;
    const r = await this.c('accounts').doc(safe(id)).get();
    return r.exists ? { id: String(r.get('id')), email: String(r.get('email')), created: Number(r.get('created')) } : null;
  }
  override async ensureAccountMeta(account: string, m: { started: number; legacy: boolean; source?: string | null }): Promise<void> {
    await this.c('account_meta').doc(safe(account)).create({ account, started: m.started, legacy: m.legacy ? 1 : 0, source: m.source ?? null, connected_at: null, first_agent_at: null, email_off: 0 })
      .catch((e) => { if (code(e) !== ALREADY_EXISTS) throw e; });
  }
  override async accountMeta(account: string): Promise<AccountMeta | null> {
    const r = await this.c('account_meta').doc(safe(account)).get();
    return r.exists ? metaRow(r.data() as Row) : null;
  }
  override async markAccountConnected(account: string, at: number): Promise<boolean> { return this.setOnce('account_meta', account, { connected_at: at }, 'connected_at'); }
  override async markAccountFirstAgent(account: string, at: number): Promise<boolean> { return this.setOnce('account_meta', account, { first_agent_at: at }, 'first_agent_at'); }
  override async setEmailOff(account: string, off: boolean): Promise<void> {
    await this.c('account_meta').doc(safe(account)).update({ email_off: off ? 1 : 0 }).catch((e) => { if (code(e) !== NOT_FOUND) throw e; });
  }
  override async lifecycleAccounts() {
    const [accounts, metas] = await Promise.all([this.c('accounts').select('id', 'email', 'created').get(), this.c('account_meta').get()]);
    const meta = new Map(rows(metas).map((m) => [String(m.account), m]));
    return rows(accounts).map((x) => { const m = meta.get(String(x.id)); return { id: String(x.id), email: String(x.email), created: Number(x.created), meta: m ? metaRow(m) : null }; });
  }
  override async accountFirsts(account: string): Promise<{ first: number | null; firstAgent: number | null }> {
    let first: number | null = null, firstAgent: number | null = null;
    for (const k of (await this.c('api_keys').where('account', '==', account).select().get()).docs) {
      const a = rows(await this.c('telemetry').where('key_id', '==', k.id).orderBy('at').limit(1).select('at').get())[0];
      const g = rows(await this.c('telemetry').where('key_id', '==', k.id).where('agent', '==', 1).orderBy('at').limit(1).select('at').get())[0];
      if (a && (first == null || Number(a.at) < first)) first = Number(a.at);
      if (g && (firstAgent == null || Number(g.at) < firstAgent)) firstAgent = Number(g.at);
    }
    return { first, firstAgent };
  }
  override async claimEmail(account: string, kind: string, ref: string, now = Date.now()): Promise<boolean> {
    const doc = this.c('email_log').doc(docId(account, kind, ref));
    return this.db.runTransaction(async (tx) => {
      const r = await tx.get(doc);
      if (!r.exists) { tx.set(doc, { id: newRowId(now), account, kind, ref, at: now, status: 'sending', attempts: 1, provider_id: null, error: null }); return true; }
      const x = r.data() as Row;
      if (Number(x.attempts) < 3 && (x.status === 'failed' || (x.status === 'sending' && Number(x.at) < now - 3600e3))) {
        tx.update(doc, { status: 'sending', at: now, attempts: Number(x.attempts) + 1 });
        return true;
      }
      return false;
    });
  }
  override async finishEmail(account: string, kind: string, ref: string, status: 'sent' | 'failed' | 'skipped', providerId: string | null, error: string | null): Promise<void> {
    await this.c('email_log').doc(docId(account, kind, ref)).update({ status, provider_id: providerId, error: error ? error.slice(0, 300) : null }).catch((e) => { if (code(e) !== NOT_FOUND) throw e; });
  }
  override async recentEmails(limit = 100) {
    return rows(await this.c('email_log').orderBy('at', 'desc').limit(limit).get()).map((x) => ({ account: String(x.account), kind: String(x.kind), ref: String(x.ref), at: Number(x.at), status: String(x.status), attempts: Number(x.attempts), error: x.error == null ? null : String(x.error) }));
  }
  override async createPortalSession(account: string, ttlMs: number, now = Date.now()): Promise<string> {
    const id = randomUUID();
    await deleteAll(this.db, this.c('portal_sessions').where('expires', '<', now), 400).catch(() => {});
    await this.c('portal_sessions').doc(safe(id)).set({ id, account, expires: now + ttlMs });
    return id;
  }
  override async portalSession(id: string, now = Date.now()): Promise<string | null> {
    if (!id) return null;
    const r = await this.c('portal_sessions').doc(safe(id)).get();
    return r.exists && Number(r.get('expires')) > now ? String(r.get('account')) : null;
  }
  override async deletePortalSession(id: string) { if (id) await this.c('portal_sessions').doc(safe(id)).delete(); }
  override async deleteOtherPortalSessions(account: string, keep: string) {
    const r = await this.c('portal_sessions').where('account', '==', account).get();
    await inBatches(this.db, r.docs.filter((d) => d.id !== safe(keep)), (b, d) => b.delete(d.ref));
  }

  // =============================================================================================== site: keys
  override async createApiKey(account: string, key: { name: string; prefix: string; hash: string; expires?: number | null; env?: string }, now = Date.now()): Promise<string> {
    const id = randomUUID();
    await this.c('api_keys').doc(safe(id)).set({ id, account, name: key.name, prefix: key.prefix, hash: key.hash, created: now, revoked: null, last_seen: null, events: 0, expires: key.expires ?? null, env: key.env ?? 'production', proof_keys: null });
    return id;
  }
  private async keyDoc(id: string): Promise<Row | null> {
    if (!id) return null;
    const r = await this.c('api_keys').doc(safe(id)).get();
    return r.exists ? (r.data() as Row) : null;
  }
  override async listApiKeys(account: string): Promise<ApiKeyRow[]> {
    return rows(await this.c('api_keys').where('account', '==', account).get()).sort((a, b) => Number(a.created) - Number(b.created)).map(apiKeyRow);
  }
  override async apiKeyById(id: string, account: string): Promise<ApiKeyRow | null> {
    const x = await this.keyDoc(id);
    return x && x.account === account ? apiKeyRow(x) : null;
  }
  override async apiKeyIdByHash(hash: string, account: string): Promise<string | null> {
    const x = rows(await this.c('api_keys').where('hash', '==', hash).limit(1).get())[0];
    return x && x.account === account ? String(x.id) : null;
  }
  /** update one key of this account when `ok(row)` holds; true when it did */
  private async keyUpdate(table: 'api_keys' | 'admin_keys', id: string, account: string, ok: (x: Row) => boolean, fields: Record<string, unknown>): Promise<boolean> {
    if (!id) return false;
    const ref = this.c(table).doc(safe(id));
    return this.db.runTransaction(async (tx) => {
      const r = await tx.get(ref);
      if (!r.exists || r.get('account') !== account || !ok(r.data() as Row)) return false;
      tx.update(ref, fields);
      return true;
    });
  }
  override async renameApiKey(id: string, account: string, name: string): Promise<boolean> { return this.keyUpdate('api_keys', id, account, () => true, { name }); }
  override async apiKeyByHash(hash: string) {
    const x = rows(await this.c('api_keys').where('hash', '==', hash).limit(1).get())[0];
    return x ? { id: String(x.id), account: String(x.account), revoked: n(x.revoked), expires: n(x.expires) } : null;
  }
  override async createAdminKey(account: string, name: string, prefix: string, hash: string, now = Date.now()): Promise<string> {
    const id = randomUUID();
    await this.c('admin_keys').doc(safe(id)).set({ id, account, name, prefix, hash, created: now, revoked: null, last_seen: null, calls: 0 });
    return id;
  }
  override async listAdminKeys(account: string) {
    return rows(await this.c('admin_keys').where('account', '==', account).get()).sort((a, b) => Number(a.created) - Number(b.created))
      .map((x) => ({ id: String(x.id), name: String(x.name), prefix: String(x.prefix), created: Number(x.created), revoked: n(x.revoked), lastSeen: n(x.last_seen), calls: Number(x.calls ?? 0) }));
  }
  override async adminKeyByHash(hash: string) {
    const x = rows(await this.c('admin_keys').where('hash', '==', hash).limit(1).get())[0];
    return x ? { id: String(x.id), account: String(x.account), revoked: n(x.revoked) } : null;
  }
  override async touchAdminKey(id: string, now = Date.now()) {
    const { FieldValue } = await import('@google-cloud/firestore');
    await this.c('admin_keys').doc(safe(id)).update({ last_seen: now, calls: FieldValue.increment(1) }).catch((e) => { if (code(e) !== NOT_FOUND) throw e; });
  }
  // =============================================================================================== site: the website chat
  override async createChat(c: { id: string; tokenHash: string; page: string | null; country: string | null; device: string | null }, now = Date.now()): Promise<void> {
    await this.c('chats').doc(safe(c.id)).create({ id: c.id, token_hash: c.tokenHash, created: now, last_at: now, status: 'ai', page: c.page, country: c.country, device: c.device, email: null, messages: 0, unread: 0, preview: null, notified_at: null, human_asked_at: null });
  }
  override async chatById(id: string): Promise<ChatRow | null> {
    if (!id) return null;
    const r = await this.c('chats').doc(safe(id)).get();
    return r.exists ? chatRow(r.data() as Row) : null;
  }
  override async updateChat(id: string, patch: ChatPatch): Promise<void> {
    if (Object.keys(patch).length) await this.c('chats').doc(safe(id)).update(patch).catch((e) => { if (code(e) !== NOT_FOUND) throw e; });
  }
  override async listChats(limit = 100): Promise<ChatRow[]> {
    return rows(await this.c('chats').orderBy('last_at', 'desc').limit(limit).get()).map(chatRow);
  }
  override async addChatMessage(chat: string, role: ChatMessageRow['role'], text: string, author: string | null, now = Date.now()): Promise<number> {
    const id = newRowId(now);
    const { FieldValue } = await import('@google-cloud/firestore');
    const b = this.db.batch();
    b.set(this.c('chat_messages').doc(), { id, chat, at: now, role, text, author });
    b.update(this.c('chats').doc(safe(chat)), {
      last_at: now, messages: FieldValue.increment(1),
      preview: `${role === 'visitor' ? '' : role === 'ai' ? 'AI: ' : role === 'admin' ? 'You: ' : ''}${text}`.slice(0, 140),
      ...(role === 'visitor' ? { unread: FieldValue.increment(1) } : {}),
    });
    await b.commit();
    return id;
  }
  override async chatMessages(chat: string, afterId = 0, limit = 300): Promise<ChatMessageRow[]> {
    return rows(await this.c('chat_messages').where('chat', '==', chat).get()).map(chatMessageRow)
      .filter((m) => m.id > afterId).sort((a, b) => a.id - b.id).slice(0, limit);
  }
  override async pruneChats(before: number): Promise<number> {
    const old = await this.c('chats').where('last_at', '<', before).limit(20).get();
    for (const d of old.docs) {
      const msgs = await this.c('chat_messages').where('chat', '==', String(d.get('id'))).get();
      const b = this.db.batch();
      for (const m of msgs.docs.slice(0, 450)) b.delete(m.ref);
      if (msgs.size <= 450) b.delete(d.ref);
      await b.commit();
    }
    return old.size;
  }

  // =============================================================================================== site: plans and usage
  override async billingFor(account: string) {
    const r = await this.c('billing').doc(safe(account)).get();
    return billingRow(r.exists ? (r.data() as Row) : undefined, account);
  }
  override async setBilling(account: string, patch: BillingPatch, now = Date.now()) {
    const ref = this.c('billing').doc(safe(account));
    await this.db.runTransaction(async (tx) => {
      const r = await tx.get(ref);
      tx.set(ref, { ...(r.exists ? {} : { account, plan: 'free', balance_cents: 0 }), ...patch, updated: now }, { merge: true });
    });
  }
  override async addBalance(account: string, cents: number, kind: string, note: string | null, by: string | null, now = Date.now()) {
    const ref = this.c('billing').doc(safe(account));
    const next = await this.db.runTransaction(async (tx) => {
      const r = await tx.get(ref);
      const balance = (r.exists ? Number(r.get('balance_cents') ?? 0) : 0) + Math.round(cents);
      tx.set(ref, { ...(r.exists ? {} : { account, plan: 'free' }), balance_cents: balance, updated: now }, { merge: true });
      tx.set(this.c('billing_ledger').doc(), { id: newRowId(now), account, at: now, cents: Math.round(cents), kind, note, by_whom: by });
      return balance;
    });
    return next;
  }
  override async debitBalance(account: string, cents: number, now = Date.now()) {
    const ref = this.c('billing').doc(safe(account));
    return this.db.runTransaction(async (tx) => {
      const r = await tx.get(ref);
      const balance = r.exists ? Number(r.get('balance_cents') ?? 0) : 0;
      if (balance < cents) return false;
      tx.update(ref, { balance_cents: balance - cents, updated: now });
      return true;
    });
  }
  override async billingLedger(account: string, limit = 20): Promise<LedgerRow[]> {
    return rows(await this.c('billing_ledger').where('account', '==', account).get())
      .map((x) => ({ id: Number(x.id), at: Number(x.at), cents: Number(x.cents), kind: String(x.kind), note: x.note == null ? null : String(x.note), by: x.by_whom == null ? null : String(x.by_whom) }))
      .sort((a, b) => b.id - a.id).slice(0, limit);
  }
  override async addUsageMarks(account: string, month: string, keyId: string, sessions: string[], now = Date.now()) {
    const fresh: string[] = [];
    for (const session of sessions) {
      const ok = await this.c('usage_marks').doc(docId(account, month, session)).create({ account, month, session, key_id: keyId, at: now, kind: 'pending', cents: 0 })
        .then(() => true, (e) => { if (code(e) === ALREADY_EXISTS) return false; throw e; });
      if (ok) fresh.push(session);
    }
    return fresh;
  }
  override async setUsageMark(account: string, month: string, session: string, kind: string, cents: number) {
    await this.c('usage_marks').doc(docId(account, month, session)).update({ kind, cents }).catch((e) => { if (code(e) !== NOT_FOUND) throw e; });
  }
  override async usageCounts(account: string, month: string): Promise<UsageCounts> {
    const kinds: Record<string, number> = {};
    let total = 0, cents = 0;
    for (const x of rows(await this.c('usage_marks').where('account', '==', account).where('month', '==', month).select('kind', 'cents').get())) {
      const k = String(x.kind); kinds[k] = (kinds[k] ?? 0) + 1; total++; cents += Number(x.cents ?? 0);
    }
    return { total, kinds, cents };
  }
  override async usageMarksOfKind(account: string, month: string, kind: string, limit = 5000) {
    return rows(await this.c('usage_marks').where('account', '==', account).where('month', '==', month).where('kind', '==', kind).get())
      .sort((a, b) => Number(a.at) - Number(b.at)).slice(0, limit).map((x) => String(x.session));
  }
  override async billingAccounts(month: string) {
    const a = new Set<string>();
    for (const x of rows(await this.c('billing').select('account').get())) a.add(String(x.account));
    for (const x of rows(await this.c('usage_marks').where('month', '==', month).select('account').get())) a.add(String(x.account));
    return [...a];
  }
  override async signatureBundleIssuedBefore(t: number) {
    const r = rows(await this.c('signature_bundles').where('issued', '<=', t).orderBy('issued', 'desc').limit(1).get())[0];
    return r ? { seq: Number(r.seq), jws: String(r.jws), issued: Number(r.issued) } : null;
  }

  // =============================================================================================== site: a key shared with other accounts
  override async keyRole(keyId: string, account: string): Promise<KeyRole | null> {
    const k = await this.keyDoc(keyId);
    if (!k) return null;
    if (k.account === account) return 'owner';
    const s = await this.c('key_shares').doc(docId(keyId, account)).get();
    return s.exists ? (String(s.get('role')) as KeyRole) : null;
  }
  override async addKeyShare(keyId: string, account: string, role: KeyRole, invitedBy: string, now = Date.now()): Promise<void> {
    const ref = this.c('key_shares').doc(docId(keyId, account));
    await this.db.runTransaction(async (tx) => {
      const r = await tx.get(ref);
      if (r.exists) tx.update(ref, { role });
      else tx.set(ref, { key_id: keyId, account, role, invited_by: invitedBy, created: now });
    });
  }
  override async removeKeyShare(keyId: string, account: string): Promise<boolean> {
    const ref = this.c('key_shares').doc(docId(keyId, account));
    return this.db.runTransaction(async (tx) => { const r = await tx.get(ref); if (r.exists) tx.delete(ref); return r.exists; });
  }
  private async accountsById(ids: string[]): Promise<Map<string, Row>> {
    const refs = [...new Set(ids)].filter(Boolean).map((id) => this.c('accounts').doc(safe(id)));
    return new Map((refs.length ? await this.db.getAll(...refs) : []).filter((d) => d.exists).map((d) => [String(d.get('id')), d.data() as Row]));
  }
  override async keyShares(keyId: string) {
    const shares = rows(await this.c('key_shares').where('key_id', '==', keyId).get()).sort((a, b) => Number(a.created) - Number(b.created));
    const acc = await this.accountsById(shares.map((x) => String(x.account)));
    return shares.filter((x) => acc.has(String(x.account))).map((x) => ({ account: String(x.account), email: String(acc.get(String(x.account))!.email), role: String(x.role) as KeyRole, created: Number(x.created) }));
  }
  override async sharedKeys(account: string): Promise<SharedKeyRow[]> {
    const shares = rows(await this.c('key_shares').where('account', '==', account).get()).sort((a, b) => Number(a.created) - Number(b.created));
    const refs = shares.map((x) => this.c('api_keys').doc(safe(String(x.key_id))));
    const keys = new Map((refs.length ? await this.db.getAll(...refs) : []).filter((d) => d.exists).map((d) => [String(d.get('id')), d.data() as Row]));
    const owners = await this.accountsById([...keys.values()].map((k) => String(k.account)));
    const out: SharedKeyRow[] = [];
    for (const x of shares) {
      const k = keys.get(String(x.key_id));
      const o = k ? owners.get(String(k.account)) : undefined;
      if (k && o) out.push({ ...apiKeyRow(k), owner: String(o.email), role: String(x.role) as KeyRole });
    }
    return out;
  }
  // =============================================================================================== site: connecting an app from the CLI
  // ---------------------------------------------------------------- the public repo scan
  override async addRepoScan(r: { id: string; repo: string; result: unknown; client: string | null }, now = Date.now()): Promise<void> {
    await this.c('repo_scans').doc(safe(r.id)).create({ id: r.id, repo: r.repo, created: now, result: JSON.stringify(r.result), client: r.client, email: null, unlocked_at: null });
  }
  override async repoScanById(id: string): Promise<RepoScanRow | null> {
    if (!id) return null;
    const r = await this.c('repo_scans').doc(safe(id)).get();
    return r.exists ? repoScanRow(r.data() as Row) : null;
  }
  override async unlockRepoScan(id: string, email: string, now = Date.now()): Promise<boolean> {
    const ref = this.c('repo_scans').doc(safe(id));
    if (!(await ref.get()).exists) return false;
    await ref.update({ email, unlocked_at: now });
    return true;
  }
  override async repoScanLeads(limit = 100): Promise<RepoScanRow[]> {
    return rows(await this.c('repo_scans').where('unlocked_at', '>', 0).orderBy('unlocked_at', 'desc').limit(limit).get()).map(repoScanRow);
  }
  override async createConnect(c: { id: string; code: string; name: string; origin: string | null; expires: number }, now = Date.now()): Promise<void> {
    await this.c('connect_requests').doc(safe(c.id)).create({ id: c.id, code: c.code, name: c.name, origin: c.origin, status: 'pending', account: null, key_id: null, sealed: null, created: now, expires: c.expires, decided_at: null });
  }
  override async connectById(id: string): Promise<ConnectRow | null> {
    if (!id) return null;
    const r = await this.c('connect_requests').doc(safe(id)).get();
    return r.exists ? connectRow(r.data() as Row) : null;
  }
  override async connectByCode(code: string, now = Date.now()): Promise<ConnectRow | null> {
    return rows(await this.c('connect_requests').where('code', '==', code).get()).map(connectRow)
      .filter((x) => x.expires > now).sort((a, b) => b.created - a.created)[0] ?? null;
  }
  override async decideConnect(id: string, d: { status: 'approved' | 'denied'; account: string; keyId?: string | null; sealed?: string | null }, now = Date.now()): Promise<boolean> {
    const ref = this.c('connect_requests').doc(safe(id));
    return this.db.runTransaction(async (tx) => {
      const r = await tx.get(ref);
      if (!r.exists || r.get('status') !== 'pending' || Number(r.get('expires')) <= now) return false;
      tx.update(ref, { status: d.status, account: d.account, key_id: d.keyId ?? null, sealed: d.sealed ?? null, decided_at: now });
      return true;
    });
  }
  override async takeConnect(id: string, now = Date.now()): Promise<ConnectRow | null> {
    const ref = this.c('connect_requests').doc(safe(id));
    return this.db.runTransaction(async (tx) => {
      const r = await tx.get(ref);
      if (!r.exists) return null;
      const row = connectRow(r.data() as Row);
      if (row.status !== 'approved' || !row.sealed) return null;
      tx.update(ref, { status: 'used', sealed: null });
      return row.expires + 10 * 60_000 > now ? row : null;
    });
  }

  override async createKeyInvite(i: { id: string; keyId: string; email: string; role: KeyRole; invitedBy: string; expires: number }, now = Date.now()): Promise<void> {
    await this.c('key_invites').doc(safe(i.id)).create({ id: i.id, key_id: i.keyId, email: i.email, role: i.role, invited_by: i.invitedBy, created: now, expires: i.expires, accepted_at: null, accepted_by: null });
  }
  private static invite(x: Row): KeyInviteRow {
    return { id: String(x.id), keyId: String(x.key_id), email: String(x.email), role: String(x.role) as KeyRole, invitedBy: String(x.invited_by), created: Number(x.created), expires: Number(x.expires), acceptedAt: n(x.accepted_at), acceptedBy: x.accepted_by == null ? null : String(x.accepted_by) };
  }
  override async keyInvite(id: string): Promise<KeyInviteRow | null> {
    if (!id) return null;
    const r = await this.c('key_invites').doc(safe(id)).get();
    return r.exists ? FireSiteStore.invite(r.data() as Row) : null;
  }
  override async keyInvites(keyId: string, now = Date.now()): Promise<KeyInviteRow[]> {
    return rows(await this.c('key_invites').where('key_id', '==', keyId).get()).map(FireSiteStore.invite)
      .filter((x) => x.acceptedAt == null && x.expires > now).sort((a, b) => a.created - b.created);
  }
  override async acceptKeyInvite(id: string, account: string, now = Date.now()): Promise<boolean> {
    const ref = this.c('key_invites').doc(safe(id));
    return this.db.runTransaction(async (tx) => {
      const r = await tx.get(ref);
      if (!r.exists || r.get('accepted_at') != null || Number(r.get('expires')) <= now) return false;
      tx.update(ref, { accepted_at: now, accepted_by: account });
      return true;
    });
  }
  override async cancelKeyInvite(keyId: string, id: string): Promise<boolean> {
    const ref = this.c('key_invites').doc(safe(id));
    return this.db.runTransaction(async (tx) => {
      const r = await tx.get(ref);
      if (!r.exists || r.get('key_id') !== keyId || r.get('accepted_at') != null) return false;
      tx.delete(ref);
      return true;
    });
  }
  override async revokeAdminKey(id: string, account: string, now = Date.now()): Promise<boolean> { return this.keyUpdate('admin_keys', id, account, (x) => x.revoked == null, { revoked: now }); }
  override async apiKeyOwned(id: string, account: string): Promise<boolean> { return (await this.keyDoc(id))?.account === account; }
  override async revokeApiKey(id: string, account: string, now = Date.now()): Promise<boolean> { return this.keyUpdate('api_keys', id, account, (x) => x.revoked == null, { revoked: now }); }
  override async rotateApiKey(id: string, account: string, prefix: string, hash: string): Promise<boolean> { return this.keyUpdate('api_keys', id, account, (x) => x.revoked == null, { prefix, hash }); }
  override async deleteApiKey(id: string, account: string): Promise<boolean> {
    const x = await this.keyDoc(id);
    if (!x || x.account !== account || x.revoked == null) return false;
    await deleteAll(this.db, this.c('telemetry').where('key_id', '==', id), Infinity);
    await this.c('key_policies').doc(safe(id)).delete();
    await deleteAll(this.db, this.c('policy_changes').where('key_id', '==', id), Infinity);
    await deleteAll(this.db, this.c('key_resources').where('key_id', '==', id), Infinity);
    await deleteAll(this.db, this.c('key_shares').where('key_id', '==', id), Infinity);
    await deleteAll(this.db, this.c('key_invites').where('key_id', '==', id), Infinity);
    await this.c('api_keys').doc(safe(id)).delete();
    return true;
  }

  // =============================================================================================== site: the portal's policy per key
  override async keyPolicy(keyId: string): Promise<KeyPolicyRow | null> {
    if (!keyId) return null;
    const d = await this.c('key_policies').doc(safe(keyId)).get();
    if (!d.exists) return null;
    const r = d.data() as Row;
    return {
      keyId, n: Number(r.n), body: JSON.parse(String(r.body)), updated: Number(r.updated),
      requireApproval: Number(r.require_approval) === 1, confirmWeakening: Number(r.confirm_weakening) === 1,
      lastFileHash: r.last_file_hash == null ? null : String(r.last_file_hash),
      seen: r.seen_at == null ? null : { version: String(r.seen_version ?? ''), source: String(r.seen_source ?? ''), at: Number(r.seen_at) },
    };
  }
  override async putKeyPolicy(keyId: string, nVersion: number, body: unknown, now = Date.now()) {
    const ref = this.c('key_policies').doc(safe(keyId));
    await this.db.runTransaction(async (tx) => {
      const r = await tx.get(ref);
      if (r.exists) tx.update(ref, { n: nVersion, body: JSON.stringify(body), updated: now });
      else tx.set(ref, { key_id: keyId, n: nVersion, body: JSON.stringify(body), updated: now, require_approval: 0, confirm_weakening: 1, last_file_hash: null, seen_version: null, seen_source: null, seen_at: null });
    });
  }
  private async keyPolicyUpdate(keyId: string, fields: Record<string, unknown>) {
    await this.c('key_policies').doc(safe(keyId)).update(fields).catch((e) => { if (code(e) !== NOT_FOUND) throw e; });
  }
  override async setKeyPolicySettings(keyId: string, s: { requireApproval?: boolean; confirmWeakening?: boolean }) {
    const f: Record<string, unknown> = {};
    if (s.requireApproval !== undefined) f.require_approval = s.requireApproval ? 1 : 0;
    if (s.confirmWeakening !== undefined) f.confirm_weakening = s.confirmWeakening ? 1 : 0;
    if (Object.keys(f).length) await this.keyPolicyUpdate(keyId, f);
  }
  override async setKeyPolicyFileHash(keyId: string, hash: string) { await this.keyPolicyUpdate(keyId, { last_file_hash: hash }); }
  override async setKeyPolicySeen(keyId: string, version: string, source: string, now = Date.now()) {
    await this.keyPolicyUpdate(keyId, { seen_version: version.slice(0, 80), seen_source: source.slice(0, 20), seen_at: now });
  }
  override async addPolicyChange(c: { keyId: string; actor: string; origin: string; status: string; fromN: number | null; toN: number | null; body: unknown; summary: string[]; weakening: string[] }, now = Date.now()): Promise<number> {
    const id = newRowId(now);
    await this.c('policy_changes').doc(String(id)).set({ id, key_id: c.keyId, at: now, actor: c.actor.slice(0, 120), origin: c.origin, status: c.status, from_n: c.fromN, to_n: c.toN, body: c.body == null ? null : JSON.stringify(c.body), summary: JSON.stringify(c.summary.slice(0, 60)), weakening: c.weakening.length ? JSON.stringify(c.weakening.slice(0, 60)) : null, decided_by: null, decided_at: null });
    return id;
  }
  override async decidePolicyChange(keyId: string, id: number, status: 'applied' | 'rejected' | 'superseded', by: string, toN: number | null, now = Date.now()): Promise<boolean> {
    const q = this.c('policy_changes').where('key_id', '==', keyId).where('id', '==', id).limit(1);
    return this.db.runTransaction(async (tx) => {
      const r = await tx.get(q);
      const d = r.docs[0];
      if (!d || d.get('status') !== 'pending') return false;
      tx.update(d.ref, { status, decided_by: by.slice(0, 120), decided_at: now, ...(toN != null ? { to_n: toN } : {}) });
      return true;
    });
  }
  override async policyChanges(keyId: string, opts: { status?: string; limit?: number } = {}): Promise<PolicyChangeRow[]> {
    let q: Query = this.c('policy_changes').where('key_id', '==', keyId);
    if (opts.status) q = q.where('status', '==', opts.status);
    return rows(await q.orderBy('id', 'desc').limit(opts.limit ?? 50).get()).map((x) => ({
      id: Number(x.id), at: Number(x.at), actor: String(x.actor), origin: String(x.origin), status: String(x.status),
      fromN: n(x.from_n), toN: n(x.to_n), body: x.body == null ? null : JSON.parse(String(x.body)), summary: safeList(x.summary), weakening: x.weakening == null ? [] : safeList(x.weakening),
      decidedBy: x.decided_by == null ? null : String(x.decided_by), decidedAt: n(x.decided_at),
    }));
  }
  override async noteKeyResources(keyId: string, resources: string[], now = Date.now()) {
    const list = [...new Set(resources.slice(0, 200))];
    if (!list.length) return;
    const refs = list.map((res) => this.c('key_resources').doc(docId(keyId, res)));
    const have = new Set((await this.db.getAll(...refs)).filter((d) => d.exists).map((d) => d.id));
    await inBatches(this.db, list.map((res, i) => ({ res, ref: refs[i]! })), (b, x) => {
      if (have.has(x.ref.id)) b.update(x.ref, { last_seen: now });
      else b.set(x.ref, { key_id: keyId, resource: x.res, first_seen: now, last_seen: now });
    });
  }
  override async keyResources(keyId: string) {
    return rows(await this.c('key_resources').where('key_id', '==', keyId).get()).map((x) => ({ resource: String(x.resource), firstSeen: Number(x.first_seen), lastSeen: Number(x.last_seen) }))
      .sort((a, b) => cmp(a.resource, b.resource));
  }
  override async telemetryResources(keyId: string, since: number) {
    return this.onScratch({ telemetry: await this.telemetryRows(keyId, since) }, (mem) => mem.telemetryResources(keyId, since));
  }
  override async latestSignatureBundle() {
    const r = rows(await this.c('signature_bundles').orderBy('seq', 'desc').limit(1).get())[0];
    return r ? { seq: Number(r.seq), jws: String(r.jws), issued: Number(r.issued) } : null;
  }
  override async addSignatureBundle(seq: number, jws: string, issued: number): Promise<boolean> {
    return this.c('signature_bundles').doc(String(seq)).create({ seq, jws, issued, added: Date.now() }).then(() => true, (e) => { if (code(e) === ALREADY_EXISTS) return false; throw e; });
  }
  override async noteAssist(account: string) { await this.c('assist_log').add({ account, at: Date.now() }); }
  override async assistCountAll(since: number): Promise<number> { return (await this.c('assist_log').where('at', '>', since).count().get()).data().count; }
  override async assistCount(account: string, since: number): Promise<number> { return (await this.c('assist_log').where('account', '==', account).where('at', '>', since).count().get()).data().count; }
  override async rememberProofKeys(keyId: string, keys: { kty: string; crv: string; x: string; kid: string }[]) {
    if (!keys.length) return;
    const x = await this.keyDoc(keyId);
    if (!x) return;
    let known: { kty: string; crv: string; x: string; kid: string; first: number }[] = [];
    try { known = x.proof_keys ? JSON.parse(String(x.proof_keys)) : []; } catch { known = []; }
    let changed = false;
    for (const k of keys) if (!known.some((q) => q.kid === k.kid)) { known.push({ kty: k.kty, crv: k.crv, x: k.x, kid: k.kid, first: Date.now() }); changed = true; }
    if (changed) await this.c('api_keys').doc(safe(keyId)).update({ proof_keys: JSON.stringify(known.slice(-10)) });
  }
  override async proofKeysFor(keyId: string) {
    const x = await this.keyDoc(keyId);
    try { return x?.proof_keys ? JSON.parse(String(x.proof_keys)) : []; } catch { return []; }
  }

  // =============================================================================================== site: telemetry
  override async setTelemetryFeedback(keyId: string, id: number, feedback: 'correct' | 'wrong' | null, note: string | null, now = Date.now()): Promise<boolean> {
    const d = (await this.c('telemetry').where('key_id', '==', keyId).where('id', '==', id).limit(1).get()).docs[0];
    if (!d) return false;
    await d.ref.update({ feedback, feedback_note: note, feedback_at: feedback ? now : null });
    return true;
  }
  override async telemetryFeedback(keyId: string, since: number) {
    return this.onScratch({ telemetry: await this.telemetryRows(keyId, since) }, (mem) => mem.telemetryFeedback(keyId, since));
  }
  override async telemetryHealth(keyId: string, since: number): Promise<TelemetryHealth> {
    const [inRange, newest] = await Promise.all([this.telemetryRows(keyId, since), this.c('telemetry').where('key_id', '==', keyId).orderBy('at', 'desc').limit(1).get()]);
    return this.onScratch({ telemetry: [...inRange, ...rows(newest)] }, (mem) => mem.telemetryHealth(keyId, since));
  }
  override async telemetryWeek(keyId: string, start: number, end: number): Promise<TelemetryWeek> {
    return this.onScratch({ telemetry: await this.telemetryRows(keyId, start, end) }, (mem) => mem.telemetryWeek(keyId, start, end));
  }
  override async telemetryProofs(keyId: string, since: number, session: string | null, limit = 5000) {
    let q: Query = this.c('telemetry').where('key_id', '==', keyId).where('at', '>=', since);
    if (session) q = q.where('session', '==', session);
    return rows(await q.orderBy('at').get()).filter((x) => x.proof != null).sort((a, b) => Number(a.id) - Number(b.id)).slice(0, limit)
      .map((x) => ({ at: Number(x.at), session: String(x.session), proof: String(x.proof), ok: Number(x.proof_ok) === 1 }));
  }
  /** a retried batch carries the same event ids: an event with an id already stored for this key is dropped */
  override async insertTelemetry(keyId: string, events: TelemetryEvent[], now = Date.now()): Promise<number> {
    const once = new Set<string>();
    events = events.filter((e) => !e.eid || (!once.has(e.eid) && !!once.add(e.eid)));
    const withId = events.filter((e) => e.eid).map((e) => this.c('telemetry').doc(docId(keyId, e.eid!)));
    const seen = new Set(withId.length ? (await this.db.getAll(...withId)).filter((d) => d.exists).map((d) => d.id) : []);
    events = events.filter((e) => !e.eid || !seen.has(docId(keyId, e.eid)));
    if (!events.length) return 0;
    const { FieldValue } = await import('@google-cloud/firestore');
    await inBatches(this.db, events, (b, e) => {
      const tools = JSON.stringify(e.tools);
      const ref = e.eid ? this.c('telemetry').doc(docId(keyId, e.eid)) : this.c('telemetry').doc();
      b.set(ref, {
        id: newRowId(now), key_id: keyId, at: e.at, session: e.session, resource: e.resource, decision: e.decision, computed: e.computed ?? e.decision, actor: e.actor, state: e.state,
        tools, reasons: JSON.stringify(e.reasons), enforcement: e.enforcement, version: e.version, proof: e.proof ?? null, proof_kid: e.proofKid ?? null,
        proof_ok: e.proofOk == null ? null : e.proofOk ? 1 : 0, eid: e.eid ?? null, feedback: null, feedback_note: null, feedback_at: null, agent: agentRow(e.actor, tools),
      });
    });
    await this.c('api_keys').doc(safe(keyId)).update({ last_seen: now, events: FieldValue.increment(events.length) }).catch((e) => { if (code(e) !== NOT_FOUND) throw e; });
    return events.length;
  }
  override async telemetryDecisions(keyId: string, from: number, to: number) {
    return (await this.telemetryRows(keyId, from, to)).map((r) => ({
      session: String(r.session), created: Number(r.at), resource: String(r.resource), decision: String(r.decision), computed: String(r.computed ?? r.decision), actor: String(r.actor),
      tools: safeList(r.tools), signed: r.proof != null, enforced: r.enforcement === 'enforce',
    }));
  }
  override async telemetryStats(keyId: string, since: number, bucketMs: number, prefix?: string): Promise<TelemetryStats> {
    return this.onScratch({ telemetry: await this.telemetryRows(keyId, since) }, (mem) => mem.telemetryStats(keyId, since, bucketMs, prefix));
  }
  override async telemetryApps(keyId: string, since: number, prefix: string): Promise<TelemetryApps> {
    return this.onScratch({ telemetry: await this.telemetryRows(keyId, since) }, (mem) => mem.telemetryApps(keyId, since, prefix));
  }
  /** the decision log, newest first, paged by id */
  override async telemetryEvents(keyId: string, since: number, beforeId: number | null, limit: number) {
    const out: Row[] = [];
    let q: Query = this.c('telemetry').where('key_id', '==', keyId);
    if (beforeId != null) q = q.where('id', '<', beforeId);
    q = q.orderBy('id', 'desc');
    let last: DocumentSnapshot | null = null;
    // ids follow arrival, `at` the event's own time: walk by id, keep what is in range, stop once a page is all older
    for (let pages = 0; out.length < limit && pages < 20; pages++) {
      const page: { docs: DocumentSnapshot[] } = await (last ? q.startAfter(last) : q).limit(Math.max(limit, 100)).get();
      if (!page.docs.length) break;
      const list = rows(page);
      for (const x of list) if (Number(x.at) >= since && out.length < limit) out.push(x);
      if (list.every((x) => Number(x.at) < since - 86_400_000) || page.docs.length < Math.max(limit, 100)) break;
      last = page.docs[page.docs.length - 1]!;
    }
    return out.map((x) => ({
      id: Number(x.id), at: Number(x.at), session: String(x.session), resource: String(x.resource), decision: String(x.decision), actor: String(x.actor), state: String(x.state),
      tools: safeList(x.tools), reasons: safeList(x.reasons), enforcement: String(x.enforcement), signed: x.proof_ok == null ? null : Number(x.proof_ok) === 1, feedback: x.feedback == null ? null : String(x.feedback),
    }));
  }
  /** every key an account sees (its own, and those shared with it) with their telemetry since `since`, for the SQL that joins them */
  private async accountTelemetry(account: string, since: number): Promise<{ api_keys: Row[]; telemetry: Row[]; key_shares: Row[] }> {
    const [own, shares] = await Promise.all([this.c('api_keys').where('account', '==', account).get(), this.c('key_shares').where('account', '==', account).get()]);
    const sharedRefs = rows(shares).map((x) => this.c('api_keys').doc(safe(String(x.key_id))));
    const shared = (sharedRefs.length ? await this.db.getAll(...sharedRefs) : []).filter((d) => d.exists).map((d) => d.data() as Row);
    const keys = [...rows(own), ...shared];
    const telemetry = (await Promise.all(keys.map((k) => this.telemetryRows(String(k.id), since)))).flat();
    return { api_keys: keys, telemetry, key_shares: rows(shares) };
  }
  override async telemetryOverview(account: string, since: number, bucketMs: number): Promise<TelemetryOverview> {
    return this.onScratch(await this.accountTelemetry(account, since), (mem) => mem.telemetryOverview(account, since, bucketMs));
  }
  override async telemetryAgentEvents(account: string, since: number, limit = 20000) {
    return this.onScratch(await this.accountTelemetry(account, since), (mem) => mem.telemetryAgentEvents(account, since, limit));
  }
}

/**
 * Firestore from the environment: FIREBASE_PROJECT_ID names the project. On Vercel the function proves who it is with
 * its OIDC token (Workload Identity Federation: GCP_PROJECT_NUMBER, GCP_WORKLOAD_IDENTITY_POOL_ID,
 * GCP_WORKLOAD_IDENTITY_PROVIDER_ID, GCP_SERVICE_ACCOUNT_EMAIL), so no key file exists anywhere. Elsewhere it uses
 * Google's default credentials, or FIRESTORE_EMULATOR_HOST.
 */
export async function firestoreFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<Firestore | null> {
  const projectId = env.FIREBASE_PROJECT_ID;
  if (!projectId) return null;
  const { Firestore } = await import('@google-cloud/firestore');
  // REST starts faster on a cold serverless function; the emulator speaks gRPC only without credentials
  const settings: Record<string, unknown> = { projectId, databaseId: env.FIRESTORE_DATABASE_ID || '(default)', preferRest: !env.FIRESTORE_EMULATOR_HOST, ignoreUndefinedProperties: true };
  if (env.GCP_WORKLOAD_IDENTITY_PROVIDER_ID && env.GCP_SERVICE_ACCOUNT_EMAIL && !env.FIRESTORE_EMULATOR_HOST) {
    const { ExternalAccountClient } = await import('google-auth-library');
    const { getVercelOidcToken } = await import('@vercel/oidc');
    settings.authClient = ExternalAccountClient.fromJSON({
      type: 'external_account',
      audience: `//iam.googleapis.com/projects/${env.GCP_PROJECT_NUMBER}/locations/global/workloadIdentityPools/${env.GCP_WORKLOAD_IDENTITY_POOL_ID}/providers/${env.GCP_WORKLOAD_IDENTITY_PROVIDER_ID}`,
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      token_url: 'https://sts.googleapis.com/v1/token',
      service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${env.GCP_SERVICE_ACCOUNT_EMAIL}:generateAccessToken`,
      subject_token_supplier: { getSubjectToken: () => getVercelOidcToken() },
    } as Parameters<typeof ExternalAccountClient.fromJSON>[0]);
  }
  return new Firestore(settings);
}

export { SERVER_LIMITS };
export type { DocumentData };
