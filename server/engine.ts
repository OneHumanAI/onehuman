// SPDX-License-Identifier: BUSL-1.1
/**
 * The OneHuman engine: everything a company's backend needs to make and
 * record a decision for one protected resource.
 *
 *   signals (untrusted, from SDK) + server observations (trusted)
 *        → assess()  → evaluate(policy) → audit (hash chain) → response
 *
 * `protect()` is a Node http adapter around `decide()`. Express-style
 * `(req, res)` handlers work with it unchanged.
 */
import { createHash, randomBytes } from 'node:crypto';
import { assess, type Assessment } from './assess.ts';
import { appendDecision } from './audit.ts';
import { proverFromSecret, thumbprint, type ProofJwk, type Prover } from './proof.ts';

/** ONEHUMAN_RETIRED_PROOF_KEYS: a JSON array of public JWKs (what `npx onehumanai proof-keys` printed before the secret changed). */
function retiredFromEnv(): ProofJwk[] {
  const raw = process.env.ONEHUMAN_RETIRED_PROOF_KEYS;
  if (!raw) return [];
  try { const v = JSON.parse(raw); const arr = Array.isArray(v) ? v : Array.isArray(v?.keys) ? v.keys : []; return arr as ProofJwk[]; } catch { console.warn('onehuman: ONEHUMAN_RETIRED_PROOF_KEYS is not JSON; ignored'); return []; }
}
import { classifyConnection, type Connection } from './connection.ts';
import { bus } from './bus.ts';
import { VISIT_IDLE_MS, type DecisionRow, type SessionRow, type Store } from './db.ts';
import { cookies, headerGetter, json, url, type Req, type Res } from './http.ts';
import { applyOwnerChoice, DEFAULT_POLICY, evaluate, ownerMayLoosen, type Decision, type Policy } from './policy.ts';
import { parseSnapshot, type ClientSnapshot, type ServerSignal } from './signals.ts';
import { issueToken, verifyToken, type TokenCheck } from './tokens.ts';
import { observeRequest, type KeyLoader } from './web-bot-auth.ts';
import { DEV_SESSIONS_PER_DAY, License } from './license.ts';

export const STEP_UP_TTL_MS = 90000;
export const TOKEN_TTL_MS = 30000;
/** how long a WebAuthn user-verified assertion counts as "a person is here" */
export const HUMAN_RECLAIM_TTL_MS = 5 * 60000;
export const CHALLENGE_TTL_MS = 120000;

export type EngineOptions = {
  store: Store;
  secret?: Buffer;
  /** proof key rotation without a new secret: sign with epoch N, keep publishing 0..N-1 (default ONEHUMAN_PROOF_EPOCH or 0) */
  proofEpoch?: number;
  /** public keys of proofs made before the secret changed; published next to the current key so those proofs still verify */
  retiredProofKeys?: ProofJwk[];
  defaultPolicy?: Policy;
  keyLoader?: KeyLoader;
  sessionCookie?: string;
  /**
   * Whose choices the owner's agent-access settings are: 'session' (default: an app's OneHuman session, one per login
   * with identify()) or 'room' (a room is one account, and the person and their agent may use two tabs).
   */
  accessScope?: 'session' | 'room';
  /** the API key's tag, so a license token issued for another key is refused */
  licenseKeyTag?: string | null;
  /** told of every decision that was not a simulation, once it is stored; must return at once (do slow work off the path) */
  onDecision?: (row: DecisionRow) => void;
};

/** How long an owner's 'allow' for their agent lasts. */
export const OWNER_ALLOW_TTL_MS = 60 * 60 * 1000;

/**
 * One request, exactly: method, path with query, and body (when the app parsed it before protect()). A person's
 * confirmation covers the request with this digest and no other, so an agent cannot swap the arguments after the
 * owner approved (another recipient, another amount).
 */
export function requestDigest(req: Req): string {
  const r = req as Req & { originalUrl?: string; body?: unknown };
  const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon)
    : v && typeof v === 'object' && !(v instanceof Uint8Array) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v);
  const h = createHash('sha256').update(`${(r.method ?? 'GET').toUpperCase()} ${r.originalUrl ?? r.url ?? '/'}\n`);
  if (r.body instanceof Uint8Array) h.update(r.body);
  else if (typeof r.body === 'string') h.update(r.body);
  else h.update(JSON.stringify(canon(r.body ?? null)) ?? '');
  return h.digest('base64url').slice(0, 32);
}

