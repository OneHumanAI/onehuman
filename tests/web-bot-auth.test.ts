// SPDX-License-Identifier: BUSL-1.1
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KNOWN_OPERATORS, signRequest, verifyWebBotAuth, type OperatorKey } from '../server/web-bot-auth.ts';

const operator = 'https://test-operator.example';
KNOWN_OPERATORS[operator] = 'memory://test';

async function keys() {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as OperatorKey;
  const publicJwk: OperatorKey = { kty: 'OKP', crv: 'Ed25519', x: jwk.x, kid: 'k1' };
  return { pair, publicJwk, loader: async () => [publicJwk] };
}
const req = (headers: Record<string, string>, url = 'https://lab.example/api/v1/account/balance') => ({ method: 'GET', url, headers: new Headers(headers) });

test('absent headers → absent', async () => {
  const r = await verifyWebBotAuth(req({}));
  assert.equal(r.status, 'absent');
});

test('valid signature → verified; same nonce → replay', async () => {
  const k = await keys();
  const seen = new Set<string>();
  const consumeNonce = (key: string) => (seen.has(key) ? false : (seen.add(key), true));
  const h = await signRequest(k.pair.privateKey, k.publicJwk, req({}), operator, { nonce: 'n1' });
  const first = await verifyWebBotAuth(req(h), { keyLoader: k.loader, consumeNonce });
  assert.equal(first.status, 'verified');
  assert.equal(first.operator, operator);
  const second = await verifyWebBotAuth(req(h), { keyLoader: k.loader, consumeNonce });
  assert.equal(second.status, 'replay');
});

test('tampered signature → invalid', async () => {
  const k = await keys();
  const h = await signRequest(k.pair.privateKey, k.publicJwk, req({}), operator);
  const bad = { ...h, signature: h.signature!.replace(/:([A-Za-z0-9+/])/, (_m, c) => `:${c === 'A' ? 'B' : 'A'}`) };
  const r = await verifyWebBotAuth(req(bad), { keyLoader: k.loader });
  assert.equal(r.status, 'invalid');
});

test('wrong authority → invalid', async () => {
  const k = await keys();
  const h = await signRequest(k.pair.privateKey, k.publicJwk, req({}, 'https://other.example/x'), operator);
  const r = await verifyWebBotAuth(req(h), { keyLoader: k.loader });
  assert.equal(r.status, 'invalid');
});

test('stale and long-lived windows → invalid', async () => {
  const k = await keys();
  const now = Math.floor(Date.now() / 1000);
  const stale = await signRequest(k.pair.privateKey, k.publicJwk, req({}), operator, { created: now - 1000, expires: now - 900 });
  assert.equal((await verifyWebBotAuth(req(stale), { keyLoader: k.loader })).status, 'invalid');
  const long = await signRequest(k.pair.privateKey, k.publicJwk, req({}), operator, { created: now, expires: now + 3600 });
  assert.equal((await verifyWebBotAuth(req(long), { keyLoader: k.loader })).status, 'invalid');
});

test('unknown operator is never fetched or verified', async () => {
  const k = await keys();
  const h = await signRequest(k.pair.privateKey, k.publicJwk, req({}), 'https://evil.example');
  let fetched = false;
  const r = await verifyWebBotAuth(req(h), { keyLoader: async () => { fetched = true; return [k.publicJwk]; } });
  assert.equal(r.status, 'unsupported');
  assert.equal(fetched, false);
});

test('signature without @authority → invalid', async () => {
  const k = await keys();
  const h = await signRequest(k.pair.privateKey, k.publicJwk, req({}), operator, { components: ['@method'] });
  assert.equal((await verifyWebBotAuth(req(h), { keyLoader: k.loader })).status, 'invalid');
});

test('key directory unavailable → unavailable, not verified', async () => {
  const k = await keys();
  const h = await signRequest(k.pair.privateKey, k.publicJwk, req({}), operator);
  const r = await verifyWebBotAuth(req(h), { keyLoader: async () => { throw new Error('down'); } });
  assert.equal(r.status, 'unavailable');
});
