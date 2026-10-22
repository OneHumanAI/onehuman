// SPDX-License-Identifier: BUSL-1.1
/**
 * The website chat (web/chat.js): a visitor writes and the assistant answers at once (streamed). The team's side (reading
 * every conversation, stepping in) is not part of this repository.
 *
 *   POST /api/v1/chat/send   { chat?, token?, text, page? }   → NDJSON: chat · ack · delta… · done | waiting
 *   GET  /api/v1/chat/poll   ?chat=&token=&after=             → messages after an id (a person's replies)
 *
 * A visitor's chat is theirs by its token (kept hashed). The team hears about a new chat, a visitor who leaves an
 * e-mail, and one who asks for a person, by e-mail to ONEHUMAN_CHAT_NOTIFY (default arif@onehuman.ai).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { json, readJson, sameOrigin, url, type Req, type Res } from './http.ts';
import type { ChatMessageRow, ChatRow, SiteStore } from './site-db.ts';
import type { limiter } from './limits.ts';
import type { Mailer } from './mail.ts';
import { CALL_LINK, CONTACT_EMAIL, type ChatModel } from './chat-ai.ts';

/** a chat quiet for 12 months is deleted with its messages (web/trust.html says so) */
const KEEP_MS = 365 * 86_400_000;
const hash = (token: string) => createHash('sha256').update(`chat:${token}`).digest('hex');
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}/;
/** "a person, please" in the languages our visitors write in */
const WANTS_HUMAN = new RegExp([
  String.raw`(?:talk|speak|chat|connect)(?:\s+(?:to|with))?\s+(?:a\s+|an\s+|the\s+|your\s+|some\s+)?(?:real\s+|live\s+)?(?:human|person|founder|someone|somebody|team|sales|representative)`,
  String.raw`real\s+(?:human|person)|live\s+(?:agent|person|support)|operator|founders?\b`,
  String.raw`insanla|canlı\s+(?:insan|dəstək|destek)|təsisçi|real\s+insan|biri\s+ilə\s+danış|yetkili|temsilci|gerçek\s+(?:bir\s+)?(?:kişi|insan)|kurucu`,
  String.raw`человек|оператор|живым|основател|менеджер|mensch|mitarbeiter|gründer`,
].join('|'), 'iu');
const clean = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max) : '');
const publicMessage = (m: ChatMessageRow) => ({ id: m.id, role: m.role, text: m.text, at: m.at, author: m.role === 'admin' ? m.author : null });