export type DecideInput = {
  room: string;
  session: SessionRow;
  resource: string;
  request: Req;
  /** snapshot carried with the request (X-OH-Sample) — untrusted */
  snapshot: ClientSnapshot | null;
  /** a request the host application sent itself to demonstrate a path: recorded, but kept out of first-data/first-agent marks */
  simulated?: boolean;
  /** what this request does, in the app's words ("Send 250 EUR to Alice"): shown to the person who approves it */
  detail?: string | null;
};

/** What the person is asked to approve: the rule's title, the request, and the app's own description of it. */
export type StepUpSummary = { title: string; request: string; detail: string | null };

export type DecideResult = {
  decision: DecisionRow;
  /** signed proof of this decision (compact JWS, see proof.ts); kept server-side, never sent to the browser */
  proof: string | null;
  assessment: Assessment;
  server: ServerSignal;
  /** `webauthn`: a passkey is registered, the client should prefer the WebAuthn path; `reclaim`: the session is blocked as agent and only WebAuthn can reopen it */
  stepUp: { id: string; challenge: string; expiresAt: number; webauthn?: boolean; reclaim?: boolean; approve?: boolean; summary?: StepUpSummary } | null;
};

export type ProtectContext = {
  room: string;
  session: SessionRow;
  decision: DecisionRow;
  assessment: Assessment;
  /** true when the handler must return masked data */
  masked: boolean;
  /** issue a single-use token bound to this decision (for download URLs) */
  token(): string;
};

export class OneHuman {
  readonly store: Store;
  readonly secret: Buffer;
  readonly defaultPolicy: Policy;
  readonly keyLoader: KeyLoader | undefined;
  readonly sessionCookie: string;
  /** signs every decision; the key is derived from `secret`, so it is the same on every instance */
  readonly prover: Prover;
  /** when true, an agent-blocked resource advertises the WebAuthn reclaim path */
  webauthnReclaimEnabled = true;
  readonly accessBy: 'session' | 'room';
  private readonly onDecision?: (row: DecisionRow) => void;

  /**
   * The passkeys that belong to this session's account. With accessScope 'session' (an app's middleware, one session
   * per login) that is the login's own passkeys, never another user's; with 'room' (the lab) the room's.
   */
  credentialsFor<T>(session: Pick<SessionRow, 'id' | 'room'>): Promise<T[]> {
    return this.accessBy === 'room' ? this.store.credentialsForRoom<T>(session.room) : this.store.credentialsForSession<T>(session.id);
  }
  async ownsCredential(session: Pick<SessionRow, 'id' | 'room'>, credentialId: string): Promise<boolean> {
    const o = await this.store.credentialOwner(credentialId);
    return !!o && (this.accessBy === 'room' ? o.room === session.room : o.session === session.id);
  }

  /**
   * An AI agent drives this session now, did earlier in this visit (and no person has reclaimed it since), or made the
   * request itself: with `request`, the click behind it is judged like any protected call (and the attempt is logged
   * as a decision on `resource`).
   */
  async agentPresent(session: SessionRow, request?: Req, resource = 'webauthn.register', now = Date.now()): Promise<boolean> {
    const c = await this.connectionFor(session, now);
    if (c.state === 'agent_attached' || c.state === 'signed_agent') return true;
    const s = await this.store.getSession(session.id);
    if (s?.agentAttachedAt && !(s.humanVerifiedAt != null && s.humanVerifiedAt > s.agentAttachedAt && now - s.humanVerifiedAt <= HUMAN_RECLAIM_TTL_MS)) return true;
    if (!request) return false;
    const r = await this.decide({ room: session.room, session, resource, request, snapshot: this.snapshotFrom(request) });
    // a program's click, or no click at all from inside an AI browser or beside an agent's side panel
    return r.assessment.actor === 'agent_likely' || (r.assessment.actor === 'unknown' && c.state === 'agent_environment');
  }

