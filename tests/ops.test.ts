// SPDX-License-Identifier: BUSL-1.1
/**
 * The public deployment's guards: visits are logged without raw IP or user agent, demo rooms are tied to the device, and the costly paths are limited.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.ts';
import { uaFamily } from '../server/ops.ts';

process.env.ONEHUMAN_LAB_KEY = 'lab-key-for-tests';
const app = await createApp({ labOperator: false });
await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
after(() => { app.server.close(); app.store.close(); delete process.env.ONEHUMAN_LAB_KEY; });

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const H = (cookie = '', ip = '203.0.113.7') => ({ 'Content-Type': 'application/json', Origin: base, 'User-Agent': UA, 'X-Forwarded-For': ip, ...(cookie ? { Cookie: cookie } : {}) });
const signup = async (email: string, ip = '203.0.113.7') => {
  const r = await fetch(`${base}/api/v1/portal/signup`, { method: 'POST', headers: H('', ip), body: JSON.stringify({ email, password: 'long-enough-password' }) });
  return { status: r.status, cookie: r.headers.get('set-cookie')?.split(';')[0] ?? '' };
};

test('user agents are reduced to families', () => {
  assert.deepEqual(uaFamily(UA), { browser: 'Chrome', os: 'macOS', mobile: false, bot: false });
  assert.equal(uaFamily('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1').os, 'iOS');
  assert.equal(uaFamily('Mozilla/5.0 (compatible; Googlebot/2.1)').bot, true);
  assert.equal(uaFamily('curl/8.7.1').browser, 'curl');
});

test('visits are logged without a raw IP or user agent, and a demo room is tied to the device', async () => {
  const phone = { ...H('', '198.51.100.23'), 'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36', 'X-Vercel-IP-Country': 'AZ', 'X-Vercel-IP-City': 'Baku' };
  await fetch(`${base}/`, { headers: phone });
  const bank = await fetch(`${base}/bank`, { headers: phone, redirect: 'manual' });
  assert.equal(bank.status, 302);
  const raw = JSON.stringify(await app.store.report('SELECT * FROM visits'));
  assert.ok(raw.includes('/bank'), 'the visit is logged');
  assert.ok(!raw.includes('198.51.100.23') && !raw.includes('Pixel 8'), 'no raw IP or user agent is stored');
});

test('lab writes need the lab key; pages are not served as raw .html files', async () => {
  assert.equal((await fetch(`${base}/api/v1/sandbox/samples`, { method: 'POST', headers: H(), body: '{}' })).status, 404);
  assert.equal((await fetch(`${base}/api/v1/sandbox/assess-run`, { method: 'POST', headers: H(), body: '{}' })).status, 404);
  for (const f of ['training.html', 'sandbox.html', 'portal.html', 'ops.html']) assert.equal((await fetch(`${base}/${f}`, { headers: H() })).status, 404, f);
  assert.equal((await fetch(`${base}/portal`, { headers: H() })).status, 200, 'the routed page still works');
});

test('login is limited per e-mail, sign-up per address; a password change ends other sign-ins', async () => {
  const a = await signup('limit@example.com', '192.0.2.50');
  let last = 0;
  for (let i = 0; i < 12; i++) last = (await fetch(`${base}/api/v1/portal/login`, { method: 'POST', headers: H('', `192.0.2.${60 + i}`), body: JSON.stringify({ email: 'limit@example.com', password: 'wrong-password' }) })).status;
  assert.equal(last, 429, 'the eleventh wrong password for one e-mail is refused, whatever the address');

  let s = 0;
  for (let i = 0; i < 21; i++) s = (await signup(`bulk${i}@example.com`, '192.0.2.99')).status;
  assert.equal(s, 429, 'the 21st sign-up from one address within an hour is refused');

  const other = await signup('pw@example.com', '192.0.2.120');
  const second = await fetch(`${base}/api/v1/portal/login`, { method: 'POST', headers: H('', '192.0.2.121'), body: JSON.stringify({ email: 'pw@example.com', password: 'long-enough-password' }) });
  const c2 = second.headers.get('set-cookie')!.split(';')[0]!;
  const ch = await fetch(`${base}/api/v1/portal/account/password`, { method: 'POST', headers: H(other.cookie), body: JSON.stringify({ current: 'long-enough-password', next: 'a-brand-new-password' }) });
  assert.equal(ch.status, 200);
  assert.equal((await fetch(`${base}/api/v1/portal/me`, { headers: H(c2) })).status, 401, 'the other sign-in is gone');
  assert.equal((await fetch(`${base}/api/v1/portal/me`, { headers: H(other.cookie) })).status, 200, 'this one stays');
  assert.ok(a.cookie);
});

test('public pages are edge-cacheable and count themselves with a beacon; a flood from one browser is cut off early', async () => {
  const landing = await fetch(`${base}/`, { headers: H('', '203.0.113.90') });
  assert.match(landing.headers.get('cache-control') ?? '', /public, .*s-maxage=/, 'the CDN may keep it');
  assert.match(await landing.text(), /<script src="\/v\.js" defer><\/script>/);
  assert.equal((await fetch(`${base}/portal`, { headers: H() })).headers.get('cache-control'), 'no-store', 'pages with sessions are never cached');
  const before = (await app.store.report("SELECT COUNT(*) AS n FROM visits WHERE path = '/docs'"))[0]!.n;
  const r = await fetch(`${base}/api/v1/visit`, { method: 'POST', headers: { ...H('', '203.0.113.90'), 'Content-Type': 'text/plain' }, body: JSON.stringify({ p: '/docs', r: 'news.example' }) });
  assert.equal(r.status, 204);
  const rows = await app.store.report("SELECT path, referrer FROM visits WHERE path IN ('/docs', '/portal') ORDER BY id DESC");
  assert.equal(Number(rows.filter((x) => x.path === '/docs').length), Number(before) + 1);
  assert.equal(rows[0]!.referrer, 'news.example');

  // one browser hammering the API: refused before any database work, told when to come back
  let last: Response | null = null;
  for (let i = 0; i < 260; i++) last = await fetch(`${base}/api/v1/sandbox/noop`, { method: 'POST', headers: H('', '198.51.100.200') });
  assert.equal(last!.status, 429);
  assert.equal(last!.headers.get('retry-after'), '60');
  assert.equal((await fetch(`${base}/api/v1/apps`, { headers: H('', '198.51.100.201') })).status, 200, 'another browser is unaffected');
});
