// SPDX-License-Identifier: Apache-2.0
package ai.onehuman;

import ai.onehuman.servlet.OneHumanFilter;
import ai.onehuman.spring.OneHumanInterceptor;
import ai.onehuman.spring.OneHumanProtect;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

/** End to end against a real sidecar (node scripts/with-sidecar.mjs -- mvn -f packages/java test). */
class AdapterTest {
    static final String SIDECAR = System.getenv("ONEHUMAN_SIDECAR_URL");
    static final String AGENT_ATTACHES = "{\"early\":{\"startedMs\":0,\"observedMs\":500,\"webdriver\":false,\"firstInteractionMs\":null,\"dataDomMs\":null,\"markers\":[{\"name\":\"claude-stop\",\"atMs\":900}],\"environment\":{\"codexModelContext\":false,\"modelContextApi\":false,\"clipboardBridge\":false,\"clipboardBridgeAtMs\":null,\"agentGlobals\":[],\"extensionsInstalled\":[],\"focusWhileHiddenMs\":null},\"focusConflict\":{\"count\":0,\"firstAtMs\":null,\"peers\":0},\"webmcpInvocations\":0},\"interaction\":null}";

    @RestController
    static class Api {
        @GetMapping("/api/balance") @OneHumanProtect("balance.read")
        public Map<String, Object> balance() { return Map.of("id", 7, "amount", 4939.1); }

        @GetMapping("/api/profile") @OneHumanProtect("profile.read")
        public Object profile(HttpServletRequest r) { return OneHuman.send(OneHumanFilter.decision(r), Map.of("id", 1, "name", "Ada Lindqvist")); }
    }

    static MockMvc app(String sidecar) {
        OneHuman oh = OneHuman.builder().sidecar(sidecar).build();
        return MockMvcBuilders.standaloneSetup(new Api()).addFilters(new OneHumanFilter(oh)).addInterceptors(new OneHumanInterceptor(oh)).build();
    }

    static Cookie session(MvcResult r) {
        String sc = r.getResponse().getHeaders("Set-Cookie").stream().filter((c) -> c.startsWith("oh_sid=")).findFirst().orElseThrow();
        return new Cookie("oh_sid", sc.substring(7, sc.indexOf(';')));
    }

    @Test
    void storyInSpringMvc() throws Exception {
        assertNotNull(SIDECAR, "run through scripts/with-sidecar.mjs");
        MockMvc mvc = app(SIDECAR);
        MvcResult sdk = mvc.perform(get("/onehuman/sdk.js")).andReturn();
        assertEquals(200, sdk.getResponse().getStatus());
        assertTrue(sdk.getResponse().getContentType().contains("javascript"));

        MvcResult first = mvc.perform(get("/api/balance")).andReturn();
        assertEquals(200, first.getResponse().getStatus());
        assertTrue(first.getResponse().getHeader("X-OH-Outcome").startsWith("allow"));
        Cookie sid = session(first);

        MvcResult sig = mvc.perform(post("/onehuman/signals").cookie(sid).header("Origin", "http://localhost").contentType("application/json").content(AGENT_ATTACHES)).andReturn();
        assertEquals(200, sig.getResponse().getStatus());

        MvcResult blocked = mvc.perform(get("/api/balance").cookie(sid)).andReturn();
        assertEquals(403, blocked.getResponse().getStatus());
        assertEquals("blocked", ((Map<?, ?>) Json.parse(blocked.getResponse().getContentAsString())).get("error"));

        MvcResult masked = mvc.perform(get("/api/profile").cookie(sid)).andReturn();
        assertEquals(Map.of("id", 1L, "name", "••••"), Json.parse(masked.getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8)));

        // a browser cannot choose its identity: the header is dropped before the sidecar
        MvcResult spoof = mvc.perform(get("/api/profile").cookie(sid).header("X-OH-Identity", "someone-else")).andReturn();
        assertEquals("••••", ((Map<?, ?>) Json.parse(spoof.getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8))).get("name"));
    }

    @Test
    void plainServletHelper() throws Exception {
        OneHuman oh = OneHuman.builder().sidecar(SIDECAR).build();
        MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/balance");
        MockHttpServletResponse res = new MockHttpServletResponse();
        Decision d = OneHumanFilter.protect(oh, req, res, "balance.read");
        assertTrue(d.allowed());
        assertSame(d, OneHumanFilter.decision(req));
        assertTrue(res.getHeaders("Set-Cookie").get(0).startsWith("oh_sid="));
    }

    @Test
    void sidecarDownFailsOpen() throws Exception {
        MvcResult r = app("http://127.0.0.1:9").perform(get("/api/balance")).andReturn();
        assertEquals(200, r.getResponse().getStatus());
        assertTrue(r.getResponse().getHeader("X-OH-Decision").startsWith("failed-open"));
        Decision strict = OneHuman.builder().sidecar("http://127.0.0.1:9").failOpen(false).build().decide("balance.read", new OneHuman.BrowserRequest("GET", "/", List.of(), "h", "http", null, null), false);
        assertEquals(503, strict.status());
    }

    @Test
    void autoMaskKeepsShapeAndIds() {
        assertEquals(Map.of("id", 7, "name", "••••", "rows", List.of(Map.of("_id", "x", "iban", "••••"))),
            OneHuman.autoMask(Map.of("id", 7, "name", "Ada", "rows", List.of(Map.of("_id", "x", "iban", "GB1")))));
        assertNull(((Map<?, ?>) OneHuman.autoMask(Map.of("amount", 12.5))).get("amount"));
    }

    @Test
    void jsonRoundTrip() {
        Object v = Json.parse("{\"a\":[1,2.5,true,null,\"x\\n\\u00e9\"],\"b\":{}}");
        assertEquals("{\"a\":[1,2.5,true,null,\"x\\né\"],\"b\":{}}", Json.write(v));
    }
}