  /** The key the account owner's agent-access choices are stored under. */
  accessScope(session: Pick<SessionRow, 'id' | 'room'>): string { return this.accessBy === 'room' ? `room:${session.room}` : `session:${session.id}`; }

  /**
   * What the account owner sees about their own AI agent: whether one is connected, each protected action with what
   * the company allows an agent, what the owner chose and what applies now, and what the agent did recently.
   */
  async agentAccess(session: SessionRow, now = Date.now()) {
    const policy = await this.policyFor(session.room);
    const choices = new Map((await this.store.agentAccess(this.accessScope(session), now)).map((c) => [c.resource, c]));
    const connection = await this.connectionFor(session, now);
    const fresh = await this.store.getSession(session.id);
    const actions = policy.rules.map((r) => {
      const c = choices.get(r.resource) ?? null;
      const mayLoosen = ownerMayLoosen(r);
      const effective = c?.choice === 'never' ? 'block' : c?.choice === 'allow' && mayLoosen ? 'allow' : r.onAgent;
      return { resource: r.resource, title: r.title, company: r.onAgent, mayLoosen, choice: c?.choice ?? null, until: c?.until ?? null, effective };
    });
    const rows = (await this.store.listDecisions(session.room, 200))
      .filter((d) => (this.accessBy === 'room' || d.session === session.id) && (d.branch === 'agent' || d.branch === 'artifact' || d.resource.startsWith('access.')))
      .sort((a, b) => b.created - a.created).slice(0, 25);
    return {
      connected: connection.state === 'agent_attached' || connection.state === 'signed_agent' || fresh?.agentAttachedAt != null,
      nearby: connection.state === 'agent_environment',
      tools: connection.tools,
      since: fresh?.agentAttachedAt ?? null,
      actions,
      activity: rows.map((d) => ({ at: d.created, resource: d.resource, decision: d.decision, owner: d.reasonCodes.includes('OWNER_ALLOWED') ? 'allowed' : d.reasonCodes.includes('OWNER_DENIED') ? 'denied' : null, passkey: d.reasonCodes.includes('HUMAN_VERIFIED_WEBAUTHN'), tools: d.tools ?? [] })),
    };
  }

  /**
   * Change the owner's choice for one resource (or every rule, resource '*'). `verified`: the person proved it is them
   * with a passkey just now. Without it, only stricter changes go through ('never', or taking back an 'allow'): an agent
   * can always restrict itself, never widen what it may do.
   */
  async setAgentAccess(session: SessionRow, resource: string, choice: 'allow' | 'never' | null, verified: boolean, now = Date.now()): Promise<{ ok: true } | { ok: false; error: 'passkey_required' | 'not_allowed' | 'unknown_resource' }> {
    const policy = await this.policyFor(session.room);
    const scope = this.accessScope(session);
    const targets = resource === '*' ? policy.rules : policy.rules.filter((r) => r.resource === resource);
    if (!targets.length) return { ok: false, error: 'unknown_resource' };
    if (resource === '*' && choice !== 'never') return { ok: false, error: 'not_allowed' };
    for (const rule of targets) {
      const current = await this.store.agentAccessFor(scope, rule.resource, now);
      const looser = choice === 'allow' || (choice === null && current?.choice === 'never');
      if (choice === 'allow' && !ownerMayLoosen(rule)) return { ok: false, error: 'not_allowed' };
      if (looser && !verified) return { ok: false, error: 'passkey_required' };
    }
    for (const rule of targets) {
      await this.store.setAgentAccess(scope, rule.resource, choice, choice === 'allow' ? now + OWNER_ALLOW_TTL_MS : null, verified ? 'owner_passkey' : 'session', now);
      await this.recordAccessChange(session, rule.resource, choice, verified, policy.version, now);
    }
    return { ok: true };
  }

