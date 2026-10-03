<p align="center">
<img src="https://onehuman.ai/logo-mark.svg" width="56" alt="">
</p>
<h1 align="center">OneHuman</h1>
<p align="center">
<b>Your customers send Claude, ChatGPT, Comet and Codex into your app. Decide what the agent can do.</b><br>
OneHuman spots the agent, hides private data, and asks the owner before exports or payments.<br>Every decision is signed on your own server.
</p>
<p align="center">
<a href="https://www.npmjs.com/package/onehumanai"><img alt="npm" src="https://img.shields.io/npm/v/onehumanai?color=3ddc84&label=npm"></a>
<a href="https://github.com/OneHumanAI/onehumanai/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/OneHumanAI/onehumanai/actions/workflows/ci.yml/badge.svg"></a>
<a href="LICENSE"><img alt="Apache-2.0 SDK, BUSL-1.1 engine" src="https://img.shields.io/badge/license-Apache--2.0%20SDK%20%C2%B7%20BUSL--1.1%20engine-blue"></a>
<a href="https://onehuman.ai"><img alt="live demo" src="https://img.shields.io/badge/live-demo-0f8a4b"></a>
</p>
<p align="center">
<a href="https://onehuman.ai"><b>Live demo</b></a> ·
<a href="https://onehuman.ai/docs">Docs</a> ·
<a href="https://onehuman.ai/compare">Compare</a> ·
<a href="QUICKSTART.md">60-second overview</a> ·
<a href="https://onehuman.ai/measurements">How we measured</a> ·
<a href="https://onehuman.ai/portal">Portal</a>
</p>

---

## Who is this for?

B2B SaaS teams whose customers now use AI agents inside their accounts. If your product holds customer lists, invoices, settings or exports, this is for you.

OneHuman is **not** workforce AI security. It does not govern the agents your own employees run. It governs the agents your **customers** bring into your product.

## Why this?

People now let AI agents work in their business tools for them: Claude in Chrome, ChatGPT agent, Codex, Comet. The agent works **inside the person's signed-in session**. Same cookies, same IP, same browser. To your server, the agent *is* the customer.

That breaks three things:

- **Data leaves.** Customer lists, emails, invoices and internal notes flow into a third-party model and its logs.
- **Actions happen by mistake.** A misread page or a prompt injection exports your data, deletes records, changes billing or settings.
- **Nobody can say who did it.** Afterwards there is no record of whether the person acted or the agent did.

Bot management stops bots at the door and MFA checks who logged in. Neither sees the agent a real customer invited into their own session. OneHuman works inside the session, at the endpoint that returns the data.

## What it does

- **Sees the agent arrive.** Agent tools leave traces in the page. OneHuman notices them 0.1 to 0.5 s after an agent attaches, before its first action.
- **Tells a hand from a program.** A person's pointer curves, trembles and slows onto the button. A driver jumps and clicks in 1 to 4 ms. On our own set: 397 human clicks from 22 browsers and devices, 2 read as a program ([method and limits](https://onehuman.ai/measurements)).
- **Your rule per endpoint.** `allow`, `mask`, `step_up` or `block`, in a JSON file or the portal, decided on your server.
- **Hides what is already on screen.** Values you mark are blurred in the browser the instant an agent appears.
- **Proof a person agreed.** When an action needs a human, they confirm with a passkey (Touch ID, Windows Hello). Every decision is signed, and an auditor can check it offline without trusting us.
- **Watch first, enforce later.** Start in watch only mode. See what agents do in your app, then turn on rules. If OneHuman ever fails, your app keeps working.

## How it is different

| | Protects | Works where |
| --- | --- | --- |
| Bot management (Cloudflare, DataDome, Akamai, HUMAN) | Your site from bots | At the door, before login |
| Identity and MFA (Stytch, Transmit, Vouched) | Who logs in | At login |
| Workforce AI security (Noma) | The agents your employees run | Inside your company |
| **OneHuman** | What your customers' agents may see and do | Inside the customer's session, on your own server |

