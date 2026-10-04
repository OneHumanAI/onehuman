// SPDX-License-Identifier: Apache-2.0
/**
 * OneHuman for Express / Connect / plain Node http.
 *
 *   import { onehuman } from 'onehumanai';
 *   const oh = await onehuman({ secret: process.env.ONEHUMAN_SECRET, policy: './onehuman.policy.json', db: 'sqlite:./onehuman.db' });
 *   app.use(oh.middleware());                       // serves /onehuman/sdk.js + the SDK's API
 *   app.get('/api/balance', oh.protect('balance.read'), (req, res) => oh.send(req, res, balance, maskBalance));
 *
 * The company keeps full control: the policy is its JSON file, `mask` is its own function, the decision
 * arrives on `req.onehuman` and nothing here touches its authentication. Storage is local (sqlite) or libSQL, so the
 * package runs on-prem; telemetry never has to leave the company's network.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// The engine (BUSL-1.1) sits next to this adapter in the package; the adapter talks to it only through its
// public surface. In this repository that is ../../server/public.ts; the build rewrites it to ./engine.js.
import {
  ENGINE_VERSION, OneHuman, SERVER_LIMITS, Store, anchorChains, applySignatures, attachModel, checkPolicy, clientSignatureRules, cookies, json, libsqlClient, loadModel, parsePolicy, predict, publicDecision,
  sessionRoutes, sqliteClient, url, webauthnRoutes, accessRoutes,
  type Assessment, type DecideResult, type DecisionRow, type Policy, type SessionRow, type SqlClient,
} from '../../server/public.ts';
import { proofBundle, verifyProof, type ProofJwk } from '../proof/verify.ts';
import { createPolicySync, type PolicyStatus } from './policy-sync.ts';
import { createSignatureSync } from './signature-sync.ts';
import { buildReport, type Report } from '../report/build.ts';
import { renderReportHtml } from '../report/html.ts';

export type Req = IncomingMessage & { onehuman?: ProtectResult };
export type Res = ServerResponse;
export type Next = (err?: unknown) => void;

export type OneHumanOptions = {
  /**
   * The policy file (path) or object. With an `apiKey` the portal is where the policy lives: on the first start this
   * file is sent there and becomes version 1; after that the server reads the policy from the portal and sends this
   * file again only when it changes. Optional when an `apiKey` is given and the portal already holds the policy.
   */
  policy?: string | Policy;
  /**
   * Read the policy from the portal (default true when an `apiKey` is set). False keeps the file as the only
   * source — for servers that cannot reach the internet.
   */
  policyFromPortal?: boolean;
  /** the portal's address (default: ONEHUMAN_PORTAL_URL, or the origin of `telemetryUrl`) */
  portalUrl?: string;
  /** ≥ 32 bytes; signs single-use tokens and derives the tenant room id — keep it stable across restarts */
  secret: string | Buffer;
  /** 'memory' | 'sqlite:./onehuman.db' | 'file:./onehuman.db' | 'libsql://host?authToken=…'  (default sqlite:./onehuman.db) */
  db?: string;
  /** an already open storage client (instead of `db`): for a host that runs OneHuman next to its own database connection */
  client?: SqlClient;
  /** an already open store (instead of `db` and `client`): a host whose storage is not SQL brings its own */
  store?: Store;
  /** where the SDK and its API live (default '/onehuman') */
  basePath?: string;
  /**
   * Map a request to the company's own authenticated session / user id. When given, every tab of one
   * login shares one OneHuman session (an agent in one tab marks the whole login). When omitted, a
   * first-party cookie identifies the browser.
   */
  identify?: (req: IncomingMessage) => string | null | undefined | Promise<string | null | undefined>;
  /**
   * Tell the page why a decision was made (reason codes, score, the evidence of an attached agent). Default off:
   * the page is where the agent is, and the reasons would show it what to hide. Turn on while developing
   * (or ONEHUMAN_EXPLAIN=1); the reasons are always in the audit log and the portal.
   */
  explain?: boolean;
  /** Rotate the proof signing key without a new secret: sign with epoch N and keep publishing 0..N-1 (default ONEHUMAN_PROOF_EPOCH). */
  proofEpoch?: number;
  /** Public keys of proofs made before the secret changed (what `npx onehumanai proof-keys` printed), or ONEHUMAN_RETIRED_PROOF_KEYS. */
  retiredProofKeys?: ProofJwk[];
  /**
   * Anchor the audit chain with RFC 3161 timestamps: every `everyMs` (default 1 h) the chain head's hash (only the hash)
   * goes to `tsa` and its signed answer is kept (`npx onehumanai anchors`). Off by default; or ONEHUMAN_TSA_URL.
   */
  anchor?: { tsa: string; everyMs?: number };
  /** cookie name (default 'oh_sid') */
  cookie?: string;
  /** set the Secure flag on the cookie; default: when the request is https or behind x-forwarded-proto=https */
  secure?: boolean;
  /** tenant name; one persistent room per tenant (default 'default') */
  tenant?: string;
  /** protect() answers block (403) and step_up (428) itself; set false to handle them in your handler (default true) */
  respond?: boolean;
  /** show the WebAuthn "I am human" reclaim path on agent blocks (default true) */
  webauthnReclaim?: boolean;
  /**
   * Report decisions to your OneHuman portal (https://onehuman.ai/portal) so you can see how
   * many of your sessions had an AI agent in them. Metadata only — hashed session id, resource, decision,
   * actor, connection state, detected tools, reason codes. Never payloads, identities or IPs.
   * Default: process.env.ONEHUMAN_API_KEY. Without a key nothing leaves your server.
   */
  apiKey?: string;
  /**
   * Send each report as soon as it is made instead of batching every 3 s. On by default on Vercel, AWS Lambda,
   * Netlify and Azure Functions (a frozen function never reaches its timer); turn it on for any other
   * platform that suspends the process between requests.
   */
  telemetryImmediate?: boolean;
  /** where reports go (default https://onehuman.ai/api/v1/ingest, or ONEHUMAN_TELEMETRY_URL) */
  telemetryUrl?: string;
  /**
   * How long a protected request waits for a decision before it goes on without one (default 1000 ms, or
   * ONEHUMAN_TIMEOUT_MS). OneHuman never makes your app fail: if the engine is slow or throws, the request
   * continues as if allowed, is logged as `unknown`, and is counted in `health().failOpen`.
   */
  decisionTimeoutMs?: number;
  /**
   * In enforce mode, what a request does when there is no decision in time: `true` (default) lets it through,
   * `false` answers 503 so nothing protected is served without a decision. Observe mode always lets it through.
   */
  failOpen?: boolean;
  /**
   * Keep a byte-exact copy of everything the page script sends (default false, or ONEHUMAN_RECORD_RAW=1), so
   * `npx onehumanai inspect` can show it as received. Local database only; never sent anywhere.
   */
  recordRaw?: boolean;
};

