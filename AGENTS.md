# OneHuman

**Access control for the AI agents your customers log in with.** Your customers now log into your product with AI agents: Claude in Chrome, ChatGPT agent, Codex, Comet. OneHuman decides what those agents may see and do. It hides private data from them, asks the account owner (with a passkey) before anything risky, and signs every decision on your own server. It is for your customers' AI agents, not your team's AI or agents your company builds.

Customers now hand their logged-in bank, CRM and insurance sessions to Claude, ChatGPT Agent, Codex and other agentic browsers. Bot management stops bots at the door; it does nothing once a legitimate user is inside and an agent is operating their session. OneHuman works *inside* the session: it detects the moment an agent attaches, redacts what is already on screen, and lets each endpoint decide per resource — **allow · mask · step-up · block** — with a human-verified way back.

- **Proof, not a guess.** Every decision — allowed, hidden, refused, or confirmed by the person with a passkey — is signed on your server (Ed25519). An auditor checks it offline with `npx onehumanai verify-proof`, without trusting us.
- **Detects at attach time, before the first click.** Agent-tool DOM markers, injected globals, evaluated-script read bursts, focus emulation, Web Bot Auth signatures. Measured: Claude in Chrome 0.1–0.5 s after attach; Codex 0.14 s; in-app agent browsers at first read.
- **Tells hands from programs per click.** Pointer kinematics — trajectory curvature, tremor, sub-movements, deceleration onto the target, hold time, pressure, teleport. Humans hold 83–225 ms with ≥35 trajectory points; agents 1–4 ms with none. Measured on our own set: 397 human clicks from 22 browsers and devices, 2 read as a program; 824 agent clicks, 2 read as human. Not an independent study — method and limits: https://onehuman.ai/measurements
- **Never treats "unknown" as human.** Decisions need evidence in both directions; a person inside an AI browser is unlocked by their own first click, not by default.
- **Protects data already on screen.** Elements marked `data-oh-sensitive="full"` are redacted in the browser the instant an indicator appears — a read already in flight sees `••••`.
- **Session memory with a human exit.** Once an agent attached, the session stays "agent" until a WebAuthn user-verified passkey (Touch ID / Windows Hello) reclaims it for 5 minutes.
- **Yours to run.** Express middleware + browser SDK; policy is your JSON, masking is your function, storage is `node:sqlite` on your disk (or libSQL). Telemetry is metadata only and never has to leave your network. Start in `observe` mode: nothing is blocked, every decision is recorded with what *would* have happened.

```bash
npm i onehumanai            # Node ≥ 22.13 · Express 4/5, Connect, Next.js custom server, plain node:http
npx onehumanai init         # asks what to protect and how, shows every change, applies it on yes
```

