// SPDX-License-Identifier: BUSL-1.1
/**
 * The engine tests pin their own bank policy: the public demo's policy is product copy and changes (2026-09-28 it
 * moved from blocking agents to masking and asking the person), while these tests check how the engine enforces a
 * policy. This is the strict policy they were written against: balance and export blocked for a proven agent.
 */
import type { Policy } from '../server/policy.ts';

const ACT: Policy['rules'][number]['actOn'] = ['verified', 'strong', 'control', 'behavioral'];
const rule = (resource: string, onAgent: Policy['rules'][number]['onAgent'], onArtifact: Policy['rules'][number]['onArtifact'], onUnknown: Policy['rules'][number]['onUnknown']): Policy['rules'][number] =>
  ({ resource, title: resource, onAgent, onArtifact, onUnknown, onHumanLike: 'allow', actOn: ACT, minScore: 65 });

export const STRICT_BANK_POLICY: Policy = {
  version: 'policy-bank-strict-test',
  enforcement: 'enforce',
  rules: [rule('profile.read', 'mask', 'allow', 'allow'), rule('balance.read', 'block', 'mask', 'allow'), rule('transactions.search', 'mask', 'allow', 'allow'), rule('report.export', 'block', 'step_up', 'step_up')],
};

/** Pin the strict bank policy on an app created by createApp(). */
export function pinStrictPolicy(app: { engine: { policyForApp: ((app: string) => Policy | null) | null } }) {
  const demo = app.engine.policyForApp;
  app.engine.policyForApp = (id: string) => (id === 'bank' ? STRICT_BANK_POLICY : demo?.(id) ?? null);
}