  /** The owner's change goes into the signed audit chain, so it can be proven later who widened or narrowed what. */
  private async recordAccessChange(session: SessionRow, resource: string, choice: 'allow' | 'never' | null, verified: boolean, policyVersion: string, now: number) {
    const code = choice === 'allow' ? 'OWNER_ALLOWED' : choice === 'never' ? 'OWNER_DENIED' : 'OWNER_RESET';
    const reasons = [{ code, kind: verified ? 'human' : 'context', tier: verified ? 'verified' : 'behavioral', detail: `${choice ?? 'default'} for ${resource}${verified ? ', confirmed with a passkey' : ''}` }];
    await appendDecision(this.store, {
      id: crypto.randomUUID(), room: session.room, session: session.id, resource: `access.${resource}`, decision: choice === 'never' ? 'block' : 'allow', computed: choice === 'never' ? 'block' : 'allow', enforced: true,
      branch: verified ? 'human_like' : 'unknown', actor: verified ? 'human_like' : 'unknown', score: null, tiers: verified ? ['verified'] : [], reasonCodes: verified ? [code, 'HUMAN_VERIFIED_WEBAUTHN'] : [code],
      policyVersion, signalVersion: 'access-v1', latencyMs: 0, dataDelivered: false, simulated: false, tools: [], connection: 'none', created: now,
      assessment: { actor: verified ? 'human_like' : 'unknown', score: null, tiers: verified ? ['verified'] : [], reasons, metrics: {}, version: 'access-v1' },
    } as unknown as Parameters<typeof appendDecision>[1], (r, seq) => this.prover.sign(r, seq));
    bus.publish({ type: 'decision', room: session.room, session: session.id, at: now, id: `access-${now}`, resource: `access.${resource}`, decision: choice === 'never' ? 'block' : 'allow', actor: verified ? 'human_like' : 'unknown', reasonCodes: [code] });
  }

  /** what this deployment's license allows (server/license.ts); fixed for the engine's life, not replaceable */
  declare readonly license: License;

  constructor(opts: EngineOptions) {
    this.store = opts.store;
    Object.defineProperty(this, 'license', { value: new License({ keyTag: opts.licenseKeyTag ?? null }), writable: false, enumerable: true, configurable: false });
    this.secret = opts.secret ?? randomBytes(32);
    this.defaultPolicy = opts.defaultPolicy ?? DEFAULT_POLICY;
    this.keyLoader = opts.keyLoader;
    this.sessionCookie = opts.sessionCookie ?? 'oh_sid';
    this.accessBy = opts.accessScope ?? 'session';
    this.onDecision = opts.onDecision;
    const epoch = Math.max(0, Math.floor(opts.proofEpoch ?? (Number(process.env.ONEHUMAN_PROOF_EPOCH) || 0)));
    this.prover = proverFromSecret(this.secret, epoch);
    const older = Array.from({ length: epoch }, (_, i) => proverFromSecret(this.secret, epoch - 1 - i).jwk);
    const retired = (opts.retiredProofKeys ?? retiredFromEnv()).filter((k) => k && k.kty === 'OKP' && k.crv === 'Ed25519' && typeof k.x === 'string' && /^[A-Za-z0-9_-]{43}$/.test(k.x)).map((k) => ({ ...k, kid: thumbprint(k.x) }));
    const seen = new Set<string>();
    this.publishedKeys = [this.prover.jwk, ...older, ...retired].filter((k) => (seen.has(k.kid) ? false : (seen.add(k.kid), true)));
  }

  private readonly publishedKeys: ProofJwk[];

  /** The keys that verify this engine's decision proofs, as a JWK Set: the current key first, then older ones. Safe to publish. */
  proofKeys() { return { keys: this.publishedKeys }; }

  /**
   * Connection classification for a session from its arrival request and the
   * latest passive snapshot. Records the first agent_attached / signed_agent
   * moment as an `attach` event. No user action is needed for this.
   */
  async connectionFor(session: SessionRow, now = Date.now()): Promise<Connection> {
    // this visit's page signals only: an agent from an earlier visit does not attach itself again
    const recent = await this.store.recentSignals(session.id, now, VISIT_IDLE_MS, 0);
    const c = classifyConnection(session.arrival, recent.early);
    if (c.state === 'agent_attached' || c.state === 'signed_agent') {
      // Server time of the attach: the evidence's page-relative time mapped onto the session
      // start, never later than now (covers sessions re-evaluated after the fact).
      const at = c.atMs != null ? Math.min(now, session.created + c.atMs) : now;
      if (await this.store.markAgentAttached(session.id, at, c.atMs)) {
        await this.store.addEvent(session.room, session.id, 'attach', c, at);
        await this.store.markFirstAgent(session.id, at);
        bus.publish({ type: 'attach', room: session.room, session: session.id, at, sinceStartMs: at - session.created, connection: c });
      }
    }
    return c;
  }

