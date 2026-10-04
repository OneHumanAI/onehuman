// SPDX-License-Identifier: BUSL-1.1
/**
 * Policy engine. A company declares which resources are protected and what
 * happens for each actor assessment. The decision is made at the endpoint
 * that returns the data, never in the UI.
 */
import type { Assessment, Tier } from './assess.ts';

export type Mode = 'allow' | 'mask' | 'step_up' | 'block';

export type Rule = {
  resource: string;
  /** human-readable label for dashboards */
  title: string;
  onAgent: Mode;
  onUnknown: Mode;
  onHumanLike: Mode;
  /** applied when the actor is unknown but environment artifacts point at an agent tool (installed extension, agent-app browser, agent globals) */
  onArtifact: Mode;
  /** which evidence tiers are allowed to trigger `onAgent` */
  actOn: Tier[];
  /** minimum score for behavioral-only evidence */
  minScore: number;
};

export type Policy = {
  version: string;
  /** observe = log what would happen but always allow; enforce = apply */
  enforcement: 'observe' | 'enforce';
  rules: Rule[];
};

export type Decision = {
  id: string;
  resource: string;
  /** decision actually applied to the response */
  decision: Mode;
  /** decision the policy computed (differs from `decision` only in observe mode) */
  computed: Mode;
  enforced: boolean;
  actor: Assessment['actor'];
  score: number | null;
  tiers: Tier[];
  reasonCodes: string[];
  policyVersion: string;
  signalVersion: string;
  /** which branch of the rule fired */
  branch: 'agent' | 'artifact' | 'unknown' | 'human_like' | 'unprotected';
};

const DEFAULT_ACT_ON: Tier[] = ['verified', 'strong', 'control', 'behavioral'];

export const DEFAULT_POLICY: Policy = {
  version: 'policy-default-2',
  enforcement: 'enforce',
  rules: [
    { resource: 'profile.read', title: 'Profile data', onAgent: 'mask', onUnknown: 'allow', onHumanLike: 'allow', onArtifact: 'allow', actOn: DEFAULT_ACT_ON, minScore: 65 },
    { resource: 'balance.read', title: 'Balans', onAgent: 'block', onUnknown: 'allow', onHumanLike: 'allow', onArtifact: 'mask', actOn: DEFAULT_ACT_ON, minScore: 65 },
    { resource: 'transactions.search', title: 'Transaction search', onAgent: 'mask', onUnknown: 'allow', onHumanLike: 'allow', onArtifact: 'allow', actOn: DEFAULT_ACT_ON, minScore: 65 },
    { resource: 'report.export', title: 'CSV export', onAgent: 'block', onUnknown: 'step_up', onHumanLike: 'allow', onArtifact: 'step_up', actOn: DEFAULT_ACT_ON, minScore: 65 },
  ],
};

const MODES: Mode[] = ['allow', 'mask', 'step_up', 'block'];
const TIERS: Tier[] = ['verified', 'strong', 'control', 'behavioral', 'artifact'];

/** Validate an untrusted policy document. Returns null when invalid; checkPolicy says why. */
export function parsePolicy(input: unknown, version: string): Policy | null {
  const c = checkPolicy(input, version);
  return 'policy' in c ? c.policy : null;
}

/** Validate a policy document and name the first problem, for error messages a person can act on. */
export function checkPolicy(input: unknown, version: string): { policy: Policy } | { error: string } {
  if (!input || typeof input !== 'object') return { error: 'the policy is not a JSON object' };
  const o = input as Record<string, unknown>;
  if (o.enforcement !== 'observe' && o.enforcement !== 'enforce') return { error: 'enforcement must be "observe" or "enforce"' };
  if (!Array.isArray(o.rules) || o.rules.length === 0 || o.rules.length > 50) return { error: 'rules must be a list of 1 to 50 rules' };
  const rules: Rule[] = [];
  for (const [i, r] of o.rules.entries()) {
    const at = `rule ${i + 1}`;
    if (!r || typeof r !== 'object') return { error: `${at} is not an object` };
    const x = r as Record<string, unknown>;
    if (typeof x.resource !== 'string' || !/^[a-z][a-z0-9_.]{1,60}$/.test(x.resource)) return { error: `${at}: resource must be lower-case letters, digits, "_" and "." (got ${JSON.stringify(x.resource)})` };
    if (rules.some((k) => k.resource === x.resource)) return { error: `${at}: resource "${x.resource}" appears twice; one rule per resource (routes may share it)` };
    if (typeof x.title !== 'string' || x.title.length > 80) return { error: `${at} (${x.resource}): title must be text of at most 80 characters` };
    for (const key of ['onAgent', 'onUnknown', 'onHumanLike'] as const) if (!MODES.includes(x[key] as Mode)) return { error: `${at} (${x.resource}): ${key} must be one of ${MODES.join(', ')}` };
    const onArtifact = x.onArtifact === undefined ? 'allow' : x.onArtifact;
    if (!MODES.includes(onArtifact as Mode)) return { error: `${at} (${x.resource}): onArtifact must be one of ${MODES.join(', ')}` };
    if (!Array.isArray(x.actOn) || !x.actOn.every((t) => TIERS.includes(t as Tier))) return { error: `${at} (${x.resource}): actOn must list tiers from ${TIERS.join(', ')}` };
    if (typeof x.minScore !== 'number' || x.minScore < 0 || x.minScore > 100) return { error: `${at} (${x.resource}): minScore must be a number from 0 to 100` };
    rules.push({
      resource: x.resource,
      title: x.title,
      onAgent: x.onAgent as Mode,
      onUnknown: x.onUnknown as Mode,
      onHumanLike: x.onHumanLike as Mode,
      onArtifact: onArtifact as Mode,
      actOn: [...new Set(x.actOn as Tier[])],
      minScore: x.minScore,
    });
  }
  return { policy: { version, enforcement: o.enforcement, rules } };
}

