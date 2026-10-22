// SPDX-License-Identifier: BUSL-1.1
/**
 * HTTP application: wires routes, pages, the SDK and static files.
 *
 * `createApp()` returns a plain `(req, res)` handler so the same code runs as a
 * long-lived Node server (dev, self-hosted) or as a serverless function (Vercel).
 */
import { createServer, type Server } from 'node:http';
import { createHash, createPrivateKey, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { APPS, publicApp } from './apps.ts';
import { SiteStore } from './site-db.ts';
import { firebaseWebConfig } from './firebase-auth.ts';
import { chatRoutes } from './chat.ts';
import { scanRoutes } from './routes/scan.ts';
import { licenseSigner, setTrustedLicenseKeys, trustedLicenseKeys } from './license.ts';
import { billing } from './billing.ts';
import { CONTACT_EMAIL, openRouterModel } from './chat-ai.ts';
import { SERVER_LIMITS, type Store, type StoreLimits } from './db.ts';

/** a store on a database that is not SQL (Firestore): it opens copies of itself with other caps */
const isFire = (s: SiteStore): s is SiteStore & { withLimits(l: StoreLimits): Store } => typeof (s as { withLimits?: unknown }).withLimits === 'function';
import { OneHuman } from './engine.ts';
import { attachModel, KINEMATICS_VERSION } from './kinematics.ts';
import { SIGNAL_VERSION } from './assess.ts';
import { loadModel, predict } from './kinematics-model.ts';
import { cookies, json, readJson, sameOrigin, serveStatic, url, UUID, type Req, type Res } from './http.ts';
import { accountRoutes } from './routes/account.ts';
import { adminRoutes } from './routes/admin.ts';
import { labRoutes, type LabOperator } from './routes/lab.ts';
import { resourceRoutes } from './routes/resources.ts';
import { accessRoutes } from './routes/access.ts';
import { sandboxRoutes } from './routes/sandbox.ts';
import { portalRoutes } from './routes/portal.ts';
import { webauthnRoutes } from './routes/webauthn.ts';
import { limiter } from './limits.ts';
import { uaFamily, visitLog } from './ops.ts';
import { startDogfood } from './dogfood.ts';
import { demoReporter, demoRules, siteKey } from './demo-report.ts';
import { mailer, previewMail, type Transport } from './mail.ts';
import { MAIL_KINDS, type MailKind } from './mail-templates.ts';
import { sampleReport } from './sample-report.ts';
import { renderReportHtml } from '../integrations/report/html.ts';
import type { SqlClient } from './sql.ts';
import { httpsDirectoryLoader, KNOWN_OPERATORS, type KeyLoader, type OperatorKey } from './web-bot-auth.ts';

const ROOT = process.env.ONEHUMAN_ROOT ?? process.cwd();
const WEB = join(ROOT, 'web');
const SDK = join(ROOT, 'sdk');
const DOCS = join(ROOT, 'docs');
/** research log and evaluation: kept out of the repository (internal/ is git-ignored), shown to the local lab only */
const INTERNAL_DOCS = join(ROOT, 'internal', 'docs');

export type AppOptions = {
  /** storage client; default in-memory sqlite */
  client?: SqlClient;
  secret?: Buffer;
  labOperator?: boolean;
  /** serverless deployments: no SSE, secure cookies */
  serverless?: boolean;
  /** storage is per-instance memory: warn on pages */
  ephemeral?: boolean;
  /** OneHuman on its own portal (default on; ONEHUMAN_DOGFOOD=0 turns it off) */
  dogfood?: boolean;
  /** how mail leaves: the entry points pass transportFromEnv() (Resend, or a local outbox); unset = no mail (tests) */
  mailTransport?: Transport | null;
  /** the website chat's assistant; default OpenRouter from OPENROUTER_API_KEY, null = no assistant (tests pass their own) */
  chatModel?: import('./chat-ai.ts').ChatModel | null;
  /** the repository scanner behind /scan (tests give it a fake; the real one reads GitHub) */
  repoScan?: (repo: string) => Promise<import('./repo-scan.ts').RepoScan>;
  /** an already open store (production: Firestore, server/fire-store.ts); otherwise SQL on `client` */
  store?: SiteStore;
  /** sign-in through Firebase Authentication; default: from FIREBASE_PROJECT_ID + FIREBASE_WEB_API_KEY, null = passwords here */
  firebase?: { projectId: string; verify?: (token: string) => Promise<import('./firebase-auth.ts').FirebaseUser> } | null;
};

export type Handler = (req: Req, res: Res) => Promise<void>;

/**
 * Lab operator key pair. With a secret it is derived deterministically (HKDF →
 * Ed25519 seed) so every serverless instance holds the same key; otherwise random.
 */
async function labOperatorKeys(secret: Buffer | undefined): Promise<{ privateKey: CryptoKey; publicJwk: OperatorKey }> {
  if (secret) {
    const seed = Buffer.from(hkdfSync('sha256', secret, 'onehuman', 'lab-operator-ed25519', 32));
    const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
    const jwk = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }).export({ format: 'jwk' }) as { x: string; d: string };
    const privateKey = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: jwk.x, d: jwk.d }, { name: 'Ed25519' }, false, ['sign']);
    return { privateKey, publicJwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid: 'lab-key-1' } };
  }
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as OperatorKey;
  return { privateKey: pair.privateKey, publicJwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid: 'lab-key-1' } };
}

