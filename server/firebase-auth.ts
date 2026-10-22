// SPDX-License-Identifier: BUSL-1.1
/**
 * Sign-in through Firebase Authentication (onehuman.ai in production): e-mail and password, or Google. The page signs in
 * with Firebase and hands its ID token to POST /api/v1/portal/session; this file checks the token here, against
 * Google's published keys, with no SDK and no credential. The portal then keeps its own session cookie as before.
 *
 * The web config is public by design (it names the project; it grants nothing): it ships in the page.
 */
import { createPublicKey, createVerify, type JsonWebKey } from 'node:crypto';

export type FirebaseWebConfig = { apiKey: string; authDomain: string; projectId: string; appId: string; messagingSenderId: string };

/** onehuman.ai's own web app in the onehuman-ai project (Firebase console → Project settings → Your apps) */
const ONEHUMAN_WEB = { projectId: 'onehuman-ai', apiKey: 'AIzaSyAxjCRgKklxqc0_M6vSKZfpIFb8UMDXQo8', appId: '1:667471175488:web:7ced82d980e90d9e98a4a5', messagingSenderId: '667471175488' };

/** the project's web config (FIREBASE_PROJECT_ID turns Firebase on); null when this deployment keeps passwords itself */
export function firebaseWebConfig(env: NodeJS.ProcessEnv = process.env): FirebaseWebConfig | null {
  const projectId = env.FIREBASE_PROJECT_ID;
  if (!projectId) return null;
  const own = projectId === ONEHUMAN_WEB.projectId ? ONEHUMAN_WEB : null;
  const apiKey = env.FIREBASE_WEB_API_KEY || own?.apiKey;
  if (!apiKey) return null;
  return {
    apiKey, projectId,
    // the sign-in pages are served from our own domain (vercel.json rewrites /__/auth/ to Firebase), so Google's
    // consent screen names onehuman.ai, not a firebaseapp.com address
    authDomain: env.FIREBASE_AUTH_DOMAIN || `${projectId}.firebaseapp.com`,
    appId: env.FIREBASE_APP_ID || own?.appId || '', messagingSenderId: env.FIREBASE_MESSAGING_SENDER_ID || own?.messagingSenderId || '',
  };
}

export type FirebaseUser = { uid: string; email: string; emailVerified: boolean; provider: string };

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let keys: { at: number; maxAge: number; byKid: Map<string, JsonWebKey> } | null = null;

async function signingKey(kid: string, fetchImpl: typeof fetch): Promise<JsonWebKey | null> {
  const fresh = keys && Date.now() - keys.at < keys.maxAge;
  if (!fresh || !keys!.byKid.has(kid)) {
    const r = await fetchImpl(JWKS_URL, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`firebase keys: ${r.status}`);
    const body = (await r.json()) as { keys: (JsonWebKey & { kid: string })[] };
    const maxAge = Number(/max-age=(\d+)/.exec(r.headers.get('cache-control') ?? '')?.[1] ?? 3600) * 1000;
    keys = { at: Date.now(), maxAge, byKid: new Map(body.keys.map((k) => [k.kid, k])) };
  }
  return keys!.byKid.get(kid) ?? null;
}

const b64json = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Record<string, unknown>;

/**
 * A Firebase ID token's owner, or why it is refused. Checks what Firebase documents: RS256 by one of Google's current
 * keys, audience and issuer = this project, not expired, issued and authenticated in the past, a subject.
 */
export async function verifyFirebaseToken(token: string, projectId: string, opts: { now?: number; fetchImpl?: typeof fetch } = {}): Promise<FirebaseUser> {
  const parts = token.split('.');
  if (parts.length !== 3 || token.length > 8000) throw new Error('not a token');
  const [h, p, sig] = parts as [string, string, string];
  const header = b64json(h), payload = b64json(p);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('wrong algorithm');
  const jwk = await signingKey(header.kid, opts.fetchImpl ?? fetch);
  if (!jwk) throw new Error('unknown key');
  const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(sig, 'base64url'));
  if (!ok) throw new Error('bad signature');
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (payload.aud !== projectId) throw new Error('wrong audience');
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('wrong issuer');
  if (typeof payload.exp !== 'number' || payload.exp <= now) throw new Error('expired');
  if (typeof payload.iat !== 'number' || payload.iat > now + 60) throw new Error('issued in the future');
  if (typeof payload.auth_time !== 'number' || payload.auth_time > now + 60) throw new Error('signed in in the future');
  if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 128) throw new Error('no subject');
  if (typeof payload.email !== 'string' || !payload.email) throw new Error('no e-mail');
  const firebase = (payload.firebase ?? {}) as { sign_in_provider?: string };
  return { uid: payload.sub, email: payload.email.toLowerCase(), emailVerified: payload.email_verified === true, provider: firebase.sign_in_provider ?? '' };
}

/** tests: forget the cached keys */
export function resetFirebaseKeys() { keys = null; }