export type ProtectResult = {
  /** allow | mask | block | step_up */
  decision: DecisionRow['decision'];
  /** true → return the masked variant of the data */
  masked: boolean;
  blocked: boolean;
  stepUp: DecideResult['stepUp'];
  actor: Assessment['actor'];
  score: number | null;
  reasonCodes: string[];
  session: SessionRow;
  full: DecisionRow;
  assessment: Assessment;
  /** single-use token bound to this decision (for download URLs) */
  token(): string;
  /**
   * Signed proof of this decision (compact JWS, EdDSA). Server-side only — nothing is added to the
   * response the end user receives. Keep it with your own records if you want; the engine stores it too.
   */
  proof: string | null;
  /**
   * Set when there was no decision in time (`ENGINE_TIMEOUT`) or the engine failed (`ENGINE_ERROR`): the request
   * went on as allowed. `session`, `full` and `assessment` are then null.
   */
  failedOpen?: 'ENGINE_TIMEOUT' | 'ENGINE_ERROR';
};

const HERE = dirname(fileURLToPath(import.meta.url));
// repo layout: integrations/express/index.ts → ../../sdk ; published layout: dist/express.js → ../sdk
const SDK_PATH = [join(HERE, '..', 'sdk', 'onehuman.js'), join(HERE, '..', '..', 'sdk', 'onehuman.js')].find((p) => existsSync(p)) ?? join(HERE, '..', 'sdk', 'onehuman.js');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** open the database named by a `db` option string (also used by `npx onehumanai inspect / report`) */
export async function openClient(db: string): Promise<SqlClient> {
  if (db === 'memory' || db === ':memory:') return sqliteClient(':memory:');
  if (db.startsWith('libsql://') || db.startsWith('https://')) {
    const u = new URL(db);
    const token = u.searchParams.get('authToken') ?? process.env.TURSO_AUTH_TOKEN;
    u.searchParams.delete('authToken');
    return libsqlClient(u.toString(), token ?? undefined);
  }
  const path = db.replace(/^(sqlite|file):/, '');
  return sqliteClient(isAbsolute(path) ? path : resolve(process.cwd(), path));
}

