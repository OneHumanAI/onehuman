// SPDX-License-Identifier: BUSL-1.1
import { mkdirSync } from 'node:fs';
import { createApp } from './app.ts';
import { clientFromEnv } from './sql.ts';
import { transportFromEnv } from './mail.ts';

// local settings (e.g. OPENROUTER_API_KEY for the policy assistant) from a git-ignored .env, when there is one
try { process.loadEnvFile('.env'); } catch { /* none */ }

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
if (!process.env.TURSO_DATABASE_URL && (process.env.ONEHUMAN_DB ?? 'data/lab.db') !== ':memory:') mkdirSync('data', { recursive: true });

const db = await clientFromEnv();
const { server, mail } = await createApp({
  client: db.client,
  secret: process.env.ONEHUMAN_SECRET ? Buffer.from(process.env.ONEHUMAN_SECRET, 'utf8') : undefined,
  labOperator: process.env.ONEHUMAN_LAB_OPERATOR !== '0',
  mailTransport: transportFromEnv({ serverless: false, root: process.cwd() }),
});

// the daily e-mail run (on Vercel a cron does this): an hour after start, then every hour; each mail goes out once
const runMail = () => mail.runDaily().then((r) => { if (r.sent || r.failed) console.log(`mail: ${r.sent} sent, ${r.failed} failed (${mail.transport})`); }, (e) => console.warn('mail run failed', e));
setTimeout(runMail, 60_000).unref(); setInterval(runMail, 3600e3).unref();

server.listen(port, host, () => {
  console.log(`OneHuman → http://${host}:${port}/   db=${db.kind}:${db.label}`);
});
