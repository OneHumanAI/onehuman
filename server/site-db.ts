// SPDX-License-Identifier: BUSL-1.1
/**
 * The website's own storage (onehuman.ai): portal accounts and keys, telemetry the middleware reports, portal-managed
 * policies, the sandbox's pointer samples, visits and rate limits. It extends the engine's Store on the same database;
 * the engine itself never needs any of it.
 */
import { Store, safeList, type StoreLimits } from './db.ts';

export const MAX_SESSIONS_PER_ROOM = 400;
export const MAX_EVENTS_PER_ROOM = 2000;
/** the demo rooms cap each room: a public demo must not grow without bound */
export const LAB_LIMITS: StoreLimits = { sessionsPerRoom: MAX_SESSIONS_PER_ROOM, eventsPerRoom: MAX_EVENTS_PER_ROOM, eventsPerSession: null, eventMaxAgeMs: null };
import { sqliteClient, type Row, type SqlArg, type SqlClient } from './sql.ts';

const SITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS portal_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account TEXT NOT NULL,
  at INTEGER NOT NULL,
  resource TEXT NOT NULL,
  action TEXT NOT NULL,
  tools TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS portal_alerts_account ON portal_alerts (account, at);
-- customer portal: an account owns API keys; each key is a project the middleware reports into
CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, pass TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS portal_sessions (id TEXT PRIMARY KEY, account TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  created INTEGER NOT NULL,
  revoked INTEGER,
  last_seen INTEGER,
  events INTEGER NOT NULL DEFAULT 0,
  expires INTEGER,
  env TEXT NOT NULL DEFAULT 'production'
);
-- management keys: an agent or a CI job administers the account with one of these
CREATE TABLE IF NOT EXISTS admin_keys (
  id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  created INTEGER NOT NULL,
  revoked INTEGER,
  last_seen INTEGER,
  calls INTEGER NOT NULL DEFAULT 0
);
-- what the middleware reports: one row per decision, metadata only (no payloads, no identities)
CREATE TABLE IF NOT EXISTS telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  session TEXT NOT NULL,
  resource TEXT NOT NULL,
  decision TEXT NOT NULL,
  actor TEXT NOT NULL,
  state TEXT NOT NULL,
  tools TEXT NOT NULL,
  reasons TEXT NOT NULL,
  enforcement TEXT NOT NULL,
  version TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS telemetry_key_at ON telemetry (key_id, at);
CREATE TABLE IF NOT EXISTS key_policies (
  key_id TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  body TEXT NOT NULL,
  updated INTEGER NOT NULL,
  require_approval INTEGER NOT NULL DEFAULT 0,
  confirm_weakening INTEGER NOT NULL DEFAULT 1,
  last_file_hash TEXT,
  seen_version TEXT,
  seen_source TEXT,
  seen_at INTEGER
);
CREATE TABLE IF NOT EXISTS policy_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  origin TEXT NOT NULL,
  status TEXT NOT NULL,
  from_n INTEGER,
  to_n INTEGER,
  body TEXT,
  summary TEXT NOT NULL,
  weakening TEXT,
  decided_by TEXT,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS policy_changes_key ON policy_changes (key_id, id);
