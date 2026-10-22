// SPDX-License-Identifier: BUSL-1.1
/**
 * The AI agent permissions generator (/ai-agent-permissions-generator): every policy it can produce is one the
 * engine accepts, an action is never masked, and a visitor's own resource names cannot inject HTML.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPolicy } from '../server/policy.ts';

await import(new URL('../web/permissions-core.js', import.meta.url).href); // a browser script: it sets globalThis.OneHumanPermissions
type State = { preset: string; stance: string; mode: string; on: Set<string>; custom: Array<{ id: string; title: string; cls: string }>; edits: Record<string, string>; tab: string };
const P = (globalThis as unknown as { OneHumanPermissions: {
  CLASSES: Record<string, { act: boolean }>; RESOURCES: Array<{ id: string; cls: string }>; PRESETS: Record<string, { r: string[] }>; STANCES: Record<string, unknown>; MODES: Record<string, unknown>;
  initial: () => State; rules: (s: State) => Array<Record<string, string>>; nextAnswer: (s: State, id: string, b: string) => string | null;
  customId: (title: string, cls: string) => string | null; output: (s: State, list: unknown[]) => string; render: (s: State) => Record<string, string>;
} }).OneHumanPermissions;

test('every stance, mode and preset gives a policy the engine accepts', () => {
  for (const stance of Object.keys(P.STANCES)) for (const mode of Object.keys(P.MODES)) for (const preset of [...Object.keys(P.PRESETS), 'all']) {
    const s = { ...P.initial(), stance, mode, preset: preset === 'all' ? 'saas' : preset, tab: 'json' };
    s.on = new Set(preset === 'all' ? P.RESOURCES.map((r) => r.id) : P.PRESETS[preset]!.r);
    const parsed = checkPolicy(JSON.parse(P.output(s, P.rules(s))), 'v');
    assert.ok('policy' in parsed, `${stance}/${mode}/${preset}: ${'error' in parsed ? parsed.error : ''}`);
  }
});

test('an action is never masked, by default or by tapping', () => {
  const s = { ...P.initial(), on: new Set(P.RESOURCES.map((r) => r.id)) };
  for (const stance of Object.keys(P.STANCES)) {
    s.stance = stance;
    for (const r of P.rules(s)) if (P.CLASSES[P.RESOURCES.find((x) => x.id === r.resource)!.cls]!.act) {
      for (const b of ['onAgent', 'onArtifact', 'onUnknown']) {
        assert.notEqual(r[b], 'mask', `${stance} ${r.resource} ${b}`);
        assert.notEqual(P.nextAnswer(s, r.resource!, b), 'mask', `${stance} ${r.resource} ${b} tapped`);
      }
    }
  }
});

test('a custom resource gets a valid id and its name is escaped in the page', () => {
  const title = '<img src=x onerror=alert(1)> Invoices';
  const id = P.customId(title, 'money')!;
  assert.match(id, /^[a-z][a-z0-9_.]{1,60}$/);
  const s = P.initial(); s.custom.push({ id, title, cls: 'money' }); s.on.add(id);
  const html = Object.values(P.render(s)).join('');
  assert.ok(!html.includes('<img'), 'raw HTML from a resource name');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt; Invoices'));
  assert.equal(P.customId('!!!', 'money'), null);
});
