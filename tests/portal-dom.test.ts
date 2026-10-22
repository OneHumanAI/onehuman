/*
 * Copyright 2026 OneHuman Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('portal markup contains every element bound during script startup', async () => {
  const html = await readFile(new URL('../web/portal.html', import.meta.url), 'utf8');
  for (const id of ['pol-import', 'pol-import-go', 'pol-import-text', 'pol-import-msg', 'agent-fab', 'ov-empty', 'policy-src']) {
    assert.match(html, new RegExp(`\\bid=["']${id}["']`), `missing #${id}`);
  }
});

test('portal exposes one grouped workspace sidebar without duplicate links', async () => {
  const html = await readFile(new URL('../web/portal.html', import.meta.url), 'utf8');
  for (const group of ['Monitor', 'Protect', 'Developers']) {
    assert.match(html, new RegExp(`<summary>${group}<`), `missing ${group} group`);
  }
  for (const [hash, view] of Object.entries({
    overview: 'overview', agents: 'agents', activity: 'activity', weekly: 'weekly',
    policy: 'policy', keys: 'keys', integrate: 'integrate', plan: 'plan', settings: 'settings',
  })) {
    const links = html.match(new RegExp(`href="#${hash}"\\s+data-view="${view}"`, 'g')) ?? [];
    assert.equal(links.length, 1, `expected one ${view} navigation link`);
  }
});
