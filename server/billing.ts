// SPDX-License-Identifier: BUSL-1.1
/**
 * Plans and usage.
 *
 * Every deployment runs with a license (server/license.ts): an API key, the free plan included. The plan decides what
 * the license allows. Within the plan: protection, and agent signatures the day they ship on paid plans (Free gets
 * them 30 days later). Past Free's limit, or with a prepaid balance used up: 14 days of grace, then the license says
 * 'observe' until the plan covers the month (or the next month starts): OneHuman still watches and records, it no
 * longer enforces. The app never breaks over a plan, and the owner is told before anything changes.
 *
 * The unit is an agent-active customer: one of the company's signed-in customers (identify()) in whose session an AI
 * agent acted, counted once a calendar month however often they come back. A visitor who is not signed in never
 * counts, so a flood of bots cannot raise anyone's bill, and a company pays only once agents actually show up.
 *
 *   Free           100 agent-active customers a month; signatures 30 days after release
 *   Pay as you go  the first 100 free, then $0.50 each from a prepaid balance; signatures the day they ship
 *   Growth         $299 a month with 1,000 included, then $0.30 each (invoiced)
 *   Enterprise     an annual contract
 */
import type { BillingRow, SiteStore, TelemetryEvent, UsageCounts } from './site-db.ts';
import type { Mailer } from './mail.ts';

export type PlanId = 'free' | 'payg' | 'growth' | 'enterprise';
export type Plan = {
  id: PlanId; name: string;
  /** agent-active customers a month before the plan charges (null: no limit) */
  included: number | null;
  /** price of each one after that, in cents (null: none, the plan stops at its limit or is contracted) */
  unitCents: number | null;
  monthlyCents: number | null;
  liveSignatures: boolean;
  prepaid: boolean;
  summary: string;
  features: string[];
};

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free', name: 'Free', included: 100, unitCents: null, monthlyCents: 0, liveSignatures: false, prepaid: false,
    summary: 'Up to 100 agent-active customers a month.',
    features: ['A free API key: the engine on your servers watches and protects', 'Portal, activity and the free 30-day report', 'Agent signatures 30 days after release', 'Help on GitHub'],
  },
  payg: {
    id: 'payg', name: 'Pay as you go', included: 100, unitCents: 50, monthlyCents: 0, liveSignatures: true, prepaid: true,
    summary: 'The first 100 a month free, then $0.50 per agent-active customer, from a prepaid balance.',
    features: ['Everything in Free', 'Agent signatures the day they are released', 'Alerts and weekly reports', 'No commitment: top up when you like'],
  },
  growth: {
    id: 'growth', name: 'Growth', included: 1000, unitCents: 30, monthlyCents: 29900, liveSignatures: true, prepaid: false,
    summary: '$299 a month with 1,000 agent-active customers included, then $0.30 each.',
    features: ['Everything in Pay as you go', 'Signed proof archive for a year', 'Priority support from the founders'],
  },
  enterprise: {
    id: 'enterprise', name: 'Enterprise', included: null, unitCents: null, monthlyCents: null, liveSignatures: true, prepaid: false,
    summary: 'An annual contract for banks, insurers and large platforms.',
    features: ['Unlimited apps and customers', 'Proof retention as long as your regulator asks', 'Auditor support for DORA, PSD2 and GDPR reviews', 'SLA, SSO and on-premise deployment by agreement'],
  },
};
export const PLAN_IDS = Object.keys(PLANS) as PlanId[];
/** how far behind the newest agent signatures a plan without live signatures is kept */
export const SIGNATURE_DELAY_MS = 30 * 86_400_000;
/** how long an account past its limit keeps full protection before the license turns to watch-only */
export const GRACE_MS = 14 * 86_400_000;

export const monthOf = (t: number) => new Date(t).toISOString().slice(0, 7);
/** an event in which an AI agent acted (the same test as everywhere in the portal) */
export const agentActed = (e: Pick<TelemetryEvent, 'state' | 'actor'>) => e.state === 'agent_attached' || e.state === 'signed_agent' || e.actor === 'agent_likely';

