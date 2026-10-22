// SPDX-License-Identifier: BUSL-1.1
/** The portal on its own host (ONEHUMAN_APP_URL): "/" there is the portal, the site's /portal sends people there. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.ts';

process.env.ONEHUMAN_APP_URL = 'https://app.onehuman.ai';
const app = await createApp({ labOperator: false, dogfood: false, firebase: null, chatModel: null });
await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
const port = (app.server.address() as AddressInfo).port;
after(() => { app.server.close(); app.store.close(); delete process.env.ONEHUMAN_APP_URL; });

const get = (host: string, path: string, method = 'GET', body?: string) => new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }>((resolve, reject) => {
  const r = request({ host: '127.0.0.1', port, path, method, headers: { Host: host, ...(body ? { 'Content-Type': 'application/json', Origin: `https://${host}`, 'X-Forwarded-Proto': 'https' } : {}) } }, (res) => {
    let text = ''; res.on('data', (c) => (text += c)); res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text }));
  });
  r.on('error', reject); if (body) r.write(body); r.end();
});

test('the site sends /portal to the app host, keeping the query', async () => {
  const r = await get('onehuman.ai', '/portal?connect=ABCD-EFGH');
  assert.equal(r.status, 301);
  assert.equal(r.headers.location, 'https://app.onehuman.ai/?connect=ABCD-EFGH');
});

test('on the app host "/" is the portal, /portal goes to "/", and public pages go back to the site', async () => {
  const home = await get('app.onehuman.ai', '/');
  assert.equal(home.status, 200);
  assert.match(home.text, /id="auth"/, 'the portal page');
  assert.match(String(home.headers['x-robots-tag']), /noindex/);
  const old = await get('app.onehuman.ai', '/portal?invite=x');
  assert.equal(old.status, 301); assert.equal(old.headers.location, '/?invite=x');
  const pricing = await get('app.onehuman.ai', '/pricing');
  assert.equal(pricing.status, 301); assert.equal(pricing.headers.location, 'https://onehuman.ai/pricing');
  assert.equal((await get('app.onehuman.ai', '/portal.js')).status, 200, 'the portal\'s own files are served');
});

test('the site itself is unchanged, and the sign-in cookie is shared with the site', async () => {
  const site = await get('onehuman.ai', '/');
  assert.equal(site.status, 200);
  assert.ok(!/id="auth"/.test(site.text));
  const r = await get('app.onehuman.ai', '/api/v1/portal/signup', 'POST', JSON.stringify({ email: 'host@test.io', password: 'long-enough-password' }));
  assert.equal(r.status, 201, r.text);
  assert.match(String(r.headers['set-cookie']), /oh_portal=[^;]+;.*Domain=onehuman\.ai/);
});
