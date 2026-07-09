# Release & branch model

Two branches, one gate. Production and the instructor-facing mirror only ever
see commits that have been proven stable and deliberately promoted.

## Branches

- **`main` — stable / instructor-facing.** The production Railway environment
  and the evaluated mirror track this branch. It advances *only* by a deliberate
  promotion of a proven commit — never a work-in-progress push. This is the
  "last stable version" at all times.
- **`claude/sidecar-debug-redeploy-hwd66g` — working / release branch.** All
  active development lands here (supersedes `claude/ehr-architecture-defense-gg486o`,
  whose history it contains). In-flight and occasionally-broken states are
  expected and fine; nothing here reaches instructors until it is promoted.

Rule of thumb: **commits are made on the working branch; `main` only moves on a
promotion.**

## Where things stand (2026-07-09, evening)

- `main` @ `736b51a` — AZ/TC3, config-hardening, CI gate, ops docs, load probe.
  **Note:** its sidecar cannot deploy — the tree predates the export-ignore fix,
  so the archive Railway builds from drops `sidecar/src/chat/tools/` (TS2307).
- working @ current HEAD — everything on `main` plus S3.3 (verify workflow),
  the deploy hardening (DB-reinstall guard, REST 500 message fix), and the
  **deploy-blocker root-cause fix**: `.gitattributes` unanchored
  `tools/ export-ignore` was silently excluding `sidecar/src/chat/tools/` from
  every GitHub source archive — the build context Railway deploys. Anchored to
  `/tools/`, added a `sidecar/** -export-ignore` carve-out, reverted the
  CACHEBUST workaround, and added an export-parity CI job so this class of
  failure is caught on push. **Promote this once its deploy is confirmed clean.**

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
git merge --ff-only claude/sidecar-debug-redeploy-hwd66g
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
