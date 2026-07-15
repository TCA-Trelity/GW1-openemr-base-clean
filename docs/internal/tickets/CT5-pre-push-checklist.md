# CT5 — "Before you push" checklist skill + CLAUDE.md eval-set maintenance rules

REQ: G8 (testing discipline made durable) · Depends on: — · Band: merged-plan Track 2 (CT) · Priority: P1 (per merged-plan.md; "CT5 can happen any time")

## Why

The check sequences exist (RELEASE.md's promotion gate, the ticket-README
ship ritual, CLAUDE.md's PHP commands) but live scattered across three docs,
and the original course-technique plan assumed a Node-only project. Track 1
adds PHP-side work (K.4/K.5, J.4), so the pre-push discipline needs **two
branches keyed on what the diff touched** — and the eval-set maintenance
rules (never edit expected answers; re-baselines are labeled commits; the
CT7 judge never blocks) need to live in the file agents actually load every
session: CLAUDE.md.

## Existing seams you MUST reuse (verified)

- `.claude/skills/` **exists** with two skills: `chesterton/` and `software-factory/`. Layout to mirror: `.claude/skills/<name>/SKILL.md` with YAML frontmatter `name:` + `description:` (see `.claude/skills/chesterton/SKILL.md:1-4`), body in markdown; optional `references/` subdir (not needed here).
- The sidecar check sequence (tickets/README.md "Verify + ship ritual", RELEASE.md promotion gate): `cd sidecar && npm test && npm run typecheck && npm run eval && npm run build`; panel leg `cd sidecar/panel && npx tsc -p tsconfig.json --noEmit && npx vitest run && npm run build`.
- The PHP check commands (CLAUDE.md "Code Quality" / "Testing"): container `openemr-cmd phpstan` / `psr12-report` / `unit-test` (aliases pst/pr/ut), host `composer phpstan` / `phpcs` etc.; pre-commit passthrough `openemr-cmd prek run`.
- `.githooks/pre-push` — already runs the full eval suite for pushes touching `sidecar/**` (install: `git config core.hooksPath .githooks` or `cd sidecar && npm run hooks:install`). The skill complements the hook (covers PHP + panel + the judgment rules the hook cannot enforce); it must POINT at the hook, not duplicate its logic.
- Baseline machinery the rules govern: `sidecar/eval/baseline.json`, `npm run eval:baseline` (`package.json:22` → `tsx eval/gate.ts --write-baseline`), gate.ts header ("Re-baselining is a reviewed diff … never an env flag").
- CLAUDE.md structure — new section slots in before "## Key Documentation" (it is Clinical-Co-Pilot-scoped inside an OpenEMR-wide file; say so in its first line).
- Standing rules being codified: merged-plan standing rules 5 + 6; tickets/README.md standing rules 1-2.

## Files to create/modify

- `.claude/skills/before-you-push/SKILL.md` — new.
- `CLAUDE.md` — one new section (verbatim text below).
- Nothing else. (No changes to `.githooks/pre-push`, no CI changes.)

## Step-by-step implementation

1. Create `.claude/skills/before-you-push/SKILL.md`:

   ```markdown
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
   ```

2. Add the CLAUDE.md section — insert this text verbatim, immediately before `## Key Documentation`:

   ```markdown
   ## Sidecar eval-set maintenance (Clinical Co-Pilot)

   Scope: `sidecar/eval/` — the deterministic eval suite and its gate. These
   rules are load-bearing; they restate the merged-plan standing rules in the
   file every session reads.

   - **Never edit an eval case's expected answer to make a failing case
     pass.** A failing eval is information: fix the code, or re-baseline
     deliberately (next rule). Silent expectation edits are treated as gate
     tampering in review.
   - **Re-baselines are separate, labeled commits.** The only legitimate
     path to changing `sidecar/eval/baseline.json` is `npm run
     eval:baseline`, committed on its own with a message that names what
     changed and why (e.g. `test(eval): re-baseline after adding retrieval
     cases`). An unexplained baseline diff blocks review. Never hand-edit
     the file.
   - **The LLM-judge scorecard (merged-plan CT7) is informational only.** It
     is a manually-run script; it never runs in CI, never blocks a push or
     PR, and never feeds `eval/run.ts` or `eval/gate.ts`. The pass/fail gate
     stays 100% deterministic.
   - **Before any push, run the `before-you-push` skill**
     (`.claude/skills/before-you-push/SKILL.md`) — it branches on whether
     the diff touched `sidecar/`, `sidecar/panel/`, or OpenEMR PHP paths.
   ```

3. Dry-run the skill once on the CT5 diff itself. This diff touches only CLAUDE.md and `.claude/` — neither a sidecar nor a PHP path, so no branch strictly matches — but run Branch 1 anyway (the ship ritual below requires it on every PR), and confirm each command block in the skill is copy-paste-runnable from a fresh shell at repo root.
4. Trackers, ship ritual.

## What NOT to do

- Do NOT wire the skill into CI or hooks — it is an agent/human checklist; the enforcement layers (`.githooks/pre-push`, `evals.yml` required check) already exist and stay unchanged.
- Do NOT duplicate threshold/gate math into the skill or CLAUDE.md — link semantics ("GATE PASS, all green") only; `eval/gate.ts` is the single source.
- Do NOT weaken or reword the three eval-set rules when pasting — "separate labeled commit", "informational only", "never edit expected answers" are the exact commitments graders were promised (merged-plan standing rules 5/6).
- Do NOT create the skill under `docs/` — skills load from `.claude/skills/` (mirror chesterton's layout exactly).
- Do NOT add a repo-root npm script for this — repo-root `package.json` belongs to OpenEMR core (standing rule 4).

## Acceptance checks

```bash
head -5 .claude/skills/before-you-push/SKILL.md
grep -n "Sidecar eval-set maintenance" CLAUDE.md
grep -n "eval:baseline" CLAUDE.md
```

Frontmatter has `name: before-you-push` + a trigger-bearing `description:`;
CLAUDE.md contains the new section before "## Key Documentation"; every
command block in the skill runs verbatim from a fresh shell at repo root
(execute each once and paste outputs in the PR body).

## Tests to add

None (checklist + doc). The executable evidence is running each skill branch
once, recorded in the PR body.

## Tracker updates

- `docs/internal/build-status.html` DATA block: ticket `CT5` (T2 section) → `s: "done"`.
- `docs/w2/requirements.md` — no checkbox; do not invent one.
- `W2_ARCHITECTURE.md` — no edit.

## Verify + ship ritual

```bash
cd sidecar && npm test && npm run typecheck && npm run eval && npm run build
```

Panel untouched — skip the panel leg. Then: conventional commit
(`docs(ct5): before-you-push skill + eval-set maintenance rules in CLAUDE.md`)
with `--trailer "Assisted-by: Claude Code"` (trackers in the SAME commit) →
`git push -u origin claude/merged-eval-course-plan-ky6ulh` → update the
PR #16 body → SendUserFile `docs/internal/build-status.html`.
