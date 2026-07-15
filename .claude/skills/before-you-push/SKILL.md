---
name: before-you-push
description: Pre-push checklist for this repo. Use before ANY git push. Branches on what the diff touched — sidecar/ (Node checks incl. the eval gate), sidecar/panel/ (panel leg), or OpenEMR PHP paths (container-based phpstan/phpcs/tests). Also enforces the eval-set maintenance rules (no expected-answer edits to force passes; re-baselines are separate labeled commits; the CT7 LLM-judge is informational-only). Trigger on "push", "pre-push", "ready to push", "ship this", or before ending a session with unpushed commits.
---

# Before you push

Determine what the outgoing range touches, then run every matching branch.

```bash
git diff --name-only @{upstream}..HEAD 2>/dev/null || git diff --name-only HEAD~1..HEAD
```

## Branch 1 — anything under `sidecar/` (except `sidecar/panel/`)

```bash
cd sidecar && npm test && npm run typecheck && npm run eval && npm run build
```

`npm run eval` must end **GATE PASS with every case green** — a red gate
is a stop, never a bypass (no env flags, no comparator edits, no skipping;
the pre-push hook in `.githooks/pre-push` runs it again anyway).

## Branch 2 — additionally, anything under `sidecar/panel/`

```bash
cd sidecar/panel && npx tsc -p tsconfig.json --noEmit && npx vitest run && npm run build
```

## Branch 3 — OpenEMR PHP paths (`src/`, `library/`, `interface/`, `tests/`, `sql/`)

In the openemr container (start it first if needed:
`cd docker/development-easy && docker compose up --detach --wait`):

```bash
openemr-cmd phpstan
openemr-cmd psr12-report
openemr-cmd unit-test
```

Host-toolchain equivalents: `composer phpstan`, `composer phpcs`, and the
relevant suite per CLAUDE.md's Testing section. Fix, never baseline, any
phpstan finding your own diff introduced.

## Every branch — the judgment checks

- Eval expected answers untouched? If a case's expectation changed on
  purpose, it is a SEPARATE commit labeled as a re-baseline (see
  CLAUDE.md "Sidecar eval-set maintenance").
- Trackers ride the same commit as the code (build-status DATA block,
  requirements checkboxes, W2_ARCHITECTURE status markers).
- Conventional commit + `--trailer "Assisted-by: Claude Code"`.
