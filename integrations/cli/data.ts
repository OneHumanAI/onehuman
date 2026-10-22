// SPDX-License-Identifier: Apache-2.0
/**
 * The CLI commands that read your own OneHuman database. Nothing here makes a network call.
 *
 *   npx onehumanai inspect [--db sqlite:./onehuman.db] [--sessions] [--session <id>] [--last 20] [--json]
 *       exactly what the page script collected in a session, as stored — and byte for byte when the server
 *       runs with recordRaw (ONEHUMAN_RECORD_RAW=1). Check our privacy claims instead of trusting them.
 *   npx onehumanai report [--db …] [--days 30] [--out onehuman-report.html] [--json] [--empty] [--app <name>]
 *       the design-partner report from the local audit log: sessions with an agent, which agents, which
 *       endpoints, what the rules did or would have done.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SERVER_LIMITS, Store } from '../../server/public.ts';
import { openClient } from '../express/index.ts';
import { buildReport } from '../report/build.ts';
import { renderReportHtml } from '../report/html.ts';

type Flags = { flag: (n: string) => string | undefined; has: (n: string) => boolean };

export async function openDb(f: Flags): Promise<Store> {
  const db = f.flag('--db') ?? process.env.ONEHUMAN_DB ?? 'sqlite:./onehuman.db';
  const path = db.replace(/^(sqlite|file):/, '');
  if (!/^(libsql|https):/.test(db) && db !== 'memory' && !existsSync(resolve(path))) {
    console.error(`No OneHuman database at ${resolve(path)}.\nRun this where your app runs, or pass --db sqlite:/path/to/onehuman.db (the same value as the db option).`);
    process.exit(2);
  }
  return Store.open(await openClient(db), { limits: SERVER_LIMITS });
}

const WHAT = [
  'What the page script sends, and nothing else:',
  '  · timings (ms since the page opened) and whether the tab was visible',
  '  · for a click: the pointer path as [time, x, y] points, how long the button was held, pressure, target size',
  '  · for typing: how many keys and the gaps between them — never which keys',
  '  · traces agent tools leave in a page (element and global names), and whether automation is flagged',
  'Never sent: page text, what was typed, form values, URLs visited, request or response bodies, names, e-mails.',
].join('\n');

export async function inspect(f: Flags) {
  const store = await openDb(f);
  const sql = store.sql;
  if (f.has('--sessions')) {
    const rows = (await sql.execute(`SELECT s.id, s.created, s.last_seen, s.agent_attached_at, (SELECT COUNT(*) FROM events e WHERE e.session = s.id AND e.kind IN ('signal','interaction','raw')) AS n
      FROM sessions s ORDER BY s.last_seen DESC LIMIT ?`, [Number(f.flag('--last') ?? 20)])).rows;
    if (f.has('--json')) { console.log(JSON.stringify(rows, null, 2)); return; }
    console.log('Most recent sessions (the id is the oh_sid cookie in your browser):\n');
    for (const r of rows) console.log(`  ${r.id}  last seen ${new Date(Number(r.last_seen)).toISOString().replace('T', ' ').slice(0, 19)}  ${String(r.n).padStart(4)} payloads${r.agent_attached_at ? '  · agent attached' : ''}`);
    return;
  }
  let session = f.flag('--session');
  if (!session) {
    session = String((await sql.execute("SELECT session FROM events WHERE kind IN ('signal','interaction','raw') ORDER BY id DESC LIMIT 1")).rows[0]?.session ?? '');
    if (!session) { console.log('Nothing collected yet: no page has sent anything. Open a page that loads /onehuman/sdk.js, then run this again.'); return; }
  }
  const last = Number(f.flag('--last') ?? 20);
  const rows = (await sql.execute("SELECT id, kind, payload, created FROM events WHERE session = ? AND kind IN ('signal','interaction','raw','seal') ORDER BY id DESC LIMIT ?", [session, last])).rows.reverse();
  const hasRaw = rows.some((r) => r.kind === 'raw');
  if (f.has('--json')) { console.log(JSON.stringify(rows.map((r) => ({ kind: r.kind, at: Number(r.created), payload: JSON.parse(String(r.payload)) })), null, 2)); return; }
  console.log(`Session ${session} — the last ${rows.length} things the page script sent, oldest first.\n`);
  console.log(WHAT + '\n');
  if (!hasRaw) console.log('These are stored as the server kept them after checking them (unknown fields dropped). For byte-exact copies, start the server with ONEHUMAN_RECORD_RAW=1 (or recordRaw: true).\n');
  for (const r of rows) {
    const p = JSON.parse(String(r.payload)) as { source?: string; body?: string };
    const when = new Date(Number(r.created)).toISOString().replace('T', ' ').slice(0, 23);
    if (r.kind === 'raw') console.log(`── ${when}  exactly as received (${p.source})\n${p.body}\n`);
    else console.log(`── ${when}  ${r.kind === 'signal' ? 'page and agent-tool traces' : r.kind === 'interaction' ? 'a click or typing sample' : 'screen sealed'} (as stored)\n${JSON.stringify(p, null, 2)}\n`);
  }
}

export async function report(f: Flags) {
  const days = Number(f.flag('--days') ?? 30);
  const to = Date.now(), from = to - days * 86_400_000;
  const app = f.flag('--app') ?? '';
  let r;
  if (f.has('--empty')) r = buildReport([], { from, to, source: 'server', app });
  else {
    const store = await openDb(f);
    r = buildReport(await store.decisionsBetween(from, to), { from, to, source: 'server', app, sessionTools: await store.attachToolsBetween(from, to) });
  }
  if (f.has('--json')) { console.log(JSON.stringify(r, null, 2)); return; }
  const out = resolve(f.flag('--out') ?? 'onehuman-report.html');
  writeFileSync(out, renderReportHtml(r));
  console.log(`${r.notes.join('\n')}\n\nReport written to ${out} — open it and print to PDF.`);
}

/**
 * `npx onehumanai anchors [--out dir]` — the RFC 3161 timestamps of the audit chain (see the `anchor` option). With
 * --out, each anchor becomes <room>-<seq>.tsr (the TSA's signed answer) and <room>-<seq>.head.txt (the chain head it
 * covers), which an auditor checks with OpenSSL without trusting this server.
 */
