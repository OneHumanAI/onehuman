// SPDX-License-Identifier: Apache-2.0
/**
 * The portal-managed policy, the part both sides must agree on: how a policy is hashed, how the portal's signed
 * envelope is checked, and what counts as a change that weakens protection.
 *
 * The portal is the source of truth for a key's policy. It hands the server a signed envelope (compact JWS,
 * EdDSA): the server accepts no policy the portal did not sign, pins the portal's key the first time it sees it,
 * and keeps the last envelope it accepted so it can run on it when the portal cannot be reached.
 */
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { thumbprint } from '../proof/verify.ts';

export const POLICY_TYP = 'oh-policy';

export type PolicyMode = 'allow' | 'mask' | 'step_up' | 'block';
export type PolicyRuleLike = {
  resource: string; title?: string;
  onAgent: PolicyMode; onUnknown: PolicyMode; onHumanLike: PolicyMode; onArtifact?: PolicyMode;
  actOn?: string[]; minScore?: number;
};
export type PolicyLike = { version: string; enforcement: 'observe' | 'enforce'; rules: PolicyRuleLike[] };

/** What the portal signs: the policy, its version number, and which API key it belongs to. */
export type PolicyEnvelopePayload = {
  v: 1;
  iss: 'onehuman-portal';
  /** first 16 hex of sha256(raw API key): binds the envelope to one key, so one key's policy cannot be replayed to another */
  kh: string;
  /** portal version number; the policy's own `version` string is `portal-v<n>` */
  n: number;
  iat: number;
  policy: PolicyLike;
};

/** first 16 hex of sha256(raw API key) — the portal stores the full sha256, the server computes it from the key */
export const keyTag = (rawKey: string) => createHash('sha256').update(rawKey).digest('hex').slice(0, 16);

/** A stable text form of a policy's meaning: the same rules in any key order hash the same; the version string is ignored. */
export function canonicalPolicy(p: PolicyLike): string {
  const rules = [...p.rules]
    .map((r) => ({
      resource: r.resource, title: r.title ?? '', onAgent: r.onAgent, onArtifact: r.onArtifact ?? 'allow', onUnknown: r.onUnknown, onHumanLike: r.onHumanLike,
      actOn: [...(r.actOn ?? ['verified', 'strong', 'control', 'behavioral'])].sort(), minScore: r.minScore ?? 65,
    }))
    .sort((a, b) => (a.resource < b.resource ? -1 : a.resource > b.resource ? 1 : 0));
  return JSON.stringify({ enforcement: p.enforcement, rules });
}
export const policyHash = (p: PolicyLike) => createHash('sha256').update(canonicalPolicy(p)).digest('hex').slice(0, 24);

const STRICT: Record<PolicyMode, number> = { allow: 0, mask: 1, step_up: 2, block: 3 };
const WHO: Record<string, string> = { onAgent: 'an AI agent', onArtifact: 'a browser with AI tools installed', onUnknown: 'a visitor we cannot identify', onHumanLike: 'a real person' };
/** what each mode means for the one asking, in plain words */
export const MODE_WORDS: Record<PolicyMode, string> = { allow: 'sees everything', mask: 'sees it with sensitive details hidden', step_up: 'must confirm with a passkey', block: 'is refused' };

export type PolicyDiff = {
  /** every change, in plain words */
  changes: string[];
  /** the subset that lets agents see or do more than before */
  weakening: string[];
  /** the subset that makes real people confirm or be refused where they were not before */
  affectsPeople: string[];
  same: boolean;
};

