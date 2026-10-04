# Changelog

## 0.7.4
- **`npx onehumanai init` puts `protect()` after the route's own login check** (`requireLogin`, `passport.authenticate(…)`, `auth.required`): a signed-out request is the app's 401, not a OneHuman decision.
- **Reads follow the documented matrix:** personal data, balances and transaction lists are shown to an agent with details hidden (mask), not refused; credentials are refused, health records refused for proven agents.
- **`mask: 'auto'` keeps what describes a record:** ids, `currency`, `unit`, `status`, `state`, `type`, `kind` and dates stay; amounts and names are still hidden. Same in the Python, .NET and Java adapters.
- **The login is found when the app sets it itself** (`req.user = { id }`, `req.auth = …`), and `init`'s own `onehuman.js` is no longer read as part of the app.
- **`init` says what else to do:** mark on-screen values `data-oh-sensitive="full"`, and use a test account's cookie for `verify --attach`; its mask example names one of your routes.
- **`verify` explains a 401** (the route needs a signed-in user: `--cookie`) even when OneHuman decided before the app's login check.
- **`npx onehumanai --help`** lists every command and option; an unknown command says so.
- **`init` says what the API key is for:** your dashboard and the free 30-day AI agent report.
- **An owner's "never" asks a possible person instead of refusing them:** when only the environment looked like an agent (a side panel, which devtools or a translation panel also opens), the owner's "never" now asks for their passkey (step-up) rather than blocking. A proven agent is still refused.

## 0.7.3
- **Fixed: an agent seen before the login was known was missed on the first protected request.** The page script reports from the first page, often before the app's login middleware has run; that evidence now moves to the login's session before its first decision.
- **Fixed: an agent could add a passkey of its own.** A passkey is added only while no agent is connected, and the click behind the request must not be a program's (or, inside an AI browser, must be there at all). A virtual authenticator can no longer approve its own actions.
- **Fixed: passkeys were shared by all users of a deployment.** They belong to the login that registered them; another user's passkey is neither offered nor accepted.
- **`<script src="/onehuman/sdk.js" data-fetch="auto" data-step-up="auto">`**: the click behind every same-origin `fetch()` and `XMLHttpRequest` travels with it, with no change to the page's code, and a 428 is answered with a passkey dialog, then the request is repeated once. Without it a person was "unknown" and met a passkey request the page could not show.
- **`npx onehumanai init`** mounts the middleware after the app's session or login middleware, puts the page script before the page's own scripts with both options on, and names `--cookie` in the verify step for apps behind a login.

(0.7.2 was never published: npm kept the version number from an upload that did not finish.)

