# SPDX-License-Identifier: Apache-2.0
"""OneHuman for Python: access control for the AI agents your customers log in with.

The decision engine runs next to your app as a small local service (``npx onehumanai sidecar``). This package is
the part inside your app, with no dependencies: it forwards the page script's requests to the sidecar and asks it
for a decision before every protected view. Adapters for Flask, Django and FastAPI / Starlette are in
``onehumanai.flask``, ``onehumanai.django`` and ``onehumanai.asgi``.

If the sidecar is slow or down, protected views go on as allowed (fail open) and the failure is logged, so
OneHuman never breaks your app.
"""
from __future__ import annotations

import http.client
import json
import logging
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Mapping, Optional
from urllib.parse import urlsplit

__version__ = "0.1.0"
__all__ = ["OneHuman", "Decision", "auto_mask", "__version__"]

log = logging.getLogger("onehumanai")

# Headers the browser must never be able to set on the way to the sidecar: they carry the app's own statements
# (who is signed in, which resource, the shared token) or the host the cookies and passkeys are bound to.
CONTROL = {"x-oh-identity", "x-oh-resource", "x-oh-method", "x-oh-url", "x-oh-want-token", "x-oh-sidecar-token", "x-forwarded-host", "x-forwarded-proto"}
HOP = {"connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade", "host", "content-length", "expect"}


@dataclass
class Decision:
    """What the engine decided for one protected request."""

    decision: str = "allow"                  # allow | mask | step_up | block
    computed: str = "allow"                  # what protect mode would do (differs from `decision` in observe mode)
    masked: bool = False
    blocked: bool = False
    actor: str = "unknown"                   # human_like | agent_likely | unknown
    status: int = 200                        # 403 for block, 428 for step_up, else 200
    body: Optional[dict] = None              # the JSON body to answer with for 403 / 428
    headers: dict = field(default_factory=dict)       # X-OH-Decision, X-OH-Outcome, X-OH-Policy
    set_cookie: list = field(default_factory=list)    # Set-Cookie values to hand to the browser
    token: Optional[str] = None              # single-use download token, when asked for
    failed_open: Optional[str] = None        # ENGINE_TIMEOUT | ENGINE_ERROR when the sidecar gave no answer

    @property
    def allowed(self) -> bool:
        return self.status == 200

    @classmethod
    def failed(cls, reason: str) -> "Decision":
        return cls(failed_open=reason, headers={"X-OH-Decision": f"failed-open:{reason}"})


_KEEP = {"id", "_id", "currency", "unit", "status", "state", "type", "kind", "date", "createdAt", "updatedAt", "created_at", "updated_at"}


def auto_mask(value: Any, key: str = "") -> Any:
    """Every value hidden; the shape, ids, currency/status/type codes and dates kept, so the page still renders (the same as Express `mask: 'auto'`)."""
    if isinstance(value, list):
        return [auto_mask(v) for v in value]
    if isinstance(value, dict):
        return {k: auto_mask(v, k) for k, v in value.items()}
    if key in _KEEP or value is None or isinstance(value, bool):
        return value
    return None if isinstance(value, (int, float)) else "••••"


