// SPDX-License-Identifier: BUSL-1.1
/**
 * Connecting an app from the command line: the CLI gets a code and a token, the person approves the code in the
 * portal (a new key on their account), and the CLI receives that key exactly once; declined, expired or unknown codes
 * give nothing. The key it receives licenses the app like any other.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.ts';
import { connectApp, envHasKey, writeKeyToEnv } from '../integrations/cli/connect.ts';

const app = await createApp({ labOperator: false, dogfood: false, firebase: null, chatModel: null });
await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
after(() => { app.server.close(); app.store.close(); });
const H = (cookie = '') => ({ 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}) });
const cookie = (await fetch(`${base}/api/v1/portal/signup`, { method: 'POST', headers: H(), body: JSON.stringify({ email: 'dev@shop.io', password: 'long-enough-password' }) })).headers.get('set-cookie')!.split(';')[0]!;
const start = async (name = 'shop-api') => (await fetch(`${base}/api/v1/connect/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })).json();
const poll = (token: string) => fetch(`${base}/api/v1/connect/poll`, { headers: { Authorization: `Bearer ${token}` } });

test('start, approve in the portal, the CLI gets the key once', async () => {
  const s = await start();
  assert.match(s.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.match(s.url, /\/portal\?connect=[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal((await poll(s.token)).status, 202, 'waiting');
  assert.equal((await fetch(`${base}/api/v1/portal/connect?code=${s.code}`)).status, 401, 'the portal side needs a signed-in person');
  const peek = await (await fetch(`${base}/api/v1/portal/connect?code=${s.code}`, { headers: H(cookie) })).json();
  assert.deepEqual([peek.name, peek.status], ['shop-api', 'pending']);
  const ok = await (await fetch(`${base}/api/v1/portal/connect`, { method: 'POST', headers: H(cookie), body: JSON.stringify({ code: s.code, approve: true }) })).json();
  assert.equal(ok.status, 'approved');
  const got = await (await poll(s.token)).json();
  assert.match(got.key, /^oh_live_[a-f0-9]{40}$/);
  assert.equal(got.account, 'dev@shop.io');
  assert.equal((await poll(s.token)).status, 410, 'only once');
  const keys = (await (await fetch(`${base}/api/v1/portal/me`, { headers: H(cookie) })).json()).keys;
  assert.ok(keys.some((k: { name: string; prefix: string }) => k.name === 'shop-api' && got.key.startsWith(k.prefix)), 'a key on the approving account');
  // and it is a real license
  const lic = await (await fetch(`${base}/api/v1/license`, { headers: { Authorization: `Bearer ${got.key}` } })).json();
  assert.equal(lic.mode, 'enforce');
  assert.equal((await fetch(`${base}/api/v1/portal/connect`, { method: 'POST', headers: H(cookie), body: JSON.stringify({ code: s.code, approve: true }) })).status, 404, 'a code works once');
});

test('declined, unknown and forged: nothing comes out', async () => {
  const s = await start();
  await fetch(`${base}/api/v1/portal/connect`, { method: 'POST', headers: H(cookie), body: JSON.stringify({ code: s.code, approve: false }) });
  assert.equal((await poll(s.token)).status, 410);
  assert.equal((await poll('x'.repeat(43))).status, 404);
  assert.equal((await poll('short')).status, 401);
  assert.equal((await fetch(`${base}/api/v1/portal/connect?code=AAAA-BBBB`, { headers: H(cookie) })).status, 404);
  const other = await start();
  assert.equal((await fetch(`${base}/api/v1/portal/connect`, { method: 'POST', headers: { ...H(cookie), Origin: 'https://evil.example' }, body: JSON.stringify({ code: other.code, approve: true }) })).status, 403, 'only from the portal page');
});

test('the CLI side: connectApp waits for the approval and the key lands in .env', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oh-connect-'));
  const env = join(dir, '.env');
  writeFileSync(env, 'PORT=3000\n');
  const lines: string[] = [];
  // the person approves a moment after the CLI starts waiting
  const approver = (async () => {
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const code = lines.join('\n').match(/Your code: ([A-Z2-9]{4}-[A-Z2-9]{4})/)?.[1];
      if (code) { await fetch(`${base}/api/v1/portal/connect`, { method: 'POST', headers: H(cookie), body: JSON.stringify({ code, approve: true }) }); return; }
    }
  })();
  const got = await connectApp({ name: 'cli-app', portal: base, open: false, log: (x) => lines.push(x), timeoutMs: 20_000 });
  await approver;
  assert.ok(got && /^oh_live_[a-f0-9]{40}$/.test(got.key));
  assert.ok(lines.some((l) => l.includes(`${base}/portal?connect=`)), 'the link is printed');
  assert.equal(envHasKey(env), false);
  assert.equal(writeKeyToEnv(env, got!.key), 'added');
  assert.equal(readFileSync(env, 'utf8'), `PORT=3000\nONEHUMAN_API_KEY=${got!.key}\n`);
  assert.equal(writeKeyToEnv(env, 'oh_live_' + '1'.repeat(40)), 'kept', 'an existing key stays');
  assert.equal(writeKeyToEnv(env, 'oh_live_' + '1'.repeat(40), true), 'replaced');
  assert.equal(await connectApp({ name: 'x', portal: 'http://127.0.0.1:9', open: false, log: () => {} }), null, 'no portal: nothing, and no hang');
});