  async policyFor(room: string): Promise<Policy> {
    const saved = await this.store.currentPolicy(room);
    if (saved) return saved;
    const app = await this.store.roomApp(room);
    return this.appPolicyFor(app ?? 'bank');
  }

  /** Default policy per simulated application; overridden by `policyForApp` when set. */
  policyForApp: ((app: string) => Policy | null) | null = null;
  defaultPolicyFor(app: string): Policy {
    return this.policyForApp?.(app) ?? this.defaultPolicy;
  }
  /** Rules managed elsewhere (the site's demos: its key's rules in the portal) laid over an app's default policy. */
  appRules: ((app: string, base: Policy) => Promise<Policy>) | null = null;
  async appPolicyFor(app: string): Promise<Policy> {
    const base = this.defaultPolicyFor(app);
    if (!this.appRules) return base;
    try { return await this.appRules(app, base); } catch (e) { console.warn('onehuman: app rules failed, using the defaults', e); return base; }
  }

  /** Server-side observation of one request (signature, fetch metadata). */
  observe(req: Req): Promise<ServerSignal> {
    return observeRequest({ method: req.method ?? 'GET', url: url(req).href, headers: headerGetter(req) }, {
      keyLoader: this.keyLoader,
      consumeNonce: (key, ttl) => this.store.consumeNonce(key, ttl),
    });
  }

  /**
   * Resolve the session. The page-bound X-OH-Session header wins over the profile-wide
   * cookie, so two tabs in one browser profile never report under each other's session.
   * Production replaces this with the application's own authenticated session lookup.
   */
  async resolveSession(req: Req): Promise<{ room: string; session: SessionRow } | null> {
    const header = req.headers['x-oh-session'];
    const fromHeader = typeof header === 'string' && /^[0-9a-f-]{36}$/i.test(header) ? header : null;
    const sid = fromHeader ?? cookies(req)[this.sessionCookie];
    if (!sid) return null;
    const session = await this.store.getSession(sid);
    if (!session || !(await this.store.roomExists(session.room))) return null;
    const room = url(req).searchParams.get('room');
    if (room && room !== session.room) return null;
    return { room: session.room, session };
  }

