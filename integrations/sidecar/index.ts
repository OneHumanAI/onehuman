// SPDX-License-Identifier: Apache-2.0
/**
 * OneHuman sidecar: the engine the Express middleware uses, as a small local HTTP service, for backends that are not
 * Node (Python first; anything that can make an HTTP call). The app's own middleware does two things:
 *
 *   - forwards the browser's `/onehuman/*` requests here unchanged (the page script and its API) and relays the answer;
 *   - asks `POST /v1/decide` before every protected handler, with the browser request's headers, and applies the answer
 *     (403 / 428 itself, or hands the handler `masked`).
 *
 * The decision, the audit log, the proofs and the passkeys stay here, on the same machine as the app. The sidecar
 * listens on 127.0.0.1; with ONEHUMAN_SIDECAR_TOKEN set, `/v1/*` also needs that token (for a sidecar on another host).
 *
 *   Every call carries the browser's host in X-Forwarded-Host (and scheme in X-Forwarded-Proto).
 *   POST /v1/decide   headers: the browser request's own headers, plus
 *                       X-OH-Resource (required), X-OH-Method, X-OH-Url (path + query of the browser request),
 *                       X-OH-Identity (the signed-in user id, optional), X-OH-Want-Token: 1 (a download token)
 *                     → { decision, computed, masked, blocked, actor, status, body, headers, setCookie, token, failedOpen }
 *   POST /v1/redeem   { token, resource } with the browser's cookie → { ok, reason }
 *   GET  /v1/health   → liveness and configuration (the same object as `/onehuman/health`)
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { cookies, json } from '../../server/public.ts';
import { onehuman, type OneHumanOptions, type Req, type Res } from '../express/index.ts';

export type SidecarOptions = Omit<OneHumanOptions, 'identify'> & { port?: number; host?: string; token?: string };

const RESOURCE = /^[a-z][a-z0-9_.:-]{0,79}$/i;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

async function body(req: IncomingMessage, max = 4000): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > max) return null; chunks.push(c as Buffer); }
  try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); return v && typeof v === 'object' ? v : null; } catch { return null; }
}

export async function startSidecar(opts: SidecarOptions): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const cookieName = opts.cookie ?? 'oh_sid';
  // the app tells us who is signed in; the engine derives the session from it exactly as identify() does in Express
  const oh = await onehuman({ ...opts, identify: (req) => { const v = req.headers['x-oh-identity']; return typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null; } });
  const pageRoutes = oh.middleware();
  const token = opts.token ?? process.env.ONEHUMAN_SIDECAR_TOKEN ?? '';
  const explain = opts.explain ?? process.env.ONEHUMAN_EXPLAIN === '1';

  async function decide(req: Req, res: Res) {
    const resource = String(req.headers['x-oh-resource'] ?? '');
    if (!RESOURCE.test(resource)) return json(res, 400, { error: 'bad_resource', message: 'Send X-OH-Resource: the name of the protected resource, e.g. balance.read.' });
    // the engine reads the request as the browser sent it: its method and path, not this call's
    const method = String(req.headers['x-oh-method'] ?? 'GET').toUpperCase();
    const path = String(req.headers['x-oh-url'] ?? '/');
    req.method = /^[A-Z]{3,7}$/.test(method) ? method : 'GET';
    req.url = path.startsWith('/') ? path.slice(0, 2000) : '/';
    const wantToken = req.headers['x-oh-want-token'] === '1';
    await new Promise<void>((done) => { oh.protect(resource, { respond: false })(req, res, () => done()); if (res.headersSent) done(); });
    if (res.headersSent) return;   // failOpen: false in protect mode answered 503 itself
    const r = req.onehuman;
    if (!r) return json(res, 503, { error: 'onehuman_unavailable' });
    const d = r.full as { id?: string; computed?: string } | null;
    // what the page sees: the outcome only (the app itself gets actor and computed below)
    const summary = explain ? { id: d?.id ?? null, resource, decision: r.decision, actor: r.actor } : { id: d?.id ?? null, resource, decision: r.decision };
    const status = r.decision === 'block' ? 403 : r.decision === 'step_up' ? 428 : 200;
    const out = {
      decision: r.decision, computed: d?.computed ?? r.decision, masked: r.masked, blocked: r.blocked, actor: r.actor, status,
      // what Express answers itself for block and step-up; the app sends the same body
      body: status === 403 ? { error: 'blocked', resource, decision: summary, stepUp: r.stepUp } : status === 428 ? { error: 'step_up_required', resource, decision: summary, stepUp: r.stepUp } : null,
      headers: Object.fromEntries(['X-OH-Decision', 'X-OH-Outcome', 'X-OH-Policy'].flatMap((h) => { const v = res.getHeader(h); return v === undefined ? [] : [[h, String(v)]]; })),
      setCookie: [res.getHeader('Set-Cookie') ?? []].flat().map(String),
      token: wantToken && r.decision === 'allow' && d ? r.token() : null,
      failedOpen: r.failedOpen ?? null,
    };
    res.removeHeader('Set-Cookie');
    json(res, 200, out);
  }

  async function redeem(req: Req, res: Res) {
    const b = await body(req);
    const t = typeof b?.token === 'string' ? b.token : '', resource = typeof b?.resource === 'string' ? b.resource : '';
    const session = cookies(req)[cookieName] ?? '';
    if (!t || !RESOURCE.test(resource) || !session) return json(res, 400, { ok: false, reason: 'bad_request' });
    const check = await oh.engine.redeemToken(t, session, resource);
    json(res, check.ok ? 200 : 403, check.ok ? { ok: true, decision: check.claims.decisionId } : { ok: false, reason: check.reason });
  }

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    // the browser's host, as the app received it: cookies, same-origin checks and passkeys (rpId) are bound to it
    const fwdHost = req.headers['x-forwarded-host'];
    if (typeof fwdHost === 'string' && /^[a-z0-9.:[\]-]{1,255}$/i.test(fwdHost.split(',')[0]!.trim())) req.headers.host = fwdHost.split(',')[0]!.trim();
    (async () => {
      if (path.startsWith('/v1/')) {
        if (token ? req.headers['x-oh-sidecar-token'] !== token : !LOOPBACK.has(req.socket.remoteAddress ?? '')) return json(res, 401, { error: 'sidecar_token', message: 'Set ONEHUMAN_SIDECAR_TOKEN on both sides, or call from the same machine.' });
        if (path === '/v1/decide' && req.method === 'POST') return decide(req as Req, res);
        if (path === '/v1/redeem' && req.method === 'POST') return redeem(req as Req, res);
        if (path === '/v1/health' && req.method === 'GET') return json(res, 200, oh.health());
        return json(res, 404, { error: 'not_found' });
      }
      // the browser's /onehuman/* traffic, forwarded by the app with its own headers
      await pageRoutes(req as Req, res, () => json(res, 404, { error: 'not_found' }));
    })().catch((e) => { if (!res.headersSent) json(res, 503, { error: 'onehuman_unavailable', message: String((e as Error).message) }); else res.end(); });
  });
  const port = opts.port ?? (Number(process.env.ONEHUMAN_SIDECAR_PORT) || 8788);
  const host = opts.host ?? process.env.ONEHUMAN_SIDECAR_HOST ?? '127.0.0.1';
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(port, host, () => ok()); });
  const addr = server.address();
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${typeof addr === 'object' && addr ? addr.port : port}`;
  return { server, url, close: async () => { await new Promise<void>((r) => server.close(() => r())); await oh.close(); } };
}

export type { ServerResponse };
