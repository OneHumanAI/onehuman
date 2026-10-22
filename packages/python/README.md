# onehumanai for Python

Access control for the AI agents your customers log in with. When a customer lets Claude in Chrome, ChatGPT agent, Codex or Comet use their signed-in account, each protected view decides: allow it, hide the private fields, wait for the account owner's passkey, or keep it closed. Every decision is signed on your own server.

The engine runs next to your app as a small local service; this package is the part inside your app. It has no dependencies.

```bash
npx onehumanai init          # writes onehuman.policy.json and ONEHUMAN_SECRET (.env)
npx onehumanai sidecar       # the engine, on 127.0.0.1:8788 (run it next to your app)
pip install onehumanai
```

Add the page script to your pages: `<script src="/onehuman/sdk.js"></script>`, and call protected endpoints with `OneHuman.fetch(url)`.

## Flask

```python
from onehumanai.flask import OneHumanFlask
oh = OneHumanFlask(app, identify=lambda: session.get("user_id"))

@app.get("/api/balance")
@oh.protect("balance.read")
def balance():
    return oh.send(full_balance, mask_balance)
```

## Django

```python
# settings.py
MIDDLEWARE = [..., "onehumanai.django.OneHumanMiddleware"]

# views.py
from onehumanai.django import protect, send

@protect("balance.read")
def balance(request):
    return JsonResponse(send(request, full_balance, mask_balance))
```

## FastAPI

```python
from onehumanai.fastapi import OneHumanFastAPI
oh = OneHumanFastAPI(app)

@app.get("/api/balance")
def balance(d=Depends(oh.protect("balance.read"))):
    return oh.send(d, full_balance, mask_balance)
```

A blocked request gets 403 and a step-up gets 428, with the same JSON the Node middleware sends, so the page script handles both the same way. If the sidecar is slow or down, protected views go on as allowed and the failure is logged: OneHuman never breaks your app.

Licence: Apache-2.0 (this package). The engine inside `npx onehumanai` is BUSL-1.1: production use with a OneHuman license (a free API key). https://onehuman.ai
