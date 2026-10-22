# SPDX-License-Identifier: Apache-2.0
"""Any WSGI app: serve the page script's `/onehuman/*` requests through the sidecar.

    from onehumanai import OneHuman
    from onehumanai.wsgi import PageRoutes
    app = PageRoutes(app, OneHuman())
"""
from __future__ import annotations

from typing import Any, Callable, Iterable, Optional

from . import OneHuman

_REASONS = {200: "OK", 201: "Created", 204: "No Content", 304: "Not Modified", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
            404: "Not Found", 405: "Method Not Allowed", 413: "Payload Too Large", 428: "Precondition Required", 429: "Too Many Requests", 503: "Service Unavailable"}


def request_parts(environ: dict) -> dict:
    """The browser request as the sidecar needs it, read from a WSGI environ."""
    headers = [(k[5:].replace("_", "-").title(), v) for k, v in environ.items() if k.startswith("HTTP_")]
    if environ.get("CONTENT_TYPE"):
        headers.append(("Content-Type", environ["CONTENT_TYPE"]))
    qs = environ.get("QUERY_STRING") or ""
    path = (environ.get("SCRIPT_NAME") or "") + (environ.get("PATH_INFO") or "/")
    host = environ.get("HTTP_HOST") or f"{environ.get('SERVER_NAME', 'localhost')}:{environ.get('SERVER_PORT', '80')}"
    return {"method": environ.get("REQUEST_METHOD", "GET"), "path": path + (f"?{qs}" if qs else ""), "headers": headers, "host": host,
            "scheme": environ.get("wsgi.url_scheme", "http"), "client_ip": environ.get("REMOTE_ADDR")}


class PageRoutes:
    """WSGI middleware: `/onehuman/*` goes to the sidecar, everything else to the app."""

    def __init__(self, app: Callable, oh: OneHuman, identify: Optional[Callable[[dict], Any]] = None, max_body: int = 64000):
        self.app, self.oh, self.identify, self.max_body = app, oh, identify, max_body

    def __call__(self, environ: dict, start_response: Callable) -> Iterable[bytes]:
        path = environ.get("PATH_INFO") or "/"
        if not self.oh.is_page_route(path):
            return self.app(environ, start_response)
        try:
            n = int(environ.get("CONTENT_LENGTH") or 0)
        except ValueError:
            n = 0
        if n > self.max_body:
            start_response("413 Payload Too Large", [("Content-Type", "application/json")])
            return [b'{"error":"too_large"}']
        body = environ["wsgi.input"].read(n) if n > 0 else b""
        parts = request_parts(environ)
        status, headers, raw = self.oh.forward(body=body, identity=self.identify(environ) if self.identify else None, **parts)
        start_response(f"{status} {_REASONS.get(status, 'OK')}", headers + [("Content-Length", str(len(raw)))] if not any(k.lower() == "content-length" for k, _ in headers) else headers)
        return [raw]
