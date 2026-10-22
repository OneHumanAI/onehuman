# OneHumanAI.AspNetCore

Access control for the AI agents your customers log in with, for ASP.NET Core apps. When a customer lets Claude in Chrome, ChatGPT agent, Codex or Comet use their signed-in account, each protected endpoint decides: allow it, hide the private fields, wait for the account owner's passkey, or keep it closed. Every decision is signed on your own server.

The engine runs next to your app as a small local service; this package is the part inside your app (no dependencies beyond ASP.NET Core).

```bash
npx onehumanai init          # writes onehuman.policy.json and ONEHUMAN_SECRET (.env)
npx onehumanai sidecar       # the engine, on 127.0.0.1:8788
dotnet add package OneHumanAI.AspNetCore
```

```csharp
builder.Services.AddOneHuman();          // ONEHUMAN_SIDECAR_URL, or o => o.Sidecar = "http://127.0.0.1:8788"
var app = builder.Build();
app.UseOneHuman();                       // serves /onehuman/sdk.js and the page script's API

// minimal APIs
app.MapGet("/api/balance", (HttpContext ctx) => OneHumanClient.Send(ctx.OneHumanDecision(), balance)).Protect("balance.read");

// MVC
[HttpGet("balance"), OneHumanProtect("balance.read")]
public object Balance() => OneHumanClient.Send(HttpContext.OneHumanDecision(), balance);
```

The signed-in user (the NameIdentifier claim) is the session identity by default; set `o.Identify` to change it. A blocked request gets 403 and a step-up gets 428 with the same JSON the Node middleware sends. If the sidecar is slow or down, endpoints go on as allowed and the failure is logged.

Tests: `node scripts/with-sidecar.mjs -- dotnet run --project packages/dotnet/tests/Smoke` from the repository root.

Licence: Apache-2.0. https://onehuman.ai
