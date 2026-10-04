# Contributing

Thanks for taking the time. OneHuman is small enough to understand in an afternoon; this page tells you where things are and what a good change looks like.

## Before your first pull request: the CLA and the licence

OneHuman is licensed in two parts (see [`LICENSE`](LICENSE)): the browser SDK, the middleware, the CLI and the proof verifier under **Apache 2.0**; the engine and everything else under the **Business Source License 1.1**. To keep that possible, every contributor agrees to the [Contributor License Agreement](CLA.md) once. You keep your copyright; you allow the project to distribute your contribution under the licences it uses. Sign it by adding one line to your first pull request's description — the template has it.

Every new source file starts with its licence: `// SPDX-License-Identifier: Apache-2.0` under `sdk/` and `integrations/`, `// SPDX-License-Identifier: BUSL-1.1` everywhere else. The open code may reach the engine only through `server/public.ts`; the build and a test enforce this.

## Setup

```bash
git clone https://github.com/OneHumanAI/onehuman.git
cd onehumanai
npm install
npm run check      # tsc + tests — must pass before a PR
npm run example    # the engine behind a small Express app, http://localhost:3000
```

Node ≥ 22.13 (the engine uses `node:sqlite`). No build step for development; TypeScript runs directly.

## Where to change what

| Want to… | Look at |
| --- | --- |
| Add a detection signal | `sdk/onehuman.js` (collect) → `server/signals.ts` (validate) → `server/assess.ts` (weigh) → `server/connection.ts` (attach-time) |
| Change how a click is judged | `server/kinematics.ts` (features + rules), `server/kinematics-model.ts` (learned model) |
| Retrain the model | Maintainers retrain on the recorded dataset (grouped CV by client, zero-FP thresholds) and commit `server/kinematics-model.json` |
| Add a policy branch or mode | `server/policy.ts` |
| Change the integration API | `integrations/express/index.ts` + `QUICKSTART.md` + `packages/onehumanai/README.md` |

## Rules we hold ourselves to

1. **Zero human false positives is the constraint, not a target.** Any change to kinematics or assessment must keep 0 misjudged real-browser human clicks and 0 engine misses on recorded human runs; maintainers check it against the recorded dataset before merging.
2. **"Unknown" is never human.** Do not add a path that treats missing telemetry as evidence of a person.
3. **Environment ≠ agent.** An installed extension or an AI app's browser is a trace about the browser, not the hand. It must not, on its own, block a person.
4. **Page-side observation with standard web APIs only.** We do not reverse-engineer vendors' bundled code or ship per-vendor fingerprints beyond publicly visible DOM markers and globals.
5. **Metadata only.** The SDK never sends page text, key identities or form values. Keep it that way.
6. **Measure, then change thresholds.** Every threshold in `kinematics.ts` has a comment with the measurement behind it. Add yours.

## Pull requests

- One concern per PR. Tests for behaviour changes (`tests/`).
- If you touch detection, include the before/after of `npm run eval` in the description.
- Commit messages in imperative mood; reference the docs section you updated.

## Reporting a false positive

The most valuable issue you can file. Please include: browser + OS + input device, what you clicked, and — if you ran the training lab — the run code shown at the end. Never include real personal data.
