# OneHuman

**Access control for the AI agents your customers log in with.** Your customers now log into your product with AI agents: Claude in Chrome, ChatGPT agent, Codex, Comet. OneHuman decides what those agents may see and do. It hides private data from them, asks the account owner (with a passkey) before anything risky, and signs every decision on your own server. It is for your customers' AI agents, not your team's AI or agents your company builds.

Customers now hand their logged-in bank, CRM and insurance sessions to Claude, ChatGPT Agent, Codex and other agentic browsers. Bot management stops bots at the door; it does nothing once a legitimate user is inside and an agent is operating their session. OneHuman works *inside* the session: it detects the moment an agent attaches, redacts what is already on screen, and lets each endpoint decide per resource — **allow · mask · step-up · block** — with a human-verified way back.

> **Security engineer? Read [QUICKSTART.md](QUICKSTART.md) first** — what it does, what it collects, how it fails and how to install it, in one screen. The long protocol below is written for AI coding agents.

- **Proof, not a guess.** Every decision — allowed, hidden, refused, or confirmed by the person with a passkey — is signed on your server (Ed25519). An auditor checks it offline with `npx onehumanai verify-proof`, without trusting us.
- **Detects at attach time, before the first click.** Agent-tool DOM markers, injected globals, evaluated-script read bursts, focus emulation, Web Bot Auth signatures. Measured: Claude in Chrome 0.1–0.5 s after attach; Codex 0.14 s; in-app agent browsers at first read.
- **Tells hands from programs per click.** Pointer kinematics — trajectory curvature, tremor, sub-movements, deceleration onto the target, hold time, pressure, teleport. Humans hold 83–225 ms with ≥35 trajectory points; agents 1–4 ms with none. Measured on our own set: 397 human clicks from 22 browsers and devices, 2 read as a program; 824 agent clicks, 2 read as human. Not an independent study — method and limits: https://onehuman.ai/measurements
- **Never treats "unknown" as human.** Decisions need evidence in both directions; a person inside an AI browser is unlocked by their own first click, not by default.
- **Protects data already on screen.** Elements marked `data-oh-sensitive="full"` are redacted in the browser the instant an indicator appears — a read already in flight sees `••••`.
- **Session memory with a human exit.** Once an agent attached, the session stays "agent" until a WebAuthn user-verified passkey (Touch ID / Windows Hello) reclaims it for 5 minutes.
- **Yours to run.** Express middleware + browser SDK; policy is your JSON, masking is your function, storage is `node:sqlite` on your disk (or libSQL). Telemetry is metadata only and never has to leave your network. Start in `observe` mode: nothing is blocked, every decision is recorded with what *would* have happened.

```bash
npm i onehumanai            # or pnpm add / yarn add · Node ≥ 22.13 · Express 4/5, Connect, Next.js custom server, plain node:http
npx onehumanai init         # asks what to protect and how, shows every change, applies it on yes
```

`init` reads your project, lists the routes an AI agent could misuse with a customer's login, proposes how to protect each one (from "hide details" to "passkey for everyone"), and asks three things: is the proposal right, watch first or protect now, and your portal API key (Enter skips it). It finds the login id in your code itself. It then shows each file it would write or change and waits for your yes. For Express it wires the code itself (a small `onehuman.js`, `app.use(onehuman.middleware())`, `onehuman.protect()` on each route); for other servers it writes the rules and `.env` and prints the lines to add. `npx onehumanai init --yes` takes the recommended answers (CI, coding agents). `npx onehumanai scan .` only reports, and writes a draft policy.

That is the only install. `onehumanai` holds the middleware, SDK and CLI (Apache-2.0) and the engine they run on (BUSL-1.1, production use granted); you never import the engine yourself. Everything you use is `onehumanai` and `npx onehumanai`.

```js
import { onehuman } from 'onehumanai';

const oh = await onehuman({ secret: process.env.ONEHUMAN_SECRET, policy: './onehuman.policy.json', db: 'sqlite:./onehuman.db',
                              identify: (req) => req.session?.userId ?? null });
app.use(oh.middleware());                                                        // serves /onehuman/sdk.js + its API
app.get('/api/balance', oh.protect('balance.read'), (req, res) => oh.send(req, res, balance, maskBalance));
```
```html
<script src="/onehuman/sdk.js"></script>   <!-- then call protected endpoints with OneHuman.fetch(url) -->
```

Three lines on the server, one tag on the page, one policy file. **Integration is designed to be done by an AI coding agent**: hand it this link and say "install this" — the next section is its protocol (analyse → propose → ask → implement → verify).

**Paste this to Claude Code, Codex, Cursor or any coding agent:**

