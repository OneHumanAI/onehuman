// SPDX-License-Identifier: BUSL-1.1
/**
 * Rate limits for the public deployment.
 *
 *   db      counters in the database (table rate_limits): the same on every serverless instance. For the few
 *           paths where one request is expensive or security-relevant: sign-up, login, new demo rooms, the AI
 *           assistant, proof verification.
 *   memory  a per-instance window for the rest of /api: cheap, catches a single client hammering one instance.
 *
 * Clients are counted by a keyed hash of their IP address; the address itself is never stored.
 */
import { createHmac, hkdfSync, randomBytes } from 'node:crypto';
import type { SiteStore } from './site-db.ts';
import type { Req } from './http.ts';

/** The client's address as the platform reports it (Vercel: x-forwarded-for / x-real-ip). */
export function clientIp(req: Req): string {
  const xff = req.headers['x-forwarded-for'];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
  return first || String(req.headers['x-real-ip'] ?? '') || req.socket?.remoteAddress || '';
}

export function limiter(store: SiteStore, secret: Buffer | undefined) {
  const key = secret ? Buffer.from(hkdfSync('sha256', secret, 'onehuman', 'rate-limit-client', 32)) : randomBytes(32);
  const client = (req: Req) => createHmac('sha256', key).update(clientIp(req)).digest('hex').slice(0, 20);
  const mem = new Map<string, { n: number; at: number }>();

  return {
    client,
    /** true when `name` has been hit more than `max` times in the current window (this hit counted) */
    async over(name: string, who: string, max: number, windowMs: number): Promise<boolean> {
      try { return (await store.hitLimit(`${name}:${who}`, windowMs)) > max; } catch { return false; }
    },
    /**
     * per-instance: more than `max` requests in `windowMs` from this address ('ip': a whole office or class behind
     * one NAT) or from this browser on it ('device'), counted separately per `name`
     */
    burst(req: Req, max: number, windowMs: number, scope: 'ip' | 'device' = 'ip', name = ''): boolean {
      const k = `${name}:${scope === 'device' ? createHmac('sha256', key).update(`${clientIp(req)}|${String(req.headers['user-agent'] ?? '')}`).digest('hex').slice(0, 20) : client(req)}`;
      const now = Date.now();
      const w = mem.get(k);
      if (!w || now - w.at > windowMs) { mem.set(k, { n: 1, at: now }); if (mem.size > 20000) mem.clear(); return false; }
      return ++w.n > max;
    },
  };
}
