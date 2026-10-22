// SPDX-License-Identifier: Apache-2.0
/**
 * The few things in a scan worth a person's attention, in plain words: what an AI agent working in a signed-in
 * customer's session could pull out in bulk, move money with, or leave behind that outlives the session (an API
 * token, a webhook, an invite, a share link). Built from the scanner's routes; nothing is run.
 */
import type { RouteHit, ScanResult } from './scan.ts';

export type FindingKind = 'leaves-behind' | 'bulk-export' | 'money' | 'private-data';
export type Finding = {
  kind: FindingKind;
  /** one line a person understands */
  title: string;
  /** what the agent can do, in a sentence */
  why: string;
  method: string;
  path: string;
  file: string;
  line: number;
  framework: string;
  score: number;
};

const KIND_LABEL: Record<FindingKind, string> = {
  'leaves-behind': 'Leaves something behind',
  'bulk-export': 'Bulk export',
  money: 'Moves money',
  'private-data': 'Private data',
};
export const findingLabel = (k: FindingKind) => KIND_LABEL[k];

const words = (x: string) => x.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const LEAVES = /(api-?keys?|access-?tokens?|personal-?access|tokens?\b.*(create|new|generate|issue)|(create|new|generate|issue|rotate).*tokens?|service-?accounts?|ssh-?keys?|webhooks?|integrations?|oauth-?apps?|invit(e|ation)s?|share-?links?|public-?links?|magic-?links?|api-?credentials?)/;
const LEAVES_WRITE_ONLY = /(create|new|generate|issue|add|register|invite|share|rotate|subscribe|connect|enable)|(webhooks?|api-?keys?|tokens?|invites?|integrations?)$/;
const INBOUND_WEBHOOK = /webhooks?\/(stripe|github|clerk|slack|twilio|sendgrid|paddle|lemon|shopify|resend|postmark|svix|polar|inngest|vercel|auth0|supabase)/;
const MONEY = /(transfer|withdraw|payout|refund|charge|checkout|pay(ment)?s?\b|send-?money|wire|top-?up|deposit|purchase|subscription.*(cancel|upgrade|update)|(cancel|upgrade|update).*subscription|billing.*(update|change)|card.*(add|update|remove))/;
const EXPORT = /(export|download|csv|xlsx|dump|backup|all-?(users|customers|contacts|records|data))/;

function classify(r: RouteHit): FindingKind | null {
  const hay = words(`${r.path} ${r.resource}`);
  const write = r.method !== 'GET';
  if (INBOUND_WEBHOOK.test(hay)) return null;
  if (write && LEAVES.test(hay) && LEAVES_WRITE_ONLY.test(words(r.path))) return 'leaves-behind';
  if (write && MONEY.test(hay)) return 'money';
  if (r.kind === 'download' || EXPORT.test(hay)) return r.sensitivity >= 25 || EXPORT.test(hay) ? 'bulk-export' : null;
  if (r.signals.includes('money-write') && write) return 'money';
  if (r.sensitivity >= 45 && !r.signals.includes('excluded-pattern')) return 'private-data';
  return null;
}

const WHY: Record<FindingKind, (r: RouteHit) => string> = {
  'leaves-behind': () => 'An agent in a signed-in session can create it, and it keeps working after the session ends. Nobody is asked.',
  'bulk-export': () => 'An agent can pull the whole list in one call, as the customer. Nothing tells the owner it left.',
  money: () => 'An agent can start this as the customer. The server cannot tell the agent from the person.',
  'private-data': () => 'An agent can read this as the customer, including fields it never needed.',
};
const BONUS: Record<FindingKind, number> = { 'leaves-behind': 30, 'bulk-export': 22, money: 25, 'private-data': 0 };

function title(r: RouteHit, kind: FindingKind): string {
  const name = words(r.path).replace(/^\/(api|actions|rpc)\//, '/').replace(/\/trpc\//, '/');
  const pretty = name.replace(/[:[\]{}]/g, '').replace(/[-_.]+/g, ' ').replace(/\//g, ' › ').trim();
  const verb = { 'leaves-behind': 'Creates', 'bulk-export': 'Exports', money: 'Moves money:', 'private-data': r.method === 'GET' ? 'Reads' : 'Changes' }[kind];
  return `${verb} ${pretty}`.replace(/\s+/g, ' ');
}

/** The top `n` findings: the highest of each kind first (a report of five exports says less than four different risks), then the rest by score. */
export function topFindings(result: ScanResult, n = 5): Finding[] {
  const all: Finding[] = [];
  for (const r of result.routes) {
    const kind = classify(r);
    if (!kind) continue;
    all.push({ kind, title: title(r, kind), why: WHY[kind](r), method: r.method, path: r.path, file: r.file, line: r.line, framework: r.framework, score: Math.min(100, r.sensitivity + BONUS[kind]) });
  }
  all.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const picked: Finding[] = [];
  for (const kind of ['leaves-behind', 'bulk-export', 'money', 'private-data'] as FindingKind[]) {
    const best = all.find((f) => f.kind === kind);
    if (best) picked.push(best);
  }
  for (const f of all) if (picked.length < n && !picked.includes(f)) picked.push(f);
  return picked.slice(0, n).sort((a, b) => b.score - a.score);
}

/** counts per kind over every finding, for the headline */
export function findingCounts(result: ScanResult): Record<FindingKind, number> {
  const c: Record<FindingKind, number> = { 'leaves-behind': 0, 'bulk-export': 0, money: 0, 'private-data': 0 };
  for (const r of result.routes) { const k = classify(r); if (k) c[k]++; }
  return c;
}