```text
https://www.npmjs.com/package/onehumanai — install this into my app.
Follow the README protocol exactly: read my code as if you were an AI browser agent
holding one of my customers' logged-in sessions, show me the exposure map and what
you propose to gate, ask me the nine decisions, then implement the server wiring,
the page tags, the policy file and every mask function yourself, verify with
`npx onehumanai verify`, and report what you left open.
```


---

## If OneHuman is slow or fails, your app keeps working

OneHuman is designed to fail open. A protected request waits at most `decisionTimeoutMs` (default 1000 ms, or `ONEHUMAN_TIMEOUT_MS`) for a decision. If the engine is slower, or throws (a locked database, a bug, anything):

- the request **continues as if allowed** — your handler runs, your users see nothing;
- `req.onehuman.failedOpen` is `'ENGINE_TIMEOUT'` or `'ENGINE_ERROR'`, the response carries `X-OH-Decision: failed-open:<reason>`;
- it is logged once a minute (`onehuman: … the request went on without one`), counted in `GET /onehuman/health` → `failOpen: { count, lastReason, lastError, lastAt }`, and reported to the portal as an `unknown` visitor;
- OneHuman's own routes (`/onehuman/*`) answer 503 themselves and never reach your error handler.

**Observe mode always fails open.** In enforce mode you may choose the opposite for the few endpoints where serving without a decision is worse than an error: `failOpen: false` answers 503 instead. A late decision that arrives after the timeout is discarded; it never writes to a response that already went out.

## If you are an AI coding agent and were told "install this"

Read this section first; it is the whole task. The user handed you a link and one sentence. Installing the package is 5 % of the job. The job is a **security analysis of their application from the point of view of an AI browser agent holding a customer's session**, a proposal they can decide on, and a complete, verified implementation — including the policy file and every mask/step-up/block behaviour. Work in this order. Never decide the questions in step 3 yourself.

### Step 0 — Threat model you are working against (read, then explain it in their words)
A customer logs into this application, then tells an AI browser agent (Claude in Chrome, Claude/ChatGPT desktop browsers, Codex, Comet, Atlas, a Playwright bot) what to do. The agent inherits the session: same cookies, same IP, same browser. Three things go wrong: (1) **exfiltration** — personal and financial data flows into a third-party model and its logs; (2) **unintended actions** — the agent misreads or is prompt-injected and moves money, deletes, changes settings; (3) **no accountability** — afterwards nobody can say whether the customer or the agent acted. Existing controls (bot management at the edge, MFA at login, enterprise browser policies) do not see this: the session is legitimate and already inside.

OneHuman answers it at the endpoint: attach-time detection (agent-tool markers, injected globals, evaluated-script reads, signed requests), pointer physics per click, on-screen redaction the instant an agent attaches, a policy per resource (`allow · mask · step_up · block`), and a passkey path for the human to take the session back.

### Step 1 — Install and scan (no questions yet)
```bash
npm i onehumanai
npx onehumanai scan .              # full report + onehuman.policy.draft.json (observe mode)
npx onehumanai scan . --proposal   # plain-language proposal for the product owner
npx onehumanai scan . --json       # machine-readable, if you prefer to parse
```
The scanner finds every HTTP route an agent could call with the user's session (Express, Fastify, Koa, NestJS, Next.js), scores sensitivity (money, financial identifiers, personal data, health, HR, credentials, exports, state-changing writes), proposes a mode per route, locates the login identity on a request (`req.session.userId`, `req.user.id`, JWT, Auth.js, Clerk, Supabase, cookies), detects SPA vs SSR and axios, and writes a draft policy. **If it finds no routes, the server is not Node**: stop, say that only the Node middleware exists today and the engine can run as a Node sidecar in front of the data endpoints, and ask whether to proceed that way.

Then read the code yourself and **correct the scan** — it is a starting point, you are the analyst:
- Add handlers it missed: anything returning balances, statements, personal or contact data, documents, exports/downloads, health or HR records, credentials/tokens, or performing transfers, payments, deletions, permission or settings changes, bulk reads (list/search endpoints over customer data).
- Follow the data, not just the URL: a `GET /api/dashboard` that embeds the balance is a balance endpoint; a GraphQL or RPC endpoint with sensitive fields is several resources behind one URL — name them by field group.
- Look at what the front end renders: every element showing a protected value must later carry `data-oh-sensitive`.
- Drop false positives (health checks, static, auth flows, public content).

### Step 2 — Present the analysis (before asking anything)
Send the user a short document, in their language and with their route names, structured as:
1. **Exposure map** — one line per route/resource: what it exposes, who is affected, how an agent would reach it (read vs act), and the *reason it matters* (data class; irreversible; bulk-readable; regulated).
2. **Proposed handling** per resource in three situations — agent proven · only the environment looks agent-like (AI app browser / agent extension installed, nothing proves an agent is acting) · not enough signal — plus "human evidence → allow". Use this default matrix and justify deviations:

