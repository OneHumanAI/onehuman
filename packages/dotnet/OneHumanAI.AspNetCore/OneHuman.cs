// SPDX-License-Identifier: Apache-2.0
// OneHuman for ASP.NET Core: the part inside your app. The decision engine runs next to it as a small local service
// (`npx onehumanai sidecar`). This package forwards the page script's /onehuman/* requests to the sidecar and asks it
// for a decision before every protected endpoint. If the sidecar is slow or down, endpoints go on as allowed (fail open).
using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace OneHumanAI;

public sealed class OneHumanOptions
{
    /// <summary>Where `npx onehumanai sidecar` listens.</summary>
    public string Sidecar { get; set; } = Environment.GetEnvironmentVariable("ONEHUMAN_SIDECAR_URL") ?? "http://127.0.0.1:8788";
    /// <summary>Shared token when the sidecar runs on another host.</summary>
    public string? Token { get; set; } = Environment.GetEnvironmentVariable("ONEHUMAN_SIDECAR_TOKEN");
    public string BasePath { get; set; } = "/onehuman";
    public TimeSpan Timeout { get; set; } = TimeSpan.FromSeconds(1);
    /// <summary>When the sidecar gives no answer: go on as allowed (default) or answer 503.</summary>
    public bool FailOpen { get; set; } = true;
    /// <summary>The signed-in user's id, or null. Never a constant: every visitor would share one session. Default: the NameIdentifier claim.</summary>
    public Func<HttpContext, string?>? Identify { get; set; }
}

/// <summary>What the engine decided for one protected request.</summary>
public sealed record Decision(
    string Kind, string Computed, bool Masked, bool Blocked, string Actor, int Status, JsonNode? Body,
    IReadOnlyDictionary<string, string> Headers, IReadOnlyList<string> SetCookie, string? Token, string? FailedOpen)
{
    public bool Allowed => Status == 200;
    internal static Decision Failed(string reason) => new("allow", "allow", false, false, "unknown", 200, null,
        new Dictionary<string, string> { ["X-OH-Decision"] = $"failed-open:{reason}" }, Array.Empty<string>(), null, reason);
}

public sealed class OneHumanClient
{
    // headers a browser must never set on the way to the sidecar: the app's own statements and the host
    static readonly HashSet<string> Control = new(StringComparer.OrdinalIgnoreCase) { "x-oh-identity", "x-oh-resource", "x-oh-method", "x-oh-url", "x-oh-want-token", "x-oh-sidecar-token", "x-forwarded-host", "x-forwarded-proto" };
    static readonly HashSet<string> Hop = new(StringComparer.OrdinalIgnoreCase) { "connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade", "host", "content-length", "expect" };

    readonly HttpClient _http;
    readonly ILogger _log;
    DateTime _lastWarn = DateTime.MinValue;
    public OneHumanOptions Options { get; }
    public int Failures { get; private set; }

