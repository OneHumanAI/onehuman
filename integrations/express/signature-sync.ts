// SPDX-License-Identifier: Apache-2.0
/**
 * Keeps this server's agent signatures current.
 *
 *   start          the last accepted bundle is loaded from the local database (checked again), else built-ins only
 *   every 6 hours  the portal is asked for the newest bundle (a 304 when nothing changed)
 *   a new bundle   is used only if OneHuman's signatures key signed it, its seq is higher than the one in use,
 *                  and this engine is new enough (minEngine); it is then saved locally for the next start
 *   portal down    nothing changes: the bundle in use stays in use
 */
import { engineAtLeast, verifySignatureBundle, type SignatureBundle } from '../signatures/common.ts';

type StoreLike = {
  policyCache(tag: string): Promise<{ envelope: string; fetched: number } | null>;
  putPolicyCache(tag: string, c: { envelope: string; pinnedKey: string; fetched: number }): Promise<void>;
};
type Apply = (rules: SignatureBundle['rules'], meta: { seq: number; issued: number; note: string | null; source: 'cache' | 'portal' }) => void;

const TAG = 'signatures:global';

export type SignatureStatus = { seq: number; issued: number | null; source: 'builtin' | 'cache' | 'portal'; lastCheckAt: number | null; problem: string | null };

export function createSignatureSync(o: { store: StoreLike; apiKey: string | null; portalUrl: string; engineVersion: string; apply: Apply; log?: (m: string) => void; checkEveryMs?: number }) {
  const log = o.log ?? ((m: string) => console.log(`onehuman: ${m}`));
  const every = o.checkEveryMs ?? 6 * 3600e3;
  let status: SignatureStatus = { seq: 0, issued: null, source: 'builtin', lastCheckAt: null, problem: null };
  let inflight: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;

  /** use a bundle if it is genuine, newer than the one in use, and meant for this engine */
  function consider(jws: string, source: 'cache' | 'portal'): boolean {
    const c = verifySignatureBundle(jws);
    if (!c.ok) { status.problem = `a signature bundle from the ${source === 'cache' ? 'saved copy' : 'portal'} failed its check (${c.reason}) and was not used`; log(status.problem); return false; }
    const b = c.bundle;
    if (b.seq <= status.seq) return false;
    if (!engineAtLeast(o.engineVersion, b.minEngine)) { status.problem = `signature bundle ${b.seq} needs engine ${b.minEngine} or newer; update onehuman to use it`; return false; }
    o.apply(b.rules, { seq: b.seq, issued: b.issued, note: b.note ?? null, source });
    status = { ...status, seq: b.seq, issued: b.issued, source, problem: null };
    log(`agent signatures ${b.seq} in use (${source === 'portal' ? 'from the portal' : 'saved copy'}${b.note ? `: ${b.note}` : ''})`);
    return true;
  }

  async function check(): Promise<void> {
    status.lastCheckAt = Date.now();
    if (!o.apiKey) return;
    let r: Response;
    try {
      r = await fetch(`${o.portalUrl.replace(/\/$/, '')}/api/v1/signatures`, {
        headers: { Authorization: `Bearer ${o.apiKey}`, ...(status.seq ? { 'If-None-Match': `"sigs-${status.seq}"` } : {}) },
        signal: AbortSignal.timeout(8000),
      });
    } catch { return; }
    if (r.status !== 200) return;
    const body = await r.json().catch(() => null) as { envelope?: string } | null;
    if (body?.envelope && consider(body.envelope, 'portal')) await o.store.putPolicyCache(TAG, { envelope: body.envelope, pinnedKey: '', fetched: Date.now() }).catch(() => {});
  }
  const checkOnce = () => { if (!inflight) inflight = check().catch(() => {}).finally(() => { inflight = null; }); return inflight; };

  return {
    async init() {
      const saved = await o.store.policyCache(TAG).catch(() => null);
      if (saved?.envelope) consider(saved.envelope, 'cache');
      void checkOnce();   // never delays start-up
      timer = setInterval(() => void checkOnce(), every); timer.unref?.();
    },
    /** on a platform that freezes between requests the interval never fires: a stale check starts here */
    maybeRefresh() { if (!inflight && o.apiKey && (status.lastCheckAt === null || Date.now() - status.lastCheckAt > every)) void checkOnce(); },
    refresh: checkOnce,
    status: (): SignatureStatus => ({ ...status }),
    close() { if (timer) clearInterval(timer); timer = null; },
  };
}
