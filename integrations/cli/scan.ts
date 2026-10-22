// SPDX-License-Identifier: Apache-2.0
/**
 * `onehumanai scan` — static discovery of what an AI agent could reach in this codebase.
 *
 * Walks the project, finds HTTP route definitions (Express/Fastify/Koa/NestJS/Next.js), scores each
 * route's sensitivity from its path, handler text and the data fields it touches, finds how a request is
 * tied to a logged-in user, and proposes a OneHuman policy. Output is a proposal for a human (or the AI
 * agent integrating the package) to confirm — never applied automatically.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

export type RouteHit = {
  file: string;
  line: number;
  method: string;
  /** the full URL path (a router's mount prefix included) */
  path: string;
  /** the path as written in the file, when it differs from `path` (routes of a mounted router) */
  source?: string;
  framework: string;
  /** 0..100 */
  sensitivity: number;
  /** why it scored */
  signals: string[];
  /** proposed resource id */
  resource: string;
  /** proposed policy */
  proposal: { onAgent: 'allow' | 'mask' | 'step_up' | 'block'; onArtifact: 'allow' | 'mask' | 'step_up' | 'block'; onUnknown: 'allow' | 'step_up' };
  /** read (returns data) or write (changes state) */
  kind: 'read' | 'write' | 'download';
};

export type IdentityHit = { file: string; line: number; expression: string; framework: string };

export type ScanResult = {
  root: string;
  filesScanned: number;
  frameworks: string[];
  routes: RouteHit[];
  identity: IdentityHit[];
  frontend: { kind: 'spa' | 'ssr' | 'mixed' | 'static' | 'unknown'; entryHtml: string[]; fetchCalls: number; axios: boolean };
  policyDraft: unknown;
  notes: string[];
};

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage', '.turbo', '.cache', 'vendor', '.vercel', 'public/vendor']);
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.mts']);
const HTML_EXT = new Set(['.html', '.ejs', '.hbs', '.pug', '.njk', '.vue', '.svelte']);

/** keyword → weight, category. Path segments and handler text are matched case-insensitively. */
const SENSITIVE: [RegExp, number, string][] = [
  [/balance|saldo|funds?|wallet/i, 40, 'money'],
  [/transaction|statement|ledger|history|payments?|payout/i, 30, 'money'],
  [/transfer|withdraw|deposit|send-?money|remit|swap|trade|order/i, 55, 'money-write'],
  [/iban|card(number|-number|_number)?|pan\b|cvv|account-?number|routing|swift|bic\b/i, 45, 'financial-id'],
  [/profile|personal|\/me\b|\/user\b|kyc|identity|passport|ssn|national-?id|birth|dob\b/i, 35, 'pii'],
  [/\b(phone|email|address|contact)s?\b/i, 25, 'pii'],
  [/medical|\bhealth-?(record|data|info)|diagnos|prescription|clinical|patient/i, 50, 'health'],
  [/claim|policy(holder)?|coverage|premium|insur/i, 30, 'insurance'],
  [/customer|client|lead|deal|pipeline|crm|opportunit/i, 25, 'crm'],
  [/\b(exports?|download|csv|xlsx|pdf|reports?|invoices?|receipts?|attachments?|documents?|statements?)\b(?!\s*=)/i, 35, 'download'],
  [/salary|payroll|compensation|tax/i, 40, 'hr'],
  [/password|secret|token|api-?key|2fa|otp|recovery/i, 30, 'credentials'],
  [/admin|settings|permission|role|delete|remove|close-?account/i, 30, 'admin-write'],
];
const NOT_SENSITIVE = /sign-?out|\/auth(\/|$)|next-?auth|better-?auth|health(check|z)?$|ping$|status$|metrics|login|logout|signin|signup|register|oauth|callback|static|assets|favicon|\.(js|css|png|svg|ico)$|webhook|csrf|version/i;

