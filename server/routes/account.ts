// SPDX-License-Identifier: BUSL-1.1
/**
 * The "company app": a synthetic bank account. Every endpoint that returns
 * sensitive data is wrapped by `engine.protect(resource, …)` — the decision
 * happens here, before any data leaves the server.
 */
import type { OneHuman } from '../engine.ts';
import { publicDecision } from '../engine.ts';
import { json, url, type Req, type Res } from '../http.ts';
import { demoAccount, maskProfile, maskTransactions, toCsv } from '../demo-data.ts';
import { isLabSimulation } from './lab.ts';

export function accountRoutes(engine: OneHuman) {
  const profile = engine.protect('profile.read', (_req, res, ctx) => {
    const { profile } = demoAccount(ctx.session.id);
    json(res, 200, { profile: ctx.masked ? maskProfile(profile) : profile, masked: ctx.masked, decision: publicDecision(ctx.decision), assessment: ctx.assessment });
  }, { simulated: isLabSimulation });

  const balance = engine.protect('balance.read', (_req, res, ctx) => {
    const { balance } = demoAccount(ctx.session.id);
    json(res, 200, { balance: ctx.masked ? { ...balance, available: null, blocked: null } : balance, masked: ctx.masked, decision: publicDecision(ctx.decision), assessment: ctx.assessment });
  }, { simulated: isLabSimulation });

  const transactions = engine.protect('transactions.search', (req, res, ctx) => {
    const q = (url(req).searchParams.get('q') ?? '').slice(0, 80).toLocaleLowerCase('az');
    const { transactions } = demoAccount(ctx.session.id);
    const hits = transactions.filter((t) => !q || t.title.toLocaleLowerCase('az').includes(q) || t.category.toLocaleLowerCase('az').includes(q));
    json(res, 200, { transactions: ctx.masked ? maskTransactions(hits) : hits, masked: ctx.masked, query: q, decision: publicDecision(ctx.decision), assessment: ctx.assessment });
  }, { simulated: isLabSimulation });

  // Step 1: the decision. Returns a single-use download URL only when allowed.
  const exportRequest = engine.protect('report.export', (_req, res, ctx) => {
    if (ctx.masked) {
      json(res, 200, { downloadUrl: null, masked: true, decision: publicDecision(ctx.decision), assessment: ctx.assessment, message: 'Under this rule, export is not available in masked mode.' });
      return;
    }
    const token = ctx.token();
    json(res, 200, { downloadUrl: `/api/v1/account/export/file?t=${encodeURIComponent(token)}`, expiresInMs: 30000, decision: publicDecision(ctx.decision), assessment: ctx.assessment });
  }, { simulated: isLabSimulation });

  // Step 2: the file. No decision token → no file. Token is single-use and session-bound.
  const exportFile = async (req: Req, res: Res) => {
    const resolved = await engine.resolveSession(req);
    if (!resolved) {
      json(res, 401, { error: 'no_session' });
      return;
    }
    const t = url(req).searchParams.get('t') ?? '';
    const check = await engine.redeemToken(t, resolved.session.id, 'report.export');
    if (!check.ok) {
      json(res, 403, { error: 'token_rejected', reason: check.reason, message: 'The download link is invalid, expired or already used.' });
      return;
    }
    const { profile, balance, transactions } = demoAccount(resolved.session.id);
    const csv = toCsv(profile, balance, transactions);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="onehuman-demo-hesabat.csv"',
      'Cache-Control': 'no-store',
      'X-OH-Decision': check.claims.decisionId,
    });
    res.end(csv);
  };

  return { profile, balance, transactions, exportRequest, exportFile };
}