    public OneHumanClient(OneHumanOptions options, ILogger<OneHumanClient>? log = null)
    {
        Options = options;
        _log = (ILogger?)log ?? Microsoft.Extensions.Logging.Abstractions.NullLogger.Instance;
        _http = new HttpClient(new SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(5), UseCookies = false, AllowAutoRedirect = false })
        { BaseAddress = new Uri(options.Sidecar), Timeout = options.Timeout };
    }

    string? IdentityOf(HttpContext ctx) => Options.Identify is { } f ? f(ctx)
        : ctx.User?.Identity?.IsAuthenticated == true ? ctx.User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value : null;

    HttpRequestMessage Build(HttpContext ctx, HttpMethod method, string path, HttpContent? content)
    {
        var msg = new HttpRequestMessage(method, path) { Content = content };
        string? xff = null;
        foreach (var (k, v) in ctx.Request.Headers)
        {
            if (Hop.Contains(k) || Control.Contains(k)) continue;
            if (k.Equals("x-forwarded-for", StringComparison.OrdinalIgnoreCase)) { xff = v.ToString(); continue; }
            if (!msg.Headers.TryAddWithoutValidation(k, (IEnumerable<string>)v) && content is not null) content.Headers.TryAddWithoutValidation(k, (IEnumerable<string>)v);
        }
        msg.Headers.TryAddWithoutValidation("X-Forwarded-Host", ctx.Request.Host.Value);
        msg.Headers.TryAddWithoutValidation("X-Forwarded-Proto", ctx.Request.Scheme);
        var ip = ctx.Connection.RemoteIpAddress?.ToString();
        if (ip is not null || xff is not null) msg.Headers.TryAddWithoutValidation("X-Forwarded-For", xff is null ? ip : ip is null ? xff : $"{xff}, {ip}");
        var identity = IdentityOf(ctx);
        if (!string.IsNullOrWhiteSpace(identity)) msg.Headers.TryAddWithoutValidation("X-OH-Identity", identity.Length > 200 ? identity[..200] : identity);
        if (!string.IsNullOrEmpty(Options.Token)) msg.Headers.TryAddWithoutValidation("X-OH-Sidecar-Token", Options.Token);
        return msg;
    }

    void Warn(string reason, Exception? e)
    {
        Failures++;
        if (DateTime.UtcNow - _lastWarn > TimeSpan.FromMinutes(1)) { _lastWarn = DateTime.UtcNow; _log.LogWarning("onehuman: {Reason} ({Error}); the request went on without a decision ({Count} so far)", reason, e?.Message, Failures); }
    }

    Decision FailedDecision(string reason) => Options.FailOpen ? Decision.Failed(reason)
        : new("block", "block", false, true, "unknown", 503, new JsonObject { ["error"] = "onehuman_unavailable" }, new Dictionary<string, string>(), Array.Empty<string>(), null, reason);

    /// <summary>Ask the sidecar what to do with this request for <paramref name="resource"/>.</summary>
    public async Task<Decision> DecideAsync(HttpContext ctx, string resource, bool wantToken = false)
    {
        var msg = Build(ctx, HttpMethod.Post, "/v1/decide", null);
        msg.Headers.TryAddWithoutValidation("X-OH-Resource", resource);
        msg.Headers.TryAddWithoutValidation("X-OH-Method", ctx.Request.Method);
        msg.Headers.TryAddWithoutValidation("X-OH-Url", ctx.Request.Path + ctx.Request.QueryString);
        if (wantToken) msg.Headers.TryAddWithoutValidation("X-OH-Want-Token", "1");
        try
        {
            using var r = await _http.SendAsync(msg, ctx.RequestAborted);
            if (r.StatusCode == HttpStatusCode.ServiceUnavailable && !Options.FailOpen) return FailedDecision("ENGINE_ERROR");
            if (r.StatusCode != HttpStatusCode.OK) { Warn("ENGINE_ERROR", new Exception($"sidecar answered {(int)r.StatusCode}")); return FailedDecision("ENGINE_ERROR"); }
            var d = JsonNode.Parse(await r.Content.ReadAsStringAsync(ctx.RequestAborted))!.AsObject();
            var headers = d["headers"]?.AsObject().ToDictionary(p => p.Key, p => p.Value?.GetValue<string>() ?? "") ?? new();
            var cookies = d["setCookie"]?.AsArray().Select(x => x!.GetValue<string>()).ToList() ?? new();
            return new Decision((string)d["decision"]!, (string?)d["computed"] ?? (string)d["decision"]!, (bool?)d["masked"] ?? false, (bool?)d["blocked"] ?? false,
                (string?)d["actor"] ?? "unknown", (int?)d["status"] ?? 200, d["body"]?.DeepClone(), headers, cookies, (string?)d["token"], (string?)d["failedOpen"]);
        }
        catch (TaskCanceledException e) when (!ctx.RequestAborted.IsCancellationRequested) { Warn("ENGINE_TIMEOUT", e); return FailedDecision("ENGINE_TIMEOUT"); }
        catch (Exception e) when (e is HttpRequestException or JsonException or InvalidOperationException or FormatException) { Warn("ENGINE_ERROR", e); return FailedDecision("ENGINE_ERROR"); }
    }

    /// <summary>Relay one of the page script's /onehuman/* requests to the sidecar and write its answer.</summary>
    public async Task ForwardAsync(HttpContext ctx)
    {
        byte[] body = Array.Empty<byte>();
        if (ctx.Request.ContentLength is > 64000) { ctx.Response.StatusCode = 413; return; }
        using (var ms = new MemoryStream()) { await ctx.Request.Body.CopyToAsync(ms, ctx.RequestAborted); body = ms.ToArray(); }
        var content = body.Length > 0 ? new ByteArrayContent(body) : null;
        var msg = Build(ctx, new HttpMethod(ctx.Request.Method), ctx.Request.Path + ctx.Request.QueryString, content);
        try
        {
            using var r = await _http.SendAsync(msg, ctx.RequestAborted);
            ctx.Response.StatusCode = (int)r.StatusCode;
            foreach (var (k, v) in r.Headers) if (!Hop.Contains(k)) ctx.Response.Headers.Append(k, v.ToArray());
            foreach (var (k, v) in r.Content.Headers) if (!Hop.Contains(k)) ctx.Response.Headers[k] = v.ToArray();
            await r.Content.CopyToAsync(ctx.Response.Body, ctx.RequestAborted);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
        {
            Warn("ENGINE_ERROR", e);
            ctx.Response.StatusCode = 503;
            await ctx.Response.WriteAsJsonAsync(new { error = "onehuman_unavailable" });
        }
    }

    /// <summary>Spend a download token once (the file endpoint calls this before sending the file).</summary>
    public async Task<bool> RedeemAsync(HttpContext ctx, string token, string resource)
    {
        var msg = new HttpRequestMessage(HttpMethod.Post, "/v1/redeem") { Content = JsonContent(new JsonObject { ["token"] = token, ["resource"] = resource }) };
        msg.Headers.TryAddWithoutValidation("Cookie", ctx.Request.Headers.Cookie.ToString());
        if (!string.IsNullOrEmpty(Options.Token)) msg.Headers.TryAddWithoutValidation("X-OH-Sidecar-Token", Options.Token);
        try { using var r = await _http.SendAsync(msg); return r.StatusCode == HttpStatusCode.OK; }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException) { Warn("ENGINE_ERROR", e); return false; }
    }

    static StringContent JsonContent(JsonNode n) => new(n.ToJsonString(), System.Text.Encoding.UTF8, "application/json");

    internal static void Apply(HttpContext ctx, Decision d)
    {
        foreach (var (k, v) in d.Headers) ctx.Response.Headers[k] = v;
        foreach (var c in d.SetCookie) ctx.Response.Headers.Append("Set-Cookie", c);
    }

    /// <summary>Every value hidden, the shape and ids kept (the same as the Node middleware's mask: 'auto').</summary>
    /// <summary>Keys whose values say what a record is, not what it holds: ids, codes such as a currency, status and dates.</summary>
    static readonly HashSet<string> KeepKeys = new() { "id", "_id", "currency", "unit", "status", "state", "type", "kind", "date", "createdAt", "updatedAt", "created_at", "updated_at" };

    public static JsonNode? AutoMask(JsonNode? value, string key = "") => value switch
    {
        JsonArray a => new JsonArray(a.Select(x => AutoMask(x)).ToArray()),
        JsonObject o => new JsonObject(o.Select(p => KeyValuePair.Create(p.Key, AutoMask(p.Value, p.Key)))),
        null => null,
        JsonValue v when KeepKeys.Contains(key) || v.GetValueKind() is JsonValueKind.True or JsonValueKind.False => v.DeepClone(),
        JsonValue v when v.GetValueKind() == JsonValueKind.Number => null,
        _ => JsonValue.Create("••••"),
    };

    /// <summary><paramref name="full"/>, or its masked form when the decision says mask (default: AutoMask).</summary>
    public static object? Send(Decision? decision, object? full, Func<object?, object?>? mask = null)
    {
        if (decision is not { Masked: true }) return full;
        return mask is not null ? mask(full) : AutoMask(JsonSerializer.SerializeToNode(full));
    }
}

