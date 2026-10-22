// SPDX-License-Identifier: Apache-2.0
/**
 * The design-partner report: what AI agents did in an app over a period, and what OneHuman would have done
 * about it. Built from decision rows — the local audit log on the customer's server, or the portal's copy of
 * the reported decisions — with the same code, so both say the same thing.
 *
 * In observe mode every decision is applied as `allow`; `computed` is what the rules would have done in
 * protect mode. The report is mostly about `computed`: that is the question a trial answers.
 */

export type DecisionLite = {
  session: string;
  created: number;
  resource: string;
  /** what was applied */
  decision: string;
  /** what the rules chose; differs from `decision` only in observe mode */
  computed: string;
  actor: string;
  tools: string[];
  signed: boolean;
  /** whether the rules were applied (enforce mode); unset when unknown */
  enforced?: boolean;
  /** 'unprotected' for a resource no rule covers */
  branch?: string;
};

export const AGENT_NAMES: Record<string, string> = {
  'claude-chrome': 'Claude in Chrome', 'codex-chrome': 'Codex (Chrome extension)', 'claude-app': 'Claude app browser', 'codex-app': 'Codex app browser',
  'claude-tools': 'Claude agent tools', 'browser-panel': 'Browser side-panel agent', 'cdp-reader': 'Automation script', 'unknown-tool': 'Unknown agent tool', operator: 'Signed agent',
};
export const agentName = (id: string) => AGENT_NAMES[id] ?? id;

const GATES = ['block', 'mask', 'step_up'] as const;
type Gate = (typeof GATES)[number];
const DAY = 86_400_000;

export type Report = {
  v: 1;
  period: { from: number; to: number; days: number };
  generated: number;
  source: 'server' | 'portal';
  app: string;
  /** the mode most decisions were made in */
  mode: 'observe' | 'enforce' | 'mixed' | 'none';
  sessions: { total: number; withAgent: number; share: number };
  decisions: { total: number; signed: number; applied: Record<string, number>; wouldBe: Record<string, number> };
  agents: { id: string; name: string; sessions: number; requests: number }[];
  endpoints: { resource: string; requests: number; agentRequests: number; wouldBlock: number; wouldMask: number; wouldStepUp: number; applied: { block: number; mask: number; step_up: number } }[];
  agentRequests: { total: number; wouldBlock: number; wouldMask: number; wouldStepUp: number; wouldAllow: number };
  people: { sessions: number; decisions: number; askedPasskey: number; wouldBeStopped: number; stopped: number };
  daily: { day: number; sessions: number; agentSessions: number; agentRequests: number }[];
  notes: string[];
};

const isAgent = (d: DecisionLite) => d.actor === 'agent_likely' || d.tools.length > 0;