export function chatRoutes(store: SiteStore, deps: {
  model: ChatModel | null;
  mail: Mailer | null;
  limits?: ReturnType<typeof limiter>;
  deviceOf?: (req: Req) => string;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const L = deps.limits;
  const notifyTo = () => (process.env.ONEHUMAN_CHAT_NOTIFY || CONTACT_EMAIL).split(',').map((s) => s.trim()).filter(Boolean);

  /** one e-mail to the team about a chat; never holds up or breaks the chat */
  async function notify(chat: ChatRow, what: 'new' | 'lead' | 'human' | 'waiting', detail: string) {
    if (!deps.mail) return;
    await Promise.all(notifyTo().map((to) => deps.mail!.sendChatAlert(to, { chatId: chat.id, what, detail, page: chat.page, country: chat.country, email: chat.email }).catch((e) => console.warn('onehuman chat: alert failed', e))));
  }

  /** the visitor's chat, if the token is theirs */
  async function own(chatId: string, token: string): Promise<ChatRow | null> {
    if (!chatId || !token || chatId.length > 64 || token.length > 128) return null;
    const c = await store.chatById(chatId);
    return c && c.tokenHash === hash(token) ? c : null;
  }

  const send = async (req: Req, res: Res) => {
    if (!sameOrigin(req)) return json(res, 403, { error: 'origin' });
    if (L && ((await L.over('chat', L.client(req), 40, 600e3)) || L.burst(req, 8, 10_000, 'device', 'chat'))) return json(res, 429, { error: 'rate_limited', message: 'Too many messages at once. Wait a minute and try again.' });
    const b = (await readJson(req, 8000).catch(() => null)) as Record<string, unknown> | null | undefined;
    if (b?.website) return json(res, 200, { ok: true });   // the hidden field: only a form-filling bot fills it
    const text = clean(b?.text, 1500);
    if (!text) return json(res, 400, { error: 'empty', message: 'Write a message first.' });
    const page = clean(b?.page, 200).replace(/[^\w/.\-?=&%#]/g, '') || null;
    const t = now();

    let chat = await own(clean(b?.chat, 64), clean(b?.token, 128));
    let token: string | null = null;
    if (!chat) {
      if (L && (await L.over('chat-new', L.client(req), 15, 86_400e3))) return json(res, 429, { error: 'rate_limited', message: 'Too many new chats from this network today. Write to ' + CONTACT_EMAIL + '.' });
      token = randomBytes(24).toString('base64url');
      const id = randomUUID();
      const country = String(req.headers['x-vercel-ip-country'] ?? '').slice(0, 2) || null;
      await store.createChat({ id, tokenHash: hash(token), page, country, device: deps.deviceOf?.(req) ?? null }, t);
      chat = (await store.chatById(id))!;
      void store.pruneChats(t - KEEP_MS).catch((e) => console.warn('onehuman chat: prune failed', e));
    }
    const firstMessage = chat.messages === 0;
    const id = await store.addChatMessage(chat.id, 'visitor', text, null, t);
    if (chat.status === 'closed') await store.updateChat(chat.id, { status: 'ai' });

    // what the team should hear about, sent while the assistant writes
    const alerts: Promise<void>[] = [];
    const email = EMAIL.exec(text)?.[0]?.toLowerCase() ?? null;
    if (email && !chat.email) { await store.updateChat(chat.id, { email }); chat = { ...chat, email }; alerts.push(notify(chat, 'lead', text)); }
    if (WANTS_HUMAN.test(text) && chat.humanAskedAt == null) { await store.updateChat(chat.id, { human_asked_at: t }); alerts.push(notify(chat, 'human', text)); }
    else if (firstMessage) alerts.push(notify(chat, 'new', text));
    else if (chat.status === 'human' && (chat.notifiedAt == null || t - chat.notifiedAt > 10 * 60_000)) { await store.updateChat(chat.id, { notified_at: t }); alerts.push(notify(chat, 'waiting', text)); }

    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
    const line = (o: unknown) => res.write(JSON.stringify(o) + '\n');
    if (token) line({ type: 'chat', id: chat.id, token });
    line({ type: 'ack', message: { id, role: 'visitor', text, at: t } });

    if (chat.status === 'human') {
      line({ type: 'waiting', status: 'human' });
    } else {
      const history = await store.chatMessages(chat.id);
      let reply = '', partial = '';
      try {
        if (!deps.model) throw new Error('no model');
        reply = await deps.model(history.map((m) => ({ role: m.role, text: m.text })), (d) => { partial += d; line({ type: 'delta', text: d }); }, { page: chat.page });
      } catch (e) {
        console.warn('onehuman chat: the assistant did not answer', e instanceof Error ? e.message : e);
        reply = partial.trim();   // cut off mid-answer: what the visitor already read is what is kept
      }
      if (!reply) {
        // the assistant is out: a person is told, and the visitor knows how to reach one now
        reply = `Thanks, a founder has been told and will reply here shortly. If it's urgent, book 15 minutes: ${CALL_LINK} or write to ${CONTACT_EMAIL}.`;
        line({ type: 'delta', text: reply });
        if (!firstMessage) alerts.push(notify(chat, 'waiting', text));
      }
      // the chat moved on while the assistant wrote (a person took over): their word stands, the reply is dropped
      const latest = await store.chatById(chat.id);
      if (latest?.status === 'human') line({ type: 'waiting', status: 'human' });
      else {
        const aiId = await store.addChatMessage(chat.id, 'ai', reply.slice(0, 4000), null, now());
        line({ type: 'done', message: { id: aiId, role: 'ai', text: reply, at: now() } });
      }
    }
    await Promise.all(alerts);
    res.end();
  };

  /** a person's replies (and the chat's state) since the visitor last looked */
  const poll = async (req: Req, res: Res) => {
    const u = url(req);
    const chat = await own(u.searchParams.get('chat') ?? '', u.searchParams.get('token') ?? '');
    if (!chat) return json(res, 404, { error: 'not_found' });
    const after = Math.max(0, Number(u.searchParams.get('after')) || 0);
    const messages = await store.chatMessages(chat.id, after);
    json(res, 200, { status: chat.status, messages: messages.map(publicMessage) }, { 'Cache-Control': 'no-store' });
  };

  return { send, poll };
}
