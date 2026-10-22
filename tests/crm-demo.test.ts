// SPDX-License-Identifier: BUSL-1.1
/** The /crm demo: the rules the page promises, and synthetic data only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APPS } from '../server/apps.ts';

const crm = APPS.crm!;
const rule = (id: string) => crm.policy.rules.find((r) => r.resource === id)!;
const res = (id: string) => crm.resources.find((r) => r.id === id)!;

test('CRM rules: contacts are masked for an agent, edits are open, the export waits for the person', () => {
  assert.equal(rule('contacts.read').onAgent, 'mask');
  assert.equal(rule('contacts.read').onHumanLike, 'allow');
  for (const id of ['deals.update', 'notes.create']) assert.deepEqual([rule(id).onAgent, rule(id).onUnknown, rule(id).onHumanLike], ['allow', 'allow', 'allow']);
  assert.deepEqual([rule('contacts.export').onAgent, rule('contacts.export').onUnknown, rule('contacts.export').onHumanLike], ['step_up', 'step_up', 'allow']);
});

test('CRM contacts: the agent keeps names, companies, values and stages but loses e-mails and phones', () => {
  const { full, masked } = res('contacts.read').data('s1', '', {}) as { full: { rows: Record<string, unknown>[] }; masked: { rows: Record<string, unknown>[] } };
  assert.equal(full.rows.length, 8);
  full.rows.forEach((row, i) => {
    const m = masked.rows[i]!;
    for (const k of ['name', 'company', 'value', 'stage']) assert.equal(m[k], row[k]);
    assert.match(String(row.email), /@example\.com$/);
    assert.match(String(row.phone), /\(555\)/);
    assert.match(String(m.email), /^•+$/);
    assert.match(String(m.phone), /^•+$/);
  });
});

test('CRM export holds all 2,431 synthetic contacts', () => {
  const file = res('contacts.export').file!('s1');
  const lines = file.body.replace(/^﻿/, '').split('\n');
  assert.equal(lines.length, 2432);
  assert.ok(lines.slice(1).every((l) => l.includes('@example.com"') && l.includes('(555)')));
});