| Resource class | Agent proven | Environment only | Unknown | Why |
| --- | --- | --- | --- | --- |
| Balances, statements, transaction lists | mask | mask | allow | read-only money; masking keeps the UI usable |
| Personal / contact / KYC data | mask | mask | allow | regulated PII, agents summarise and forward |
| Documents, exports, downloads | block | step_up | allow | one click hands over the whole dataset |
| Transfers, payments, orders | block | step_up | step_up | irreversible; injected instructions cause loss |
| Deletes, role/permission/settings changes | block | step_up | step_up | irreversible administrative actions |
| Credentials, tokens, recovery | block | block | step_up | must never reach a model |
| Health / medical | block | mask | allow | highest sensitivity class |
| Search/list over customers (CRM) | mask | mask | allow | bulk-readable in one pass |
| Public / non-sensitive | allow | allow | allow | leave unprotected |

3. **Mask design** per masked resource — what exactly disappears and what stays so the page still renders: amounts → `null`; IBAN/card → first 4 + last 4; phone/e-mail → domain or last 2 digits; addresses → city only; document bodies → title + date; lists → keep rows, mask sensitive columns, cap row count. Masks are the company's own functions; you will write them.
4. **Rollout** — start in `observe` (nothing blocked, every decision recorded with what *would* have happened), review the decision log, flip to `enforce`.
5. **What this does not cover** — say it plainly: server-to-server API keys, mobile apps without the SDK, and a person deliberately relaying data to an agent by hand.

### Judgement calls — what you see in the code should change what you recommend

The matrix is the default. You are expected to depart from it when the code tells you to, and to say why in one sentence. These are the patterns that should move your recommendation:

| When you find… | Recommend | Because |
| --- | --- | --- |
| A list/search endpoint over customer records with no page size cap, or a cursor the client controls | `mask` **and** a hard row cap for agents; drop `nextCursor` | one agent pass reads the whole base; masking columns alone still leaks volume |
| An aggregate endpoint (`/dashboard`, `/summary`, `/me`) that embeds a value you protect elsewhere | the same resource name and the same mask on the embedded field | the protection is per resource, not per URL — a second URL for the same number is a hole |
| GraphQL / tRPC / JSON-RPC behind one URL | one resource **per field group**, decided in the resolver with `{ respond: false }` | URL-level rules cannot see which fields were asked for |
| Writes to recovery data (phone, e-mail, address, security questions, devices) | `block` for agents, `step_up` otherwise, even if the app treats it as "profile" | changing recovery data is how an account is taken over *later*, after the agent is gone |
| Money movement with an idempotency key already present | keep it, and bind the step-up grant to that key | otherwise the retry after `428` can run the transfer twice |
| Money movement **without** an idempotency key | add one before wiring the step-up, and tell the user you did | a gate in front of a non-idempotent action creates the double-execution it was meant to prevent |
| PDF/CSV/XLSX generation, `Content-Disposition: attachment`, signed S3/GCS URLs | protect the request that *issues* the link, token-bind the file route | the file URL outlives the decision; a copied link must be dead |
| Role checks (`isAdmin`, `role === 'manager'`) on a route | `block` agents on the admin branch regardless of the data class | administrative reach multiplies the blast radius of one injected instruction |
| Health, medical, HR, minors' data, biometric templates | `block` for agents; `mask` for environment-only; never `allow` on `onUnknown` for the raw record | the highest regulated classes; masking is not enough because the *existence* of a record is the secret |
| A SPA that calls the API with `axios`/`ky`/a generated client | interceptor with `OneHuman.sessionHeaders()` + `X-OH-Sample`, not `OneHuman.fetch` rewrites | without the click sample a person inside an AI browser is never unlocked |
| SSR pages that render protected values into HTML | mark the rendered elements `data-oh-sensitive="full"` **and** protect the data loader | seal-on-attach covers what is already on screen; the loader covers the next navigation |
| A mobile app or partner API hitting the same endpoints without the SDK | say so explicitly in the report; those clients decide on `onUnknown` | the SDK is what turns "unknown" into "human"; be honest about where it is absent |
| A non-Node backend | stop, propose the Node sidecar in front of the data endpoints, ask before continuing | there is no other server integration today; do not improvise one |

When two rows apply, the stricter one wins. When none applies and the data is not in the matrix, ask — do not invent a class.

Two habits that separate a good integration from a checklist run:
- **Trace the number, not the route.** For each protected value, `grep` for where it is *read* (loader, resolver, serializer, template, test fixture) and where it is *derived* (totals, charts, exports, e-mails). Every place it appears is either protected the same way or listed as deliberately open.
- **Say what you would do, then ask.** Every question in step 3 comes with your recommendation and the reason. A user who only gets a question will guess; a user who gets a recommendation will correct you when you are wrong — which is the point.

