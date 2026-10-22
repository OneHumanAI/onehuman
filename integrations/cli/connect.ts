// SPDX-License-Identifier: Apache-2.0
/**
 * Connecting this app to onehuman.ai from the terminal, nothing to copy: the portal gives a short code, the browser
 * opens on it, the person signs in (or creates a free account) and presses Connect after checking the code matches the
 * one here, and the new API key arrives in this process. The key is what licenses OneHuman on the app's real domain.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export type Connected = { key: string; account: string | null };

/** open a URL in the default browser; quietly does nothing where there is none (a server, CI) */
export function openBrowser(href: string): boolean {
  if (process.env.CI || process.env.ONEHUMAN_NO_BROWSER) return false;
  const [cmd, args] = process.platform === 'darwin' ? ['open', [href]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', href]] : ['xdg-open', [href]];
  try { const p = spawn(cmd, args as string[], { stdio: 'ignore', detached: true }); p.on('error', () => {}); p.unref(); return true; } catch { return false; }
}

export async function connectApp(o: { name: string; portal?: string; open?: boolean; log?: (s: string) => void; timeoutMs?: number; fetch?: typeof fetch }): Promise<Connected | null> {
  const portal = (o.portal ?? process.env.ONEHUMAN_PORTAL_URL ?? 'https://onehuman.ai').replace(/\/+$/, '');
  const log = o.log ?? ((s: string) => console.log(s));
  const f = o.fetch ?? fetch;
  let start: { code: string; token: string; url: string; interval: number; expires: number };
  try {
    const r = await f(`${portal}/api/v1/connect/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: o.name.slice(0, 80) }), signal: AbortSignal.timeout(15_000) });
    if (!r.ok) { log(`  Could not reach ${portal} (${r.status}). Create a key at ${portal}/portal instead.`); return null; }
    start = await r.json() as typeof start;
  } catch { log(`  Could not reach ${portal}. Create a key at ${portal}/portal instead.`); return null; }

  log(`\n  Your code: ${start.code}`);
  const opened = o.open !== false && openBrowser(start.url);
  log(`  ${opened ? 'Opening' : 'Open'} ${start.url}`);
  log('  Sign in or create a free account, check the code is the same, and press Connect. Waiting…');

  const until = Math.min(start.expires, Date.now() + (o.timeoutMs ?? 10 * 60_000));
  const every = Math.max(1, start.interval || 2) * 1000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, every));
    let r: Response;
    try { r = await f(`${portal}/api/v1/connect/poll`, { headers: { Authorization: `Bearer ${start.token}` }, signal: AbortSignal.timeout(15_000) }); } catch { continue; }
    if (r.status === 202) continue;
    const b = await r.json().catch(() => ({})) as { key?: string; account?: string | null; message?: string };
    if (r.ok && b.key && /^oh_live_[a-f0-9]{40}$/.test(b.key)) return { key: b.key, account: b.account ?? null };
    log(`  ${b.message ?? 'The connection did not go through.'}`);
    return null;
  }
  log('  The code expired before Connect was pressed. Run the command again.');
  return null;
}

/** whether a .env file already sets ONEHUMAN_API_KEY */
export const envHasKey = (file: string) => existsSync(file) && /^ONEHUMAN_API_KEY=.+$/m.test(readFileSync(file, 'utf8'));

/** put ONEHUMAN_API_KEY in a .env file: added, or replaced when `replace` */
export function writeKeyToEnv(file: string, key: string, replace = false): 'added' | 'replaced' | 'kept' {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (/^ONEHUMAN_API_KEY=.+$/m.test(text)) {
    if (!replace) return 'kept';
    writeFileSync(file, text.replace(/^ONEHUMAN_API_KEY=.*$/m, `ONEHUMAN_API_KEY=${key}`));
    return 'replaced';
  }
  writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}ONEHUMAN_API_KEY=${key}\n`);
  return 'added';
}
