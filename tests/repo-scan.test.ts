// SPDX-License-Identifier: BUSL-1.1
/**
 * The public repository scan: the archive reader keeps only safe source files, the scan finds what an agent could do,
 * and an e-mail address unlocks the rest and tells the team.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.ts';
import { parseRepo, scanRepo, ScanError } from '../server/repo-scan.ts';
import type { Outgoing, Transport } from '../server/mail.ts';

// --- a tar archive in memory: [name, content, type]
function tar(entries: [string, string, string?][]): Buffer {
  const out: Buffer[] = [];
  for (const [name, content, type = '0'] of entries) {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(Buffer.byteLength(content).toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136);
    h.write('        ', 148); h.write(type, 156); h.write('ustar\0', 257);
    let sum = 0; for (const b of h) sum += b; h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    out.push(h, Buffer.from(content), Buffer.alloc((512 - (Buffer.byteLength(content) % 512)) % 512));
  }
  out.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(out));
}
const archive = (entries: [string, string, string?][]) => async () => new Response(new Uint8Array(tar(entries.map(([n, c, t]) => [`repo-abc/${n}`, c, t] as [string, string, string?]))), { status: 200 });

const APP = [
  ['src/server.ts', "import express from 'express'\nconst app = express()\napp.get('/api/customers/export', (req, res) => res.send(csv()))\napp.post('/api/transfers', (req, res) => res.json({ ok: 1 }))\napp.post('/api/api-keys', (req, res) => res.json({ key: 'x' }))\napp.post('/api/webhooks', (req, res) => res.json({ ok: 1 }))\napp.get('/api/profile', (req, res) => res.json({ email: 'a', phone: 'b' }))\napp.get('/health', (req, res) => res.send('ok'))\n"],
] as [string, string][];

test('parseRepo accepts a link or owner/name and nothing else', () => {
  assert.deepEqual(parseRepo('https://github.com/honojs/hono'), { owner: 'honojs', name: 'hono' });
  assert.deepEqual(parseRepo('github.com/honojs/hono/tree/main/src'), { owner: 'honojs', name: 'hono' });
  assert.deepEqual(parseRepo('honojs/hono.git'), { owner: 'honojs', name: 'hono' });
  for (const bad of ['', 'https://evil.example/a/b', 'http://169.254.169.254/latest', 'a/../b', '../..', 'a/b/c d', 'https://github.com/a']) assert.throws(() => parseRepo(bad), (e: unknown) => e instanceof ScanError && e.code === 'bad_repo', bad);
});

test('scanRepo reads source files, finds the four kinds, and ignores tests, vendored code, symlinks and path tricks', async () => {
  const r = await scanRepo('acme/shop', { fetch: archive([
    ...APP,
    ['node_modules/x/index.js', "app.get('/api/balance', () => 1)"],
    ['tests/a.test.ts', "app.get('/api/transactions/export', () => 1)"],
    ['src/evil-link.ts', '../../etc/passwd', '2'],
    ['../../escape.ts', "app.get('/api/escape/export', () => 1)"],
    ['README.md', "app.get('/api/readme', () => 1)"],
  ]) as unknown as typeof fetch });
  assert.equal(r.repo, 'acme/shop');
  assert.equal(r.filesScanned, 1, 'only the one real source file');
  const kinds = r.findings.map((f) => f.kind);
  for (const k of ['leaves-behind', 'bulk-export', 'money']) assert.ok(kinds.includes(k as never), `finds ${k}: ${kinds.join(',')}`);
  assert.ok(r.findings.every((f) => !/escape|balance|readme|transactions/.test(f.path)), 'nothing from skipped files');
  assert.ok(r.findings.length <= 5);
  assert.ok(!r.findings.some((f) => /health/.test(f.path)));
});

test('scanRepo: private or missing, huge, and empty repositories give plain answers', async () => {
  const code = async (f: () => Promise<Response>, o = {}) => scanRepo('a/b', { fetch: f as unknown as typeof fetch, ...o }).then(() => 'ok', (e) => (e as ScanError).code);
  assert.equal(await code(async () => new Response('nope', { status: 404 })), 'not_found');
  assert.equal(await code(async () => new Response('x', { status: 200, headers: { 'content-length': String(500 * 1024 * 1024) } })), 'too_large');
  assert.equal(await code(archive([['README.md', 'hello']])), 'empty');
  assert.equal(await code(archive([['a.ts', 'x'], ['b.ts', 'y'], ['c.ts', 'z']]), { limits: { files: 2 } }), 'too_large');
  assert.equal(await code(async () => { throw new Error('down'); }), 'unavailable');
});

// --- the page's API
const sent: Outgoing[] = [];
const transport: Transport = { name: 'fake', async send(m) { sent.push(m); return { id: String(sent.length) }; } };
let calls = 0;
const app = await createApp({ labOperator: false, dogfood: false, firebase: null, mailTransport: transport, chatModel: null, repoScan: async (repo) => { calls++; if (/bad\/repo/.test(repo)) throw new ScanError('not_found', 'That repository is private or does not exist.'); return scanRepo(repo, { fetch: archive(APP) as unknown as typeof fetch }); } });
await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
after(() => { app.server.close(); app.store.close(); });
const H = { 'Content-Type': 'application/json', Origin: base };
const post = (path: string, body: unknown, headers: Record<string, string> = H) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });

test('the page shows two findings, holds the rest back, and an e-mail unlocks them and tells the team', async () => {
  const r = await post('/api/v1/scan', { repo: 'https://github.com/acme/shop' });
  assert.equal(r.status, 200);
  const v = await r.json();
  assert.match(v.id, /^[a-f0-9]{32}$/);
  assert.equal(v.findings.length, 2);
  assert.ok(v.locked >= 1 && v.total === v.findings.length + v.locked);
  assert.ok(v.findings.every((f: Record<string, unknown>) => !('file' in f)), 'file and line wait for the e-mail');

  assert.equal((await post('/api/v1/scan/unlock', { id: v.id, email: 'nope' })).status, 400);
  const free = await post('/api/v1/scan/unlock', { id: v.id, email: 'someone@gmail.com' });
  assert.equal(free.status, 400); assert.equal((await free.json()).error, 'work_email');
  assert.equal((await post('/api/v1/scan/unlock', { id: 'f'.repeat(32), email: 'cto@acme.io' })).status, 404);
  assert.equal(sent.filter((m) => m.kind === 'scan').length, 0, 'nothing sent before a valid unlock');

  const u = await post('/api/v1/scan/unlock', { id: v.id, email: 'CTO@Acme.io' });
  assert.equal(u.status, 200);
  const full = await u.json();
  assert.equal(full.unlocked, true); assert.equal(full.findings.length, v.total); assert.ok(full.findings.every((f: Record<string, unknown>) => f.file));
  const mails = sent.filter((m) => m.kind === 'scan');
  assert.ok(mails.some((m) => m.to === 'cto@acme.io' && /cal\.com\/onehumanai/.test(m.text) && /acme\/shop/.test(m.subject)), 'the map goes to the address, with the 15-minute link');
  assert.ok(mails.some((m) => m.to === 'arif@onehuman.ai' && /Inbound lead/.test(m.subject)), 'the team is told');
  // a second unlock of the same scan does not send again
  const before = sent.length; await post('/api/v1/scan/unlock', { id: v.id, email: 'cto@acme.io' }); assert.equal(sent.length, before);
});

test('errors are plain, other origins are refused, and a visitor is limited', async () => {
  const bad = await post('/api/v1/scan', { repo: 'bad/repo' });
  assert.equal(bad.status, 404); assert.match((await bad.json()).message, /private/);
  assert.equal((await post('/api/v1/scan', { repo: 'acme/shop' }, { ...H, Origin: 'https://evil.example' })).status, 403);
  const n = calls; let limited = 0;
  for (let i = 0; i < 8; i++) if ((await post('/api/v1/scan', { repo: 'acme/shop' })).status === 429) limited++;
  assert.ok(limited >= 1 && calls < n + 8, 'six an hour');
});

test('the page: /scan is public', async () => {
  const page = await fetch(`${base}/scan`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /id="sc-form"/);
  assert.equal((await fetch(`${base}/api/v1/ops/scan-leads`)).status, 404, 'the team\'s lead list is not part of this repository');
});
