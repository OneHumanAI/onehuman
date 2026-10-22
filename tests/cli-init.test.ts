// SPDX-License-Identifier: Apache-2.0
/** `onehumanai init --yes` wires an Express app: rules, secret, setup module, middleware and protect() on the chosen routes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoMask } from '../integrations/express/index.ts';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../integrations/cli/index.ts', import.meta.url));
const run = (dir: string) => spawnSync(process.execPath, [CLI, 'init', dir, '--yes', '--no-install'], { encoding: 'utf8' });

test('an ES-module Express app is wired end to end, and a second run changes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oh-init-esm-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'bank', type: 'module', scripts: { start: 'node server.js' }, dependencies: { express: '^4' } }, null, 2));
  writeFileSync(join(dir, 'server.js'), [
    "import express from 'express';",
    '',
    'const app = express();',
    "app.get('/api/balance', (req, res) => res.json({ id: 'a', balance: 5, owner: req.session?.userId }));",
    "app.get('/api/statements/export', (req, res) => res.send('csv'));",
    "app.get('/health', (req, res) => res.send('ok'));",
    'app.listen(3000);',
  ].join('\n'));
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /Want help going live\? Book 15 min: cal\.com\/onehumanai/, 'init ends with the offer to help');
  const server = readFileSync(join(dir, 'server.js'), 'utf8');
  assert.match(server, /^import \{ onehuman \} from '\.\/onehuman\.js';$/m);
  assert.match(server, /const app = express\(\);\napp\.use\(onehuman\.middleware\(\)\);/);
  assert.match(server, /app\.get\('\/api\/balance', onehuman\.protect\('balance\.read', \{ mask: 'auto' \}\),/);
  assert.match(server, /app\.get\('\/api\/statements\/export', onehuman\.protect\('statements\.export'\),/, 'not statements.export.export');
  assert.doesNotMatch(server, /'\/health', onehuman/, 'a health check is not protected');
  const setup = readFileSync(join(dir, 'onehuman.js'), 'utf8');
  assert.match(setup, /identify: \(req\) => req\.session\?\.userId \?\? null/);
  const policy = JSON.parse(readFileSync(join(dir, 'onehuman.policy.json'), 'utf8'));
  assert.equal(policy.enforcement, 'observe', 'the recommended start is watching only');
  assert.deepEqual(policy.rules.map((x: { resource: string }) => x.resource).sort(), ['balance.read', 'statements.export']);
  assert.match(readFileSync(join(dir, '.env'), 'utf8'), /^ONEHUMAN_SECRET=[a-f0-9]{64}$/m);
  assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /^\.env$/m);
  assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts.start, 'node --env-file-if-exists=.env server.js');

  const again = run(dir);
  assert.equal(again.status, 0);
  assert.equal(readFileSync(join(dir, 'server.js'), 'utf8'), server, 'idempotent');
});

test('a CommonJS app with routes in their own file gets require() in both files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oh-init-cjs-'));
  mkdirSync(join(dir, 'routes'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'crm', dependencies: { express: '^4' } }));
  writeFileSync(join(dir, 'app.js'), "const express = require('express');\nconst accounts = require('./routes/accounts');\n\nconst app = express();\napp.use('/api', accounts);\napp.listen(3000);\n");
  writeFileSync(join(dir, 'routes', 'accounts.js'), "const express = require('express');\nconst router = express.Router();\nrouter.get('/customers', (req, res) => res.json([]));\nmodule.exports = router;\n");
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(readFileSync(join(dir, 'routes', 'accounts.js'), 'utf8'), /const \{ onehuman \} = require\('\.\.\/onehuman\.js'\);[\s\S]*router\.get\('\/customers', onehuman\.protect\('customers\.read', \{ mask: 'auto' \}\),/);
  assert.match(readFileSync(join(dir, 'app.js'), 'utf8'), /app\.use\(onehuman\.middleware\(\)\);/);
  assert.match(readFileSync(join(dir, 'onehuman.js'), 'utf8'), /require\('onehumanai'\)[\s\S]*module\.exports = \{ onehuman \}/);
  assert.ok(!existsSync(join(dir, 'onehuman.mjs')));
});

test("mask: 'auto' hides every value and keeps the shape and ids", () => {
  assert.deepEqual(autoMask({ id: 7, balance: 10.5, owner: 'Ada', active: true, items: [{ _id: 'x', memo: 'rent' }], none: null }),
    { id: 7, balance: null, owner: '••••', active: true, items: [{ _id: 'x', memo: '••••' }], none: null });
  assert.deepEqual(autoMask({ balance: 4939.1, currency: 'USD', status: 'active', date: '2026-09-28', iban: 'GB29NWBK60161331926819' }), { balance: null, currency: 'USD', status: 'active', date: '2026-09-28', iban: '••••' }, 'codes, status and dates stay: the page can still say "USD ••••"');
});

test('init installs with the project\'s own package manager (npm breaks inside a pnpm node_modules)', async () => {
  const { packageManager } = await import('../integrations/cli/init.ts');
  const at = (files: string[]) => { const d = mkdtempSync(join(tmpdir(), 'oh-pm-')); for (const f of files) { mkdirSync(join(d, f, '..'), { recursive: true }); writeFileSync(join(d, f), ''); } return d; };
  assert.deepEqual(packageManager(at(['node_modules/.pnpm/x']), {}), ['pnpm', 'add']);
  assert.deepEqual(packageManager(at(['yarn.lock']), {}), ['yarn', 'add']);
  assert.deepEqual(packageManager(at(['package-lock.json']), { packageManager: 'pnpm@9.0.0' }), ['pnpm', 'add']);
  const ws = at(['pnpm-workspace.yaml', 'apps/api/package.json']);
  assert.deepEqual(packageManager(join(ws, 'apps', 'api'), {}), ['pnpm', 'add'], 'a workspace lockfile above the app counts');
  assert.deepEqual(packageManager(at(['package-lock.json']), {}), ['npm', 'install']);
});

test('a router in its own file with its own name is found; login is never proposed; the policy it writes starts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oh-init-router-'));
  mkdirSync(join(dir, 'routes')); mkdirSync(join(dir, 'public'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'payroll', type: 'module', dependencies: { express: '^5' } }));
  writeFileSync(join(dir, 'server.js'), [
    "import express from 'express';",
    "import { payroll } from './routes/payroll.js';",
    'const app = express();',
    "app.post('/api/login', (req, res) => res.json({ ok: true, password: req.body?.password && 1 }));",
    "app.use('/api/hr', payroll);",
    'const port = Number(process.env.PORT ?? 3100);',
    'app.listen(port);',
  ].join('\n'));
  writeFileSync(join(dir, 'routes', 'payroll.js'), [
    "import { Router } from 'express';",
    'export const payroll = Router();',
    "payroll.get('/employees', (req, res) => res.json({ salary: 1, iban: 'AZ', by: req.session.user.email }));",
    "payroll.get('/employees/:id', (req, res) => res.json({ salary: 1, iban: 'AZ' }));",
    "payroll.post('/payroll/run', (req, res) => res.json({ ok: true }));",
  ].join('\n'));
  writeFileSync(join(dir, 'public', 'index.html'), '<html><head><title>x</title><script src="/app.js"></script></head><body></body></html>');
  writeFileSync(join(dir, 'public', 'app.js'), "const r = await fetch('/api/hr/employees');\nconst j = await window.fetch('/x');\n");
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const routes = readFileSync(join(dir, 'routes', 'payroll.js'), 'utf8');
  assert.match(routes, /payroll\.get\('\/employees', onehuman\.protect\('hr\.employees\.read'/, 'found under its mount prefix');
  assert.match(routes, /payroll\.post\('\/payroll\/run', onehuman\.protect\(/);
  assert.doesNotMatch(readFileSync(join(dir, 'server.js'), 'utf8'), /'\/api\/login', onehuman/, 'login is never protected');
  const policy = JSON.parse(readFileSync(join(dir, 'onehuman.policy.json'), 'utf8'));
  const ids = policy.rules.map((x: { resource: string }) => x.resource);
  assert.equal(new Set(ids).size, ids.length, 'one rule per resource, although two routes share hr.employees.read');
  const { checkPolicy } = await import('../server/policy.ts');
  assert.ok('policy' in checkPolicy(policy, 'v'), 'the engine accepts what init wrote');
  assert.match(readFileSync(join(dir, 'onehuman.js'), 'utf8'), /identify: \(req\) => req\.session\?\.user\?\.email \?\? null/, 'a login id, not the user object');
  // the page's own code is not rewritten: the script tag carries the click behind every same-origin request
  assert.equal(readFileSync(join(dir, 'public', 'app.js'), 'utf8'), "const r = await fetch('/api/hr/employees');\nconst j = await window.fetch('/x');\n");
  assert.match(readFileSync(join(dir, 'public', 'index.html'), 'utf8'), /<script src="\/onehuman\/sdk\.js" data-fetch="auto" data-step-up="auto"><\/script>\s*<script src="\/app\.js">/, 'the page script comes before the page\'s own');
  assert.match(r.stdout, /verify http:\/\/localhost:3100 \/api\/hr\/employees/, 'the check uses the real port and a GET route');
});

test('paths with dashes, digits and odd characters still give resources the engine accepts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oh-init-names-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'shop', type: 'module', dependencies: { express: '^5' } }));
  writeFileSync(join(dir, 'server.js'), [
    "import express from 'express';",
    'const app = express();',
    "app.patch('/api/payout-account', (req, res) => res.json({ ok: true, iban: 'AZ', by: req.session.userId }));",
    "app.post('/api/2fa/backup-codes', (req, res) => res.json({ codes: [1], password: 1 }));",
    "app.get('/api/user-settings/api-keys', (req, res) => res.json({ apiKey: 'x', secret: 'y' }));",
    'app.listen(3000);',
  ].join('\n'));
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const policy = JSON.parse(readFileSync(join(dir, 'onehuman.policy.json'), 'utf8'));
  const ids: string[] = policy.rules.map((x: { resource: string }) => x.resource);
  assert.ok(ids.includes('payout_account.make'), ids.join(', '));
  for (const id of ids) assert.match(id, /^[a-z][a-z0-9_.]{1,60}$/);
  const { checkPolicy } = await import('../server/policy.ts');
  const c = checkPolicy(policy, 'v');
  assert.ok('policy' in c, 'error' in c ? c.error : '');
  assert.match(readFileSync(join(dir, 'server.js'), 'utf8'), /onehuman\.protect\('payout_account\.make'/, 'the route uses the same name as its rule');
});

test('a policy with a problem names it', async () => {
  const { checkPolicy } = await import('../server/policy.ts');
  const rule = { resource: 'a.read', title: 'A', onAgent: 'mask', onArtifact: 'mask', onUnknown: 'allow', onHumanLike: 'allow', actOn: ['strong'], minScore: 65 };
  const c = checkPolicy({ enforcement: 'enforce', rules: [rule, rule] }, 'v');
  assert.ok('error' in c && /"a\.read" appears twice/.test(c.error));
});

test('the dependency the package manager adds stays in package.json (init writes its files first)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oh-init-dep-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'shop', type: 'module', scripts: { start: 'node server.js' }, dependencies: { express: '^5' } }, null, 2));
  writeFileSync(join(dir, 'package-lock.json'), '{}');
  writeFileSync(join(dir, 'server.js'), "import express from 'express';\nconst app = express();\napp.get('/api/balance', (req, res) => res.json({ balance: 5 }));\napp.listen(3000);\n");
  // a stand-in npm: `npm install onehumanai` records the dependency the way npm does
  const bin = mkdtempSync(join(tmpdir(), 'oh-fake-npm-'));
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\nexec "${process.execPath}" -e "const f=require('fs');const p=JSON.parse(f.readFileSync('package.json','utf8'));p.dependencies={...p.dependencies,onehumanai:'^0.6.1'};f.writeFileSync('package.json',JSON.stringify(p,null,2))"\n`, { mode: 0o755 });
  const r = spawnSync(process.execPath, [CLI, 'init', dir, '--yes'], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies.onehumanai, '^0.6.1', 'installed and listed');
  assert.match(pkg.scripts.start, /--env-file-if-exists=\.env/, 'and init\'s own change is there too');
});

test('behind a login: OneHuman goes after the session middleware and after each route\'s own login check; reads follow the documented matrix', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oh-init-login-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'bank', type: 'module', scripts: { start: 'node server.js' }, dependencies: { express: '^5', 'express-session': '^1' } }, null, 2));
  writeFileSync(join(dir, 'server.js'), [
    "import express from 'express';",
    "import session from 'express-session';",
    'const app = express();',
    'app.use(express.json());',
    "app.use(session({ secret: 's', resave: false, saveUninitialized: false }));",
    'const requireLogin = (req, res, next) => (req.session.userId ? next() : res.status(401).end());',
    "app.get('/api/me', requireLogin, (req, res) => res.json({ name: 'Ada', email: 'a@example.com' }));",
    "app.get('/api/transactions', requireLogin, (req, res) => res.json({ rows: [] }));",
    "app.post('/api/transfer', requireLogin, (req, res) => res.json({ ok: true }));",
    'app.listen(3000);',
  ].join('\n'));
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const server = readFileSync(join(dir, 'server.js'), 'utf8');
  assert.match(server, /app\.use\(session\(\{[^\n]*\}\)\);\napp\.use\(onehuman\.middleware\(\)\);/, 'after express-session, so identify() sees the login on the page script\'s requests');
  assert.match(server, /app\.get\('\/api\/me', requireLogin, onehuman\.protect\('me\.read'/, 'after the route\'s own login check');
  assert.match(server, /app\.post\('\/api\/transfer', requireLogin, onehuman\.protect\('transfer\.make'\)/);
  const rules = Object.fromEntries(JSON.parse(readFileSync(join(dir, 'onehuman.policy.json'), 'utf8')).rules.map((x: { resource: string; onAgent: string }) => [x.resource, x.onAgent]));
  assert.equal(rules['me.read'], 'mask', 'personal data: hidden from an agent, not refused (the documented matrix)');
  assert.equal(rules['transactions.read'], 'mask');
  assert.equal(rules['transfer.make'], 'block');
  assert.match(r.stdout, /verify http:\/\/localhost:3000 \/api\/[a-z]+ --cookie/, 'the check names the login cookie');
  assert.match(r.stdout, /data-oh-sensitive="full"/, 'it says how to hide what is already on screen');
});

test('a login set by the app\'s own middleware is found (req.user = …), and init\'s own file is not read as the app', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oh-init-requser-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'shop', scripts: { start: 'node index.js' }, dependencies: { express: '^4' } }, null, 2));
  writeFileSync(join(dir, 'index.js'), [
    "const express = require('express');",
    'const app = express();',
    "app.use((req, _res, next) => { req.user = req.headers['x-user'] ? { id: req.headers['x-user'] } : null; next(); });",
    "app.get('/api/orders', (req, res) => res.json({ orders: [] }));",
    'app.listen(3100);',
  ].join('\n'));
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(readFileSync(join(dir, 'onehuman.js'), 'utf8'), /identify: \(req\) => req\.user\?\.id \?\? null/);
  assert.equal(run(dir).status, 0);
  assert.match(readFileSync(join(dir, 'onehuman.js'), 'utf8'), /identify: \(req\) => req\.user\?\.id \?\? null/, 'unchanged on a second run');
});

test('--help lists every command and the verify options; an unknown command says so', () => {
  const h = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.equal(h.status, 0);
  for (const w of ['init', 'verify', '--cookie', '--attach', 'scan', 'inspect', 'report', 'verify-proof', 'proof-keys', 'anchors', 'sidecar', 'secret']) assert.ok(h.stdout.includes(w), w);
  const u = spawnSync(process.execPath, [CLI, 'nope'], { encoding: 'utf8' });
  assert.equal(u.status, 2);
  assert.match(u.stderr, /unknown command "nope"/);
});