/** Compare two policies in plain language, and say which changes weaken protection or reach real people. */
export function diffPolicy(before: PolicyLike | null, after: PolicyLike): PolicyDiff {
  const changes: string[] = [], weakening: string[] = [], affectsPeople: string[] = [];
  const name = (r: PolicyRuleLike) => (r.title && r.title !== r.resource ? `${r.title} (${r.resource})` : r.resource);
  if (!before) {
    changes.push(`${after.rules.length} rule${after.rules.length === 1 ? '' : 's'}, ${after.enforcement === 'enforce' ? 'protection on' : 'watching only'}`);
    return { changes, weakening, affectsPeople, same: false };
  }
  if (before.enforcement !== after.enforcement) {
    if (after.enforcement === 'observe') { const s = 'Protection switched off: rules are only watched, nothing is blocked'; changes.push(s); weakening.push(s); }
    else changes.push('Protection switched on: the rules now apply');
  }
  const was = new Map(before.rules.map((r) => [r.resource, r]));
  const now = new Map(after.rules.map((r) => [r.resource, r]));
  for (const [res, r] of now) {
    const o = was.get(res);
    if (!o) {
      changes.push(`New rule: ${name(r)}`);
      if (r.onHumanLike !== 'allow') affectsPeople.push(`New rule ${name(r)}: ${WHO.onHumanLike} ${MODE_WORDS[r.onHumanLike]}`);
      continue;
    }
    for (const f of ['onAgent', 'onArtifact', 'onUnknown', 'onHumanLike'] as const) {
      const a = (o[f] ?? 'allow') as PolicyMode, b = (r[f] ?? 'allow') as PolicyMode;
      if (a === b) continue;
      const s = `${name(r)}: ${WHO[f]} ${MODE_WORDS[a]} → ${MODE_WORDS[b]}`;
      changes.push(s);
      if (STRICT[b] < STRICT[a] && f !== 'onHumanLike') weakening.push(s);
      if (f === 'onHumanLike' && STRICT[b] > STRICT[a]) affectsPeople.push(s);
    }
    const ta = new Set(o.actOn ?? ['verified', 'strong', 'control', 'behavioral']), tb = new Set(r.actOn ?? ['verified', 'strong', 'control', 'behavioral']);
    const dropped = [...ta].filter((t) => !tb.has(t)), added = [...tb].filter((t) => !ta.has(t));
    if (dropped.length) { const s = `${name(r)}: ignores kinds of evidence it used before (${dropped.join(', ')})`; changes.push(s); weakening.push(s); }
    if (added.length) changes.push(`${name(r)}: also uses ${added.join(', ')} evidence`);
    const sa = o.minScore ?? 65, sb = r.minScore ?? 65;
    if (sa !== sb) { const s = `${name(r)}: ${sb > sa ? 'needs stronger' : 'acts on weaker'} evidence before acting (score ${sa} → ${sb})`; changes.push(s); if (sb > sa) weakening.push(s); }
    if ((o.title ?? '') !== (r.title ?? '')) changes.push(`${res}: renamed to "${r.title ?? ''}"`);
  }
  for (const [res, o] of was) if (!now.has(res)) { const s = `${name(o)} is no longer protected (rule removed)`; changes.push(s); weakening.push(s); }
  return { changes, weakening, affectsPeople, same: changes.length === 0 };
}

export type EnvelopeCheck =
  | { ok: true; payload: PolicyEnvelopePayload; kid: string }
  | { ok: false; reason: 'malformed' | 'wrong_type' | 'unknown_key' | 'bad_signature' | 'wrong_key_tag' };

const keyCache = new Map<string, KeyObject>();
/** Check a signed policy envelope against the pinned portal key(s) and this server's API key tag. */
export function verifyPolicyEnvelope(jws: string, keys: { x: string }[], expectedKeyTag: string): EnvelopeCheck {
  if (typeof jws !== 'string') return { ok: false, reason: 'malformed' };
  const parts = jws.split('.');
  if (parts.length !== 3 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) return { ok: false, reason: 'malformed' };
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: string; typ?: string; kid?: string }, payload: PolicyEnvelopePayload;
  try { header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')); payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch { return { ok: false, reason: 'malformed' }; }
  if (header.alg !== 'EdDSA' || header.typ !== POLICY_TYP || payload?.iss !== 'onehuman-portal' || payload.v !== 1) return { ok: false, reason: 'wrong_type' };
  const key = keys.find((k) => thumbprint(k.x) === header.kid);
  if (!key) return { ok: false, reason: 'unknown_key' };
  let pub = keyCache.get(key.x);
  if (!pub) {
    try { pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.x }, format: 'jwk' }); } catch { return { ok: false, reason: 'unknown_key' }; }
    keyCache.set(key.x, pub);
  }
  if (!verify(null, Buffer.from(`${h}.${p}`), pub, Buffer.from(s, 'base64url'))) return { ok: false, reason: 'bad_signature' };
  if (payload.kh !== expectedKeyTag) return { ok: false, reason: 'wrong_key_tag' };
  return { ok: true, payload, kid: header.kid! };
}