/**
 * Evaluate a policy for one resource against an assessment.
 * Pure: no I/O, deterministic. The caller persists the decision to the audit log.
 */
export function evaluate(policy: Policy, resource: string, a: Assessment, id: string): Decision {
  const rule = policy.rules.find((r) => r.resource === resource);
  const base = {
    id,
    resource,
    actor: a.actor,
    score: a.score,
    tiers: a.tiers,
    reasonCodes: a.reasons.map((r) => r.code),
    policyVersion: policy.version,
    signalVersion: a.version,
  };
  if (!rule) return { ...base, decision: 'allow', computed: 'allow', enforced: false, branch: 'unprotected' };

  let computed: Mode;
  let branch: Decision['branch'];
  const actionableTiers = a.tiers.filter((t) => rule.actOn.includes(t));
  const agentByPolicy =
    a.actor === 'agent_likely' &&
    actionableTiers.length > 0 &&
    (actionableTiers.some((t) => t === 'verified' || t === 'strong' || t === 'control') || (a.score ?? 0) >= rule.minScore);
  // artifact in actOn = treat environment traces as agent evidence; otherwise they take the softer onArtifact branch
  const artifactAsAgent = a.actor === 'unknown' && actionableTiers.includes('artifact');
  const artifactOnly = a.actor === 'unknown' && a.tiers.includes('artifact');

  if (agentByPolicy || artifactAsAgent) {
    computed = rule.onAgent;
    branch = 'agent';
  } else if (artifactOnly) {
    computed = rule.onArtifact;
    branch = 'artifact';
  } else if (a.actor === 'human_like') {
    computed = rule.onHumanLike;
    branch = 'human_like';
  } else {
    computed = rule.onUnknown;
    branch = 'unknown';
  }
  const enforced = policy.enforcement === 'enforce';
  return { ...base, computed, decision: enforced ? computed : 'allow', enforced, branch };
}

/**
 * The account owner's say over their own agent, inside the bounds the company set. The owner can always make it
 * stricter ('never': the agent is refused this resource). The owner can make it looser ('allow') only where the
 * company's rule for agents is 'mask' or 'step_up'; a company 'block' stays a block. It applies only when the rule's
 * agent branches fired: a person at the controls is never affected.
 *
 * 'never' refuses a proven agent outright. When only the environment looked like one (the artifact branch: a side
 * panel, which devtools or a translation panel also opens), a person may well be the one asking, so 'never' asks for
 * the owner's passkey instead of refusing: an agent cannot give it, a person can.
 */
export function ownerMayLoosen(rule: Rule | undefined): boolean {
  return !!rule && (rule.onAgent === 'mask' || rule.onAgent === 'step_up');
}
export function applyOwnerChoice(d: Decision, rule: Rule | undefined, choice: 'allow' | 'never' | null): Decision {
  if (!choice || (d.branch !== 'agent' && d.branch !== 'artifact')) return d;
  if (choice === 'allow' && !ownerMayLoosen(rule)) return d;
  const computed: Mode = choice === 'allow' ? 'allow' : d.branch === 'agent' || d.computed === 'block' ? 'block' : 'step_up';
  return { ...d, computed, decision: d.enforced ? computed : 'allow', reasonCodes: [...d.reasonCodes, choice === 'never' ? 'OWNER_DENIED' : 'OWNER_ALLOWED'] };
}
