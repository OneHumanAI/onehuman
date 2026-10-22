// SPDX-License-Identifier: BUSL-1.1
/**
 * The visit log of onehuman.ai itself: who visited and from which kind of device.
 *
 *   privacy  no raw IP and no raw user agent are stored: a keyed hash of both identifies a device, plus the browser
 *            and OS family, mobile or not, and the country/city the host reports; visits are kept 90 days
 */
import { createHmac, hkdfSync, randomBytes } from 'node:crypto';
import type { SiteStore } from './site-db.ts';
import { clientIp } from './limits.ts';
import { json, url, type Req, type Res } from './http.ts';
import type { Row } from './sql.ts';
import { APPS } from './apps.ts';
import { demoPolicy } from './demo-report.ts';

const KEEP_MS = 90 * 86400000;
const DAY = 86400000;

// ---------------------------------------------------------------------------------------------- devices

/** Browser and OS family from a user agent; the raw string is never stored. */
export function uaFamily(ua: string): { browser: string; os: string; mobile: boolean; bot: boolean } {
  // link previews (a link shared in WhatsApp, Telegram, Slack…) open the page too; they are not people
  const bot = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|headless|lighthouse|pingdom|uptime|monitor|WhatsApp|Telegram|Slack|Discord|LinkedIn|Twitter|Viber|SkypeUriPreview|vkShare|Pinterest|redditbot|Iframely|Google-Read-Aloud/i.test(ua);
  const app = /\bClaude\/[\d.]+/.test(ua) ? 'Claude app' : /ChatGPT|Atlas\//.test(ua) ? 'ChatGPT Atlas' : /Comet\//.test(ua) ? 'Comet' : null;
  const browser = app
    ?? (/Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung' : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
      : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /^curl\//.test(ua) ? 'curl' : /python|node|axios|go-http|wget|java\//i.test(ua) ? 'script' : ua ? 'other' : 'none');
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows'
    : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'other';
  return { browser, os, mobile: /Mobi|iPhone|Android.+Mobile/.test(ua), bot };
}

/** Pages, and the calls that change something. Polling, SDK signals and customer telemetry have their own tables. */
function kindOf(method: string, path: string): 'page' | 'action' | null {
  if (path.startsWith('/api/v1/ops') || path.startsWith('/api/v1/admin') || path.startsWith('/admin-panel') || path === '/api/v1/visit') return null;
  if (method === 'GET') {
    if (path.startsWith('/api/') || path.startsWith('/sdk/') || path.startsWith('/onehuman/') || /\.[a-z0-9]{1,5}$/i.test(path)) return null;
    return 'page';
  }
  if (!path.startsWith('/api/')) return null;
  if (/^\/api\/v1\/(signals|ingest|sandbox\/noop|key-policy)/.test(path)) return null;
  return 'action';
}

export function visitLog(store: SiteStore, secret: Buffer | undefined, accountOf: (req: Req) => Promise<string | null>) {
  const key = secret ? Buffer.from(hkdfSync('sha256', secret, 'onehuman', 'ops-device-id', 32)) : randomBytes(32);
  const deviceOf = (req: Req): string => createHmac('sha256', key).update(`${clientIp(req)}|${String(req.headers['user-agent'] ?? '')}`).digest('hex').slice(0, 16);

  // A flood from one client must not become a flood of log rows: at most PER_MINUTE rows per device per instance,
  // and answers that were refused for rate (429) are not logged at all.
  const PER_MINUTE = 60;
  const recent = new Map<string, { n: number; at: number }>();
  const allowed = (device: string) => {
    const now = Date.now(); const w = recent.get(device);
    if (!w || now - w.at > 60e3) { recent.set(device, { n: 1, at: now }); if (recent.size > 20000) recent.clear(); return true; }
    return ++w.n <= PER_MINUTE;
  };

  /** a page served from the CDN cache, counted by its beacon */
  async function page(req: Req, path: string, referrer: string | null): Promise<void> {
    try {
      const device = deviceOf(req);
      if (!allowed(device)) return;
      const fam = uaFamily(String(req.headers['user-agent'] ?? ''));
      const h = (n: string) => { const v = req.headers[n]; const x = Array.isArray(v) ? v[0] : v; return x ? decodeURIComponent(x).slice(0, 60) : null; };
      await store.addVisit({ at: Date.now(), device, account: null, method: 'GET', path, kind: 'page', status: 200, ms: 0, ...fam, country: h('x-vercel-ip-country'), city: h('x-vercel-ip-city'), referrer: referrer || null }, KEEP_MS);
    } catch { /* never breaks anything */ }
  }

  /** called after the response is sent; never throws */
  async function record(req: Req, res: Res, startedAt: number): Promise<void> {
    try {
      const u = url(req);
      const method = req.method ?? 'GET';
      const kind = kindOf(method, u.pathname);
      if (!kind || res.statusCode === 429) return;
      if (kind === 'page' && String(res.getHeader('Cache-Control') ?? '').startsWith('public')) return;   // edge-cached page: its beacon counts it
      if (!allowed(deviceOf(req))) return;
      const ua = String(req.headers['user-agent'] ?? '');
      const fam = uaFamily(ua);
      // internet-wide scanners probing for leaked files are not visitors, whatever browser they claim
      if (/^\/(\.env|\.git|wp-|wordpress|xmlrpc|phpmyadmin|cgi-bin|vendor\/|\.aws|\.ssh|server-status)|\.(php|asp|aspx|jsp|bak|sql)$/i.test(u.pathname)) fam.bot = true;
      const h = (n: string) => { const v = req.headers[n]; const s = Array.isArray(v) ? v[0] : v; return s ? decodeURIComponent(s).slice(0, 60) : null; };
      let referrer: string | null = null;
      try { const r = req.headers.referer; if (r) { const rh = new URL(r).host; if (rh && rh !== req.headers.host) referrer = rh.slice(0, 80); } } catch { /* bad referer */ }
      const account = u.pathname.startsWith('/api/v1/portal') || u.pathname === '/portal' ? await accountOf(req).catch(() => null) : null;
      await store.addVisit({
        at: startedAt, device: deviceOf(req), account, method, path: u.pathname.slice(0, 160), kind, status: res.statusCode, ms: Date.now() - startedAt,
        ...fam, country: h('x-vercel-ip-country'), city: h('x-vercel-ip-city'), referrer,
      }, KEEP_MS);
    } catch { /* the log must never break a request */ }
  }
  return { deviceOf, record, page };
}
