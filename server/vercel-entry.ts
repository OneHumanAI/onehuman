// SPDX-License-Identifier: BUSL-1.1
/**
 * Vercel serverless entry. One function serves every route; `vercel.json` rewrites all paths here.
 *
 * Storage is Cloud Firestore in the onehuman-ai project (FIREBASE_PROJECT_ID): every instance shares rooms, sessions,
 * accounts and reports, and the function signs in to Google with its Vercel OIDC token (no key file). The same
 * variable turns on sign-in through Firebase Authentication. TURSO_DATABASE_URL (libSQL) still works for a deployment
 * that has not moved. With neither, the app boots on an in-memory database so the landing page and docs render.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp, type Handler } from '../server/app.ts';
import { libsqlClient, sqliteClient } from '../server/sql.ts';
import { transportFromEnv } from '../server/mail.ts';
import { FireSiteStore, firestoreFromEnv } from '../server/fire-store.ts';

let handlerPromise: Promise<Handler> | null = null;

async function boot(): Promise<Handler> {
  const secret = process.env.ONEHUMAN_SECRET ? Buffer.from(process.env.ONEHUMAN_SECRET, 'utf8') : undefined;
  const base = { secret, labOperator: true, serverless: true, mailTransport: transportFromEnv({ serverless: true, root: process.cwd() }) };
  const firestore = await firestoreFromEnv();
  if (firestore) return (await createApp({ ...base, store: FireSiteStore.connect(firestore) })).handler;
  const url = process.env.TURSO_DATABASE_URL;
  if (url) return (await createApp({ ...base, client: await libsqlClient(url, process.env.TURSO_AUTH_TOKEN) })).handler;
  console.warn('no database configured (FIREBASE_PROJECT_ID or TURSO_DATABASE_URL): running on an ephemeral in-memory database');
  return (await createApp({ ...base, client: await sqliteClient(':memory:'), ephemeral: true, mailTransport: null })).handler;
}

async function handler(req: IncomingMessage, res: ServerResponse) {
  handlerPromise ??= boot().catch((e) => { handlerPromise = null; throw e; });
  const h = await handlerPromise;
  await h(req, res);
}

// Vercel's Node runtime accepts either `module.exports = fn` or a default export; esbuild (cjs) maps `export default` to `.default`,
// so export both shapes explicitly.
export default handler;
export { handler };
