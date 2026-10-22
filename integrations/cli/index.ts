// SPDX-License-Identifier: Apache-2.0
/**
 * onehuman CLI
 *   npx onehumanai init [dir] [--yes] [--no-install]  answer a few questions; OneHuman is set up in this project
 *   npx onehumanai connect [dir] [--force]          connect this app to onehuman.ai in the browser; the free key goes into .env
 *   npx onehumanai inspect [--sessions] [--session <id>] [--db …]   exactly what the page script collected
 *   npx onehumanai report [--days 30] [--out file.html] [--json]    the 30-day report from your own audit log
 *   npx onehumanai scan [dir]                      discover routes, sensitivity, identity; write onehuman.policy.draft.json
 *   npx onehumanai scan [dir] --json               same, machine-readable (for AI agents)
 *   npx onehumanai scan [dir] --proposal           only the plain-language proposal to show the product owner
 *   npx onehumanai verify <baseUrl> <protectedPath> [--base /onehuman]   run the 4 post-integration checks
 *   npx onehumanai sidecar [--port 8788]           run the engine next to a Python, C# or Java backend
 *   npx onehumanai anchors [--out dir]             RFC 3161 timestamps of the audit chain, as files OpenSSL verifies
 *   npx onehumanai proof-keys                      the public keys of this deployment's proofs (keep them before changing the secret)
 *   npx onehumanai secret                          print a fresh ONEHUMAN_SECRET
 *   npx onehumanai verify-proof <bundle.json> [--keys <jwks.json | https://…/onehuman/proof-keys>]
 *                                                  check signed decision proofs offline (for an auditor)
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { renderProposal, renderReport, scan } from './scan.ts';
import { runInit } from './init.ts';
import { connectApp, envHasKey, writeKeyToEnv } from './connect.ts';
import { anchors, inspect, report } from './data.ts';
import { runSidecar } from './sidecar.ts';
import { runProofKeys } from './proof-keys.ts';
import { thumbprint, verifyProof } from '../proof/verify.ts';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
const has = (name: string) => rest.includes(name);
const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1]!.startsWith('--') && rest[i - 1] !== '--json'));

const HELP = `onehumanai: access control for the AI agents your customers log in with

Set up and check
  npx onehumanai init [dir] [--yes] [--no-install]
      three questions, shows every change, writes it on yes (--yes: the recommended answers)
  npx onehumanai connect [dir] [--force]
      connect this app to onehuman.ai in the browser: the free API key arrives in .env (--force replaces one)
  npx onehumanai verify <baseUrl> <protectedPath> [--base /onehuman] [--cookie "name=value"] [--attach]
      four checks against your running app. Behind a login, pass a signed-in session cookie with --cookie;
      --attach also simulates an attached agent (it marks that login as an agent for this visit: use a test account)
  npx onehumanai scan [dir] [--json | --proposal]
      routes, what they expose, the login, a draft policy (onehuman.policy.draft.json)

See what happened
  npx onehumanai inspect [--sessions] [--session <id>] [--db sqlite:./onehuman.db]
      exactly what the page script sent
  npx onehumanai report [--days 30] [--out file.html] [--json]
      the 30-day report from your own audit log

Proofs
  npx onehumanai verify-proof <bundle.json> [--keys <jwks.json | https://your-app/onehuman/proof-keys>]
      check signed decisions offline (for an auditor)
  npx onehumanai proof-keys
      this deployment's public proof keys (keep them before changing the secret)
  npx onehumanai anchors [--out dir]
      RFC 3161 timestamps of the audit chain, as files OpenSSL verifies

Other backends and secrets
  npx onehumanai sidecar [--port 8788] [--dir .]
      the engine next to a Python, .NET or Java app (packages: onehumanai, OneHumanAI.AspNetCore, ai.onehuman:onehumanai)
  npx onehumanai secret
      a fresh ONEHUMAN_SECRET

Docs: https://onehuman.ai/docs`;

declare const __ONEHUMAN_VERSION__: string | undefined;
const VERSION = typeof __ONEHUMAN_VERSION__ === 'string' ? __ONEHUMAN_VERSION__ : '0.0.0-dev';

/**
 * `npx onehumanai init` in a project that already has an older onehumanai installed runs that old copy. The setup
 * should always be the newest one: if npm has a newer version, run that instead (once; a quick check, skipped offline).
 */