public static class OneHumanExtensions
{
    public static IServiceCollection AddOneHuman(this IServiceCollection services, Action<OneHumanOptions>? configure = null)
    {
        var o = new OneHumanOptions();
        configure?.Invoke(o);
        services.AddSingleton(o);
        services.AddSingleton<OneHumanClient>();
        return services;
    }

    /// <summary>Serves the page script's /onehuman/* requests through the sidecar. Put it before routing.</summary>
    public static IApplicationBuilder UseOneHuman(this IApplicationBuilder app) => app.Use(async (ctx, next) =>
    {
        var oh = ctx.RequestServices.GetRequiredService<OneHumanClient>();
        if (ctx.Request.Path.StartsWithSegments(oh.Options.BasePath)) { await oh.ForwardAsync(ctx); return; }
        await next();
    });

    /// <summary>Minimal APIs: decide before the handler. Block → 403, step-up → 428 with the same body as the Node middleware.</summary>
    public static TBuilder Protect<TBuilder>(this TBuilder builder, string resource, bool respond = true, bool wantToken = false) where TBuilder : IEndpointConventionBuilder =>
        builder.AddEndpointFilter(async (fctx, next) =>
        {
            var ctx = fctx.HttpContext;
            var d = await ctx.RequestServices.GetRequiredService<OneHumanClient>().DecideAsync(ctx, resource, wantToken);
            ctx.Items["onehuman"] = d;
            OneHumanClient.Apply(ctx, d);
            if (respond && d.Status != 200) return Results.Json(d.Body ?? new JsonObject { ["error"] = "onehuman" }, statusCode: d.Status);
            return await next(fctx);
        });

    /// <summary>This request's decision, when the endpoint is protected.</summary>
    public static Decision? OneHumanDecision(this HttpContext ctx) => ctx.Items.TryGetValue("onehuman", out var d) ? d as Decision : null;
}

/// <summary>MVC controllers: <c>[OneHumanProtect("balance.read")]</c> on an action or a controller.</summary>
[AttributeUsage(AttributeTargets.Method | AttributeTargets.Class)]
public sealed class OneHumanProtectAttribute(string resource) : Attribute, IAsyncActionFilter
{
    public bool Respond { get; set; } = true;
    public bool WantToken { get; set; }
    public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
    {
        var ctx = context.HttpContext;
        var d = await ctx.RequestServices.GetRequiredService<OneHumanClient>().DecideAsync(ctx, resource, WantToken);
        ctx.Items["onehuman"] = d;
        OneHumanClient.Apply(ctx, d);
        if (Respond && d.Status != 200) { context.Result = new JsonResult(d.Body ?? new JsonObject { ["error"] = "onehuman" }) { StatusCode = d.Status }; return; }
        await next();
    }
}
