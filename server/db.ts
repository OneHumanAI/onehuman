// SPDX-License-Identifier: BUSL-1.1
/**
 * Storage (SQLite dialect) over a SqlClient: node:sqlite locally, libSQL/Turso
 * in serverless deployments. All methods are async.
 *
 * A deployment keeps one room for all its visitors, capped per session and by age (SERVER_LIMITS). Short-lived rooms
 * (tests, demos) expire after ROOM_TTL_MS. Nothing here stores IPs, user agents, typed text or cookies.
 */
import type { Assessment } from './assess.ts';
import type { Decision, Policy } from './policy.ts';
import type { ClientSnapshot, ServerSignal } from './signals.ts';
import { sqliteClient, type Row, type SqlArg, type SqlClient } from './sql.ts';

/** short-lived rooms (and their sessions, events, decisions) are kept this long; a deployment's own room never expires */
export const ROOM_TTL_MS = 60 * 86400000;
/** a pause this long ends a visit: the next request starts a new one (see touchSession) */
export const VISIT_IDLE_MS = 30 * 60000;

/**
 * How much the store keeps. A deployment has one room for all its visitors, so the caps are per session and by age:
 * no session limit, the newest events of each session, nothing older than a week. A host running many small rooms
 * can cap each room instead (sessionsPerRoom, eventsPerRoom).
 */
export type StoreLimits = { sessionsPerRoom: number | null; eventsPerRoom: number | null; eventsPerSession: number | null; eventMaxAgeMs: number | null };
export const SERVER_LIMITS: StoreLimits = { sessionsPerRoom: null, eventsPerRoom: null, eventsPerSession: 300, eventMaxAgeMs: 7 * 24 * 3600e3 };

export type SessionRow = {
  id: string;
  room: string;
  label: 'human' | 'agent' | 'unlabelled';
  /** benchmark scenario slug declared in the URL (e.g. "chrome-keyboard-only"); a declaration, never a classifier input */
  scenario: string;
  created: number;
  arrival: ServerSignal | null;
  firstDataAt: number | null;
  firstAgentAt: number | null;
  /** server time when the connection classifier first said agent_attached / signed_agent */
  agentAttachedAt: number | null;
  /** client ms-since-page-start of the evidence that flipped the state */
  agentAttachedClientMs: number | null;
  /** server time of the last successful WebAuthn user-verified assertion (a person reclaimed the session) */
  humanVerifiedAt: number | null;
  lastSeen: number;
};

export type ChallengeKind = 'register' | 'assert' | 'approve' | 'permit';
/** The account owner's choice for their own agent on one resource. */
export type AgentAccess = { resource: string; choice: 'allow' | 'never'; until: number | null; by: string; created: number };

export type EventRow = {
  id: number;
  room: string;
  session: string;
  /** 'raw': a byte-exact copy of what a page sent, kept only when the server records raw payloads */
  kind: 'arrival' | 'signal' | 'interaction' | 'attach' | 'seal' | 'raw';
  payload: unknown;
  created: number;
};

export type DecisionRow = Decision & {
  room: string;
  session: string;
  latencyMs: number;
  dataDelivered: boolean;
  /** a request the host sent itself to demonstrate a path (DecideInput.simulated); excluded from statistics */
  simulated: boolean;
  assessment: Assessment;
  /** agent products seen in the session when this decision was made (e.g. claude-chrome), and the connection state */
  tools?: string[];
  connection?: string;
  created: number;
  prevHash: string;
  hash: string;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, created INTEGER NOT NULL, app TEXT NOT NULL DEFAULT 'bank');
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  room TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT 'unlabelled',
  scenario TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL,
  arrival TEXT,
  first_data_at INTEGER,
  first_agent_at INTEGER,
  agent_attached_at INTEGER,
  agent_attached_client_ms INTEGER,
  human_verified_at INTEGER,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_room ON sessions(room, created);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  session TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_session ON events(session, id);
CREATE INDEX IF NOT EXISTS events_room ON events(room, id);
-- what the account owner lets their own AI agent do, per resource: 'allow' (given with a passkey, until a time) or
-- 'never'. scope = the account: the OneHuman session of that login, or a room
CREATE TABLE IF NOT EXISTS agent_access (
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  choice TEXT NOT NULL,
  until INTEGER,
  by_whom TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (scope, resource)
);
CREATE TABLE IF NOT EXISTS anchors (
  room TEXT NOT NULL,
  seq INTEGER NOT NULL,
  hash TEXT NOT NULL,
  tsa TEXT NOT NULL,
  request TEXT NOT NULL,
  response TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (room, seq)
);
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  room TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  session TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  body TEXT NOT NULL,
  created INTEGER NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS decisions_room ON decisions(room, seq);
