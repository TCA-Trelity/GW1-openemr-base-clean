# Release & branch model

One protected line, one gate. Production and the instructor-facing mirror only
ever see commits that have been proven stable and deliberately promoted.

## The model (current — PR-gated)

- **`main` — stable / instructor-facing.** The production Railway environment
  and the evaluated mirror track this branch. It advances *only* by merging a
  reviewed, CI-green pull request — the merge **is** the promotion decision.
  This is the "last stable version" at all times.
- **Feature branches (`claude/*`)** — all active development. In-flight and
  occasionally-broken states are expected and fine; nothing reaches
  instructors until its PR merges.

This supersedes the earlier two-branch model (a designated working branch,
`claude/sidecar-debug-redeploy-hwd66g`, manually promoted to `main`), which
served the 2026-07-09/10 deploy-blocker firefight. Wave M (PR #4, merged
2026-07-11 as `b1b9346`) was the first promotion through the PR gate.

## Promotion gate

> **2026-07-13 — the gate is now ENFORCED by branch protection:** `main`
> requires the **`Run eval suite`** status check (plus the Sidecar CI jobs)
> to pass before any merge — the Week 2 eval gate (58 cases, tiered category
> math, rehearsed in `docs/w2/gate-rehearsal.md`) cannot be bypassed by an
> ordinary merge. (0.5 acceptance.)

A PR may merge to `main` only when ALL of these are green on its head:

1. `cd sidecar && npm test` **and** `cd sidecar/panel && npm test`
2. `npm run typecheck` in both (plus `typecheck:eval`)
3. `npm run build` in `sidecar/panel` and `sidecar` (the Docker build path)
4. The CI suite on the PR — including `export parity` (deploy archive ==
   committed tree) and the live smoke where applicable. Known-benign
   infra failures (e.g. Codecov tokenless-upload rejections; no
   `CODECOV_TOKEN` secret is configured) are the only acceptable reds, and
   must be verified as such per-run, not assumed.

## Checkpoints for graders

Immutable checkpoints are tags, minted from CI because the dev session's git
proxy only accepts branch pushes (`.github/workflows/tag-stable.yml`; currently
hard-coded per tag). Existing: `stable-2026-07-09` → `2124b47` (in `main`'s
history). Cut a fresh `stable-YYYY-MM-DD` tag at each submission milestone so
graders always have a frozen ref while Railway tracks `main`.

## Historical note: orphaned deployment SHAs

During the 2026-07-09/10 firefight, at least one promotion replaced `main`'s
history instead of fast-forwarding. Two then-tips of `main` are therefore no
longer reachable from any branch or tag:

- `736b51a` — recorded as `main`'s tip in this file's 2026-07-09 revision.
- `46e149aa` — the commit the Railway **OpenEMR service's** Active deployment
  (built 2026-07-10 ~4 PM EDT) still reports as of 2026-07-11.

These SHAs are not corruption and not mystery meat: they were `main` when they
were built/recorded, and were superseded by later promotions. The content they
carry predates the 2026-07-10 insurance-route fix (`7562e84`) and everything
after it — which is why the deployed EHR can 500 on routes that are fixed in
today's `main`. The remedy is always "deploy current `main`," never "redeploy
the orphaned SHA."

## Rollback

`main` is always the last proven commit, and submission milestones are tagged
`stable-YYYY-MM-DD`. To roll production back: redeploy the previous `main`
deployment (Railway → the service → Deployments → Redeploy on that older
deployment) or deploy the latest `stable-*` tag. Nothing on a feature branch
can affect production until its PR merges.

## Hardening that protects this model

- **Boot-crash-proof config** — a malformed env var disables *that feature*
  and logs a warning (`[config] X is invalid and was ignored`), it does not
  kill the process.
- **Health-gated deploys** — `railway.json` sets `healthcheckPath: /health`;
  Railway keeps the previous healthy deployment serving if a new one fails its
  health check, so a bad promotion cannot take production down.
- **Export parity in CI** — the deploy archive is byte-compared against the
  committed tree on every push, so an export-ignore regression (the original
  deploy blocker) fails on push instead of silently shipping a partial tree.
- **Deploy triggers** — the OpenEMR service must rebuild on any `main` change
  outside `sidecar/**` and `docs/**` (Railway watch paths are *include*
  patterns: `/**` plus `!sidecar/**`, `!docs/**`). A service that misses two
  consecutive `main` movements has a trigger problem, not a code problem —
  check Settings → Source before debugging anything else.