### Step 3 — Ask the nine decisions (each with your recommended default)
1. Confirm/edit the resource list from the exposure map.
2. Per resource, `onAgent` — default from the matrix.
3. Per resource, `onArtifact` (environment only) — default from the matrix. Explain: a person browsing inside Claude/ChatGPT is unlocked by their own first click through pointer physics, *provided the page calls protected endpoints through `OneHuman.fetch`*.
4. `observe` (recommended, 1–2 weeks) or `enforce`.
5. Session identity for `identify(req)`: confirm the expression. It must return the login/user id **or `null`** — never a constant (a constant merges all anonymous visitors into one session).
6. Storage: `sqlite:./onehuman.db` on the server's disk (default) or a libSQL/Turso URL (multi-instance, serverless, read-only filesystems).
7. Step-up: built-in challenge + passkey reclaim now, or their OTP/push via `grantStepUp` later.
8. `ONEHUMAN_SECRET`: generate with `npx onehumanai secret`, store in their env/secret manager. Never hardcode, never commit.
9. URL prefix `/onehuman` — change only on collision.

### Step 4 — Implement everything (server, page, policy, masks)
**Server**
```js
import { onehuman } from 'onehumanai';

const oh = await onehuman({
  secret: process.env.ONEHUMAN_SECRET,                    // ≥ 32 bytes, stable across restarts
  policy: './onehuman.policy.json',               // the confirmed draft, renamed
  db: 'sqlite:./onehuman.db',                     // or 'libsql://…?authToken=…'
  identify: (req) => req.session?.userId ?? null,   // decision 5 — null when not logged in
});
app.use(oh.middleware());                           // before your routes: serves /onehuman/sdk.js + the SDK API

app.get('/api/balance', oh.protect('balance.read'), (req, res) =>
  oh.send(req, res, fullBalance, (full) => ({ ...full, amount: null, iban: full.iban.slice(0, 4) + ' •••• ' + full.iban.slice(-4) })));
```
- `protect()` answers `block` → **403** and `step_up` → **428** itself; pass `{ respond: false }` to branch on `req.onehuman.decision` yourself (response envelopes, custom error shapes, GraphQL resolvers).
- Write **one mask function per masked resource** following the mask design you presented. Keep the shape so the UI still renders. Never mask in the front end.
- **Downloads/exports**: protect the request that *issues* the link, put `req.onehuman.token()` in the file URL, redeem with `oh.engine.redeemToken(token, req.onehuman.session.id, resource)` in the file route.
- **Writes** (transfers, deletes): protect the mutating endpoint; on `step_up` the client shows the confirmation flow, then retries.
- Next.js custom server (`server.mjs` + `next()`): mount `oh.middleware()` and protected routes on Express **before** `app.all('*', handle)`. Fastify/Koa: `protect()`/`middleware()` are `(req, res, next)` over Node's raw request/response — use the framework's raw adapter.

**Front end** (every page that shows or requests protected data)
```html
<script src="/onehuman/sdk.js"></script>
```
- **Simplest: `<script src="/onehuman/sdk.js" data-fetch="auto" data-step-up="auto"></script>`** before the page's own scripts. Every same-origin `fetch()` and `XMLHttpRequest` then carries the click behind it (no code change, axios included), and a 428 is answered with a built-in passkey dialog and one retry. `npx onehumanai init` writes this tag. Otherwise:
- **Call protected endpoints with `OneHuman.fetch(url, init)`** (same signature as `fetch`). It carries the click's pointer trajectory; without it human evidence never reaches the server and a person inside an AI browser stays masked. axios/ky: add `OneHuman.sessionHeaders()` and `'X-OH-Sample': JSON.stringify(OneHuman.snapshot(true))` in a request interceptor. React/Next: guard with `window.OneHuman?.fetch ?? fetch`.
- Mark every rendered sensitive element `data-oh-sensitive="full"` (real values) or `"masked"` (placeholders). The SDK redacts every `"full"` element the instant an agent attaches and dispatches the `document` event `onehuman:sealed` → show a notice and re-fetch.
- **403**: show "protected — an AI agent is operating this session"; if `body.stepUp?.reclaim`, offer "I'm human — verify with passkey": `POST /onehuman/webauthn/assert/options` → `navigator.credentials.get` → `POST /onehuman/webauthn/assert` → `OneHuman.unseal(response.reclaim)` → retry. `unseal()` accepts only that server proof; never wire it to a plain button. Registration: `/onehuman/webauthn/register/options` → `navigator.credentials.create` → `/onehuman/webauthn/register`.
- **428**: step-up dialog; demo answer → `POST /onehuman/step-up {id, answer}`; own OTP → verify your way, then server-side `oh.engine.store.grantStepUp(sessionId, resource, ttlMs)`, then retry.
- CSP: `script-src 'self'`, `connect-src 'self'`; add `chrome-extension:` to `img-src`/`connect-src` for installed-extension detection.