CREATE TABLE IF NOT EXISTS policies (
  room TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  body TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY (room, version)
);
CREATE TABLE IF NOT EXISTS nonces (key TEXT PRIMARY KEY, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS policy_cache (
  tag TEXT PRIMARY KEY,
  envelope TEXT NOT NULL,
  pinned_key TEXT NOT NULL,
  fetched INTEGER NOT NULL,
  pushed_file_hash TEXT
);
CREATE TABLE IF NOT EXISTS stepups (
  id TEXT PRIMARY KEY,
  session TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  resource TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires INTEGER NOT NULL,
  passed INTEGER NOT NULL DEFAULT 0,
  digest TEXT,
  summary TEXT
);
CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  room TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  session TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS credentials_room ON credentials(room);
CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,
  session TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  resource TEXT,
  expires INTEGER NOT NULL
);
`;

/** additive migrations for databases created by earlier builds */
/** The newest column of each migrated table. Add a line here whenever MIGRATIONS gains a column. */
const SCHEMA_MARKERS: [string, string][] = [['decisions', 'proof'], ['sessions', 'human_verified_at'], ['policy_cache', 'pushed_file_hash'], ['rooms', 'device'], ['anchors', 'response'], ['agent_access', 'by_whom'], ['stepups', 'summary']];

/**
 * Indexes the schema check also looks for. decisions_room_seq makes (room, seq) unique so two writers can never
 * both append seq N (the chain would fork). It covers rows from 29 Sep 2026 on: older rooms may already hold
 * duplicates from before the fix, and a full unique index would fail to build on them.
 */
const INDEX_MARKERS = ['decisions_room_seq'];

const MIGRATIONS = [
  'CREATE UNIQUE INDEX IF NOT EXISTS decisions_room_seq ON decisions(room, seq) WHERE created >= 1790640000000',
  'ALTER TABLE sessions ADD COLUMN agent_attached_at INTEGER',
  'ALTER TABLE sessions ADD COLUMN agent_attached_client_ms INTEGER',
  "ALTER TABLE sessions ADD COLUMN scenario TEXT NOT NULL DEFAULT ''",
  'ALTER TABLE sessions ADD COLUMN human_verified_at INTEGER',
  "ALTER TABLE rooms ADD COLUMN app TEXT NOT NULL DEFAULT 'bank'",
  'ALTER TABLE decisions ADD COLUMN proof TEXT',
  'ALTER TABLE rooms ADD COLUMN device TEXT',
  'ALTER TABLE stepups ADD COLUMN digest TEXT',
  'ALTER TABLE stepups ADD COLUMN summary TEXT',
  'CREATE INDEX IF NOT EXISTS rooms_device ON rooms(device, created)',
  'CREATE INDEX IF NOT EXISTS rooms_created ON rooms(created)',
];

export type StepUpRow = { id: string; session: string; resource: string; challenge: string; expires: number; passed: boolean; digest: string | null; summary: string | null };
export const stepUpRow = (r: Record<string, unknown>): StepUpRow => ({ id: String(r.id), session: String(r.session), resource: String(r.resource), challenge: String(r.challenge), expires: Number(r.expires), passed: !!Number(r.passed), digest: r.digest == null ? null : String(r.digest), summary: r.summary == null ? null : String(r.summary) });

/** stored JSON columns are written by us, but a bad row must not take a whole page down */
export const safeList = (v: unknown): string[] => { try { const a: unknown = JSON.parse(String(v)); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } };

export class Store {
  readonly sql: SqlClient;
  readonly limits: StoreLimits;
  private inserts = 0;
  private roomInserts = 0;
  private roomTrims = 0;
  protected constructor(sql: SqlClient, limits: StoreLimits) { this.sql = sql; this.limits = limits; }

  /** Open a store on a client and make sure the schema exists. */
  static async open(client?: SqlClient, opts: { migrate?: boolean; limits?: StoreLimits } = {}): Promise<Store> {
    const c = client ?? (await sqliteClient(':memory:'));
    await Store.prepare(c, opts);
    return new Store(c, opts.limits ?? SERVER_LIMITS);
  }

  /** Create or migrate the engine's tables on `c`. */
  protected static async prepare(c: SqlClient, opts: { migrate?: boolean } = {}): Promise<void> {
    // One round trip decides whether the schema exists; cold starts on a ready database then skip
    // the CREATE/ALTER statements (each of which is a network round trip on libSQL).
    // A database is ready when every table exists AND the newest migrated columns exist: a deployment that
    // predates a column must still get its ALTERs, or every insert naming that column fails.
    const probe = (await c.execute(`SELECT
      (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('rooms','sessions','decisions','challenges','agent_access','policy_cache')) AS tables,
      ${SCHEMA_MARKERS.map(([t, col]) => `(SELECT COUNT(*) FROM pragma_table_info('${t}') WHERE name='${col}')`).join(' + ')} AS columns,
      (SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN (${INDEX_MARKERS.map((n) => `'${n}'`).join(',')})) AS indexes`)).rows[0] ?? {};
    const ready = Number(probe.tables) === 6 && Number(probe.columns) === SCHEMA_MARKERS.length && Number(probe.indexes) === INDEX_MARKERS.length;
    if (!ready || opts.migrate) {
      await c.executeMultiple(SCHEMA);
      for (const m of MIGRATIONS) { try { await c.execute(m); } catch { /* column exists */ } }
    }
  }

  close() {
    this.sql.close();
  }

  /** Test helper: run a raw statement. */
  exec(sqlText: string, args: SqlArg[] = []) {
    return this.sql.execute(sqlText, args);
  }

  // --- rooms ---------------------------------------------------------------
  async createRoom(now = Date.now(), app = 'bank', device: string | null = null): Promise<string> {
    const id = crypto.randomUUID();
    // expired rooms go now and then, children first: the remote database may not enforce ON DELETE CASCADE
    const expired = "SELECT id FROM rooms WHERE created < ? AND app NOT LIKE 'tenant:%'";
    const cut = now - ROOM_TTL_MS;
    const prune = ++this.roomInserts % 50 === 1
      ? ['challenges', 'stepups'].map((t) => ({ sql: `DELETE FROM ${t} WHERE session IN (SELECT id FROM sessions WHERE room IN (${expired}))`, args: [cut] }))
        .concat(['events', 'decisions', 'credentials', 'policies', 'sessions', 'rooms'].map((t) => ({ sql: t === 'rooms' ? `DELETE FROM rooms WHERE id IN (${expired})` : `DELETE FROM ${t} WHERE room IN (${expired})`, args: [cut] })))
      : [];
    await this.sql.batch([
      ...prune,
      { sql: 'INSERT INTO rooms (id, created, app, device) VALUES (?, ?, ?, ?)', args: [id, now, app, device] },
    ]);
    return id;
  }
  async roomExists(id: string, now = Date.now()): Promise<boolean> {
    // short-lived rooms expire; a deployment's own room never does
    return (await this.sql.execute("SELECT 1 AS x FROM rooms WHERE id = ? AND (created > ? OR app LIKE 'tenant:%')", [id, now - ROOM_TTL_MS])).rows.length > 0;
  }

  /** Integration package: one persistent room per tenant with a caller-chosen id. */
  async ensureRoom(id: string, app: string, now = Date.now()): Promise<void> {
    await this.sql.execute('INSERT OR IGNORE INTO rooms (id, created, app) VALUES (?, ?, ?)', [id, now, app]);
  }

  /** sessions started since `since` (the development cap of an unlicensed deployment) */
  async countSessionsSince(since: number): Promise<number> {
    return Number((await this.sql.execute('SELECT COUNT(*) AS n FROM sessions WHERE created >= ?', [since])).rows[0]?.n ?? 0);
  }
  async roomApp(id: string): Promise<string | null> {
    const r = (await this.sql.execute('SELECT app FROM rooms WHERE id = ?', [id])).rows[0];
    return r ? (r.app as string) : null;
  }

  // --- sessions ------------------------------------------------------------
  async createSession(room: string, label: SessionRow['label'], arrival: ServerSignal | null, now = Date.now(), scenario = ''): Promise<string | null> {
    if (this.limits.sessionsPerRoom !== null) {
      const n = (await this.sql.execute('SELECT COUNT(*) AS n FROM sessions WHERE room = ?', [room])).rows[0]!.n as number;
      if (n >= this.limits.sessionsPerRoom) return null;
    }
    const id = crypto.randomUUID();
    await this.sql.execute('INSERT INTO sessions (id, room, label, scenario, created, arrival, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, room, label, scenario, now, arrival ? JSON.stringify(arrival) : null, now]);
    if (arrival) await this.addEvent(room, id, 'arrival', arrival, now);
    return id;
  }

  /**
   * Integration package: a session whose id the caller derives from its own authenticated session, so
   * every tab of one login reports under one OneHuman session. Idempotent; no per-room limit.
   */
  async ensureSession(id: string, room: string, arrival: ServerSignal | null, now = Date.now()): Promise<SessionRow> {
    const existing = await this.getSession(id);
    if (existing) return existing;
    await this.sql.execute('INSERT OR IGNORE INTO sessions (id, room, label, scenario, created, arrival, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, room, 'unlabelled', '', now, arrival ? JSON.stringify(arrival) : null, now]);
    if (arrival) await this.addEvent(room, id, 'arrival', arrival, now);
    return (await this.getSession(id))!;
  }

  async getSession(id: string): Promise<SessionRow | null> {
    const r = (await this.sql.execute('SELECT * FROM sessions WHERE id = ?', [id])).rows[0];
    return r ? this.rowToSession(r) : null;
  }

  async listSessions(room: string): Promise<SessionRow[]> {
    return (await this.sql.execute('SELECT * FROM sessions WHERE room = ? ORDER BY created ASC', [room])).rows.map((r) => this.rowToSession(r));
  }

  /**
   * A request in this session. After a pause longer than VISIT_IDLE_MS a new visit starts clean: an agent that was
   * attached in an earlier visit no longer marks this one (a session tied to a login would otherwise stay "agent"
   * for good). An agent that is still attached is seen again at once from the page's next signal.
   */
  async touchSession(id: string, now = Date.now()) {
    await this.sql.execute(`UPDATE sessions SET
        agent_attached_at = CASE WHEN ? - last_seen > ? THEN NULL ELSE agent_attached_at END,
        agent_attached_client_ms = CASE WHEN ? - last_seen > ? THEN NULL ELSE agent_attached_client_ms END,
        last_seen = ? WHERE id = ?`, [now, VISIT_IDLE_MS, now, VISIT_IDLE_MS, now, id]);
  }

  async markFirstData(id: string, now: number) {
    await this.sql.execute('UPDATE sessions SET first_data_at = COALESCE(first_data_at, ?) WHERE id = ?', [now, id]);
  }

  async markFirstAgent(id: string, now: number) {
    await this.sql.execute('UPDATE sessions SET first_agent_at = COALESCE(first_agent_at, ?) WHERE id = ?', [now, id]);
  }

  /** Returns true the first time the session is marked (so callers can emit the attach event once). */
  async markAgentAttached(id: string, now: number, clientMs: number | null): Promise<boolean> {
    const r = await this.sql.execute('UPDATE sessions SET agent_attached_at = ?, agent_attached_client_ms = ? WHERE id = ? AND agent_attached_at IS NULL', [now, clientMs, id]);
    return r.rowsAffected > 0;
  }

  /**
   * A browser's evidence moves with it when it logs in: the page script reported to the browser's own session before
   * the login was known, and the login's session must not start blind. Copies the newest page snapshot (if it is newer
   * than any the login's session has) and an earlier agent attachment. Only evidence moves, never a person's clicks.
   */
  async carryOverEvidence(from: string, to: string, now = Date.now(), windowMs = VISIT_IDLE_MS): Promise<boolean> {
    if (from === to) return false;
    const src = await this.getSession(from);
    const dst = await this.getSession(to);
    if (!src || !dst || src.room !== dst.room) return false;
    const newest = async (s: string) => (await this.sql.execute("SELECT id, payload, created FROM events WHERE session = ? AND kind = 'signal' ORDER BY id DESC LIMIT 1", [s])).rows[0];
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

  async markHumanVerified(session: string, now = Date.now()) {
    await this.sql.execute('UPDATE sessions SET human_verified_at = ? WHERE id = ?', [now, session]);
  }

  private rowToSession(r: Record<string, unknown>): SessionRow {
    return {
      id: r.id as string,
      room: r.room as string,
      label: r.label as SessionRow['label'],
      scenario: (r.scenario as string | null) ?? '',
      created: Number(r.created),
      arrival: r.arrival ? (JSON.parse(r.arrival as string) as ServerSignal) : null,
      firstDataAt: r.first_data_at == null ? null : Number(r.first_data_at),
      firstAgentAt: r.first_agent_at == null ? null : Number(r.first_agent_at),
      agentAttachedAt: r.agent_attached_at == null ? null : Number(r.agent_attached_at),
      agentAttachedClientMs: r.agent_attached_client_ms == null ? null : Number(r.agent_attached_client_ms),
      humanVerifiedAt: r.human_verified_at == null ? null : Number(r.human_verified_at),
      lastSeen: Number(r.last_seen),
    };
  }

  // --- events --------------------------------------------------------------
  async addEvent(room: string, session: string, kind: EventRow['kind'], payload: unknown, now = Date.now()): Promise<number> {
    const res = await this.sql.execute('INSERT INTO events (room, session, kind, payload, created) VALUES (?, ?, ?, ?, ?)', [room, session, kind, JSON.stringify(payload), now]);
    const L = this.limits;
    if (L.eventsPerRoom !== null && ++this.roomTrims % 20 === 1) await this.sql.execute('DELETE FROM events WHERE room = ? AND id NOT IN (SELECT id FROM events WHERE room = ? ORDER BY id DESC LIMIT ?)', [room, room, L.eventsPerRoom]);
    // per session: an indexed look at this session only, never a scan of everyone's events
    if (L.eventsPerSession !== null) await this.sql.execute('DELETE FROM events WHERE session = ? AND id < (SELECT id FROM events WHERE session = ? ORDER BY id DESC LIMIT 1 OFFSET ?)', [session, session, L.eventsPerSession - 1]);
    // by age: now and then, not on every insert
    if (L.eventMaxAgeMs !== null && ++this.inserts % 500 === 1) await this.sql.execute('DELETE FROM events WHERE created < ?', [now - L.eventMaxAgeMs]);
    return res.lastInsertRowid ?? 0;
  }

  /** Latest early signal and last N interaction samples inside the behavioral window. */
  async hasEvent(session: string, kind: EventRow['kind']): Promise<boolean> {
    return (await this.sql.execute('SELECT 1 FROM events WHERE session = ? AND kind = ? LIMIT 1', [session, kind])).rows.length > 0;
  }
  async recentSignals(session: string, now = Date.now(), windowMs = 120000, limit = 5): Promise<{ early: ClientSnapshot['early']; interactions: NonNullable<ClientSnapshot['interaction']>[] }> {
    const rows = (await this.sql.execute("SELECT kind, payload FROM events WHERE session = ? AND kind IN ('signal','interaction') AND created > ? ORDER BY id DESC LIMIT 60", [session, now - windowMs])).rows as { kind: string; payload: string }[];
    let early: ClientSnapshot['early'] = null;
    const interactions: NonNullable<ClientSnapshot['interaction']>[] = [];
    for (const r of rows) {
      const p = JSON.parse(r.payload);
      if (r.kind === 'signal' && !early) early = p;
      if (r.kind === 'interaction' && interactions.length < limit) interactions.push(p);
    }
    if (!early) {
      const last = (await this.sql.execute("SELECT payload FROM events WHERE session = ? AND kind = 'signal' ORDER BY id DESC LIMIT 1", [session])).rows[0] as { payload: string } | undefined;
      if (last) early = JSON.parse(last.payload);
    }
    return { early, interactions: interactions.reverse() };
  }

  async listEvents(room: string, limit = 200): Promise<EventRow[]> {
    return (await this.sql.execute('SELECT * FROM events WHERE room = ? ORDER BY id DESC LIMIT ?', [room, limit])).rows.map((r) => ({
      id: Number(r.id),
      room: r.room as string,
      session: r.session as string,
      kind: r.kind as EventRow['kind'],
      payload: JSON.parse(r.payload as string),
      created: Number(r.created),
    }));
  }

  // --- decisions (hash-chained audit) -------------------------------------
  async lastDecision(room: string): Promise<{ seq: number; hash: string }> {
    const r = (await this.sql.execute('SELECT seq, hash FROM decisions WHERE room = ? ORDER BY seq DESC LIMIT 1', [room])).rows[0];
    return r ? { seq: Number(r.seq), hash: r.hash as string } : { seq: 0, hash: 'genesis' };
  }

  // --- chain anchors (RFC 3161 timestamps of a chain head) ------------------
  /** The head of every chain: the newest decision per room. */
  async chainHeads(): Promise<{ room: string; seq: number; hash: string }[]> {
    const r = await this.sql.execute('SELECT d.room AS room, d.seq AS seq, d.hash AS hash FROM decisions d JOIN (SELECT room, MAX(seq) AS seq FROM decisions GROUP BY room) m ON m.room = d.room AND m.seq = d.seq');
    return r.rows.map((x) => ({ room: String(x.room), seq: Number(x.seq), hash: String(x.hash) }));
  }
  async lastAnchor(room: string): Promise<{ seq: number; created: number } | null> {
    const r = (await this.sql.execute('SELECT seq, created FROM anchors WHERE room = ? ORDER BY seq DESC LIMIT 1', [room])).rows[0];
    return r ? { seq: Number(r.seq), created: Number(r.created) } : null;
  }
  async addAnchor(a: { room: string; seq: number; hash: string; tsa: string; request: string; response: string; created: number }) {
    await this.sql.execute('INSERT OR IGNORE INTO anchors (room, seq, hash, tsa, request, response, created) VALUES (?, ?, ?, ?, ?, ?, ?)', [a.room, a.seq, a.hash, a.tsa, a.request, a.response, a.created]);
  }
  async listAnchors(limit = 1000): Promise<{ room: string; seq: number; hash: string; tsa: string; request: string; response: string; created: number }[]> {
    const r = await this.sql.execute('SELECT room, seq, hash, tsa, request, response, created FROM anchors ORDER BY created DESC LIMIT ?', [limit]);
    return r.rows.map((x) => ({ room: String(x.room), seq: Number(x.seq), hash: String(x.hash), tsa: String(x.tsa), request: String(x.request), response: String(x.response), created: Number(x.created) }));
  }

  async insertDecision(row: DecisionRow, seq: number, proof: string | null = null) {
    const { room, session, created, prevHash, hash, ...body } = row;
    await this.sql.execute('INSERT INTO decisions (id, room, session, seq, body, created, prev_hash, hash, proof) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [row.id, room, session, seq, JSON.stringify(body), created, prevHash, hash, proof]);
  }

  private rowToDecision(r: Record<string, unknown>): DecisionRow & { seq: number } {
    return {
      ...(JSON.parse(r.body as string) as Omit<DecisionRow, 'room' | 'session' | 'created' | 'prevHash' | 'hash'>),
      room: r.room as string,
      session: r.session as string,
      seq: Number(r.seq),
      created: Number(r.created),
      prevHash: r.prev_hash as string,
      hash: r.hash as string,
    };
  }

  /** The signed proof of one decision (proof.ts). Kept out of rowToDecision: it is not part of the hashed body. */
  async decisionProof(id: string): Promise<string | null> {
    const r = (await this.sql.execute('SELECT proof FROM decisions WHERE id = ?', [id])).rows[0];
    return r && typeof r.proof === 'string' ? r.proof : null;
  }
  /** Every signed decision of one session, oldest first — what a business hands an auditor about one customer. */
  async sessionProofs(session: string, limit = 5000): Promise<{ id: string; seq: number; proof: string }[]> {
    const r = await this.sql.execute('SELECT id, seq, proof FROM decisions WHERE session = ? AND proof IS NOT NULL ORDER BY created, seq LIMIT ?', [session, limit]);
    return r.rows.map((x) => ({ id: String(x.id), seq: Number(x.seq), proof: String(x.proof) }));
  }

  /**
   * The light fields of every real decision in a time range, for reports: read with json_extract so a month of
   * decisions does not load each assessment. `room` null = every room in this database.
   */
  async decisionsBetween(from: number, to: number, room: string | null = null): Promise<{ session: string; created: number; resource: string; decision: string; computed: string; actor: string; enforced: boolean; branch: string; tools: string[]; signed: boolean; policyVersion: string }[]> {
    const rows = (await this.sql.execute(`SELECT session, created, json_extract(body,'$.resource') AS resource, json_extract(body,'$.decision') AS decision,
      json_extract(body,'$.computed') AS computed, json_extract(body,'$.actor') AS actor, json_extract(body,'$.enforced') AS enforced, json_extract(body,'$.branch') AS branch,
      json_extract(body,'$.tools') AS tools, json_extract(body,'$.policyVersion') AS pv, proof IS NOT NULL AS signed
      FROM decisions WHERE created >= ? AND created < ? AND COALESCE(json_extract(body,'$.simulated'), 0) = 0${room ? ' AND room = ?' : ''} ORDER BY created`, room ? [from, to, room] : [from, to])).rows;
    return rows.map((r) => ({
      session: String(r.session), created: Number(r.created), resource: String(r.resource ?? ''), decision: String(r.decision ?? 'allow'),
      computed: String(r.computed ?? r.decision ?? 'allow'), actor: String(r.actor ?? 'unknown'), enforced: Number(r.enforced) === 1 || r.enforced === true,
      branch: String(r.branch ?? ''), tools: safeList(r.tools ?? '[]'), signed: Number(r.signed) === 1, policyVersion: String(r.pv ?? ''),
    }));
  }
  /** agent products seen per session from the connection record, for decisions made before tools were stored on them */
  async attachToolsBetween(from: number, to: number): Promise<Map<string, string[]>> {
    const rows = (await this.sql.execute("SELECT session, json_extract(payload,'$.tools') AS tools FROM events WHERE kind = 'attach' AND created >= ? AND created < ?", [from, to])).rows;
    const out = new Map<string, string[]>();
    for (const r of rows) out.set(String(r.session), [...new Set([...(out.get(String(r.session)) ?? []), ...safeList(r.tools ?? '[]')])]);
    return out;
  }

  async listDecisions(room: string, limit = 300): Promise<(DecisionRow & { seq: number })[]> {
    return (await this.sql.execute('SELECT * FROM decisions WHERE room = ? ORDER BY seq DESC LIMIT ?', [room, limit])).rows.map((r) => this.rowToDecision(r));
  }

  async getDecision(id: string): Promise<(DecisionRow & { seq: number }) | null> {
    const r = (await this.sql.execute('SELECT * FROM decisions WHERE id = ?', [id])).rows[0];
    return r ? this.rowToDecision(r) : null;
  }

  // --- policies ------------------------------------------------------------
  async savePolicy(room: string, policy: Policy, now = Date.now()) {
    await this.sql.execute('INSERT INTO policies (room, version, body, created) VALUES (?, ?, ?, ?)', [room, policy.version, JSON.stringify(policy), now]);
  }

  async currentPolicy(room: string): Promise<Policy | null> {
    const r = (await this.sql.execute('SELECT body FROM policies WHERE room = ? ORDER BY created DESC, rowid DESC LIMIT 1', [room])).rows[0];
    return r ? (JSON.parse(r.body as string) as Policy) : null;
  }

  async policyHistory(room: string): Promise<{ version: string; created: number; enforcement: string }[]> {
    return (await this.sql.execute('SELECT version, created, body FROM policies WHERE room = ? ORDER BY created DESC LIMIT 50', [room])).rows.map((r) => ({
      version: r.version as string,
      created: Number(r.created),
      enforcement: (JSON.parse(r.body as string) as Policy).enforcement,
    }));
  }

  // --- the server's own copy of the portal policy (engine side) --------------------------------------
  /** The last signed envelope this server accepted from the portal, the portal key it pinned, and the file hash it last proposed. */
  async policyCache(tag: string): Promise<{ envelope: string; pinnedKey: string; fetched: number; pushedFileHash: string | null } | null> {
    const r = (await this.sql.execute('SELECT envelope, pinned_key, fetched, pushed_file_hash FROM policy_cache WHERE tag = ?', [tag])).rows[0];
    return r ? { envelope: String(r.envelope), pinnedKey: String(r.pinned_key), fetched: Number(r.fetched), pushedFileHash: r.pushed_file_hash == null ? null : String(r.pushed_file_hash) } : null;
  }
  async putPolicyCache(tag: string, c: { envelope: string; pinnedKey: string; fetched: number }) {
    await this.sql.execute(`INSERT INTO policy_cache (tag, envelope, pinned_key, fetched) VALUES (?, ?, ?, ?)
      ON CONFLICT(tag) DO UPDATE SET envelope = excluded.envelope, pinned_key = excluded.pinned_key, fetched = excluded.fetched`, [tag, c.envelope, c.pinnedKey, c.fetched]);
  }
  async setPolicyCachePushed(tag: string, fileHash: string, pinnedKey: string) {
    const r = await this.sql.execute('UPDATE policy_cache SET pushed_file_hash = ? WHERE tag = ?', [fileHash, tag]);
    if (!r.rowsAffected) await this.sql.execute('INSERT INTO policy_cache (tag, envelope, pinned_key, fetched, pushed_file_hash) VALUES (?, ?, ?, 0, ?)', [tag, '', pinnedKey, fileHash]);
  }

  // --- nonces (replay protection for signatures and tokens) ---------------
  /** Returns true when the key was fresh (and is now consumed). */
  async consumeNonce(key: string, ttlMs: number, now = Date.now()): Promise<boolean> {
    await this.sql.execute('DELETE FROM nonces WHERE expires < ?', [now]);
    try {
      await this.sql.execute('INSERT INTO nonces (key, expires) VALUES (?, ?)', [key, now + ttlMs]);
      return true;
    } catch {
      return false;
    }
  }

  // --- WebAuthn credentials & challenges ----------------------------------
  async saveCredential(room: string, session: string, cred: { id: string }, now = Date.now()) {
    await this.sql.execute('INSERT OR REPLACE INTO credentials (id, room, session, body, created) VALUES (?, ?, ?, ?, ?)', [cred.id, room, session, JSON.stringify(cred), now]);
  }

  /** Passkeys registered in this room. */
  async credentialsForRoom<T>(room: string): Promise<T[]> {
    return (await this.sql.execute('SELECT body FROM credentials WHERE room = ? ORDER BY created DESC', [room])).rows.map((r) => JSON.parse(r.body as string) as T);
  }

  /** Passkeys registered by one session (in a deployment with identify(), one login). */
  async credentialsForSession<T>(session: string): Promise<T[]> {
    return (await this.sql.execute('SELECT body FROM credentials WHERE session = ? ORDER BY created DESC', [session])).rows.map((r) => JSON.parse(r.body as string) as T);
  }

  async getCredential<T>(id: string): Promise<T | null> {
    const r = (await this.sql.execute('SELECT body FROM credentials WHERE id = ?', [id])).rows[0];
    return r ? (JSON.parse(r.body as string) as T) : null;
  }

  /** Where a credential was registered: its room and session. */
  async credentialOwner(id: string): Promise<{ room: string; session: string } | null> {
    const r = (await this.sql.execute('SELECT room, session FROM credentials WHERE id = ?', [id])).rows[0];
    return r ? { room: String(r.room), session: String(r.session) } : null;
  }

  async updateCredential(cred: { id: string }) {
    await this.sql.execute('UPDATE credentials SET body = ? WHERE id = ?', [JSON.stringify(cred), cred.id]);
  }

  async createChallenge(id: string, session: string, kind: ChallengeKind, resource: string | null, ttlMs: number, now = Date.now()) {
    await this.sql.execute('DELETE FROM challenges WHERE expires < ?', [now]);
    await this.sql.execute('INSERT INTO challenges (id, session, kind, resource, expires) VALUES (?, ?, ?, ?, ?)', [id, session, kind, resource, now + ttlMs]);
  }

  /** Single use: returns the challenge row and deletes it. */
  async consumeChallenge(id: string, session: string, kind: ChallengeKind | readonly ChallengeKind[], now = Date.now()): Promise<{ resource: string | null; kind: string } | null> {
    const kinds = typeof kind === 'string' ? [kind] : [...kind];
    const r = (await this.sql.execute(`SELECT resource, expires, kind FROM challenges WHERE id = ? AND session = ? AND kind IN (${kinds.map(() => '?').join(', ')})`, [id, session, ...kinds])).rows[0] as { resource: string | null; expires: number; kind: string } | undefined;
    await this.sql.execute('DELETE FROM challenges WHERE id = ?', [id]);
    if (!r || Number(r.expires) < now) return null;
    return { resource: r.resource, kind: String(r.kind) };
  }

  // --- the owner's choices for their own agent -------------------------------
  /** Unexpired choices for a scope, newest first. */
  async agentAccess(scope: string, now = Date.now()): Promise<AgentAccess[]> {
    const r = await this.sql.execute('SELECT resource, choice, until, by_whom, created FROM agent_access WHERE scope = ? AND (until IS NULL OR until > ?) ORDER BY created DESC', [scope, now]);
    return r.rows.map((x) => ({ resource: String(x.resource), choice: String(x.choice) as AgentAccess['choice'], until: x.until == null ? null : Number(x.until), by: String(x.by_whom), created: Number(x.created) }));
  }
  async agentAccessFor(scope: string, resource: string, now = Date.now()): Promise<AgentAccess | null> {
    const r = (await this.sql.execute('SELECT resource, choice, until, by_whom, created FROM agent_access WHERE scope = ? AND resource = ? AND (until IS NULL OR until > ?)', [scope, resource, now])).rows[0];
    return r ? { resource: String(r.resource), choice: String(r.choice) as AgentAccess['choice'], until: r.until == null ? null : Number(r.until), by: String(r.by_whom), created: Number(r.created) } : null;
  }
  /** Set (or with choice null, clear) the owner's choice for one resource. */
  async setAgentAccess(scope: string, resource: string, choice: AgentAccess['choice'] | null, until: number | null, by: string, now = Date.now()) {
    if (choice === null) { await this.sql.execute('DELETE FROM agent_access WHERE scope = ? AND resource = ?', [scope, resource]); return; }
    await this.sql.execute('INSERT INTO agent_access (scope, resource, choice, until, by_whom, created) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(scope, resource) DO UPDATE SET choice = excluded.choice, until = excluded.until, by_whom = excluded.by_whom, created = excluded.created', [scope, resource, choice, until, by, now]);
  }

  // --- step-up -------------------------------------------------------------
  /**
   * Grant one resource without a challenge or a held request: any one request to it passes once. For an app that
   * verifies the person its own way (its own OTP). OneHuman's own confirmations pass the held step-up instead
   * (passStepUp), which covers only the request that was held.
   */
  async grantStepUp(session: string, resource: string, ttlMs: number, now = Date.now()) {
    await this.sql.execute('INSERT INTO stepups (id, session, resource, challenge, expires, passed) VALUES (?, ?, ?, ?, ?, 1)', [crypto.randomUUID(), session, resource, 'webauthn', now + ttlMs]);
  }

  /** A held request: `digest` names exactly that request (method, path, body), `summary` is what the person is shown. */
  async createStepUp(session: string, resource: string, challenge: string, ttlMs: number, now = Date.now(), bind: { digest?: string | null; summary?: string | null } = {}): Promise<string> {
    const id = crypto.randomUUID();
    await this.sql.execute('INSERT INTO stepups (id, session, resource, challenge, expires, digest, summary) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, session, resource, challenge, now + ttlMs, bind.digest ?? null, bind.summary ?? null]);
    return id;
  }

  async getStepUp(id: string): Promise<StepUpRow | null> {
    const r = (await this.sql.execute('SELECT * FROM stepups WHERE id = ?', [id])).rows[0];
    return r ? stepUpRow(r) : null;
  }

  /** Requests of this session to this resource still waiting for the person, newest first. */
  async pendingStepUps(session: string, resource: string, now = Date.now()): Promise<StepUpRow[]> {
    return (await this.sql.execute('SELECT * FROM stepups WHERE session = ? AND resource = ? AND passed = 0 AND expires > ? ORDER BY expires DESC LIMIT 20', [session, resource, now])).rows.map(stepUpRow);
  }

  /** The person confirmed this held request; `until` gives them time to repeat it. */
  async passStepUp(id: string, until?: number) {
    if (until == null) await this.sql.execute('UPDATE stepups SET passed = 1 WHERE id = ?', [id]);
    else await this.sql.execute('UPDATE stepups SET passed = 1, expires = MAX(expires, ?) WHERE id = ?', [until, id]);
  }

  /**
   * A passed, unexpired grant for this session and resource that covers this request, consumed on use: one bound to
   * the same request (`digest`), or one an app granted for the resource as a whole (grantStepUp, no digest).
   */
  async consumeStepUpGrant(session: string, resource: string, now = Date.now(), digest: string | null = null): Promise<boolean> {
    const r = (await this.sql.execute('SELECT id FROM stepups WHERE session = ? AND resource = ? AND passed = 1 AND expires > ? AND (digest IS NULL OR digest = ?) ORDER BY expires DESC LIMIT 1', [session, resource, now, digest])).rows[0];
    if (!r) return false;
    await this.sql.execute('DELETE FROM stepups WHERE id = ?', [r.id as string]);
    return true;
  }
}
