// SPDX-License-Identifier: BUSL-1.1
/**
 * A sample 30-day report from made-up decisions: the /report page shows what a trial ends with, and the e-mail
 * previews fill their numbers from it. Deterministic (a seeded generator), so the page never changes between deploys
 * of the same code. Every figure is synthetic and the page says so.
 */
import { buildReport, type DecisionLite, type Report } from '../integrations/report/build.ts';

const DAY = 86_400_000;

/** a small seeded generator (mulberry32): the same numbers on every server */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PEOPLE_RESOURCES = ['invoices.read', 'customers.read', 'profile.read', 'invoices.read', 'reports.read'];
/** what an agent asked for, and what the sample rules would have done with it */
const AGENT_ACTIONS: [string, string][] = [
  ['customers.read', 'mask'], ['invoices.read', 'mask'], ['customers.export', 'step_up'], ['payments.create', 'step_up'],
  ['invoices.read', 'mask'], ['settings.api_keys', 'block'], ['customers.read', 'mask'], ['reports.read', 'allow'],
];
const AGENTS = [['claude-chrome'], ['claude-chrome'], ['claude-app'], ['codex-chrome'], ['claude-chrome'], ['browser-panel']];

export function sampleDecisions(to: number, days = 30): DecisionLite[] {
  const r = rng(20261002);
  const rows: DecisionLite[] = [];
  const from = to - days * DAY;
  let n = 0;
  for (let d = 0; d < days; d++) {
    const dayStart = from + d * DAY;
    const weekday = new Date(dayStart).getUTCDay();
    const people = (weekday === 0 || weekday === 6 ? 22 : 48) + Math.floor(r() * 14);
    // agents arrive slowly at first, then more often: the curve a trial usually shows
    const agents = Math.floor((d / days) * 4 + r() * 2.2);
    for (let i = 0; i < people; i++) {
      const session = `p${++n}`;
      const at = dayStart + Math.floor(r() * DAY);
      const k = 1 + Math.floor(r() * 3);
      for (let j = 0; j < k; j++) {
        const resource = PEOPLE_RESOURCES[Math.floor(r() * PEOPLE_RESOURCES.length)]!;
        rows.push({ session, created: at + j * 4000, resource, decision: 'allow', computed: 'allow', actor: 'human_like', tools: [], signed: true, enforced: false });
      }
    }
    for (let i = 0; i < agents; i++) {
      const session = `a${++n}`;
      const at = dayStart + Math.floor(r() * DAY);
      const tools = AGENTS[Math.floor(r() * AGENTS.length)]!;
      const k = 2 + Math.floor(r() * 4);
      for (let j = 0; j < k; j++) {
        const [resource, computed] = AGENT_ACTIONS[Math.floor(r() * AGENT_ACTIONS.length)]!;
        rows.push({ session, created: at + j * 2500, resource, decision: 'allow', computed, actor: 'agent_likely', tools, signed: true, enforced: false });
      }
    }
  }
  return rows.sort((a, b) => a.created - b.created);
}

/** the sample report, ending at the start of today (UTC) */
export function sampleReport(now = Date.now(), days = 30): Report {
  const to = Math.floor(now / DAY) * DAY;
  return buildReport(sampleDecisions(to, days), { from: to - days * DAY, to, now: to, source: 'portal', app: 'Acme Billing (sample data)' });
}