**Policy**: apply the answers to `onehuman.policy.draft.json`, rename to `onehuman.policy.json`. Branches: `onAgent` proven agent · `onArtifact` environment only · `onUnknown` not enough signal (never treated as human) · `onHumanLike` kinematic/behavioral human evidence or passkey. Keep `actOn`/`minScore` defaults. Unlisted resources stay unprotected — list that explicitly in your report. With an `apiKey` the file becomes version 1 in the portal on first start; later edits you make to it are sent there and may wait for the owner's approval (a change that weakens protection always does, by default) — say so in your report instead of assuming it is live.

### Mask cookbook — write these yourself, one per masked resource

A mask is **not** a redaction of the string after the fact; it is a second projection of the same record, built on the server, that keeps the page working and removes what a model must not read. Keep the response's shape and types (a UI that expects a number should get `null`, not `"••••"`), never return the real value in a field the mask "forgot", and never compute a mask in the browser.

```js
// money: keep currency and shape, drop the number
const maskMoney  = (b) => ({ ...b, amount: null, available: null, currency: b.currency, masked: true });
// account identifiers: enough to recognise, not enough to transact
const maskIban   = (v) => v.slice(0, 4) + ' •••• ' + v.slice(-4);
const maskCard   = (v) => '•••• •••• •••• ' + v.slice(-4);
// people: keep the person identifiable to the account owner, not to a model
const maskName   = (v) => v.split(' ').map((w) => w[0] + '.').join(' ');
const maskEmail  = (v) => v[0] + '•••@' + v.split('@')[1];
const maskPhone  = (v) => v.replace(/\d(?=\d{2})/g, '•');
const maskAddr   = (a) => ({ city: a.city, country: a.country });           // street and number gone
const maskDob    = (v) => v.slice(0, 4) + '-••-••';
// documents: metadata only, never the body
const maskDoc    = (d) => ({ id: d.id, title: d.title, date: d.date, body: null, url: null });
// collections: keep the rows so the table renders, mask the columns, cap the page
const maskRows   = (rows, cap = 20) => rows.slice(0, cap).map((r) =>
  ({ ...r, name: maskName(r.name), email: maskEmail(r.email), phone: maskPhone(r.phone), notes: null }));
// aggregates: a total is a leak when the list is masked
const maskTotals = (t) => ({ ...t, total: null, bucketCounts: t.bucketCounts });
```

Rules that decide a mask's quality, in the order they bite:
1. **Mask the join, not only the field.** Masking `name` while leaving `email`, `memberId` or a URL that contains the id re-identifies the record in one step.
2. **Mask derived values too.** Totals, averages, chart series, sparkline arrays, CSV previews and `aria-label`s carry the same number you just removed.
3. **Cap volume.** A masked list of 10 000 rows is still a customer-base dump: cap rows and drop `nextCursor` for agents.
4. **Keep the contract.** Same keys, same types, add `masked: true` so the front end can show "hidden while an AI agent is in this session".
5. **Irreversible actions are never masked** — they are `step_up` or `block`. A half-executed transfer is worse than a refused one.
6. **Errors must not leak.** A `403` body, a validation message or a stack trace that echoes the value defeats the mask.
7. **Test the mask like a leak.** `JSON.stringify(masked)` must not contain the full value: `assert(!JSON.stringify(masked).includes(real.iban))`.

### Block and step-up design — the half the mask cookbook does not cover

Masking answers "what may this agent read". Blocking and step-up answer "what may this agent **do**", and they are where a bad integration leaks or annoys. Design them per resource, not per route:

```js
// 1) A blocked read must not be reconstructable from its neighbours.
//    If report.export is blocked but transactions.search returns every row with no cap, the block is theatre.
app.get('/api/transactions', oh.protect('transactions.search'), (req, res) =>
  oh.send(req, res, rows, (full) => full.slice(0, 20).map(maskRow)));   // cap + mask, or the export block is moot

// 2) A step-up is a gate in front of an action, not a banner after it.
//    Do the work only after the grant exists; never "optimistically" and then undo.
app.post('/api/transfer', oh.protect('transfer.create'), async (req, res) => {
  if (req.onehuman.decision === 'step_up') return;            // protect() already answered 428 with the challenge
  await transfer(req.body);                             // reached only with human evidence or a valid grant
  res.json({ ok: true });
});

// 3) Downloads: gate the issuer, bind the file to the session and the resource.
app.post('/api/statement', oh.protect('report.export'), (req, res) => res.json({ url: `/files/${req.onehuman.token()}` }));
app.get('/files/:token', async (req, res) => {
  const ok = await oh.engine.redeemToken(req.params.token, req.onehuman.session.id, 'report.export');
  if (!ok) return res.sendStatus(403);                  // single use, bound, expires — a copied link is dead
  streamStatement(res);
});

// 4) Fail closed on the thing that matters, open on the thing that does not.
//    If the engine errors, a balance may still render masked; a transfer must not execute.
```

