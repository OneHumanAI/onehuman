// SPDX-License-Identifier: BUSL-1.1
/**
 * WebAuthn verification with a software authenticator (P-256): registration and assertion checks of the server-side
 * verifier. The flows built on it (reclaim, approve, the owner's control) run end to end in the lab tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAssertion, verifyRegistration, type StoredCredential } from '../server/webauthn.ts';
import { SoftAuthenticator } from './soft-authenticator.ts';

const RP = { rpId: 'lab.example', origin: 'https://lab.example' };

test('registration parses COSE key, requires UP+UV, binds challenge/origin/rpId', () => {
  const a = new SoftAuthenticator();
  const cred = verifyRegistration(a.register('ch1', RP.origin, RP.rpId), { challenge: 'ch1', ...RP });
  assert.equal(cred.alg, -7);
  assert.equal((cred.publicKeyJwk as { kty: string }).kty, 'EC');
  assert.throws(() => verifyRegistration(a.register('ch1', RP.origin, RP.rpId), { challenge: 'other', ...RP }), /challenge/);
  assert.throws(() => verifyRegistration(a.register('ch1', 'https://evil.example', RP.rpId), { challenge: 'ch1', ...RP }), /origin/);
  assert.throws(() => verifyRegistration(a.register('ch1', RP.origin, 'other.example'), { challenge: 'ch1', ...RP }), /rpIdHash/);
  assert.throws(() => verifyRegistration(a.register('ch1', RP.origin, RP.rpId, 0x41), { challenge: 'ch1', ...RP }), /not verified/);
});

test('assertion verifies signature, UV flag, counter, and rejects tampering', () => {
  const a = new SoftAuthenticator();
  const cred: StoredCredential = verifyRegistration(a.register('ch1', RP.origin, RP.rpId), { challenge: 'ch1', ...RP });
  const ok = verifyAssertion(a.assert('ch2', RP.origin, RP.rpId), cred, { challenge: 'ch2', ...RP });
  assert.equal(ok.ok, true);
  if (ok.ok) { assert.equal(ok.newSignCount, 1); cred.signCount = ok.newSignCount; }
  // UV missing (only UP) → rejected: a click on the authenticator without biometrics/PIN is not enough
  assert.match((verifyAssertion(a.assert('ch3', RP.origin, RP.rpId, 0x01), cred, { challenge: 'ch3', ...RP }) as { reason: string }).reason, /not verified/);
  // replayed counter → rejected
  const replay = a.assert('ch4', RP.origin, RP.rpId); a.counter = 0;
  const r1 = verifyAssertion(replay, cred, { challenge: 'ch4', ...RP }); assert.equal(r1.ok, true); if (r1.ok) cred.signCount = r1.newSignCount;
  a.counter = 1; // authenticator counter rewound below stored value
  assert.match((verifyAssertion(a.assert('ch5', RP.origin, RP.rpId), cred, { challenge: 'ch5', ...RP }) as { reason: string }).reason, /sign count/);
  // wrong origin, wrong challenge, other key
  a.counter = 50;
  assert.match((verifyAssertion(a.assert('ch6', 'https://evil.example', RP.rpId), cred, { challenge: 'ch6', ...RP }) as { reason: string }).reason, /origin/);
  assert.match((verifyAssertion(a.assert('ch7', RP.origin, RP.rpId), cred, { challenge: 'nope', ...RP }) as { reason: string }).reason, /challenge/);
  const b = new SoftAuthenticator(); b.credId = a.credId; b.counter = 60;
  assert.match((verifyAssertion(b.assert('ch8', RP.origin, RP.rpId), cred, { challenge: 'ch8', ...RP }) as { reason: string }).reason, /bad signature/);
});
