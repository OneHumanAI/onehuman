// SPDX-License-Identifier: BUSL-1.1
/**
 * The policy assistant: a person writes what they want in their own words ("let agents see balances but hide
 * the amounts") and a language model turns it into edits of the rules that already exist.
 *
 * It never adds or removes a rule. A new rule needs a new oh.protect() in the app's code, so for that the
 * assistant answers with a prompt the person gives to the coding agent that works on their code. Whatever the
 * model says, only edits to existing rules with valid values survive the check below; the result is a draft
 * the person reviews and saves through the normal path (password for anything that lowers protection).
 *
 * Sent to the model: the rules (names, labels, modes, thresholds) and the person's message. No traffic,
 * no sessions, no keys.
 */
import type { Policy } from './policy.ts';
import { diffPolicy, MODE_WORDS, type PolicyLike, type PolicyMode } from '../integrations/policy/common.ts';
import { aiBody, aiTargets, languageOf } from './ai.ts';

const MODES: PolicyMode[] = ['allow', 'mask', 'step_up', 'block'];
const FIELDS = ['onAgent', 'onArtifact', 'onUnknown', 'onHumanLike'] as const;

export const assistEnabled = () => aiTargets('rules').length > 0;

const SYSTEM = `You help a non-technical person adjust the rules of OneHuman, a product that decides what an AI agent (an AI browser acting inside a customer's logged-in session) may do with each part of a web app.

Each rule covers one part of the app (its "resource" name comes from the app's code and must never change) and says what happens for four kinds of visitor:
- onAgent: an AI agent was detected
- onArtifact: the browser has AI tools installed, but no agent was seen acting
- onUnknown: not enough signal to tell
- onHumanLike: the visitor behaves like a real person
Each is one of: allow (${MODE_WORDS.allow}), mask (${MODE_WORDS.mask}), step_up (${MODE_WORDS.step_up}), block (${MODE_WORDS.block}).
minScore (0-100, default 65): how sure OneHuman must be before it acts. Higher = acts less often.
enforcement: "observe" = only watch and record, block nothing; "enforce" = apply the rules.

Rules you must follow:
- You may only change existing rules: their four modes, minScore, title, and the overall enforcement.
- Match the person's words to existing rules by meaning, in any language ("payments" or "pagos" can be payout.create; "download the report" can be report.export). Only when no existing rule fits is a new rule needed.
- You must never add a rule or remove one. If the person asks to protect something that has no rule, do not invent one: set "needsCode" with a short explanation and a clear prompt they can give to the AI coding assistant that works on their app's code (the coding assistant adds oh.protect('<name>') to the route and the rule to onehuman.policy.json; after deploy the rule appears in the portal by itself).
- If the request is unclear or impossible, change nothing and ask one short question in "reply".
- Never make real people (onHumanLike) blocked or asked for a passkey unless the person clearly asks for that.
- "reply" is 1-3 short sentences in the language named in "Reply in" (the language of the person's last message), in plain words, without technical terms like onAgent or step_up. Earlier messages may be in other languages: always answer in the language of the last one, and never mix alphabets. Azerbaijani and Turkish are different languages: Azerbaijani writes ə and q (e.g. "eyni", "qayda"), Turkish does not.
- When nothing needs to change, say so and say briefly what the rules already do about it.
- "needsCode.why" is in the person's language; "needsCode.prompt" is in English (coding assistants work best in it) and names what to protect in the person's own words — never guess a resource name.

Answer with JSON only:
{"reply": string, "edits": [{"resource": string, "onAgent"?: mode, "onArtifact"?: mode, "onUnknown"?: mode, "onHumanLike"?: mode, "minScore"?: number, "title"?: string}], "enforcement": "observe" | "enforce" | null, "needsCode": null | {"why": string, "prompt": string}}`;

export type AssistResult = {
  reply: string;
  /** the draft with the edits applied, or null when nothing changed */
  proposed: PolicyLike | null;
  changes: string[];
  /** changes that lower protection or reach real people: saving them asks for the password */
  careful: string[];
  /** edits the model proposed that were not allowed (a rule that does not exist, a bad value) */
  refused: string[];
  needsCode: { why: string; prompt: string } | null;
};

function extractJson(text: string): Record<string, unknown> | null {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { const o = JSON.parse(t.slice(a, b + 1)); return o && typeof o === 'object' ? o : null; } catch { return null; }
}