## 0.7.1
- **What it is, in one line:** access control for the AI agents your customers log in with. Package description, README and keywords say so.
- **Owner's control.** `GET/POST /onehuman/access`: the account owner sees whether an AI agent is connected to their account, what it may do and what it did, and chooses per action. Stricter (`never`, or everything with `'*'`) applies at once; wider (`allow` for an hour, lifting a `never`) needs the owner's passkey (`purpose: 'permit'`), so an agent cannot widen its own access; a rule's `block` cannot be opened. Every change is signed in the audit chain (`OWNER_ALLOWED` / `OWNER_DENIED` / `OWNER_RESET`), and so is every decision it changes.
- **`OneHuman.presence()`** and the `onehuman:presence` event: what the page itself sees (an agent driving the tab, or a side panel beside it) for your own banner; `data-report="off"` runs the page script locally without sending anything.
- **Passkey dialogs name your site** (the relying party's host), not "OneHuman Lab".
- **The engine's page routes are only what the page script needs** (signals, connection, session, step-up). Demo-room limits and the lab's simulation flag are gone from the engine; a store opened by the middleware uses per-session limits by default.
- The example app is in English. Tests run from paths with spaces (Windows user folders).

## 0.7.0
- **Python, .NET and Java.** `npx onehumanai sidecar` runs the same engine as a small local service (127.0.0.1:8788) for backends that are not Node. Adapters: `onehumanai` for Python (Flask, Django, FastAPI), `OneHumanAI.AspNetCore` (minimal APIs, MVC) and `ai.onehuman:onehumanai` (Jakarta Servlet, Spring MVC). Each forwards the page script's `/onehuman/*` requests and asks `POST /v1/decide` before a protected handler; same 403/428 bodies, masking, download tokens and fail open as Express.
- **Audit chain holds under parallel traffic.** Appends to one chain are serialised in the process, and a unique (room, seq) index with a retry keeps it whole across instances. Before, three cards loading at once could all write seq 1 and break verification.
- **The chain hash covers the evidence.** v2 hashes canonical JSON (keys sorted at every level), so editing a nested reason, metric or engine version breaks the chain. v1 rows still verify.
- **The page learns less.** With `explain` off (the default) the page script gets only what it needs to seal: no actor, no environment verdict, no computed decision in production (`X-OH-Outcome` carries the decision only; development keeps the detail `npx onehumanai verify` reads).
- **Extension probes are opt-in** (`data-extension-probes="on"`): reading installed extensions is an ePrivacy question and never weighed in the decision.
- **SDK is lighter on busy pages**: DOM-change scans coalesced to one per frame, the globals listing at most once a second and only when globals changed, the reading shield's region lookup cached for 100 ms.
- **`X-OH-Sample` stays under 6000 characters** (nginx refuses one header over 8 KB by default): the trajectory keeps its newest points.
- Reason details, API errors and default policy titles are in English.
- **Proof key rotation.** `proofEpoch` / `ONEHUMAN_PROOF_EPOCH` signs with a new key derived from the same secret and keeps publishing the older ones; `retiredProofKeys` / `ONEHUMAN_RETIRED_PROOF_KEYS` keeps the public keys of a previous secret. `npx onehumanai proof-keys` prints them.
- **Independent timestamps for the audit chain.** `anchor: { tsa }` / `ONEHUMAN_TSA_URL` sends the chain head's hash (only the hash) to an RFC 3161 timestamp authority every hour and keeps its signed answer; `npx onehumanai anchors --out dir` writes files `openssl ts -verify` checks. Off by default. Checked against freetsa.org.

## 0.6.6
- **An AI agent cannot approve its own action.** When a rule asks for a step-up and an agent is acting, the 428 no longer carries the code (the agent reads the page, so it could type it back). It says `stepUp.approve: true`, and only the account owner's passkey approves it: `webauthn/assert/options { resource, purpose: 'approve' }`, then assert, then retry once. That approval opens that one action; the session stays the agent's. A typed code for it is refused with `passkey_required`.
- **Control, not block.** Recommended rules for agents now read: hide personal data, send money movement and exports to the owner for approval, keep only secrets (API keys, card numbers) closed. `block` still exists for those.
- **The 30-day report opens with the headline**: how many of your customers' sessions had an AI agent, which products, and what the rules did with what they asked for.

## 0.6.5
- **Fixed: a real iPhone user was treated as an AI agent** (found in the first public test). WebKit — every iPhone/iPad browser and Safari on the Mac — reports pressure 0 for real taps and trackpad clicks, reports a finger tap's click as a "mouse", and releases tap-to-click in about 1 ms. Two such taps were read as a program (`ZERO_PRESSURE_POINTER`) and the person's export and balance were refused. Now those readings count as unknown on WebKit, and the page script takes the pointer type from the press itself, so a tap is a tap.

## 0.6.4
- **The setup is always the newest one.** `npx onehumanai init` in a project that already has an older onehumanai installed ran that old copy (with its old questions). It now checks npm first and, when there is a newer version, runs that instead.
- **No technical questions left.** An unrecognised server no longer asks which framework it is: the rules and settings are written and the plan says which lines to add. The questions are only: is the proposed protection right, watch first or protect now, and the portal API key.

## 0.6.3
- **`npx onehumanai init` asks three plain questions**: is the proposed protection right (yes, or change it item by item), watch first or protect now, and your portal API key (Enter skips it). The server type, the signed-in user, the page script and `OneHuman.fetch` are worked out from the code and listed in the plan instead of asked. A list and its detail page are one item; the plan counts protected routes per file instead of printing code.
- **`npx onehumanai` on its own** starts the setup.
- Starting without setup now says what to do: no rules file or no secret → "Run `npx onehumanai init`".

## 0.6.2
- **`npx onehumanai init` keeps `onehumanai` in package.json.** It wrote its own package.json change after installing, which dropped the dependency npm had just added, so a fresh `npm ci` on a server would not install OneHuman. Files are written first now.
- **`npx onehumanai verify` works in observe mode.** Protected answers carry `X-OH-Outcome: <decision>; computed=<what protect mode would do>; actor=<who it looked like>` (never the reasons), and verify reads it, so a watch-only setup can be checked too.

## 0.6.1
Found by installing it into a new app as a customer would, then attacking it.

- **`init` finds routers with their own name** (`const payroll = Router()`) in their own file, and their mount prefix (`app.use('/api/hr', payroll)`). Before, the most sensitive routes of such an app were missed.
- **`init` writes a policy the engine accepts**: routes that share a resource (a list and its detail) become one rule. A bad policy now names the problem (`rule 2: resource "x" appears twice`), instead of "invalid".
- **`init` never proposes protecting login/logout**, suggests a login id rather than the user object (`req.session.user.email`), finds the port from `process.env.PORT ?? 3100`, points `verify` at a GET route, and offers to send the page's own `fetch()` calls through `OneHuman.fetch` (without it a person's click never counts, and in protect mode real people meet a passkey request).
- **Money that leaves, or where it goes** (payroll, payouts, transfers, bank details): `init` suggests "everyone confirms with a passkey". A program can fake a person's clicks; it cannot press their passkey.
- **If OneHuman cannot start** (a bad policy, an unreachable database) the app keeps working: requests go on without a decision (`X-OH-Decision: failed-open:ENGINE_START_FAILED`) and the reason is logged. `failOpen: false` answers 503 instead.
- **The page learns the outcome, not the reasons.** Blocked/confirm answers, `_onehuman` and the SDK's connection state no longer carry reason codes, scores or evidence (they would teach an agent what to hide). `explain: true` / `ONEHUMAN_EXPLAIN=1` shows them while developing; they are always in the audit log and the portal.
- **An agent from an earlier visit no longer marks the next one.** With `identify()` a session belongs to a login; after 30 minutes without requests a new visit starts clean.
- **A recorded click replayed from another session** is not counted as a person clicking.
- **`identify()` returning an object** (the user instead of its id) is ignored with a warning, instead of merging every user into one session.
- **`verify --cookie "session=…"`** checks an app behind a login; the attached-agent step runs only with `--attach` (it would mark that user as an agent for the visit).
- `npx onehumanai init` installs with the project's own package manager (pnpm, yarn, bun); npm cannot install into a `node_modules` that pnpm made.

