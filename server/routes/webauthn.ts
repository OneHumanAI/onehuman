// SPDX-License-Identifier: BUSL-1.1
/**
 * WebAuthn routes, served under the middleware's basePath. Credentials are scoped to the store's room.
 *
 *   POST /webauthn/register/options  → { challenge, rp, user, pubKeyCredParams, authenticatorSelection }
 *   POST /webauthn/register          ← { challengeId, id, clientDataJSON, attestationObject }
 *   POST /webauthn/assert/options    ← { stepUpId?, resource?, purpose? }  → { challenge, allowCredentials, userVerification, approving? }
 *   POST /webauthn/assert            ← { challengeId, id, clientDataJSON, authenticatorData, signature }
 *
 * A successful assertion marks the session human-verified for HUMAN_RECLAIM_TTL_MS (a reclaim), or, with purpose
 * 'approve', approves one action an agent asked for. Either way a confirmation covers the one held request it was
 * given for (stepUpId from the 428, or the only request held for that resource): same method, path and body.
 */
import { CHALLENGE_TTL_MS, HUMAN_RECLAIM_TTL_MS, STEP_UP_TTL_MS, type OneHuman } from '../engine.ts';
import { json, readJson, sameOrigin, url, type Req, type Res } from '../http.ts';
import { newChallenge, rpFromUrl, verifyAssertion, verifyRegistration, type StoredCredential } from '../webauthn.ts';
import { bus } from '../bus.ts';
import type { StepUpRow } from '../db.ts';

const summaryOf = (s: StepUpRow) => { try { return s.summary ? JSON.parse(s.summary) : null; } catch { return null; } };

