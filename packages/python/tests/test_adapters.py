# SPDX-License-Identifier: Apache-2.0
"""End to end: a real sidecar (`npx onehumanai sidecar` from this repository) and a small app per framework.

The browser's story in every framework: a first request is allowed and gets a session cookie; the page script
reports an AI agent attaching; the same endpoints now answer with the rules for agents (403 for a block, the
masked body for a mask). Plus: control headers from the browser never reach the sidecar, and a sidecar that is
down never breaks the app (fail open).

Run: ONEHUMAN_REPO=/path/to/repo python -m unittest discover -s tests
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from onehumanai import OneHuman, auto_mask  # noqa: E402

REPO = os.environ.get("ONEHUMAN_REPO") or os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
ACT = ["verified", "strong", "control", "behavioral"]
RULE = lambda r, a, art, u: {"resource": r, "title": r, "onAgent": a, "onArtifact": art, "onUnknown": u, "onHumanLike": "allow", "actOn": ACT, "minScore": 65}  # noqa: E731
POLICY = {"version": "py-test", "enforcement": "enforce", "rules": [RULE("balance.read", "block", "mask", "allow"), RULE("profile.read", "mask", "allow", "allow")]}
EARLY = {"startedMs": 0, "observedMs": 500, "webdriver": False, "firstInteractionMs": None, "dataDomMs": None,
         "markers": [{"name": "claude-stop", "atMs": 900}],
         "environment": {"codexModelContext": False, "modelContextApi": False, "clipboardBridge": False, "clipboardBridgeAtMs": None, "agentGlobals": [], "extensionsInstalled": [], "focusWhileHiddenMs": None},
         "focusConflict": {"count": 0, "firstAtMs": None, "peers": 0}, "webmcpInvocations": 0}
AGENT_ATTACHES = {"early": EARLY, "interaction": None}
URL = None
_proc = None
_dir = None


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def setUpModule():
    global URL, _proc, _dir
    _dir = tempfile.mkdtemp(prefix="oh-py-")
    with open(os.path.join(_dir, "onehuman.policy.json"), "w") as f:
        json.dump(POLICY, f)
    with open(os.path.join(_dir, ".env"), "w") as f:
        f.write("ONEHUMAN_SECRET=" + "s" * 48 + "\n")
    port = _free_port()
    _proc = subprocess.Popen(["node", os.path.join(REPO, "integrations", "cli", "index.ts"), "sidecar", "--dir", _dir, "--port", str(port)],
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env={**os.environ, "ONEHUMAN_NO_UPDATE_CHECK": "1"})
    URL = f"http://127.0.0.1:{port}"
    for _ in range(100):
        try:
            urllib.request.urlopen(URL + "/v1/health", timeout=0.5)
            return
        except Exception:  # noqa: BLE001
            if _proc.poll() is not None:
                raise RuntimeError("sidecar exited: " + _proc.stdout.read().decode())
            time.sleep(0.1)
    raise RuntimeError("sidecar did not start")


def tearDownModule():
    if _proc:
        _proc.terminate()
        _proc.wait(5)
    if _dir:
        shutil.rmtree(_dir, ignore_errors=True)


class Core(unittest.TestCase):
    def test_control_headers_from_the_browser_are_dropped(self):
        h = OneHuman._browser_headers([("X-OH-Identity", "victim"), ("X-Forwarded-Host", "evil.example"), ("X-OH-Sample", "{}"), ("Cookie", "a=b"), ("Connection", "close")], "shop.example", "https", "203.0.113.9")
        names = [k.lower() for k, _ in h]
        self.assertNotIn("x-oh-identity", names)
        self.assertNotIn("connection", names)
        self.assertIn(("X-Forwarded-Host", "shop.example"), h)
        self.assertIn(("X-OH-Sample", "{}"), h)
        self.assertIn(("X-Forwarded-For", "203.0.113.9"), h)

    def test_a_sidecar_that_is_down_fails_open(self):
        oh = OneHuman("http://127.0.0.1:9", timeout=0.3)
        d = oh.decide("balance.read", method="GET", path="/api/balance", headers=[], host="shop.example")
        self.assertEqual(d.status, 200)
        self.assertEqual(d.failed_open, "ENGINE_ERROR")
        self.assertEqual(oh.failures["count"], 1)
        strict = OneHuman("http://127.0.0.1:9", timeout=0.3, fail_open=False)
        self.assertEqual(strict.decide("balance.read", method="GET", path="/", headers=[], host="h").status, 503)

    def test_auto_mask_keeps_codes_status_and_dates(self):
        self.assertEqual(auto_mask({"balance": 4939.1, "currency": "USD", "status": "active", "date": "2026-09-28", "iban": "GB1"}),
                         {"balance": None, "currency": "USD", "status": "active", "date": "2026-09-28", "iban": "••••"})

    def test_auto_mask_keeps_shape_and_ids(self):
        self.assertEqual(auto_mask({"id": 7, "name": "Ada", "amount": 12.5, "ok": True, "rows": [{"_id": "x", "iban": "GB1"}]}),
                         {"id": 7, "name": "••••", "amount": None, "ok": True, "rows": [{"_id": "x", "iban": "••••"}]})


def _need(mod):
    try:
        __import__(mod)
        return False
    except ImportError:
        return True


@unittest.skipIf(_need("flask"), "flask not installed")
class FlaskApp(unittest.TestCase):
    def test_story(self):
        from flask import Flask
        from onehumanai.flask import OneHumanFlask
        app = Flask(__name__)
        oh = OneHumanFlask(app, OneHuman(URL))

        @app.get("/api/balance")
        @oh.protect("balance.read")
        def balance():
            return {"id": 7, "amount": 4939.1}

        @app.get("/api/profile")
        @oh.protect("profile.read", mask="auto")
        def profile():
            return {"id": 1, "name": "Ada Lindqvist"}

        c = app.test_client()
        self.assertEqual(c.get("/onehuman/sdk.js").status_code, 200)
        r = c.get("/api/balance")
        self.assertEqual(r.status_code, 200)
        self.assertIn("oh_sid=", r.headers.get("Set-Cookie", ""))
        self.assertTrue(r.headers["X-OH-Outcome"].startswith("allow;"))
        self.assertEqual(c.post("/onehuman/signals", json=AGENT_ATTACHES, headers={"Origin": "http://localhost"}).status_code, 200)
        r = c.get("/api/balance")
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.get_json()["error"], "blocked")
        r = c.get("/api/profile")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json(), {"id": 1, "name": "••••"})


@unittest.skipIf(_need("django"), "django not installed")
class DjangoApp(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import django
        from django.conf import settings
        if not settings.configured:
            settings.configure(DEBUG=True, SECRET_KEY="t" * 50, ROOT_URLCONF=__name__, ALLOWED_HOSTS=["*"], MIDDLEWARE=["onehumanai.django.OneHumanMiddleware"], ONEHUMAN={"sidecar": URL})
            django.setup()
        from django.http import JsonResponse
        from django.urls import path
        from onehumanai.django import protect, send

        @protect("balance.read")
        def balance(request):
            return JsonResponse({"id": 7, "amount": 4939.1})

        @protect("profile.read")
        def profile(request):
            return JsonResponse(send(request, {"id": 1, "name": "Ada Lindqvist"}))

        global urlpatterns
        urlpatterns = [path("api/balance", balance), path("api/profile", profile)]

    def test_story(self):
        from django.test import Client
        # the sidecar runs without a license, which serves local hosts only: the test client's default "testserver" is not one
        c = Client(HTTP_HOST="localhost")
        self.assertEqual(c.get("/onehuman/sdk.js").status_code, 200)
        r = c.get("/api/balance")
        self.assertEqual(r.status_code, 200)
        self.assertIn("oh_sid", r.cookies)
        self.assertTrue(r.cookies["oh_sid"]["httponly"])
        self.assertEqual(c.post("/onehuman/signals", data=json.dumps(AGENT_ATTACHES), content_type="application/json", HTTP_ORIGIN="http://localhost").status_code, 200)
        r = c.get("/api/balance")
        self.assertEqual(r.status_code, 403)
        self.assertEqual(json.loads(r.content)["error"], "blocked")
        self.assertEqual(json.loads(c.get("/api/profile").content), {"id": 1, "name": "••••"})


urlpatterns = []


@unittest.skipIf(_need("fastapi") or _need("httpx"), "fastapi / httpx not installed")
class FastAPIApp(unittest.TestCase):
    def test_story(self):
        from fastapi import Depends, FastAPI
        from fastapi.testclient import TestClient
        from onehumanai.fastapi import OneHumanFastAPI
        app = FastAPI()
        oh = OneHumanFastAPI(app, OneHuman(URL))

        @app.get("/api/balance")
        def balance(d=Depends(oh.protect("balance.read"))):
            return {"id": 7, "amount": 4939.1}

        @app.get("/api/profile")
        def profile(d=Depends(oh.protect("profile.read"))):
            return oh.send(d, {"id": 1, "name": "Ada Lindqvist"})

        c = TestClient(app, base_url="http://localhost")   # no license in the tests: local hosts only (see DjangoApp)
        self.assertEqual(c.get("/onehuman/sdk.js").status_code, 200)
        r = c.get("/api/balance")
        self.assertEqual(r.status_code, 200)
        self.assertIn("oh_sid", r.cookies)
        self.assertTrue(r.headers["x-oh-outcome"].startswith("allow;"))
        self.assertEqual(c.post("/onehuman/signals", json=AGENT_ATTACHES, headers={"Origin": "http://localhost"}).status_code, 200)
        r = c.get("/api/balance")
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json()["error"], "blocked")
        self.assertEqual(c.get("/api/profile").json(), {"id": 1, "name": "••••"})


if __name__ == "__main__":
    unittest.main()
