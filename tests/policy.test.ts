// SPDX-License-Identifier: BUSL-1.1
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POLICY, evaluate, parsePolicy } from '../server/policy.ts';
import type { Assessment } from '../server/assess.ts';

const a = (over: Partial<Assessment>): Assessment => ({ version: 'assess-v1', actor: 'unknown', score: null, tiers: [], reasons: [], metrics: { actions: 0, atomic: 0, organic: 0, untrusted: 0, keys: 0, markers: 0, focusConflicts: 0, hiddenClicks: 0, zeroPressure: 0 }, ...over });

test('unknown actor follows onUnknown, not onHumanLike', () => {
  const d = evaluate(DEFAULT_POLICY, 'report.export', a({ actor: 'unknown' }), 'd1');
  assert.equal(d.decision, 'step_up');
  assert.equal(d.branch, 'unknown');
});

test('agent with strong tier is blocked on balance', () => {
  const d = evaluate(DEFAULT_POLICY, 'balance.read', a({ actor: 'agent_likely', tiers: ['strong'], score: 90 }), 'd2');
  assert.equal(d.decision, 'block');
});

test('agent on profile is masked', () => {
  const d = evaluate(DEFAULT_POLICY, 'profile.read', a({ actor: 'agent_likely', tiers: ['behavioral'], score: 79 }), 'd3');
  assert.equal(d.decision, 'mask');
});

test('behavioral evidence below minScore falls to unknown branch', () => {
  const d = evaluate(DEFAULT_POLICY, 'balance.read', a({ actor: 'agent_likely', tiers: ['behavioral'], score: 50 }), 'd4');
  assert.equal(d.branch, 'unknown');
  assert.equal(d.decision, 'allow');
});

test('artifact-only evidence takes the onArtifact branch unless policy opts in to treat it as agent', () => {
  const art = a({ actor: 'unknown', tiers: ['artifact'], score: 60 });
  const soft = evaluate(DEFAULT_POLICY, 'balance.read', art, 'd5');
  assert.equal(soft.branch, 'artifact');
  assert.equal(soft.decision, 'mask');
  assert.equal(evaluate(DEFAULT_POLICY, 'profile.read', art, 'd5b').decision, 'allow');
  assert.equal(evaluate(DEFAULT_POLICY, 'report.export', art, 'd5c').decision, 'step_up');
  const optIn = { ...DEFAULT_POLICY, rules: DEFAULT_POLICY.rules.map((r) => ({ ...r, actOn: [...r.actOn, 'artifact' as const] })) };
  const d = evaluate(optIn, 'balance.read', art, 'd6');
  assert.equal(d.branch, 'agent');
  assert.equal(d.decision, 'block');
});

test('control tier is decisive regardless of score', () => {
  const d = evaluate(DEFAULT_POLICY, 'balance.read', a({ actor: 'agent_likely', tiers: ['control'], score: 82 }), 'd9');
  assert.equal(d.decision, 'block');
  assert.equal(d.branch, 'agent');
});

test('parsePolicy defaults onArtifact to allow for older documents', () => {
  const legacy = DEFAULT_POLICY.rules.map(({ onArtifact, ...rest }) => rest);
  const p = parsePolicy({ enforcement: 'enforce', rules: legacy }, 'v10');
  assert.equal(p?.rules[0]?.onArtifact, 'allow');
});

test('observe mode records the computed decision but allows', () => {
  const p = { ...DEFAULT_POLICY, enforcement: 'observe' as const };
  const d = evaluate(p, 'balance.read', a({ actor: 'agent_likely', tiers: ['strong'], score: 90 }), 'd7');
  assert.equal(d.decision, 'allow');
  assert.equal(d.computed, 'block');
  assert.equal(d.enforced, false);
});

test('unprotected resource is allowed and marked', () => {
  const d = evaluate(DEFAULT_POLICY, 'help.article', a({ actor: 'agent_likely', tiers: ['strong'] }), 'd8');
  assert.equal(d.branch, 'unprotected');
});

test('parsePolicy rejects malformed documents', () => {
  assert.equal(parsePolicy({ enforcement: 'enforce', rules: [] }, 'v'), null);
  assert.equal(parsePolicy({ enforcement: 'yes', rules: DEFAULT_POLICY.rules }, 'v'), null);
  assert.equal(parsePolicy({ enforcement: 'enforce', rules: [{ ...DEFAULT_POLICY.rules[0], onAgent: 'nuke' }] }, 'v'), null);
  assert.equal(parsePolicy({ enforcement: 'enforce', rules: [{ ...DEFAULT_POLICY.rules[0], onArtifact: 'nuke' }] }, 'v'), null);
  assert.equal(parsePolicy({ enforcement: 'enforce', rules: [DEFAULT_POLICY.rules[0], DEFAULT_POLICY.rules[0]] }, 'v'), null);
  const ok = parsePolicy({ enforcement: 'observe', rules: DEFAULT_POLICY.rules }, 'v9');
  assert.equal(ok?.version, 'v9');
  assert.equal(ok?.enforcement, 'observe');
});