## 0.6.0 — OneHuman
- **One package: `onehumanai`.** `npm i onehumanai` installs everything — the Express/Connect middleware, the browser SDK (`/onehuman/sdk.js`, or `import 'onehumanai/sdk'`), the command line (`npx onehumanai init`, `inspect`, `report`, `verify`, `verify-proof`) and the engine they run on (`dist/engine.js`, BUSL-1.1). `import { onehuman } from 'onehumanai'`. Markup `data-oh-*`, headers `X-OH-*`, cookie `oh_sid`, keys `oh_live_…` / `oh_admin_…`, `req.onehuman`, `_onehuman`, event `onehuman:sealed`; environment `ONEHUMAN_SECRET`, `ONEHUMAN_API_KEY`, `ONEHUMAN_TELEMETRY_URL`, `ONEHUMAN_PORTAL_URL`, `ONEHUMAN_DB`. Portal https://onehuman.ai; source https://github.com/OneHumanAI/onehuman.
- **`npx onehumanai init`** — answer a few questions (what to protect, how, where the login id is, watch or protect, portal or not); it shows every file it would write or change and applies them on yes. For Express it wires the code itself, ES modules and CommonJS, routes in any file. `--yes` takes the recommended answers.
- `onehumanDeferred(options)` — the same instance without `await`, for CommonJS and code that cannot wait at the top level.
- `protect(resource, { mask: 'auto' })` — when the decision is mask and the handler uses `res.json()`, every value is hidden and the shape and ids kept; or pass your own function.
- **OneHuman never breaks your app.** A protected request waits at most `decisionTimeoutMs` (1000 ms) for a decision; on a timeout or an engine error it goes on as allowed (`req.onehuman.failedOpen`, header `X-OH-Decision: failed-open:<reason>`, counted in `health().failOpen`). Observe mode always fails open; enforce mode can choose `failOpen: false` (503). OneHuman's own routes no longer hand errors to your error handler.
- **Fixed: a customer server stopped opening sessions after 400 visitors**, and kept only 2000 events for all visitors together (pruned on every insert). Now: no visitor cap, the newest 300 events per session, a week of history.
- **Observe mode is counted right.** Reports carry what the rules would have done (`computed`); the portal used to count observe-mode decisions as all "allow".
- **30-day report.** `npx onehumanai report` (from your own audit log, nothing sent anywhere), `oh.report()` / `oh.reportHtml()`, and the portal's "30-day report": sessions with an agent, which agents, which endpoints they touched, what the rules did or would have done, the effect on real people, the signed share. Printable to PDF.
- **`npx onehumanai inspect`** prints what the page script sent in a session, from your own database; byte for byte with `recordRaw: true` / `ONEHUMAN_RECORD_RAW=1`.
- **Agent signature updates** — signed, versioned, additive bundles fetched from the portal; see the README.
- Decisions now record the agent tools seen and the connection state.

