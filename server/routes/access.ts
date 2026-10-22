// SPDX-License-Identifier: BUSL-1.1
/**
 * The account owner's screen for their own AI agent: what it may do here, what it did, and the owner's choices.
 *
 *   GET  /access   → { connected, nearby, tools, since, actions: [{ resource, title, company, mayLoosen, choice, until, effective }], activity }
 *   POST /access   ← { resource | '*', choice: 'allow' | 'never' | null }
 *
 * Stricter changes ('never', taking back an 'allow', "disconnect" = '*' never) go straight through: an agent may
 * restrict itself. Wider ones ('allow', lifting a 'never') answer 403 passkey_required; the page then asks the owner
 * for a passkey (POST /webauthn/assert/options with purpose 'permit'), and the verified assertion applies the change.
 */
import type { OneHuman } from '../engine.ts';
import { json, readJson, sameOrigin, type Req, type Res } from '../http.ts';

export const ACCESS_RESOURCE = /^[a-z][a-z0-9_.]{1,60}$/;

export function accessRoutes(engine: OneHuman) {
  const get = async (req: Req, res: Res) => {
    const r = await engine.resolveSession(req);
    if (!r) return json(res, 401, { error: 'no_session' });
    json(res, 200, await engine.agentAccess(r.session), { 'Cache-Control': 'no-store' });
  };

  const set = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    const r = await engine.resolveSession(req);
    if (!r) return json(res, 401, { error: 'no_session' });
    const body = (await readJson(req, 2000)) as { resource?: unknown; choice?: unknown } | null | undefined;
    const resource = typeof body?.resource === 'string' && (body.resource === '*' || ACCESS_RESOURCE.test(body.resource)) ? body.resource : null;
    const choice = body?.choice === 'allow' || body?.choice === 'never' ? body.choice : body?.choice === null ? null : undefined;
    if (!resource || choice === undefined) return json(res, 400, { error: 'bad_request' });
    const out = await engine.setAgentAccess(r.session, resource, choice, false);
    if (!out.ok) {
      const message = out.error === 'passkey_required' ? 'Giving an AI agent more access needs the account owner\'s passkey.'
        : out.error === 'not_allowed' ? 'This one is closed to AI agents by the company; it cannot be opened here.' : 'Unknown action.';
      return json(res, out.error === 'unknown_resource' ? 404 : 403, { error: out.error, message });
    }
    json(res, 200, await engine.agentAccess(r.session));
  };

  return { get, set };
}
