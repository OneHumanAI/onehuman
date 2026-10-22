# SPDX-License-Identifier: Apache-2.0
"""Django.

settings.py:
    MIDDLEWARE = [..., "onehumanai.django.OneHumanMiddleware"]
    ONEHUMAN = {"sidecar": "http://127.0.0.1:8788"}          # optional; also ONEHUMAN_SIDECAR_URL

views.py:
    from onehumanai.django import protect, send

    @protect("balance.read")
    def balance(request):
        return JsonResponse(send(request, full_balance, mask_balance))

The signed-in user (request.user.pk) is the session identity by default; ONEHUMAN = {"identify": "app.module.func"}
changes that. Block → 403, step-up → 428 with the same JSON body as the Node middleware; `request.onehuman` is the Decision.
"""
from __future__ import annotations

import functools
from typing import Any, Callable, Optional

from django.conf import settings
from django.http import HttpResponse, JsonResponse
from django.utils.module_loading import import_string

from . import Decision, OneHuman
from ._cookies import parse_set_cookie

_client: Optional[OneHuman] = None


def client() -> OneHuman:
    global _client
    if _client is None:
        conf = dict(getattr(settings, "ONEHUMAN", {}) or {})
        ident = conf.pop("identify", None)
        _client = OneHuman(**conf)
        _client.identify = import_string(ident) if isinstance(ident, str) else ident
    return _client


def _identity(request) -> Any:
    oh = client()
    if oh.identify:
        return oh.identify(request)
    user = getattr(request, "user", None)
    return user.pk if user is not None and getattr(user, "is_authenticated", False) else None


def _parts(request) -> dict:
    return {"method": request.method, "path": request.get_full_path(), "headers": list(request.headers.items()),
            "host": request.get_host(), "scheme": request.scheme, "client_ip": request.META.get("REMOTE_ADDR")}


def _cookies(resp, values):
    for v in values:
        c = parse_set_cookie(v)
        resp.set_cookie(c["key"], c["value"], path=c["path"], httponly=c["httponly"], secure=c["secure"], samesite=c["samesite"], max_age=c["max_age"])


def _finish(resp, d: Decision):
    for k, v in d.headers.items():
        resp[k] = v
    _cookies(resp, d.set_cookie)
    return resp


class OneHumanMiddleware:
    """Serves the page script's `/onehuman/*` requests through the sidecar."""

    def __init__(self, get_response: Callable):
        self.get_response = get_response

    def __call__(self, request):
        oh = client()
        if not oh.is_page_route(request.path):
            return self.get_response(request)
        status, headers, raw = oh.forward(body=request.body, identity=_identity(request), **_parts(request))
        resp = HttpResponse(raw, status=status)
        cookies = []
        for k, v in headers:
            if k.lower() == "set-cookie":
                cookies.append(v)
            else:
                resp[k] = v
        _cookies(resp, cookies)
        return resp


def protect(resource: str, *, respond: bool = True, want_token: bool = False):
    def wrap(view: Callable):
        @functools.wraps(view)
        def inner(request, *args: Any, **kwargs: Any):
            d = client().decide(resource, identity=_identity(request), want_token=want_token, **_parts(request))
            request.onehuman = d
            if respond and d.status != 200:
                return _finish(JsonResponse(d.body or {"error": "onehuman"}, status=d.status), d)
            return _finish(view(request, *args, **kwargs), d)
        return inner
    return wrap


def send(request, full: Any, mask: Optional[Callable[[Any], Any]] = None) -> Any:
    return OneHuman.send(getattr(request, "onehuman", None), full, mask)


def redeem(request, token: str, resource: str) -> bool:
    return client().redeem(token, resource, request.headers.get("Cookie", ""))