Decide these five for every blocked or stepped-up resource, and write the answers into your report:
1. **Sibling leak** — which other endpoint returns the same data in another shape (dashboard aggregate, search, CSV, GraphQL field, mobile API, webhook replay)? Gate it the same way or the block is decorative.
2. **Idempotency** — if the client retries after a `428`, does the action run twice? Bind the retry to the same request id.
3. **Grant scope** — a step-up grant is per resource and short-lived (minutes). Never grant "the session is human now" globally from one confirmation.
4. **Recovery** — what does the person do when they meant to use an agent? The answer is the passkey reclaim, and the UI must say so; a dead end turns into a support ticket.
5. **Observability** — after the fact, can you show which decision fired, on which evidence, at which second? That is `oh.engine` audit; quote its shape in your report.

### Worked example — what a good exposure map looks like

The user gets a table like this, in their language, with their own route names, before any code changes:

| Route | Resource | What an agent gets | Class | Agent | Env. only | Unknown | Mask / gate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `GET /api/accounts/:id` | `balance.read` | Live balance + IBAN | money, read | mask | mask | allow | `amount: null`, IBAN first4+last4 |
| `GET /api/dashboard` | `balance.read` | **Same balance**, embedded | money, read | mask | mask | allow | same mask on the embedded field |
| `GET /api/tx?q=` | `transactions.search` | Whole history, searchable | money, bulk | mask | mask | allow | cap 20 rows, mask counterparty |
| `POST /api/statements` | `report.export` | CSV of everything | export | block | step_up | step_up | token-bound download |
| `POST /api/transfers` | `transfer.create` | Moves money | irreversible | block | step_up | step_up | no partial execution |
| `POST /api/profile` | `profile.update` | Changes address/phone | account takeover path | block | step_up | step_up | — |
| `GET /api/health` | — | Nothing | public | allow | allow | allow | left open, deliberately |

Two lines in that table are the ones a careless integration misses: `/api/dashboard`, because the balance hides inside an aggregate, and `/api/profile`, because changing the recovery phone is how an account is taken over later. Read for those before you propose anything.

### Step 5 — Verify, then report
```bash
npx onehumanai verify http://localhost:3000 /api/balance     # --base /prefix if you changed basePath
```
Four checks: SDK served · protected endpoint returns a decision (`X-OH-Decision`) · AI-app browser UA reaches the environment branch · a simulated attached agent (control markers posted to `/signals`) changes that session's decision (in `observe` it is recorded, not enforced). Run it for at least one masked, one blocked and one step-up resource. Then open the page in a normal browser and click the real button: data shows, `OneHuman.lastConnection.state` is `no_indication`, the app's own tests still pass.

Report to the user: the exposure map with the final handling per resource, the mask design as implemented, files changed, how to read the decision log and flip `observe` → `enforce`, that `ONEHUMAN_SECRET` must be set in production, and every route deliberately left open.

### Do not
Move the decision into the front end (the SDK is untrusted input) · protect login/logout/static/health routes · treat `actor: "unknown"` as human · return a constant from `identify()` · call `unseal()` without the server proof · send page text, key identities or form values anywhere (the SDK sends metadata only) · hardcode or commit the secret · skip the analysis and ask the user to "configure it themselves" · silently leave a sensitive route unprotected.

---

## What it detects (so you can explain it to the user)
- **Attach time, before the first click:** agent-tool DOM markers (Claude in Chrome / Codex overlays), tool-injected globals, evaluated-script DOM read bursts, focus emulation, Web Bot Auth signatures (verified operators).
- **Per click:** pointer kinematics — trajectory curvature, tremor, sub-movements, deceleration onto the target, hold time, pressure, teleport. Measured: humans hold 83–225 ms with ≥35 trajectory points; agents 1–4 ms with none. Measured on our own set: 397 human clicks from 22 browsers and devices, 2 read as a program; 824 agent clicks, 2 read as human. Not an independent study — method and limits: https://onehuman.ai/measurements
- **Session memory:** once an agent attached, the session stays "agent" until a WebAuthn user-verified passkey (Touch ID) reclaims it for 5 minutes.
- **Seal-on-attach:** `data-oh-sensitive="full"` elements are redacted in the browser the instant an indicator appears — even a read that is already in flight sees `••••`.

