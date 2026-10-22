# OneHuman for Java

Access control for the AI agents your customers log in with. When a customer lets Claude in Chrome, ChatGPT agent, Codex or Comet use their signed-in account, each protected handler decides: allow it, hide the private fields, wait for the account owner's passkey, or keep it closed. Every decision is signed on your own server.

The engine runs next to your app as a small local service; this library is the part inside your app. Java 17+, no runtime dependencies (Jakarta Servlet and Spring MVC are provided by your app).

```bash
npx onehumanai init          # writes onehuman.policy.json and ONEHUMAN_SECRET (.env)
npx onehumanai sidecar       # the engine, on 127.0.0.1:8788
```

```xml
<dependency><groupId>ai.onehuman</groupId><artifactId>onehumanai</artifactId><version>0.1.0</version></dependency>
```

## Spring Boot

```java
@Bean OneHuman oneHuman() { return OneHuman.builder().build(); }                 // ONEHUMAN_SIDECAR_URL
@Bean FilterRegistrationBean<OneHumanFilter> oneHumanFilter(OneHuman oh) { return new FilterRegistrationBean<>(new OneHumanFilter(oh)); }
@Override public void addInterceptors(InterceptorRegistry r) { r.addInterceptor(new OneHumanInterceptor(oneHuman())); }

@GetMapping("/api/balance") @OneHumanProtect("balance.read")
public Object balance(HttpServletRequest req) { return OneHuman.send(OneHumanFilter.decision(req), balance); }
```

## Any servlet container

```java
// web.xml or ServletContext: register new OneHumanFilter(oh) for /*
Decision d = OneHumanFilter.protect(oh, req, res, "balance.read");
if (!d.allowed()) return;          // 403 / 428 already written, same JSON as the Node middleware
```

The signed-in principal's name is the session identity by default. If the sidecar is slow or down, handlers go on as allowed and the failure is logged.

Tests: `node scripts/with-sidecar.mjs -- mvn -f packages/java/pom.xml test` from the repository root.

Licence: Apache-2.0. https://onehuman.ai
