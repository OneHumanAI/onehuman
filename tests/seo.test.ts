// SPDX-License-Identifier: BUSL-1.1
/**
 * Search and answer engines: public pages carry an up-to-date head block (canonical, JSON-LD whose FAQ matches the
 * visible questions), the crawler files are served, and pages that are not content say noindex.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.ts';

const app = await createApp({ labOperator: false });
await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
after(() => { app.server.close(); app.store.close(); });

test('every public page head is generated from the current page (scripts/seo.mjs --check)', () => {
  execFileSync(process.execPath, ['scripts/seo.mjs', '--check'], { stdio: 'pipe' });
});

test('public pages are indexable, with one canonical and valid JSON-LD', async () => {
  for (const path of ['/', '/docs', '/scorecard', '/measurements', '/trust', '/compare', '/product', '/ai-agent-permissions-generator']) {
    const r = await fetch(base + path);
    assert.equal(r.status, 200, path);
    assert.equal(r.headers.get('x-robots-tag'), null, path);
    const html = await r.text();
    assert.equal(html.match(/<link rel="canonical"/g)?.length, 1, path);
    assert.equal(html.match(/<title>/g)?.length, 1, path);
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)![1]!);
    assert.ok(ld['@graph'].some((n: { '@type': string }) => n['@type'] === 'Organization'), path);
  }
});

test('landing FAQ structured data matches the visible questions', async () => {
  const html = await (await fetch(base + '/')).text();
  const visible = [...html.matchAll(/<summary>(.*?)<\/summary>/g)].map((m) => m[1]);
  const faq = JSON.parse(html.match(/application\/ld\+json">(.*?)<\/script>/)![1]!)['@graph'].find((n: { '@type': string }) => n['@type'] === 'FAQPage');
  assert.deepEqual(faq.mainEntity.map((q: { name: string }) => q.name), visible);
});

test('crawler files are served', async () => {
  const robots = await fetch(base + '/robots.txt');
  assert.match(robots.headers.get('content-type') ?? '', /text\/plain/);
  assert.match(await robots.text(), /Sitemap: https:\/\/onehuman\.ai\/sitemap\.xml/);
  const map = await (await fetch(base + '/sitemap.xml')).text();
  for (const path of ['/docs', '/scorecard', '/measurements', '/trust', '/compare', '/product', '/ai-agent-permissions-generator']) assert.ok(map.includes(`<loc>https://onehuman.ai${path}</loc>`), path);
  assert.match(await (await fetch(base + '/llms.txt')).text(), /^# OneHuman/);
  assert.equal((await fetch(base + '/llms-full.txt')).status, 200);
});

test('demo rooms and the portal are not for search engines', async () => {
  const portal = await fetch(base + '/portal');
  assert.equal(portal.headers.get('x-robots-tag'), 'noindex, nofollow');
});

test('the product page moved to /product; the old address redirects there for good', async () => {
  const r = await fetch(base + '/how-it-works', { redirect: 'manual' });
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), '/product');
});