export function webauthnRoutes(engine: OneHuman) {
  const store = engine.store;

  const registerOptions = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    const r = await engine.resolveSession(req);
    if (!r) return json(res, 401, { error: 'no_session' });
    // An agent in this session could register a passkey of its own (a virtual authenticator) and then approve its
    // own actions. A passkey is added only while no agent is connected.
    if (await engine.agentPresent(r.session, req)) return json(res, 403, { error: 'agent_present', message: 'A passkey can be added only while no AI agent is connected to this session.' });
    const { rpId } = rpFromUrl(url(req));
    const challenge = newChallenge();
    await store.createChallenge(challenge, r.session.id, 'register', null, CHALLENGE_TTL_MS);
    const existing = await engine.credentialsFor<StoredCredential>(r.session);
    const owner = engine.accessBy === 'room' ? r.room : r.session.id;
    json(res, 200, {
      challengeId: challenge,
      publicKey: {
        challenge,
        rp: { id: rpId, name: rpId },
        user: { id: Buffer.from(owner).toString('base64url'), name: `account-${owner.slice(0, 8)}`, displayName: 'This account' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }, { type: 'public-key', alg: -8 }],
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        excludeCredentials: existing.map((c) => ({ type: 'public-key', id: c.id })),
        attestation: 'none',
        timeout: CHALLENGE_TTL_MS,
      },
    });
  };

  const register = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    const r = await engine.resolveSession(req);
    if (!r) return json(res, 401, { error: 'no_session' });
    const body = (await readJson(req, 64000)) as Record<string, unknown> | null | undefined;
    if (!body || typeof body.challengeId !== 'string' || typeof body.clientDataJSON !== 'string' || typeof body.attestationObject !== 'string') return json(res, 400, { error: 'bad_request' });
    if (!(await store.consumeChallenge(body.challengeId, r.session.id, 'register'))) return json(res, 400, { error: 'challenge', message: 'Registration challenge not found or expired.' });
    if (await engine.agentPresent(r.session)) return json(res, 403, { error: 'agent_present', message: 'A passkey can be added only while no AI agent is connected to this session.' });
    const { rpId, origin } = rpFromUrl(url(req));
    try {
      const cred = verifyRegistration({ clientDataJSON: body.clientDataJSON, attestationObject: body.attestationObject }, { challenge: body.challengeId, origin, rpId }, typeof body.label === 'string' ? body.label.slice(0, 40) : 'passkey');
      await store.saveCredential(r.room, r.session.id, cred);
      json(res, 201, { ok: true, credential: { id: cred.id, alg: cred.alg, label: cred.label } });
    } catch (e) {
      json(res, 400, { error: 'registration_failed', message: (e as Error).message });
    }
  };

  const assertOptions = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    const r = await engine.resolveSession(req);
    if (!r) return json(res, 401, { error: 'no_session' });
    const body = (await readJson(req, 2000)) as { resource?: unknown; purpose?: unknown; choice?: unknown; stepUpId?: unknown } | null | undefined;
    const named = body && typeof body.resource === 'string' && /^[a-z][a-z0-9_.]{1,60}$/.test(body.resource) ? body.resource : null;
    const now = Date.now();
    // The held request this confirmation is for: the one named by the 428's stepUp.id, or, for a page that sends only
    // the resource, the one request held for it. Never "the next request to this resource", whatever it carries.
    let held: StepUpRow | null = null;
    if (typeof body?.stepUpId === 'string' && body.stepUpId) {
      const s = body.stepUpId.length <= 64 ? await store.getStepUp(body.stepUpId) : null;
      if (!s || s.session !== r.session.id || s.passed || s.expires <= now) return json(res, 404, { error: 'step_up_not_found', message: 'This action is no longer waiting. Repeat it.' });
      held = s;
    }
    const resource = held?.resource ?? named;
    // 'approve': the person approves one action an AI agent asked for; the session stays the agent's.
    // 'permit': the owner gives their agent more access (choice 'allow', or 'default' to lift a 'never').
    // Default ('reclaim'): the person takes the whole session back for a few minutes.
    const approve = body?.purpose === 'approve' && resource !== null;
    const permit = body?.purpose === 'permit' && named !== null && (body.choice === 'allow' || body.choice === 'default') ? body.choice : null;
    if (!held && resource && !permit) {
      const waiting = (await store.pendingStepUps(r.session.id, resource, now)).filter((s) => !approve || s.challenge.startsWith('P:'));
      if (approve && !waiting.length) return json(res, 409, { error: 'nothing_to_approve', message: 'No action is waiting for approval. Repeat the action first.' });
      if (approve && waiting.length > 1) return json(res, 409, { error: 'ambiguous', message: 'More than one action is waiting. Approve the one you mean: send its stepUp.id from the 428.' });
      if (waiting.length === 1) held = waiting[0]!;
    }
    const creds = await engine.credentialsFor<StoredCredential>(r.session);
    if (!creds.length) return json(res, 404, { error: 'no_credentials', message: 'No passkey is registered for this account.' });
    const { rpId } = rpFromUrl(url(req));
    const challenge = newChallenge();
    // what the assertion will cover: a held request (S:<id>), the resource as a whole for a reclaim with nothing held, or nothing
    const target = permit ? `${permit}|${named}` : held ? `S:${held.id}` : approve ? null : resource;
    await store.createChallenge(challenge, r.session.id, permit ? 'permit' : approve ? 'approve' : 'assert', target, CHALLENGE_TTL_MS);
    json(res, 200, {
      challengeId: challenge,
      publicKey: { challenge, rpId, allowCredentials: creds.map((c) => ({ type: 'public-key', id: c.id })), userVerification: 'required', timeout: CHALLENGE_TTL_MS },
      ...(held ? { approving: { stepUpId: held.id, resource: held.resource, summary: summaryOf(held) } } : {}),
    });
  };

  const assert = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    const r = await engine.resolveSession(req);
    if (!r) return json(res, 401, { error: 'no_session' });
    const body = (await readJson(req, 64000)) as Record<string, unknown> | null | undefined;
    if (!body || typeof body.challengeId !== 'string' || typeof body.id !== 'string' || typeof body.clientDataJSON !== 'string' || typeof body.authenticatorData !== 'string' || typeof body.signature !== 'string') return json(res, 400, { error: 'bad_request' });
    const ch = await store.consumeChallenge(body.challengeId, r.session.id, ['assert', 'approve', 'permit']);
    if (!ch) return json(res, 400, { error: 'challenge', message: 'Verification challenge not found or expired.' });
    // only this account's own passkeys count: another user's passkey never approves or reclaims this session
    const cred = (await engine.ownsCredential(r.session, body.id)) ? await store.getCredential<StoredCredential>(body.id) : null;
    if (!cred) return json(res, 404, { error: 'unknown_credential' });
    const { rpId, origin } = rpFromUrl(url(req));
    const result = verifyAssertion({ credentialId: body.id, clientDataJSON: body.clientDataJSON, authenticatorData: body.authenticatorData, signature: body.signature }, cred, { challenge: body.challengeId, origin, rpId });
    if (!result.ok) return json(res, 403, { error: 'assertion_failed', message: result.reason });
    cred.signCount = result.newSignCount;
    await store.updateCredential(cred);
    const now = Date.now();
    if (ch.kind === 'permit') {
      // the owner widened what their agent may do; the session is not reclaimed and nothing is granted once
      const [choice, resource] = (ch.resource ?? '').split('|');
      const out = await engine.setAgentAccess(r.session, resource!, choice === 'allow' ? 'allow' : null, true, now);
      if (!out.ok) return json(res, 403, { error: out.error });
      return json(res, 200, { ok: true, permitted: resource, choice, access: await engine.agentAccess(r.session, now) });
    }
    const approval = ch.kind === 'approve';
    // an approval covers that one held request; only a reclaim marks the whole session as the person's
    const ref = ch.resource ?? '';
    const held = ref.startsWith('S:') ? await store.getStepUp(ref.slice(2)) : null;
    const heldOk = !!held && held.session === r.session.id && held.expires > now;
    if (approval && !heldOk) return json(res, 410, { error: 'step_up_expired', message: 'The action is no longer waiting. Repeat it and approve again.' });
    if (!approval) await store.markHumanVerified(r.session.id, now);
    let granted: string | null = null;
    if (heldOk) { await store.passStepUp(held!.id, now + STEP_UP_TTL_MS); granted = held!.resource; }
    else if (!approval && ref && !ref.startsWith('S:')) { await store.grantStepUp(r.session.id, ref, STEP_UP_TTL_MS, now); granted = ref; }
    if (!approval) await store.addEvent(r.room, r.session.id, 'attach', { state: 'human_verified', atMs: null, evidence: [{ code: 'HUMAN_VERIFIED_WEBAUTHN', atMs: 0, detail: `credential ${cred.id.slice(0, 8)}…, UV=true` }], tools: [], version: 'webauthn-v1' }, now);
    bus.publish({ type: 'decision', room: r.room, session: r.session.id, at: now, id: `webauthn-${now}`, resource: granted ?? 'session.reclaim', decision: 'allow', actor: 'human_like', reasonCodes: ['HUMAN_VERIFIED_WEBAUTHN'] });
    if (approval) return json(res, 200, { ok: true, approved: granted, message: 'Approved once. Repeat the action.' });
    json(res, 200, { ok: true, humanVerifiedAt: now, validForMs: HUMAN_RECLAIM_TTL_MS, reclaim: { until: now + HUMAN_RECLAIM_TTL_MS }, granted, message: granted ? 'Confirmed. Repeat the action once.' : 'The session is yours again.' });
  };

  const status = async (req: Req, res: Res) => {
    const r = await engine.resolveSession(req);
    if (!r) return json(res, 401, { error: 'no_session' });
    const creds = await engine.credentialsFor<StoredCredential>(r.session);
    const s = (await store.getSession(r.session.id))!;
    json(res, 200, { credentials: creds.map((c) => ({ id: c.id, alg: c.alg, label: c.label, createdAt: c.createdAt })), humanVerifiedAt: s.humanVerifiedAt, validForMs: HUMAN_RECLAIM_TTL_MS });
  };

  return { registerOptions, register, assertOptions, assert, status };
}