## Unreleased (in 0.6.0)
- **The policy lives in the portal.** With an `apiKey`, the first start sends `onehuman.policy.json` to the portal as version 1 (no approval); the server then reads the policy from there every minute, so portal edits are live without a deploy. Later edits to the file are proposed to the portal: applied at once by default, or held for approval when the owner turns that on. Changes that weaken protection wait for approval and the account password unless the owner switches that check off. Every change is journalled (who, when, what).
- Changes that make real people confirm or be refused are treated like weakening ones: they wait for approval and the password.
- Portal: the Policy page is now **Rules**, written for non-technical owners, with an assistant that edits existing rules from a plain-language request (never adds or removes one; for a new rule it writes a prompt for the coding agent).
- The portal signs each version (Ed25519) for one API key; the server pins the portal key on first use, refuses unsigned or altered policies, and runs on its saved signed copy when the portal is unreachable.
- `oh.protect()` names and resources seen in traffic are listed in the portal when no rule covers them, with a suggested protection.
- `oh.policySource()`, `health().policy.source`, a log line on every change, and (outside production) the `X-OH-Policy-Source` response header say whether the running policy came from the portal, the saved copy or the file.
- New options: `policyFromPortal` (default `true` with an `apiKey`; `false` keeps the file as the only source), `portalUrl`. `policy` is optional when an `apiKey` is given.
- Management API: `GET /api/v1/manage/policy?key=`, `POST /api/v1/manage/policy {key, policy}`.

## 0.5.0 — 2026-09-24
- Package descriptions, landing, docs and portal wizard rewritten around one message: `npm i onehumanai` is the only install; the engine comes with it and is never imported. Startup now refuses a mismatched `@onehumanai/engine` version with the exact command to fix it.