async function newerSetup(args: string[]): Promise<boolean> {
  if (VERSION === '0.0.0-dev' || process.env.ONEHUMAN_NO_UPDATE_CHECK) return false;
  const latest = await fetch('https://registry.npmjs.org/onehumanai/latest', { signal: AbortSignal.timeout(2500) })
    .then((r) => (r.ok ? r.json() : null), () => null).then((j: { version?: string } | null) => j?.version ?? null, () => null);
  const newer = (a: string, b: string) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0); return false; };
  if (!latest || !newer(latest, VERSION)) return false;
  console.log(`Using the newest setup (onehumanai ${latest}; this project has ${VERSION}).`);
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('npx', ['--yes', `onehumanai@${latest}`, ...args], { stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ONEHUMAN_NO_UPDATE_CHECK: '1' } });
  process.exit(r.status ?? 0);
}

async function main() {
  if (cmd === 'inspect') { await inspect({ flag, has }); return; }
  if (cmd === 'report') { await report({ flag, has }); return; }
  if (cmd === 'sidecar') { await runSidecar({ flag, has }); return; }
  if (cmd === 'proof-keys') { runProofKeys({ flag }); return; }
  if (cmd === 'anchors') { await anchors({ flag, has }); return; }
  // `npx onehumanai` on its own sets the project up: the one command people need to remember
  if (cmd === 'connect') {
    const dir = resolve(positional[0] ?? process.cwd());
    let name = basename(dir);
    try { name = String((JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) as { name?: string }).name || name).replace(/^@[^/]+\//, ''); } catch { /* not a Node project: the folder's name */ }
    const env = resolve(dir, '.env');
    if (!has('--force') && envHasKey(env)) { console.log(`${env} already has ONEHUMAN_API_KEY. Run with --force to replace it.`); return; }
    const got = await connectApp({ name });
    if (!got) { process.exitCode = 1; return; }
    const how = writeKeyToEnv(env, got.key, true);
    console.log(`\nConnected${got.account ? ` to ${got.account}` : ''}. ONEHUMAN_API_KEY ${how === 'replaced' ? 'replaced' : 'added'} in ${env}.`);
    console.log('Set the same variable where the app runs (your host\'s environment settings), then deploy.');
    return;
  }
  if (cmd === 'init' || cmd === undefined) { await newerSetup(['init', ...rest]); await runInit(positional[0] ?? process.cwd(), { yes: has('--yes'), install: !has('--no-install') }); return; }
  if (cmd === 'scan') {
    const root = resolve(positional[0] ?? process.cwd());
    const r = scan(root);
    writeFileSync(resolve(root, 'onehuman.policy.draft.json'), JSON.stringify(r.policyDraft, null, 2) + '\n');
    if (has('--json')) console.log(JSON.stringify({ ...r, proposalText: renderProposal(r) }, null, 2));
    else if (has('--proposal')) console.log(renderProposal(r));
    else console.log(renderReport(r));
    return;
  }
  if (cmd === 'verify-proof') {
    // An auditor's check. Nothing is sent anywhere; the only input is the file (and, better, a key you got
    // yourself from the business's own site — the key inside a bundle proves consistency, not origin).
    const file = positional[0];
    if (!file) { console.error('usage: onehuman verify-proof <bundle.json> [--keys <jwks.json | https://…/onehuman/proof-keys>]'); process.exit(2); }
    const bundle = JSON.parse(readFileSync(resolve(file), 'utf8')) as { keys?: { x: string; kid?: string }[]; proofs?: string[] };
    const keySrc = flag('--keys');
    let keys = bundle.keys ?? [];
    if (keySrc) {
      const raw = /^https?:\/\//.test(keySrc) ? await (await fetch(keySrc)).json() : JSON.parse(readFileSync(resolve(keySrc), 'utf8'));
      keys = (raw.keys ?? raw) as { x: string }[];
    }
    const proofs = bundle.proofs ?? [];
    if (!keys.length || !proofs.length) { console.error('The file has no keys or no proofs.'); process.exit(2); }
    let ok = 0;
    for (const [i, jws] of proofs.entries()) {
      const c = verifyProof(jws, keys);
      if (c.valid) {
        ok++;
        const p = c.payload;
        console.log(`✓ ${new Date(p.iat * 1000).toISOString()}  ${p.resource.padEnd(22)} ${p.decision.padEnd(8)} actor=${p.actor.padEnd(13)} delivered=${p.delivered ? 'yes' : 'no '}  decision ${p.jti}  chain #${p.audit.seq}`);
      } else console.log(`✗ proof ${i + 1}: ${c.reason}`);
    }
    console.log(`\n${ok}/${proofs.length} proofs valid, signed by ${[...new Set(keys.map((k) => thumbprint(k.x)))].join(', ')}${keySrc ? '' : '\nKeys came from the bundle itself. For an independent check pass --keys https://<their-site>/onehuman/proof-keys'}`);
    process.exit(ok === proofs.length ? 0 : 1);
  }
  if (cmd === 'verify') {
    const base = positional[0]; const path = positional[1]; const sdkBase = flag('--base') ?? '/onehuman';
    if (!base || !path) { console.error('usage: onehumanai verify <baseUrl> <protectedPath> [--base /onehuman] [--cookie "session=…" [--attach]]'); process.exit(2); }
    // an app behind a login: the cookie of a signed-in browser (copy it from the browser's dev tools)
    const login = flag('--cookie') ?? '';
    const withLogin = (c: string) => [login, c].filter(Boolean).join('; ');
    const results: { name: string; ok: boolean; detail: string }[] = [];
    const u = (p: string) => new URL(p, base).toString();
    // 1. SDK is served
    const sdk = await fetch(u(`${sdkBase}/sdk.js`)).catch(() => null);
    results.push({ name: 'SDK served', ok: !!sdk && sdk.ok && /sdk-v/.test(await sdk.text().catch(() => '')), detail: `GET ${sdkBase}/sdk.js → ${sdk?.status ?? 'unreachable'}` });
    // 2. protected endpoint answers with a decision and sets the session cookie
    const r1 = await fetch(u(path), { headers: login ? { cookie: login } : {} }).catch(() => null);
    const cookie = r1?.headers.get('set-cookie')?.split(';')[0] ?? '';
    const b1 = r1 ? await r1.json().catch(() => null) : null;
    // `decision; computed=…; actor=…` — present on every protected answer, whatever the app's body looks like
    const outcome = (r: Response | null) => { const h = r?.headers.get('x-oh-outcome') ?? ''; const m = /^(\w+); computed=(\w+); actor=(\w+)/.exec(h); return m ? { decision: m[1]!, computed: m[2]!, actor: m[3]! } : null; };
    const decisionHeader = r1?.headers.get('x-oh-decision');
    // a 401 is the app's own login check, whether or not OneHuman decided first; a 403 or a redirect without a decision too
    const needsLogin = !!r1 && (r1.status === 401 || (!decisionHeader && (r1.status === 403 || (r1.status >= 300 && r1.status < 400))));
    results.push({ name: 'Decision on protected endpoint', ok: !!r1 && !!decisionHeader && (r1.status === 200 || r1.status === 403 || r1.status === 428), detail: `GET ${path} → ${r1?.status ?? 'unreachable'}, X-OH-Decision ${decisionHeader ? 'present' : 'MISSING (protect() not applied?)'}, ${outcome(r1) ? `decision=${outcome(r1)!.decision}, rules say ${outcome(r1)!.computed}` : `decision=${b1?._onehuman?.decision ?? b1?.decision?.decision ?? '-'}`}` });
    // 3. environment-only evidence (AI app browser UA) reaches the onArtifact branch
    const r2 = await fetch(u(path), { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Claude/2.2553.1 Chrome/152.0.0.0 Safari/537.36', ...(login ? { cookie: login } : {}) } }).catch(() => null);
    const t2 = r2 ? await r2.text().catch(() => '') : '';
    const b2 = (() => { try { return JSON.parse(t2); } catch { return null; } })();
    const codes2: string[] = b2?._onehuman?.reasonCodes ?? b2?.decision?.reasonCodes ?? [];
    // apps that answer with their own body carry no reason codes: then the answer itself must change (refused, confirm, or masked)
    const plain = r1 ? JSON.stringify(b1) : '';
    const changed = !!r2 && (r2.status === 403 || r2.status === 428 || (r2.status === 200 && r1?.status === 200 && JSON.stringify(b2) !== plain));
    const o2 = outcome(r2);
    const envSeen = codes2.includes('AGENT_APP_BROWSER') || (!!o2 && o2.computed !== (outcome(r1)?.computed ?? 'allow')) || (!codes2.length && changed);
    results.push({ name: 'Environment evidence recognised', ok: envSeen, detail: `AI-app UA → ${r2?.status}, ${o2 ? `decision=${o2.decision}, rules say ${o2.computed}, actor=${o2.actor}` : `decision=${b2?._onehuman?.decision ?? b2?.decision?.decision ?? '-'}`}${codes2.length ? `, codes=${codes2.join(',')}` : ''}` });
    // 4. attached agent (control markers via the SDK endpoint) changes the decision for the same session.
    // With --cookie that session is a real login: marking it "agent" would follow that user for the rest of the visit,
    // so it runs only when asked (--attach, ideally with a test account).
    if (login && !rest.includes('--attach')) {
      results.push({ name: 'Attached agent changes the decision', ok: true, detail: 'skipped: it would mark the signed-in user as an agent for this visit. Run with --attach and a test account\'s cookie to include it.' });
    } else {
      const early = { startedMs: 0, observedMs: 500, webdriver: false, firstInteractionMs: null, dataDomMs: null, markers: [{ name: 'claude-stop', atMs: 100 }, { name: 'claude-cursor', atMs: 100 }], environment: { codexModelContext: false, modelContextApi: false, clipboardBridge: false, clipboardBridgeAtMs: null, agentGlobals: [], extensionsInstalled: [], focusWhileHiddenMs: null }, focusConflict: { count: 0, firstAtMs: null, peers: 0 }, webmcpInvocations: 0, reading: { loadedHidden: false, readBursts: 0, firstReadBurstMs: null, lastReadBurstReads: 0, readBurstAnonymous: false, textExtracts: 0, firstTextExtractMs: null, visibilityFlickers: 0, firstFlickerMs: null, flickerResize: null, renderWhileHiddenMs: null, firstClick: null } };
      const sig = await fetch(u(`${sdkBase}/signals`), { method: 'POST', headers: { 'content-type': 'application/json', cookie: withLogin(cookie) }, body: JSON.stringify({ early, interaction: null }) }).catch(() => null);
      const sb = sig ? await sig.json().catch(() => null) : null;
      const r3 = await fetch(u(path), { headers: { cookie: withLogin(cookie) } }).catch(() => null);
      const b3 = r3 ? await r3.json().catch(() => null) : null;
      const o3 = outcome(r3);
      const applied = o3?.decision ?? b3?._onehuman?.decision ?? b3?.decision?.decision;
      const observe = r3?.status === 200 && applied === 'allow' && (o3 ? o3.computed !== 'allow' : (b3?._onehuman?.reasonCodes ?? b3?.decision?.reasonCodes ?? []).some((c: string) => /AGENT_CONTROL_MARKER|AGENT_ATTACHED_EARLIER/.test(c)));
      results.push({ name: 'Attached agent changes the decision', ok: sb?.connection?.state === 'agent_attached' && (r3?.status === 403 || r3?.status === 428 || applied === 'mask' || applied === 'step_up' || observe || (r3?.status === 200 && r1?.status === 200 && JSON.stringify(b3) !== plain)), detail: `signals → ${sb?.connection?.state ?? sig?.status ?? 'unreachable'}; then GET ${path} → ${r3?.status}, decision=${applied ?? '-'}${observe ? ' (observe mode: recorded, not enforced)' : ''}` });
    }
    let allOk = true;
    for (const x of results) { allOk &&= x.ok; console.log(`${x.ok ? '✓' : '✗'} ${x.name}\n    ${x.detail}`); }
    if (needsLogin && !login) console.log(`\n${path} answered ${r1!.status} before OneHuman decided: it needs a signed-in user. Sign in in a browser, copy your app's session cookie and run again with --cookie "name=value".`);
    console.log(allOk ? '\nAll checks passed.' : '\nSome checks failed — see details above.');
    process.exit(allOk ? 0 : 1);
  }
  if (cmd === 'secret') { console.log(randomBytes(32).toString('base64url')); return; }
  const help = !cmd || cmd === 'help' || cmd === '--help' || cmd === '-h';
  if (!help) console.error(`onehumanai: unknown command "${cmd}"\n`);
  console.log(HELP);
  process.exit(help ? 0 : 2);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
