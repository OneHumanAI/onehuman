// SPDX-License-Identifier: BUSL-1.1
/**
 * Sign-in through Firebase: the ID token is checked here against Google's keys, and POST /api/v1/portal/session turns
 * it into a portal session — a new address is a sign-up with its welcome mail, an old account is found again, and an
 * address someone else already holds is never taken over by an unverified sign-in.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { createApp } from '../server/app.ts';
import { verifyFirebaseToken, resetFirebaseKeys, type FirebaseUser } from '../server/firebase-auth.ts';
import type { Outgoing, Transport } from '../server/mail.ts';
import { hashPassword } from '../server/routes/portal.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const keysFetch = (async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'cache-control': 'public, max-age=600' } })) as unknown as typeof fetch;
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256', kid: 'k1' }) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64(header)}.${b64({ aud: 'proj', iss: 'https://securetoken.google.com/proj', sub: 'u1', iat: now, exp: now + 3600, auth_time: now, email: 'a@acme.io', email_verified: true, firebase: { sign_in_provider: 'google.com' }, ...claims })}`;
  return `${body}.${createSign('RSA-SHA256').update(body).sign(privateKey).toString('base64url')}`;
}

test('a Firebase ID token is accepted only when Google signed it for this project, and it is current', async () => {
  resetFirebaseKeys();
  const v = (t: string) => verifyFirebaseToken(t, 'proj', { fetchImpl: keysFetch });
  assert.deepEqual(await v(token({ email: 'A@Acme.io' })), { uid: 'u1', email: 'a@acme.io', emailVerified: true, provider: 'google.com' });
  for (const [why, t] of [
    ['another project', token({ aud: 'other' })], ['another issuer', token({ iss: 'https://securetoken.google.com/other' })],
    ['expired', token({ exp: Math.floor(Date.now() / 1000) - 1 })], ['no subject', token({ sub: '' })], ['no e-mail', token({ email: '' })],
    ['unknown key', token({}, { alg: 'RS256', kid: 'k9' })], ['not RS256', token({}, { alg: 'HS256', kid: 'k1' })],
    ['edited claims', (() => { const [h, , s] = token({}).split('.'); return `${h}.${b64({ sub: 'admin' })}.${s}`; })()],
  ] as const) await assert.rejects(v(t), Error, why);
});

test('POST /api/v1/portal/session: sign-up, sign-in again, an account from before, and no takeover', async () => {
  const sent: Outgoing[] = [];
  const transport: Transport = { name: 'fake', async send(m) { sent.push(m); return { id: 'x' }; } };
  const users = new Map<string, FirebaseUser>();
  const app = await createApp({ labOperator: false, mailTransport: transport, dogfood: false, firebase: { projectId: 'proj', verify: async (t) => { const u = users.get(t); if (!u) throw new Error('bad'); return u; } } });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  after(() => { app.server.close(); app.store.close(); });
  const H = { 'Content-Type': 'application/json', Origin: base };
  const session = (idToken: string, source?: string) => fetch(`${base}/api/v1/portal/session`, { method: 'POST', headers: H, body: JSON.stringify({ idToken, source }) });

  // a new address: an account, the report starts, the welcome mail goes out, and the cookie opens the portal
  users.set('t-new', { uid: 'fb-1', email: 'cto@startup.io', emailVerified: true, provider: 'google.com' });
  let r = await session('t-new', 'report');
  assert.equal(r.status, 201);
  const cookie = r.headers.get('set-cookie')!.split(';')[0]!;
  assert.equal((await (await fetch(`${base}/api/v1/portal/me`, { headers: { Cookie: cookie } })).json()).account.email, 'cto@startup.io');
  assert.equal(sent.length, 1); assert.equal(sent[0]!.kind, 'welcome');
  assert.equal((await app.store.accountMeta((await app.store.accountByEmail('cto@startup.io'))!.id))?.source, 'report');
  // the same Firebase user again: the same account, no second welcome
  r = await session('t-new');
  assert.equal(r.status, 200); assert.equal(sent.length, 1);

  // an account from before Firebase, copied over with its id as the Firebase user id
  const old = (await app.store.createAccount('owner@shop.io', hashPassword('longenough1')))!;
  users.set('t-old', { uid: old, email: 'owner@shop.io', emailVerified: false, provider: 'password' });
  r = await session('t-old');
  assert.equal(r.status, 200); assert.equal((await r.json()).account.email, 'owner@shop.io');

  // someone signs up with an address that already has an account: unverified, refused; verified (Google), joined
  const held = (await app.store.createAccount('cfo@bank.io', hashPassword('longenough1')))!;
  users.set('t-squat', { uid: 'fb-2', email: 'cfo@bank.io', emailVerified: false, provider: 'password' });
  assert.equal((await session('t-squat')).status, 409);
  users.set('t-google', { uid: 'fb-3', email: 'cfo@bank.io', emailVerified: true, provider: 'google.com' });
  r = await session('t-google');
  assert.equal(r.status, 200);
  assert.equal((await app.store.accountByFirebaseUid('fb-3'))?.id, held);

  // a token that does not check out opens nothing; the password routes are closed while Firebase signs people in
  assert.equal((await session('forged')).status, 401);
  assert.equal((await fetch(`${base}/api/v1/portal/login`, { method: 'POST', headers: H, body: JSON.stringify({ email: 'owner@shop.io', password: 'longenough1' }) })).status, 410);
  assert.equal((await fetch(`${base}/api/v1/portal/signup`, { method: 'POST', headers: H, body: JSON.stringify({ email: 'x@y.io', password: 'longenough1' }) })).status, 410);
  assert.equal((await fetch(`${base}/api/v1/portal/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' })).status, 403);
});