## 0.4.0 — 2026-09-24 (identical content also published as 0.5.0)
- **Licence split.** `onehuman` (browser SDK, Express middleware, CLI, proof verifier) is now **Apache 2.0**. The engine moves to the **Business Source License 1.1** with a production-use grant: run it in production, at any scale, to protect your own applications and the services you provide to your customers; offering OneHuman itself as a competing hosted or embedded product is not granted. Each engine version converts to Apache 2.0 four years after release. Versions up to 0.3.x remain MIT.
- **Nothing changes in your code.** `npm i onehumanai` installs the engine as a dependency; `import { onehuman } from 'onehumanai'` and every option, method and endpoint are the same.
- The proof verifier (`npx onehumanai verify-proof`) is entirely Apache 2.0 and contains no engine code: an auditor needs nothing under the BSL to check a proof.
- **Grade decisions.** In the portal's Activity each decision has right/wrong marks; gated decisions marked wrong count as false stops, allows marked wrong as misses, both shown for the range. `POST /api/v1/manage/feedback` for agents.
- **`GET <basePath>/health`** and `oh.health()`: policy version, reporter state, proof key id, and integration warnings — 503 while one stands.
- **`identify()` guard.** When the same identity arrives from five different clients the middleware logs once, loudly, that it is a constant (every visitor would share one session) and flips health to 503.
- `/trust`: a one-page data-flow summary for security and legal reviewers.
- **Fixed: one visitor split into many sessions.** A page that calls several protected endpoints at load sent them all before the session cookie existed, and each opened its own session — the agent's traces landed in one, the data request in another, and the request looked like `NO_CLIENT_TELEMETRY`. The browser SDK now lets the first call establish the session and holds the others until it has (a later page in the same tab skips the wait).
- **Fixed: reports lost on serverless.** On Vercel, AWS Lambda, Netlify and Azure Functions each report is sent at once (and kept alive with Vercel's `waitUntil`) instead of waiting for a 3-second timer a frozen function never reaches. `telemetryImmediate: true` turns this on anywhere else.
- **Fixed: a retried batch counted twice.** Every report carries an id; the portal stores and counts each once.
- Portal: Activity opens on the key that is actually reporting; a revoked key's history stays viewable; the overview title follows the selected range.
- SDK: transport state is declared before any probe can report during page load.

## 0.3.0 — 2026-09-24
- **Decision proofs.** Every decision is signed server-side (Ed25519, compact JWS, key derived from `secret`) and stored with its audit row; the proof covers the decision, its reasons and its place in the hash chain, never the raw session id. `req.onehuman.proof`, `oh.proofBundle(sessionId)`, `oh.proofFor(id)`, `oh.verifyProof(jws)`, `oh.proofKeys()`; public key at `<basePath>/proof-keys`. Nothing changes for end users.
- Telemetry carries the proof; the portal verifies each one at ingest (and that it belongs to its event), marks it ✓ in Activity, and exports an auditor bundle. `npx onehumanai verify-proof <bundle> [--keys <url>]` checks one offline.
- Portal: key rotation, revoked-key history and deletion, password change, paged log with CSV export.
- A single click unlocks a session only with the learned model's agreement, not on rule points alone.

## 0.2.2 — 2026-09-23
- **Management API** for agents and CI: `oh_admin_…` keys administer an account over HTTP — list/create/revoke project keys, read overview and per-key stats; `GET /api/v1/manage/me` describes itself. Project keys gained an environment tag and an optional expiry.
- `apiKey` option (or `ONEHUMAN_API_KEY`): the middleware reports each decision to the OneHuman portal — batched, off the request path, metadata only — and the portal shows the share of sessions with an AI agent, decisions over time, agents seen, resources reached, and a live log.
- Isolated-world reading detection: a side panel taking viewport width plus main-thread work with no input is an attach indicator (`PANEL_PAGE_READ`); each alone is environment evidence.

## 0.2.1 — 2026-09-22
- **Judgement calls**: thirteen code patterns that should move the recommendation away from the default matrix (uncapped lists, aggregates embedding protected values, GraphQL field groups, recovery-data writes, non-idempotent money moves, file links, admin branches, regulated classes, SPA interceptors, SSR loaders, SDK-less clients, non-Node backends), each with the reason to give the user; plus the two habits — trace the number not the route, recommend then ask.
- **Block and step-up design** in README/AGENTS.md, the half the mask cookbook did not cover: sibling leaks (an uncapped search next to a blocked export makes the block decorative), retry idempotency after a 428, per-resource short-lived grants, the passkey way back, audit observability, and token-bound downloads — with code for each.
- **Worked exposure map**: the table the integrating agent should hand the owner before touching code, and the two rows careless integrations miss — an aggregate endpoint that embeds a protected value, and the profile write that is the account-takeover path.
- **Mask cookbook**: ready implementations per data class (money, IBAN/card, names, contact, addresses, documents, lists, aggregates) and the seven rules that decide a mask's quality: mask the join, mask derived values, cap volume, keep the response contract, never mask an irreversible action, don't leak through errors, assert the real value is absent from the serialized mask.
- Paste-ready prompt for the user's own coding agent at the top of the README; wider keyword set; `llms.txt` points at the new sections.

## 0.2.0 — 2026-09-22
- Learned per-click model (gradient-boosted trees, grouped CV AUC 0.999, zero human false positives) shipped in `dist/kinematics-model.json`; physics features against humanised bots (roughness, noise–speed coupling, kurtosis, autocorrelation); decisive rules for generated and noise-dressed curves.
- Kinematics v16 / assessment v7: keyboard activation neutral, approach retained across clicks and reloads, cyborg-session handling, dominance rule.
- README rewritten as a security-analysis protocol for AI coding agents: threat model, exposure map, default decision matrix, mask design, nine decisions, verification.
- `/api/v1/version` reports engine, kinematics and model versions.

## 0.1.3 — 2026-09-21
- `scan --proposal`: plain-language security proposal (what each route exposes, why it matters with an agent in the session, proposed handling) for the product owner; README opens with the agent protocol (install → scan → propose → ask → implement → verify).
- CLI: `npx onehumanai scan` (route discovery, sensitivity scoring, identity detection, draft policy), `npx onehumanai verify` (4 post-integration checks), `npx onehumanai secret`.
- `unseal()` now requires the server's reclaim proof (from `/webauthn/assert`); a plain call is ignored.
- A request from an AI app's built-in browser counts as environment evidence even when the session was opened from a normal browser.
- README rewritten as instructions for AI coding agents: decision questions to ask the user, exact code, policy schema, verification steps. Added AGENTS.md and llms.txt (same guidance) so Claude Code / Cursor / Codex find it.

## 0.1.1, 0.1.2 — 2026-09-21
- Same content as 0.1.0 (release-process runs).

## 0.1.0 — 2026-09-21
- First public build: Express/Connect middleware (`onehumanai`), browser SDK (`/onehuman/sdk.js`).
- Attach-time detection (control markers, tool globals, main-world read traps, focus-while-hidden), pointer kinematics (kin-v4), seal-on-attach for on-screen data, WebAuthn "I am human" reclaim, single-use download tokens, hash-chained audit.
- Storage: node:sqlite (built in) or libSQL/Turso (optional dependency).