class OneHuman:
    """The connection to the sidecar. One instance per app; safe to share between threads.

    sidecar:  where `npx onehumanai sidecar` listens (default http://127.0.0.1:8788, or ONEHUMAN_SIDECAR_URL)
    token:    shared token when the sidecar runs on another host (ONEHUMAN_SIDECAR_TOKEN)
    identify: function(request) -> the signed-in user's id, or None. Never a constant: every visitor would share
              one session. Without it, a first-party cookie keeps each browser apart.
    """

    def __init__(self, sidecar: Optional[str] = None, *, token: Optional[str] = None, identify: Optional[Callable[[Any], Any]] = None,
                 base_path: str = "/onehuman", timeout: float = 1.0, fail_open: bool = True):
        u = urlsplit(sidecar or os.environ.get("ONEHUMAN_SIDECAR_URL") or "http://127.0.0.1:8788")
        self._host, self._port = u.hostname or "127.0.0.1", u.port or 8788
        self.token = token if token is not None else os.environ.get("ONEHUMAN_SIDECAR_TOKEN", "")
        self.identify = identify
        self.base_path = base_path.rstrip("/")
        self.timeout = timeout
        self.fail_open = fail_open
        self._local = threading.local()
        self._last_warn = 0.0
        self.failures = {"count": 0, "last_reason": None, "last_error": None, "last_at": None}

    # ------------------------------------------------------------------ transport
    def _conn(self) -> http.client.HTTPConnection:
        c = getattr(self._local, "conn", None)
        if c is None:
            c = http.client.HTTPConnection(self._host, self._port, timeout=self.timeout)
            self._local.conn = c
        return c

    def _call(self, method: str, path: str, headers: list, body: Optional[bytes] = None):
        """One request to the sidecar on a kept-alive connection; one retry when the old connection went stale."""
        for attempt in (0, 1):
            c = self._conn()
            try:
                c.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
                c.putheader("Host", f"{self._host}:{self._port}")
                for k, v in headers:
                    c.putheader(k, v)
                if self.token:
                    c.putheader("X-OH-Sidecar-Token", self.token)
                c.putheader("Content-Length", str(len(body or b"")))
                c.endheaders(body or None)
                r = c.getresponse()
                return r.status, r.getheaders(), r.read()
            except (ConnectionError, http.client.HTTPException, OSError):
                c.close()
                self._local.conn = None
                if attempt:
                    raise
        raise RuntimeError("unreachable")

    @staticmethod
    def _browser_headers(headers: Iterable[tuple], host: str, scheme: str, client_ip: Optional[str]) -> list:
        out, xff = [], None
        for k, v in headers:
            lk = k.lower()
            if lk in HOP or lk in CONTROL:
                continue
            if lk == "x-forwarded-for":
                xff = v
                continue
            out.append((k, v))
        out.append(("X-Forwarded-Host", host))
        out.append(("X-Forwarded-Proto", scheme))
        if client_ip:
            out.append(("X-Forwarded-For", f"{xff}, {client_ip}" if xff else client_ip))
        elif xff:
            out.append(("X-Forwarded-For", xff))
        return out

    def _warn(self, reason: str, err: Optional[BaseException]):
        self.failures.update(count=self.failures["count"] + 1, last_reason=reason, last_error=str(err) if err else None, last_at=time.time())
        if time.time() - self._last_warn > 60:
            self._last_warn = time.time()
            log.warning("onehuman: %s (%s); the request went on without a decision (%d so far)", reason, err, self.failures["count"])

    # ------------------------------------------------------------------ the two calls an adapter makes
    def decide(self, resource: str, *, method: str, path: str, headers: Iterable[tuple], host: str, scheme: str = "http",
               client_ip: Optional[str] = None, identity: Any = None, want_token: bool = False) -> Decision:
        """Ask the sidecar what to do with this browser request for `resource`."""
        h = self._browser_headers(headers, host, scheme, client_ip)
        h += [("X-OH-Resource", resource), ("X-OH-Method", method.upper()), ("X-OH-Url", path)]
        if identity is not None and not isinstance(identity, (dict, list, tuple, set)) and str(identity).strip():
            h.append(("X-OH-Identity", str(identity)[:200]))
        if want_token:
            h.append(("X-OH-Want-Token", "1"))
        try:
            status, _, raw = self._call("POST", "/v1/decide", h)
        except OSError as e:   # timeouts are OSError too
            reason = "ENGINE_TIMEOUT" if "timed out" in str(e).lower() else "ENGINE_ERROR"
            self._warn(reason, e)
            return self._failed(reason)
        except Exception as e:   # noqa: BLE001 — OneHuman must never break the app
            self._warn("ENGINE_ERROR", e)
            return self._failed("ENGINE_ERROR")
        if status == 503 and not self.fail_open:
            return Decision(status=503, body={"error": "onehuman_unavailable", "resource": resource}, decision="block", blocked=True)
        if status != 200:
            self._warn("ENGINE_ERROR", RuntimeError(f"sidecar answered {status}: {raw[:200]!r}"))
            return self._failed("ENGINE_ERROR")
        d = json.loads(raw)
        return Decision(decision=d["decision"], computed=d.get("computed", d["decision"]), masked=bool(d.get("masked")), blocked=bool(d.get("blocked")),
                        actor=d.get("actor", "unknown"), status=int(d.get("status", 200)), body=d.get("body"), headers=d.get("headers") or {},
                        set_cookie=d.get("setCookie") or [], token=d.get("token"), failed_open=d.get("failedOpen"))

    def _failed(self, reason: str) -> Decision:
        if self.fail_open:
            return Decision.failed(reason)
        return Decision(status=503, decision="block", blocked=True, body={"error": "onehuman_unavailable"}, failed_open=reason)

    def forward(self, *, method: str, path: str, headers: Iterable[tuple], body: bytes, host: str, scheme: str = "http",
                client_ip: Optional[str] = None, identity: Any = None):
        """Relay one of the page script's `/onehuman/*` requests. Returns (status, [(header, value)], body)."""
        h = self._browser_headers(headers, host, scheme, client_ip)
        if identity is not None and str(identity).strip():
            h.append(("X-OH-Identity", str(identity)[:200]))
        try:
            status, rh, raw = self._call(method.upper(), path, h, body)
        except Exception as e:   # noqa: BLE001
            self._warn("ENGINE_ERROR", e)
            return 503, [("Content-Type", "application/json")], b'{"error":"onehuman_unavailable"}'
        keep = [(k, v) for k, v in rh if k.lower() not in HOP]
        return status, keep, raw

    def redeem(self, token: str, resource: str, cookie_header: str) -> bool:
        """Spend a download token once (the file route calls this before sending the file)."""
        try:
            status, _, _ = self._call("POST", "/v1/redeem", [("Content-Type", "application/json"), ("Cookie", cookie_header or "")],
                                      json.dumps({"token": token, "resource": resource}).encode())
            return status == 200
        except Exception as e:   # noqa: BLE001
            self._warn("ENGINE_ERROR", e)
            return False

    def is_page_route(self, path: str) -> bool:
        return path.startswith(self.base_path + "/")

    @staticmethod
    def send(decision: Optional[Decision], full: Any, mask: Optional[Callable[[Any], Any]] = None) -> Any:
        """The data to answer with: `full`, or `mask(full)` (default: auto_mask) when the decision says mask."""
        if decision is not None and decision.masked:
            return (mask or auto_mask)(full)
        return full
