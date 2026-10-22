# SPDX-License-Identifier: Apache-2.0
"""Set-Cookie strings from the sidecar, parsed for frameworks that only take cookies as arguments (Django)."""
from __future__ import annotations


def parse_set_cookie(value: str) -> dict:
    parts = [p.strip() for p in value.split(";") if p.strip()]
    name, _, val = parts[0].partition("=")
    out = {"key": name, "value": val, "path": "/", "httponly": False, "secure": False, "samesite": None, "max_age": None}
    for p in parts[1:]:
        k, _, v = p.partition("=")
        k = k.lower()
        if k == "path":
            out["path"] = v or "/"
        elif k == "httponly":
            out["httponly"] = True
        elif k == "secure":
            out["secure"] = True
        elif k == "samesite":
            out["samesite"] = v or None
        elif k == "max-age" and v.lstrip("-").isdigit():
            out["max_age"] = int(v)
    return out
