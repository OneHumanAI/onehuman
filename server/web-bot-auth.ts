// SPDX-License-Identifier: BUSL-1.1
/**
 * Web Bot Auth / RFC 9421 HTTP Message Signature verification.
 *
 * Deliberately bounded profile:
 *  - one signature label, Ed25519 only, `tag="web-bot-auth"`
 *  - covered components must include `@authority`; ASCII header values only;
 *    no component parameters
 *  - `created`/`expires` mandatory, at most 5 minutes apart, not in the future
 *  - operator directory pinned to an allowlist; the `Signature-Agent` value is
 *    matched against it, never fetched blindly
 *  - nonce (or signature digest) replay is rejected within the validity window
 *
 * Anything outside the profile is `unsupported`, never `verified`.
 * An absent signature says nothing about the actor: it is not human proof.
 */
import { extraAppToken } from './signatures.ts';
import { createHash } from 'node:crypto';
import type { ServerSignal } from './signals.ts';

export type OperatorKey = JsonWebKey & { kid?: string; nbf?: number; exp?: number };
export type KeyLoader = (operator: string) => Promise<OperatorKey[]>;

export const KNOWN_OPERATORS: Record<string, string> = {
  'https://chatgpt.com': 'https://chatgpt.com/.well-known/http-message-signatures-directory',
};

const cache = new Map<string, { keys: OperatorKey[]; until: number }>();

export const httpsDirectoryLoader: KeyLoader = async (operator) => {
  const url = KNOWN_OPERATORS[operator];
  if (!url) throw new Error('unknown operator');
  const hit = cache.get(operator);
  if (hit && Date.now() < hit.until) return hit.keys;
  const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(4000), headers: { Accept: 'application/http-message-signatures-directory+json' } });
  if (!r.ok) throw new Error('directory');
  const text = await r.text();
  if (text.length > 64000) throw new Error('size');
  const data = JSON.parse(text);
  if (!Array.isArray(data.keys) || data.keys.length > 20) throw new Error('keys');
  cache.set(operator, { keys: data.keys, until: Date.now() + 300000 });
  return data.keys;
};

export type VerifyOptions = {
  keyLoader?: KeyLoader;
  /** returns true if the nonce was fresh; false if seen before */
  consumeNonce?: (key: string, ttlMs: number) => boolean | Promise<boolean>;
  now?: number;
};

type HeaderGetter = { get(name: string): string | null };

export type SignatureRequest = { method: string; url: string; headers: HeaderGetter };