Noma governs the agents your employees use. OneHuman governs the agents your customers bring. Full scored table with 10 companies: [onehuman.ai/compare](https://onehuman.ai/compare) (marked from public documentation as of September 2026).

## Quick start

```bash
npx onehumanai init
```

It reads your app, then asks three short questions: what to protect, whether to only watch first, and your portal key (optional). It shows every change before it writes anything. For Express it wires the code for you.

```bash
npm start
npx onehumanai verify http://localhost:3000 /api/customers # four checks, in seconds
```

Node 22.13 or newer. Express 4/5, Connect, a Next.js custom server or plain `node:http`. In a pnpm, yarn or bun project it uses your package manager. Prefer to wire it by hand? See the [docs](https://onehuman.ai/docs) or [QUICKSTART.md](QUICKSTART.md).

Want to see what agents already do in your product? Ask for the **[free 30 day agent report](https://onehuman.ai/report)** (watch only) or [book a demo](https://cal.com/onehumanai).

## Try it in one minute

1. Open the [live CRM demo](https://onehuman.ai/crm) yourself and click around. Everything works.
2. Open the same page with an AI agent (Claude in Chrome, ChatGPT agent, Comet) and ask it for the customer list or an export.
3. Watch the private fields get hidden and the export held for a passkey, while a person's own clicks still go through.

Found a way to fool it? [Open an issue](https://github.com/OneHumanAI/onehumanai/issues). Hard criticism is welcome.

## How it decides

```
signals from the page (untrusted) + what the server sees (trusted)
    → assess()    evidence tiers: verified · strong · control · behavioral · artifact
    → evaluate()  your rule: onAgent / onArtifact / onUnknown / onHumanLike
    → audit       hash-chained, signed decision log
    → response    allow | mask | 428 step-up | 403 block (+ passkey to take the session back)
```

"Unknown" is its own outcome and is never treated as human. If OneHuman is slow or fails, your app keeps working (it fails open, and says so in a header and in `/onehuman/health`).

## What it does not do

- **API keys and server calls.** No browser, no page: nothing to see. It protects signed-in web sessions.
- **Native mobile apps.** Mobile browsers are covered; iOS and Android apps are not.
- **Every custom script.** A program written to fake a person's clicks can pass the click check. That is why money-moving actions ask everyone for a passkey by default.
- **Go, Ruby and PHP backends.** Node runs the middleware directly; Python (`packages/python`), .NET (`packages/dotnet`) and Java (`packages/java`) use a local sidecar with the same engine (`npx onehumanai sidecar`). Go, Ruby and PHP are not covered yet.

## Roadmap

- [x] Attach-time detection, screen seal, rules per endpoint
- [x] Passkey confirmation and session reclaim
- [x] Signed decision proofs and an offline verifier
- [x] Portal: activity, rules in plain words, 30-day report
- [x] One-command setup (`npx onehumanai init`)
- [ ] Customers mark a decision right or wrong in the portal; the false-stop rate becomes a live number
- [ ] Hosted agent-signature updates for self-hosted engines
- [ ] Fastify and Next.js adapters
- [ ] Touch layer for mobile browsers
- [x] Sidecar and adapters for Python, .NET and Java backends

## Repository

| Path | What |
| --- | --- |
| `server/` | Engine: signals, assessment, kinematics model, policy, audit, WebAuthn, Web Bot Auth, storage (sqlite / libSQL) |
| `sdk/onehuman.js` | Browser SDK: attach-time probes, pointer trajectories, seal on attach |
| `integrations/express/` | The middleware in `onehumanai` |
| `integrations/cli/` | `npx onehumanai init · verify · scan · inspect · report` |
| `packages/onehumanai/` | The published npm package |
| `packages/python`, `packages/dotnet`, `packages/java` | Adapters for Python, .NET and Java backends (they talk to `npx onehumanai sidecar`) |
| `examples/express-bank/` | A small Express app protected end to end |
| `tests/` | engine, middleware, CLI and sidecar tests (`npm test`); Python adapters in `packages/python/tests` |

This repository is the engine and everything you install. The website, the hosted portal and the live demos at [onehuman.ai](https://onehuman.ai) are not part of it.

```bash
npm install
npm run check          # typecheck + tests
npm run example        # a protected Express app on http://localhost:3000
npm run build:package  # packages/onehumanai/dist
```

## Contributing

Issues and pull requests are welcome, see [`CONTRIBUTING.md`](CONTRIBUTING.md). Security reports: [`SECURITY.md`](SECURITY.md). If OneHuman is useful to you, a ⭐ helps other developers find it.

## License

OneHuman is licensed in two parts. © 2026 Arif Babayev.

| Part | Licence | What it means for you |
| --- | --- | --- |
| Browser SDK, Express middleware, CLI, sidecar, proof verifier, Python/.NET/Java adapters | [Apache 2.0](LICENSE-APACHE) | Use, change and ship it anywhere, including closed-source products. Patent grant included. |
| Engine (`server/`, and `dist/engine.js` in `onehumanai`), build scripts | [Business Source License 1.1](LICENSE-BSL) | **Production use is granted**, including protecting your own apps and the services you give your customers. Not granted: offering OneHuman itself to others as a competing hosted or embedded product. Each version becomes Apache 2.0 four years after release. |

Versions before 0.4.0 were published under MIT and stay available under it. Contributions need the one-line [CLA](CLA.md).
