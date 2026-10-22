// SPDX-License-Identifier: Apache-2.0
package ai.onehuman;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Function;
import java.util.logging.Logger;

/**
 * OneHuman for Java: the part inside your app. The decision engine runs next to it as a small local service
 * ({@code npx onehumanai sidecar}). This client forwards the page script's /onehuman/* requests to the sidecar and asks
 * it for a decision before every protected handler. If the sidecar is slow or down, handlers go on as allowed (fail open).
 * Framework adapters: {@link ai.onehuman.servlet.OneHumanFilter} (any Jakarta Servlet container) and
 * {@link ai.onehuman.spring.OneHumanInterceptor} (Spring MVC, {@code @OneHumanProtect}).
 */
public final class OneHuman {
    /** The browser request as the sidecar needs it. Headers are name/value pairs as received. */
    public record BrowserRequest(String method, String path, List<Map.Entry<String, String>> headers, String host, String scheme, String clientIp, String identity) {}

    /** The sidecar's answer to a forwarded page-script request. */
    public record Forwarded(int status, List<Map.Entry<String, String>> headers, byte[] body) {}

    // headers a browser must never set on the way to the sidecar: the app's own statements and the host
    private static final Set<String> CONTROL = Set.of("x-oh-identity", "x-oh-resource", "x-oh-method", "x-oh-url", "x-oh-want-token", "x-oh-sidecar-token", "x-forwarded-host", "x-forwarded-proto");
    // hop-by-hop headers, and the ones java.net.http sets itself
    private static final Set<String> HOP = Set.of("connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade", "host", "content-length", "expect", "http2-settings");
    private static final Logger LOG = Logger.getLogger("onehumanai");

    private final URI sidecar;
    private final String token;
    private final String basePath;
    private final Duration timeout;
    private final boolean failOpen;
    private final HttpClient http;
    private final AtomicInteger failures = new AtomicInteger();
    private final AtomicLong lastWarn = new AtomicLong();

