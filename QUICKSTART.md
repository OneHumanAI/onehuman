# OneHuman in 60 seconds

**What it does.** When a customer lets an AI agent (Claude in Chrome, ChatGPT agent, Codex, …) act inside their signed-in session on your web app, OneHuman notices, applies your rule for that endpoint — **allow**, **hide the sensitive fields**, **ask the person for a passkey**, or **refuse** — and signs every decision on your server, so you can later prove who approved what.

**Where it runs.** A Node middleware and a small script your own server serves to your own pages. No proxy, no third-party script, no network call on the request path. **It fails open:** if it is slow or broken, requests go on as before and the failure is counted.

**What it collects.** In the browser: the timing and pointer path of clicks, and the traces agent tools leave in a page. **Never:** page content, what people type, form values, request or response bodies, names, e-mails, IP addresses. It is all kept in your own database. With an API key, decision metadata (resource, decision, who was acting, detected agent) goes to the OneHuman portal — nothing else. See for yourself: `npx onehumanai inspect` prints exactly what was collected.

**Install.**

```bash
npx onehumanai init                       # installs the package, asks what to protect, shows every change before writing it
npm start                               # starts in observe mode: nothing is blocked, everything is recorded
npx onehumanai verify http://localhost:3000 /api/balance
```

**Turn it on.** After a week in observe mode, look at what *would* have been stopped (`npx onehumanai report`, or the portal), then switch the rules to enforce.

**What it does not do.** API keys and server-to-server calls (no browser, nothing to see). Native mobile apps. Go, Ruby and PHP backends (Python, .NET and Java run through `npx onehumanai sidecar`). It does not identify people. A script written for one site can pass the behaviour check — that is why critical actions should ask for a passkey.

**More.** How the numbers were measured: https://onehuman.ai/measurements · What stays and what leaves: https://onehuman.ai/trust · Full docs: https://onehuman.ai/docs · Security: arif@onehuman.ai