export async function verifyWebBotAuth(req: SignatureRequest, opts: VerifyOptions = {}): Promise<ServerSignal['signature']> {
  const sig = req.headers.get('signature');
  const input = req.headers.get('signature-input');
  const agent = req.headers.get('signature-agent');
  const present = { signature: !!sig, signatureInput: !!input, signatureAgent: !!agent };
  const done = (status: ServerSignal['signature']['status'], reason: string, operator: string | null = null): ServerSignal['signature'] => ({ status, reason, operator, present });

  if (!sig && !input && !agent) return done('absent', 'The request has no signature; this is not proof of a human.');
  if (!sig || !input || !agent) return done('invalid', 'Signature headers are incomplete.');
  const operator = /^"([^"]+)"$/.exec(agent)?.[1] ?? null;
  if (!operator || !(operator in KNOWN_OPERATORS)) return done('unsupported', 'This operator is not on the allowlist; its key directory is not fetched.');
  if (sig.length > 8192 || input.length > 8192) return done('unsupported', 'Signature size is not supported.', operator);

  const m = /^([a-z][a-z0-9_.*-]*)=(\((?:"[a-z0-9@_-]+"(?: )?)+\))((?:;[a-z][a-z0-9_-]*=(?:"(?:[^"\\\r\n]|\\["\\])*"|[0-9]+))*)$/.exec(input);
  if (!m) return done('unsupported', 'Signature components do not match this profile.', operator);
  const label = m[1]!;
  const componentList = m[2]!;
  const paramText = m[3]!;
  const components = [...componentList.matchAll(/"([a-z0-9@_-]+)"/g)].map((x) => x[1]!);
  if (new Set(components).size !== components.length || !components.includes('@authority')) return done('invalid', 'The domain is not covered by the signature, or a component is repeated.', operator);

  const params: Record<string, string | number> = {};
  for (const p of paramText.matchAll(/;([a-z][a-z0-9_-]*)=("(?:[^"\\]|\\["\\])*"|[0-9]+)/g)) {
    const key = p[1]!;
    const raw = p[2]!;
    if (key in params) return done('invalid', 'Repeated signature parameter.', operator);
    params[key] = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(["\\])/g, '$1') : Number(raw);
  }
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (params.tag !== 'web-bot-auth' || (params.alg !== undefined && params.alg !== 'ed25519') || typeof params.keyid !== 'string') return done('unsupported', 'Signature algorithm or tag is not supported.', operator);
  const created = params.created;
  const expires = params.expires;
  if (
    typeof created !== 'number' || typeof expires !== 'number' || !Number.isSafeInteger(created) || !Number.isSafeInteger(expires) ||
    created > now + 30 || expires < now || expires <= created || expires - created > 300 || now - created > 300
  ) return done('invalid', 'The signature time window is not accepted.', operator);

  const sm = /^([a-z][a-z0-9_.*-]*)=:([A-Za-z0-9+/]+={0,2}):$/.exec(sig);
  if (!sm || sm[1] !== label) return done('unsupported', 'Signature encoding is not supported.', operator);

  const url = new URL(req.url);
  const lines: string[] = [];
  for (const name of components) {
    let value: string | null;
    switch (name) {
      case '@authority': value = url.host.toLowerCase(); break;
      case '@method': value = req.method; break;
      case '@target-uri': value = url.href; break;
      case '@scheme': value = url.protocol.slice(0, -1); break;
      case '@path': value = url.pathname; break;
      case '@query': value = url.search || '?'; break;
      default:
        if (name.startsWith('@')) return done('unsupported', 'Derived components are not supported.', operator);
        value = req.headers.get(name);
    }
    if (value === null || /[^\x20-\x7e]/.test(value)) return done('invalid', 'A signed component is missing or has changed.', operator);
    lines.push(`"${name}": ${value.trim()}`);
  }
  lines.push(`"@signature-params": ${componentList}${paramText}`);

  let keys: OperatorKey[];
  try {
    keys = await (opts.keyLoader ?? httpsDirectoryLoader)(operator);
  } catch {
    return done('unavailable', 'Could not reach the official key directory of the operator.', operator);
  }
  const sigBytes = Uint8Array.from(atob(sm[2]!), (c) => c.charCodeAt(0));
  const base = new TextEncoder().encode(lines.join('\n'));
  for (const key of keys) {
    if (key.kty !== 'OKP' || key.crv !== 'Ed25519' || !key.x || key.d || (key.nbf && key.nbf > now) || (key.exp && key.exp < now)) continue;
    const thumb = createHash('sha256').update(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x: key.x })).digest('base64url');
    if (params.keyid !== key.kid && params.keyid !== thumb) continue;
    try {
      const publicKey = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: key.x }, { name: 'Ed25519' }, false, ['verify']);
      if (await crypto.subtle.verify('Ed25519', publicKey, sigBytes, base)) {
        const nonceKey = typeof params.nonce === 'string' ? `nonce:${operator}:${params.nonce}` : `sig:${createHash('sha256').update(sm[2]!).digest('hex')}`;
        if (opts.consumeNonce && !(await opts.consumeNonce(nonceKey, (expires - now) * 1000 + 1000))) {
          return done('replay', 'A verified signature was reused within a short time.', operator);
        }
        return done('verified', `Signature verified with the ${operator} key.`, operator);
      }
    } catch {
      continue;
    }
  }
  return done('invalid', 'The signature does not match the official key. Proxy changes or key rotation can also cause this.', operator);
}

