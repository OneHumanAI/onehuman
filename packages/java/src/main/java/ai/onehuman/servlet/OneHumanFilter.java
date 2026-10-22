// SPDX-License-Identifier: Apache-2.0
package ai.onehuman.servlet;

import ai.onehuman.Decision;
import ai.onehuman.Json;
import ai.onehuman.OneHuman;
import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

/**
 * Any Jakarta Servlet container (Tomcat, Jetty, Undertow; Spring Boot registers it as a bean): serves the page script's
 * /onehuman/* requests through the sidecar. Protect a handler with {@link #protect}, or in Spring MVC with
 * {@code @OneHumanProtect}.
 */
public final class OneHumanFilter implements Filter {
    /** Request attribute holding this request's {@link Decision}. */
    public static final String ATTRIBUTE = "onehuman";
    private static final int MAX_BODY = 64_000;

    private final OneHuman oh;
    private final Function<HttpServletRequest, String> identify;

    /** @param identify the signed-in user's id, or null (never a constant: every visitor would share one session) */
    public OneHumanFilter(OneHuman oh, Function<HttpServletRequest, String> identify) { this.oh = oh; this.identify = identify; }
    public OneHumanFilter(OneHuman oh) { this(oh, OneHumanFilter::principal); }

    static String principal(HttpServletRequest r) { return r.getUserPrincipal() == null ? null : r.getUserPrincipal().getName(); }

    public static OneHuman.BrowserRequest browserRequest(HttpServletRequest r, String identity) {
        List<Map.Entry<String, String>> headers = new ArrayList<>();
        for (String name : Collections.list(r.getHeaderNames())) for (String v : Collections.list(r.getHeaders(name))) headers.add(Map.entry(name, v));
        String qs = r.getQueryString();
        String host = r.getHeader("Host") != null ? r.getHeader("Host") : r.getServerName() + ":" + r.getServerPort();
        return new OneHuman.BrowserRequest(r.getMethod(), r.getRequestURI() + (qs == null || qs.isEmpty() ? "" : "?" + qs), headers, host, r.getScheme(), r.getRemoteAddr(), identity);
    }

    @Override
    public void doFilter(ServletRequest req, ServletResponse res, FilterChain chain) throws IOException, ServletException {
        HttpServletRequest r = (HttpServletRequest) req;
        HttpServletResponse w = (HttpServletResponse) res;
        String path = r.getRequestURI().substring(r.getContextPath().length());
        if (!oh.isPageRoute(path)) { chain.doFilter(req, res); return; }
        if (r.getContentLengthLong() > MAX_BODY) { w.setStatus(413); return; }
        byte[] body = r.getInputStream().readNBytes(MAX_BODY);
        OneHuman.Forwarded f = oh.forward(browserRequest(r, identify.apply(r)), body);
        w.setStatus(f.status());
        for (Map.Entry<String, String> h : f.headers()) w.addHeader(h.getKey(), h.getValue());
        w.getOutputStream().write(f.body());
    }

    /** Headers and cookies from a decision onto the response. */
    public static void apply(HttpServletResponse w, Decision d) {
        d.headers().forEach(w::setHeader);
        for (String c : d.setCookie()) w.addHeader("Set-Cookie", c);
    }

    /**
     * Decide for {@code resource}; the decision is also stored as the request attribute {@value #ATTRIBUTE}. When it is
     * a block (403) or a step-up (428) the JSON answer is written and the handler should return:
     * {@code if (!OneHumanFilter.protect(oh, req, res, "balance.read").allowed()) return;}
     */
    public static Decision protect(OneHuman oh, HttpServletRequest r, HttpServletResponse w, String resource, Function<HttpServletRequest, String> identify, boolean wantToken) throws IOException {
        Decision d = oh.decide(resource, browserRequest(r, identify == null ? principal(r) : identify.apply(r)), wantToken);
        r.setAttribute(ATTRIBUTE, d);
        apply(w, d);
        if (!d.allowed()) writeRefusal(w, d);
        return d;
    }

    public static Decision protect(OneHuman oh, HttpServletRequest r, HttpServletResponse w, String resource) throws IOException { return protect(oh, r, w, resource, null, false); }

    public static void writeRefusal(HttpServletResponse w, Decision d) throws IOException {
        w.setStatus(d.status());
        w.setContentType("application/json;charset=utf-8");
        w.getOutputStream().write(Json.write(d.body() == null ? Map.of("error", "onehuman") : d.body()).getBytes(StandardCharsets.UTF_8));
    }

    /** This request's decision, when the handler is protected. */
    public static Decision decision(HttpServletRequest r) { return r.getAttribute(ATTRIBUTE) instanceof Decision d ? d : null; }
}