/** Apply the model's edits to the draft, keeping only what the assistant is allowed to change. */
export function applyEdits(draft: PolicyLike, raw: Record<string, unknown>): Omit<AssistResult, 'reply' | 'needsCode'> {
  const next: PolicyLike = { ...draft, rules: draft.rules.map((r) => ({ ...r })) };
  const refused: string[] = [];
  const byRes = new Map(next.rules.map((r) => [r.resource, r]));
  for (const e of Array.isArray(raw.edits) ? raw.edits.slice(0, 60) : []) {
    if (!e || typeof e !== 'object') continue;
    const x = e as Record<string, unknown>;
    const rule = typeof x.resource === 'string' ? byRes.get(x.resource) : undefined;
    if (!rule) { refused.push(`${String(x.resource ?? '?')}: there is no rule with that name, so it was not changed`); continue; }
    for (const f of FIELDS) {
      if (x[f] === undefined) continue;
      if (MODES.includes(x[f] as PolicyMode)) rule[f] = x[f] as PolicyMode;
      else refused.push(`${rule.resource}: "${String(x[f])}" is not a valid choice`);
    }
    if (x.minScore !== undefined) {
      const n = Number(x.minScore);
      if (Number.isInteger(n) && n >= 0 && n <= 100) rule.minScore = n; else refused.push(`${rule.resource}: the threshold must be a whole number from 0 to 100`);
    }
    if (typeof x.title === 'string' && x.title.trim()) rule.title = x.title.trim().slice(0, 80);
  }
  if (raw.enforcement === 'observe' || raw.enforcement === 'enforce') next.enforcement = raw.enforcement;
  const d = diffPolicy(draft, next);
  return { proposed: d.same ? null : next, changes: d.changes, careful: [...d.weakening, ...d.affectsPeople], refused };
}

/** an earlier turn of the same conversation: what the person asked, what the assistant answered (text only) */
export type AssistTurn = { role: 'user' | 'assistant'; text: string };
/** keep a usable history: the last few turns, each short, roles as said */
export const cleanHistory = (raw: unknown): AssistTurn[] => (Array.isArray(raw) ? raw : [])
  .filter((t): t is AssistTurn => !!t && typeof t === 'object' && ((t as AssistTurn).role === 'user' || (t as AssistTurn).role === 'assistant') && typeof (t as AssistTurn).text === 'string' && !!(t as AssistTurn).text.trim())
  .slice(-8).map((t) => ({ role: t.role, text: t.text.trim().slice(0, 600) }));

export async function assistPolicy(draft: Policy, message: string, history: AssistTurn[] = []): Promise<AssistResult> {
  const targets = aiTargets('rules');
  if (!targets.length) throw Object.assign(new Error('The assistant is not set up on this server.'), { code: 'assistant_off' });
  const rules = draft.rules.map((r) => ({ resource: r.resource, title: r.title, onAgent: r.onAgent, onArtifact: r.onArtifact, onUnknown: r.onUnknown, onHumanLike: r.onHumanLike, minScore: r.minScore }));
  // the reply's language is decided here, not left to the model (an English request once got a Spanish answer)
  const lang = languageOf(message) ?? 'the language of the person\'s message (English when unsure)';
  const messages = [
      { role: 'system', content: SYSTEM },
      // the conversation so far, so "and the exports too" or "undo that" mean something; the rules are always the current ones
      ...history.map((t) => ({ role: t.role, content: t.text })),
      { role: 'user', content: `Current rules (enforcement: ${draft.enforcement}):\n${JSON.stringify(rules)}\n\nWhat the person wants:\n${message}\n\nReply in: ${lang}` },
  ];
  // the best model first; if it does not answer, the next one does
  let data: { choices?: { message?: { content?: string } }[] } | null = null;
  for (const target of targets) {
    const body = aiBody(target, { temperature: 0.1, maxTokens: 1500, json: true, effort: 'medium', messages });
    const r = await fetch(target.url, { method: 'POST', headers: target.headers, body: JSON.stringify(body), signal: AbortSignal.timeout(45_000) }).catch((e) => { console.warn(`onehuman: rules agent ${target.provider} unreachable`, (e as Error).message); return null; });
    if (r?.ok) { data = await r.json().catch(() => null); if (data) break; }
    else if (r) console.warn(`onehuman: rules agent ${target.provider} answered`, r.status, (await r.text().catch(() => '')).slice(0, 300));
  }
  if (!data) throw Object.assign(new Error('The assistant could not answer right now. Try again in a minute.'), { code: 'assistant_error' });
  const raw = extractJson(data?.choices?.[0]?.message?.content ?? '');
  if (!raw) throw Object.assign(new Error('The assistant gave an answer we could not read. Try again, or put it differently.'), { code: 'assistant_error' });
  const applied = applyEdits(draft as PolicyLike, raw);
  const nc = raw.needsCode && typeof raw.needsCode === 'object' ? raw.needsCode as Record<string, unknown> : null;
  const needsCode = nc && typeof nc.prompt === 'string' && nc.prompt.trim()
    ? {
      why: String(nc.why ?? '').slice(0, 400),
      prompt: `OneHuman (npm: onehuman) is installed in this app.\n\n${nc.prompt.trim().slice(0, 1500)}`,
    }
    : null;
  const reply = typeof raw.reply === 'string' && raw.reply.trim() ? raw.reply.trim().slice(0, 600) : applied.proposed ? 'Here is the change.' : 'Nothing to change.';
  return { reply, ...applied, needsCode };
}
