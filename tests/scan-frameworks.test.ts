// SPDX-License-Identifier: Apache-2.0
/** The scanner finds entry points that are not `app.get('/path')`: server actions, tRPC, oRPC and Hono. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { scan } from '../integrations/cli/scan.ts';

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'oh-scan-'));
  for (const [f, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), text); }
  return dir;
}
const find = (r: ReturnType<typeof scan>, re: RegExp) => r.routes.find((x) => re.test(x.path));

test('Next.js server actions: a use-server file and an inline action', () => {
  const r = scan(project({
    'app/actions/billing.ts': "'use server'\nimport { db } from './db'\nexport async function exportInvoices() { return db.invoice.findMany() }\nexport async function createApiKey(name: string) { return db.apiKey.create({ name }) }\nexport const cancelSubscription = async () => { await stripe.subscriptions.cancel('x') }\n",
    'app/team/page.tsx': "export default function Page() { async function inviteMember(form: FormData) { 'use server'\n await db.member.create({ email: form.get('email') }) } return null }\n",
  }));
  assert.ok(r.frameworks.includes('server-actions'));
  const exp = find(r, /export-invoices/);
  assert.ok(exp && exp.method === 'POST' && exp.kind !== 'read' && exp.sensitivity >= 30, 'an export action is sensitive');
  assert.ok(find(r, /create-api-key/)?.signals.includes('credentials'), 'an API key action is a credential');
  assert.ok(find(r, /cancel-subscription/) && find(r, /invite-member/), 'arrow actions and inline actions are found');
});

test('tRPC: queries are reads, mutations are writes, the router name is part of the path', () => {
  const r = scan(project({
    'server/routers/customers.ts': "import { createTRPCRouter, protectedProcedure } from '../trpc'\nexport const customersRouter = createTRPCRouter({\n  list: protectedProcedure.input(z.object({})).query(({ ctx }) => ctx.db.customer.findMany()),\n  exportAll: protectedProcedure.mutation(async ({ ctx }) => csv(await ctx.db.customer.findMany())),\n  delete: protectedProcedure.input(z.string()).mutation(({ ctx, input }) => ctx.db.customer.delete({ where: { id: input } })),\n})\n",
  }));
  assert.ok(r.frameworks.includes('trpc'));
  assert.equal(find(r, /customers\.list/)?.method, 'GET');
  const ex = find(r, /customers\.export-all/);
  assert.ok(ex && ex.method === 'POST' && ex.kind === 'download', 'exportAll is read as an export');
  assert.equal(find(r, /customers\.delete/)?.method, 'POST');
});

test('oRPC: handlers keep their route and method when they declare one', () => {
  const r = scan(project({
    'src/router.ts': "import { os } from '@orpc/server'\nexport const router = {\n  exportContacts: os.route({ method: 'GET', path: '/contacts/export' }).handler(async () => csv(await db.contact.all())),\n  createWebhook: os.input(z.object({ url: z.string() })).handler(async ({ input }) => db.webhook.create(input)),\n}\n",
  }));
  assert.ok(r.frameworks.includes('orpc'));
  assert.equal(find(r, /^\/contacts\/export$/)?.method, 'GET');
  assert.ok(find(r, /create-webhook/), 'a handler without a route gets a name-based path');
});

test('Hono: chained routes, a base path and a mounted router', () => {
  const r = scan(project({
    'src/index.ts': "import { Hono } from 'hono'\nimport { admin } from './admin'\nconst app = new Hono().basePath('/api')\napp.route('/admin', admin)\napp\n  .get('/balance', (c) => c.json({ balance: 5 }))\n  .post('/transfers', (c) => c.json({ ok: true }))\nexport default app\n",
    'src/admin.ts': "import { Hono } from 'hono'\nexport const admin = new Hono()\nadmin.get('/users/export', (c) => c.text('csv'))\n",
  }));
  assert.ok(r.frameworks.includes('hono'));
  assert.ok(find(r, /^\/api\/balance$/), 'the chain after a base path');
  assert.equal(find(r, /^\/api\/transfers$/)?.method, 'POST');
  assert.ok(find(r, /^\/admin\/users\/export$/), 'a router mounted with app.route()');
});

test('a plain Express app is still found as Express, not as one of the new families', () => {
  const r = scan(project({ 'server.js': "const express = require('express'); const app = express();\napp.get('/api/balance', (req, res) => res.json({ balance: 1 }));\n" }));
  assert.deepEqual(r.frameworks, ['express']);
});