/** RFC 4122-shaped id from an HMAC, so ids are deterministic per (secret, name) and pass the engine's UUID checks. */
function derivedUuid(secret: Buffer, kind: string, name: string): string {
  const h = createHmac('sha256', secret).update(`${kind}\0${name}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** `computed`: what the policy chose — in observe mode `decision` is always allow, `computed` is what protect mode would do */
type TelemetryEvent = { at: number; session: string; resource: string; decision: string; computed?: string; actor: string; state: string; tools: string[]; reasons: string[]; enforcement: string; version: string; proof?: string; eid?: string };

/** Buffers decision events and posts them to the portal in the background. Drops rather than blocks. */
/**
 * On a serverless platform the function is frozen as soon as the response is sent: a batch waiting for its
 * 3-second timer is sent on the next invocation at best, or lost with the instance. There, every event is
 * sent right away, and on Vercel the send is registered with the request's `waitUntil` so the platform keeps
 * the function alive until it finishes.
 */
const SERVERLESS = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY || process.env.FUNCTIONS_WORKER_RUNTIME);
function keepAlive(p: Promise<unknown>) {
  try {
    const ctx = (globalThis as unknown as Record<symbol, { get?: () => { waitUntil?: (p: Promise<unknown>) => void } | undefined } | undefined>)[Symbol.for('@vercel/request-context')]?.get?.();
    ctx?.waitUntil?.(p);
  } catch { /* not on Vercel */ }
}

function createReporter(apiKey: string, endpoint: string, keys: ProofJwk[], eager = SERVERLESS) {
  let queue: TelemetryEvent[] = [];
  let timer: NodeJS.Timeout | null = null;
  let sending = false;
  let failures = 0;
  const MAX = 500, BATCH = 25, EVERY_MS = 3000;
  async function flush(): Promise<void> {
    if (sending || !queue.length) return;
    if (failures && Date.now() < backoffUntil) return;
    sending = true;
    const batch = queue.splice(0, 100);   // a signed event is ~1 KB; 100 stays well under the ingest limit
    try {
      const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ events: batch, keys }), signal: AbortSignal.timeout(10000) });
      if (r.status === 401) { failures = 999; console.warn('onehuman: telemetry API key rejected — check apiKey / ONEHUMAN_API_KEY'); queue = []; }
      else if (!r.ok) throw new Error(String(r.status));
      else { failures = 0; if (eager && queue.length) setTimeout(() => { keepAlive(flush()); }, 0); }
    } catch {
      failures++; backoffUntil = Date.now() + Math.min(60_000, 2000 * 2 ** Math.min(failures, 5));
      queue = [...batch, ...queue].slice(-MAX);   // keep the newest
    } finally { sending = false; }
  }
  let backoffUntil = 0;
  function push(e: TelemetryEvent) {
    if (failures >= 999) return;
    queue.push({ ...e, eid: e.eid ?? randomUUID() });   // a retried batch repeats these ids; the portal counts each once if (queue.length > MAX) queue = queue.slice(-MAX);
    if (eager) keepAlive(flush());
    else if (queue.length >= BATCH) void flush();
    if (!timer) { timer = setInterval(() => { void flush(); }, EVERY_MS); timer.unref?.(); }
  }
  return { push, flush, get pending() { return queue.length; }, close() { if (timer) clearInterval(timer); timer = null; return flush(); } };
}

declare const __ONEHUMAN_VERSION__: string | undefined;
/** this package's version, stamped by the build; from source both sides read 0.0.0-dev and the check is skipped */
const PACKAGE_VERSION: string = typeof __ONEHUMAN_VERSION__ === 'string' ? __ONEHUMAN_VERSION__ : '0.0.0-dev';

export async function onehuman(opts: OneHumanOptions) {
  // the middleware and the engine are built into one package at one version; a half-updated install fails here, not deep and late
  if (PACKAGE_VERSION !== '0.0.0-dev' && ENGINE_VERSION !== '0.0.0-dev' && PACKAGE_VERSION !== ENGINE_VERSION) {
    throw new Error(`onehumanai: the middleware is ${PACKAGE_VERSION} but its engine is ${ENGINE_VERSION} — the install is broken; run \`npm i onehumanai@${PACKAGE_VERSION}\` again.`);
  }
  const secret = Buffer.isBuffer(opts.secret) ? opts.secret : Buffer.from(opts.secret ?? '', 'utf8');
  if (secret.length < 32) throw new Error(opts.secret ? 'onehuman: secret must be at least 32 bytes' : 'onehuman: no secret. Run `npx onehumanai init` in this project (it writes ONEHUMAN_SECRET to .env), or pass secret yourself.');
  const basePath = (opts.basePath ?? '/onehuman').replace(/\/$/, '');
  const cookieName = opts.cookie ?? 'oh_sid';
  const tenant = opts.tenant ?? 'default';
  const respond = opts.respond ?? true;
  const decisionTimeoutMs = opts.decisionTimeoutMs ?? (Number(process.env.ONEHUMAN_TIMEOUT_MS) || 1000);
  const failOpen = opts.failOpen ?? true;
  const recordRaw = opts.recordRaw ?? process.env.ONEHUMAN_RECORD_RAW === '1';
  const failures = { count: 0, lastReason: null as string | null, lastError: null as string | null, lastAt: null as number | null };
  let lastFailWarn = 0;
  const apiKey = opts.apiKey ?? process.env.ONEHUMAN_API_KEY ?? '';
  const sessionHash = (id: string) => createHash('sha256').update(apiKey).update('\0').update(id).digest('hex').slice(0, 16);

  // one room holds every visitor of this app: limits are per session and by age, never a cap on visitors
  const store = opts.store ?? await Store.open(opts.client ?? await openClient(opts.db ?? 'sqlite:./onehuman.db'), { limits: SERVER_LIMITS });
  const model = await loadModel();
  attachModel(model ? { predict: (f) => predict(model, f), humanAbove: model.humanAbove, syntheticBelow: model.syntheticBelow } : null);
  const engine = new OneHuman({ store, secret, sessionCookie: cookieName, proofEpoch: opts.proofEpoch, retiredProofKeys: opts.retiredProofKeys });
  const telemetryUrl = opts.telemetryUrl ?? process.env.ONEHUMAN_TELEMETRY_URL ?? 'https://onehuman.ai/api/v1/ingest';
  const reporter = apiKey ? createReporter(apiKey, telemetryUrl, engine.proofKeys().keys, opts.telemetryImmediate ?? SERVERLESS) : null;
  engine.webauthnReclaimEnabled = opts.webauthnReclaim ?? true;
  const room = derivedUuid(secret, 'room', tenant);
  await store.ensureRoom(room, `tenant:${tenant}`);

  async function loadPolicy(src: string | Policy): Promise<Policy> {
    const text = typeof src === 'string' ? await readFile(src, 'utf8').catch((e: NodeJS.ErrnoException) => { throw new Error(e.code === 'ENOENT' ? `onehuman: no rules file at ${src}. Run \`npx onehumanai init\` in this project to create it.` : e.message); }) : null;
    const raw = typeof src === 'string' ? JSON.parse(text!) : src;
    const version = typeof raw?.version === 'string' ? raw.version : `policy-${tenant}-${Date.now()}`;
    const checked = checkPolicy(raw, version);
    if ('error' in checked) throw new Error(`onehuman: the policy${typeof src === 'string' ? ` in ${src}` : ''} is invalid: ${checked.error}`);
    const parsed = checked.policy;
    return parsed;
  }
  const portalUrl = opts.portalUrl ?? process.env.ONEHUMAN_PORTAL_URL ?? new URL(telemetryUrl).origin;
  const fromPortal = !!apiKey && opts.policyFromPortal !== false;
  if (opts.policy === undefined && !fromPortal) throw new Error('onehuman: give a `policy` file, or an `apiKey` so the policy can come from the portal');
  let filePolicy: Policy | null = opts.policy === undefined ? null : await loadPolicy(opts.policy);
  // With an API key the portal holds the policy; this server keeps a signed copy for when the portal is unreachable.
  const sync = fromPortal
    ? createPolicySync({
      store, apiKey, filePath: typeof opts.policy === 'string' ? opts.policy : null, initialFile: filePolicy,
      portalUrl,
      parse: (raw, version) => parsePolicy(raw, version),
    })
    : null;
  if (sync) await sync.init();
  // agent signature updates: newer detection definitions, signed by OneHuman, without a package release
  const signatures = createSignatureSync({ store, apiKey: apiKey || null, portalUrl, engineVersion: ENGINE_VERSION, apply: (rules, meta) => applySignatures(rules, meta) });
  await signatures.init();
  const currentPolicy = (): Policy => (sync ? sync.policy : filePolicy!);
  engine.policyForApp = () => currentPolicy();
  /** Re-read the policy: from the portal (and send the file if it changed), or from the file when there is no portal. */
  async function reloadPolicy() {
    if (sync) await sync.refresh();
    else if (opts.policy !== undefined) filePolicy = await loadPolicy(opts.policy);
    return currentPolicy();
  }
  /** Which policy runs and where it came from: portal, saved copy (portal unreachable) or the file in your code. */
  const policySource = (): PolicyStatus => (sync ? sync.status() : { version: filePolicy!.version, source: 'file', n: null, confirmedAt: null, lastCheckAt: null, portalReachable: null, lastProposal: null, problem: null });
  // outside production, responses say where the policy came from, so a developer can see it in the network tab
  const debugPolicyHeader = process.env.NODE_ENV !== 'production';

  const isSecure = (req: IncomingMessage) => opts.secure ?? (url(req).protocol === 'https:' || req.headers['x-forwarded-proto'] === 'https');
  const setCookie = (req: IncomingMessage, res: ServerResponse, id: string) => {
    const prev = res.getHeader('Set-Cookie');
    const value = `${cookieName}=${id}; Path=/; HttpOnly; SameSite=Lax${isSecure(req) ? '; Secure' : ''}`;
    res.setHeader('Set-Cookie', Array.isArray(prev) ? [...prev, value] : prev ? [String(prev), value] : value);
  };

  // The one integration mistake that has bitten a real deployment: `identify()` returning a constant
  // ("user", the tenant name, a hard-coded id). Every visitor then shares one OneHuman session, and a single
  // agent test marks the whole site "agent" for everyone. The engine cannot tell a constant from a real id,
  // but it can see the symptom: one identity arriving from many different clients. Warn loudly, once.
  const clientsByIdentity = new Map<string, Set<string>>();
  let identityWarning: string | null = null;
  let objectIdentityWarned = false;
  function watchIdentity(identity: string, req: IncomingMessage) {
    if (identityWarning) return;
    const ip = String(req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? '').split(',')[0]!.trim();
    const ua = String(req.headers['user-agent'] ?? '').slice(0, 80);
    let seen = clientsByIdentity.get(identity);
    if (!seen) { if (clientsByIdentity.size >= 500) clientsByIdentity.clear(); seen = new Set(); clientsByIdentity.set(identity, seen); }
    seen.add(`${ip}|${ua}`);
    if (seen.size >= 5) {
      identityWarning = `identify() returned "${identity.slice(0, 40)}" for ${seen.size} different clients (distinct IP or browser). That is a constant, not a login id: every visitor is sharing one session and one agent will mark them all. Return req.session.userId / req.user.id, or null.`;
      console.error(`onehuman: ${identityWarning}`);
    }
  }

  /** The OneHuman session for this request: derived from `identify()` or from the first-party cookie. Creates it on first sight. */
  async function sessionFor(req: IncomingMessage, res: ServerResponse): Promise<SessionRow> {
    let identity: unknown = opts.identify ? await opts.identify(req) : null;
    if (identity !== null && typeof identity === 'object') {
      // `req.session.user` instead of `req.session.user.id`: every object would become "[object Object]", one session for all
      if (!objectIdentityWarned) { objectIdentityWarned = true; console.error('onehuman: identify() returned an object, not an id — ignored (each browser gets its own session). Return the login id, e.g. req.session.user.id.'); }
      identity = null;
    }
    if (identity) {
      watchIdentity(String(identity), req);
      const id = derivedUuid(secret, 'session', String(identity));
      const fromCookie = cookies(req)[cookieName];
      const existing = await store.getSession(id) ?? await store.ensureSession(id, room, await engine.observe(req));
      if (fromCookie !== id) {
        // this browser reported to its own session before the login was known (the page script runs from the first
        // page, often before the login): its evidence moves to the login's session before the first decision
        if (fromCookie && UUID.test(fromCookie)) await store.carryOverEvidence(fromCookie, id).catch(() => false);
        setCookie(req, res, id);
      }
      return existing;
    }
    const fromCookie = cookies(req)[cookieName];
    if (fromCookie && UUID.test(fromCookie)) { const s = await store.getSession(fromCookie); if (s && s.room === room) return s; }
    const id = await store.createSession(room, 'unlabelled', await engine.observe(req));
    if (!id) throw new Error('onehuman: session limit reached');
    setCookie(req, res, id);
    return (await store.getSession(id))!;
  }

  // what the page sees of a decision: the outcome; the reasons stay in the audit log and the portal (explain: true shows them)
  const explain = opts.explain ?? process.env.ONEHUMAN_EXPLAIN === '1';
  const clientDecision = (d: DecisionRow) => (explain ? publicDecision(d) : { id: d.id, resource: d.resource, decision: d.decision });
  const pageRoutes = sessionRoutes(engine, { explain });
  const wa = webauthnRoutes(engine);
  const access = accessRoutes(engine);
  const api: Record<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>> = {
    'POST /signals': pageRoutes.signals,
    'GET /connection': pageRoutes.connection,
    'GET /session': pageRoutes.me,
    'POST /step-up': pageRoutes.stepUp,
    'POST /webauthn/register/options': wa.registerOptions,
    'POST /webauthn/register': wa.register,
    'POST /webauthn/assert/options': wa.assertOptions,
    'POST /webauthn/assert': wa.assert,
    'GET /webauthn/status': wa.status,
    'GET /access': access.get,
    'POST /access': access.set,
  };
  let sdkCache: Buffer | null = null;

  /** Serves `${basePath}/sdk.js` and the SDK's API; everything else passes through. */
  function middleware() {
    return async (req: Req, res: Res, next: Next) => {
      try {
        const u = url(req);
        if (!u.pathname.startsWith(basePath + '/')) return next();
        const sub = u.pathname.slice(basePath.length);
        if (sub === '/sdk.js' && req.method === 'GET') {
          sdkCache ??= await readFile(SDK_PATH);
          // signatures a verified bundle added travel with the script, so the page looks for them from its first moment
          const extra = clientSignatureRules();
          const body = extra ? Buffer.concat([Buffer.from(`window.__ONEHUMAN_RULES__=${extra};\n`), sdkCache]) : sdkCache;
          res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'Content-Length': body.length });
          res.end(body);
          return;
        }
        // what an operator's monitoring asks: is it up, which policy, is the reporter healthy, any integration warning
        if (sub === '/health' && req.method === 'GET') {
          return json(res, identityWarning ? 503 : 200, health());
        }
        // the public key that verifies this deployment's decision proofs — an auditor fetches it from here
        if (sub === '/proof-keys' && req.method === 'GET') {
          const body = JSON.stringify(engine.proofKeys());
          res.writeHead(200, { 'Content-Type': 'application/jwk-set+json', 'Cache-Control': 'public, max-age=3600', 'Content-Length': Buffer.byteLength(body) });
          res.end(body);
          return;
        }
        const handler = api[`${req.method} ${sub}`];
        if (!handler) return next();
        // raw recording: read the page's body here, keep it as received, hand the parsed JSON to the handler
        let raw: string | null = null;
        if (recordRaw && req.method === 'POST' && sub === '/signals' && (req as Req & { body?: unknown }).body === undefined) {
          const chunks: Buffer[] = []; let size = 0;
          for await (const c of req) { size += (c as Buffer).length; if (size > 16000) break; chunks.push(c as Buffer); }
          raw = Buffer.concat(chunks).toString('utf8');
          try { (req as Req & { body?: unknown }).body = JSON.parse(raw); } catch { (req as Req & { body?: unknown }).body = null; }
        }
        // the engine's routes resolve the session from the request cookie; with identify() (or on a very first
        // request) that cookie may only exist on the response, so it is made visible on the request too
        const session = await sessionFor(req, res);
        if (cookies(req)[cookieName] !== session.id) req.headers.cookie = `${req.headers.cookie ? req.headers.cookie + '; ' : ''}${cookieName}=${session.id}`;
        if (raw !== null) await store.addEvent(room, session.id, 'raw', { source: 'POST /signals', body: raw });
        await handler(req, res);
      } catch (e) {
        // these are OneHuman's own routes: answer here, never through the app's error handler
        console.warn(`onehuman: ${req.method} ${req.url} failed — ${(e as Error).message}`);
        if (!res.headersSent) json(res, 503, { error: 'onehuman_unavailable' }); else res.end();
      }
    };
  }

  /**
   * Decide for `resource`; the result is on `req.onehuman`. Block → 403, step-up → 428 (unless `respond: false`).
   * `mask`: what to send when the decision is mask and the handler answers with Express's `res.json()` —
   * `'auto'` hides every value and keeps the shape and ids, or pass your own function. Without it, the
   * handler decides (check `req.onehuman.masked`, or use `oh.send()`).
   */
  function protect(resource: string, local: { respond?: boolean; mask?: 'auto' | ((body: unknown) => unknown) } = {}) {
    const answer = local.respond ?? respond;
    sync?.declare(resource);   // the portal lists endpoints that have no rule yet
    return (req: Req, res: Res, next: Next) => {
      sync?.maybeRefresh();
      signatures.maybeRefresh();
      let settled = false;
      const timer = setTimeout(() => giveUp('ENGINE_TIMEOUT'), decisionTimeoutMs);
      timer.unref?.();
      // No decision in time, or the engine failed: the request goes on as allowed — OneHuman never breaks the app.
      function giveUp(reason: 'ENGINE_TIMEOUT' | 'ENGINE_ERROR', err?: unknown) {
        if (settled) return;
        settled = true; clearTimeout(timer);
        failures.count++; failures.lastReason = reason; failures.lastAt = Date.now(); failures.lastError = err ? String((err as Error).message ?? err) : null;
        if (Date.now() - lastFailWarn > 60_000) {
          lastFailWarn = Date.now();
          console.warn(`onehuman: ${resource} — ${reason === 'ENGINE_TIMEOUT' ? `no decision within ${decisionTimeoutMs} ms` : `engine error: ${failures.lastError}`}; the request went on without one (${failures.count} so far, see /health).`);
        }
        const enforce = currentPolicy().enforcement === 'enforce';
        if (!res.headersSent) res.setHeader('X-OH-Decision', `failed-open:${reason}`);
        reporter?.push({ at: Date.now(), session: sessionHash(cookies(req)[cookieName] ?? 'failed-open'), resource, decision: 'allow', computed: 'allow', actor: 'unknown', state: 'none', tools: [], reasons: [reason], enforcement: currentPolicy().enforcement, version: 'failed-open' });
        if (enforce && !failOpen) { if (!res.headersSent) json(res, 503, { error: 'onehuman_unavailable', resource }); return; }
        req.onehuman = {
          decision: 'allow', masked: false, blocked: false, stepUp: null as unknown as DecideResult['stepUp'], actor: 'unknown', score: null,
          reasonCodes: [reason], session: null as unknown as SessionRow, full: null as unknown as DecisionRow, assessment: null as unknown as Assessment,
          token: () => '', proof: null, failedOpen: reason,
        };
        next();
      }
      (async () => {
        const session = await sessionFor(req, res);
        const sample = req.headers['x-oh-sample'];
        if (recordRaw && typeof sample === 'string') await store.addEvent(room, session.id, 'raw', { source: `X-OH-Sample header on ${resource}`, body: sample });
        const result = await engine.decide({ room, session, resource, request: req, snapshot: engine.snapshotFrom(req) });
        return { session, result };
      })().then(({ session, result }) => {
        if (settled) return;   // too late: the request already went on without a decision
        settled = true; clearTimeout(timer);
        try {
          const d = result.decision;
          req.onehuman = {
            decision: d.decision, masked: d.decision === 'mask', blocked: d.decision === 'block', stepUp: result.stepUp,
            actor: d.actor, score: d.score, reasonCodes: d.reasonCodes, session, full: d, assessment: result.assessment,
            token: () => engine.issueToken(d), proof: result.proof,
          };
          res.setHeader('X-OH-Decision', d.id);
          // the outcome, never the reasons: what was done, what protect mode would do (observe), and who it looked like
          // (production without explain: the decision only — `computed` and `actor` would let an agent tune itself)
          res.setHeader('X-OH-Outcome', explain || debugPolicyHeader ? `${d.decision}; computed=${d.computed}; actor=${d.actor}` : d.decision);
          res.setHeader('X-OH-Policy', d.policyVersion);
          if (debugPolicyHeader) res.setHeader('X-OH-Policy-Source', sync ? sync.source : 'file');
          if (reporter) report(session, resource, d, result);
          if (answer && d.decision === 'block') return json(res, 403, { error: 'blocked', resource, decision: clientDecision(d), stepUp: result.stepUp });
          if (answer && d.decision === 'step_up') return json(res, 428, { error: 'step_up_required', resource, decision: clientDecision(d), stepUp: result.stepUp });
          const r = res as Res & { json?: (body: unknown) => unknown };
          if (d.decision === 'mask' && local.mask && typeof r.json === 'function') {
            const original = r.json.bind(res);
            const mask = local.mask === 'auto' ? autoMask : local.mask;
            r.json = (body: unknown) => original(mask(body));
          }
        } catch (e) { settled = false; return giveUp('ENGINE_ERROR', e); }
        next();
      }, (e) => giveUp('ENGINE_ERROR', e));
    };
  }

  /** One event per decision, off the request path: what happened, to which resource, who was acting, which tool. */
  function report(session: SessionRow, resource: string, d: DecisionRow, result: DecideResult) {
    if (!reporter) return;
    engine.connectionFor(session).then((c) => {
      reporter.push({
        at: Date.now(), session: sessionHash(session.id), resource, decision: d.decision, computed: d.computed, actor: d.actor, state: c.state,
        tools: c.tools.slice(0, 8), reasons: d.reasonCodes.slice(0, 8), enforcement: currentPolicy().enforcement, version: result.assessment.version,
        ...(result.proof ? { proof: result.proof } : {}),
      });
    }).catch(() => {});
  }

  /** Respond with `full`, or with `mask(full)` when the decision says mask. Adds the decision summary under `_onehuman`. */
  function send<T>(req: Req, res: Res, full: T, mask: (full: T) => unknown) {
    const oh = req.onehuman;
    const body = oh?.masked ? mask(full) : full;
    json(res, 200, { ...(body as object), _onehuman: oh ? (explain ? { decision: oh.decision, actor: oh.actor, score: oh.score, reasonCodes: oh.reasonCodes } : { decision: oh.decision }) : null });
  }

  /** the background reporter (null without an apiKey): `await oh.telemetry?.flush()` before exit if you want the last events delivered */
  const telemetry = reporter ? { flush: () => reporter.flush(), get pending() { return reporter.pending; } } : null;

  // RFC 3161 anchoring of the audit chain: off the request path, only the chain head's hash leaves
  const tsa = opts.anchor?.tsa ?? process.env.ONEHUMAN_TSA_URL ?? '';
  const anchors = { lastRunAt: null as number | null, anchored: 0, lastError: null as string | null };
  async function anchorNow() {
    if (!tsa) return [];
    const res = await anchorChains(store, { tsa });
    anchors.lastRunAt = Date.now();
    anchors.anchored += res.filter((r) => r.ok).length;
    const err = res.find((r) => !r.ok);
    anchors.lastError = err ? err.error ?? 'failed' : null;
    if (err) console.warn(`onehuman: anchoring the audit chain at ${tsa} failed: ${anchors.lastError}`);
    return res;
  }
  const anchorTimer = tsa ? setInterval(() => { anchorNow().catch(() => {}); }, Math.max(60_000, opts.anchor?.everyMs ?? (Number(process.env.ONEHUMAN_TSA_EVERY_MS) || 3_600_000))) : null;
  anchorTimer?.unref?.();
  /** Liveness and configuration in one object; `${basePath}/health` serves it (503 while an integration warning stands). */
  function health() {
    return {
      ok: !identityWarning,
      policy: { ...policySource(), version: currentPolicy().version, enforcement: currentPolicy().enforcement, resources: currentPolicy().rules.length },
      signatures: signatures.status(),
      telemetry: reporter ? { enabled: true, pending: reporter.pending, immediate: opts.telemetryImmediate ?? SERVERLESS } : { enabled: false },
      proofKey: engine.proofKeys().keys[0]!.kid,
      proofKeys: engine.proofKeys().keys.length,
      anchors: tsa ? { tsa, ...anchors } : { enabled: false },
      failOpen: { timeoutMs: decisionTimeoutMs, enforceFailsOpen: failOpen, ...failures },
      warnings: identityWarning ? [identityWarning] : [],
    };
  }

  // --- proofs: what a business hands an auditor --------------------------------------------------
  /** the JWK Set that verifies this deployment's proofs (also served at `${basePath}/proof-keys`) */
  const proofKeys = () => engine.proofKeys();
  /** the signed proof of one decision, by its id (`req.onehuman.full.id`, or the `X-OH-Decision` header you log) */
  const proofFor = (decisionId: string) => store.decisionProof(decisionId);
  /** every signed decision for one session, as a self-contained file an auditor can check offline */
  async function proofBundleFor(sessionId: string) {
    const rows = await store.sessionProofs(sessionId);
    return proofBundle(rows.map((r) => r.proof), engine.proofKeys().keys, { session: sessionId, decisions: rows.length });
  }
  /**
   * The design-partner report from this server's own audit log: sessions with an agent, which agents, which
   * endpoints they touched, and what the rules did — or, in observe mode, would have done. Nothing is sent anywhere.
   */
  async function localReport(o: { days?: number; from?: number; to?: number; app?: string } = {}): Promise<Report> {
    const to = o.to ?? Date.now(), from = o.from ?? to - (o.days ?? 30) * 86_400_000;
    const rows = await store.decisionsBetween(from, to, room);
    return buildReport(rows, { from, to, source: 'server', app: o.app ?? '', sessionTools: await store.attachToolsBetween(from, to) });
  }
  const reportHtml = async (o: Parameters<typeof localReport>[0] = {}) => renderReportHtml(await localReport(o));
  /** check a proof against this deployment's key — or pass `keys` to check one from another deployment */
  const checkProof = (jws: string, keys = engine.proofKeys().keys) => verifyProof(jws, keys);

  return { middleware, protect, send, sessionFor, reloadPolicy, get policy() { return currentPolicy(); }, policySource, engine, store, room, basePath, telemetry, health,
    proofKeys, proofFor, proofBundle: proofBundleFor, verifyProof: checkProof, report: localReport, reportHtml,
    anchorNow,
    close: async () => { if (anchorTimer) clearInterval(anchorTimer); sync?.close(); signatures.close(); await reporter?.close(); store.close(); } };
}

