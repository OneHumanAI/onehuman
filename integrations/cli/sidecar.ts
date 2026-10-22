// SPDX-License-Identifier: Apache-2.0
/**
 * `npx onehumanai sidecar` — run the OneHuman engine next to a backend that is not Node (Python, C#, Java …).
 * Reads the same files `init` writes: onehuman.policy.json and ONEHUMAN_SECRET (from the environment or .env).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startSidecar } from '../sidecar/index.ts';

/** Minimal .env reader: KEY=value lines, existing environment wins. */
export function loadEnv(file: string) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
}

export async function runSidecar(o: { flag: (n: string) => string | undefined; has: (n: string) => boolean }) {
  const dir = resolve(o.flag('--dir') ?? process.cwd());
  loadEnv(resolve(dir, '.env'));
  const secret = process.env.ONEHUMAN_SECRET ?? '';
  const policy = resolve(dir, o.flag('--policy') ?? 'onehuman.policy.json');
  if (secret.length < 32 || !existsSync(policy)) {
    console.error(!existsSync(policy) ? `No rules file at ${policy}. Run \`npx onehumanai init\` first.` : 'ONEHUMAN_SECRET is missing or shorter than 32 characters. Run `npx onehumanai init`, or `npx onehumanai secret` and put it in .env.');
    process.exit(2);
  }
  const db = o.flag('--db') ?? process.env.ONEHUMAN_DB ?? `sqlite:${resolve(dir, 'onehuman.db')}`;
  const port = Number(o.flag('--port') ?? process.env.ONEHUMAN_SIDECAR_PORT ?? 8788);
  const host = o.flag('--host') ?? process.env.ONEHUMAN_SIDECAR_HOST ?? '127.0.0.1';
  const sc = await startSidecar({ secret, policy, db, port, host });
  const h = (await fetch(`${sc.url}/v1/health`).then((r) => r.json()).catch(() => null)) as { policy?: { version?: string; enforcement?: string } } | null;
  console.log(`OneHuman sidecar on ${sc.url}  (rules ${h?.policy?.version ?? '?'}, ${h?.policy?.enforcement ?? '?'} mode, storage ${db.replace(/authToken=[^&]+/, 'authToken=…')})`);
  console.log('Your app forwards /onehuman/* here and asks POST /v1/decide before protected handlers. Ctrl+C stops it.');
  const stop = () => { sc.close().finally(() => process.exit(0)); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