`init` reads your project, lists the routes an AI agent could misuse with a customer's login, proposes how to protect each one (from "hide details" to "passkey for everyone"), and asks three things: is the proposal right, watch first or protect now, and your portal API key (Enter skips it). It finds the login id in your code itself. It then shows each file it would write or change and waits for your yes. For Express it wires the code itself (a small `onehuman.js`, `app.use(onehuman.middleware())`, `onehuman.protect()` on each route); for other servers it writes the rules and `.env` and prints the lines to add. `npx onehumanai init --yes` takes the recommended answers (CI, coding agents). `npx onehumanai scan .` only reports, and writes a draft policy.

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
The scanner finds every HTTP route an agent could call with the user's session (Express, Fastify, Koa, NestJS, Next.js), scores sensitivity (money, financial identifiers, personal data, health, HR, credentials, exports, state-changing writes), proposes a mode per route, locates the login identity on a request (`req.session.userId`, `req.user.id`, JWT, Auth.js, Clerk, Supabase, cookies), detects SPA vs SSR and axios, and writes a draft policy. **If it finds no routes, the server is not Node**: for Python (Flask, Django, FastAPI), .NET (ASP.NET Core) or Java (Spring MVC, Jakarta Servlet) run the engine as a sidecar (`npx onehumanai sidecar`) and use the adapter in `packages/python`, `packages/dotnet` or `packages/java`; for Go, Ruby or PHP say that no adapter exists yet and ask how to proceed.

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
- Development builds: the page script seals when a script with no URL in its stack (an evaluated script, the way agent tools read a page) reads a sensitive region. Dev bundles that run your own code through `eval` (webpack `devtool: 'eval…'`, some HMR setups) and userscripts look the same, so your own page may seal in development. Use a source-map setting without eval, or add `data-seal="off"` to the script tag in development only. Production builds are not affected.
- **403**: show "protected — an AI agent is operating this session"; if `body.stepUp?.reclaim`, offer "I'm human — verify with passkey": `POST /onehuman/webauthn/assert/options` → `navigator.credentials.get` → `POST /onehuman/webauthn/assert` → `OneHuman.unseal(response.reclaim)` → retry. `unseal()` accepts only that server proof; never wire it to a plain button. Registration: `/onehuman/webauthn/register/options` → `navigator.credentials.create` → `/onehuman/webauthn/register`.
- **428**: step-up dialog; demo answer → `POST /onehuman/step-up {id, answer}`; own OTP → verify your way, then server-side `oh.engine.store.grantStepUp(sessionId, resource, ttlMs)`, then retry.
- **428 with `stepUp.approve: true`** means an AI agent asked for this action. There is no code in the response (an agent would read it): only the account owner can approve, with a passkey. `POST /onehuman/webauthn/assert/options {resource, purpose: 'approve'}` → `navigator.credentials.get` → `POST /onehuman/webauthn/assert` → retry once. The approval covers that one action; the session stays the agent's. Typed codes are refused with `passkey_required`.
- CSP: `script-src 'self'`, `connect-src 'self'`. Installed-extension detection is off by default (it reads what is installed on the visitor's device and carries no weight in the decision); a site that wants it adds `data-extension-probes="on"` to the script tag and `chrome-extension:` to `img-src`/`connect-src`.

**Policy**: apply the answers to `onehuman.policy.draft.json`, rename to `onehuman.policy.json`. Branches: `onAgent` proven agent · `onArtifact` environment only · `onUnknown` not enough signal (never treated as human) · `onHumanLike` kinematic/behavioral human evidence or passkey. Keep `actOn`/`minScore` defaults. Unlisted resources stay unprotected — list that explicitly in your report.

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
`onehuman(options)` (or `onehumanDeferred(options)` without `await`, for CommonJS) → `{ middleware(), protect(resource, {respond?}), send(req,res,full,mask), sessionFor(req,res), reloadPolicy(), policy, engine, store, room, basePath, close() }`
`req.onehuman` → `{ decision, masked, blocked, stepUp, actor, score, reasonCodes, session, full, assessment, token() }`
SDK: `OneHuman.fetch`, `.snapshot(withInteraction)`, `.sessionHeaders()`, `.onAssessment(fn)`, `.seal()`, `.unseal(proof)`, `.sealed`, `.lastConnection`; event `onehuman:sealed`.
CLI: `npx onehumanai init [dir] [--yes]` · `npx onehumanai report [--days 30]` (the design-partner report from your own audit log) · `npx onehumanai inspect [--sessions]` (exactly what the page script collected; byte for byte with `recordRaw`) · `npx onehumanai scan [dir] [--json]` · `npx onehumanai verify <baseUrl> <protectedPath> [--base /onehuman]` · `npx onehumanai secret`.
Routes under `basePath`: `GET /sdk.js`, `POST /signals`, `GET /connection`, `GET /session`, `POST /step-up`, `POST /webauthn/register/options|register|assert/options|assert`, `GET /webauthn/status`.

Options: `secret` (required, ≥32 B) · `policy` (path or object, required) · `db` (`sqlite:./file` | `memory` | `libsql://…`) · `identify(req)` · `basePath` (`/onehuman`) · `cookie` (`oh_sid`) · `secure` · `tenant` · `respond` (`true`) · `webauthnReclaim` (`true`). · `proofEpoch` / `retiredProofKeys` (proof key rotation; `npx onehumanai proof-keys`) · `anchor: { tsa, everyMs }` (RFC 3161 timestamps of the audit chain, off by default; `npx onehumanai anchors`).

Live demo: https://onehuman.ai · Source and docs: https://github.com/OneHumanAI/onehuman (SDK and middleware Apache-2.0; engine BUSL-1.1 — production use granted) · https://onehuman.ai/docs · https://onehuman.ai/measurements.