export type OneHumanInstance = Awaited<ReturnType<typeof onehuman>>;

/** Keys whose values say what a record is, not what it holds: ids, codes such as a currency, status and dates. */
const KEEP_KEYS = new Set(['id', '_id', 'currency', 'unit', 'status', 'state', 'type', 'kind', 'date', 'createdAt', 'updatedAt', 'created_at', 'updated_at']);
/** The `mask: 'auto'` variant: every value hidden, the shape kept, and ids, currency/status/type codes and dates left as they are, so the page still renders. */
export function autoMask(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((v) => autoMask(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, autoMask(v, k)]));
  if (KEEP_KEYS.has(key) || value === null || typeof value === 'boolean') return value;
  return typeof value === 'number' ? null : '••••';
}

/**
 * The same instance without `await`: for CommonJS, or code that cannot wait at the top level. It returns at
 * once and starts in the background; the first request waits for the start. `ready` resolves to the full
 * instance (or rejects with the reason it could not start, e.g. a missing secret).
 */
export function onehumanDeferred(opts: OneHumanOptions) {
  const ready = onehuman(opts);
  // If OneHuman cannot start (a bad policy file, an unreachable database), the app keeps working: requests go on
  // without a decision, exactly as when the engine fails later, and the reason is logged once a minute.
  let startError: string | null = null;
  let lastLog = 0;
  ready.catch((e: unknown) => { startError = (e as Error).message; console.error(`onehuman: could not start — ${startError}. Requests go on without OneHuman until this is fixed.`); });
  const basePath = (opts.basePath ?? '/onehuman').replace(/\/$/, '');
  const notStarted = (res: Res) => {
    if (Date.now() - lastLog > 60e3) { lastLog = Date.now(); console.error(`onehuman: not started (${startError}); the request went on without a decision`); }
    if (!res.headersSent) res.setHeader('X-OH-Decision', 'failed-open:ENGINE_START_FAILED');
  };
  let mw: ((req: Req, res: Res, next: Next) => void) | null = null;
  return {
    ready,
    middleware() {
      return (req: Req, res: Res, next: Next) => {
        ready.then((oh) => { mw ??= oh.middleware(); mw(req, res, next); }, () => {
          const path = (req.url ?? '').split('?')[0]!;
          if (path === basePath || path.startsWith(`${basePath}/`)) return json(res, 503, { error: 'onehuman_not_started' });
          next();
        });
      };
    },
    protect(resource: string, local?: Parameters<OneHumanInstance['protect']>[1]) {
      let h: ReturnType<OneHumanInstance['protect']> | null = null;
      return (req: Req, res: Res, next: Next) => {
        ready.then((oh) => { h ??= oh.protect(resource, local); return h(req, res, next); }, () => {
          if (opts.failOpen === false) return json(res, 503, { error: 'onehuman_not_started', message: 'This endpoint needs a OneHuman decision and OneHuman is not running.' });
          notStarted(res);
          next();
        });
      };
    },
    send<T>(req: Req, res: Res, full: T, mask: (full: T) => unknown) { ready.then((oh) => oh.send(req, res, full, mask), () => { notStarted(res); json(res, 200, full); }); },
    close: () => ready.then((oh) => oh.close(), () => {}),
  };
}

// Express users get `req.onehuman` typed without importing anything else.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { onehuman?: ProtectResult }
  }
}