## API surface
`onehuman(options)` (or `onehumanDeferred(options)` without `await`, for CommonJS) → `{ middleware(), protect(resource, {respond?}), send(req,res,full,mask), sessionFor(req,res), reloadPolicy(), policy, policySource(), health(), engine, store, room, basePath, close() }`
`req.onehuman` → `{ decision, masked, blocked, stepUp, actor, score, reasonCodes, session, full, assessment, token() }`
SDK: `OneHuman.fetch`, `.snapshot(withInteraction)`, `.sessionHeaders()`, `.onAssessment(fn)`, `.seal()`, `.unseal(proof)`, `.sealed`, `.lastConnection`; event `onehuman:sealed`.
CLI: `npx onehumanai init [dir] [--yes]` · `npx onehumanai report [--days 30]` (the design-partner report from your own audit log) · `npx onehumanai inspect [--sessions]` (exactly what the page script collected; byte for byte with `recordRaw`) · `npx onehumanai scan [dir] [--json]` · `npx onehumanai verify <baseUrl> <protectedPath> [--base /onehuman]` · `npx onehumanai secret`.
Routes under `basePath`: `GET /sdk.js`, `POST /signals`, `GET /connection`, `GET /session`, `POST /step-up`, `POST /webauthn/register/options|register|assert/options|assert`, `GET /webauthn/status`.

Options: `secret` (required, ≥32 B) · `policy` (path or object; optional with an `apiKey`, see below) · `policyFromPortal` (`true` with an `apiKey`) · `portalUrl` · `db` (`sqlite:./file` | `memory` | `libsql://…`) · `identify(req)` · `basePath` (`/onehuman`) · `cookie` (`oh_sid`) · `secure` · `tenant` · `respond` (`true`) · `webauthnReclaim` (`true`) · `apiKey` (portal reporting, default `ONEHUMAN_API_KEY`) · `telemetryUrl` · `telemetryImmediate` (send each report at once; automatic on Vercel/Lambda/Netlify/Azure Functions) · `decisionTimeoutMs` (1000) · `failOpen` (`true`; enforce mode only) · `recordRaw` (`false`; keep byte-exact copies of what the page sends, for `inspect`).

## Portal: how many of your sessions had an AI agent in them

Create an account at https://onehuman.ai/portal, create an API key (one per project) and pass it as `apiKey` (or set `ONEHUMAN_API_KEY`). The middleware then reports every decision in the background — batched (sent at once on serverless platforms), never on the request path, dropped rather than blocking if the portal is unreachable. Each report is metadata only: a hashed session id, resource, decision, actor, connection state, detected tool, reason codes. No payloads, no identities, no IPs. Without a key nothing leaves your server.

The portal shows, per key: the share of sessions with an AI agent, decisions over time, which agents were seen, which resources they reached for, and a live log of recent decisions. Start in `observe` mode and you get the picture before anything is enforced.

### The policy lives in the portal

With an `apiKey`, the portal is where the policy is kept. The first time your server starts, it sends `onehuman.policy.json` to the portal and that becomes version 1 — nothing to approve. From then on the server reads the policy from the portal (every minute, and on requests on serverless), so a change made in the portal is live within a minute with no deploy.