    private OneHuman(Builder b) {
        this.sidecar = URI.create(b.sidecar.endsWith("/") ? b.sidecar.substring(0, b.sidecar.length() - 1) : b.sidecar);
        this.token = b.token;
        this.basePath = b.basePath.endsWith("/") ? b.basePath.substring(0, b.basePath.length() - 1) : b.basePath;
        this.timeout = b.timeout;
        this.failOpen = b.failOpen;
        this.http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).connectTimeout(b.timeout).followRedirects(HttpClient.Redirect.NEVER).build();
    }

    public static Builder builder() { return new Builder(); }

    public static final class Builder {
        private String sidecar = env("ONEHUMAN_SIDECAR_URL", "http://127.0.0.1:8788");
        private String token = env("ONEHUMAN_SIDECAR_TOKEN", "");
        private String basePath = "/onehuman";
        private Duration timeout = Duration.ofSeconds(1);
        private boolean failOpen = true;
        /** Where {@code npx onehumanai sidecar} listens. */
        public Builder sidecar(String url) { this.sidecar = url; return this; }
        /** Shared token when the sidecar runs on another host. */
        public Builder token(String t) { this.token = t == null ? "" : t; return this; }
        public Builder basePath(String p) { this.basePath = p; return this; }
        public Builder timeout(Duration d) { this.timeout = d; return this; }
        /** When the sidecar gives no answer: go on as allowed (default) or answer 503. */
        public Builder failOpen(boolean f) { this.failOpen = f; return this; }
        public OneHuman build() { return new OneHuman(this); }
        private static String env(String k, String d) { String v = System.getenv(k); return v == null || v.isBlank() ? d : v; }
    }

    public String basePath() { return basePath; }
    public int failures() { return failures.get(); }
    public boolean isPageRoute(String path) { return path != null && path.startsWith(basePath + "/"); }

    private HttpRequest.Builder request(String path, BrowserRequest br) {
        HttpRequest.Builder r = HttpRequest.newBuilder(sidecar.resolve(path)).timeout(timeout);
        String xff = null;
        for (Map.Entry<String, String> h : br.headers()) {
            String k = h.getKey().toLowerCase(Locale.ROOT);
            if (HOP.contains(k) || CONTROL.contains(k)) continue;
            if (k.equals("x-forwarded-for")) { xff = h.getValue(); continue; }
            try { r.header(h.getKey(), h.getValue()); } catch (IllegalArgumentException ignored) { /* a header java.net.http refuses to send */ }
        }
        r.header("X-Forwarded-Host", br.host());
        r.header("X-Forwarded-Proto", br.scheme());
        String ip = br.clientIp();
        if (ip != null || xff != null) r.header("X-Forwarded-For", xff == null ? ip : ip == null ? xff : xff + ", " + ip);
        if (br.identity() != null && !br.identity().isBlank()) r.header("X-OH-Identity", br.identity().length() > 200 ? br.identity().substring(0, 200) : br.identity());
        if (!token.isEmpty()) r.header("X-OH-Sidecar-Token", token);
        return r;
    }

    private void warn(String reason, Throwable e) {
        int n = failures.incrementAndGet();
        long now = System.currentTimeMillis(), last = lastWarn.get();
        if (now - last > 60_000 && lastWarn.compareAndSet(last, now)) LOG.warning("onehuman: " + reason + " (" + (e == null ? "" : e.getMessage()) + "); the request went on without a decision (" + n + " so far)");
    }

    private Decision failed(String reason) {
        if (failOpen) return Decision.failed(reason);
        return new Decision("block", "block", false, true, "unknown", 503, Map.of("error", "onehuman_unavailable"), Map.of(), List.of(), null, reason);
    }

    /** Ask the sidecar what to do with this browser request for {@code resource}. */
    @SuppressWarnings("unchecked")
    public Decision decide(String resource, BrowserRequest br, boolean wantToken) {
        HttpRequest.Builder r = request("/v1/decide", br).header("X-OH-Resource", resource).header("X-OH-Method", br.method().toUpperCase(Locale.ROOT)).header("X-OH-Url", br.path());
        if (wantToken) r.header("X-OH-Want-Token", "1");
        try {
            HttpResponse<String> res = http.send(r.POST(HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.ofString());
            if (res.statusCode() == 503 && !failOpen) return failed("ENGINE_ERROR");
            if (res.statusCode() != 200) { warn("ENGINE_ERROR", new RuntimeException("sidecar answered " + res.statusCode())); return failed("ENGINE_ERROR"); }
            Map<String, Object> d = (Map<String, Object>) Json.parse(res.body());
            Map<String, String> headers = new LinkedHashMap<>();
            if (d.get("headers") instanceof Map<?, ?> hm) hm.forEach((k, v) -> headers.put(String.valueOf(k), String.valueOf(v)));
            List<String> cookies = new ArrayList<>();
            if (d.get("setCookie") instanceof List<?> l) l.forEach((x) -> cookies.add(String.valueOf(x)));
            String kind = String.valueOf(d.get("decision"));
            return new Decision(kind, d.get("computed") == null ? kind : String.valueOf(d.get("computed")), Boolean.TRUE.equals(d.get("masked")), Boolean.TRUE.equals(d.get("blocked")),
                d.get("actor") == null ? "unknown" : String.valueOf(d.get("actor")), d.get("status") instanceof Number n ? n.intValue() : 200,
                d.get("body") instanceof Map<?, ?> body ? (Map<String, Object>) body : null, headers, cookies,
                d.get("token") == null ? null : String.valueOf(d.get("token")), d.get("failedOpen") == null ? null : String.valueOf(d.get("failedOpen")));
        } catch (HttpTimeoutException e) { warn("ENGINE_TIMEOUT", e); return failed("ENGINE_TIMEOUT"); }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); warn("ENGINE_ERROR", e); return failed("ENGINE_ERROR"); }
        catch (Exception e) { warn("ENGINE_ERROR", e); return failed("ENGINE_ERROR"); }
    }

    /** Relay one of the page script's /onehuman/* requests. */
    public Forwarded forward(BrowserRequest br, byte[] body) {
        HttpRequest.Builder r = request(br.path(), br);
        r.method(br.method().toUpperCase(Locale.ROOT), body == null || body.length == 0 ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofByteArray(body));
        try {
            HttpResponse<byte[]> res = http.send(r.build(), HttpResponse.BodyHandlers.ofByteArray());
            List<Map.Entry<String, String>> out = new ArrayList<>();
            res.headers().map().forEach((k, vs) -> { if (!HOP.contains(k.toLowerCase(Locale.ROOT)) && !k.startsWith(":")) vs.forEach((v) -> out.add(Map.entry(k, v))); });
            return new Forwarded(res.statusCode(), out, res.body());
        } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        catch (Exception e) { warn("ENGINE_ERROR", e); }
        return new Forwarded(503, List.of(Map.entry("Content-Type", "application/json")), "{\"error\":\"onehuman_unavailable\"}".getBytes());
    }

    /** Spend a download token once (the file handler calls this before sending the file). */
    public boolean redeem(String token, String resource, String cookieHeader) {
        HttpRequest.Builder r = HttpRequest.newBuilder(sidecar.resolve("/v1/redeem")).timeout(timeout).header("Content-Type", "application/json").header("Cookie", cookieHeader == null ? "" : cookieHeader);
        if (!this.token.isEmpty()) r.header("X-OH-Sidecar-Token", this.token);
        try { return http.send(r.POST(HttpRequest.BodyPublishers.ofString(Json.write(Map.of("token", token, "resource", resource)))).build(), HttpResponse.BodyHandlers.discarding()).statusCode() == 200; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return false; }
        catch (Exception e) { warn("ENGINE_ERROR", e); return false; }
    }

    /** Every value hidden, the shape and ids kept (the same as the Node middleware's mask: 'auto'). Works on Map / List / scalars. */
    /** Keys whose values say what a record is, not what it holds: ids, codes such as a currency, status and dates. */
    private static final java.util.Set<String> KEEP_KEYS = java.util.Set.of("id", "_id", "currency", "unit", "status", "state", "type", "kind", "date", "createdAt", "updatedAt", "created_at", "updated_at");

    public static Object autoMask(Object value) { return autoMask(value, ""); }

    private static Object autoMask(Object value, String key) {
        if (value instanceof Map<?, ?> m) { Map<String, Object> out = new LinkedHashMap<>(); m.forEach((k, v) -> out.put(String.valueOf(k), autoMask(v, String.valueOf(k)))); return out; }
        if (value instanceof Iterable<?> it) { List<Object> out = new ArrayList<>(); it.forEach((v) -> out.add(autoMask(v, ""))); return out; }
        if (KEEP_KEYS.contains(key) || value == null || value instanceof Boolean) return value;
        return value instanceof Number ? null : "••••";
    }

    /** {@code full}, or {@code mask.apply(full)} (default: autoMask) when the decision says mask. */
    public static Object send(Decision decision, Object full, Function<Object, Object> mask) {
        if (decision == null || !decision.masked()) return full;
        return mask != null ? mask.apply(full) : autoMask(full);
    }

    public static Object send(Decision decision, Object full) { return send(decision, full, null); }
}
