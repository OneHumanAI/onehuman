// SPDX-License-Identifier: Apache-2.0
package ai.onehuman.spring;

import ai.onehuman.Decision;
import ai.onehuman.OneHuman;
import ai.onehuman.servlet.OneHumanFilter;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.HandlerInterceptor;

import java.util.function.Function;

/**
 * Spring MVC: register with {@code registry.addInterceptor(new OneHumanInterceptor(oh))} and mark handlers with
 * {@link OneHumanProtect}. The decision is the request attribute {@code onehuman} ({@link OneHumanFilter#decision}).
 */
public final class OneHumanInterceptor implements HandlerInterceptor {
    private final OneHuman oh;
    private final Function<HttpServletRequest, String> identify;

    public OneHumanInterceptor(OneHuman oh, Function<HttpServletRequest, String> identify) { this.oh = oh; this.identify = identify; }
    public OneHumanInterceptor(OneHuman oh) { this(oh, null); }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) throws Exception {
        if (!(handler instanceof HandlerMethod hm)) return true;
        OneHumanProtect p = hm.getMethodAnnotation(OneHumanProtect.class);
        if (p == null) p = hm.getBeanType().getAnnotation(OneHumanProtect.class);
        if (p == null) return true;
        Decision d = oh.decide(p.value(), OneHumanFilter.browserRequest(request, identify != null ? identify.apply(request) : request.getUserPrincipal() == null ? null : request.getUserPrincipal().getName()), p.wantToken());
        request.setAttribute(OneHumanFilter.ATTRIBUTE, d);
        OneHumanFilter.apply(response, d);
        if (p.respond() && !d.allowed()) { OneHumanFilter.writeRefusal(response, d); return false; }
        return true;
    }
}
