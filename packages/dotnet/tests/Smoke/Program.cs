// SPDX-License-Identifier: Apache-2.0
// End to end against a real sidecar (scripts/with-sidecar.mjs): a small ASP.NET Core app with a minimal-API endpoint,
// a masked endpoint and an MVC controller, driven like a browser. Exit code 0 = every check passed.
using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Mvc;
using OneHumanAI;

var sidecar = Environment.GetEnvironmentVariable("ONEHUMAN_SIDECAR_URL") ?? throw new Exception("ONEHUMAN_SIDECAR_URL not set");
var failures = 0;
void Check(bool ok, string what) { Console.WriteLine($"{(ok ? "ok  " : "FAIL")} {what}"); if (!ok) failures++; }

WebApplication Build(string url)
{
    var b = WebApplication.CreateBuilder();
    b.Logging.ClearProviders();
    b.WebHost.UseUrls("http://127.0.0.1:0");
    b.Services.AddOneHuman(o => o.Sidecar = url);
    b.Services.AddControllers().AddApplicationPart(typeof(BalanceController).Assembly);
    var app = b.Build();
    app.UseOneHuman();
    app.MapGet("/api/balance", () => new { id = 7, amount = 4939.1 }).Protect("balance.read");
    app.MapGet("/api/profile", (HttpContext ctx) => OneHumanClient.Send(ctx.OneHumanDecision(), new { id = 1, name = "Ada Lindqvist" })).Protect("profile.read");
    app.MapControllers();
    return app;
}

var app = Build(sidecar);
await app.StartAsync();
var baseUrl = app.Urls.First();
var jar = new CookieContainer();
using var browser = new HttpClient(new HttpClientHandler { CookieContainer = jar }) { BaseAddress = new Uri(baseUrl) };
browser.DefaultRequestHeaders.UserAgent.ParseAdd("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36");

var sdk = await browser.GetAsync("/onehuman/sdk.js");
Check(sdk.StatusCode == HttpStatusCode.OK && (sdk.Content.Headers.ContentType?.MediaType ?? "").Contains("javascript"), "page script served through the sidecar");
var first = await browser.GetAsync("/api/balance");
Check(first.StatusCode == HttpStatusCode.OK, "first request allowed");
Check(jar.GetCookies(new Uri(baseUrl))["oh_sid"] is not null, "session cookie handed to the browser");
Check(first.Headers.TryGetValues("X-OH-Outcome", out var outcome) && outcome.First().StartsWith("allow"), "X-OH-Outcome on the response");

var early = """{"early":{"startedMs":0,"observedMs":500,"webdriver":false,"firstInteractionMs":null,"dataDomMs":null,"markers":[{"name":"claude-stop","atMs":900}],"environment":{"codexModelContext":false,"modelContextApi":false,"clipboardBridge":false,"clipboardBridgeAtMs":null,"agentGlobals":[],"extensionsInstalled":[],"focusWhileHiddenMs":null},"focusConflict":{"count":0,"firstAtMs":null,"peers":0},"webmcpInvocations":0},"interaction":null}""";
var sig = new HttpRequestMessage(HttpMethod.Post, "/onehuman/signals") { Content = new StringContent(early, Encoding.UTF8, "application/json") };
sig.Headers.Add("Origin", baseUrl.TrimEnd('/'));
Check((await browser.SendAsync(sig)).StatusCode == HttpStatusCode.OK, "agent attaches: the page script reports it");

var blocked = await browser.GetAsync("/api/balance");
Check(blocked.StatusCode == HttpStatusCode.Forbidden, "minimal API: balance blocked for the agent (403)");
Check((string?)JsonNode.Parse(await blocked.Content.ReadAsStringAsync())?["error"] == "blocked", "403 body is the Node middleware's");
var masked = JsonNode.Parse(await browser.GetStringAsync("/api/profile"));
Check((string?)masked?["name"] == "••••" && (int?)masked?["id"] == 1, "masked: private fields hidden, ids kept");
var mvc = await browser.GetAsync("/mvc/balance");
Check(mvc.StatusCode == HttpStatusCode.Forbidden, "MVC [OneHumanProtect]: blocked for the agent (403)");

var spoof = new HttpRequestMessage(HttpMethod.Get, "/api/profile");
spoof.Headers.Add("X-OH-Identity", "someone-else");
var viaSpoof = JsonNode.Parse(await (await browser.SendAsync(spoof)).Content.ReadAsStringAsync());
Check((string?)viaSpoof?["name"] == "••••", "an X-OH-Identity header from the browser does not change the session");

await app.StopAsync();
var down = Build("http://127.0.0.1:9");
await down.StartAsync();
using var c2 = new HttpClient { BaseAddress = new Uri(down.Urls.First()) };
var open = await c2.GetAsync("/api/balance");
Check(open.StatusCode == HttpStatusCode.OK && open.Headers.TryGetValues("X-OH-Decision", out var dh) && dh.First().StartsWith("failed-open"), "sidecar down: the endpoint still answers (fail open)");
await down.StopAsync();

Console.WriteLine(failures == 0 ? "all checks passed" : $"{failures} check(s) failed");
return failures == 0 ? 0 : 1;

[ApiController]
[Route("mvc")]
public sealed class BalanceController : ControllerBase
{
    [HttpGet("balance"), OneHumanProtect("balance.read")]
    public object Balance() => new { id = 7, amount = 4939.1 };
}
