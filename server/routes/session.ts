// SPDX-License-Identifier: BUSL-1.1
/**
 * The page script's own routes, served under the middleware's basePath: signals in, the session's connection state,
 * the session itself, and answering a step-up challenge.
 */
import { STEP_UP_TTL_MS, type OneHuman } from '../engine.ts';
import { json, readJson, sameOrigin, type Req, type Res } from '../http.ts';
import { parseSnapshot } from '../signals.ts';

export function sessionRoutes(engine: OneHuman, opts: { explain?: boolean } = {}) {
  const store = engine.store;
  // With explain on (development) the page sees why. In production the page, and so the agent in it, learns only the
  // outcome: the evidence behind it would teach an agent what to hide.
  const explain = opts.explain ?? true;
  // With explain off the page gets only what the SDK needs to seal: that an agent attached (or signed in). No actor,
  // no environment verdict: an agent that could read its own verdict could tune its cursor until it reads human.
  const SEAL = new Set(['agent_attached', 'signed_agent']);
  const view = <T extends { state: string }>(c: T) => (explain ? c : SEAL.has(c.state) ? { state: c.state } : null);

  const me = async (req: Req, res: Res) => {
    const r = await engine.resolveSession(req);
    if (!r) return json(res, 401, { error: 'no_session' });
    const policy = await engine.policyFor(r.room);
    const app = (await store.roomApp(r.room)) ?? 'bank';
    json(res, 200, { room: r.room, app, session: r.session.id, label: r.session.label, scenario: r.session.scenario, arrival: explain ? r.session.arrival : null, connection: view(await engine.connectionFor(r.session)), policy: explain ? policy : null });
  };

  /** The one question: is an agent attached to this session right now? No action required. */
  const connection = async (req: Req, res: Res) => {
    const r = await engine.resolveSession(req);
    if (!r) return json(res, 401, { error: 'no_session' });
    const c = await engine.connectionFor(r.session);
    const s = (await store.getSession(r.session.id))!;
    if (!explain) return json(res, 200, { connection: view(c) });
    json(res, 200, { session: s.id, connection: view(c), attachedAt: s.agentAttachedAt, attachedClientMs: s.agentAttachedClientMs, sinceStartMs: s.agentAttachedAt ? s.agentAttachedAt - s.created : null });
  };

  const signals = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    const r = await engine.resolveSession(req);
    if (!r) return json(res, 401, { error: 'no_session' });
    const body = await readJson(req, 16000);
    const snapshot = body === undefined ? null : parseSnapshot(body);
    if (!snapshot) return json(res, 400, { error: 'bad_snapshot', message: 'Invalid signal format.' });
    const { assessment, connection } = await engine.ingest(r.room, r.session, snapshot);
    json(res, 200, explain ? { assessment, connection } : { connection: view(connection) });
  };

  const stepUp = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    const r = await engine.resolveSession(req);
    if (!r) return json(res, 401, { error: 'no_session' });
    const body = (await readJson(req, 2000)) as { id?: unknown; answer?: unknown } | null | undefined;
    if (!body || typeof body.id !== 'string' || typeof body.answer !== 'string') return json(res, 400, { error: 'bad_request' });
    const s = await store.getStepUp(body.id);
    if (!s || s.session !== r.session.id || s.expires < Date.now()) return json(res, 404, { error: 'step_up_not_found', message: 'The confirmation request was not found or has expired.' });
    // an AI agent asked for this action: only the person's passkey approves it, never a typed code
    if (s.challenge.startsWith('P:')) return json(res, 403, { error: 'passkey_required', message: 'Only the account owner can approve this, with a passkey.' });
    if (s.challenge !== body.answer.trim().toUpperCase()) return json(res, 403, { error: 'step_up_failed', message: 'The code does not match.' });
    await store.passStepUp(s.id, Date.now() + STEP_UP_TTL_MS);   // this held request, and only it, may now pass
    json(res, 200, { ok: true, resource: s.resource, message: 'Confirmed. Repeat the action once.' });
  };

  return { me, connection, signals, stepUp };
}
