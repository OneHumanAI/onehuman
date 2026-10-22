# SPDX-License-Identifier: Apache-2.0
"""Flask.

    from onehumanai.flask import OneHumanFlask
    oh = OneHumanFlask(app, identify=lambda: session.get("user_id"))

    @app.get("/api/balance")
    @oh.protect("balance.read")
    def balance():
        return oh.send(full_balance, mask_balance)     # masked when an AI agent is acting and the rule says hide

Block → 403, step-up → 428, with the same JSON body as the Node middleware. `g.onehuman` holds the Decision.
"""
from __future__ import annotations

import functools
from typing import Any, Callable, Optional

from flask import Flask, g, jsonify, make_response, request

from . import Decision, OneHuman
from .wsgi import PageRoutes


def _parts() -> dict:
    qs = request.query_string.decode("latin-1")
    return {"method": request.method, "path": request.path + (f"?{qs}" if qs else ""), "headers": list(request.headers.items()),
            "host": request.host, "scheme": request.scheme, "client_ip": request.remote_addr}


def _finish(resp, d: Decision):
    for k, v in d.headers.items():
        resp.headers[k] = v
    for c in d.set_cookie:
        resp.headers.add("Set-Cookie", c)
    return resp


class OneHumanFlask:
    def __init__(self, app: Optional[Flask] = None, oh: Optional[OneHuman] = None, *, identify: Optional[Callable[[], Any]] = None, **client: Any):
        self.oh = oh or OneHuman(**client)
        self.identify = identify
        if app is not None:
            self.init_app(app)

    def init_app(self, app: Flask) -> None:
        # the page script's routes run before Flask routing; identity comes from the same function as protect()
        app.wsgi_app = PageRoutes(app.wsgi_app, self.oh)
        app.extensions["onehuman"] = self

    def decide(self, resource: str, want_token: bool = False) -> Decision:
        return self.oh.decide(resource, identity=self.identify() if self.identify else None, want_token=want_token, **_parts())

    def protect(self, resource: str, *, respond: bool = True, mask: Any = None, want_token: bool = False):
        """Decide before the view. `mask="auto"` or a function masks a dict/list the view returns when the decision says mask."""
        def wrap(view: Callable):
            @functools.wraps(view)
            def inner(*args: Any, **kwargs: Any):
                d = self.decide(resource, want_token)
                g.onehuman = d
                if respond and d.status != 200:
                    r = jsonify(d.body or {"error": "onehuman"})
                    r.status_code = d.status
                    return _finish(r, d)
                rv = view(*args, **kwargs)
                if mask is not None and d.masked and isinstance(rv, (dict, list)):
                    rv = self.oh.send(d, rv, None if mask == "auto" else mask)
                return _finish(make_response(rv), d)
            return inner
        return wrap

    def send(self, full: Any, mask: Optional[Callable[[Any], Any]] = None) -> Any:
        """`full`, or its masked form when this request's decision says mask."""
        return self.oh.send(getattr(g, "onehuman", None), full, mask)

    def redeem(self, token: str, resource: str) -> bool:
        return self.oh.redeem(token, resource, request.headers.get("Cookie", ""))