const ROUTE_PATTERNS: { framework: string; re: RegExp; method: (m: RegExpExecArray) => string; path: (m: RegExpExecArray) => string }[] = [
  // app.get('/x', …) / router.post("/x", …) / fastify.get('/x', …) / server.route({ method:'GET', url:'/x' })
  { framework: 'express', re: /\b(?:app|router|server|api|fastify|koaRouter|r)\s*\.\s*(get|post|put|patch|delete|all)\s*\(\s*(['"`])([^'"`]+)\2/g, method: (m) => m[1]!.toUpperCase(), path: (m) => m[3]! },
  { framework: 'fastify', re: /\.route\s*\(\s*\{[^}]*?method\s*:\s*['"`](GET|POST|PUT|PATCH|DELETE)['"`][^}]*?url\s*:\s*['"`]([^'"`]+)['"`]/gs, method: (m) => m[1]!, path: (m) => m[2]! },
  // NestJS: @Get('x') inside @Controller('y')
  { framework: 'nestjs', re: /@(Get|Post|Put|Patch|Delete)\s*\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g, method: (m) => m[1]!.toUpperCase(), path: (m) => '/' + (m[2] ?? '') },
  // Hono / Elysia / itty: app.get('/x')
  { framework: 'hono', re: /\bhono\s*\.\s*(get|post|put|patch|delete)\s*\(\s*(['"`])([^'"`]+)\2/g, method: (m) => m[1]!.toUpperCase(), path: (m) => m[3]! },
];

const IDENTITY_PATTERNS: { framework: string; re: RegExp; expr?: (m: RegExpExecArray) => string }[] = [
  { framework: 'express-session', re: /req\.session\??\.\w+(?:\.\w+)?/g },
  { framework: 'passport / req.user', re: /req\.user\??\.\w+/g },
  // the app's own login middleware: req.user = { id: … } / req.auth = decoded
  { framework: 'custom middleware', re: /\breq\.(user|auth|account|currentUser|member)\s*=(?!=)/g, expr: (m) => `req.${m[1]}` },
  { framework: 'jwt', re: /jwt\.verify\s*\(|jsonwebtoken|jose\b|verifyToken\(/g },
  { framework: 'next-auth / auth.js', re: /getServerSession\(|auth\(\)|getToken\(/g },
  { framework: 'clerk', re: /getAuth\(|clerkMiddleware|auth\(\)\.userId/g },
  { framework: 'supabase', re: /supabase\.auth\.getUser\(|getSession\(\)/g },
  { framework: 'firebase', re: /verifyIdToken\(/g },
  { framework: 'cookie', re: /req\.cookies\??\.\w+|cookies\(\)\.get\(/g },
];

function walk(root: string, out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out;
  let entries: string[] = [];
  try { entries = readdirSync(root); } catch { return out; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e) || e.startsWith('.')) continue;
    const p = join(root, e);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out, depth + 1);
    else if (st.size < 600_000 && (CODE_EXT.has(extname(e)) || HTML_EXT.has(extname(e)))) out.push(p);
  }
  return out;
}

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;

function score(method: string, path: string, context: string): { sensitivity: number; signals: string[]; kind: RouteHit['kind'] } {
  const signals: string[] = [];
  let s = 0;
  // a camelCase name is read as words: 'exportContacts' is an export of contacts
  const hay = `${path.replace(/([a-z0-9])([A-Z])/g, '$1-$2')} ${context}`;
  for (const [re, w, cat] of SENSITIVE) { if (re.test(hay)) { s += w; signals.push(cat); } }
  const excluded = NOT_SENSITIVE.test(path);
  if (excluded) { s = Math.min(s, 10); signals.push('excluded-pattern'); }
  // write operations on anything sensitive are more dangerous than reads (login/logout and the like stay excluded)
  const write = method !== 'GET';
  if (write && s > 0 && !excluded) s += 15;
  let kind: RouteHit['kind'] = write ? 'write' : 'read';
  if (/download|export|csv|xlsx|pdf|attachment/i.test(path) || /Content-Disposition|res\.download\(|res\.attachment\(|sendFile\(/.test(context)) kind = 'download';
  return { sensitivity: Math.max(0, Math.min(100, s)), signals: [...new Set(signals)], kind };
}

function resourceId(method: string, path: string, kind: RouteHit['kind']): string {
  const segs = path.split('/').filter((x) => x && !x.startsWith(':') && !x.startsWith('[') && !/^v\d+$/i.test(x) && x !== 'api');
  // a rule's resource may only hold a-z, 0-9, '_' and '.', starting with a letter: '/payout-account' is 'payout_account'
  const noun = (segs.slice(-2).join('.').toLowerCase().replace(/[^a-z0-9.]+/g, '_').replace(/\.{2,}/g, '.').replace(/^[^a-z]+|\.+$/g, '')) || 'resource';
  const verb = kind === 'download' ? 'export' : method === 'GET' ? 'read' : method === 'DELETE' ? 'delete' : /transfer|withdraw|send|pay/i.test(path) ? 'make' : 'write';
  // '/statements/export' is already an export: 'statements.export', not 'statements.export.export'
  const id = noun.split('.').pop() === verb || (verb === 'export' && /^(download|csv)$/.test(noun.split('.').pop() ?? '')) ? noun : `${noun}.${verb}`;
  return id.slice(0, 61).replace(/\.+$/, '');
}

function proposal(h: { sensitivity: number; kind: RouteHit['kind']; signals: string[] }): RouteHit['proposal'] {
  const s = h.sensitivity;
  if (h.kind === 'download') return { onAgent: 'block', onArtifact: 'step_up', onUnknown: s >= 60 ? 'step_up' : 'allow' };
  if (h.kind === 'write') return s >= 40 ? { onAgent: 'block', onArtifact: 'step_up', onUnknown: 'step_up' } : { onAgent: 'step_up', onArtifact: 'allow', onUnknown: 'allow' };
  // reads: the documented matrix. Credentials never reach a model, health records are refused; money, personal and
  // customer data are shown with details hidden, so the page keeps working for an agent the person sent
  if (h.signals.includes('credentials')) return { onAgent: 'block', onArtifact: 'block', onUnknown: 'step_up' };
  if (h.signals.includes('health')) return { onAgent: 'block', onArtifact: 'mask', onUnknown: 'allow' };
  if (s >= 30) return { onAgent: 'mask', onArtifact: 'mask', onUnknown: 'allow' };
  return { onAgent: 'mask', onArtifact: 'allow', onUnknown: 'allow' };
}

const ident = /^[A-Za-z_$][\w$]*$/;
const escapeRe = (s: string) => s.replace(/[$]/g, '\\$');

/**
 * Express routers carry any name (`const payroll = Router()`), and a router's routes are relative to where it is
 * mounted (`app.use('/api/hr', payroll)`). Collected from every file first: the router is often defined in one file
 * and mounted in another.
 */
function routerNames(texts: string[]): { names: Set<string>; mounts: Map<string, string> } {
  const names = new Set<string>();
  const mounts = new Map<string, string>();
  for (const t of texts) {
    for (const m of t.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:new\s+)?(?:express\s*\.\s*)?(?:Router|express|KoaRouter|Hono)\s*\(/g)) names.add(m[1]!);
    for (const m of t.matchAll(/\.(?:use|route)\s*\(\s*(['"`])(\/[^'"`]*)\1\s*,\s*([A-Za-z_$][\w$]*)\s*[,)]/g)) if (!mounts.has(m[3]!)) mounts.set(m[3]!, m[2]!.replace(/\/$/, ''));
  }
  return { names, mounts };
}


type Extra = { method: string; path: string; line: number; framework: string; ctx: string };
const kebab = (x: string) => x.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const clipCtx = (text: string, from: number, len = 1200) => text.slice(from, Math.min(text.length, from + len)).replace(/^\s*(import|export)\b[^\n]*\n/gm, '');

/**
 * Entry points that are not `app.get('/path')`: server actions ('use server'), tRPC and oRPC procedures, and Hono
 * routes written as a chain or under a base path. Each is a call an agent in the person's session can make.
 */
function extraRoutes(rel: string, text: string): Extra[] {
  const out: Extra[] = [];
  const base = (rel.split('/').pop() ?? rel).replace(/\.[^.]+$/, '');

  // Server actions: a file that starts with 'use server', or a function that opens with it
  const fileLevel = /^(?:\s*\/\/[^\n]*\n|\s*\/\*[\s\S]*?\*\/)*\s*(['"])use server\1/.test(text);
  if (fileLevel || /(['"])use server\1/.test(text)) {
    const seenNames = new Set<string>();
    const add = (name: string, index: number) => { if (name.startsWith('_') || seenNames.has(name)) return; seenNames.add(name); out.push({ method: 'POST', path: `/actions/${kebab(base)}/${kebab(name)}`, line: lineOf(text, index), framework: 'server-actions', ctx: clipCtx(text, index) }); };
    if (fileLevel) {
      for (const m of text.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) add(m[1]!, m.index!);
      for (const m of text.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/g)) add(m[1]!, m.index!);
    }
    for (const m of text.matchAll(/(?:async\s+function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{\s*|const\s+([A-Za-z_$][\w$]*)\s*=\s*async\s*\([^)]*\)\s*(?::[^=]+)?=>\s*\{\s*)(['"])use server\3/g)) add((m[1] ?? m[2])!, m.index!);
  }

  // tRPC: `name: someProcedure.input(...).query(...)` / `.mutation(...)`
  if (/@trpc\/server|initTRPC|createTRPCRouter|[pP]rocedure\b/.test(text)) {
    const router = text.match(/(?:const|let|export\s+const)\s+([A-Za-z_$][\w$]*?)(?:Router)?\s*=\s*(?:t\.router|createTRPCRouter|router|createRouter)\s*\(/)?.[1] ?? base;
    const keys = [...text.matchAll(/(?:^|[\s,{])([A-Za-z_$][\w$]*)\s*:\s*(?:[A-Za-z_$][\w$]*\.)?[A-Za-z_$]*[pP]rocedure\b/g)];
    keys.forEach((m, i) => {
      const end = keys[i + 1]?.index ?? Math.min(text.length, m.index! + 2500);
      const body = text.slice(m.index!, Math.min(end, m.index! + 2500));
      const kind = body.match(/\.\s*(query|mutation|subscription)\s*\(/)?.[1];
      if (!kind) return;
      out.push({ method: kind === 'mutation' ? 'POST' : 'GET', path: `/api/trpc/${kebab(router)}.${kebab(m[1]!)}`, line: lineOf(text, m.index!), framework: 'trpc', ctx: body });
    });
  }

  // oRPC: `name: os.route({ method, path }).input(...).handler(...)`
  if (/@orpc\//.test(text)) {
    for (const m of text.matchAll(/\.\s*handler\s*\(/g)) {
      const before = text.slice(Math.max(0, m.index! - 700), m.index!);
      // the key whose value chain reaches this handler: brackets between the key and the handler must balance
      const found = [...before.matchAll(/(?:^|[\s,{])([A-Za-z_$][\w$]*)\s*:\s*[A-Za-z_$]/g)].reverse().find((k) => {
        let depth = 0;
        for (const ch of before.slice(k.index! + k[0].length)) { if ('({['.includes(ch)) depth++; else if (')}]'.includes(ch) && --depth < 0) return false; }
        return depth === 0;
      });
      if (!found) continue;
      const key = found[1]!;
      const chain = before.slice(found.index!);
      const route = chain.match(/\.\s*route\s*\(\s*\{([^}]*)\}/);
      const method = route?.[1]?.match(/method\s*:\s*['"`](GET|POST|PUT|PATCH|DELETE)['"`]/)?.[1] ?? 'POST';
      const path = route?.[1]?.match(/path\s*:\s*['"`]([^'"`]+)['"`]/)?.[1] ?? `/rpc/${kebab(key)}`;
      out.push({ method, path, line: lineOf(text, m.index!), framework: 'orpc', ctx: before + clipCtx(text, m.index!, 900) });
    }
  }

  // Hono: chained routes, and a base path
  if (/from\s+['"]hono|new\s+(?:OpenAPI)?Hono\b/.test(text)) {
    const bp = text.match(/\.basePath\s*\(\s*['"`](\/[^'"`]*)['"`]/)?.[1]?.replace(/\/$/, '') ?? '';
    for (const m of text.matchAll(/\n\s*\.\s*(get|post|put|patch|delete)\s*\(\s*(['"`])([^'"`]+)\2/g)) out.push({ method: m[1]!.toUpperCase(), path: bp + m[3]!, line: lineOf(text, m.index!), framework: 'hono', ctx: clipCtx(text, m.index!, 900) });
  }
  return out;
}

export function scan(root: string): ScanResult {
  const files = walk(root);
  const texts = files.map((f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } });
  const { names: customRouters, mounts } = routerNames(texts);
  const receivers = ['app', 'router', 'server', 'api', 'fastify', 'koaRouter', 'r', ...[...customRouters].filter((n) => ident.test(n))].map(escapeRe);
  const EXPRESS = new RegExp(`\\b(${[...new Set(receivers)].join('|')})\\s*\\.\\s*(get|post|put|patch|delete|all)\\s*\\(\\s*(['"\`])([^'"\`]+)\\3`, 'g');
  const NEXT_ROUTE = new RegExp(`\\n\\s*(?:${[...new Set(receivers)].join('|')})\\s*\\.\\s*(?:get|post|put|patch|delete|all|use)\\s*\\(|\\n\\s*@(?:Get|Post|Put|Patch|Delete)\\(`);
  const routes: RouteHit[] = [];
  const identity: IdentityHit[] = [];
  const frameworks = new Set<string>();
  const entryHtml: string[] = [];
  let fetchCalls = 0, axios = false, ssrTemplates = 0, spaMarkers = 0;
  const seen = new Set<string>();

  for (const [i, f] of files.entries()) {
    const text = texts[i]!;
    // skip the file `init` wrote itself: its commented example of identify() is not the app's login
    if (!text || /written by `npx onehumanai init`/.test(text.slice(0, 200))) continue;
    const rel = relative(root, f);
    const ext = extname(f);
    if (HTML_EXT.has(ext)) {
      if (ext === '.html' && /<div id=["'](root|app)["']/.test(text)) { spaMarkers++; entryHtml.push(rel); }
      else if (ext === '.html' && /<script[^>]*type=["']module["']|<script src=/.test(text)) entryHtml.push(rel);
      else ssrTemplates++;
      continue;
    }
    if (/\bfetch\s*\(/.test(text)) fetchCalls += (text.match(/\bfetch\s*\(/g) ?? []).length;
    if (/from ['"]axios['"]|require\(['"]axios['"]\)/.test(text)) axios = true;
    if (/from ['"]react['"]|from ['"]vue['"]|from ['"]svelte/.test(text)) spaMarkers++;
    if (/res\.render\s*\(/.test(text)) ssrTemplates++;

    // Next.js file-system routes
    const nextApi = rel.match(/^(?:src\/)?(?:pages\/api\/(.+?)\.(?:ts|js)|app\/(.+?)\/route\.(?:ts|js))$/);
    if (nextApi) {
      const path = '/' + (nextApi[1] ? 'api/' + nextApi[1] : nextApi[2]!).replace(/\/index$/, '');
      const methods = [...text.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]!);
      for (const method of methods.length ? methods : ['GET']) {
        const sc = score(method, path, text.slice(0, 4000));
        const key = `${method} ${path}`; if (seen.has(key)) continue; seen.add(key);
        frameworks.add('nextjs');
        routes.push({ file: rel, line: 1, method, path, framework: 'nextjs', ...sc, resource: resourceId(method, path, sc.kind), proposal: proposal(sc) });
      }
    }
    // server actions, tRPC, oRPC and Hono chains
    for (const x of extraRoutes(rel, text)) {
      const key = `${x.method} ${x.path}`; if (seen.has(key)) continue; seen.add(key);
      const sc = score(x.method, x.path, x.ctx);
      frameworks.add(x.framework);
      routes.push({ file: rel, line: x.line, method: x.method, path: x.path, framework: x.framework, ...sc, resource: resourceId(x.method, x.path, sc.kind), proposal: proposal(sc) });
    }
    // NestJS controllers carry a prefix
    const nestPrefix = text.match(/@Controller\s*\(\s*['"`]([^'"`]*)['"`]\s*\)/)?.[1];
    const patterns = [{ framework: 'express', re: EXPRESS, method: (m: RegExpExecArray) => m[2]!.toUpperCase(), path: (m: RegExpExecArray) => m[4]! }, ...ROUTE_PATTERNS.slice(1)];
    for (const pat of patterns) {
      pat.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pat.re.exec(text))) {
        if (pat.framework === 'nestjs' && nestPrefix === undefined) continue;
        let path = pat.path(m);
        if (pat.framework === 'nestjs') path = '/' + [nestPrefix, path.replace(/^\//, '')].filter(Boolean).join('/');
        const written = path;
        const mount = pat.framework === 'express' ? mounts.get(m[1]!) : undefined;
        if (mount && customRouters.has(m[1]!)) path = (mount + (path === '/' ? '' : path)) || '/';
        const method = pat.method(m);
        if (method === 'ALL') continue;
        const key = `${method} ${path}`; if (seen.has(key)) continue; seen.add(key);
        // handler context ends at the next route definition, so neighbours' keywords do not leak in
        const tail = text.slice(m.index + m[0].length, Math.min(text.length, m.index + 1500));
        const nextRoute = tail.search(NEXT_ROUTE);
        const ctx = (m[0] + (nextRoute >= 0 ? tail.slice(0, nextRoute) : tail)).replace(/module\.exports[^\n]*|^\s*(import|export)\b[^\n]*/gm, '');
        const sc = score(method, path, ctx);
        const honoFile = pat.framework === 'express' && /from\s+['"]hono|new\s+(?:OpenAPI)?Hono\b/.test(text);
        const fw = honoFile ? 'hono' : pat.framework;
        frameworks.add(fw);
        routes.push({ file: rel, line: lineOf(text, m.index), method, path, ...(written !== path ? { source: written } : {}), framework: fw, ...sc, resource: resourceId(method, path, sc.kind), proposal: proposal(sc) });
      }
    }
    for (const pat of IDENTITY_PATTERNS) {
      pat.re.lastIndex = 0;
      let m: RegExpExecArray | null; let n = 0;
      while ((m = pat.re.exec(text)) && n < 3) { n++; identity.push({ file: rel, line: lineOf(text, m.index), expression: pat.expr ? pat.expr(m) : m[0], framework: pat.framework }); }
    }
  }

  routes.sort((a, b) => b.sensitivity - a.sensitivity || a.path.localeCompare(b.path));
  const protectedRoutes = routes.filter((r) => r.sensitivity >= 30);
  const frontend: ScanResult['frontend'] = { kind: spaMarkers && ssrTemplates ? 'mixed' : spaMarkers ? 'spa' : ssrTemplates ? 'ssr' : entryHtml.length ? 'static' : 'unknown', entryHtml: entryHtml.slice(0, 5), fetchCalls, axios };

  // identity: rank by frequency of expression prefix
  const byExpr = new Map<string, IdentityHit & { count: number }>();
  for (const h of identity) { const k = h.expression.replace(/\?\./g, '.').split('.').slice(0, 3).join('.'); const cur = byExpr.get(k); if (cur) cur.count++; else byExpr.set(k, { ...h, expression: k, count: 1 }); }
  // identify() must return an id, not the user object (an object stringifies to one value for everyone):
  // prefer a field the code itself reads under the same object, else `.id`
  const ID_FIELDS = ['id', 'userId', 'uid', 'sub', 'email', 'username'];
  for (const h of byExpr.values()) {
    const last = h.expression.split('.').at(-1) ?? '';
    if (ID_FIELDS.includes(last)) continue;
    const deeper = identity.map((x) => x.expression.replace(/\?\./g, '.')).filter((e) => e.startsWith(h.expression + '.')).map((e) => e.slice(h.expression.length + 1).split('.')[0]!);
    const field = ID_FIELDS.find((f) => deeper.includes(f)) ?? (/^(user|account|profile|currentUser|auth|member)$/.test(last) ? 'id' : null);
    if (field) h.expression = `${h.expression}.${field}`;
  }
  const identityRanked = [...byExpr.values()].sort((a, b) => b.count - a.count).slice(0, 5);

  const notes: string[] = [];
  if (!routes.length) notes.push('No HTTP route definitions recognised. If the server is not Node (Java/.NET/Go/Python), the middleware does not apply; run the OneHuman engine as a Node sidecar in front of the data endpoints instead.');
  if (!identityRanked.length) notes.push('No login/session expression found: OneHuman will fall back to a first-party cookie per browser. If the app has authentication, tell the integrator where the user id lives on the request.');
  if (frontend.kind === 'spa' || frontend.kind === 'mixed') notes.push(`SPA detected: add <script src="/onehuman/sdk.js"> to ${frontend.entryHtml[0] ?? 'the entry HTML'} and mark rendered sensitive values with data-oh-sensitive in the components.`);
  if (axios) notes.push('axios is used: add OneHuman.sessionHeaders() and X-OH-Sample from OneHuman.snapshot(true) in a request interceptor for protected calls, or switch those calls to OneHuman.fetch.');
  if (routes.some((r) => r.kind === 'download' && r.sensitivity >= 30)) notes.push('Download/export routes found: decide on the request that issues the link (protect) and put req.onehuman.token() in the file URL; redeem it in the file route.');

  const policyDraft = {
    version: 'draft-1',
    enforcement: 'observe',
    rules: protectedRoutes.filter((r, i, all) => all.findIndex((x) => x.resource === r.resource) === i).map((r) => ({ resource: r.resource, title: `${r.method} ${r.path}`, onAgent: r.proposal.onAgent, onArtifact: r.proposal.onArtifact, onUnknown: r.proposal.onUnknown, onHumanLike: 'allow', actOn: ['verified', 'strong', 'control', 'behavioral'], minScore: 65 })),
  };
  return { root, filesScanned: files.length, frameworks: [...frameworks], routes, identity: identityRanked, frontend, policyDraft, notes };
}

const WHY: Record<string, string> = {
  money: 'balances and transaction history — the first thing a user asks an agent to read',
  'money-write': 'moves money or creates orders — an agent acting on a stale or injected instruction can cause loss',
  'financial-id': 'IBAN / card / account numbers — copyable identifiers, prime target for exfiltration via an agent',
  pii: 'personal data (name, ID, contact, address) — regulated; agents summarise and forward it',
  health: 'medical records — highest sensitivity class, usually must not reach a third-party model',
  insurance: 'policy, claims and coverage data — contractual and personal',
  crm: 'customer / lead / deal records — bulk-readable by an agent in one pass',
  download: 'file export — one click gives the agent the whole dataset as a document',
  hr: 'salary / payroll / tax — sensitive employment data',
  credentials: 'credentials or tokens — must never be readable by an agent',
  'admin-write': 'settings, roles or deletion — irreversible actions an agent may take by mistake',
};
const modeWord = (m: string) => ({ allow: 'allow', mask: 'mask sensitive fields', step_up: 'require step-up confirmation', block: 'block' }[m] ?? m);

/** A proposal in plain language, meant to be pasted to the product owner (by the integrating AI agent). */
export function renderProposal(r: ScanResult): string {
  const prot = r.routes.filter((x) => x.sensitivity >= 30);
  const out: string[] = [];
  out.push('PROPOSAL — what an AI browser agent could reach in this application, and what I suggest');
  out.push('');
  out.push(`I scanned ${r.filesScanned} files (${r.frameworks.join(', ') || 'no recognised framework'}). An AI agent operating a logged-in user's browser session inherits that session: every endpoint below is reachable by it with the user's rights. ${prot.length} of ${r.routes.length} routes handle data or actions that should be gated:`);
  out.push('');
  for (const x of prot) {
    const why = x.signals.filter((c) => WHY[c]).map((c) => WHY[c]).slice(0, 2).join('; ');
    out.push(`• ${x.method} ${x.path}  (${x.file}:${x.line})`);
    out.push(`    why: ${why || 'sensitive by path/handler keywords'}`);
    out.push(`    proposal: proven agent → ${modeWord(x.proposal.onAgent)} · AI-browser environment only → ${modeWord(x.proposal.onArtifact)} · not enough signal → ${modeWord(x.proposal.onUnknown)} · human evidence → allow`);
  }
  const rest = r.routes.filter((x) => x.sensitivity < 30);
  if (rest.length) out.push('', `Left unprotected (low sensitivity or auth/health/static): ${rest.map((x) => `${x.method} ${x.path}`).join(', ')}`);
  out.push('');
  out.push(`Session identity: ${r.identity.length ? `use identify(req) → ${r.identity[0]!.expression} (found in ${r.identity[0]!.file}); return null when not logged in.` : 'no login expression found → per-browser cookie mode (tell me if the app has authentication).'}`);
  out.push(`Front end: ${r.frontend.kind}${r.frontend.axios ? ', axios' : ''} → add <script src="/onehuman/sdk.js">, call protected endpoints through OneHuman.fetch (or an axios interceptor), mark rendered sensitive values with data-oh-sensitive so they are redacted the instant an agent attaches.`);
  out.push('Rollout: start in observe mode (nothing blocked, every decision recorded with what would have happened); switch to enforce after review.');
  out.push('');
  out.push('Questions for you: (1) confirm/edit the protected list; (2) modes per route; (3) observe or enforce; (4) session identity expression; (5) storage (sqlite file vs libSQL); (6) built-in step-up/passkey or your own OTP; (7) where ONEHUMAN_SECRET lives.');
  return out.join('\n');
}

export function renderReport(r: ScanResult): string {
  const out: string[] = [];
  out.push(`OneHuman scan — ${r.root}`);
  out.push(`${r.filesScanned} files · frameworks: ${r.frameworks.join(', ') || 'none recognised'} · front end: ${r.frontend.kind}${r.frontend.axios ? ' (axios)' : ''} · fetch() calls: ${r.frontend.fetchCalls}`);
  out.push('');
  const prot = r.routes.filter((x) => x.sensitivity >= 30);
  out.push(`Routes an AI agent could reach with the user's session: ${r.routes.length} found, ${prot.length} look sensitive`);
  out.push('');
  out.push('  score  method  path                                   kind      proposal (agent / env-only / unknown)   resource');
  for (const x of r.routes.slice(0, 40)) {
    out.push(`  ${String(x.sensitivity).padStart(5)}  ${x.method.padEnd(6)}  ${x.path.padEnd(38).slice(0, 38)} ${x.kind.padEnd(9)} ${x.sensitivity >= 30 ? `${x.proposal.onAgent} / ${x.proposal.onArtifact} / ${x.proposal.onUnknown}`.padEnd(38) : 'leave unprotected'.padEnd(38)} ${x.resource}   ${x.file}:${x.line}${x.signals.length ? `  [${x.signals.join(',')}]` : ''}`);
  }
  if (r.routes.length > 40) out.push(`  … ${r.routes.length - 40} more`);
  out.push('');
  out.push('How a request is tied to the logged-in user (candidates for identify()):');
  if (!r.identity.length) out.push('  none found → cookie mode');
  for (const i of r.identity) out.push(`  ${i.expression.padEnd(36)} ${i.framework.padEnd(22)} e.g. ${i.file}:${i.line}`);
  out.push('');
  for (const n of r.notes) out.push(`! ${n}`);
  out.push('');
  out.push('Draft policy written to onehuman.policy.draft.json (enforcement: observe). Confirm resources and modes, then rename to onehuman.policy.json.');
  out.push('');
  out.push('────────────────────────────────────────────────────────────────');
  out.push(renderProposal(r));
  return out.join('\n');
}