export async function createApp(opts: AppOptions = {}): Promise<{ handler: Handler; server: Server; engine: OneHuman; store: SiteStore; labOperator: LabOperator; mail: ReturnType<typeof mailer> }> {
  const store = opts.store ?? await SiteStore.open(opts.client);
  const model = await loadModel();
  attachModel(model ? { predict: (f) => predict(model, f), humanAbove: model.humanAbove, syntheticBelow: model.syntheticBelow } : null);
  const secret = opts.secret ?? randomBytes(32);
  // this portal signs licenses; its own processes (the portal's protection) trust its key besides the built-in ones
  const licenseKey = licenseSigner(secret).jwk.x;
  if (!trustedLicenseKeys().some((k) => k.x === licenseKey)) setTrustedLicenseKeys([...trustedLicenseKeys(), { x: licenseKey }]);
  const serverless = opts.serverless ?? false;
  const ephemeral = opts.ephemeral ?? false;

  // Optional lab operator: an Ed25519 key pair so the verified-signature path can be
  // demonstrated without ChatGPT's private key.
  let labOperator: LabOperator = null;
  let keyLoader: KeyLoader = httpsDirectoryLoader;
  if (opts.labOperator !== false) {
    const keys = await labOperatorKeys(opts.secret);
    labOperator = { operator: 'https://lab-operator.onehuman.test', privateKey: keys.privateKey, publicJwk: keys.publicJwk };
    KNOWN_OPERATORS[labOperator.operator] = 'memory://lab';
    keyLoader = async (operator) => (operator === labOperator!.operator ? [keys.publicJwk] : httpsDirectoryLoader(operator));
  }

  // onehuman.ai runs with a license like any other site: a license file this portal signs for itself at start. The
  // demos and the lab report to the site's own account (the dogfood key), so the team sees how people test agents here
  const ownKey = siteKey(store, process.env.ONEHUMAN_DOGFOOD_API_KEY);
  const engine = new OneHuman({ store, secret, keyLoader, accessScope: 'room', onDecision: demoReporter(store, store, ownKey) });
  engine.license.set(licenseSigner(secret).issue({ sub: 'offline', account: 'onehuman', plan: 'enterprise', mode: 'enforce', ttlMs: 400 * 86_400_000, note: 'onehuman.ai demos' }), 'file');
  engine.policyForApp = (app) => APPS[app]?.policy ?? null;
  // and the rules of that key, set in the portal, are what the demos enforce
  const demoRuleSet = demoRules(store, ownKey);
  engine.appRules = demoRuleSet.rulesFor;
  const limits = limiter(store, opts.secret);
  /** a few demo rooms per visitor is normal; hundreds an hour from one address (a whole class shares one) is a script */
  const roomAllowed = async (req: Req) => !(await limits.over('room', limits.client(req), 200, 3600e3));
  const lab = labRoutes(engine, labOperator, { roomAllowed, deviceOf: (req) => visits.deviceOf(req) });
  const account = accountRoutes(engine);
  const admin = adminRoutes(engine);
  const wa = webauthnRoutes(engine);
  const resources = resourceRoutes(engine);
  const access = accessRoutes(engine);
  const sandbox = sandboxRoutes(engine);

  const CSP = "default-src 'self'; img-src 'self' data: chrome-extension:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self' chrome-extension:; frame-ancestors 'none'";
  /** the website chat (web/chat.js, server/chat.ts) is off: ONEHUMAN_CHAT=on brings it back (the script on the public pages and its API). Same origin only. */
  const CHAT = process.env.ONEHUMAN_CHAT === 'on';
  const secure = (req: Req) => serverless || url(req).protocol === 'https:';
  const mail = mailer(store, { secret, transport: opts.mailTransport ?? null });
  // sign-in through Firebase when the deployment names a project (production); local runs and tests keep passwords here
  const firebase = opts.firebase !== undefined ? opts.firebase : (firebaseWebConfig() ? { projectId: firebaseWebConfig()!.projectId } : null);
  // plans and usage: metered from what customers' servers report; a limit holds back fresh signatures, never protection
  const bill = billing(store, { mail: opts.mailTransport ? mail : null });
  const portal = portalRoutes(engine, { secure, limits, mail, firebase, billing: bill, teamEmail: CONTACT_EMAIL, onPolicyChange: () => demoRuleSet.refresh() });
  const visits = visitLog(store, opts.secret, portal.accountOf);
  const scan = scanRoutes(store, { limits, mail: opts.mailTransport ? mail : null, ...(opts.repoScan ? { scan: opts.repoScan } : {}) });
  const chat = chatRoutes(store, { model: opts.chatModel !== undefined ? opts.chatModel : openRouterModel(), mail: opts.mailTransport ? mail : null, limits, deviceOf: (req) => { const f = uaFamily(String(req.headers['user-agent'] ?? '')); return `${f.browser} · ${f.os}${f.mobile ? ' · phone' : ''}`; } });
  // OneHuman on its own portal: nothing blocked; for an AI agent, secrets are masked and account changes raise an alert
  const dogfood = opts.dogfood === false || process.env.ONEHUMAN_DOGFOOD === '0' ? null
    // a store that is not SQL gives the portal's own protection the same database with a server's caps
    // the portal's own protection is a deployment like any other: it carries a license this portal signed for itself
    : await startDogfood({ ...(isFire(store) ? { engineStore: store.withLimits(SERVER_LIMITS) } : { client: store.sql }), secret: opts.secret, apiKey: process.env.ONEHUMAN_DOGFOOD_API_KEY, store, accountOf: portal.accountOf, serverless,
      license: licenseSigner(secret).issue({ sub: 'offline', account: 'onehuman', plan: 'enterprise', mode: 'enforce', ttlMs: 400 * 86_400_000, note: 'onehuman.ai' }) });
  const g = (resource: string, h: (req: Req, res: Res) => void | Promise<void>): ((req: Req, res: Res) => void | Promise<void>) => (dogfood ? dogfood.guard(resource, h) : h);

  /** Serve an HTML file with the session id and flags embedded. */
  /**
   * Public pages that are the same for everyone are cached at the edge (a load test on them never reaches the
   * function); they count their own views with a beacon (/v.js → POST /api/v1/visit).
   */
  const EDGE = 'public, max-age=60, s-maxage=600, stale-while-revalidate=86400';
  const CACHED_PAGES = new Set(['/', '/docs', '/trust', '/privacy', '/scorecard', '/measurements', '/compare', '/product', '/report', '/pricing', '/ai-agent-permissions-generator', '/scan', '/cookies']);
  async function page(res: Res, file: string, meta: Record<string, string>, headers: Record<string, string> = {}, cached = false, fill?: (html: string) => string) {
    let html: string;
    try { html = await readFile(join(WEB, file), 'utf8'); } catch { json(res, 500, { error: 'missing_ui', file }); return; }
    if (fill) html = fill(html);
    const tags = Object.entries(meta).map(([k, v]) => `<meta name="${k}" content="${v.replace(/"/g, '&quot;')}">`).join('\n');
    html = html.replace('<head>', `<head>\n${tags}`);
    if (cached) html = html.replace('</head>', '<script src="/v.js" defer></script>\n</head>');
    // the website chat on the public pages only (never the portal, the demos or the lab)
    if (cached && CHAT) html = html.replace('</head>', '<script src="/chat.js" defer></script>\n</head>');
    const body = Buffer.from(html, 'utf8');
    // only the public pages are for search engines; demo rooms, the portal and lab pages are not content
    const robots = cached ? {} : { 'X-Robots-Tag': 'noindex, nofollow' };
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': cached ? EDGE : 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP, ...robots, ...headers });
    res.end(body);
  }

  /** An application page: ensures a room for this app, creates a session, embeds ids. `file` = product UI or technical lab UI. */
  const appPage = (appId: string, file = 'product.html') => async (req: Req, res: Res) => {
    const app = APPS[appId]!;
    const u = url(req);
    let room = u.searchParams.get('room');
    const roomOk = room && UUID.test(room) && (await store.roomExists(room)) && (await store.roomApp(room)) === appId;
    if (!roomOk) {
      if (!(await roomAllowed(req))) return json(res, 429, { error: 'rate_limited', message: 'Too many new demo rooms from this network. Try again in an hour.' });
      room = await store.createRoom(Date.now(), appId, visits.deviceOf(req));
      const next = new URL(u.href);
      next.searchParams.set('room', room);
      res.writeHead(302, { Location: next.pathname + next.search, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    const as = u.searchParams.get('as');
    const label = as === 'human' || as === 'agent' ? as : 'unlabelled';
    const scenarioRaw = u.searchParams.get('scenario') ?? '';
    const scenario = /^[a-z0-9][a-z0-9-]{0,39}$/.test(scenarioRaw) ? scenarioRaw : '';
    const arrival = await engine.observe(req);
    const session = await store.createSession(room!, label, arrival, Date.now(), scenario);
    const headers: Record<string, string> = {};
    if (session) headers['Set-Cookie'] = `${engine.sessionCookie}=${session}; Path=/; HttpOnly; SameSite=Lax${secure(req) ? '; Secure' : ''}`;
    await page(res, file, { 'oh-session': session ?? '', 'oh-app': app.id, 'oh-serverless': serverless ? '1' : '0', 'oh-ephemeral': ephemeral ? '1' : '0' }, headers);
  };

  // the hero video: its YouTube poster, and the no-cookie player once the visitor presses play
  const LANDING_CSP = CSP.replace("img-src 'self'", "img-src 'self' https://i.ytimg.com")
    .replace("frame-ancestors 'none'", "frame-src https://www.youtube-nocookie.com; frame-ancestors 'none'");
  const landing = async (_req: Req, res: Res) => page(res, 'index.html', { 'oh-serverless': serverless ? '1' : '0', 'oh-ephemeral': ephemeral ? '1' : '0' }, { 'Content-Security-Policy': LANDING_CSP }, !ephemeral);

  const dashboard = async (req: Req, res: Res) => {
    const room = url(req).searchParams.get('room');
    if (!room || !UUID.test(room) || !(await store.roomExists(room))) { res.writeHead(302, { Location: '/' }); res.end(); return; }
    await page(res, 'dashboard.html', { 'oh-app': (await store.roomApp(room)) ?? 'bank', 'oh-serverless': serverless ? '1' : '0' });
  };

  /** Sitemap of the public pages; lastmod is the deploy date on Vercel, the file's change date locally. */
  const SITEMAP: Array<[string, string, string]> = [['/', 'index.html', '1.0'], ['/docs', 'docs.html', '0.9'], ['/product', 'how-it-works.html', '0.8'], ['/compare', 'compare.html', '0.8'], ['/pricing', 'pricing.html', '0.8'], ['/scorecard', 'scorecard.html', '0.8'], ['/measurements', 'measurements.html', '0.7'], ['/trust', 'trust.html', '0.7'], ['/report', 'report.html', '0.9'], ['/ai-agent-permissions-generator', 'permissions-generator.html', '0.8'], ['/scan', 'scan.html', '0.8'], ['/cookies', 'cookies.html', '0.3']];
  const sitemap = async (_req: Req, res: Res) => {
    const rows = await Promise.all(SITEMAP.map(async ([path, file, priority]) => {
      const mod = process.env.ONEHUMAN_BUILT_AT ?? (await stat(join(WEB, file)).then((s) => s.mtime.toISOString().slice(0, 10), () => new Date().toISOString().slice(0, 10)));
      return `  <url><loc>https://onehuman.ai${path}</loc><lastmod>${mod}</lastmod><priority>${priority}</priority></url>`;
    }));
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join('\n')}\n</urlset>\n`;
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': EDGE });
    res.end(body);
  };

  /** GitHub stars for the nav button: one GitHub call per instance per 10 minutes, edge-cached for everyone else. */
  let stars: { n: number | null; at: number } = { n: null, at: 0 };
  const starsApi = async (_req: Req, res: Res) => {
    if (Date.now() - stars.at > 600_000) {
      try {
        const r = await fetch('https://api.github.com/repos/OneHumanAI/onehuman', { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'onehuman.ai' }, signal: AbortSignal.timeout(3000) });
        if (r.ok) stars = { n: Number(((await r.json()) as { stargazers_count?: number }).stargazers_count ?? 0), at: Date.now() };
        else stars.at = Date.now() - 480_000; // GitHub said no (rate limit): try again in two minutes
      } catch { stars.at = Date.now() - 480_000; }
    }
    json(res, 200, { stars: stars.n }, { 'Cache-Control': 'public, max-age=300, s-maxage=600, stale-while-revalidate=86400' });
  };

  const appsApi = async (_req: Req, res: Res) => json(res, 200, { apps: Object.values(APPS).map(publicApp) }, { 'Cache-Control': 'public, max-age=60, s-maxage=600, stale-while-revalidate=86400' });

  type RouteHandler = (req: Req, res: Res) => void | Promise<void>;
  // The lab (training + sandbox + dataset endpoints) is the operator's, not the public's. With ONEHUMAN_LAB_KEY set,
  // it answers 404 unless the request carries the key (?key=… once, then a cookie); unset = open, for local work.
  const LAB_KEY = process.env.ONEHUMAN_LAB_KEY ?? '';
  const PUBLIC_DOCS = new Set(['INTEGRATION.md', 'INTEGRATION-AGENT.md']);
  // the cookie carries a hash of the key, not the key; comparisons are constant-time
  const digest = (v: string) => createHash('sha256').update(`lab:${v}`).digest();
  const LAB_DIGEST = digest(LAB_KEY);
  const sameKey = (v: string | undefined | null) => !!v && timingSafeEqual(digest(v), LAB_DIGEST);
  const labOpen = (req: Req, res: Res): boolean => {
    if (!LAB_KEY) return true;
    if (sameKey(url(req).searchParams.get('key'))) {
      res.setHeader('Set-Cookie', `oh_lab=${LAB_DIGEST.toString('base64url')}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure(req) ? '; Secure' : ''}`);
      return true;
    }
    const c = cookies(req).oh_lab;
    return !!c && c.length === 43 && timingSafeEqual(Buffer.from(c), Buffer.from(LAB_DIGEST.toString('base64url')));
  };
  const labPage = (file: string) => async (req: Req, res: Res) => {
    if (!labOpen(req, res)) return json(res, 404, { error: 'not_found' });
    return page(res, file, { 'oh-serverless': serverless ? '1' : '0', 'oh-lab-key': LAB_KEY });
  };
  const labApi = (h: RouteHandler): RouteHandler => async (req, res) => (labOpen(req, res) ? h(req, res) : json(res, 404, { error: 'not_found' }));

  /** /report shows the sample report's own figures, so the preview and the full sample never disagree */
  const reportSampleFill = (html: string) => {
    const r = sampleReport();
    const n = (x: number) => x.toLocaleString('en-US');
    const share = r.sessions.total ? `${Math.round((r.sessions.withAgent / r.sessions.total) * 1000) / 10}%` : '0%';
    const row = (name: string, v: string, code = false) => `<div class="rp-row">${code ? `<code>${escHtml(name)}</code>` : `<span>${escHtml(name)}</span>`}<b>${escHtml(v)}</b></div>`;
    const a = r.agentRequests;
    const fills: Record<string, string> = {
      withAgent: n(r.sessions.withAgent), share, sessions: n(r.sessions.total), agents: n(r.agents.length), protected: n(a.wouldBlock + a.wouldMask + a.wouldStepUp),
      agentRows: r.agents.slice(0, 4).map((x) => row(x.name, `${n(x.sessions)} sessions`)).join(''),
      endpointRows: r.endpoints.filter((e) => e.agentRequests).slice(0, 4).map((e) => row(e.resource, `${n(e.agentRequests)} requests`, true)).join(''),
      people: r.people.wouldBeStopped ? `${n(r.people.wouldBeStopped)} requests by real people would have been refused.` : `No real person would have been stopped. ${n(r.people.sessions)} sessions by people went through untouched.`,
    };
    return html.replace(/\{\{(\w+)\}\}/g, (m, k: string) => fills[k] ?? m);
  };
  const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

  /** A link in every mail. GET asks (link scanners open links; they must not unsubscribe anyone), POST does it. */
  async function unsubscribePage(req: Req, res: Res, doIt: boolean) {
    const u = url(req);
    const account = u.searchParams.get('a') ?? '', token = u.searchParams.get('t') ?? '';
    const ok = UUID.test(account) && mail.checkUnsubscribe(account, token) && !!(await store.accountById(account));
    let body: string;
    if (!ok) body = '<h1>This link does not work</h1><p>It may be cut short. Turn the e-mails off in your dashboard under Settings, or reply to any of them and we do it for you.</p>';
    else if (doIt) {
      await store.ensureAccountMeta(account, { started: Date.now(), legacy: true });
      await store.setEmailOff(account, true);
      body = '<h1>You will not get these e-mails any more</h1><p>No more reminders, weekly summaries or report mails. You can turn them back on in your dashboard under Settings.</p><p><a href="/portal#settings">Open Settings</a></p>';
    } else body = `<h1>Stop OneHuman e-mails?</h1><p>No more reminders, weekly summaries or report mails for this account. Your app and your dashboard keep working.</p><form method="post" action="/email/unsubscribe?a=${encodeURIComponent(account)}&amp;t=${encodeURIComponent(token)}"><button type="submit">Stop the e-mails</button></form>`;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>E-mail settings · OneHuman</title><style>body{margin:0;background:#f4f5f7;font:15px/1.6 -apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;color:#374151}main{max-width:480px;margin:12vh auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:32px}h1{font-size:20px;color:#0b0c0f;margin:0 0 12px}a{color:#3d8180}button{font:600 15px/1 inherit;font-family:inherit;background:#0b0c0f;color:#fff;border:0;border-radius:8px;padding:12px 18px;cursor:pointer}img{display:block;margin-bottom:24px}</style></head><body><main><img src="/email-logo.png" width="134" height="22" alt="OneHuman">${body}</main></body></html>`;
    res.writeHead(ok || !doIt ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'" });
    res.end(html);
  }

  const routes: [string, string, RouteHandler][] = [
    ['GET', '/', landing],
    ['GET', '/sitemap.xml', sitemap],
    ['GET', '/bank', appPage('bank')],
    ['GET', '/crm', appPage('crm')],
    ['GET', '/enterprise', appPage('enterprise')],
    // the insurer demo became the enterprise workspace (2026-09-28); old links land on the new demo
    ['GET', '/insurance', async (_req, res) => { res.writeHead(301, { Location: '/enterprise', 'Cache-Control': 'public, max-age=3600' }); res.end(); }],
    ['GET', '/dashboard', labApi(dashboard)],
    ['GET', '/sandbox', labPage('sandbox.html')],
    ['POST', '/api/v1/sandbox/samples', labApi(sandbox.addSample)],
    ['GET', '/api/v1/sandbox/stats', labApi(sandbox.stats)],
    ['GET', '/api/v1/sandbox/export', labApi(sandbox.exportSamples)],
    ['POST', '/api/v1/sandbox/assess-run', labApi(sandbox.assessRun)],
    // the lab pages load the SDK without a session; its passive pushes land here instead of 404
    ['POST', '/api/v1/sandbox/noop', async (_req, res) => json(res, 200, { ok: true })],
    ['GET', '/training', labPage('training.html')],
    // customer portal + middleware telemetry
    ['GET', '/docs', async (_req, res) => page(res, 'docs.html', {}, {}, true)],
    ['GET', '/trust', async (_req, res) => page(res, 'trust.html', {}, {}, true)],
    ['GET', '/privacy', async (_req, res) => page(res, 'trust.html', {}, {}, true)],
    ['GET', '/cookies', async (_req, res) => page(res, 'cookies.html', {}, {}, true)],
    ['GET', '/product', async (_req, res) => page(res, 'how-it-works.html', {}, {}, true)],
    ['GET', '/how-it-works', async (_req, res) => { res.writeHead(301, { Location: '/product', 'Cache-Control': 'public, max-age=86400' }); res.end(); }],
    ['GET', '/compare', async (_req, res) => page(res, 'compare.html', {}, {}, true)],
    ['GET', '/pricing', async (_req, res) => page(res, 'pricing.html', {}, {}, true)],
    ['GET', '/scorecard', async (_req, res) => page(res, 'scorecard.html', {}, {}, true)],
    // a free tool: AI agent permissions for an app, generated in the browser
    ['GET', '/scan', async (_req, res) => page(res, 'scan.html', {}, {}, true)],
    ['POST', '/api/v1/scan', scan.start],
    ['POST', '/api/v1/scan/unlock', scan.unlock],
    ['GET', '/ai-agent-permissions-generator', async (_req, res) => page(res, 'permissions-generator.html', {}, {}, true)],
    ['GET', '/measurements', async (_req, res) => page(res, 'measurements.html', {}, {}, true)],
    // the free 30-day AI agent report: what it is, and a sample of what it ends with
    ['GET', '/report', async (_req, res) => page(res, 'report.html', {}, {}, true, reportSampleFill)],
    ['GET', '/report/sample', async (_req, res) => {
      const html = renderReportHtml(sampleReport(), { title: 'Sample 30-day AI agent report · OneHuman' })
        .replace('<div class="page">', '<div class="sample-bar" style="max-width:820px;margin:24px auto 0;padding:10px 14px;border-radius:8px;background:#0b0c0f;color:#fff;font:13px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">Sample report with made-up data. Yours is built from your own app. <a href="/portal?start=report" style="color:#a7ddd0">Start your free report →</a></div><div class="page">');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': EDGE, 'X-Robots-Tag': 'noindex', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff' });
      res.end(html);
    }],
    // e-mail: the daily run (Vercel cron), turning the mails off from a mail, and the operators' view of them
    ['GET', '/api/cron/email', async (req, res) => {
      const want = process.env.CRON_SECRET ?? '';
      const got = (req.headers.authorization ?? '').toString().replace(/^Bearer /, '');
      if (!want || got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) return json(res, 404, { error: 'not_found' });
      json(res, 200, { ok: true, transport: mail.transport, ...(await mail.runDaily()) });
    }],
    ['GET', '/email/unsubscribe', async (req, res) => unsubscribePage(req, res, false)],
    ['POST', '/email/unsubscribe', async (req, res) => unsubscribePage(req, res, true)],
    ['POST', '/api/v1/portal/email', portal.emailPrefs],
    ['GET', '/api/v1/ops/mail-preview', async (req, res) => {
      // a local server only (no lab key), to look at the mails while writing them
      if (serverless || LAB_KEY) return json(res, 404, { error: 'not_found' });
      const kind = url(req).searchParams.get('kind') as MailKind;
      if (!MAIL_KINDS.includes(kind)) return json(res, 200, { kinds: MAIL_KINDS });
      const m = previewMail(kind, mail.ctxFor('preview', 'you@company.com'), sampleReport());
      const asText = url(req).searchParams.get('format') === 'text';
      const body = asText ? `Subject: ${m.subject}\nPreheader: ${m.preheader}\n\n${m.text}` : m.html.replace(/https:\/\/onehuman\.ai\/email-logo\.png/g, '/email-logo.png');
      res.writeHead(200, { 'Content-Type': `${asText ? 'text/plain' : 'text/html'}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https://onehuman.ai data:; frame-ancestors 'self'" });
      res.end(body);
    }],
    ['POST', '/api/v1/visit', async (req, res) => {
      const b = (await readJson(req, 600).catch(() => null)) as { p?: unknown; r?: unknown } | null | undefined;
      const path = typeof b?.p === 'string' ? b.p : '';
      if (CACHED_PAGES.has(path)) await visits.page(req, path, typeof b?.r === 'string' ? b.r.slice(0, 80) : null);
      res.writeHead(204); res.end();
    }],
    ['GET', '/portal', async (_req, res) => {
      // a visitor whose sign-in cookie is good sees a loading screen while the dashboard opens, never the sign-in form
      const signedIn = !!(await portal.accountOf(_req).catch(() => null));
      const boot = (html: string) => (signedIn ? html.replace('<div class="boot" id="boot" hidden', '<div class="boot" id="boot"').replace('<main class="auth" id="auth">', '<main class="auth" id="auth" hidden>') : html);
      // with Firebase sign-in: its public web config in the page, its sign-in module before the portal script, and a
      // CSP that lets the sign-in reach Google (identitytoolkit/securetoken; the Google window runs from authDomain)
      const fbc = firebaseWebConfig();
      if (!fbc) return page(res, 'portal.html', { 'oh-serverless': serverless ? '1' : '0' }, {}, false, boot);
      const frame = fbc.authDomain === url(_req).host ? "'self'" : `https://${fbc.authDomain}`;
      const csp = CSP.replace("script-src 'self'", "script-src 'self' https://apis.google.com")
        .replace("connect-src 'self'", "connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com")
        .replace("frame-ancestors 'none'", `frame-src ${frame} https://accounts.google.com; frame-ancestors 'none'`);
      return page(res, 'portal.html', { 'oh-serverless': serverless ? '1' : '0', 'oh-firebase': JSON.stringify(fbc) }, { 'Content-Security-Policy': csp }, false,
        (html) => boot(html).replace('<script src="/portal.js"></script>', '<script src="/portal-auth.js"></script>\n<script src="/portal.js"></script>'));
    }],
    ['POST', '/api/v1/portal/signup', dogfood ? dogfood.guardLogin(portal.signup) : portal.signup],
    ['POST', '/api/v1/portal/login', dogfood ? dogfood.guardLogin(portal.login) : portal.login],
    ['POST', '/api/v1/portal/session', dogfood ? dogfood.guardLogin(portal.session) : portal.session],
    ['POST', '/api/v1/portal/logout', portal.logout],
    // alerts: what an AI agent changed in this account (raised by the portal's own OneHuman guard)
    ['GET', '/api/v1/portal/alerts', async (req, res) => { const a = await portal.accountOf(req); if (!a) return json(res, 401, { error: 'unauthenticated' }); json(res, 200, { alerts: await store.listPortalAlerts(a, Date.now() - 30 * 86400e3) }); }],
    ['POST', '/api/v1/portal/alerts/seen', async (req, res) => { if (!sameOrigin(req)) return json(res, 403, { error: 'origin' }); const a = await portal.accountOf(req); if (!a) return json(res, 401, { error: 'unauthenticated' }); await store.markPortalAlertsSeen(a); json(res, 200, { ok: true }); }],
    ['GET', '/api/v1/portal/me', g('portal.account.read', portal.me)],
    ['POST', '/api/v1/portal/keys', g('portal.keys.write', portal.createKey)],
    ['POST', '/api/v1/portal/keys/revoke', g('portal.keys.write', portal.revokeKey)],
    ['POST', '/api/v1/portal/keys/rename', g('portal.keys.write', portal.renameKey)],
    ['POST', '/api/v1/portal/keys/lookup', g('portal.keys.lookup', portal.lookupKey)],
    ['POST', '/api/v1/portal/keys/rotate', g('portal.keys.write', portal.rotateKey)],
    ['POST', '/api/v1/portal/keys/delete', g('portal.keys.write', portal.deleteKey)],
    // a key's statistics shared by e-mail (read only)
    // connecting an app from the command line (npx onehumanai init / connect): the CLI starts and polls, the person decides here
    ['POST', '/api/v1/connect/start', portal.connectStart],
    ['GET', '/api/v1/connect/poll', portal.connectPoll],
    ['GET', '/api/v1/portal/connect', g('portal.account.read', portal.connectPeek)],
    ['POST', '/api/v1/portal/connect', g('portal.keys.write', portal.connectDecide)],
    ['POST', '/api/v1/portal/keys/share', g('portal.keys.write', portal.shareKey)],
    ['POST', '/api/v1/portal/keys/share-role', g('portal.keys.write', portal.shareRoleSet)],
    ['GET', '/api/v1/portal/keys/access', portal.keyAccess],
    ['POST', '/api/v1/portal/keys/unshare', g('portal.keys.write', portal.unshareKey)],
    ['POST', '/api/v1/portal/keys/invites/cancel', g('portal.keys.write', portal.cancelInvite)],
    ['GET', '/api/v1/portal/invites/peek', portal.peekInvite],
    ['POST', '/api/v1/portal/invites/accept', portal.acceptInvite],
    ['POST', '/api/v1/portal/account/password', g('portal.password.write', portal.changePassword)],
    ['GET', '/api/v1/portal/events', portal.events],
    ['GET', '/api/v1/portal/proofs', g('portal.proofs.read', portal.proofs)],
    ['POST', '/api/v1/portal/feedback', portal.feedback],
    ['GET', '/api/v1/portal/health', portal.health],
    ['GET', '/api/v1/portal/weekly', portal.weekly],
    ['GET', '/api/v1/portal/agents', portal.agents],
    ['GET', '/api/v1/portal/report', portal.report],
    ['GET', '/api/v1/signatures', portal.signaturesGet],
    ['POST', '/api/v1/signatures', portal.signaturesPost],
    ['POST', '/api/v1/proof/verify', portal.verifyBundle],
    ['GET', '/api/v1/proof-keys', async (_req, res) => json(res, 200, engine.proofKeys(), { 'Cache-Control': 'public, max-age=60, s-maxage=600, stale-while-revalidate=86400' })],
    ['GET', '/api/v1/portal/admin-keys', g('portal.adminkeys.read', portal.listAdminKeys)],
    ['POST', '/api/v1/portal/admin-keys', g('portal.adminkeys.write', portal.createAdminKey)],
    ['POST', '/api/v1/portal/admin-keys/revoke', g('portal.adminkeys.write', portal.revokeAdminKey)],
    ['GET', '/api/v1/portal/stats', portal.stats],
    ['GET', '/api/v1/portal/overview', portal.overview],
    ['POST', '/api/v1/ingest', portal.ingest],
    ['GET', '/api/v1/key-policy', portal.policy.getForServer],
    ['POST', '/api/v1/key-policy/propose', portal.policy.proposeFromServer],
    ['POST', '/api/v1/key-policy/resources', portal.policy.resourcesFromServer],
    ['GET', '/api/v1/policy-keys', portal.policy.publicKeys],
    ['GET', '/api/v1/portal/policy', portal.policy.portalGet],
    ['POST', '/api/v1/portal/policy', g('portal.policy.write', portal.policy.portalSave)],
    ['POST', '/api/v1/portal/policy/settings', g('portal.policy.write', portal.policy.portalSettings)],
    ['POST', '/api/v1/portal/policy/decide', g('portal.policy.write', portal.policy.portalDecide)],
    ['POST', '/api/v1/portal/policy/assist', g('portal.policy.write', portal.policy.portalAssist)],
    ['GET', '/api/v1/apps', appsApi],
    ['GET', '/api/v1/stars', starsApi],
    ['GET', '/api/v1/license', portal.licenseGet],
    ['GET', '/api/v1/license/keys', portal.licenseKeys],
    ['GET', '/api/v1/portal/plan', portal.planGet],
    ['POST', '/api/v1/portal/plan', portal.planPost],
    // the website chat: visitors, token-bound
    ...(CHAT ? [['POST', '/api/v1/chat/send', chat.send], ['GET', '/api/v1/chat/poll', chat.poll]] as [string, string, RouteHandler][] : []),
    ['GET', '/api/v1/version', async (_req, res) => json(res, 200, { signal: SIGNAL_VERSION, kinematics: KINEMATICS_VERSION, model: model ? { version: model.version, trainedAt: model.trainedAt, humanAbove: model.humanAbove, syntheticBelow: model.syntheticBelow, report: model.report } : null })],
    ['POST', '/api/v1/rooms', lab.createRoom],
    ['GET', '/api/v1/session', lab.me],
    ['GET', '/api/v1/connection', lab.connection],
    ['GET', '/api/v1/stream', serverless ? (_r, res) => json(res, 501, { error: 'sse_unavailable', message: 'Live streaming is not available in serverless mode; the page refreshes by polling.' }) : lab.stream],
    ['POST', '/api/v1/signals', lab.signals],
    ['GET', '/api/v1/journal', lab.journal],
    ['GET', '/api/v1/benchmark', lab.benchmark],
    ['GET', '/api/v1/audit', lab.audit],
    ['POST', '/api/v1/step-up', lab.stepUp],
    ['POST', '/api/v1/webauthn/register/options', wa.registerOptions],
    ['POST', '/api/v1/webauthn/register', wa.register],
    ['POST', '/api/v1/webauthn/assert/options', wa.assertOptions],
    ['POST', '/api/v1/webauthn/assert', wa.assert],
    ['GET', '/api/v1/access', access.get],
    ['POST', '/api/v1/access', access.set],
    ['GET', '/api/v1/webauthn/status', wa.status],
    ['POST', '/api/v1/simulate/signed', lab.simulateSigned],
    ['GET', '/api/v1/policy', admin.getPolicy],
    ['GET', '/api/v1/policy-default', async (req, res) => { const room = url(req).searchParams.get('room') ?? ''; const app = UUID.test(room) ? (await store.roomApp(room)) ?? 'bank' : 'bank'; json(res, 200, { policy: await engine.appPolicyFor(app) }); }],
    ['PUT', '/api/v1/policy', admin.putPolicy],
    // legacy bank routes (kept for the original tests and SDK examples)
    ['GET', '/api/v1/account/profile', account.profile],
    ['GET', '/api/v1/account/balance', account.balance],
    ['GET', '/api/v1/account/transactions', account.transactions],
    ['POST', '/api/v1/account/export', account.exportRequest],
    ['GET', '/api/v1/account/export/file', account.exportFile],
  ];

  /**
   * The portal on its own host (ONEHUMAN_APP_URL, e.g. https://app.onehuman.ai): there "/" is the portal, and the
   * site's /portal sends people there with their query (?connect=, ?invite=, ?start=) and fragment kept by the
   * browser. Without the setting the portal stays at /portal.
   */
  const APP_URL = (process.env.ONEHUMAN_APP_URL || '').replace(/\/+$/, '');
  const appHost = APP_URL ? new URL(APP_URL).host : null;
  const portalPage = routes.find(([m, p]) => m === 'GET' && p === '/portal')![2];
  const handler: Handler = async (req, res) => {
    const startedAt = Date.now();
    try {
      const u = url(req);
      const method = req.method ?? 'GET';
      // one client hammering one instance; the costly paths also have shared limits in the database
      // Before any database work: one browser (600/min, writes 240/min) and one address (3000/min, a class behind one
      // NAT fits) per instance. Load tests on public pages and static files never get here (edge cache, CDN).
      const write = method !== 'GET' && method !== 'HEAD';
      if (limits.burst(req, 600, 60e3, 'device', 'all') || (write && limits.burst(req, 240, 60e3, 'device', 'write')) || limits.burst(req, 3000, 60e3, 'ip', 'ip')) {
        json(res, 429, { error: 'rate_limited', message: 'Too many requests. Slow down and try again in a minute.' }, { 'Retry-After': '60' }); return;
      }
      // the portal's own page script and its API (OneHuman protecting onehuman.ai)
      if (dogfood && u.pathname.startsWith('/onehuman/')) { let passed = false; await dogfood.oh.middleware()(req as never, res, () => { passed = true; }); if (!passed) return; }
      if (appHost && (method === 'GET' || method === 'HEAD')) {
        if (u.host === appHost) {
          if (u.pathname === '/') { await portalPage(req, res); return; }
          if (u.pathname === '/portal') { res.writeHead(301, { Location: `/${u.search}` }); res.end(); return; }
          // the public pages live on the main site
          if (CACHED_PAGES.has(u.pathname)) { res.writeHead(301, { Location: `${process.env.ONEHUMAN_PUBLIC_URL || 'https://onehuman.ai'}${u.pathname}${u.search}` }); res.end(); return; }
        } else if (u.pathname === '/portal') { res.writeHead(301, { Location: `${APP_URL}/${u.search}` }); res.end(); return; }
      }
      const route = routes.find(([m, p]) => m === method && p === u.pathname);
      if (route) { await route[2](req, res); return; }
      if (u.pathname === '/api/v1/manage' || u.pathname.startsWith('/api/v1/manage/')) { await portal.manage(req, res); return; }
      if (await resources.handle(req, res)) return;
      if (method === 'GET' && u.pathname.startsWith('/sdk/') && (await serveStatic(res, SDK, u.pathname.slice(5)))) return;
      // Only the integration guides are public. The research log, the evaluation and the internal
      // runbooks describe how detection actually works; they stay behind the operator key.
      if (method === 'GET' && u.pathname.startsWith('/docs/')) {
        const file = u.pathname.slice(6);
        if (!PUBLIC_DOCS.has(file) && !labOpen(req, res)) { json(res, 404, { error: 'not_found' }); return; }
        if (await serveStatic(res, DOCS, file)) return;
        if (!PUBLIC_DOCS.has(file) && (await serveStatic(res, INTERNAL_DOCS, file))) return;
      }
      // pages are served only through their routes (session ids, CSP, lab key); never as raw files
      const file = u.pathname.slice(1);
      if (method === 'GET' && u.pathname !== '/' && !file.endsWith('.html') && (await serveStatic(res, WEB, file))) return;
      json(res, 404, { error: 'not_found' });
    } catch (err) {
      console.error('request failed', err);
      if (!res.headersSent) json(res, 500, { error: 'internal', message: 'Internal error. Please try again.' });
      else res.end();
    } finally {
      await visits.record(req, res, startedAt);
    }
  };

  const server = createServer((req, res) => { void handler(req, res); });
  return { handler, server, engine, store, labOperator, mail };
}