- **The file still works.** When a developer or a coding agent edits `onehuman.policy.json`, the server sends the edit to the portal. By default it applies at once. In the portal's Policy page the owner can turn on *Ask me before a change from code takes effect*; then edits wait there for Approve / Reject.
- **Risky changes need a second step.** A change that lets agents see or do more — a rule removed, `block` → `allow`, `enforce` → `observe` — or that makes real people confirm or be refused waits for approval and the account password, unless the owner switched that check off (which itself needs the password).
- **An assistant for non-technical owners.** On the Rules page the owner writes what they want in plain words, in any language; a language model turns it into edits of the existing rules, shown for review before saving. It never adds or removes a rule: for a new part of the app it writes a prompt for the coding agent instead. It receives the rules and the message, never traffic.
- **Signed, and it keeps working offline.** The portal signs each version (Ed25519) for your key only; the server pins the portal's key the first time and refuses anything unsigned or altered. It keeps the last signed version in its own database and runs on it when the portal cannot be reached.
- **New endpoints are noticed.** Every `oh.protect('name')` is reported, and so is any resource seen in traffic; the portal lists the ones without a rule, with a suggested protection.
- **Every change is journalled:** who (you, your server, an agent's management key), when, and what changed.
- **Where did the policy come from?** Logged on every change (`onehuman: policy portal-v3 (enforce, 4 rules) from the portal`), returned by `oh.policySource()` and `GET <basePath>/health`, and — outside `NODE_ENV=production` — sent as the `X-OH-Policy-Source: portal | cache | file` response header.
- **Servers without internet:** `policyFromPortal: false` keeps the file as the only source; the portal can still download it.

### Agent signature updates

AI agent products change how they show themselves every few weeks. Installed engines learn the new traces without a package release: with an `apiKey` the server asks the portal for the newest **signature bundle** every six hours (and on requests, on serverless). A bundle is used only if OneHuman's signatures key signed it — a key kept offline, not on the portal — its sequence number is higher than the one in use, and the engine is new enough for it. It only **adds** to the built-in signatures; it can never remove one. The last accepted bundle is kept in your database, so a restart with the portal down keeps it; a saved copy that was altered is refused. `GET /onehuman/health` → `signatures: { seq, source: builtin | cache | portal, issued, lastCheckAt, problem }`. Without an API key the built-in signatures are used, updated with each package release.

### Decision proofs — the evidence an auditor can check

Every decision is signed on your server when it is made (Ed25519, key derived from `secret`). The proof states what was decided and why — resource, decision, actor, reason codes, policy and engine versions, whether data was delivered, and its place in the hash-chained audit log — with a digest of the session instead of the id. **Your end users see nothing**: no header, no body field, no extra request.

```js
app.get('/api/export', oh.protect('report.export'), (req, res) => {
  audit.save({ decision: req.onehuman.full.id, proof: req.onehuman.proof });   // optional: keep it in your own records too
  /* … */
});
const file = await oh.proofBundle(sessionId);   // every signed decision for one session + the verifying key
```

With an `apiKey`, proofs travel with the telemetry; the portal checks each signature on arrival (✓ in Activity) and **Export proofs** downloads a bundle. An auditor checks it offline, against the key your own site publishes:

```bash
npx onehumanai verify-proof proofs.json --keys https://your-app.example/onehuman/proof-keys
```

Proofs are standard compact JWS (EdDSA), so any JOSE library verifies them. Management API: `GET /api/v1/manage/proofs?key=<id>&range=30d`.

### Management API — for coding agents and CI

A **management key** (`oh_admin_…`, created in the portal under Settings) administers the account over HTTP, so an agent can set OneHuman up end to end without a human opening the portal:

```bash
export ONEHUMAN_ADMIN_KEY=oh_admin_…
BASE=https://onehuman.ai

curl -H "Authorization: Bearer $ONEHUMAN_ADMIN_KEY" $BASE/api/v1/manage/me            # whose account this is + endpoint list
curl -H "Authorization: Bearer $ONEHUMAN_ADMIN_KEY" $BASE/api/v1/manage/keys          # list project keys
curl -H "Authorization: Bearer $ONEHUMAN_ADMIN_KEY" -H 'Content-Type: application/json' \
     -d '{"name":"bank-web","env":"production","expiresInDays":90}' \
     $BASE/api/v1/manage/keys                                               # create one → the raw key, once
curl -X POST -H "Authorization: Bearer $ONEHUMAN_ADMIN_KEY" $BASE/api/v1/manage/keys/<id>/rotate   # new secret, same key
curl -X DELETE -H "Authorization: Bearer $ONEHUMAN_ADMIN_KEY" $BASE/api/v1/manage/keys/<id>
curl -H "Authorization: Bearer $ONEHUMAN_ADMIN_KEY" "$BASE/api/v1/manage/overview?range=7d"
curl -H "Authorization: Bearer $ONEHUMAN_ADMIN_KEY" "$BASE/api/v1/manage/stats?key=<id>&range=7d"
curl -H "Authorization: Bearer $ONEHUMAN_ADMIN_KEY" "$BASE/api/v1/manage/events?key=<id>&range=7d&limit=100"
curl -H "Authorization: Bearer $ONEHUMAN_ADMIN_KEY" "$BASE/api/v1/manage/proofs?key=<id>&range=30d"          # signed decisions + verifying keys
curl -H "Authorization: Bearer $ONEHUMAN_ADMIN_KEY" "$BASE/api/v1/manage/policy?key=<id>"                     # the key's policy, pending changes, endpoints without a rule
curl -H "Authorization: Bearer $ONEHUMAN_ADMIN_KEY" -H 'Content-Type: application/json' \
     -d '{"key":"<id>","policy":{…}}' $BASE/api/v1/manage/policy                                   # propose a change: applied, or held for approval
```

`POST /keys` answers with `{ id, name, env, expires, key }` — put `key` into the app's environment as `ONEHUMAN_API_KEY` and it starts reporting. `GET /manage/me` lists every endpoint, so an agent can discover the API from one call. A management key can create and revoke project keys: treat it like a password, and revoke it in the portal when the job is done.

## Licence

In `onehumanai` (this package) the browser SDK, the Express middleware, the CLI and the proof verifier are **Apache 2.0**. The engine they run on (`dist/engine.js`) is **Business Source License 1.1** with a production-use grant: you may run it in production, at any scale, to protect your own applications and the services you provide to your customers. The only use not granted is offering OneHuman itself to third parties as a competing hosted or embedded product. Each engine version converts to Apache 2.0 four years after release. Versions before 0.4.0 were MIT.

Live demo: https://onehuman.ai · Source and docs: https://github.com/OneHumanAI/onehuman (SDK and middleware Apache-2.0; engine BUSL-1.1 — production use granted) · https://onehuman.ai/docs · https://onehuman.ai/measurements.
