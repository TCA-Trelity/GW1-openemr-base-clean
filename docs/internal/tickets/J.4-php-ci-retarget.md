# J.4 — Retarget PHPStan + Semgrep workflows to this fork's `main`

REQ: G7 (security scanning; the PHP-side gap sidecar-security.yml's own header documents) · Depends on: — (USER-ACTIONS item 12 for the required-check flip) · Band: merged-plan Track 1 (J) · Priority: P1 within sub-track J (per merged-plan.md)

> **PARKED — post-grading.** Sub-track J is "post-grading hardening". Also:
> the first PR after retargeting may need a baseline commit (Step 4), which is
> review noise nobody wants during the grading window.

## Why

This fork inherited **54 of its 60** workflow files from upstream OpenEMR
(the merged plan's "roughly 50" — verified count; the 6 fork-authored ones
are `evals.yml`, `live-smoke.yml`, `sidecar-ci.yml`, `sidecar-load.yml`,
`sidecar-security.yml`, `tag-stable.yml`). The inherited PHP checks are
branch-filtered to upstream's `master` / `rel-*` and **never fire on this
fork's `main`** — `sidecar-security.yml`'s own header says exactly this about
`semgrep.yml`. So today the OpenEMR PHP side (including the fork's own
`oe-module-clinical-copilot` and `oe-module-dashboard-context`, plus K.4/K.5
work to come) merges with zero PHP CI. Retarget the two highest-value checks
— PHP static analysis and the PHP security scanner — and accept pre-existing
findings as a committed baseline, the same posture the sidecar side already
committed to (`sidecar/eval/baseline.json`; sidecar-security's documented
wholesale rule-exclusions).

## Existing seams you MUST reuse

- `.github/workflows/phpstan.yml` — `name: PHPStan`; triggers `on.push.branches` / `on.pull_request.branches` = `master`, `rel-*` (lines 3-11). Job id `phpstan`, single-element matrix `php-version: ['8.5']` → the check name branch protection sees is **`phpstan (8.5)`**. Analyze step: `vendor/bin/phpstan --memory-limit=8G analyze -c .phpstan/phpstan.ci.neon --error-format=github` (fails only on NEW errors — `.phpstan/phpstan.ci.neon` sets `reportUnmatchedIgnoredErrors: false`). It then regenerates the baseline (`composer phpstan-baseline`), enforces `git diff --exit-code .phpstan/baseline/` ("Ensure baseline is stable"), and uploads the `phpstan-baseline-php8.5` artifact.
- `.github/workflows/semgrep.yml` — `name: Semgrep Security Scan`; same `master`/`rel-*` filters plus a weekly cron + `workflow_dispatch`. Job id `semgrep`, `name: Semgrep Security Scan` → check name **`Semgrep Security Scan`**. Two legs: full scan → SARIF on push events; **diff-aware scan vs `BASE_SHA` on pull_request** (inherently only new findings — a built-in baseline semantics).
- `.github/workflows/phpstan-baseline-diff.yml` — chained via `workflow_run` on the `PHPStan` workflow; posts the sticky baseline-diff PR comment. Needs NO edit: it activates automatically once PHPStan runs on this fork's PRs.
- `.phpstan/baseline/` (committed baseline files), `composer phpstan-baseline` (regeneration), `phpstan.neon.dist` `paths:` — note `interface` IS analyzed, so the fork's PHP modules are in scope; `interface/modules/custom_modules/oe-module-claimrev-connect/*` is already excluded as third-party.
- In-container equivalents (CLAUDE.md): `openemr-cmd phpstan` (pst), `openemr-cmd phpstan-generate` (psg) — for running the analysis without a host PHP toolchain.
- USER-ACTIONS item 7 — the existing branch-protection click path (the required-check flip in Step 6 reuses it verbatim); item 12 is the parked placeholder this ticket fills.

## Files to create/modify

- `.github/workflows/phpstan.yml` — add `- main` to both branch lists.
- `.github/workflows/semgrep.yml` — add `- main` to both branch lists.
- `.phpstan/baseline/*.php` — regenerated IF the fork's PHP tree carries findings upstream's baseline doesn't cover (expected: the fork-authored modules under `interface/modules/custom_modules/`). Committed as its own clearly-labeled commit.
- `docs/internal/tickets/USER-ACTIONS.md` item 12 (GitHub half) + `docs/internal/user-actions.html` — the two exact check names to add as required checks.
- NOTHING else. Explicitly out of scope: fixing any upstream finding, editing `semgrep.yaml` rules, touching the other 52 inherited workflows (api-docs.yml et al. stay upstream-scoped — the merged plan picked exactly two).

## Step-by-step implementation

1. **Retarget the triggers.** In both workflow files, the push and pull_request `branches:` lists gain `- main`. Keep `master` and `rel-*` entries — they are inert on this fork (no such branches) and preserve merge-hygiene with upstream.
2. **Dry-run PHPStan against the fork's tree before pushing** (predict the baseline delta instead of discovering it in a red PR):
   - Container path: `cd docker/development-easy && docker compose up --detach --wait`, then `openemr-cmd phpstan`. (Honest note: this repo's dev container may not already be running in the executing environment — budget the compose boot.)
   - Host path: `composer install` then `composer phpstan`.
3. **Interpret the result:**
   - Clean → no baseline change; proceed.
   - Findings in **fork-authored, currently-being-touched code** → fix them (CLAUDE.md: "when modifying a file, fix any existing baseline entries for that file" — do not baseline your own new code).
   - Findings in **inherited/pre-existing code paths** the fork hasn't touched → `composer phpstan-baseline` (or `openemr-cmd psg`) and commit the regenerated `.phpstan/baseline/` files as a dedicated commit: `chore(ci): accept pre-existing phpstan findings as baseline for fork main`. This is the deliberate J.4 posture and mirrors how the sidecar committed its accepted baselines; note in the PR body that CLAUDE.md's "avoid new baseline entries" rule is being consciously applied at fork-adoption granularity, not per-line.
4. **Semgrep needs no baseline file**: the PR leg is diff-aware (only new findings can fail a PR). Before merging, READ both legs of `semgrep.yml` end-to-end and confirm the full-scan (push) leg's failure semantics — it produces SARIF for the Security tab; verify whether it runs with `--error` and, if pre-existing findings would fail the push leg on `main`, record them via the workflow's existing exclusion idiom (`--exclude-rule` with a rationale comment, exactly like the two `echoed-request`/`printed-request` exclusions already there) — never by deleting the leg.
5. **Prove both fire.** Open the PR with these edits; both new checks must appear on it (`pull_request` targeting `main` now matches). Expect `phpstan (8.5)` and `Semgrep Security Scan` in the PR checks list, plus the sticky PHPStan-baseline-diff comment.
6. **Required-check flip (user).** Rewrite USER-ACTIONS item 12's GitHub half: same click path as item 7 (Settings → Branches → the `main` rule → status checks search box), adding exactly `phpstan (8.5)` and `Semgrep Security Scan` (branch protection matches JOB names, not workflow titles — the item 7 lesson). Include item 7's "if nothing is suggested" remedy (checks must have run in the last 7 days — this PR's runs satisfy that).
7. Trackers, ship ritual.

## What NOT to do

- Do NOT attempt to fix upstream OpenEMR findings — explicitly out of this ticket's scope per the merged plan ("rather than trying to fix everything upstream ever wrote").
- Do NOT retarget more than these two workflows — the other inherited ones (api-docs, rector, styling, test.yml, docker-*) stay as-is; each would need its own runtime-cost/flakiness assessment.
- Do NOT hand-edit `.phpstan/baseline/*.php` — only `composer phpstan-baseline` regenerations (the workflow's "Ensure baseline is stable" step hard-fails manual edits anyway).
- Do NOT remove the `master`/`rel-*` filters or the weekly semgrep cron.
- Do NOT mark the checks required yourself via API — that is the user's deliberate click (item 12), matching how item 7 was handled.
- Do NOT let a red retarget PR sit: if Step 2's prediction missed something, either fix (fork code) or baseline (inherited) in the same PR — a permanently-red required check teaches everyone to ignore CI.

## Acceptance checks

```bash
git push -u origin claude/merged-eval-course-plan-ky6ulh
gh pr checks 16
# expect rows for: phpstan (8.5) ........ pass
#                  Semgrep Security Scan  pass
# plus the existing Run eval suite / sidecar rows
```

And on the PR page: the PHPStan Baseline Diff sticky comment appears (proves
the workflow_run chain engaged). After the user's item 12 flip: the merge box
lists both checks as Required.

## Tests to add

None in-repo (the workflows ARE the tests). Evidence to record in the PR
body: links to the first green `phpstan (8.5)` and `Semgrep Security Scan`
runs on a `main`-targeting PR, and the baseline-commit SHA if Step 3 produced
one.

## Tracker updates

- `docs/internal/build-status.html` DATA block: ticket `J.4` (T1 section) → `s: "done"`.
- `docs/internal/tickets/USER-ACTIONS.md` item 12 + `docs/internal/user-actions.html` (same commit).
- `docs/w2/requirements.md` — no checkbox for this follow-on; do not invent one.

## Verify + ship ritual

PHP-side ticket — per merged-plan standing rule 3, run the PHP checks the way
any PHP change is checked (Step 2's container or host path): `openemr-cmd
phpstan` + `openemr-cmd psr12-report` (workflow YAML itself is also covered
by `actionlint` via the pre-commit suite: `openemr-cmd prek run --all-files`
if hooks are installed). Additionally the standard sidecar leg, since the PR
gate runs it regardless:

```bash
cd sidecar && npm test && npm run typecheck && npm run eval && npm run build
```

Panel untouched — skip the panel leg. Then: conventional commit with
`--trailer "Assisted-by: Claude Code"` (trackers in the SAME commit; the
baseline regeneration is its OWN labeled commit per Step 3) →
`git push -u origin claude/merged-eval-course-plan-ky6ulh` → update the
PR #16 body → SendUserFile `docs/internal/build-status.html`.
