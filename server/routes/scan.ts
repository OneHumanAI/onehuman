// SPDX-License-Identifier: BUSL-1.1
/**
 * The public repository scan (web/scan.html): a visitor pastes a link to a public GitHub repository, we read its source
 * without running it (server/repo-scan.ts) and show the first two findings at once. A work e-mail address unlocks the
 * other three and the full map is sent to it with the offer of 15 minutes. Every unlock is an inbound lead: the
 * team is told by e-mail.
 *
 *   POST /api/v1/scan          { repo }         → { id, repo, …, findings: first two, locked: n }
 *   POST /api/v1/scan/unlock   { id, email }    → { findings: all, mailed }
 */
import { randomBytes } from 'node:crypto';
import { json, readJson, sameOrigin, type Req, type Res } from './../http.ts';
import type { RepoScanRow, SiteStore } from '../site-db.ts';
import type { limiter } from '../limits.ts';
import type { Mailer } from '../mail.ts';
import { CONTACT_EMAIL } from '../chat-ai.ts';
import { ScanError, scanRepo, type RepoScan } from '../repo-scan.ts';
import type { Finding } from '../../integrations/cli/findings.ts';

const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,5}$/;
/** free mailboxes are not a work address; the scan's map goes to a company */
const FREE_MAIL = /@(?:gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|aol|proton|protonmail|pm|gmx|mail|yandex|bk|inbox|list|rambler|qq|163|126|zoho|tutanota|fastmail|hey)\.[a-z.]+$/i;
const PREVIEW = 2;

const sendable = (f: Finding, full: boolean) => ({ kind: f.kind, title: f.title, why: f.why, method: f.method, path: f.path, framework: f.framework, ...(full ? { file: f.file, line: f.line } : {}) });

export function scanRoutes(store: SiteStore, deps: {
  limits?: ReturnType<typeof limiter>;
  mail: Mailer | null;
  scan?: (repo: string) => Promise<RepoScan>;
}) {
  const run = deps.scan ?? ((repo: string) => scanRepo(repo));
  const notifyTo = () => (process.env.ONEHUMAN_CHAT_NOTIFY || CONTACT_EMAIL).split(',').map((s) => s.trim()).filter(Boolean);
  let busy = 0;   // scans running on this instance right now

  const view = (row: RepoScanRow, full: boolean) => {
    const r = row.result as RepoScan;
    const all = r.findings ?? [];
    return {
      id: row.id, repo: r.repo, filesScanned: r.filesScanned, frameworks: r.frameworks, routes: r.routes, counts: r.counts, total: all.length,
      unlocked: full,
      findings: all.slice(0, full ? all.length : PREVIEW).map((f) => sendable(f, full)),
      locked: full ? 0 : Math.max(0, all.length - PREVIEW),
    };
  };

  const start = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    const b = (await readJson(req, 2000).catch(() => null)) as { repo?: unknown } | null | undefined;
    const repo = typeof b?.repo === 'string' ? b.repo : '';
    const L = deps.limits;
    if (L && ((await L.over('scan', L.client(req), 6, 3600e3)) || (await L.over('scan-all', 'all', 400, 86_400e3)))) return json(res, 429, { error: 'rate_limited', message: 'Too many scans just now. Try again in a little while.' });
    if (busy >= 2) return json(res, 503, { error: 'busy', message: 'The scanner is busy. Try again in a minute.' });
    busy++;
    try {
      const result = await run(repo);
      const id = randomBytes(16).toString('hex');
      await store.addRepoScan({ id, repo: result.repo, result, client: L ? L.client(req) : null });
      json(res, 200, view({ id, repo: result.repo, created: Date.now(), result, client: null, email: null, unlockedAt: null }, false));
    } catch (e) {
      if (e instanceof ScanError) return json(res, e.code === 'bad_repo' ? 400 : e.code === 'not_found' ? 404 : e.code === 'too_large' ? 413 : e.code === 'empty' ? 422 : 502, { error: e.code, message: e.message });
      console.warn('onehuman scan: failed', e);
      json(res, 500, { error: 'failed', message: 'The scan did not finish. Try again in a minute.' });
    } finally { busy--; }
  };

  const unlock = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    const b = (await readJson(req, 2000).catch(() => null)) as { id?: unknown; email?: unknown } | null | undefined;
    const id = typeof b?.id === 'string' && /^[a-f0-9]{32}$/.test(b.id) ? b.id : '';
    const email = typeof b?.email === 'string' ? b.email.trim().toLowerCase() : '';
    const L = deps.limits;
    if (L && (await L.over('scan-unlock', L.client(req), 5, 3600e3))) return json(res, 429, { error: 'rate_limited', message: 'Too many tries. Try again in a little while.' });
    if (!EMAIL.test(email)) return json(res, 400, { error: 'bad_email', message: 'Enter a valid e-mail address.' });
    if (FREE_MAIL.test(email)) return json(res, 400, { error: 'work_email', message: 'Use your work e-mail: the map is about your company\'s product.' });
    const row = id ? await store.repoScanById(id) : null;
    if (!row) return json(res, 404, { error: 'not_found', message: 'This scan is gone. Run it again.' });
    const first = row.unlockedAt == null;
    if (first) await store.unlockRepoScan(id, email);
    const v = view({ ...row, email, unlockedAt: row.unlockedAt ?? Date.now() }, true);
    let mailed: 'sent' | 'skipped' | 'off' = 'off';
    if (first && deps.mail) {
      const r = row.result as RepoScan;
      try { mailed = await deps.mail.sendScanMap(email, { scanId: id, repo: r.repo, findings: r.findings, routes: r.routes, filesScanned: r.filesScanned, frameworks: r.frameworks }); } catch (e) { console.warn('onehuman scan: map mail failed', e); }
      const country = String(req.headers['x-vercel-ip-country'] ?? '') || null;
      for (const to of notifyTo()) await deps.mail.sendScanLead(to, { scanId: id, email, repo: r.repo, findings: r.findings, country }).catch((e) => console.warn('onehuman scan: lead mail failed', e));
    }
    json(res, 200, { ...v, mailed });
  };

  return { start, unlock };
}
