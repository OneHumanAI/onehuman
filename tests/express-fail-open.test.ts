// SPDX-License-Identifier: BUSL-1.1
/**
 * OneHuman never breaks the app it protects: a slow or failing engine lets the request go on (fail-open),
 * logged as unknown and counted in /health. Only enforce mode with failOpen:false answers 503 instead.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { onehuman } from '../integrations/express/index.ts';
import { Store, SERVER_LIMITS } from '../server/db.ts';
import { countRows } from './rows.ts';

const rule = { resource: 'balance.read', title: 'Balance', onAgent: 'block', onArtifact: 'mask', onUnknown: 'step_up', onHumanLike: 'allow', actOn: ['verified', 'strong', 'control', 'behavioral'], minScore: 65 };
const secret = 'test-secret-test-secret-test-secret-fail';

async function appWith(enforcement: 'observe' | 'enforce', extra: Record<string, unknown> = {}) {
  const oh = await onehuman({ secret, policy: { version: 't', enforcement, rules: [rule] } as never, db: 'memory', decisionTimeoutMs: 150, ...extra });
  const app = express();
  app.use(oh.middleware());
  app.get('/api/balance', oh.protect('balance.read'), (req, res) => { res.json({ balance: 10, failedOpen: req.onehuman?.failedOpen ?? null }); });
  // the app's own error handler must never be reached because of OneHuman
  app.use((_e: unknown, _req: express.Request, res: express.Response, _n: express.NextFunction) => { res.status(599).json({ appErrorHandler: true }); });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { oh, base, close: async () => { server.close(); await oh.close(); } };
}
const quiet = console.warn;
console.warn = () => {};
after(() => { console.warn = quiet; });

test('an engine that throws: the request goes on, marked failed-open, counted in health', async () => {
  const a = await appWith('enforce');
  a.oh.engine.decide = async () => { throw new Error('database is locked'); };
  const r = await fetch(`${a.base}/api/balance`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { balance: 10, failedOpen: 'ENGINE_ERROR' });
  assert.equal(r.headers.get('x-oh-decision'), 'failed-open:ENGINE_ERROR');
  const h = a.oh.health().failOpen;
  assert.equal(h.count, 1); assert.equal(h.lastReason, 'ENGINE_ERROR'); assert.equal(h.lastError, 'database is locked');
  await a.close();
});

test('an engine slower than the timeout: the request goes on within the timeout, and the late answer is ignored', async () => {
  const a = await appWith('observe');
  const real = a.oh.engine.decide.bind(a.oh.engine);
  a.oh.engine.decide = async (x) => { await new Promise((r) => setTimeout(r, 600)); return real(x); };
  const t0 = Date.now();
  const r = await fetch(`${a.base}/api/balance`);
  const took = Date.now() - t0;
  assert.equal(r.status, 200);
  assert.equal((await r.json()).failedOpen, 'ENGINE_TIMEOUT');
  assert.ok(took < 500, `answered in ${took} ms`);
  await new Promise((r) => setTimeout(r, 700));   // the late decision arrives after the response: nothing breaks
  assert.equal(a.oh.health().failOpen.lastReason, 'ENGINE_TIMEOUT');
  await a.close();
});

test('enforce mode with failOpen:false answers 503 instead of serving without a decision; observe ignores it', async () => {
  const strict = await appWith('enforce', { failOpen: false });
  strict.oh.engine.decide = async () => { throw new Error('boom'); };
  const r = await fetch(`${strict.base}/api/balance`);
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, 'onehuman_unavailable');
  await strict.close();
  const watch = await appWith('observe', { failOpen: false });
  watch.oh.engine.decide = async () => { throw new Error('boom'); };
  assert.equal((await fetch(`${watch.base}/api/balance`)).status, 200, 'observe mode never blocks');
  await watch.close();
});

test('a healthy engine still decides normally (no false fail-open)', async () => {
  const a = await appWith('enforce');
  const r = await fetch(`${a.base}/api/balance`);
  assert.equal(r.status, 428, 'unknown visitor, enforce: passkey asked');
  assert.equal(a.oh.health().failOpen.count, 0);
  await a.close();
});

test("the customer's server has no visitor cap and keeps events per session, not per room", async () => {
  const store = await Store.open(undefined, { limits: SERVER_LIMITS });
  const room = 'room-1';
  await store.ensureRoom(room, 'tenant:t');
  for (let i = 0; i < 450; i++) assert.ok(await store.createSession(room, 'unlabelled', null), `session ${i + 1} opened`);
  const [a, b] = [await store.createSession(room, 'unlabelled', null), await store.createSession(room, 'unlabelled', null)];
  for (let i = 0; i < 320; i++) await store.addEvent(room, a!, 'signal', { i });
  await store.addEvent(room, b!, 'signal', { only: true });
  const count = (s: string) => countRows(store, 'events', 'session', s);
  assert.equal(await count(a!), SERVER_LIMITS.eventsPerSession, 'a busy session keeps its newest events');
  assert.equal(await count(b!), 1, "another visitor's events are untouched");
  store.close();
});

test('if OneHuman cannot start, the app still answers; failOpen: false answers 503', async () => {
  const { onehumanDeferred } = await import('../integrations/express/index.ts');
  const bad = { version: 'x', enforcement: 'enforce', rules: [rule, rule] } as never;   // the same resource twice
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };
  try {
    for (const [failOpen, expect] of [[undefined, 200], [false, 503]] as const) {
      const oh = onehumanDeferred({ secret, policy: bad, db: 'memory', ...(failOpen === false ? { failOpen } : {}) });
      const app = express();
      app.use(oh.middleware());
      app.get('/api/balance', oh.protect('balance.read'), (_req, res) => { res.json({ amount: 5 }); });
      app.get('/free', (_req, res) => { res.send('ok'); });
      const server = app.listen(0);
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const r = await fetch(`${base}/api/balance`);
      assert.equal(r.status, expect);
      if (expect === 200) assert.equal(r.headers.get('x-oh-decision'), 'failed-open:ENGINE_START_FAILED');
      assert.equal((await fetch(`${base}/free`)).status, 200, 'unprotected routes are untouched');
      assert.equal((await fetch(`${base}/onehuman/sdk.js`)).status, 503);
      server.close();
    }
  } finally { console.error = origError; }
  assert.ok(errors.some((e) => /could not start — .*"balance\.read" appears twice/.test(e)), 'the reason is logged');
});
