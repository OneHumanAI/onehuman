// SPDX-License-Identifier: BUSL-1.1
/**
 * Generic protected resources for the simulated applications.
 *
 *   GET|POST /api/v1/r/<resource>[?q=...]   → decision, then data (full or masked) / download URL
 *   GET      /api/v1/r/<resource>/file?t=   → the file, once, with a valid single-use token
 *
 * The app is the room's app; the resource must belong to it. The engine decides
 * before any data function runs.
 */
import { APPS, type ResourceDef } from '../apps.ts';
import { publicDecision, type OneHuman } from '../engine.ts';
import { json, url, type Req, type Res } from '../http.ts';
import { isLabSimulation } from './lab.ts';

export function resourceRoutes(engine: OneHuman) {
  const RESOURCE = /^\/api\/v1\/r\/([a-z][a-z0-9_.]{1,60})(\/file)?$/;

  async function lookup(req: Req): Promise<{ def: ResourceDef; file: boolean } | null> {
    const m = RESOURCE.exec(url(req).pathname);
    if (!m) return null;
    const resolved = await engine.resolveSession(req);
    if (!resolved) return null;
    const app = APPS[(await engine.store.roomApp(resolved.room)) ?? 'bank'];
    const def = app?.resources.find((r) => r.id === m[1]);
    return def ? { def, file: !!m[2] } : null;
  }

  /** Router entry: returns false when the path is not a resource path. */
  async function handle(req: Req, res: Res): Promise<boolean> {
    const m = RESOURCE.exec(url(req).pathname);
    if (!m) return false;
    const found = await lookup(req);
    if (!found) {
      const resolved = await engine.resolveSession(req);
      json(res, resolved ? 404 : 401, { error: resolved ? 'unknown_resource' : 'no_session' });
      return true;
    }
    const { def, file } = found;
    if (file) {
      if (req.method !== 'GET' || !def.file) { json(res, 405, { error: 'method' }); return true; }
      const resolved = (await engine.resolveSession(req))!;
      const t = url(req).searchParams.get('t') ?? '';
      const check = await engine.redeemToken(t, resolved.session.id, def.id);
      if (!check.ok) { json(res, 403, { error: 'token_rejected', reason: check.reason, message: 'The download link is invalid, expired or already used.' }); return true; }
      const out = def.file(resolved.session.id);
      res.writeHead(200, { 'Content-Type': out.mime, 'Content-Disposition': `attachment; filename="${out.filename}"`, 'Cache-Control': 'no-store', 'X-OH-Decision': check.claims.decisionId });
      res.end(out.body);
      return true;
    }
    if (req.method !== def.method) { json(res, 405, { error: 'method', expected: def.method }); return true; }
    await engine.protect(def.id, (rq, rs, ctx) => {
      if (def.view === 'download') {
        if (ctx.masked) { json(rs, 200, { view: def.view, downloadUrl: null, masked: true, decision: publicDecision(ctx.decision), assessment: ctx.assessment, message: 'Export is not available while data is masked.' }); return; }
        json(rs, 200, { view: def.view, downloadUrl: `/api/v1/r/${def.id}/file?t=${encodeURIComponent(ctx.token())}`, expiresInMs: 30000, decision: publicDecision(ctx.decision), assessment: ctx.assessment });
        return;
      }
      const params = url(rq).searchParams;
      const q = (params.get('q') ?? '').slice(0, 80);
      // form fields of a write action arrive as f.<name>; only the ones the resource declares, each short
      const fields: Record<string, string> = {};
      for (const f of def.fields ?? []) fields[f.name] = (params.get(`f.${f.name}`) ?? '').slice(0, 80);
      const data = def.data(ctx.session.id, q, fields);
      json(rs, 200, { view: def.view, data: ctx.masked ? data.masked : data.full, masked: ctx.masked, query: q, decision: publicDecision(ctx.decision), assessment: ctx.assessment });
    }, { simulated: isLabSimulation })(req, res);
    return true;
  }

  return { handle };
}