/** Build a ServerSignal from a Node request. Stores no raw UA, IP or cookies. */
export async function observeRequest(req: SignatureRequest, opts: VerifyOptions = {}): Promise<ServerSignal> {
  const start = performance.now();
  const signature = await verifyWebBotAuth(req, opts);
  const ua = req.headers.get('user-agent') ?? '';
  const major = /(?:Chrome|CriOS|Firefox|Safari|Edg)\/(\d+)/.exec(ua)?.[1];
  // Known agent-application shells that embed Chromium. Observed 2026-09-18: the Claude
  // desktop app's built-in browser sends "Claude/<version>" and no Sec-CH-UA headers.
  const agentApp = /\b(Claude|Codex|ChatGPT|Atlas|Comet|Electron)\/[\w.]+/.exec(ua)?.[0] ?? extraAppToken(ua)?.token ?? null;
  return {
    signature,
    secFetch: {
      site: req.headers.get('sec-fetch-site'),
      mode: req.headers.get('sec-fetch-mode'),
      dest: req.headers.get('sec-fetch-dest'),
      user: req.headers.get('sec-fetch-user'),
    },
    uaMajor: major ? Number(major) : null,
    environment: {
      agentAppToken: agentApp,
      clientHints: req.headers.get('sec-ch-ua') !== null,
      webkitPointer: /iPhone|iPad|iPod/.test(ua) || (/AppleWebKit/.test(ua) && /Version\/[\d.]+.*Safari/.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Android|FxiOS/.test(ua)),
    },
    checkedMs: Math.round(performance.now() - start),
  };
}

// ---------------------------------------------------------------------------
// Test helper: sign a request the way an operator would. Used by tests and demos.
// Never used to accept anything.
// ---------------------------------------------------------------------------
export async function signRequest(
  privateKey: CryptoKey,
  publicJwk: OperatorKey,
  req: SignatureRequest,
  operator: string,
  opts: { created?: number; expires?: number; nonce?: string; components?: string[] } = {},
): Promise<Record<string, string>> {
  const url = new URL(req.url);
  const created = opts.created ?? Math.floor(Date.now() / 1000);
  const expires = opts.expires ?? created + 120;
  const components = opts.components ?? ['@authority', 'signature-agent'];
  const nonce = opts.nonce ?? crypto.randomUUID();
  const keyid = publicJwk.kid ?? createHash('sha256').update(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x: publicJwk.x })).digest('base64url');
  const headers = new Headers();
  for (const [k, v] of Object.entries(reqHeadersToObject(req.headers))) headers.set(k, v);
  headers.set('signature-agent', `"${operator}"`);
  const paramText = `;created=${created};expires=${expires};keyid="${keyid}";alg="ed25519";nonce="${nonce}";tag="web-bot-auth"`;
  const componentList = `(${components.map((c) => `"${c}"`).join(' ')})`;
  const lines: string[] = [];
  for (const name of components) {
    let value: string | null;
    switch (name) {
      case '@authority': value = url.host.toLowerCase(); break;
      case '@method': value = req.method; break;
      case '@path': value = url.pathname; break;
      default: value = headers.get(name);
    }
    lines.push(`"${name}": ${(value ?? '').trim()}`);
  }
  lines.push(`"@signature-params": ${componentList}${paramText}`);
  const sig = await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(lines.join('\n')));
  return {
    'signature-agent': `"${operator}"`,
    'signature-input': `sig1=${componentList}${paramText}`,
    signature: `sig1=:${Buffer.from(sig).toString('base64')}:`,
  };
}

function reqHeadersToObject(h: HeaderGetter): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ['content-type', 'signature-agent']) {
    const v = h.get(name);
    if (v) out[name] = v;
  }
  return out;
}
