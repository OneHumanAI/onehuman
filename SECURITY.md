# Security policy

## Reporting a vulnerability

Use either private channel, and please do not open a public GitHub issue for a security problem:

- GitHub: **[Report a vulnerability](https://github.com/OneHumanAI/onehuman/security/advisories/new)** (Security tab of this repository)
- E-mail: **arif@onehuman.ai**

Include what you found, how to reproduce it, the affected version (`npm ls onehumanai`, or the version in `GET /onehuman/health`), and the impact as you see it. A proof of concept helps; so does a trajectory sample for a detection bypass.

## What you can expect

| When | What |
|---|---|
| within **72 hours** | a human reply confirming we received the report, with a tracking reference |
| within **14 days** | for a confirmed issue: a fix, or a written plan with a date and the interim mitigation |
| on release | a changelog entry and a GitHub security advisory; credit to you by name or handle, if you want it |

We will keep you informed while we work on it. If we disagree that something is a vulnerability, we will say why.

## Scope

In scope:

- the `onehumanai` package: browser SDK, Express/Connect middleware, CLI, proof verifier, and the engine (detection, policy, audit log, signed decision proofs)
- the portal and its API at https://onehuman.ai (accounts, API keys, rules, telemetry ingest)

Out of scope: the synthetic data in the demo apps, denial-of-service by volume, reports from automated scanners without a demonstrated impact, and third-party services the hosted portal runs on: report those to their providers.

## Detection bypasses

Passing as a human is an arms race, and we treat a working bypass as a welcome research report rather than a vulnerability. Send it the same way; we credit it in our measurements page, which lists what is known to get through: https://onehuman.ai/measurements

## Safe harbour

We will not pursue legal action against research done in good faith that follows this policy: test only against your own installation or your own portal account, do not access or change other people's data, do not degrade the service for others, and give us the time above before publishing. If in doubt, ask first at the same address.

## Supported versions

The latest minor release on npm receives security fixes. Older releases get a fix when the issue is severe and the upgrade is not a drop-in.