export async function anchors(f: Flags) {
  const store = await openDb(f);
  const list = await store.listAnchors(Number(f.flag('--last') ?? 1000));
  if (!list.length) { console.log('No anchors yet. Set the anchor option (or ONEHUMAN_TSA_URL) and let the app run.'); store.close(); return; }
  const out = f.flag('--out');
  if (out) {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(resolve(out), { recursive: true });
    for (const a of list) {
      const base = resolve(out, `${a.room.slice(0, 8)}-${a.seq}`);
      writeFileSync(`${base}.tsr`, Buffer.from(a.response, 'base64'));
      writeFileSync(`${base}.tsq`, Buffer.from(a.request, 'base64'));
      writeFileSync(`${base}.head.txt`, a.hash);
    }
  }
  for (const a of list) console.log(`${new Date(a.created).toISOString()}  chain ${a.room.slice(0, 8)} up to #${a.seq}  ${a.hash.slice(0, 19)}…  ${a.tsa}`);
  if (out) {
    const first = `${a0(list[0]!)}`;
    console.log(`\nWrote ${list.length} anchor(s) to ${resolve(out)}. Check one without trusting this server:\n  openssl ts -reply -in ${first}.tsr -text                     # time, TSA, and the imprint\n  openssl ts -verify -in ${first}.tsr -data ${first}.head.txt -CAfile <TSA CA certificate>`);
  }
  store.close();
}
const a0 = (a: { room: string; seq: number }) => `${a.room.slice(0, 8)}-${a.seq}`;