export type BillingStatus = {
  plan: Plan; billing: BillingRow; month: string; usage: UsageCounts;
  /** past the plan's limit (Free) or out of balance (Pay as you go): signatures are held back until it changes */
  over: boolean;
  /** when this month's overrun began, and what the license allows now: enforce, or observe once the grace is over */
  overSince: number | null;
  licenseMode: 'enforce' | 'observe';
  /** when the license turns to observe if nothing changes (null: it will not) */
  observeFrom: number | null;
  liveSignatures: boolean;
  /** this month's charge so far, in cents (null: by contract) */
  estimateCents: number | null;
};

export function billing(store: SiteStore, deps: { mail?: Mailer | null; now?: () => number } = {}) {
  const now = deps.now ?? Date.now;
  const planOf = (b: BillingRow): Plan => PLANS[b.plan as PlanId] ?? PLANS.free;

  /** how one more agent-active customer is counted on this plan, the n-th of the month */
  async function classify(account: string, plan: Plan, n: number): Promise<{ kind: string; cents: number }> {
    if (plan.included === null) return { kind: 'included', cents: 0 };
    if (n <= plan.included) return { kind: 'included', cents: 0 };
    if (plan.id === 'payg') return (await store.debitBalance(account, plan.unitCents!, now())) ? { kind: 'paid', cents: plan.unitCents! } : { kind: 'unpaid', cents: 0 };
    if (plan.id === 'growth') return { kind: 'overage', cents: plan.unitCents! };
    return { kind: 'over', cents: 0 };
  }

  /** On ingest: count the customers in whose session an agent acted this month, each once. */
  async function meter(account: string, keyId: string, events: TelemetryEvent[]): Promise<number> {
    // only signed-in customers count; older reporters do not say, and are counted as before
    const sessions = [...new Set(events.filter((e) => agentActed(e) && e.login !== false).map((e) => e.session))];
    if (!sessions.length) return 0;
    const t = now();
    const month = monthOf(t);
    const fresh = await store.addUsageMarks(account, month, keyId, sessions, t);
    if (!fresh.length) return 0;
    const b = await store.billingFor(account);
    const plan = planOf(b);
    let n = (await store.usageCounts(account, month)).total - fresh.length;
    for (const s of fresh) {
      const c = await classify(account, plan, ++n);
      await store.setUsageMark(account, month, s, c.kind, c.cents);
    }
    await markOverrun(account);
    await notices(account).catch((e) => console.warn('onehuman billing: notice failed', e));
    return fresh.length;
  }

  async function status(account: string): Promise<BillingStatus> {
    const month = monthOf(now());
    const b = await store.billingFor(account);
    const plan = planOf(b);
    const usage = await store.usageCounts(account, month);
    const over = plan.id === 'free' ? usage.total > (plan.included ?? Infinity)
      : plan.id === 'payg' ? (usage.kinds.unpaid ?? 0) > 0
      : false;
    const estimateCents = plan.id === 'enterprise' ? null
      : plan.id === 'growth' ? (plan.monthlyCents ?? 0) + (usage.kinds.overage ?? 0) * (plan.unitCents ?? 0)
      : usage.cents;
    const overSince = over ? (b.overMonth === month && b.overSince ? b.overSince : now()) : null;
    const observeFrom = overSince === null ? null : overSince + GRACE_MS;
    const licenseMode = observeFrom !== null && now() >= observeFrom ? 'observe' : 'enforce';
    return { plan, billing: b, month, usage, over, overSince, licenseMode, observeFrom, liveSignatures: plan.liveSignatures && !over, estimateCents };
  }

  /** the day an account went past its plan this month starts its grace; covering the month clears it */
  async function markOverrun(account: string): Promise<void> {
    const st = await status(account);
    if (st.over && (st.billing.overMonth !== st.month || !st.billing.overSince)) await store.setBilling(account, { over_since: st.overSince, over_month: st.month }, now());
    if (!st.over && st.billing.overSince) await store.setBilling(account, { over_since: null, over_month: null }, now());
  }

  /**
   * After a plan change or a top-up: customers counted this month that the old plan could not cover (over a limit,
   * or no balance) are counted again on the plan the account has now.
   */
  async function settle(account: string): Promise<void> {
    const month = monthOf(now());
    const plan = planOf(await store.billingFor(account));
    let n = (await store.usageCounts(account, month)).total;
    const open = [...await store.usageMarksOfKind(account, month, 'over'), ...await store.usageMarksOfKind(account, month, 'unpaid')];
    // the ones already in their place keep it; these are the newest, so they take the last places
    n -= open.length;
    for (const s of open) {
      const c = await classify(account, plan, ++n);
      await store.setUsageMark(account, month, s, c.kind, c.cents);
    }
  }

  /** the plan the owner chose: Free applies at once; a paid plan is a request the team confirms after payment */
  async function choose(account: string, id: PlanId, by: string): Promise<{ applied: boolean; requested: PlanId | null }> {
    const b = await store.billingFor(account);
    if (b.plan === id) { if (b.requested) await store.setBilling(account, { requested: null, requested_at: null }, now()); return { applied: true, requested: null }; }
    if (id === 'free') {
      await store.setBilling(account, { plan: 'free', requested: null, requested_at: null, note: `changed to Free by ${by}` }, now());
      return { applied: true, requested: null };
    }
    await store.setBilling(account, { requested: id, requested_at: now() }, now());
    return { applied: false, requested: id };
  }

  /** The team sets a plan or adds to a balance (after a payment or as a credit), then what was open is settled. */
  async function adjust(account: string, change: { plan?: PlanId; addCents?: number; note?: string | null }, by: string): Promise<BillingStatus> {
    if (change.plan) await store.setBilling(account, { plan: change.plan, requested: null, requested_at: null, note: change.note ?? null }, now());
    if (change.addCents) await store.addBalance(account, change.addCents, change.addCents > 0 ? 'topup' : 'adjust', change.note ?? null, by, now());
    await settle(account);
    await markOverrun(account);
    return status(account);
  }

  /** one e-mail per kind per month: 80% of Free, Free's limit, a low balance, an empty one */
  async function notices(account: string): Promise<void> {
    if (!deps.mail) return;
    const st = await status(account);
    const kinds: ('near' | 'limit' | 'low' | 'empty' | 'observe')[] = [];
    const used = st.usage.total, included = st.plan.included ?? Infinity;
    if (st.plan.id === 'free') { if (used > included) kinds.push('limit'); else if (used >= included * 0.8) kinds.push('near'); }
    if (st.plan.id === 'payg') {
      if ((st.usage.kinds.unpaid ?? 0) > 0) kinds.push('empty');
      else if (used > included && st.billing.balanceCents < 20 * (st.plan.unitCents ?? 0)) kinds.push('low');
    }
    if (st.licenseMode === 'observe') kinds.push('observe');
    const sent = new Set((st.billing.notified ?? '').startsWith(`${st.month}:`) ? st.billing.notified!.slice(8).split(',') : []);
    const todo = kinds.filter((k) => !sent.has(k));
    if (!todo.length) return;
    const acc = await store.accountById(account);
    if (!acc) return;
    for (const k of todo) {
      await deps.mail.sendPlanNotice(acc.email, { kind: k, plan: st.plan.name, used, included: st.plan.included, balanceCents: st.billing.balanceCents, observeFrom: st.observeFrom });
      sent.add(k);
    }
    await store.setBilling(account, { notified: `${st.month}:${[...sent].join(',')}` }, now());
  }

  /** what an account's license allows now (the portal signs it into the token its servers fetch) */
  async function licenseMode(account: string): Promise<'enforce' | 'observe'> {
    const st = await status(account);
    if (st.licenseMode === 'observe') await notices(account).catch(() => {});
    return st.licenseMode;
  }

  return { meter, status, settle, choose, adjust, notices, planOf, licenseMode };
}
export type Billing = ReturnType<typeof billing>;