/** Turn decision rows into the report. `sessionTools` adds agent names known per session from elsewhere (older rows). */
export function buildReport(rows: DecisionLite[], opts: { from: number; to: number; now?: number; source: 'server' | 'portal'; app?: string; sessionTools?: Map<string, string[]> }): Report {
  const toolsBySession = new Map<string, Set<string>>();
  for (const [s, t] of opts.sessionTools ?? []) toolsBySession.set(s, new Set(t));
  const sessions = new Map<string, { agent: boolean; human: boolean; firstDay: number }>();
  const applied: Record<string, number> = {}, wouldBe: Record<string, number> = {};
  const ep = new Map<string, Report['endpoints'][number]>();
  const agentReq = { total: 0, wouldBlock: 0, wouldMask: 0, wouldStepUp: 0, wouldAllow: 0 };
  const people = { sessions: 0, decisions: 0, askedPasskey: 0, wouldBeStopped: 0, stopped: 0 };
  const perTool = new Map<string, { sessions: Set<string>; requests: number }>();
  const days = new Map<number, { sessions: Set<string>; agentSessions: Set<string>; agentRequests: number }>();
  let signed = 0;

  for (const d of rows) {
    const day = Math.floor(d.created / DAY) * DAY;
    const t = [...new Set([...d.tools, ...(toolsBySession.get(d.session) ?? [])])];
    const agent = isAgent(d) || t.length > 0;
    const s = sessions.get(d.session) ?? { agent: false, human: false, firstDay: day };
    s.agent ||= agent; s.human ||= d.actor === 'human_like';
    sessions.set(d.session, s);
    applied[d.decision] = (applied[d.decision] ?? 0) + 1;
    wouldBe[d.computed] = (wouldBe[d.computed] ?? 0) + 1;
    if (d.signed) signed++;
    const e = ep.get(d.resource) ?? { resource: d.resource, requests: 0, agentRequests: 0, wouldBlock: 0, wouldMask: 0, wouldStepUp: 0, applied: { block: 0, mask: 0, step_up: 0 } };
    e.requests++;
    if ((GATES as readonly string[]).includes(d.decision)) e.applied[d.decision as Gate]++;
    if (agent) {
      e.agentRequests++; agentReq.total++;
      if (d.computed === 'block') { e.wouldBlock++; agentReq.wouldBlock++; }
      else if (d.computed === 'mask') { e.wouldMask++; agentReq.wouldMask++; }
      else if (d.computed === 'step_up') { e.wouldStepUp++; agentReq.wouldStepUp++; }
      else agentReq.wouldAllow++;
      for (const id of t.length ? t : ['unknown-tool']) {
        const x = perTool.get(id) ?? { sessions: new Set(), requests: 0 };
        x.sessions.add(d.session); x.requests++; perTool.set(id, x);
      }
    }
    ep.set(d.resource, e);
    if (d.actor === 'human_like') {
      people.decisions++;
      if (d.computed === 'step_up') people.askedPasskey++;
      if (d.computed === 'block') people.wouldBeStopped++;
      if (d.decision === 'block') people.stopped++;
    }
    const dd = days.get(day) ?? { sessions: new Set(), agentSessions: new Set(), agentRequests: 0 };
    dd.sessions.add(d.session); if (agent) { dd.agentSessions.add(d.session); dd.agentRequests++; }
    days.set(day, dd);
  }
  people.sessions = [...sessions.values()].filter((s) => s.human && !s.agent).length;
  const withAgent = [...sessions.values()].filter((s) => s.agent).length;
  const total = sessions.size;
  // the mode: only decisions a rule made count (an endpoint without a rule is never enforced)
  const ruled = rows.filter((d) => d.branch !== 'unprotected' && d.enforced !== undefined);
  const enf = ruled.filter((d) => d.enforced).length;
  const mode: Report['mode'] = !rows.length ? 'none' : !ruled.length ? 'observe' : enf === ruled.length ? 'enforce' : enf === 0 ? 'observe' : 'mixed';
  const daily: Report['daily'] = [];
  for (let t = Math.floor(opts.from / DAY) * DAY; t < opts.to; t += DAY) {
    const x = days.get(t);
    daily.push({ day: t, sessions: x?.sessions.size ?? 0, agentSessions: x?.agentSessions.size ?? 0, agentRequests: x?.agentRequests ?? 0 });
  }
  const agents = [...perTool.entries()].map(([id, x]) => ({ id, name: agentName(id), sessions: x.sessions.size, requests: x.requests })).sort((a, b) => b.sessions - a.sessions || b.requests - a.requests);
  const endpoints = [...ep.values()].sort((a, b) => b.agentRequests - a.agentRequests || b.requests - a.requests);

  // plain-language observations, the part a reader remembers
  const notes: string[] = [];
  const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 1000) / 10}%` : '0%');
  if (!rows.length) notes.push('No decisions yet in this period. The report fills in as soon as the app has traffic on a protected endpoint.');
  else {
    notes.push(`${withAgent} of ${total} sessions (${pct(withAgent, total)}) had an AI agent in them.`);
    if (agents[0]) notes.push(`The agent seen most often was ${agents[0].name}, in ${agents[0].sessions} session${agents[0].sessions === 1 ? '' : 's'}.`);
    const top = endpoints.find((e) => e.agentRequests > 0);
    if (top) notes.push(`Agents reached most for ${top.resource}: ${top.agentRequests} request${top.agentRequests === 1 ? '' : 's'}.`);
    const stoppedOrLimited = agentReq.wouldBlock + agentReq.wouldMask + agentReq.wouldStepUp;
    if (agentReq.total) notes.push(`${mode === 'enforce' ? 'Under the rules' : 'In protect mode'}, ${stoppedOrLimited} of ${agentReq.total} agent requests ${mode === 'enforce' ? 'were' : 'would have been'} refused, hidden or sent to a passkey.`);
    if (people.wouldBeStopped) notes.push(`${people.wouldBeStopped} request${people.wouldBeStopped === 1 ? '' : 's'} by people ${mode === 'enforce' ? 'were' : 'would have been'} refused. Check those rules before switching on.`);
    else if (people.decisions) notes.push(`No request by a person ${mode === 'enforce' ? 'was' : 'would have been'} refused.`);
    if (people.askedPasskey) notes.push(`People ${mode === 'enforce' ? 'were' : 'would have been'} asked for a passkey ${people.askedPasskey} time${people.askedPasskey === 1 ? '' : 's'}.`);
  }
  return {
    v: 1, period: { from: opts.from, to: opts.to, days: Math.round((opts.to - opts.from) / DAY) }, generated: opts.now ?? Date.now(), source: opts.source, app: opts.app ?? '',
    mode, sessions: { total, withAgent, share: total ? withAgent / total : 0 }, decisions: { total: rows.length, signed, applied, wouldBe },
    agents, endpoints, agentRequests: agentReq, people, daily, notes,
  };
}
