// SPDX-License-Identifier: BUSL-1.1
/**
 * A key's statistics shared with another account: the owner invites an address, the invitation mail carries a link
 * that works once, for that address only; the invited account then reads the key's figures and changes nothing, and
 * the owner can take it back.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.ts';
import type { Outgoing, Transport } from '../server/mail.ts';

test('share a key: invite by e-mail, accept once, read only, take it back', async () => {
  const sent: Outgoing[] = [];
  const transport: Transport = { name: 'fake', async send(m) { sent.push(m); return { id: `m${sent.length}` }; } };
  const app = await createApp({ labOperator: false, mailTransport: transport, dogfood: false, firebase: null });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  after(() => { app.server.close(); app.store.close(); });

  const signup = async (email: string) => {
    const r = await fetch(`${base}/api/v1/portal/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ email, password: 'longenough1' }) });
    assert.equal(r.status, 201);
    return r.headers.get('set-cookie')!.split(';')[0]!;
  };
  const call = (cookie: string, path: string, body?: unknown) => fetch(`${base}${path}`, body === undefined
    ? { headers: { Cookie: cookie } }
    : { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie }, body: JSON.stringify(body) });

  const owner = await signup('cto@acme.io');
  const guest = await signup('cfo@acme.io');
  const stranger = await signup('eve@other.io');
  const key = await (await call(owner, '/api/v1/portal/keys', { name: 'Acme Billing' })).json();
  sent.length = 0;

  // only the owner shares; not with themselves; the invitation goes out by mail with a link
  assert.equal((await call(guest, '/api/v1/portal/keys/share', { key: key.id, email: 'cfo@acme.io' })).status, 404);
  assert.equal((await call(owner, '/api/v1/portal/keys/share', { key: key.id, email: 'cto@acme.io' })).status, 400);
  assert.equal((await call(owner, '/api/v1/portal/keys/share', { key: key.id, email: 'not an address' })).status, 400);
  let r = await call(owner, '/api/v1/portal/keys/share', { key: key.id, email: 'CFO@acme.io', role: 'viewer' });
  assert.equal(r.status, 201);
  const shared = await r.json();
  assert.equal(shared.mailed, 'sent'); assert.equal(shared.email, 'cfo@acme.io');
  assert.equal(sent.length, 1);
  const mail = sent[0]!;
  assert.equal(mail.kind, 'invite'); assert.equal(mail.to, 'cfo@acme.io');
  assert.match(mail.subject, /cto@acme\.io shared OneHuman statistics/);
  assert.ok(mail.html.includes('Acme Billing') && mail.text.includes(shared.link), 'the mail names the app and carries the link');
  assert.equal(mail.unsubscribePost, '', 'a one-off invitation has no stop link');
  const token = new URL(shared.link).searchParams.get('invite')!;

  // the owner sees the pending invitation
  let access = await (await call(owner, `/api/v1/portal/keys/access?key=${key.id}`)).json();
  assert.deepEqual(access.invites.map((i: { email: string }) => i.email), ['cfo@acme.io']);
  assert.equal(access.members.length, 0);
  assert.equal((await call(guest, `/api/v1/portal/keys/access?key=${key.id}`)).status, 404);

  // before sign-in the link says who shared what; no one else can use it; then it opens once
  const peek = await (await fetch(`${base}/api/v1/portal/invites/peek?token=${token}`)).json();
  assert.deepEqual([peek.email, peek.inviter, peek.app, peek.state], ['cfo@acme.io', 'cto@acme.io', 'Acme Billing', 'open']);
  assert.equal((await call(guest, `/api/v1/portal/stats?key=${key.id}`)).status, 404, 'nothing before accepting');
  assert.equal((await call(stranger, '/api/v1/portal/invites/accept', { token })).status, 403, 'a forwarded link does not open for another address');
  assert.equal((await call(guest, '/api/v1/portal/invites/accept', { token: 'x'.repeat(32) })).status, 404);
  r = await call(guest, '/api/v1/portal/invites/accept', { token });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).key, key.id);
  assert.equal((await call(guest, '/api/v1/portal/invites/accept', { token })).status, 410, 'once');

  // the guest reads: the key is in their list as shared, with its figures, log, weekly and 30-day report
  const me = await (await call(guest, '/api/v1/portal/me')).json();
  const k = me.keys.find((x: { id: string }) => x.id === key.id);
  assert.deepEqual([k.role, k.owner, k.name], ['viewer', 'cto@acme.io', 'Acme Billing']);
  for (const path of [`/api/v1/portal/stats?key=${key.id}`, `/api/v1/portal/events?key=${key.id}`, `/api/v1/portal/health?key=${key.id}`, `/api/v1/portal/weekly?key=${key.id}`, `/api/v1/portal/report?key=${key.id}`, '/api/v1/portal/overview', '/api/v1/portal/agents']) {
    assert.equal((await call(guest, path)).status, 200, path);
  }
  assert.equal((await (await call(guest, `/api/v1/portal/report?key=${key.id}`)).json()).app, 'Acme Billing');
  assert.ok((await (await call(guest, '/api/v1/portal/overview')).json()).keys.some((x: { id: string }) => x.id === key.id));
  // … and changes nothing
  await call(guest, '/api/v1/portal/keys/rename', { id: key.id, name: 'mine now' });
  await call(guest, '/api/v1/portal/keys/revoke', { id: key.id });
  await call(guest, '/api/v1/portal/keys/rotate', { id: key.id });
  const still = (await (await call(owner, '/api/v1/portal/me')).json()).keys.find((x: { id: string }) => x.id === key.id);
  assert.deepEqual([still.name, still.revoked, still.prefix], ['Acme Billing', null, key.prefix], 'rename, revoke and rotate by a viewer change nothing');
  assert.equal((await call(guest, '/api/v1/portal/feedback', { key: key.id, id: 1, verdict: 'wrong' })).status, 400);
  assert.equal((await call(guest, `/api/v1/portal/policy?key=${key.id}`)).status, 404, 'rules stay with the owner');
  assert.equal((await call(guest, '/api/v1/portal/keys/share', { key: key.id, email: 'more@acme.io' })).status, 404, 'a viewer cannot pass it on');
  assert.equal((await call(stranger, `/api/v1/portal/stats?key=${key.id}`)).status, 404, 'a third account sees nothing');

  // the owner sees who has access, and takes it back
  access = await (await call(owner, `/api/v1/portal/keys/access?key=${key.id}`)).json();
  assert.deepEqual(access.members.map((m: { email: string; role: string }) => [m.email, m.role]), [['cfo@acme.io', 'viewer']]);
  assert.equal(access.invites.length, 0);
  assert.equal((await call(owner, '/api/v1/portal/keys/unshare', { key: key.id, account: access.members[0].account })).status, 200);
  assert.equal((await call(guest, `/api/v1/portal/stats?key=${key.id}`)).status, 404, 'gone at once');

  // a new invitation replaces an older one to the same address; a cancelled one stops working
  const first = await (await call(owner, '/api/v1/portal/keys/share', { key: key.id, email: 'cfo@acme.io' })).json();
  const second = await (await call(owner, '/api/v1/portal/keys/share', { key: key.id, email: 'cfo@acme.io' })).json();
  assert.equal((await call(guest, '/api/v1/portal/invites/accept', { token: new URL(first.link).searchParams.get('invite') })).status, 404);
  access = await (await call(owner, `/api/v1/portal/keys/access?key=${key.id}`)).json();
  assert.equal(access.invites.length, 1);
  assert.equal((await call(owner, '/api/v1/portal/keys/invites/cancel', { key: key.id, id: access.invites[0].id })).status, 200);
  assert.equal((await call(guest, '/api/v1/portal/invites/accept', { token: new URL(second.link).searchParams.get('invite') })).status, 404);

  // a viewer may leave on their own; deleting the key removes every share
  const third = await (await call(owner, '/api/v1/portal/keys/share', { key: key.id, email: 'cfo@acme.io' })).json();
  assert.equal((await call(guest, '/api/v1/portal/invites/accept', { token: new URL(third.link).searchParams.get('invite') })).status, 200);
  assert.equal((await call(guest, '/api/v1/portal/keys/unshare', { key: key.id })).status, 200);
  assert.equal((await call(guest, `/api/v1/portal/stats?key=${key.id}`)).status, 404);
  const fourth = await (await call(owner, '/api/v1/portal/keys/share', { key: key.id, email: 'cfo@acme.io' })).json();
  assert.equal((await call(guest, '/api/v1/portal/invites/accept', { token: new URL(fourth.link).searchParams.get('invite') })).status, 200);
  await call(owner, '/api/v1/portal/keys/revoke', { id: key.id });
  assert.equal((await call(owner, '/api/v1/portal/keys/delete', { id: key.id })).status, 200);
  assert.ok(!(await (await call(guest, '/api/v1/portal/me')).json()).keys.some((x: { id: string }) => x.id === key.id));
});
