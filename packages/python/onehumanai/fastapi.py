# SPDX-License-Identifier: Apache-2.0
"""FastAPI (and Starlette for the page routes).

    from onehumanai.fastapi import OneHumanFastAPI
    oh = OneHumanFastAPI(app, identify=lambda request: request.session.get("user_id"))

    @app.get("/api/balance")
    def balance(d = Depends(oh.protect("balance.read"))):
        return oh.send(d, full_balance, mask_balance)

Block → 403, step-up → 428 with the same JSON body as the Node middleware. Sidecar calls run in a worker thread,
so the event loop is never blocked.
"""
from __future__ import annotations

import asyncio
from typing import Any, Callable, Optional

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

from . import Decision, OneHuman


class OneHumanRefused(Exception):
    def __init__(self, decision: Decision):
        self.decision = decision


def _parts(request: Request) -> dict:
    qs = request.url.query
    return {"method": request.method, "path": request.url.path + (f"?{qs}" if qs else ""), "headers": list(request.headers.items()),
            "host": request.headers.get("host", request.url.netloc), "scheme": request.url.scheme, "client_ip": request.client.host if request.client else None}


class PageRoutes:
    """ASGI middleware: `/onehuman/*` goes to the sidecar, everything else to the app."""

    def __init__(self, app, oh: OneHuman, identify: Optional[Callable[[Request], Any]] = None, max_body: int = 64000):
        self.app, self.oh, self.identify, self.max_body = app, oh, identify, max_body

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not self.oh.is_page_route(scope.get("path", "")):
            return await self.app(scope, receive, send)
        request = Request(scope, receive)
        body = await request.body()
        if len(body) > self.max_body:
            return await JSONResponse({"error": "too_large"}, status_code=413)(scope, receive, send)
        identity = self.identify(request) if self.identify else None
        status, headers, raw = await asyncio.to_thread(self.oh.forward, body=body, identity=identity, **_parts(request))
        resp = Response(raw, status_code=status)
        for k, v in headers:
            if k.lower() == "set-cookie":
                resp.headers.append("set-cookie", v)
            elif k.lower() not in ("content-length",):
                resp.headers[k] = v
        await resp(scope, receive, send)


class OneHumanFastAPI:
    def __init__(self, app: Optional[FastAPI] = None, oh: Optional[OneHuman] = None, *, identify: Optional[Callable[[Request], Any]] = None, **client: Any):
        self.oh = oh or OneHuman(**client)
        self.identify = identify
        if app is not None:
            self.init_app(app)

    def init_app(self, app: FastAPI) -> None:
        app.add_middleware(PageRoutes, oh=self.oh, identify=self.identify)

        @app.exception_handler(OneHumanRefused)
        async def _refused(_request: Request, exc: OneHumanRefused):
            d = exc.decision
            resp = JSONResponse(d.body or {"error": "onehuman"}, status_code=d.status)
            _apply(resp, d)
            return resp

    def protect(self, resource: str, *, respond: bool = True, want_token: bool = False):
        """A dependency: `d: Decision = Depends(oh.protect("balance.read"))`."""
        async def dependency(request: Request, response: Response) -> Decision:
            identity = self.identify(request) if self.identify else None
            d = await asyncio.to_thread(self.oh.decide, resource, identity=identity, want_token=want_token, **_parts(request))
            request.state.onehuman = d
            if respond and d.status != 200:
                raise OneHumanRefused(d)
            _apply(response, d)
            return d
        return dependency

    def send(self, decision: Optional[Decision], full: Any, mask: Optional[Callable[[Any], Any]] = None) -> Any:
        return self.oh.send(decision, full, mask)

    async def redeem(self, request: Request, token: str, resource: str) -> bool:
        return await asyncio.to_thread(self.oh.redeem, token, resource, request.headers.get("cookie", ""))


def _apply(resp: Response, d: Decision) -> None:
    for k, v in d.headers.items():
        resp.headers[k] = v
    for c in d.set_cookie:
        resp.headers.append("set-cookie", c)
