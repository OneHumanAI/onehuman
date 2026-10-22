// SPDX-License-Identifier: BUSL-1.1
/**
 * The website chat: a visitor writes and the assistant answers at once (streamed); the team hears about new chats,
 * leads and requests for a person. A chat is the visitor's by its token, and nothing of it reaches anyone else.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.ts';
import type { Outgoing, Transport } from '../server/mail.ts';
import type { ChatModel, ChatTurn } from '../server/chat-ai.ts';

const sent: Outgoing[] = [];
const transport: Transport = { name: 'fake', async send(m) { sent.push(m); return { id: String(sent.length) }; } };
const alerts = () => sent.filter((m) => m.kind === 'chat');

// the assistant, scripted per test: what it saw, and what it does
let seen: ChatTurn[][] = [];
let behave: (turns: ChatTurn[], onDelta: (t: string) => void) => Promise<string> = async (_t, d) => { d('Hello'); d(' there.'); return 'Hello there.'; };
const model: ChatModel = (turns, onDelta) => { seen.push(turns); return behave(turns, onDelta); };

process.env.ONEHUMAN_CHAT = 'on';   // the chat is off on the site unless this says on
const app = await createApp({ labOperator: false, dogfood: false, firebase: null, mailTransport: transport, chatModel: model });
await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
after(() => { app.server.close(); app.store.close(); });

const H = (ip: string, cookie = '') => ({ 'Content-Type': 'application/json', Origin: base, 'X-Forwarded-For': ip, 'X-Vercel-IP-Country': 'DE', 'User-Agent': `test ${ip}`, ...(cookie ? { Cookie: cookie } : {}) });
type Ev = { type: string; id?: string; token?: string; text?: string; message?: { id: number; text: string; role: string } };
async function say(ip: string, text: string, chat?: { id: string; token: string }) {
  const r = await fetch(`${base}/api/v1/chat/send`, { method: 'POST', headers: H(ip), body: JSON.stringify({ chat: chat?.id, token: chat?.token, text, page: '/report' }) });
  const body = await r.text();
  const events: Ev[] = r.headers.get('content-type')?.includes('ndjson') ? body.trim().split('\n').map((l) => JSON.parse(l)) : [];
  const c = events.find((e) => e.type === 'chat');
  return { status: r.status, events, chat: c ? { id: c.id!, token: c.token! } : chat, reply: events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), body };
}
const poll = (chat: { id: string; token: string }, after = 0) => fetch(`${base}/api/v1/chat/poll?chat=${chat.id}&token=${encodeURIComponent(chat.token)}&after=${after}`);

test('the chat is on the public pages, same-origin only, and never in the portal or a demo', async () => {
  for (const [path, on] of [['/', true], ['/report', true], ['/product', true], ['/portal', false]] as const) {
    const r = await fetch(`${base}${path}`);
    assert.equal(/<script src="\/chat\.js" defer>/.test(await r.text()), on, path);
    assert.ok(!/tawk|chatwoot|crisp|intercom/i.test(r.headers.get('content-security-policy') ?? ''), `${path}: no third party in the CSP`);
  }
  const demo = await fetch(`${base}/bank`, { headers: H('192.0.2.1') });
  assert.ok(!/chat\.js/.test(await demo.text()), 'not in a demo');
  const js = await fetch(`${base}/chat.js`);
  assert.equal(js.status, 200);
  assert.ok(!/tawk|embed\.|https:\/\/(?!cal\.com)[\w.-]+\/[\w/]*\.js/.test(await js.text()), 'the widget loads nothing from elsewhere');
});

test('a visitor writes: the answer streams, the chat is theirs by its token, the team hears about it', async () => {
  sent.length = 0; seen = [];
  const a = await say('198.51.100.10', 'Salam, OneHuman nədir?');
  assert.equal(a.status, 200);
  assert.deepEqual(a.events.map((e) => e.type), ['chat', 'ack', 'delta', 'delta', 'done']);
  assert.equal(a.reply, 'Hello there.');
  assert.equal(seen[0]!.at(-1)!.text, 'Salam, OneHuman nədir?');
  assert.equal(alerts().length, 1);
  assert.equal(alerts()[0]!.to, 'arif@onehuman.ai');
  assert.match(alerts()[0]!.subject, /New chat on onehuman\.ai/);
  assert.match(alerts()[0]!.html, /\/admin-panel#chats\//);

  // the next message carries the conversation; an e-mail in it makes a lead
  const b = await say('198.51.100.10', 'Bizim CRM var. Mənə yazın: Lead@Acme.io', a.chat);
  assert.ok(!b.events.some((e) => e.type === 'chat'), 'same chat, no new token');
  assert.deepEqual(seen[1]!.map((t) => t.role), ['visitor', 'ai', 'visitor']);
  assert.equal(alerts().length, 2);
  assert.match(alerts()[1]!.subject, /Lead in the chat/);
  assert.equal((await app.store.chatById(a.chat!.id))!.email, 'lead@acme.io');

  // asking for a person: one alert, not one per message
  await say('198.51.100.10', 'Can I talk to a real person?', a.chat);
  await say('198.51.100.10', 'Any person?', a.chat);
  assert.equal(alerts().filter((m) => /asks for a person/.test(m.subject)).length, 1);

  // the transcript is the visitor's alone
  const own = await (await poll(a.chat!)).json();
  assert.equal(own.status, 'ai');
  assert.deepEqual(own.messages.map((m: { role: string }) => m.role), ['visitor', 'ai', 'visitor', 'ai', 'visitor', 'ai', 'visitor', 'ai']);
  assert.ok(own.messages.every((m: { author: unknown }) => m.author === null));
  assert.equal((await poll({ id: a.chat!.id, token: 'not-the-token' })).status, 404);
  assert.equal((await poll({ id: a.chat!.id, token: '' })).status, 404);
  const later = await (await poll(a.chat!, own.messages[5].id)).json();
  assert.equal(later.messages.length, 2, 'only what is new');
  // a token that is not theirs starts a new chat, it never joins someone else's
  const other = await say('198.51.100.11', 'hi', { id: a.chat!.id, token: 'guess' });
  assert.notEqual(other.chat!.id, a.chat!.id);
});

test('when the assistant fails, the visitor still gets a way to a person, and the guards hold', async () => {
  behave = async () => { throw new Error('model down'); };
  try {
    const r = await say('198.51.100.40', 'hello?');
    assert.equal(r.events.at(-1)!.type, 'done');
    assert.match(r.reply, /cal\.com\/onehumanai/);
    assert.match(r.reply, /arif@onehuman\.ai/);
  } finally { behave = async (_t, d) => { d('Hello'); d(' there.'); return 'Hello there.'; }; }

  const cross = await fetch(`${base}/api/v1/chat/send`, { method: 'POST', headers: { ...H('198.51.100.41'), Origin: 'https://evil.example' }, body: JSON.stringify({ text: 'hi' }) });
  assert.equal(cross.status, 403);
  assert.equal((await say('198.51.100.42', '   ')).status, 400);
  const before = (await app.store.listChats(500)).length;
  const bot = await fetch(`${base}/api/v1/chat/send`, { method: 'POST', headers: H('198.51.100.43'), body: JSON.stringify({ text: 'buy now', website: 'http://spam.example' }) });
  assert.equal(bot.status, 200);
  assert.equal((await app.store.listChats(500)).length, before, 'the hidden field: no chat for a form-filling bot');
  // long text is cut, control characters are gone
  const long = await say('198.51.100.44', `a\u0000b${'x'.repeat(3000)}`);
  const ack = long.events.find((e) => e.type === 'ack')!.message!;
  assert.equal(ack.text.length, 1500); assert.ok(ack.text.startsWith('abx'));
  // a burst from one device is slowed down
  let limited = 0, chat: { id: string; token: string } | undefined;
  for (let i = 0; i < 10; i++) { const r = await say('198.51.100.45', `msg ${i}`, chat); chat = r.chat ?? chat; if (r.status === 429) limited++; }
  assert.ok(limited >= 1, 'rate limited');
});

test('a chat quiet for 12 months is deleted with its messages', async () => {
  const old = Date.now() - 400 * 86_400_000;
  await app.store.createChat({ id: 'old-chat-0001', tokenHash: 'x', page: '/', country: null, device: null }, old);
  await app.store.addChatMessage('old-chat-0001', 'visitor', 'from last year', null, old);
  const fresh = await say('198.51.100.60', 'new here');
  await app.store.pruneChats(Date.now() - 365 * 86_400_000);   // a new chat starts this too, in the background
  assert.equal(await app.store.chatById('old-chat-0001'), null);
  assert.equal((await app.store.chatMessages('old-chat-0001')).length, 0);
  assert.ok(await app.store.chatById(fresh.chat!.id), 'a recent chat stays');
});

test('an answer cut off midway keeps what the visitor already read', async () => {
  behave = async (_t, d) => { d('OneHuman spots the agent'); throw new Error('stream cut'); };
  try {
    const r = await say('198.51.100.70', 'what is it?');
    assert.equal(r.reply, 'OneHuman spots the agent');
    const done = r.events.find((e) => e.type === 'done')!;
    assert.equal(done.message!.text, 'OneHuman spots the agent');
  } finally { behave = async (_t, d) => { d('Hello'); d(' there.'); return 'Hello there.'; }; }
});

test('the chat is off on the site by default: no script on the pages and no chat API', async () => {
  const saved = process.env.ONEHUMAN_CHAT; delete process.env.ONEHUMAN_CHAT;
  const off = await createApp({ labOperator: false, dogfood: false, firebase: null, chatModel: model });
  await new Promise<void>((r) => off.server.listen(0, '127.0.0.1', () => r()));
  const b = `http://127.0.0.1:${(off.server.address() as AddressInfo).port}`;
  try {
    const home = await (await fetch(`${b}/`)).text();
    assert.ok(!home.includes('/chat.js'), 'the widget script is not on the home page');
    const r = await fetch(`${b}/api/v1/chat/send`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: b }, body: JSON.stringify({ text: 'hello' }) });
    assert.equal(r.status, 404, 'and its API is gone');
  } finally { off.server.close(); off.store.close(); if (saved !== undefined) process.env.ONEHUMAN_CHAT = saved; }
});
