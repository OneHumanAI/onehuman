// SPDX-License-Identifier: BUSL-1.1
/**
 * What changed in the AI agents themselves — the part of the weekly report that is the same for every
 * customer. Written for a security lead, not an engineer: what the agent did differently and what it meant
 * for OneHuman customers. Never names the signals we use (they would help agent authors hide).
 * Newest first. Add an entry whenever a scorecard run or a field report shows a change.
 */
export type AgentNews = { date: string; agent: string; change: string; impact: string; action: string | null };

export const AGENT_NEWS: AgentNews[] = [
  {
    date: '2026-09-23',
    agent: 'Stealth scripts written for one site',
    change: 'Our own red-team built a script that knows a site\'s layout, never reads the page and imitates hardware input. It passes behaviour checks as a person.',
    impact: 'General AI agents are still caught, because they read the page. A script hand-built against your site is the remaining gap.',
    action: 'Mark your most critical actions (exports, payouts, changing contact details) as "Passkey for everyone" in the policy builder.',
  },
  {
    date: '2026-09-22',
    agent: 'OpenAI Codex, built-in browser',
    change: 'A new version shows up as a plain Chrome browser and, in one run, left no sign of the product at all.',
    impact: 'Still caught at its first click by how it acts. Vendors removing their marks is why detection needs weekly updates.',
    action: null,
  },
  {
    date: '2026-09-22',
    agent: 'OpenAI Codex, Chrome extension',
    change: 'Re-tested on a 21-task session.',
    impact: 'Caught as it takes over the tab, before its first click, on every step.',
    action: null,
  },
  {
    date: '2026-09-20',
    agent: 'Anthropic Claude in Chrome',
    change: 'Re-tested on a 21-task session after its extension update.',
    impact: 'Caught as it takes over the tab, before its first click, on every step.',
    action: null,
  },
];

export function newsSince(since: number, now = Date.now()): AgentNews[] {
  return AGENT_NEWS.filter((n) => { const t = Date.parse(n.date + 'T00:00:00Z'); return t >= since && t <= now; });
}
