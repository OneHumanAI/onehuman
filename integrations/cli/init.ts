// SPDX-License-Identifier: Apache-2.0
/**
 * `onehumanai init` — set OneHuman up in this project by answering a few questions.
 *
 * It reads the project (the same scan as `onehumanai scan`), asks what to protect and how, shows every file it
 * would write or change, and writes nothing until the person says yes. For an Express app it wires the code
 * itself: a small `onehuman.js` next to the server, `app.use(onehuman.middleware())`, and
 * `onehuman.protect('…')` on each chosen route. For other servers it writes the rules and the environment and
 * prints the lines to add.
 *
 *   npx onehumanai init [dir]            ask, show the plan, apply on yes
 *   npx onehumanai init [dir] --yes      take every recommended answer (for CI and coding agents)
 *   npx onehumanai init [dir] --no-install   do not run the package manager
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { scan, type RouteHit, type ScanResult } from './scan.ts';

type Mode = 'allow' | 'mask' | 'step_up' | 'block';
const PRESETS: Record<string, { label: string; what: string; m: [Mode, Mode, Mode, Mode] }> = {
  open: { label: 'Open to everyone', what: 'agents and people see everything', m: ['allow', 'allow', 'allow', 'allow'] },
  hide: { label: 'AI agents see it with details hidden', what: 'values hidden from an agent, people see everything', m: ['mask', 'mask', 'allow', 'allow'] },
  refuse: { label: 'Refuse AI agents', what: 'an agent is turned away, people see everything', m: ['block', 'mask', 'allow', 'allow'] },
  guard: { label: 'Refuse AI agents, passkey when unsure', what: 'an agent is turned away; when unsure, the person confirms with a passkey', m: ['block', 'step_up', 'step_up', 'allow'] },
  passkey: { label: 'Everyone confirms with a passkey', what: 'for the few critical actions: payouts, contact changes, bulk export', m: ['block', 'step_up', 'step_up', 'step_up'] },
};
const PRESET_KEYS = Object.keys(PRESETS);

const tty = process.stdout.isTTY;
const c = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c('1'), dim = c('2'), green = c('32'), cyan = c('36'), yellow = c('33');

type Choice<T> = { label: string; value: T; hint?: string };

function suggestPreset(r: RouteHit): string {
  if (r.proposal.onAgent === 'allow') return 'open';
  if (r.proposal.onAgent === 'mask') return r.kind === 'read' ? 'hide' : 'refuse';
  // money that leaves, or where it goes: a program can imitate a person's clicks, it cannot press their passkey
  if (r.kind === 'write' && /transfer|withdraw|payout|payroll|payments?\b|pay\b|bank|iban|beneficiar|payee|card/i.test(r.path)) return 'passkey';
  if (r.kind === 'download' || /delete/i.test(r.path)) return 'guard';
  return r.proposal.onUnknown === 'step_up' ? 'guard' : 'refuse';
}
/** `payroll.run.make` → "Make payroll run", `employees.read` → "View employees": how the portal lists the rule */
const VERBS: Record<string, string> = { read: 'View', write: 'Change', make: 'Make', export: 'Export', delete: 'Delete' };
const titleOf = (res: string) => {
  let parts = res.split('.').map((p) => (p === 'me' ? 'your profile' : p));
  if (parts.includes('export') && parts.at(-1) !== 'export') parts = [...parts.filter((p) => p !== 'export'), 'export'];
  const verb = VERBS[parts.at(-1) ?? ''];
  const noun = (verb ? parts.slice(0, -1) : parts).join(' ').replace(/[_-]+/g, ' ');
  const t = verb ? `${verb} ${noun}` : noun;
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** `req.session.userId` → `req.session?.userId`, so a request without a login gives null instead of throwing */
const safeChain = (expr: string) => expr.replace(/\?\./g, '.').replace(/\./g, '?.').replace(/^req\?\./, 'req.');

type Style = { esm: boolean; ts: boolean; ext: string; importSuffix: string };
function styleOf(file: string, text: string, pkgType: string | undefined): Style {
  const ext = extname(file);
  const ts = ext === '.ts' || ext === '.mts' || ext === '.tsx';
  const esm = ext === '.mjs' || ext === '.mts' || (ext !== '.cjs' && (/^\s*import\s[\s\S]*?from\s|^\s*export\s/m.test(text) || (!/\brequire\s*\(/.test(text) && pkgType === 'module')));
  // follow how this file already imports its neighbours: './x.js' or './x'
  const rel = text.match(/from\s+['"](\.{1,2}\/[^'"]+)['"]/);
  const importSuffix = rel ? (/\.(m?js|ts)$/.test(rel[1]!) ? (rel[1]!.match(/\.(m?js|ts)$/)![0]) : '') : ts ? '' : ext === '.mjs' ? '.mjs' : '.js';
  return { esm, ts, ext: ts ? '.ts' : ext === '.mjs' || ext === '.cjs' ? ext : '.js', importSuffix };
}

type Edit = { file: string; before: string | null; after: string; changes: string[] };

/**
 * The project's own package manager: npm cannot install into a node_modules that pnpm made (it stops with
 * "Cannot read properties of null (reading 'matches')"), so pnpm, yarn and bun projects get their own tool.
 * Looks at package.json "packageManager", node_modules/.pnpm, and lockfiles here and in parent folders (workspaces).
 */
export function packageManager(root: string, pkg: { packageManager?: unknown }): string[] {
  const declared = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : '';
  if (declared === 'pnpm' || declared === 'yarn' || declared === 'bun') return [declared, 'add'];
  if (existsSync(join(root, 'node_modules', '.pnpm'))) return ['pnpm', 'add'];
  for (let dir = root; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-lock.yaml')) || existsSync(join(dir, 'pnpm-workspace.yaml'))) return ['pnpm', 'add'];
    if (existsSync(join(dir, 'yarn.lock'))) return ['yarn', 'add'];
    if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) return ['bun', 'add'];
    if (existsSync(join(dir, 'package-lock.json')) || dirname(dir) === dir) return ['npm', 'install'];
  }
}

export async function runInit(dir: string, flags: { yes: boolean; install: boolean }) {
  const root = resolve(dir);
  const rl = flags.yes ? null : createInterface({ input: process.stdin, output: process.stdout });
  if (!flags.yes && !process.stdin.isTTY) {
    console.error('onehumanai init asks questions. In a script, run `npx onehumanai init --yes` to take the recommended answers.');
    process.exit(2);
  }
  const say = (s = '') => console.log(s);

  async function choose<T>(question: string, choices: Choice<T>[], def = 0): Promise<T> {
    if (flags.yes || choices.length === 1) return choices[def]!.value;
    say(`\n${bold('? ' + question)}`);
    choices.forEach((ch, i) => say(`  ${cyan(String(i + 1) + ')')} ${ch.label}${i === def ? dim('  (recommended)') : ''}${ch.hint ? dim('  — ' + ch.hint) : ''}`));
    for (;;) {
      const a = (await rl!.question(`  Choose [${def + 1}]: `)).trim();
      if (!a) return choices[def]!.value;
      const n = Number(a);
      if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1]!.value;
      say(yellow(`  Type a number from 1 to ${choices.length}.`));
    }
  }
  async function text(question: string, def = ''): Promise<string> {
    if (flags.yes) return def;
    return (await rl!.question(`\n${bold('? ' + question)} ${def ? dim(`[${def}] `) : ''}`)).trim() || def;
  }
  async function confirm(question: string, def = true): Promise<boolean> {
    if (flags.yes) return def;
    const a = (await rl!.question(`\n${bold('? ' + question)} ${dim(def ? '(Y/n)' : '(y/N)')} `)).trim().toLowerCase();
    return a ? a.startsWith('y') : def;
  }

  // ---------------------------------------------------------------- read the project
  say(`\n${bold('OneHuman setup')} ${dim('· three short questions. Nothing is written until you say yes.')}`);
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) { say(yellow(`\nNo package.json in ${root}. Run this in your Node server's folder, or pass it: npx onehumanai init ./server`)); rl?.close(); process.exit(2); }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { type?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string>; packageManager?: string };
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const r: ScanResult = scan(root);
  for (const x of r.routes) x.file = resolve(root, x.file);   // the scan reports paths relative to the project
  const detected = deps.express ? 'express' : deps.fastify ? 'fastify' : deps.next ? 'next' : deps.koa ? 'koa' : deps['@nestjs/core'] ? 'nestjs' : r.frameworks[0] ?? 'unknown';
  const risky = r.routes.filter((x) => x.sensitivity >= 25 && !x.signals.includes('excluded-pattern')).length;
  const known = { express: 'an Express app', fastify: 'a Fastify app', next: 'a Next.js app', koa: 'a Koa app', nestjs: 'a NestJS app' }[detected as 'express'];
  say(dim(`\nFound ${known ?? 'a Node app'} with ${r.routes.length} routes. ${risky ? `${risky} of them return or change data an AI agent should not get freely.` : 'None of them look sensitive.'}`));

  // ---------------------------------------------------------------- 1. the server
  // not asked: an unknown server gets the rules and settings, plus the lines to add (see the plan)
  const framework = ['express', 'fastify', 'next'].includes(detected) ? detected : 'other';

  // ---------------------------------------------------------------- 2. what to protect, and how
  const candidates = r.routes.filter((x) => x.sensitivity >= 25 && !x.signals.includes('excluded-pattern')).sort((a, b) => b.sensitivity - a.sensitivity).slice(0, 40);
  let chosen: RouteHit[] = [...candidates];
  const presetFor = new Map<RouteHit, string>(chosen.map((x) => [x, suggestPreset(x)]));
  if (candidates.length) {
    const w = Math.max(...candidates.map((x) => titleOf(x.resource).length));
    say(`\n${bold('What I would protect:')}`);
    for (const [i, x] of candidates.entries()) {
      if (candidates.findIndex((y) => y.resource === x.resource) !== i) continue;   // a list and its detail page are one item
      const paths = candidates.filter((y) => y.resource === x.resource).map((y) => `${y.method} ${y.path}`).join(', ');
      say(`  ${titleOf(x.resource).padEnd(w)}  ${dim(paths)}\n  ${' '.repeat(w)}  → ${green(PRESETS[presetFor.get(x)!]!.label)}`);
    }
    const how = await choose('Protect it like this?', [
      { label: 'Yes', value: 'yes' },
      { label: 'Let me change it', value: 'change', hint: 'one question per item' },
    ]);
    if (how === 'change') {
      for (const [i, x] of candidates.entries()) {
        if (candidates.findIndex((y) => y.resource === x.resource) !== i) continue;
        const cur = PRESET_KEYS.indexOf(presetFor.get(x)!);
        const pick = await choose(`${titleOf(x.resource)}: when an AI agent asks for it`, PRESET_KEYS.map((k) => ({ value: k, label: PRESETS[k]!.label, hint: PRESETS[k]!.what })), cur);
        for (const y of candidates) if (y.resource === x.resource) presetFor.set(y, pick);
      }
      chosen = candidates.filter((x) => presetFor.get(x) !== 'open');
    }
  } else say(dim('\nNothing looks sensitive yet. You can add rules later in the portal or in onehuman.policy.json.'));

  // ---------------------------------------------------------------- 3. who is logged in
  const exprs = [...new Set(r.identity.map((i) => i.expression).filter((e) => /^req\.(session|user|auth|account|currentUser|member)\b/.test(e)))].slice(0, 5);
  // who is signed in: taken from the code, not asked (it is a technical question); init says what it chose
  const identifyExpr: string | null = exprs[0] ?? null;

  // ---------------------------------------------------------------- 4. start mode
  const enforcement = await choose('Start by only watching, or protect right away?', [
    { value: 'observe', label: 'Only watch for now', hint: 'nothing is blocked; you see what AI agents do, then switch it on' },
    { value: 'enforce', label: 'Protect right away' },
  ]);

  // ---------------------------------------------------------------- 5. the portal
  let apiKey = process.env.ONEHUMAN_API_KEY ?? '';
  if (!apiKey) {
    for (;;) {
      apiKey = await text('Your API key from onehuman.ai/portal, for your dashboard and the free 30-day AI agent report (press Enter to skip):');
      if (!apiKey || /^oh_live_[a-f0-9]{40}$/.test(apiKey)) break;
      say(yellow('  That is not a OneHuman key: it starts with oh_live_ and has 40 more characters. Press Enter to skip.'));
    }
  }

  // ---------------------------------------------------------------- 6. the page
  const htmlCandidates = [...r.frontend.entryHtml, 'public/index.html', 'index.html', 'static/index.html', 'views/index.html', 'client/index.html', 'src/index.html'];
  const html = [...new Set(htmlCandidates)].map((f) => resolve(root, f)).find((f) => existsSync(f) && /<\/head>/i.test(readFileSync(f, 'utf8')) && !readFileSync(f, 'utf8').includes('/onehuman/sdk.js'));
  // the page script and OneHuman.fetch are part of the setup, not questions: both are listed in the plan below
  const addScript = !!html;
  // The page's own requests must carry the click that caused them, or a person's click never counts as human evidence
  // (and in protect mode a real person meets a passkey request). The script tag does it for every same-origin fetch()
  // and XMLHttpRequest of the page (data-fetch="auto": inline scripts, bundles and axios alike, no code rewritten), and
  // answers a passkey request with a dialog of its own (data-step-up="auto").

  // ---------------------------------------------------------------- the plan
  const edits: Edit[] = [];
  const notes: string[] = [];
  const read = (f: string) => { const hit = edits.find((e) => e.file === f); return hit ? hit.after : readFileSync(f, 'utf8'); };
  const put = (file: string, after: string, change: string) => {
    const hit = edits.find((e) => e.file === file);
    if (hit) { hit.after = after; hit.changes.push(change); } else edits.push({ file, before: existsSync(file) ? readFileSync(file, 'utf8') : null, after, changes: [change] });
  };

  // the rules
  // one rule per resource: routes that share one (a list and its detail page) get the stricter of their choices
  const STRICT = ['allow', 'mask', 'step_up', 'block'];
  const stricter = (a: string, b: string) => (STRICT.indexOf(b) > STRICT.indexOf(a) ? b : a);
  const byResource = new Map<string, { resource: string; title: string; onAgent: string; onArtifact: string; onUnknown: string; onHumanLike: string; actOn: string[]; minScore: number }>();
  for (const x of chosen) {
    const m = PRESETS[presetFor.get(x)!]!.m;
    const prev = byResource.get(x.resource);
    byResource.set(x.resource, prev
      ? { ...prev, onAgent: stricter(prev.onAgent, m[0]), onArtifact: stricter(prev.onArtifact, m[1]), onUnknown: stricter(prev.onUnknown, m[2]), onHumanLike: stricter(prev.onHumanLike, m[3]) }
      : { resource: x.resource, title: titleOf(x.resource), onAgent: m[0], onArtifact: m[1], onUnknown: m[2], onHumanLike: m[3], actOn: ['verified', 'strong', 'control', 'behavioral'], minScore: 65 });
  }
  const rules = [...byResource.values()];
  const policyFile = join(root, 'onehuman.policy.json');
  if (existsSync(policyFile)) notes.push('onehuman.policy.json already exists — kept as it is.');
  else put(policyFile, JSON.stringify({ version: 'app-1', enforcement, rules }, null, 2) + '\n', `${rules.length} rule${rules.length === 1 ? '' : 's'}, ${enforcement === 'observe' ? 'watching only' : 'protection on'}`);

  // the environment
  const envFile = join(root, '.env');
  const envText = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
  const envAdd: string[] = [];
  if (!/^ONEHUMAN_SECRET=/m.test(envText)) envAdd.push(`ONEHUMAN_SECRET=${randomBytes(32).toString('hex')}`);
  if (apiKey && !/^ONEHUMAN_API_KEY=/m.test(envText)) envAdd.push(`ONEHUMAN_API_KEY=${apiKey}`);
  if (envAdd.length) put(envFile, envText + (envText && !envText.endsWith('\n') ? '\n' : '') + `# OneHuman\n${envAdd.join('\n')}\n`, `adds ${envAdd.map((l) => l.split('=')[0]).join(', ')} (the secret is new and random; keep it stable)`);
  const giFile = join(root, '.gitignore');
  const gi = existsSync(giFile) ? readFileSync(giFile, 'utf8') : '';
  const giAdd = ['.env', 'onehuman.db*'].filter((l) => !gi.split('\n').some((x) => x.trim() === l || (l === '.env' && /^\.env\*?$/.test(x.trim()))));
  if (giAdd.length) put(giFile, gi + (gi && !gi.endsWith('\n') ? '\n' : '') + giAdd.join('\n') + '\n', `ignores ${giAdd.join(', ')} so the secret and the local database are never committed`);
  // load .env at start when the app does not already
  if (!deps.dotenv && !deps['@dotenvx/dotenvx'] && pkg.scripts) {
    const next = { ...pkg.scripts };
    let changed = false;
    for (const k of ['start', 'dev']) {
      const v = next[k];
      if (v && /^node\s/.test(v) && !/--env-file/.test(v)) { next[k] = v.replace(/^node\s/, 'node --env-file-if-exists=.env '); changed = true; }
    }
    if (changed) {
      const raw = readFileSync(pkgPath, 'utf8');
      const indent = raw.match(/^\{\s*\n([ \t]+)"/)?.[1] ?? '  ';
      put(pkgPath, JSON.stringify({ ...JSON.parse(raw), scripts: next }, null, indent) + '\n', 'npm start / npm run dev load .env (node --env-file-if-exists)');
    }
    else notes.push('Make sure your app loads .env when it starts (node --env-file=.env, or dotenv).');
  }

  // the code (Express)
  const protectedFiles = new Set<string>();
  let entry: string | null = null;
  if (framework === 'express') {
    const appRe = /^([ \t]*)(?:const|let|var)\s+(\w+)\s*=\s*express\s*\(\s*\)\s*;?[^\n]*$/m;
    entry = r.routes.map((x) => x.file).concat(listFiles(root)).find((f) => appRe.test(readFileSync(f, 'utf8'))) ?? null;
    if (!entry) notes.push('Could not find `express()` in your code: add `app.use(onehuman.middleware())` right after you create the app.');
    const pkgType = pkg.type;
    const setupDir = entry ? dirname(entry) : root;
    const entryStyle = entry ? styleOf(entry, readFileSync(entry, 'utf8'), pkgType) : { esm: pkgType === 'module', ts: false, ext: '.js', importSuffix: '.js' };
    // the setup file speaks the same module language as the server file, with an extension Node reads that way
    const setupExt = entryStyle.ts ? '.ts' : entryStyle.ext !== '.js' ? entryStyle.ext : entryStyle.esm ? (pkgType === 'module' ? '.js' : '.mjs') : (pkgType === 'module' ? '.cjs' : '.js');
    const setupFile = join(setupDir, `onehuman${setupExt}`);
    const policyRel = relative(root, policyFile).replace(/\\/g, '/');   // read relative to where the app is started: the project root
    const id = identifyExpr ? `  identify: (req${entryStyle.ts ? ': any' : ''}) => ${safeChain(identifyExpr)} ?? null,   // who is logged in: one session per login\n` : '  // identify: (req) => req.session?.userId ?? null,   // add your login id: one session per login, not per browser\n';
    const opts = `{\n  secret: process.env.ONEHUMAN_SECRET${entryStyle.ts ? " ?? ''" : ''},\n  policy: './${policyRel}',\n  apiKey: process.env.ONEHUMAN_API_KEY,   // the portal: agents seen, rules without a deploy (optional)\n${id}}`;
    const header = '// OneHuman — written by `npx onehumanai init`. Import `onehuman` wherever a route needs protection.\n// The rules are in onehuman.policy.json; with an API key they live in the portal after the first start.\n';
    if (!existsSync(setupFile)) {
      put(setupFile, entryStyle.esm || entryStyle.ts
        ? `${header}import { onehumanDeferred } from 'onehumanai';\n\nexport const onehuman = onehumanDeferred(${opts});\n`
        : `${header}const { onehumanDeferred } = require('onehumanai');\n\nconst onehuman = onehumanDeferred(${opts});\nmodule.exports = { onehuman };\n`, 'creates the OneHuman instance');
    }
    const importLine = (file: string) => {
      const st = styleOf(file, readFileSync(file, 'utf8'), pkgType);
      let rel = relative(dirname(file), setupFile).replace(/\\/g, '/');
      if (!rel.startsWith('.')) rel = './' + rel;
      if (st.ts) rel = rel.replace(/\.ts$/, st.importSuffix);   // TypeScript: follow the file's own import style
      return st.esm || st.ts ? `import { onehuman } from '${rel}';` : `const { onehuman } = require('${rel}');`;
    };
    const addImport = (file: string) => {
      let t = read(file);
      if (/\bonehuman\b.*from\s+['"][^'"]*onehuman|require\(['"][^'"]*onehuman/.test(t)) return;
      const line = importLine(file);
      const lines = t.split('\n');
      let at = 0;
      lines.forEach((l, i) => { if (/^\s*import\s.*from\s|^\s*import\s+['"]|^\s*(const|let|var)\s.*=\s*require\(/.test(l)) at = i + 1; });
      if (at === 0 && /^#!/.test(lines[0] ?? '')) at = 1;
      lines.splice(at, 0, line);
      t = lines.join('\n');
      put(file, t, `imports onehuman`);
    };
    if (entry) {
      addImport(entry);
      const t = read(entry);
      const m = appRe.exec(t)!;
      const indent = m[1]!, app = m[2]!;
      if (!t.includes(`${app}.use(onehuman.middleware())`)) {
        const at = afterLoginMiddleware(t, app, m.index + m[0].length);
        const where = at.after ? `right after ${at.after}` : 'right after the app is created';
        put(entry, t.slice(0, at.index) + `\n${indent}${app}.use(onehuman.middleware());   // OneHuman: the page script and its API, after the login middleware so identify() sees who is signed in` + t.slice(at.index), `${app}.use(onehuman.middleware()) ${where}`);
      }
    }
    for (const x of chosen) {
      const t = read(x.file);
      const lines = t.split('\n');
      const esc = (x.source ?? x.path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\.\\s*${x.method === 'ALL' ? 'all' : x.method.toLowerCase()}\\s*\\(\\s*(['"\`])${esc}\\1\\s*,`);
      let done = false;
      for (let i = x.line - 1; i < Math.min(lines.length, x.line + 2) && !done; i++) {
        const mm = re.exec(lines[i]!);
        if (!mm) continue;
        if (lines[i]!.includes('onehuman.protect(')) { done = true; break; }
        const preset = presetFor.get(x)!;
        const mask = PRESETS[preset]!.m.includes('mask') && x.method === 'GET' ? ", { mask: 'auto' }" : '';
        // after the route's own login check (requireLogin, passport.authenticate(…), …): a signed-out request is the
        // app's 401, not a OneHuman decision, and identify() already knows the user when OneHuman decides
        const cut = mm.index + mm[0].length + afterAuthHandlers(lines[i]!.slice(mm.index + mm[0].length));
        lines[i] = `${lines[i]!.slice(0, cut)} onehuman.protect('${x.resource}'${mask}),${lines[i]!.slice(cut)}`;
        put(x.file, lines.join('\n'), `protects ${x.method} ${x.path}`);
        protectedFiles.add(x.file);
        done = true;
      }
      if (!done) notes.push(`Could not place protect() on ${x.method} ${x.path} (${relative(root, x.file)}:${x.line}). Add onehuman.protect('${x.resource}') as the first handler of that route.`);
    }
    for (const f of protectedFiles) addImport(f);
    const masked = chosen.find((x) => x.method === 'GET' && PRESETS[presetFor.get(x)!]!.m.includes('mask'));
    if (masked) notes.push(`Routes that hide details use mask: 'auto': values are hidden, while ids, dates, flags and codes such as a currency are kept, and so is the shape. For a precise mask, pass your own function: onehuman.protect('${masked.resource}', { mask: (body) => ({ ...body, amount: null }) }).`);
    notes.push('Mark the values your pages show from protected routes with data-oh-sensitive="full" (the element that holds the balance, the e-mail, the IBAN). The page script hides them on screen the moment an agent attaches; without the mark, what is already on screen stays readable.');
  } else {
    const snippet = {
      fastify: "import { onehuman } from 'onehumanai';\nconst oh = await onehuman({ secret: process.env.ONEHUMAN_SECRET, policy: './onehuman.policy.json', apiKey: process.env.ONEHUMAN_API_KEY });\nfastify.addHook('onRequest', (req, reply, done) => oh.middleware()(req.raw, reply.raw, done));\n// on each protected route: { onRequest: (req, reply, done) => oh.protect('balance.read')(req.raw, reply.raw, done) }",
      next: '// Next.js: run the app through a small Express server (server.mjs) and add app.use(oh.middleware()) before the Next handler — see https://onehuman.ai/docs',
      other: '// Paste this into your coding agent:\n// https://www.npmjs.com/package/onehumanai — integrate it into my app. Use the rules in onehuman.policy.json and the keys in .env.',
    }[framework as 'fastify' | 'next' | 'other'];
    notes.push(`Add this to your server:\n${snippet}`);
  }
  if (addScript && html) {
    const t = read(html);
    // before the page's own scripts, so their first requests already go through it
    const tag = '<script src="/onehuman/sdk.js" data-fetch="auto" data-step-up="auto"></script>';
    const head = t.slice(0, t.search(/<\/head>/i));
    const first = head.search(/<script\b/i);
    put(html, first >= 0 ? t.slice(0, first) + tag + '\n  ' + t.slice(first) : t.replace(/<\/head>/i, `  ${tag}\n</head>`), 'adds the page script in <head>, before your scripts (it adds the click behind each request and asks for a passkey when the rules say so)');
    if (r.frontend.kind === 'spa') notes.push('If the page is served by a separate dev server (Vite, webpack), proxy /onehuman to your API server so /onehuman/sdk.js loads.');
  }
  if (!addScript && r.frontend.fetchCalls) notes.push('Add <script src="/onehuman/sdk.js" data-fetch="auto" data-step-up="auto"></script> to your pages: it carries the click behind each request, so a person is recognised as a person, and asks for a passkey when the rules say so.');
  if (chosen.some((x) => x.method === 'GET' && !PRESETS[presetFor.get(x)!]!.m.includes('mask') && /\.(csv|pdf|xlsx?|zip|json)$|export|download|statement/i.test(x.path))) notes.push('Downloads opened with a plain link (<a href>) carry no click evidence and cannot show a passkey dialog. Fetch the file with fetch() and save it from the page, or issue a single-use link after the decision (req.onehuman.token()).');
  const installed = !!deps['onehumanai'];

  // ---------------------------------------------------------------- show it, then do it
  say(`\n${bold('Here is what will change:')}`);
  if (!installed && flags.install) say(`  ${cyan('install')}  onehumanai  ${dim('(one package: middleware, page script, engine)')}`);
  for (const e of edits) {
    say(`  ${e.before === null ? green('new    ') : yellow('change ')} ${relative(root, e.file) || basename(e.file)}`);
    const routes = e.changes.filter((c) => c.startsWith('protects '));
    for (const ch of e.changes.filter((c) => !c.startsWith('protects '))) say(`           ${dim('· ' + ch)}`);
    if (routes.length) say(`           ${dim(`· protects ${routes.length === 1 ? routes[0]!.slice(9) : `${routes.length} routes`}`)}`);
  }
  if (framework === 'express') say(dim(`\n  Signed-in user: ${identifyExpr ? `${identifyExpr} (found in your code)` : 'none found, so each browser gets its own session'}. You can change it in onehuman.js.`));
  if (!edits.length && (installed || !flags.install)) { say(dim('  nothing — OneHuman already looks set up here.')); rl?.close(); return; }
  if (!(await confirm('Apply these changes?', true))) { say('\nNothing was written.'); rl?.close(); return; }
  rl?.close();

  // files first: the package manager then adds the dependency to the package.json we just wrote (the other order
  // overwrote it, and a fresh `npm ci` on the server would not install OneHuman at all)
  for (const e of edits) writeFileSync(e.file, e.after);
  if (!installed && flags.install) {
    const pm = packageManager(root, pkg);
    say(dim(`\n$ ${pm.join(' ')} onehumanai`));
    const res = spawnSync(pm[0]!, [...pm.slice(1), 'onehumanai'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
    if (res.status !== 0) notes.push(`Installing failed. Run \`${pm.join(' ')} onehumanai\` yourself.`);
  }

  say(`\n${green('✓')} ${bold('OneHuman is set up.')}`);
  say(`  ${enforcement === 'observe' ? 'It is watching only: nothing is blocked. Look at Activity, then turn protection on in the portal or in onehuman.policy.json.' : 'Protection is on from the first request.'}`);
  say(`\n${bold('Next:')}`);
  say(`  1. Start your app and open a page that calls a protected route.`);
  const entryText = entry ? readFileSync(entry, 'utf8') : '';
  const port = entryText.match(/\.listen\(\s*(?:process\.env\.PORT\s*(?:\|\||\?\?)\s*)?(\d{2,5})/)?.[1] ?? entryText.match(/\bPORT\s*(?:\|\||\?\?)\s*['"]?(\d{2,5})/)?.[1] ?? '3000';
  // verify sends GET requests: show it a protected route it can call
  const verifyPath = (chosen.find((x) => x.method === 'GET') ?? chosen[0])?.path.replace(/:\w+/g, '1') ?? '/api/…';
  say(`  2. Check it: ${cyan(`npx onehumanai verify http://localhost:${port} ${verifyPath}${identifyExpr ? ' --cookie "<your session cookie>"' : ''}`)}`);
  if (identifyExpr) say(`     The route needs a signed-in user: sign in with a test account and copy the session cookie from the browser. Add --attach to also check an attached agent (it marks that login as an agent for this visit).`);
  say(`  3. ${apiKey ? 'See it in the portal: https://onehuman.ai/portal' : 'For the portal (agents seen, rules without a deploy): create a key at https://onehuman.ai/portal and add ONEHUMAN_API_KEY to .env.'}`);
  for (const n of notes) say(`\n${yellow('!')} ${n}`);
  say('');
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 4) return;
    let list: string[] = [];
    try { list = readdirSync(d); } catch { return; }
    for (const e of list) {
      if (e === 'node_modules' || e.startsWith('.') || e === 'dist' || e === 'build') continue;
      const p = join(d, e);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (/\.(m?js|cjs|ts|mts)$/.test(e) && st.size < 600_000) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

/**
 * Where app.use(onehuman.middleware()) goes: after the app's session or login middleware (express-session,
 * cookie-session, passport, a JWT or auth middleware), so identify() sees who is signed in on the page script's own
 * requests too. Only app.use(...) lines before the first route count; otherwise right after the app is created.
 */
export function afterLoginMiddleware(text: string, app: string, created: number): { index: number; after: string | null } {
  const e = app.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const route = new RegExp(`\\b${e}\\s*\\.\\s*(get|post|put|patch|delete|all|route)\\s*\\(|\\b${e}\\s*\\.\\s*use\\s*\\(\\s*['"\`]/`, 'g');
  route.lastIndex = created;
  const firstRoute = route.exec(text)?.index ?? text.length;
  const use = new RegExp(`\\b${e}\\s*\\.\\s*use\\s*\\(`, 'g');
  use.lastIndex = created;
  let best: { index: number; after: string | null } = { index: created, after: null };
  for (let mm = use.exec(text); mm && mm.index < firstRoute; mm = use.exec(text)) {
    // the whole statement: up to the parenthesis that closes app.use(
    let depth = 0, i = mm.index + mm[0].length - 1;
    for (; i < text.length; i++) { const c = text[i]; if (c === '(') depth++; else if (c === ')' && --depth === 0) break; }
    const stmt = text.slice(mm.index, i + 1);
    if (!/session|passport|auth|jwt|clerk|lucia|cookieParser|cookie-parser|supabase/i.test(stmt) || /onehuman/.test(stmt)) continue;
    let end = i + 1;
    if (text[end] === ';') end++;
    best = { index: end, after: stmt.replace(/\s+/g, ' ').slice(0, 60) + (stmt.length > 60 ? '…' : '') };
  }
  return best;
}

/**
 * Route handlers written before the route's own function that check the login (requireLogin, isAuthenticated,
 * passport.authenticate('jwt'), auth.required, …): how far into `rest` protect() goes so it comes after them.
 */
export function afterAuthHandlers(rest: string): number {
  const AUTH = /^(?:require|ensure|check|verify|must|is)?[a-z]*(?:auth|login|logged|session|signed|user)[a-z]*$/i;
  let at = 0;
  for (;;) {
    const m = /^\s*([\w$.]+)(\s*\((?:[^()]|\([^()]*\))*\))?\s*,/.exec(rest.slice(at));
    if (!m) return at;
    if (!m[1]!.split('.').some((part) => AUTH.test(part))) return at;
    at += m[0].length;
  }
}