  /** Parse the untrusted snapshot header. Malformed → null (treated as no telemetry). */
  snapshotFrom(req: Req): ClientSnapshot | null {
    const raw = req.headers['x-oh-sample'];
    if (typeof raw !== 'string' || raw.length > 12000) return null;
    try {
      return parseSnapshot(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  /**
   * A recorded click sent again is not a person clicking. The same click may reach the server twice from its own
   * session within a few seconds (the page's request and its signal); from another session, or later, it is a replay
   * and does not count as human evidence. (A program that fabricates a fresh click each time is not caught here —
   * for irreversible actions the rule should ask everyone for a passkey.)
   */
  private async withoutReplayedClick(sessionId: string, snapshot: ClientSnapshot | null, now: number): Promise<ClientSnapshot | null> {
    const click = snapshot?.interaction?.click;
    if (!snapshot || !click?.traj || click.traj.length < 3) return snapshot;
    const fp = createHash('sha256').update(JSON.stringify([click.traj, click.holdMs, click.downMs ?? null, click.at ?? null, click.target ?? null])).digest('base64url').slice(0, 32);
    if (await this.store.consumeNonce(`click:${fp}`, 24 * 3600e3, now)) { await this.store.consumeNonce(`click:${fp}:${sessionId}`, 10_000, now); return snapshot; }
    if (!(await this.store.consumeNonce(`click:${fp}:${sessionId}`, 10_000, now))) return snapshot;   // its own session, just now
    return { ...snapshot, interaction: null };
  }

  /** Store a snapshot as events and return the current assessment (no decision, no audit). */
  async ingest(room: string, session: SessionRow, raw: ClientSnapshot, now = Date.now()): Promise<{ assessment: Assessment; connection: Connection }> {
    const snapshot = (await this.withoutReplayedClick(session.id, raw, now))!;
    if (snapshot.early) await this.store.addEvent(room, session.id, 'signal', snapshot.early, now);
    // first report of on-screen redaction by the SDK: keep it as its own timeline event
    if (snapshot.early?.reading.seal && !(await this.store.hasEvent(session.id, 'seal'))) await this.store.addEvent(room, session.id, 'seal', snapshot.early.reading.seal, now);
    if (snapshot.interaction) await this.store.addEvent(room, session.id, 'interaction', snapshot.interaction, now);
    await this.store.touchSession(session.id, now);
    const connection = await this.connectionFor(session, now);
    const recent = await this.store.recentSignals(session.id, now, 120000, 6);
    const assessment = assess({ server: session.arrival, early: recent.early, interactions: recent.interactions, current: null });
    if (assessment.actor === 'agent_likely') await this.store.markFirstAgent(session.id, now);
    return { assessment, connection };
  }

  /**
   * No license on a real host: the request goes on untouched, nothing is recorded, nothing is protected. The app never
   * breaks over a license; the server's log and /health say what is missing.
   */
  private devCount: { at: number; n: number } | null = null;
  private devCapped: true | undefined;
  /** sessions this deployment started in the last 24 hours (counted at most once a minute) */
  private async devSessionsToday(now: number): Promise<number> {
    if (this.devCount && now - this.devCount.at < 60_000) return this.devCount.n;
    const n = await this.store.countSessionsSince(now - 86_400_000).catch(() => 0);
    this.devCount = { at: now, n };
    return n;
  }
  private unlicensed(input: DecideInput, now: number): DecideResult {
    const assessment: Assessment = { version: 'unlicensed', actor: 'unknown', score: null, tiers: [], reasons: [],
      metrics: { actions: 0, atomic: 0, organic: 0, untrusted: 0, keys: 0, markers: 0, focusConflicts: 0, hiddenClicks: 0, zeroPressure: 0 } };
    const decision: DecisionRow = {
      id: 'unlicensed', resource: input.resource, decision: 'allow', computed: 'allow', enforced: false, actor: 'unknown', score: null, tiers: [],
      reasonCodes: ['UNLICENSED'], policyVersion: 'unlicensed', signalVersion: 'unlicensed', branch: 'unprotected',
      room: input.room, session: input.session.id, latencyMs: 0, dataDelivered: true, simulated: true, assessment, created: now, prevHash: '', hash: '',
    };
    return { decision, proof: null, assessment, server: null as unknown as ServerSignal, stepUp: null };
  }

  async decide(input: DecideInput, now = Date.now()): Promise<DecideResult> {
    const licensed = this.license.mode(input.request);
    if (licensed === 'off') return this.unlicensed(input, now);
    // without a license, a local host is served for development: up to a development's size a day, not a whole site
    if (this.license.localOnly(input.request) && (await this.devSessionsToday(now)) > DEV_SESSIONS_PER_DAY) {
      this.devCapped ??= (console.warn(`onehuman: more than ${DEV_SESSIONS_PER_DAY} sessions today without a license; requests now pass through unprotected. A free API key at https://onehuman.ai/portal removes the limit (npx onehumanai connect).`), true);
      return this.unlicensed(input, now);
    }
    const t0 = performance.now();
    const thisRequest = await this.observe(input.request);
    // The stronger of "this request" and "how the session arrived".
    const arrival = input.session.arrival;
    const sigStatus = thisRequest.signature.status;
    // A request arriving now from an AI application's built-in browser is environment evidence now, even if
    // the session was opened from a normal browser (shared login across tabs/devices via identify()).
    const env = thisRequest.environment?.agentAppToken ? thisRequest.environment : arrival?.environment ?? thisRequest.environment;
    const server: ServerSignal = sigStatus === 'verified' || sigStatus === 'replay' || !arrival ? thisRequest : { ...arrival, environment: env, checkedMs: thisRequest.checkedMs };

    const snapshot = await this.withoutReplayedClick(input.session.id, input.snapshot, now);
    if (snapshot?.early) await this.store.addEvent(input.room, input.session.id, 'signal', snapshot.early, now);
    if (snapshot?.interaction) await this.store.addEvent(input.room, input.session.id, 'interaction', snapshot.interaction, now);
    await this.store.touchSession(input.session.id, now);
    const simulated = input.simulated === true;
    const conn = simulated ? null : await this.connectionFor(input.session, now);
    // Once an agent has attached to this session, the fact sticks: a control indicator that
    // disappeared (agent paused, or a person took over) does not make the session clean again.
    // The only way back is a WebAuthn user-verified assertion (a person pressed Touch ID / a
    // passkey) — and that reclaim covers a short window, after which the agent evidence returns.
    const fresh = await this.store.getSession(input.session.id);
    const attachedEarlier = fresh?.agentAttachedAt ?? null;
    const reclaimed = fresh?.humanVerifiedAt != null && now - fresh.humanVerifiedAt <= HUMAN_RECLAIM_TTL_MS && (attachedEarlier === null || fresh.humanVerifiedAt > attachedEarlier);
    const recent = await this.store.recentSignals(input.session.id, now, 120000, 6);
    const assessment = assess({ server, early: recent.early, interactions: recent.interactions, current: null, attachedEarlierMs: attachedEarlier === null || reclaimed ? null : attachedEarlier - input.session.created, humanVerified: reclaimed });

    // a plan past its free limit (after the grace period) watches and records, and enforces nothing
    const policy = licensed === 'observe' ? { ...(await this.policyFor(input.room)), enforcement: 'observe' as const } : await this.policyFor(input.room);
    let decision: Decision = evaluate(policy, input.resource, assessment, crypto.randomUUID());
    // the account owner's own say over their agent, inside the company's bounds (policy.ts applyOwnerChoice)
    if (decision.branch === 'agent' || decision.branch === 'artifact') {
      const owner = await this.store.agentAccessFor(this.accessScope(input.session), input.resource, now);
      decision = applyOwnerChoice(decision, policy.rules.find((r) => r.resource === input.resource), owner?.choice ?? null);
    }
    let stepUp: DecideResult['stepUp'] = null;
    if (decision.decision === 'step_up' || (decision.decision === 'block' && decision.branch === 'agent' && !reclaimed && this.webauthnReclaimEnabled)) {
      // a confirmation covers the one request it was given for: same method, path and body
      const digest = requestDigest(input.request);
      if (await this.store.consumeStepUpGrant(input.session.id, input.resource, now, digest)) {
        decision = { ...decision, decision: 'allow', reasonCodes: [...decision.reasonCodes, 'STEP_UP_PASSED'] };
      } else if (decision.decision === 'step_up') {
        const agentBranch = decision.branch === 'agent';
        const challenge = randomBytes(3).toString('hex').toUpperCase();
        // an approval step-up is stored with a marker the code path refuses: a passkey is the only way through
        const target = (input.request as Req & { originalUrl?: string }).originalUrl ?? input.request.url ?? '/';
        const summary: StepUpSummary = {
          title: policy.rules.find((r) => r.resource === input.resource)?.title || input.resource,
          request: `${(input.request.method ?? 'GET').toUpperCase()} ${target.split('?')[0]}`.slice(0, 200),
          detail: input.detail ? String(input.detail).slice(0, 300) : null,
        };
        const id = await this.store.createStepUp(input.session.id, input.resource, agentBranch ? `P:${randomBytes(12).toString('hex')}` : challenge, STEP_UP_TTL_MS, now, { digest, summary: JSON.stringify(summary) });
        // An agent is acting: the page it reads must not carry the code, or the agent confirms its own action.
        // Only the person can approve, with a passkey (purpose 'approve'); the session stays the agent's.
        stepUp = agentBranch
          ? { id, challenge: '', expiresAt: now + STEP_UP_TTL_MS, webauthn: true, approve: true, summary }
          : { id, challenge, expiresAt: now + STEP_UP_TTL_MS, webauthn: (await this.credentialsFor(input.session)).length > 0, summary };
      } else {
        // blocked as agent: offer the WebAuthn reclaim path in the response, decision stays block
        stepUp = { id: '', challenge: '', expiresAt: now + STEP_UP_TTL_MS, webauthn: true, reclaim: true };
      }
    }

    const row = await appendDecision(this.store, {
      ...decision,
      room: input.room,
      session: input.session.id,
      latencyMs: Math.round((performance.now() - t0) * 10) / 10,
      dataDelivered: decision.decision === 'allow',
      simulated,
      assessment,
      tools: conn?.tools.slice(0, 8) ?? [],
      connection: conn?.state ?? 'none',
      created: now,
    }, (r, seq) => this.prover.sign(r, seq));
    if (row.dataDelivered && !simulated) await this.store.markFirstData(input.session.id, now);
    if (assessment.actor === 'agent_likely' && !simulated) await this.store.markFirstAgent(input.session.id, now);
    bus.publish({ type: 'decision', room: input.room, session: input.session.id, at: now, id: row.id, resource: row.resource, decision: row.decision, actor: row.actor, reasonCodes: row.reasonCodes });
    if (!simulated && this.onDecision) { try { this.onDecision(row); } catch (e) { console.warn('onehuman: onDecision failed', e); } }
    const { seq: _seq, proof, ...decisionRow } = row;
    return { decision: decisionRow, proof, assessment, server, stepUp };
  }

  issueToken(decision: DecisionRow): string {
    return issueToken(this.secret, { session: decision.session, resource: decision.resource, decision: decision.decision, decisionId: decision.id }, TOKEN_TTL_MS);
  }

  /** Verify and consume a single-use token. */
  async redeemToken(token: string, session: string, resource: string): Promise<TokenCheck | { ok: false; reason: 'reused' }> {
    const check = verifyToken(this.secret, token, { session, resource });
    if (!check.ok) return check;
    if (!(await this.store.consumeNonce(`jti:${check.claims.jti}`, Math.max(1000, check.claims.exp - Date.now() + 1000)))) return { ok: false, reason: 'reused' };
    return check;
  }

  /**
   * Node http adapter. Resolves the session, decides, writes the audit row and
   * either responds (block / step-up) or calls the handler with the context.
   */
  protect(resource: string, handler: (req: Req, res: Res, ctx: ProtectContext) => void | Promise<void>, opts: { simulated?: (req: Req) => boolean } = {}) {
    return async (req: Req, res: Res): Promise<void> => {
      const resolved = await this.resolveSession(req);
      if (!resolved) {
        json(res, 401, { error: 'no_session', message: 'Session not found. Reload the page.' });
        return;
      }
      const result = await this.decide({ room: resolved.room, session: resolved.session, resource, request: req, snapshot: this.snapshotFrom(req), simulated: opts.simulated?.(req) ?? false });
      const { decision, assessment } = result;
      const headers = { 'X-OH-Decision': decision.id, 'X-OH-Policy': decision.policyVersion };
      if (decision.decision === 'block') {
        json(res, 403, { error: 'blocked', resource, decision: publicDecision(decision), assessment, stepUp: result.stepUp }, headers);
        return;
      }
      if (decision.decision === 'step_up') {
        json(res, 428, { error: 'step_up_required', resource, decision: publicDecision(decision), assessment, stepUp: result.stepUp }, headers);
        return;
      }
      res.setHeader('X-OH-Decision', decision.id);
      res.setHeader('X-OH-Policy', decision.policyVersion);
      await handler(req, res, {
        room: resolved.room,
        session: resolved.session,
        decision,
        assessment,
        masked: decision.decision === 'mask',
        token: () => this.issueToken(decision),
      });
    };
  }
}

/** What a client may see about a decision (the audit row keeps more). */
export function publicDecision(d: DecisionRow) {
  return {
    id: d.id,
    resource: d.resource,
    decision: d.decision,
    computed: d.computed,
    enforced: d.enforced,
    branch: d.branch,
    actor: d.actor,
    score: d.score,
    tiers: d.tiers,
    reasonCodes: d.reasonCodes,
    policyVersion: d.policyVersion,
    signalVersion: d.signalVersion,
    latencyMs: d.latencyMs,
    created: d.created,
  };
}
