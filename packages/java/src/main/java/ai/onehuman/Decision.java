// SPDX-License-Identifier: Apache-2.0
package ai.onehuman;

import java.util.List;
import java.util.Map;

/** What the engine decided for one protected request. {@code body} is the JSON to answer with for 403 / 428. */
public record Decision(String decision, String computed, boolean masked, boolean blocked, String actor, int status,
                       Map<String, Object> body, Map<String, String> headers, List<String> setCookie, String token, String failedOpen) {
    public boolean allowed() { return status == 200; }

    static Decision failed(String reason) {
        return new Decision("allow", "allow", false, false, "unknown", 200, null, Map.of("X-OH-Decision", "failed-open:" + reason), List.of(), null, reason);
    }
}
