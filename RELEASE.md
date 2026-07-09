# Release & branch model

Two branches, one gate. Production and the instructor-facing mirror only ever
see commits that have been proven stable and deliberately promoted.

## Branches

- **`main` — stable / instructor-facing.** The production Railway environment
  and the evaluated mirror track this branch. It advances *only* by a deliberate
  promotion of a proven commit — never a work-in-progress push. This is the
  "last stable version" at all times.
- **`claude/ehr-architecture-defense-gg486o` — working / release branch.** All
  active development lands here. In-flight and occasionally-broken states are
  expected and fine; nothing here reaches instructors until it is promoted.

Rule of thumb: **commits are made on the working branch; `main` only moves on a
promotion.**

## Where things stand (2026-07-09)

- `main` @ `eb0a8b9` — pre-AZ, last known-good deploy: TC1/TC2 tool-use, the EHR
  layer, imaging, the working app. Stable.
- working @ current HEAD — adds TC3 (tool activity render), Wave AZ
  (authorization: verifier + PEP + role switcher), the panel auth wiring, and
  the fail-closed SMART-role fix. Fully unit-tested (sidecar 319, panel 72) and
  builds clean; **not yet promoted** — pending a confirmed clean deploy (a bad
  env var can still crash boot until the config-hardening lands; see below).

## Promotion (working → stable)

Promote only when ALL of these are green on the working branch HEAD:

1. `cd sidecar && npm test` **and** `cd sidecar/panel && npm test`
2. `npm run typecheck` in both
3. `npm run build` in `sidecar/panel` and `sidecar` (the Docker build path)
4. A clean deploy — `/health` and `/ready` green on a staging or test deploy

Then fast-forward `main` (working already contains all of `main`'s history, so
this never rewrites stable):

```
git checkout main
git merge --ff-only claude/ehr-architecture-defense-gg486o
git tag stable-$(date +%Y-%m-%d)
git push origin main --tags
```

If `--ff-only` refuses, `main` has commits the working branch lacks — rebase the
working branch onto `main`, re-run the gate, then promote.

## Rollback

`main` is always the last proven commit, and each promotion is tagged
`stable-YYYY-MM-DD`. To roll production back: redeploy the `main` deployment
(Railway → the service → Deployments → Redeploy) or check out the latest
`stable-*` tag. Nothing on the working branch can affect production until the
next promotion.

## Hardening that protects this model

- **Boot-crash-proof config** — a malformed env var should disable *that feature*
  and log a warning, not throw and kill the process. (Tracked; lands on the
  working branch before the next promotion.)
- **Health-gated deploys** — `railway.json` sets `healthcheckPath: /health`;
  Railway keeps the previous healthy deployment serving if a new one fails its
  health check, so a bad promotion cannot take production down.