CREATE TABLE IF NOT EXISTS key_resources (
  key_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (key_id, resource)
);
CREATE TABLE IF NOT EXISTS signature_bundles (
  seq INTEGER PRIMARY KEY,
  jws TEXT NOT NULL,
  issued INTEGER NOT NULL,
  added INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS assist_log (
  account TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS assist_log_account ON assist_log (account, at);
CREATE TABLE IF NOT EXISTS samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client TEXT NOT NULL,
  label TEXT NOT NULL,
  source TEXT NOT NULL,
  task TEXT NOT NULL,
  ua TEXT NOT NULL,
  click TEXT NOT NULL,
  features TEXT NOT NULL,
  verdict TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS samples_label ON samples(label, created);
CREATE INDEX IF NOT EXISTS samples_client ON samples(client, id);
CREATE TABLE IF NOT EXISTS training_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client TEXT NOT NULL,
  label TEXT NOT NULL,
  source TEXT NOT NULL,
  ua TEXT NOT NULL,
  early TEXT NOT NULL,
  steps TEXT NOT NULL,
  summary TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS training_sessions_client ON training_sessions(client);
-- visits to this website (onehuman.ai itself, not customers' apps): pages and state-changing API calls, for the
-- operators' view. No raw IP and no raw user agent: a keyed hash of both, plus browser/OS family and country.
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  device TEXT NOT NULL,
  account TEXT,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  status INTEGER NOT NULL,
  ms INTEGER NOT NULL,
  browser TEXT NOT NULL,
  os TEXT NOT NULL,
  mobile INTEGER NOT NULL,
  bot INTEGER NOT NULL,
  country TEXT,
  city TEXT,
  referrer TEXT
);
CREATE INDEX IF NOT EXISTS visits_at ON visits(at);
CREATE INDEX IF NOT EXISTS visits_device ON visits(device, at);
-- rate-limit counters shared by every serverless instance (server/limits.ts)
CREATE TABLE IF NOT EXISTS rate_limits (key TEXT NOT NULL, win INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (key, win));
-- the free 30-day agent report: when an account started, when its app first reported, when the first agent came;
-- legacy = the account existed before these e-mails did, so it gets no welcome or set-up mails after the fact
CREATE TABLE IF NOT EXISTS account_meta (
  account TEXT PRIMARY KEY,
  started INTEGER NOT NULL,
  legacy INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  connected_at INTEGER,
  first_agent_at INTEGER,
  email_off INTEGER NOT NULL DEFAULT 0
);
-- a key's statistics shared with another account (read only); an owner invites by e-mail, the invite is accepted once
CREATE TABLE IF NOT EXISTS key_shares (key_id TEXT NOT NULL, account TEXT NOT NULL, role TEXT NOT NULL, invited_by TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (key_id, account));
CREATE INDEX IF NOT EXISTS key_shares_account ON key_shares (account);
CREATE TABLE IF NOT EXISTS key_invites (id TEXT PRIMARY KEY, key_id TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL, invited_by TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, accepted_at INTEGER, accepted_by TEXT);
CREATE INDEX IF NOT EXISTS key_invites_key ON key_invites (key_id);
-- connecting an app from the command line: \`npx onehumanai init\` asks for a code, the person approves it in the portal,
-- the CLI picks up the new key once (kept sealed with the server's secret until then, minutes at most)
CREATE TABLE IF NOT EXISTS connect_requests (id TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, origin TEXT, status TEXT NOT NULL, account TEXT, key_id TEXT, sealed TEXT, created INTEGER NOT NULL, expires INTEGER NOT NULL, decided_at INTEGER);
CREATE INDEX IF NOT EXISTS connect_requests_code ON connect_requests (code);
-- the public repo scan (/scan): one row per scan; an e-mail address makes it a lead and unlocks the full map
CREATE TABLE IF NOT EXISTS repo_scans (id TEXT PRIMARY KEY, repo TEXT NOT NULL, created INTEGER NOT NULL, result TEXT NOT NULL, client TEXT, email TEXT, unlocked_at INTEGER);
CREATE INDEX IF NOT EXISTS repo_scans_unlocked ON repo_scans (unlocked_at);
-- plans and usage. The unit is an agent-active customer: one of the account's signed-in customers in whose session
-- an AI agent acted, counted once a calendar month (usage_marks). billing_ledger keeps every change to a balance.
CREATE TABLE IF NOT EXISTS billing (account TEXT PRIMARY KEY, plan TEXT NOT NULL DEFAULT 'free', balance_cents INTEGER NOT NULL DEFAULT 0, note TEXT, updated INTEGER NOT NULL, notified TEXT, requested TEXT, requested_at INTEGER, over_since INTEGER, over_month TEXT);
CREATE TABLE IF NOT EXISTS usage_marks (account TEXT NOT NULL, month TEXT NOT NULL, session TEXT NOT NULL, key_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'pending', cents INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account, month, session));
CREATE TABLE IF NOT EXISTS billing_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, at INTEGER NOT NULL, cents INTEGER NOT NULL, kind TEXT NOT NULL, note TEXT, by_whom TEXT);
CREATE INDEX IF NOT EXISTS billing_ledger_account ON billing_ledger (account, at);
-- the website chat: one conversation per visitor (its token is kept hashed), answered by the assistant until a person takes over
CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, created INTEGER NOT NULL, last_at INTEGER NOT NULL, status TEXT NOT NULL, page TEXT, country TEXT, device TEXT, email TEXT, messages INTEGER NOT NULL DEFAULT 0, unread INTEGER NOT NULL DEFAULT 0, preview TEXT, notified_at INTEGER, human_asked_at INTEGER);
CREATE INDEX IF NOT EXISTS chats_last ON chats (last_at);
CREATE TABLE IF NOT EXISTS chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat TEXT NOT NULL, at INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, author TEXT);
CREATE INDEX IF NOT EXISTS chat_messages_chat ON chat_messages (chat, id);
-- every e-mail once: (account, kind, ref) is claimed before sending, so two cron runs never send it twice
CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  at INTEGER NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  provider_id TEXT,
  error TEXT,
  UNIQUE (account, kind, ref)
);
`;
/** The newest column of each migrated site table. */
const SITE_MARKERS: [string, string][] = [['telemetry', 'feedback_at'], ['api_keys', 'proof_keys'], ['key_policies', 'seen_at'], ['policy_changes', 'decided_at'], ['key_resources', 'last_seen'], ['assist_log', 'at'], ['telemetry', 'computed'], ['signature_bundles', 'added'], ['visits', 'referrer'], ['rate_limits', 'n'], ['portal_alerts', 'seen'], ['account_meta', 'email_off'], ['email_log', 'error'], ['accounts', 'firebase_uid'], ['key_shares', 'invited_by'], ['key_invites', 'accepted_by'], ['chats', 'human_asked_at'], ['chat_messages', 'author'], ['billing', 'over_month'], ['usage_marks', 'cents'], ['billing_ledger', 'by_whom'], ['connect_requests', 'decided_at'], ['repo_scans', 'unlocked_at']];
const SITE_MIGRATIONS = [
  'ALTER TABLE billing ADD COLUMN over_since INTEGER',
  'ALTER TABLE billing ADD COLUMN over_month TEXT',
  'ALTER TABLE api_keys ADD COLUMN expires INTEGER',
  "ALTER TABLE api_keys ADD COLUMN env TEXT NOT NULL DEFAULT 'production'",
  'ALTER TABLE telemetry ADD COLUMN proof TEXT',
  'ALTER TABLE telemetry ADD COLUMN proof_kid TEXT',
  'ALTER TABLE telemetry ADD COLUMN proof_ok INTEGER',
  'ALTER TABLE api_keys ADD COLUMN proof_keys TEXT',
  'ALTER TABLE telemetry ADD COLUMN eid TEXT',
  'CREATE UNIQUE INDEX IF NOT EXISTS telemetry_eid ON telemetry (key_id, eid)',
  'ALTER TABLE telemetry ADD COLUMN feedback TEXT',
  'ALTER TABLE telemetry ADD COLUMN feedback_note TEXT',
  'ALTER TABLE telemetry ADD COLUMN feedback_at INTEGER',
  'ALTER TABLE telemetry ADD COLUMN computed TEXT',
  // sign-in through Firebase Authentication: the Firebase user behind an account (accounts copied in keep their id as uid)
  'ALTER TABLE accounts ADD COLUMN firebase_uid TEXT',
  'CREATE UNIQUE INDEX IF NOT EXISTS accounts_firebase_uid ON accounts (firebase_uid)',
];

export type KeyPolicyRow = {
  keyId: string; n: number; body: unknown; updated: number; requireApproval: boolean; confirmWeakening: boolean;
  lastFileHash: string | null; seen: { version: string; source: string; at: number } | null;
};
export type PolicyChangeRow = {
  id: number; at: number; actor: string; origin: string; status: string; fromN: number | null; toN: number | null;
  body: unknown; summary: string[]; weakening: string[]; decidedBy: string | null; decidedAt: number | null;
};
export type ApiKeyRow = { id: string; name: string; prefix: string; created: number; revoked: number | null; lastSeen: number | null; events: number; expires: number | null; env: string };
const apiKeyRow = (x: Row): ApiKeyRow => ({ id: String(x.id), name: String(x.name), prefix: String(x.prefix), created: Number(x.created), revoked: x.revoked == null ? null : Number(x.revoked), lastSeen: x.last_seen == null ? null : Number(x.last_seen), events: Number(x.events), expires: x.expires == null ? null : Number(x.expires), env: String(x.env ?? 'production') });

export type TelemetryEvent = { at: number; session: string; resource: string; decision: string;
  /** what the rules chose — in observe mode `decision` is allow and this is what protect mode would have done */
  computed?: string | null; actor: string; state: string; tools: string[]; reasons: string[]; enforcement: string; version: string;
  /** signed decision proof (compact JWS), its key id, and whether the signature checked out at ingest */
  proof?: string | null; proofKid?: string | null; proofOk?: boolean | null;
  /** the reporter's id for this event: a retried batch carries the same ids, so nothing is counted twice */
  eid?: string | null;
  /** whether the session belongs to a signed-in customer (identify()); undefined from reporters older than 0.7.5 */
  login?: boolean | null };
export type TelemetryStats = {
  decisions: Record<string, number>;
  actors: Record<string, number>;
  states: Record<string, number>;
  resources: { resource: string; decision: string; n: number }[];
  tools: { tool: string; sessions: number }[];
  sessions: { total: number; agent: number };
  /**
   * Sessions by what they turned out to be, judged over the whole session: an agent at any point, else a person once
   * the signals showed one; the rest by why it stayed open (no browser data at all: an API call or an app; only one
   * or two actions: too early; enough actions, no clear signal: unclear).
   */
  people: { agent: number; human: number; noData: number; early: number; unclear: number };
  series: { t: number; n: number; agent: number; gated: number }[];
  recent: { id: number; at: number; session: string; resource: string; decision: string; actor: string; state: string; tools: string[]; reasons: string[]; enforcement: string; signed: boolean | null; feedback: string | null; verdict: SessionVerdict }[];
};
export type SessionVerdict = 'agent' | 'human' | 'no_data' | 'early' | 'unclear';
/** per app of a key's resources named <prefix><app>.<resource> (the site's demos: demo.bank.balance.read) */
export type TelemetryApps = { app: string; sessions: number; agent: number; events: number; gated: number }[];

export type TelemetryHealth = {
  events: number;
  /** newest reported event, any range */
  last: number | null;
  sessions: number;
  /** sessions whose decisions had browser-SDK signals behind them */
  sdkSessions: number;
  proofs: number;
  proofsOk: number;
  enforcement: string | null;
  version: string | null;
  people: { sessions: number; stopped: number; engineStopped: number; gradedWrong: number; askedToConfirm: number; askedSessions: number };
  agents: { sessions: number; gated: number };
};

export type TelemetryWeek = {
  decisions: number; sessions: number; agentSessions: number; agentGated: number; peopleStopped: number; stepUps: number; signed: number;
  tools: { tool: string; sessions: number }[];
  agentResources: { resource: string; n: number; gated: number }[];
};

export type TelemetryOverview = {
  series: { key: string; t: number; n: number; agent: number; gated: number }[];
  totals: { key: string; n: number; sessions: number; agentSessions: number; gated: number; last: number }[];
};

/** owner: made the key; editor: shared, sees statistics and manages the rules; viewer: shared, statistics only */
export type KeyRole = 'owner' | 'viewer' | 'editor';
export type SharedKeyRow = ApiKeyRow & { owner: string; role: KeyRole };
export type ConnectRow = { id: string; code: string; name: string; origin: string | null; status: 'pending' | 'approved' | 'denied' | 'used'; account: string | null; keyId: string | null; sealed: string | null; created: number; expires: number; decidedAt: number | null };
export const connectRow = (x: Row): ConnectRow => ({ id: String(x.id), code: String(x.code), name: String(x.name), origin: x.origin == null ? null : String(x.origin), status: String(x.status) as ConnectRow['status'], account: x.account == null ? null : String(x.account), keyId: x.key_id == null ? null : String(x.key_id), sealed: x.sealed == null ? null : String(x.sealed), created: Number(x.created), expires: Number(x.expires), decidedAt: x.decided_at == null ? null : Number(x.decided_at) });
export type RepoScanRow = { id: string; repo: string; created: number; result: unknown; client: string | null; email: string | null; unlockedAt: number | null };
export const repoScanRow = (x: Row): RepoScanRow => { let result: unknown = null; try { result = JSON.parse(String(x.result)); } catch { /* keep null */ } return { id: String(x.id), repo: String(x.repo), created: Number(x.created), result, client: x.client == null ? null : String(x.client), email: x.email == null ? null : String(x.email), unlockedAt: x.unlocked_at == null ? null : Number(x.unlocked_at) }; };
export type KeyInviteRow = { id: string; keyId: string; email: string; role: KeyRole; invitedBy: string; created: number; expires: number; acceptedAt: number | null; acceptedBy: string | null };
const inviteRow = (x: Row): KeyInviteRow => ({ id: String(x.id), keyId: String(x.key_id), email: String(x.email), role: String(x.role) as KeyRole, invitedBy: String(x.invited_by), created: Number(x.created), expires: Number(x.expires), acceptedAt: x.accepted_at == null ? null : Number(x.accepted_at), acceptedBy: x.accepted_by == null ? null : String(x.accepted_by) });
export type ChatStatus = 'ai' | 'human' | 'closed';
export type BillingRow = { account: string; plan: string; balanceCents: number; note: string | null; updated: number; notified: string | null; requested: string | null; requestedAt: number | null; overSince: number | null; overMonth: string | null };
export const billingRow = (x: Row | undefined, account: string): BillingRow => x
  ? { account, plan: String(x.plan ?? 'free'), balanceCents: Number(x.balance_cents ?? 0), note: x.note == null ? null : String(x.note), updated: Number(x.updated ?? 0), notified: x.notified == null ? null : String(x.notified), requested: x.requested == null ? null : String(x.requested), requestedAt: x.requested_at == null ? null : Number(x.requested_at), overSince: x.over_since == null ? null : Number(x.over_since), overMonth: x.over_month == null ? null : String(x.over_month) }
  : { account, plan: 'free', balanceCents: 0, note: null, updated: 0, notified: null, requested: null, requestedAt: null, overSince: null, overMonth: null };
/** fields of a billing row a caller may change, by their column names */
export type BillingPatch = Partial<{ plan: string; note: string | null; notified: string | null; requested: string | null; requested_at: number | null; over_since: number | null; over_month: string | null }>;
/** one month's agent-active customers by how they were counted: included, paid (from a balance), unpaid, overage, over */
export type UsageCounts = { total: number; kinds: Record<string, number>; cents: number };
export type LedgerRow = { id: number; at: number; cents: number; kind: string; note: string | null; by: string | null };

export type ChatRow = { id: string; tokenHash: string; created: number; lastAt: number; status: ChatStatus; page: string | null; country: string | null; device: string | null; email: string | null; messages: number; unread: number; preview: string | null; notifiedAt: number | null; humanAskedAt: number | null };
export type ChatMessageRow = { id: number; chat: string; at: number; role: 'visitor' | 'ai' | 'admin' | 'system'; text: string; author: string | null };
export const chatRow = (x: Row): ChatRow => ({ id: String(x.id), tokenHash: String(x.token_hash), created: Number(x.created), lastAt: Number(x.last_at), status: String(x.status) as ChatStatus, page: x.page == null ? null : String(x.page), country: x.country == null ? null : String(x.country), device: x.device == null ? null : String(x.device), email: x.email == null ? null : String(x.email), messages: Number(x.messages ?? 0), unread: Number(x.unread ?? 0), preview: x.preview == null ? null : String(x.preview), notifiedAt: x.notified_at == null ? null : Number(x.notified_at), humanAskedAt: x.human_asked_at == null ? null : Number(x.human_asked_at) });
export const chatMessageRow = (x: Row): ChatMessageRow => ({ id: Number(x.id), chat: String(x.chat), at: Number(x.at), role: String(x.role) as ChatMessageRow['role'], text: String(x.text), author: x.author == null ? null : String(x.author) });
/** chat fields a caller may change, by their column names */
export type ChatPatch = Partial<{ status: ChatStatus; email: string | null; unread: number; notified_at: number | null; human_asked_at: number | null }>;
export type AccountMeta = { account: string; started: number; legacy: boolean; source: string | null; connectedAt: number | null; firstAgentAt: number | null; emailOff: boolean };
const accountMeta = (x: Row): AccountMeta => ({ account: String(x.account), started: Number(x.started), legacy: !!Number(x.legacy), source: x.source == null ? null : String(x.source), connectedAt: x.connected_at == null ? null : Number(x.connected_at), firstAgentAt: x.first_agent_at == null ? null : Number(x.first_agent_at), emailOff: !!Number(x.email_off) });
/** an agent in a telemetry row: the actor, or a named tool */
const AGENT_ROW = "(actor = 'agent_likely' OR tools <> '[]')";

export class SiteStore extends Store {
  /** demo rooms this device opened since `since` — a cheap brake on scripted room creation */
  async roomsByDevice(device: string, since: number): Promise<number> {
    return Number((await this.sql.execute('SELECT COUNT(*) AS n FROM rooms WHERE device = ? AND created >= ?', [device, since])).rows[0]?.n ?? 0);
  }

  static override async open(client?: SqlClient, opts: { migrate?: boolean; limits?: StoreLimits } = {}): Promise<SiteStore> {
    const c = client ?? (await sqliteClient(':memory:'));
    await Store.prepare(c, opts);
    const probe = (await c.execute(`SELECT
      (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('accounts','api_keys','admin_keys','telemetry','samples','visits')) AS tables,
      ${SITE_MARKERS.map(([t, col]) => `(SELECT COUNT(*) FROM pragma_table_info('${t}') WHERE name='${col}')`).join(' + ')} AS columns`)).rows[0] ?? {};
    if (Number(probe.tables) !== 6 || Number(probe.columns) !== SITE_MARKERS.length || opts.migrate) {
      await c.executeMultiple(SITE_SCHEMA);
      for (const m of SITE_MIGRATIONS) { try { await c.execute(m); } catch { /* column exists */ } }
    }
    return new SiteStore(c, opts.limits ?? LAB_LIMITS);
  }


  async addVisit(v: { at: number; device: string; account: string | null; method: string; path: string; kind: string; status: number; ms: number; browser: string; os: string; mobile: boolean; bot: boolean; country: string | null; city: string | null; referrer: string | null }, keepMs: number): Promise<void> {
    await this.sql.execute('INSERT INTO visits (at, device, account, method, path, kind, status, ms, browser, os, mobile, bot, country, city, referrer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [v.at, v.device, v.account, v.method, v.path, v.kind, v.status, v.ms, v.browser, v.os, v.mobile ? 1 : 0, v.bot ? 1 : 0, v.country, v.city, v.referrer]);
    if (Math.random() < 0.01) await this.sql.execute('DELETE FROM visits WHERE at < ?', [v.at - keepMs]);
  }
  /** count one hit on `key` in the current window of `windowMs`; returns the count so far */
  async hitLimit(key: string, windowMs: number, now = Date.now()): Promise<number> {
    const win = Math.floor(now / windowMs) * windowMs;   // the window's start time
    const r = await this.sql.execute('INSERT INTO rate_limits (key, win, n) VALUES (?, ?, 1) ON CONFLICT (key, win) DO UPDATE SET n = n + 1 RETURNING n', [key, win]);
    if (Math.random() < 0.005) await this.sql.execute('DELETE FROM rate_limits WHERE win < ?', [now - 2 * 86400000]).catch(() => {});
    return Number(r.rows[0]?.n ?? 1);
  }
  /** read-only reporting query for the admin panel (/admin-panel); `_since` is the report's start (a store that loads rows for SQL loads from it) */
  async report(sqlText: string, args: SqlArg[] = [], _since: number | null = null): Promise<Row[]> {
    return (await this.sql.execute(sqlText, args)).rows as Row[];
  }
  async addPortalAlert(a: { account: string; at: number; resource: string; action: string; tools: string[] }) {
    await this.sql.execute('INSERT INTO portal_alerts (account, at, resource, action, tools) VALUES (?, ?, ?, ?, ?)', [a.account, a.at, a.resource, a.action.slice(0, 120), JSON.stringify(a.tools.slice(0, 8))]);
  }
  async listPortalAlerts(account: string, since: number, limit = 50): Promise<{ id: number; at: number; resource: string; action: string; tools: string[]; seen: boolean }[]> {
    const r = await this.sql.execute('SELECT id, at, resource, action, tools, seen FROM portal_alerts WHERE account = ? AND at >= ? ORDER BY at DESC LIMIT ?', [account, since, limit]);
    return r.rows.map((x) => ({ id: Number(x.id), at: Number(x.at), resource: String(x.resource), action: String(x.action), tools: (() => { try { return JSON.parse(String(x.tools)) as string[]; } catch { return []; } })(), seen: Number(x.seen) === 1 }));
  }
  async markPortalAlertsSeen(account: string) {
    await this.sql.execute('UPDATE portal_alerts SET seen = 1 WHERE account = ? AND seen = 0', [account]);
  }
  async addSample(row: { client: string; label: string; source: string; task: string; ua: string; click: unknown; features: unknown; verdict: string }, now = Date.now()): Promise<number> {
    const r = await this.sql.execute('INSERT INTO samples (client, label, source, task, ua, click, features, verdict, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [row.client, row.label, row.source, row.task, row.ua, JSON.stringify(row.click), JSON.stringify(row.features), row.verdict, now]);
    return Number(r.lastInsertRowid ?? 0);
  }
  async sampleStats(): Promise<{ label: string; source: string; verdict: string; n: number }[]> {
    const r = await this.sql.execute('SELECT label, source, verdict, COUNT(*) AS n FROM samples GROUP BY label, source, verdict ORDER BY label, source, verdict');
    return r.rows.map((x) => ({ label: String(x.label), source: String(x.source), verdict: String(x.verdict), n: Number(x.n) }));
  }
  async clientSamples(client: string): Promise<{ id: number; task: string; verdict: string; features: unknown; created: number }[]> {
    const r = await this.sql.execute('SELECT id, task, verdict, features, created FROM samples WHERE client = ? ORDER BY id', [client]);
    return r.rows.map((x) => ({ id: Number(x.id), task: String(x.task), verdict: String(x.verdict), features: JSON.parse(String(x.features)), created: Number(x.created) }));
  }
  async listSamples(label: string | null, limit = 5000): Promise<{ id: number; client: string; label: string; source: string; task: string; ua: string; click: unknown; features: unknown; verdict: string; created: number }[]> {
    const r = label
      ? await this.sql.execute('SELECT * FROM samples WHERE label = ? ORDER BY id DESC LIMIT ?', [label, limit])
      : await this.sql.execute('SELECT * FROM samples ORDER BY id DESC LIMIT ?', [limit]);
    return r.rows.map((x) => ({ id: Number(x.id), client: String(x.client), label: String(x.label), source: String(x.source), task: String(x.task), ua: String(x.ua), click: JSON.parse(String(x.click)), features: JSON.parse(String(x.features)), verdict: String(x.verdict), created: Number(x.created) }));
  }
  async addTrainingSession(row: { client: string; label: string; source: string; ua: string; early: unknown; steps: unknown; summary: unknown }, now = Date.now()): Promise<number> {
    const r = await this.sql.execute('INSERT INTO training_sessions (client, label, source, ua, early, steps, summary, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [row.client, row.label, row.source, row.ua, JSON.stringify(row.early), JSON.stringify(row.steps), JSON.stringify(row.summary), now]);
    return Number(r.lastInsertRowid ?? 0);
  }
  async listTrainingSessions(limit = 500): Promise<{ id: number; client: string; label: string; source: string; ua: string; early: unknown; steps: unknown; summary: unknown; created: number }[]> {
    const r = await this.sql.execute('SELECT * FROM training_sessions ORDER BY id DESC LIMIT ?', [limit]);
    return r.rows.map((x) => ({ id: Number(x.id), client: String(x.client), label: String(x.label), source: String(x.source), ua: String(x.ua), early: JSON.parse(String(x.early)), steps: JSON.parse(String(x.steps)), summary: JSON.parse(String(x.summary)), created: Number(x.created) }));
  }
  async createAccount(email: string, passHash: string, now = Date.now()): Promise<string | null> {
    const id = crypto.randomUUID();
    try { await this.sql.execute('INSERT INTO accounts (id, email, pass, created) VALUES (?, ?, ?, ?)', [id, email, passHash, now]); } catch { return null; }
    return id;
  }
  async accountByEmail(email: string): Promise<{ id: string; email: string; pass: string; created: number } | null> {
    const r = await this.sql.execute('SELECT id, email, pass, created FROM accounts WHERE email = ?', [email]);
    const x = r.rows[0]; return x ? { id: String(x.id), email: String(x.email), pass: String(x.pass), created: Number(x.created) } : null;
  }
  async setAccountPassword(id: string, passHash: string): Promise<boolean> {
    const r = await this.sql.execute('UPDATE accounts SET pass = ? WHERE id = ?', [passHash, id]);
    return r.rowsAffected > 0;
  }
  /** the account a Firebase user signs in to */
  async accountByFirebaseUid(uid: string): Promise<{ id: string; email: string; created: number } | null> {
    const x = (await this.sql.execute('SELECT id, email, created FROM accounts WHERE firebase_uid = ?', [uid])).rows[0];
    return x ? { id: String(x.id), email: String(x.email), created: Number(x.created) } : null;
  }
  async linkFirebaseUid(id: string, uid: string): Promise<void> {
    await this.sql.execute('UPDATE accounts SET firebase_uid = ? WHERE id = ?', [uid, id]);
  }
  async accountById(id: string): Promise<{ id: string; email: string; created: number } | null> {
    const r = await this.sql.execute('SELECT id, email, created FROM accounts WHERE id = ?', [id]);
    const x = r.rows[0]; return x ? { id: String(x.id), email: String(x.email), created: Number(x.created) } : null;
  }
  // ---------------------------------------------------------------- the 30-day report and its e-mails
  /** creates the row once; `legacy` marks an account that is older than the e-mails */
  async ensureAccountMeta(account: string, m: { started: number; legacy: boolean; source?: string | null }): Promise<void> {
    await this.sql.execute('INSERT OR IGNORE INTO account_meta (account, started, legacy, source) VALUES (?, ?, ?, ?)', [account, m.started, m.legacy ? 1 : 0, m.source ?? null]);
  }
  async accountMeta(account: string): Promise<AccountMeta | null> {
    const x = (await this.sql.execute('SELECT * FROM account_meta WHERE account = ?', [account])).rows[0];
    return x ? accountMeta(x) : null;
  }
  /** true only for the call that set it: the first report from the account's app */
  async markAccountConnected(account: string, at: number): Promise<boolean> {
    return (await this.sql.execute('UPDATE account_meta SET connected_at = ? WHERE account = ? AND connected_at IS NULL', [at, account])).rowsAffected > 0;
  }
  /** true only for the call that set it: the first AI agent in the account's app */
  async markAccountFirstAgent(account: string, at: number): Promise<boolean> {
    return (await this.sql.execute('UPDATE account_meta SET first_agent_at = ? WHERE account = ? AND first_agent_at IS NULL', [at, account])).rowsAffected > 0;
  }
  async setEmailOff(account: string, off: boolean): Promise<void> {
    await this.sql.execute('UPDATE account_meta SET email_off = ? WHERE account = ?', [off ? 1 : 0, account]);
  }
  /** every account with its report state (accounts older than the e-mails have no row yet: meta is null) */
  async lifecycleAccounts(): Promise<{ id: string; email: string; created: number; meta: AccountMeta | null }[]> {
    const r = await this.sql.execute('SELECT a.id AS id, a.email AS email, a.created AS created, m.* FROM accounts a LEFT JOIN account_meta m ON m.account = a.id');
    return r.rows.map((x) => ({ id: String(x.id), email: String(x.email), created: Number(x.created), meta: x.started == null ? null : accountMeta({ ...x, account: x.id }) }));
  }
  /** the first decision any of the account's keys reported, and the first one with an AI agent in it */
  async accountFirsts(account: string): Promise<{ first: number | null; firstAgent: number | null }> {
    const r = (await this.sql.execute(`SELECT
      (SELECT MIN(t.at) FROM telemetry t JOIN api_keys k ON k.id = t.key_id WHERE k.account = ?) AS first,
      (SELECT MIN(t.at) FROM telemetry t JOIN api_keys k ON k.id = t.key_id WHERE k.account = ? AND ${AGENT_ROW.replace(/actor|tools/g, (c) => `t.${c}`)}) AS agent`, [account, account])).rows[0] ?? {};
    return { first: r.first == null ? null : Number(r.first), firstAgent: r.agent == null ? null : Number(r.agent) };
  }
  /** the decisions of all the account's keys in a period, for the report builder */
  async accountDecisions(account: string, from: number, to: number) {
    const keys = await this.listApiKeys(account);
    const rows = (await Promise.all(keys.map((k) => this.telemetryDecisions(k.id, from, to)))).flat();
    return { rows, apps: keys.filter((k) => !k.revoked).map((k) => k.name) };
  }
  /**
   * Claim an e-mail before sending it. A new (account, kind, ref) is claimed once; a failed one is retried up to
   * three times; one stuck in "sending" for an hour (the function died) is taken over. Anything else: not yours.
   */
  async claimEmail(account: string, kind: string, ref: string, now = Date.now()): Promise<boolean> {
    if ((await this.sql.execute("INSERT OR IGNORE INTO email_log (account, kind, ref, at, status) VALUES (?, ?, ?, ?, 'sending')", [account, kind, ref, now])).rowsAffected > 0) return true;
    return (await this.sql.execute("UPDATE email_log SET status = 'sending', at = ?, attempts = attempts + 1 WHERE account = ? AND kind = ? AND ref = ? AND attempts < 3 AND (status = 'failed' OR (status = 'sending' AND at < ?))", [now, account, kind, ref, now - 3600e3])).rowsAffected > 0;
  }
  async finishEmail(account: string, kind: string, ref: string, status: 'sent' | 'failed' | 'skipped', providerId: string | null, error: string | null): Promise<void> {
    await this.sql.execute('UPDATE email_log SET status = ?, provider_id = ?, error = ? WHERE account = ? AND kind = ? AND ref = ?', [status, providerId, error ? error.slice(0, 300) : null, account, kind, ref]);
  }
  /** for the operators: what went out lately */
  async recentEmails(limit = 100): Promise<{ account: string; kind: string; ref: string; at: number; status: string; attempts: number; error: string | null }[]> {
    const r = await this.sql.execute('SELECT account, kind, ref, at, status, attempts, error FROM email_log ORDER BY at DESC LIMIT ?', [limit]);
    return r.rows.map((x) => ({ account: String(x.account), kind: String(x.kind), ref: String(x.ref), at: Number(x.at), status: String(x.status), attempts: Number(x.attempts), error: x.error == null ? null : String(x.error) }));
  }
  async createPortalSession(account: string, ttlMs: number, now = Date.now()): Promise<string> {
    const id = crypto.randomUUID();
    await this.sql.batch([
      { sql: 'DELETE FROM portal_sessions WHERE expires < ?', args: [now] },
      { sql: 'INSERT INTO portal_sessions (id, account, expires) VALUES (?, ?, ?)', args: [id, account, now + ttlMs] },
    ]);
    return id;
  }
  async portalSession(id: string, now = Date.now()): Promise<string | null> {
    const r = await this.sql.execute('SELECT account FROM portal_sessions WHERE id = ? AND expires > ?', [id, now]);
    return r.rows[0] ? String(r.rows[0].account) : null;
  }
  async deletePortalSession(id: string) { await this.sql.execute('DELETE FROM portal_sessions WHERE id = ?', [id]); }
  /** after a password change: every other sign-in of the account ends */
  async deleteOtherPortalSessions(account: string, keep: string) { await this.sql.execute('DELETE FROM portal_sessions WHERE account = ? AND id <> ?', [account, keep]); }
  async createApiKey(account: string, key: { name: string; prefix: string; hash: string; expires?: number | null; env?: string }, now = Date.now()): Promise<string> {
    const id = crypto.randomUUID();
    await this.sql.execute('INSERT INTO api_keys (id, account, name, prefix, hash, created, expires, env) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, account, key.name, key.prefix, key.hash, now, key.expires ?? null, key.env ?? 'production']);
    return id;
  }
  async listApiKeys(account: string): Promise<ApiKeyRow[]> {
    const r = await this.sql.execute('SELECT id, name, prefix, created, revoked, last_seen, events, expires, env FROM api_keys WHERE account = ? ORDER BY created', [account]);
    return r.rows.map(apiKeyRow);
  }
  async apiKeyById(id: string, account: string): Promise<ApiKeyRow | null> {
    const r = await this.sql.execute('SELECT id, name, prefix, created, revoked, last_seen, events, expires, env FROM api_keys WHERE id = ? AND account = ?', [id, account]);
    return r.rows[0] ? apiKeyRow(r.rows[0]) : null;
  }
  /** find the key a raw string belongs to — the portal's "paste a key" search; the hash never leaves here */
  async apiKeyIdByHash(hash: string, account: string): Promise<string | null> {
    const r = await this.sql.execute('SELECT id FROM api_keys WHERE hash = ? AND account = ?', [hash, account]);
    return r.rows[0] ? String(r.rows[0].id) : null;
  }
  async renameApiKey(id: string, account: string, name: string): Promise<boolean> {
    const r = await this.sql.execute('UPDATE api_keys SET name = ? WHERE id = ? AND account = ?', [name, id, account]);
    return r.rowsAffected > 0;
  }
  async apiKeyByHash(hash: string): Promise<{ id: string; account: string; revoked: number | null; expires: number | null } | null> {
    const r = await this.sql.execute('SELECT id, account, revoked, expires FROM api_keys WHERE hash = ?', [hash]);
    const x = r.rows[0];
    return x ? { id: String(x.id), account: String(x.account), revoked: x.revoked == null ? null : Number(x.revoked), expires: x.expires == null ? null : Number(x.expires) } : null;
  }
  async createAdminKey(account: string, name: string, prefix: string, hash: string, now = Date.now()): Promise<string> {
    const id = crypto.randomUUID();
    await this.sql.execute('INSERT INTO admin_keys (id, account, name, prefix, hash, created) VALUES (?, ?, ?, ?, ?, ?)', [id, account, name, prefix, hash, now]);
    return id;
  }
  async listAdminKeys(account: string): Promise<{ id: string; name: string; prefix: string; created: number; revoked: number | null; lastSeen: number | null; calls: number }[]> {
    const r = await this.sql.execute('SELECT id, name, prefix, created, revoked, last_seen, calls FROM admin_keys WHERE account = ? ORDER BY created', [account]);
    return r.rows.map((x) => ({ id: String(x.id), name: String(x.name), prefix: String(x.prefix), created: Number(x.created), revoked: x.revoked == null ? null : Number(x.revoked), lastSeen: x.last_seen == null ? null : Number(x.last_seen), calls: Number(x.calls) }));
  }
  async adminKeyByHash(hash: string): Promise<{ id: string; account: string; revoked: number | null } | null> {
    const r = await this.sql.execute('SELECT id, account, revoked FROM admin_keys WHERE hash = ?', [hash]);
    const x = r.rows[0]; return x ? { id: String(x.id), account: String(x.account), revoked: x.revoked == null ? null : Number(x.revoked) } : null;
  }
  async touchAdminKey(id: string, now = Date.now()) {
    await this.sql.execute('UPDATE admin_keys SET last_seen = ?, calls = calls + 1 WHERE id = ?', [now, id]);
  }
  async revokeAdminKey(id: string, account: string, now = Date.now()): Promise<boolean> {
    const r = await this.sql.execute('UPDATE admin_keys SET revoked = ? WHERE id = ? AND account = ? AND revoked IS NULL', [now, id, account]);
    return r.rowsAffected > 0;
  }
  async apiKeyOwned(id: string, account: string): Promise<boolean> {
    const r = await this.sql.execute('SELECT 1 FROM api_keys WHERE id = ? AND account = ?', [id, account]);
    return r.rows.length > 0;
  }
  // ---------------------------------------------------------------- the website chat
  async createChat(c: { id: string; tokenHash: string; page: string | null; country: string | null; device: string | null }, now = Date.now()): Promise<void> {
    await this.sql.execute("INSERT INTO chats (id, token_hash, created, last_at, status, page, country, device) VALUES (?, ?, ?, ?, 'ai', ?, ?, ?)", [c.id, c.tokenHash, now, now, c.page, c.country, c.device]);
  }
  async chatById(id: string): Promise<ChatRow | null> {
    const r = (await this.sql.execute('SELECT * FROM chats WHERE id = ?', [id])).rows[0];
    return r ? chatRow(r) : null;
  }
  async updateChat(id: string, patch: ChatPatch): Promise<void> {
    const cols = Object.keys(patch) as (keyof ChatPatch)[];
    if (cols.length) await this.sql.execute(`UPDATE chats SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => patch[c] ?? null), id]);
  }
  /** newest activity first */
  async listChats(limit = 100): Promise<ChatRow[]> {
    return (await this.sql.execute('SELECT * FROM chats ORDER BY last_at DESC LIMIT ?', [limit])).rows.map(chatRow);
  }
  /** a message, and the chat's last activity, count and preview; a visitor's message is unread until a person opens the chat */
  async addChatMessage(chat: string, role: ChatMessageRow['role'], text: string, author: string | null, now = Date.now()): Promise<number> {
    const r = await this.sql.execute('INSERT INTO chat_messages (chat, at, role, text, author) VALUES (?, ?, ?, ?, ?)', [chat, now, role, text, author]);
    await this.sql.execute(`UPDATE chats SET last_at = ?, messages = messages + 1, preview = ?${role === 'visitor' ? ', unread = unread + 1' : ''} WHERE id = ?`, [now, `${role === 'visitor' ? '' : role === 'ai' ? 'AI: ' : role === 'admin' ? 'You: ' : ''}${text}`.slice(0, 140), chat]);
    return Number(r.lastInsertRowid);
  }
  async chatMessages(chat: string, afterId = 0, limit = 300): Promise<ChatMessageRow[]> {
    return (await this.sql.execute('SELECT * FROM chat_messages WHERE chat = ? AND id > ? ORDER BY id LIMIT ?', [chat, afterId, limit])).rows.map(chatMessageRow);
  }
  /** chats quiet since `before` go, with their messages (the trust page promises 12 months) */
  async pruneChats(before: number): Promise<number> {
    const old = (await this.sql.execute('SELECT id FROM chats WHERE last_at < ? LIMIT 50', [before])).rows.map((r) => String(r.id));
    for (const id of old) {
      await this.sql.execute('DELETE FROM chat_messages WHERE chat = ?', [id]);
      await this.sql.execute('DELETE FROM chats WHERE id = ?', [id]);
    }
    return old.length;
  }

  // ---------------------------------------------------------------- plans and usage (server/billing.ts decides; this only stores)
  async billingFor(account: string): Promise<BillingRow> {
    return billingRow((await this.sql.execute('SELECT * FROM billing WHERE account = ?', [account])).rows[0], account);
  }
  async setBilling(account: string, patch: BillingPatch, now = Date.now()): Promise<void> {
    await this.sql.execute('INSERT OR IGNORE INTO billing (account, updated) VALUES (?, ?)', [account, now]);
    const cols = Object.keys(patch) as (keyof BillingPatch)[];
    await this.sql.execute(`UPDATE billing SET ${[...cols.map((c) => `${c} = ?`), 'updated = ?'].join(', ')} WHERE account = ?`, [...cols.map((c) => patch[c] ?? null), now, account]);
  }
  /** add to (or with a negative amount take from) a balance, with a ledger line; returns the new balance */
  async addBalance(account: string, cents: number, kind: string, note: string | null, by: string | null, now = Date.now()): Promise<number> {
    await this.sql.execute('INSERT OR IGNORE INTO billing (account, updated) VALUES (?, ?)', [account, now]);
    await this.sql.batch([
      { sql: 'UPDATE billing SET balance_cents = balance_cents + ?, updated = ? WHERE account = ?', args: [Math.round(cents), now, account] },
      { sql: 'INSERT INTO billing_ledger (account, at, cents, kind, note, by_whom) VALUES (?, ?, ?, ?, ?, ?)', args: [account, now, Math.round(cents), kind, note, by] },
    ]);
    return (await this.billingFor(account)).balanceCents;
  }
  /** take `cents` from the balance only if it holds that much; true when taken */
  async debitBalance(account: string, cents: number, now = Date.now()): Promise<boolean> {
    const r = await this.sql.execute('UPDATE billing SET balance_cents = balance_cents - ?, updated = ? WHERE account = ? AND balance_cents >= ?', [cents, now, account, cents]);
    return r.rowsAffected > 0;
  }
  async billingLedger(account: string, limit = 20): Promise<LedgerRow[]> {
    const r = await this.sql.execute('SELECT * FROM billing_ledger WHERE account = ? ORDER BY id DESC LIMIT ?', [account, limit]);
    return r.rows.map((x) => ({ id: Number(x.id), at: Number(x.at), cents: Number(x.cents), kind: String(x.kind), note: x.note == null ? null : String(x.note), by: x.by_whom == null ? null : String(x.by_whom) }));
  }
  /** count these sessions for the month (once each); returns the ones that were new */
  async addUsageMarks(account: string, month: string, keyId: string, sessions: string[], now = Date.now()): Promise<string[]> {
    const fresh: string[] = [];
    for (const s of sessions) {
      const r = await this.sql.execute("INSERT OR IGNORE INTO usage_marks (account, month, session, key_id, at, kind) VALUES (?, ?, ?, ?, ?, 'pending')", [account, month, s, keyId, now]);
      if (r.rowsAffected > 0) fresh.push(s);
    }
    return fresh;
  }
  async setUsageMark(account: string, month: string, session: string, kind: string, cents: number): Promise<void> {
    await this.sql.execute('UPDATE usage_marks SET kind = ?, cents = ? WHERE account = ? AND month = ? AND session = ?', [kind, cents, account, month, session]);
  }
  async usageCounts(account: string, month: string): Promise<UsageCounts> {
    const r = await this.sql.execute('SELECT kind, COUNT(*) AS n, SUM(cents) AS c FROM usage_marks WHERE account = ? AND month = ? GROUP BY kind', [account, month]);
    const kinds: Record<string, number> = {};
    let total = 0, cents = 0;
    for (const x of r.rows) { kinds[String(x.kind)] = Number(x.n); total += Number(x.n); cents += Number(x.c ?? 0); }
    return { total, kinds, cents };
  }
  async usageMarksOfKind(account: string, month: string, kind: string, limit = 5000): Promise<string[]> {
    return (await this.sql.execute('SELECT session FROM usage_marks WHERE account = ? AND month = ? AND kind = ? ORDER BY at LIMIT ?', [account, month, kind, limit])).rows.map((x) => String(x.session));
  }
  /** every account with a plan row or usage this month, for the admin panel */
  async billingAccounts(month: string): Promise<string[]> {
    const r = await this.sql.execute('SELECT account FROM billing UNION SELECT DISTINCT account FROM usage_marks WHERE month = ?', [month]);
    return r.rows.map((x) => String(x.account));
  }
  /** the newest signature bundle issued at or before `t` (what a plan without live signatures gets) */
  async signatureBundleIssuedBefore(t: number): Promise<{ seq: number; jws: string; issued: number } | null> {
    const r = (await this.sql.execute('SELECT seq, jws, issued FROM signature_bundles WHERE issued <= ? ORDER BY seq DESC LIMIT 1', [t])).rows[0];
    return r ? { seq: Number(r.seq), jws: String(r.jws), issued: Number(r.issued) } : null;
  }

  // ---------------------------------------------------------------- a key shared with other accounts (read only)
  /** owner: the account that created the key; viewer: an account it was shared with; null: neither */
  async keyRole(keyId: string, account: string): Promise<KeyRole | null> {
    if (await this.apiKeyOwned(keyId, account)) return 'owner';
    const r = await this.sql.execute('SELECT role FROM key_shares WHERE key_id = ? AND account = ?', [keyId, account]);
    return r.rows[0] ? (String(r.rows[0].role) as KeyRole) : null;
  }
  async addKeyShare(keyId: string, account: string, role: KeyRole, invitedBy: string, now = Date.now()): Promise<void> {
    await this.sql.execute('INSERT INTO key_shares (key_id, account, role, invited_by, created) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key_id, account) DO UPDATE SET role = excluded.role', [keyId, account, role, invitedBy, now]);
  }
  async removeKeyShare(keyId: string, account: string): Promise<boolean> {
    return (await this.sql.execute('DELETE FROM key_shares WHERE key_id = ? AND account = ?', [keyId, account])).rowsAffected > 0;
  }
  /** who else sees this key */
  async keyShares(keyId: string): Promise<{ account: string; email: string; role: KeyRole; created: number }[]> {
    const r = await this.sql.execute('SELECT s.account AS account, a.email AS email, s.role AS role, s.created AS created FROM key_shares s JOIN accounts a ON a.id = s.account WHERE s.key_id = ? ORDER BY s.created', [keyId]);
    return r.rows.map((x) => ({ account: String(x.account), email: String(x.email), role: String(x.role) as KeyRole, created: Number(x.created) }));
  }
  /** the keys other accounts shared with this one, with their owner's e-mail */
  async sharedKeys(account: string): Promise<SharedKeyRow[]> {
    const r = await this.sql.execute('SELECT k.id, k.name, k.prefix, k.created, k.revoked, k.last_seen, k.events, k.expires, k.env, a.email AS owner, s.role AS role FROM key_shares s JOIN api_keys k ON k.id = s.key_id JOIN accounts a ON a.id = k.account WHERE s.account = ? ORDER BY s.created', [account]);
    return r.rows.map((x) => ({ ...apiKeyRow(x), owner: String(x.owner), role: String(x.role) as KeyRole }));
  }
  // ---------------------------------------------------------------- connecting an app from the command line
  async createConnect(c: { id: string; code: string; name: string; origin: string | null; expires: number }, now = Date.now()): Promise<void> {
    await this.sql.execute('INSERT INTO connect_requests (id, code, name, origin, status, created, expires) VALUES (?, ?, ?, ?, ?, ?, ?)', [c.id, c.code, c.name, c.origin, 'pending', now, c.expires]);
  }
  async connectById(id: string): Promise<ConnectRow | null> {
    const r = (await this.sql.execute('SELECT * FROM connect_requests WHERE id = ?', [id])).rows[0];
    return r ? connectRow(r) : null;
  }
  /** the newest request with this code that is still waiting (codes are short; an old one may repeat) */
  async connectByCode(code: string, now = Date.now()): Promise<ConnectRow | null> {
    const r = (await this.sql.execute("SELECT * FROM connect_requests WHERE code = ? AND expires > ? ORDER BY created DESC LIMIT 1", [code, now])).rows[0];
    return r ? connectRow(r) : null;
  }
  /** approve (with the new key, sealed) or deny a request still waiting; false when it was not */
  async decideConnect(id: string, d: { status: 'approved' | 'denied'; account: string; keyId?: string | null; sealed?: string | null }, now = Date.now()): Promise<boolean> {
    return (await this.sql.execute("UPDATE connect_requests SET status = ?, account = ?, key_id = ?, sealed = ?, decided_at = ? WHERE id = ? AND status = 'pending' AND expires > ?", [d.status, d.account, d.keyId ?? null, d.sealed ?? null, now, id, now])).rowsAffected > 0;
  }
  /** the CLI picks up an approved key: once, and the sealed copy is gone after */
  async takeConnect(id: string, now = Date.now()): Promise<ConnectRow | null> {
    const row = await this.connectById(id);
    if (!row || row.status !== 'approved' || !row.sealed) return null;
    const ok = (await this.sql.execute("UPDATE connect_requests SET status = 'used', sealed = NULL WHERE id = ? AND status = 'approved'", [id])).rowsAffected > 0;
    return ok && row.expires + 10 * 60_000 > now ? row : null;
  }

  // ---------------------------------------------------------------- the public repo scan
  async addRepoScan(r: { id: string; repo: string; result: unknown; client: string | null }, now = Date.now()): Promise<void> {
    await this.sql.execute('INSERT INTO repo_scans (id, repo, created, result, client) VALUES (?, ?, ?, ?, ?)', [r.id, r.repo, now, JSON.stringify(r.result), r.client]);
  }
  async repoScanById(id: string): Promise<RepoScanRow | null> {
    const r = (await this.sql.execute('SELECT * FROM repo_scans WHERE id = ?', [id])).rows[0];
    return r ? repoScanRow(r) : null;
  }
  /** an e-mail address unlocks the full map; false when the scan is gone */
  async unlockRepoScan(id: string, email: string, now = Date.now()): Promise<boolean> {
    return (await this.sql.execute('UPDATE repo_scans SET email = ?, unlocked_at = ? WHERE id = ?', [email, now, id])).rowsAffected > 0;
  }
  /** scans that left an e-mail address, newest first: the inbound leads */
  async repoScanLeads(limit = 100): Promise<RepoScanRow[]> {
    return (await this.sql.execute('SELECT * FROM repo_scans WHERE unlocked_at IS NOT NULL ORDER BY unlocked_at DESC LIMIT ?', [limit])).rows.map(repoScanRow);
  }

  async createKeyInvite(i: { id: string; keyId: string; email: string; role: KeyRole; invitedBy: string; expires: number }, now = Date.now()): Promise<void> {
    await this.sql.execute('INSERT INTO key_invites (id, key_id, email, role, invited_by, created, expires) VALUES (?, ?, ?, ?, ?, ?, ?)', [i.id, i.keyId, i.email, i.role, i.invitedBy, now, i.expires]);
  }
  async keyInvite(id: string): Promise<KeyInviteRow | null> {
    const r = await this.sql.execute('SELECT * FROM key_invites WHERE id = ?', [id]);
    return r.rows[0] ? inviteRow(r.rows[0]) : null;
  }
  /** pending invites of a key (not accepted, not expired) */
  async keyInvites(keyId: string, now = Date.now()): Promise<KeyInviteRow[]> {
    const r = await this.sql.execute('SELECT * FROM key_invites WHERE key_id = ? AND accepted_at IS NULL AND expires > ? ORDER BY created', [keyId, now]);
    return r.rows.map(inviteRow);
  }
  /** true only for the call that accepted it */
  async acceptKeyInvite(id: string, account: string, now = Date.now()): Promise<boolean> {
    return (await this.sql.execute('UPDATE key_invites SET accepted_at = ?, accepted_by = ? WHERE id = ? AND accepted_at IS NULL AND expires > ?', [now, account, id, now])).rowsAffected > 0;
  }
  async cancelKeyInvite(keyId: string, id: string): Promise<boolean> {
    return (await this.sql.execute('DELETE FROM key_invites WHERE id = ? AND key_id = ? AND accepted_at IS NULL', [id, keyId])).rowsAffected > 0;
  }
  async revokeApiKey(id: string, account: string, now = Date.now()): Promise<boolean> {
    const r = await this.sql.execute('UPDATE api_keys SET revoked = ? WHERE id = ? AND account = ? AND revoked IS NULL', [now, id, account]);
    return r.rowsAffected > 0;
  }
  /** rotation keeps the key's identity — name, environment and its whole history — and only the secret changes */
  async rotateApiKey(id: string, account: string, prefix: string, hash: string): Promise<boolean> {
    const r = await this.sql.execute('UPDATE api_keys SET prefix = ?, hash = ? WHERE id = ? AND account = ? AND revoked IS NULL', [prefix, hash, id, account]);
    return r.rowsAffected > 0;
  }
  /** removing a revoked key takes its reported decisions with it */
  async deleteApiKey(id: string, account: string): Promise<boolean> {
    const owned = await this.sql.execute('SELECT 1 FROM api_keys WHERE id = ? AND account = ? AND revoked IS NOT NULL', [id, account]);
    if (!owned.rows.length) return false;
    await this.sql.batch([
      { sql: 'DELETE FROM telemetry WHERE key_id = ?', args: [id] as SqlArg[] },
      { sql: 'DELETE FROM key_policies WHERE key_id = ?', args: [id] as SqlArg[] },
      { sql: 'DELETE FROM policy_changes WHERE key_id = ?', args: [id] as SqlArg[] },
      { sql: 'DELETE FROM key_resources WHERE key_id = ?', args: [id] as SqlArg[] },
      { sql: 'DELETE FROM key_shares WHERE key_id = ?', args: [id] as SqlArg[] },
      { sql: 'DELETE FROM key_invites WHERE key_id = ?', args: [id] as SqlArg[] },
      { sql: 'DELETE FROM api_keys WHERE id = ? AND account = ?', args: [id, account] as SqlArg[] },
    ]);
    return true;
  }
  /** The policy the portal holds for one key, its settings, and what the key's server last said it runs. */
  async keyPolicy(keyId: string): Promise<KeyPolicyRow | null> {
    const r = (await this.sql.execute('SELECT * FROM key_policies WHERE key_id = ?', [keyId])).rows[0];
    if (!r) return null;
    return {
      keyId, n: Number(r.n), body: JSON.parse(String(r.body)), updated: Number(r.updated),
      requireApproval: Number(r.require_approval) === 1, confirmWeakening: Number(r.confirm_weakening) === 1,
      lastFileHash: r.last_file_hash == null ? null : String(r.last_file_hash),
      seen: r.seen_at == null ? null : { version: String(r.seen_version ?? ''), source: String(r.seen_source ?? ''), at: Number(r.seen_at) },
    };
  }
  /** Write a new version (or the first one). Settings are kept; a first write takes the defaults. */
  async putKeyPolicy(keyId: string, n: number, body: unknown, now = Date.now()) {
    await this.sql.execute(`INSERT INTO key_policies (key_id, n, body, updated) VALUES (?, ?, ?, ?)
      ON CONFLICT(key_id) DO UPDATE SET n = excluded.n, body = excluded.body, updated = excluded.updated`, [keyId, n, JSON.stringify(body), now]);
  }
  async setKeyPolicySettings(keyId: string, s: { requireApproval?: boolean; confirmWeakening?: boolean }) {
    if (s.requireApproval !== undefined) await this.sql.execute('UPDATE key_policies SET require_approval = ? WHERE key_id = ?', [s.requireApproval ? 1 : 0, keyId]);
    if (s.confirmWeakening !== undefined) await this.sql.execute('UPDATE key_policies SET confirm_weakening = ? WHERE key_id = ?', [s.confirmWeakening ? 1 : 0, keyId]);
  }
  async setKeyPolicyFileHash(keyId: string, hash: string) {
    await this.sql.execute('UPDATE key_policies SET last_file_hash = ? WHERE key_id = ?', [hash, keyId]);
  }
  /** What the key's server reported it is running, and where the policy came from (portal, cache or file). */
  async setKeyPolicySeen(keyId: string, version: string, source: string, now = Date.now()) {
    await this.sql.execute('UPDATE key_policies SET seen_version = ?, seen_source = ?, seen_at = ? WHERE key_id = ?', [version.slice(0, 80), source.slice(0, 20), now, keyId]);
  }
  async addPolicyChange(c: { keyId: string; actor: string; origin: string; status: string; fromN: number | null; toN: number | null; body: unknown; summary: string[]; weakening: string[] }, now = Date.now()): Promise<number> {
    const r = await this.sql.execute('INSERT INTO policy_changes (key_id, at, actor, origin, status, from_n, to_n, body, summary, weakening) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [c.keyId, now, c.actor.slice(0, 120), c.origin, c.status, c.fromN, c.toN, c.body == null ? null : JSON.stringify(c.body), JSON.stringify(c.summary.slice(0, 60)), c.weakening.length ? JSON.stringify(c.weakening.slice(0, 60)) : null]);
    return Number(r.lastInsertRowid);
  }
  async decidePolicyChange(keyId: string, id: number, status: 'applied' | 'rejected' | 'superseded', by: string, toN: number | null, now = Date.now()): Promise<boolean> {
    const r = await this.sql.execute("UPDATE policy_changes SET status = ?, decided_by = ?, decided_at = ?, to_n = COALESCE(?, to_n) WHERE id = ? AND key_id = ? AND status = 'pending'", [status, by.slice(0, 120), now, toN, id, keyId]);
    return r.rowsAffected > 0;
  }
  async policyChanges(keyId: string, opts: { status?: string; limit?: number } = {}): Promise<PolicyChangeRow[]> {
    const r = opts.status
      ? await this.sql.execute('SELECT * FROM policy_changes WHERE key_id = ? AND status = ? ORDER BY id DESC LIMIT ?', [keyId, opts.status, opts.limit ?? 50])
      : await this.sql.execute('SELECT * FROM policy_changes WHERE key_id = ? ORDER BY id DESC LIMIT ?', [keyId, opts.limit ?? 50]);
    return r.rows.map((x) => ({
      id: Number(x.id), at: Number(x.at), actor: String(x.actor), origin: String(x.origin), status: String(x.status),
      fromN: x.from_n == null ? null : Number(x.from_n), toN: x.to_n == null ? null : Number(x.to_n),
      body: x.body == null ? null : JSON.parse(String(x.body)), summary: safeList(x.summary), weakening: x.weakening == null ? [] : safeList(x.weakening),
      decidedBy: x.decided_by == null ? null : String(x.decided_by), decidedAt: x.decided_at == null ? null : Number(x.decided_at),
    }));
  }
  /** The protected resources a key's server declared (every oh.protect() call it registered). */
  async noteKeyResources(keyId: string, resources: string[], now = Date.now()) {
    if (!resources.length) return;
    await this.sql.batch(resources.slice(0, 200).map((res) => ({ sql: 'INSERT INTO key_resources (key_id, resource, first_seen, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT(key_id, resource) DO UPDATE SET last_seen = excluded.last_seen', args: [keyId, res, now, now] as SqlArg[] })));
  }
  async keyResources(keyId: string): Promise<{ resource: string; firstSeen: number; lastSeen: number }[]> {
    const r = await this.sql.execute('SELECT resource, first_seen, last_seen FROM key_resources WHERE key_id = ? ORDER BY resource', [keyId]);
    return r.rows.map((x) => ({ resource: String(x.resource), firstSeen: Number(x.first_seen), lastSeen: Number(x.last_seen) }));
  }
  /** Resources the key reported decisions for (traffic), newest first — catches endpoints the server never declared. */
  async telemetryResources(keyId: string, since: number): Promise<{ resource: string; n: number; last: number }[]> {
    const r = await this.sql.execute('SELECT resource, COUNT(*) AS n, MAX(at) AS last FROM telemetry WHERE key_id = ? AND at >= ? GROUP BY resource ORDER BY last DESC LIMIT 200', [keyId, since]);
    return r.rows.map((x) => ({ resource: String(x.resource), n: Number(x.n), last: Number(x.last) }));
  }
  /** Agent signature bundles, newest first. They arrive signed; the portal only stores and serves them. */
  async latestSignatureBundle(): Promise<{ seq: number; jws: string; issued: number } | null> {
    const r = (await this.sql.execute('SELECT seq, jws, issued FROM signature_bundles ORDER BY seq DESC LIMIT 1')).rows[0];
    return r ? { seq: Number(r.seq), jws: String(r.jws), issued: Number(r.issued) } : null;
  }
  async addSignatureBundle(seq: number, jws: string, issued: number): Promise<boolean> {
    const r = await this.sql.execute('INSERT OR IGNORE INTO signature_bundles (seq, jws, issued, added) VALUES (?, ?, ?, ?)', [seq, jws, issued, Date.now()]);
    return r.rowsAffected > 0;
  }
  /** The policy assistant's use per account, for its daily limit. */
  async noteAssist(account: string) {
    await this.sql.execute('INSERT INTO assist_log (account, at) VALUES (?, ?)', [account, Date.now()]);
  }
  /** every account together: the assistant's spend has one ceiling for the whole portal */
  async assistCountAll(since: number): Promise<number> {
    return Number((await this.sql.execute('SELECT COUNT(*) AS n FROM assist_log WHERE at > ?', [since])).rows[0]?.n ?? 0);
  }
  async assistCount(account: string, since: number): Promise<number> {
    return Number((await this.sql.execute('SELECT COUNT(*) AS n FROM assist_log WHERE account = ? AND at > ?', [account, since])).rows[0]?.n ?? 0);
  }
  /** Remember the public keys a deployment reports with its events; old keys stay so old proofs keep verifying. */
  async rememberProofKeys(keyId: string, keys: { kty: string; crv: string; x: string; kid: string }[]) {
    if (!keys.length) return;
    const r = (await this.sql.execute('SELECT proof_keys FROM api_keys WHERE id = ?', [keyId])).rows[0];
    let known: { kty: string; crv: string; x: string; kid: string; first: number }[] = [];
    try { known = r?.proof_keys ? JSON.parse(String(r.proof_keys)) : []; } catch { known = []; }
    let changed = false;
    for (const k of keys) if (!known.some((q) => q.kid === k.kid)) { known.push({ kty: k.kty, crv: k.crv, x: k.x, kid: k.kid, first: Date.now() }); changed = true; }
    if (changed) await this.sql.execute('UPDATE api_keys SET proof_keys = ? WHERE id = ?', [JSON.stringify(known.slice(-10)), keyId]);
  }
  async proofKeysFor(keyId: string): Promise<{ kty: 'OKP'; crv: 'Ed25519'; x: string; kid: string; first: number }[]> {
    const r = (await this.sql.execute('SELECT proof_keys FROM api_keys WHERE id = ?', [keyId])).rows[0];
    try { return r?.proof_keys ? JSON.parse(String(r.proof_keys)) : []; } catch { return []; }
  }
  /**
   * The customer's verdict on one reported decision: `correct`, or `wrong` (a person was stopped, or an agent was
   * let through). This is the only ground truth a security product ever gets from the field; the false-stop rate
   * on the overview is computed from it.
   */
  async setTelemetryFeedback(keyId: string, id: number, feedback: 'correct' | 'wrong' | null, note: string | null, now = Date.now()): Promise<boolean> {
    const r = await this.sql.execute('UPDATE telemetry SET feedback = ?, feedback_note = ?, feedback_at = ? WHERE id = ? AND key_id = ?', [feedback, note, feedback ? now : null, id, keyId]);
    return r.rowsAffected > 0;
  }
  /** Feedback totals for one key in range: how many gated decisions were marked wrong (false stops), how many allows were (misses). */
  async telemetryFeedback(keyId: string, since: number): Promise<{ reviewed: number; falseStops: number; misses: number; gated: number }> {
    const r = (await this.sql.execute(`SELECT
      SUM(CASE WHEN feedback IS NOT NULL THEN 1 ELSE 0 END) AS reviewed,
      SUM(CASE WHEN feedback = 'wrong' AND decision IN ('mask','block','step_up') THEN 1 ELSE 0 END) AS false_stops,
      SUM(CASE WHEN feedback = 'wrong' AND decision = 'allow' THEN 1 ELSE 0 END) AS misses,
      SUM(CASE WHEN decision IN ('mask','block','step_up') THEN 1 ELSE 0 END) AS gated
      FROM telemetry WHERE key_id = ? AND at >= ?`, [keyId, since])).rows[0] ?? {};
    return { reviewed: Number(r.reviewed ?? 0), falseStops: Number(r.false_stops ?? 0), misses: Number(r.misses ?? 0), gated: Number(r.gated ?? 0) };
  }
  /**
   * Integration health for one key: is the server reporting, does the page send browser signals, do the
   * signatures verify, is the policy enforcing — and the number a bank asks first: how many people were stopped.
   * "People stopped" counts decisions the engine itself called human-like that were still blocked or masked,
   * plus gated decisions the customer graded wrong. A person the engine could not tell apart is asked to
   * confirm with a passkey (step_up) — counted separately, never as blocked.
   */
  async telemetryHealth(keyId: string, since: number): Promise<TelemetryHealth> {
    const [agg, last] = await Promise.all([
      this.sql.execute(`SELECT COUNT(*) AS n, MAX(at) AS last, COUNT(DISTINCT session) AS sessions,
        COUNT(DISTINCT CASE WHEN reasons NOT LIKE '%"NO_CLIENT_TELEMETRY"%' THEN session END) AS sdk_sessions,
        SUM(CASE WHEN proof IS NOT NULL THEN 1 ELSE 0 END) AS proofs,
        SUM(CASE WHEN proof_ok = 1 THEN 1 ELSE 0 END) AS proofs_ok,
        COUNT(DISTINCT CASE WHEN actor = 'human_like' THEN session END) AS human_sessions,
        SUM(CASE WHEN actor = 'human_like' AND decision IN ('block','mask') THEN 1 ELSE 0 END) AS human_gated,
        SUM(CASE WHEN feedback = 'wrong' AND decision IN ('mask','block','step_up') THEN 1 ELSE 0 END) AS false_stops,
        SUM(CASE WHEN decision = 'step_up' THEN 1 ELSE 0 END) AS step_ups,
        COUNT(DISTINCT CASE WHEN decision = 'step_up' THEN session END) AS step_up_sessions,
        COUNT(DISTINCT CASE WHEN (state IN ('agent_attached','signed_agent') OR actor = 'agent_likely') THEN session END) AS agent_sessions,
        SUM(CASE WHEN (state IN ('agent_attached','signed_agent') OR actor = 'agent_likely') AND decision IN ('mask','block','step_up') THEN 1 ELSE 0 END) AS agent_gated
        FROM telemetry WHERE key_id = ? AND at >= ?`, [keyId, since]),
      this.sql.execute('SELECT at, enforcement, version FROM telemetry WHERE key_id = ? ORDER BY at DESC, id DESC LIMIT 1', [keyId]),
    ]);
    const a = agg.rows[0] ?? {};
    const l = last.rows[0];
    const n = (v: unknown) => Number(v ?? 0);
    return {
      events: n(a.n), last: l ? n(l.at) : null, sessions: n(a.sessions), sdkSessions: n(a.sdk_sessions),
      proofs: n(a.proofs), proofsOk: n(a.proofs_ok), enforcement: l ? String(l.enforcement) : null, version: l ? String(l.version) : null,
      people: { sessions: n(a.human_sessions), stopped: n(a.human_gated) + n(a.false_stops), engineStopped: n(a.human_gated), gradedWrong: n(a.false_stops), askedToConfirm: n(a.step_ups), askedSessions: n(a.step_up_sessions) },
      agents: { sessions: n(a.agent_sessions), gated: n(a.agent_gated) },
    };
  }
  /** One week against the week before, for the weekly report. `end` is exclusive. */
  async telemetryWeek(keyId: string, start: number, end: number): Promise<TelemetryWeek> {
    const agentCase = "(state IN ('agent_attached','signed_agent') OR actor = 'agent_likely')";
    const [agg, tools, res] = await Promise.all([
      this.sql.execute(`SELECT COUNT(*) AS n, COUNT(DISTINCT session) AS sessions, COUNT(DISTINCT CASE WHEN ${agentCase} THEN session END) AS agent_sessions,
        SUM(CASE WHEN ${agentCase} AND decision IN ('mask','block','step_up') THEN 1 ELSE 0 END) AS agent_gated,
        SUM(CASE WHEN actor = 'human_like' AND decision IN ('block','mask') THEN 1 ELSE 0 END) + SUM(CASE WHEN feedback = 'wrong' AND decision IN ('mask','block','step_up') THEN 1 ELSE 0 END) AS people_stopped,
        SUM(CASE WHEN decision = 'step_up' THEN 1 ELSE 0 END) AS step_ups,
        SUM(CASE WHEN proof_ok = 1 THEN 1 ELSE 0 END) AS signed
        FROM telemetry WHERE key_id = ? AND at >= ? AND at < ?`, [keyId, start, end]),
      this.sql.execute("SELECT tools, COUNT(DISTINCT session) AS n FROM telemetry WHERE key_id = ? AND at >= ? AND at < ? AND tools != '[]' GROUP BY tools", [keyId, start, end]),
      this.sql.execute(`SELECT resource, COUNT(*) AS n, SUM(CASE WHEN decision IN ('mask','block','step_up') THEN 1 ELSE 0 END) AS gated FROM telemetry WHERE key_id = ? AND at >= ? AND at < ? AND ${agentCase} GROUP BY resource ORDER BY n DESC LIMIT 6`, [keyId, start, end]),
    ]);
    const a = agg.rows[0] ?? {};
    const n = (v: unknown) => Number(v ?? 0);
    const toolCounts: Record<string, number> = {};
    for (const x of tools.rows) { let arr: unknown = []; try { arr = JSON.parse(String(x.tools)); } catch { /* ignore */ } if (Array.isArray(arr)) for (const t of arr) toolCounts[String(t)] = (toolCounts[String(t)] ?? 0) + n(x.n); }
    return {
      decisions: n(a.n), sessions: n(a.sessions), agentSessions: n(a.agent_sessions), agentGated: n(a.agent_gated), peopleStopped: n(a.people_stopped), stepUps: n(a.step_ups), signed: n(a.signed),
      tools: Object.entries(toolCounts).sort((x, y) => y[1] - x[1]).map(([tool, sessions]) => ({ tool, sessions })),
      agentResources: res.rows.map((x) => ({ resource: String(x.resource), n: n(x.n), gated: n(x.gated) })),
    };
  }
  /** Signed decisions for one key (optionally one session), oldest first, for a proof bundle. */
  async telemetryProofs(keyId: string, since: number, session: string | null, limit = 5000): Promise<{ at: number; session: string; proof: string; ok: boolean }[]> {
    const r = session
      ? await this.sql.execute('SELECT at, session, proof, proof_ok FROM telemetry WHERE key_id = ? AND at >= ? AND session = ? AND proof IS NOT NULL ORDER BY id LIMIT ?', [keyId, since, session, limit])
      : await this.sql.execute('SELECT at, session, proof, proof_ok FROM telemetry WHERE key_id = ? AND at >= ? AND proof IS NOT NULL ORDER BY id LIMIT ?', [keyId, since, limit]);
    return r.rows.map((x) => ({ at: Number(x.at), session: String(x.session), proof: String(x.proof), ok: Number(x.proof_ok) === 1 }));
  }
  /**
   * Store reported events. A reporter retries a batch when the answer did not reach it (a timeout on a cold
   * start), so events that carry an id already stored for this key are dropped, and only new ones count.
   * Returns how many were new.
   */
  async insertTelemetry(keyId: string, events: TelemetryEvent[], now = Date.now()): Promise<number> {
    const ids = events.map((e) => e.eid).filter((x): x is string => !!x);
    if (ids.length) {
      const seen = new Set((await this.sql.execute(`SELECT eid FROM telemetry WHERE key_id = ? AND eid IN (${ids.map(() => '?').join(',')})`, [keyId, ...ids])).rows.map((r) => String(r.eid)));
      const once = new Set<string>();
      events = events.filter((e) => !e.eid || (!seen.has(e.eid) && !once.has(e.eid) && once.add(e.eid)));
    }
    if (!events.length) return 0;
    await this.sql.batch([
      ...events.map((e) => ({ sql: 'INSERT OR IGNORE INTO telemetry (key_id, at, session, resource, decision, computed, actor, state, tools, reasons, enforcement, version, proof, proof_kid, proof_ok, eid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', args: [keyId, e.at, e.session, e.resource, e.decision, e.computed ?? e.decision, e.actor, e.state, JSON.stringify(e.tools), JSON.stringify(e.reasons), e.enforcement, e.version, e.proof ?? null, e.proofKid ?? null, e.proofOk == null ? null : e.proofOk ? 1 : 0, e.eid ?? null] as SqlArg[] })),
      { sql: 'UPDATE api_keys SET last_seen = ?, events = events + ? WHERE id = ?', args: [now, events.length, keyId] },
    ]);
    return events.length;
  }
  /** one key's reported decisions in a range, in the shape the design-partner report is built from */
  async telemetryDecisions(keyId: string, from: number, to: number): Promise<{ session: string; created: number; resource: string; decision: string; computed: string; actor: string; tools: string[]; signed: boolean; enforced: boolean }[]> {
    const rows = (await this.sql.execute('SELECT session, at, resource, decision, COALESCE(computed, decision) AS computed, actor, tools, enforcement, proof IS NOT NULL AS signed FROM telemetry WHERE key_id = ? AND at >= ? AND at < ? ORDER BY at', [keyId, from, to])).rows;
    return rows.map((r) => ({ session: String(r.session), created: Number(r.at), resource: String(r.resource), decision: String(r.decision), computed: String(r.computed), actor: String(r.actor), tools: safeList(r.tools), signed: Number(r.signed) === 1, enforced: r.enforcement === 'enforce' }));
  }
  /** everything the portal shows for one key since `since` */
  async telemetryStats(keyId: string, since: number, bucketMs: number, prefix?: string): Promise<TelemetryStats> {
    const agentCase = "(state IN ('agent_attached','signed_agent') OR actor = 'agent_likely')";
    // every query reads the same rows: one key, a range, and when asked only the resources under a prefix
    const W = `key_id = ? AND at >= ?${prefix ? ' AND resource LIKE ?' : ''}`;
    const A = (...more: SqlArg[]): SqlArg[] => (prefix ? [...more, keyId, since, `${prefix}%`] : [...more, keyId, since]);
    const [dec, act, st, res, tools, sess, series, recent, people] = await Promise.all([
      this.sql.execute(`SELECT decision, COUNT(*) AS n FROM telemetry WHERE ${W} GROUP BY decision`, A()),
      this.sql.execute(`SELECT actor, COUNT(*) AS n FROM telemetry WHERE ${W} GROUP BY actor`, A()),
      this.sql.execute(`SELECT state, COUNT(*) AS n FROM telemetry WHERE ${W} GROUP BY state`, A()),
      this.sql.execute(`SELECT resource, decision, COUNT(*) AS n FROM telemetry WHERE ${W} GROUP BY resource, decision ORDER BY n DESC LIMIT 60`, A()),
      this.sql.execute(`SELECT tools, COUNT(DISTINCT session) AS n FROM telemetry WHERE ${W} AND tools != '[]' GROUP BY tools`, A()),
      this.sql.execute(`SELECT COUNT(DISTINCT session) AS total, COUNT(DISTINCT CASE WHEN ${agentCase} THEN session END) AS agent FROM telemetry WHERE ${W}`, A()),
      this.sql.execute(`SELECT CAST(at / ? AS INTEGER) * ? AS t, COUNT(*) AS n, SUM(CASE WHEN ${agentCase} THEN 1 ELSE 0 END) AS agent, SUM(CASE WHEN decision IN ('mask','block','step_up') THEN 1 ELSE 0 END) AS gated FROM telemetry WHERE ${W} GROUP BY t ORDER BY t`, A(bucketMs, bucketMs)),
      this.sql.execute(`SELECT id, at, session, resource, decision, actor, state, tools, reasons, enforcement, proof_ok, feedback FROM telemetry WHERE ${W} ORDER BY id DESC LIMIT 60`, A()),
      this.sql.execute(`SELECT ${SiteStore.VERDICT} AS verdict, COUNT(*) AS n FROM (${SiteStore.SESSION_FLAGS.replace('$W', W)}) GROUP BY verdict`, A()),
    ]);
    const toolCounts: Record<string, number> = {};
    for (const x of tools.rows) { let arr: unknown = []; try { arr = JSON.parse(String(x.tools)); } catch { /* ignore */ } if (Array.isArray(arr)) for (const t of arr) toolCounts[String(t)] = (toolCounts[String(t)] ?? 0) + Number(x.n); }
    const s0 = sess.rows[0] ?? {};
    const p = Object.fromEntries(people.rows.map((x) => [String(x.verdict), Number(x.n)]));
    // what each session of the latest events turned out to be, so a row says "a person" where its own decision could not
    const ids = [...new Set(recent.rows.map((x) => String(x.session)))];
    const verdicts = new Map<string, SessionVerdict>();
    if (ids.length) {
      const q = SiteStore.SESSION_FLAGS.replace('$W', `${W} AND session IN (${ids.map(() => '?').join(',')})`);
      const r = await this.sql.execute(`SELECT session, ${SiteStore.VERDICT} AS verdict FROM (${q})`, [...A(), ...ids]);
      for (const x of r.rows) verdicts.set(String(x.session), String(x.verdict) as SessionVerdict);
    }
    return {
      decisions: Object.fromEntries(dec.rows.map((x) => [String(x.decision), Number(x.n)])),
      actors: Object.fromEntries(act.rows.map((x) => [String(x.actor), Number(x.n)])),
      states: Object.fromEntries(st.rows.map((x) => [String(x.state), Number(x.n)])),
      resources: res.rows.map((x) => ({ resource: String(x.resource), decision: String(x.decision), n: Number(x.n) })),
      tools: Object.entries(toolCounts).sort((a, b) => b[1] - a[1]).map(([tool, sessions]) => ({ tool, sessions })),
      sessions: { total: Number(s0.total ?? 0), agent: Number(s0.agent ?? 0) },
      people: { agent: p.agent ?? 0, human: p.human ?? 0, noData: p.no_data ?? 0, early: p.early ?? 0, unclear: p.unclear ?? 0 },
      series: series.rows.map((x) => ({ t: Number(x.t), n: Number(x.n), agent: Number(x.agent), gated: Number(x.gated) })),
      recent: recent.rows.map((x) => ({ id: Number(x.id), at: Number(x.at), session: String(x.session), resource: String(x.resource), decision: String(x.decision), actor: String(x.actor), state: String(x.state), tools: safeList(x.tools), reasons: safeList(x.reasons), enforcement: String(x.enforcement), signed: x.proof_ok == null ? null : Number(x.proof_ok) === 1, feedback: x.feedback == null ? null : String(x.feedback), verdict: verdicts.get(String(x.session)) ?? 'unclear' })),
    };
  }
  /** one row per session of the given telemetry rows ($W): agent at any point, a person seen, browser data at all, too few actions */
  private static readonly SESSION_FLAGS = `SELECT session,
      MAX(CASE WHEN state IN ('agent_attached','signed_agent') OR actor = 'agent_likely' THEN 1 ELSE 0 END) AS a,
      MAX(CASE WHEN actor = 'human_like' THEN 1 ELSE 0 END) AS h,
      MAX(CASE WHEN reasons LIKE '%NO_CLIENT_TELEMETRY%' THEN 0 ELSE 1 END) AS sdk,
      MAX(CASE WHEN reasons LIKE '%INSUFFICIENT_ACTIONS%' THEN 1 ELSE 0 END) AS few
    FROM telemetry WHERE $W GROUP BY session`;
  private static readonly VERDICT = "CASE WHEN a = 1 THEN 'agent' WHEN h = 1 THEN 'human' WHEN sdk = 0 THEN 'no_data' WHEN few = 1 THEN 'early' ELSE 'unclear' END";
  /** sessions, agent sessions, events and gated events per app, for resources named <prefix><app>.<resource> */
  async telemetryApps(keyId: string, since: number, prefix: string): Promise<TelemetryApps> {
    const agentCase = "(state IN ('agent_attached','signed_agent') OR actor = 'agent_likely')";
    const app = `substr(resource, ${prefix.length + 1}, instr(substr(resource, ${prefix.length + 1}), '.') - 1)`;
    const r = await this.sql.execute(`SELECT ${app} AS app, COUNT(DISTINCT session) AS s, COUNT(DISTINCT CASE WHEN ${agentCase} THEN session END) AS a, COUNT(*) AS n,
      SUM(CASE WHEN decision IN ('mask','block','step_up') THEN 1 ELSE 0 END) AS g FROM telemetry WHERE key_id = ? AND at >= ? AND resource LIKE ? GROUP BY app ORDER BY s DESC`, [keyId, since, `${prefix}%`]);
    return r.rows.filter((x) => String(x.app)).map((x) => ({ app: String(x.app), sessions: Number(x.s), agent: Number(x.a), events: Number(x.n), gated: Number(x.g ?? 0) }));
  }
  /** the decision log, oldest-last, paged by id so an export can walk the whole range */
  async telemetryEvents(keyId: string, since: number, beforeId: number | null, limit: number): Promise<{ id: number; at: number; session: string; resource: string; decision: string; actor: string; state: string; tools: string[]; reasons: string[]; enforcement: string; signed: boolean | null; feedback: string | null }[]> {
    const r = beforeId == null
      ? await this.sql.execute('SELECT id, at, session, resource, decision, actor, state, tools, reasons, enforcement, proof_ok, feedback FROM telemetry WHERE key_id = ? AND at >= ? ORDER BY id DESC LIMIT ?', [keyId, since, limit])
      : await this.sql.execute('SELECT id, at, session, resource, decision, actor, state, tools, reasons, enforcement, proof_ok, feedback FROM telemetry WHERE key_id = ? AND at >= ? AND id < ? ORDER BY id DESC LIMIT ?', [keyId, since, beforeId, limit]);
    return r.rows.map((x) => ({
      id: Number(x.id), at: Number(x.at), session: String(x.session), resource: String(x.resource), decision: String(x.decision),
      actor: String(x.actor), state: String(x.state), tools: safeList(x.tools), reasons: safeList(x.reasons), enforcement: String(x.enforcement),
      signed: x.proof_ok == null ? null : Number(x.proof_ok) === 1, feedback: x.feedback == null ? null : String(x.feedback),
    }));
  }
  /** the overview: every key of an account, per bucket and in total, in two queries */
  /** the account's keys and the keys shared with it, as a SQL condition on `k` */
  private static readonly VISIBLE = '(k.account = ? OR k.id IN (SELECT key_id FROM key_shares WHERE account = ?))';
  async telemetryOverview(account: string, since: number, bucketMs: number): Promise<TelemetryOverview> {
    const agentCase = "(t.state IN ('agent_attached','signed_agent') OR t.actor = 'agent_likely')";
    const V = SiteStore.VISIBLE;
    const [series, totals] = await Promise.all([
      this.sql.execute(`SELECT t.key_id AS key_id, CAST(t.at / ? AS INTEGER) * ? AS b, COUNT(*) AS n, SUM(CASE WHEN ${agentCase} THEN 1 ELSE 0 END) AS agent, SUM(CASE WHEN t.decision IN ('mask','block','step_up') THEN 1 ELSE 0 END) AS gated FROM telemetry t JOIN api_keys k ON k.id = t.key_id WHERE ${V} AND t.at >= ? GROUP BY t.key_id, b ORDER BY b`, [bucketMs, bucketMs, account, account, since]),
      this.sql.execute(`SELECT t.key_id AS key_id, COUNT(*) AS n, COUNT(DISTINCT t.session) AS sessions, COUNT(DISTINCT CASE WHEN ${agentCase} THEN t.session END) AS agent_sessions, SUM(CASE WHEN t.decision IN ('mask','block','step_up') THEN 1 ELSE 0 END) AS gated, MAX(t.at) AS last FROM telemetry t JOIN api_keys k ON k.id = t.key_id WHERE ${V} AND t.at >= ? GROUP BY t.key_id`, [account, account, since]),
    ]);
    return {
      series: series.rows.map((x) => ({ key: String(x.key_id), t: Number(x.b), n: Number(x.n), agent: Number(x.agent), gated: Number(x.gated) })),
      totals: totals.rows.map((x) => ({ key: String(x.key_id), n: Number(x.n), sessions: Number(x.sessions), agentSessions: Number(x.agent_sessions), gated: Number(x.gated), last: Number(x.last) })),
    };
  }
  /** Every decision in the account's agent sessions since `since` (a session counts once any event in it saw an agent). */
  async telemetryAgentEvents(account: string, since: number, limit = 20000): Promise<{ key: string; at: number; session: string; resource: string; decision: string; computed: string; actor: string; state: string; tools: string[]; reasons: string[] }[]> {
    const agentCase = "(t.state IN ('agent_attached','signed_agent') OR t.actor = 'agent_likely' OR t.tools != '[]')";
    const rows = (await this.sql.execute(`SELECT t.key_id, t.at, t.session, t.resource, t.decision, t.computed, t.actor, t.state, t.tools, t.reasons FROM telemetry t JOIN api_keys k ON k.id = t.key_id WHERE ${SiteStore.VISIBLE} AND t.at >= ? AND ${agentCase} ORDER BY t.at LIMIT ?`, [account, account, since, limit])).rows;
    const arr = (v: unknown) => { try { const a = JSON.parse(String(v)); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } };
    return rows.map((x) => ({ key: String(x.key_id), at: Number(x.at), session: String(x.session), resource: String(x.resource), decision: String(x.decision), computed: String(x.computed ?? x.decision), actor: String(x.actor), state: String(x.state), tools: arr(x.tools), reasons: arr(x.reasons) }));
  }
}

/** The website's store behind an engine: the site's routes need SiteStore.open(), never a plain engine Store. */
export function siteOf(store: Store): SiteStore {
  if (!(store instanceof SiteStore)) throw new Error('site routes need a store opened with SiteStore.open()');
  return store;
}
