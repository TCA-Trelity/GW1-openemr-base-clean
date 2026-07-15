# H.17 — Every test names the failure mode it guards against (G8's open clause)

REQ: G8 · Depends on: — (safest item in the plan; zero behavior change) · Band: merged-plan Track 1 · Priority: P2 (per merged-plan.md)

## Why

G8's box is open strictly on its last clause: *"every test names the failure
mode it guards against"* — §11's layer table maps failure modes at layer level,
but per-test naming *"is not enforced test-by-test"* (the register's own
annotation). This ticket closes it with pure renaming/comment work — no
assertion, id, or behavior changes — and defines a grep-able convention so the
clause stays enforced by inspection, not memory. The merged plan marks this the
safest item to skip under deadline; if executing near a grading cutoff, confirm
priorities before spending the hours.

## Sampling result (verified 2026-07-15 — define the heuristic from THIS, not from imagination)

- ~524 `it(` cases across `sidecar/test/` (+ 14 eval suites in `sidecar/eval/`, 6 panel test files).
- **No `it('works')`-style titles exist** — a naive "no generic titles" acceptance would be vacuously green on day one. The generic-title regex below is therefore a *ratchet* (pins the current zero), not the deliverable.
- The repo's real failure-mode convention is **`// Guards:` comments** (267 occurrences, e.g. `test/obs.test.ts`, `test/chat.test.ts`), but coverage is uneven: **21 of ~35 `test/*.test.ts` files, all 14 `eval/*.eval.ts`, and all 6 `panel/src/test/*.tsx` contain no `Guards:` token at all** (several carry prose headers naming failure modes without the token — e.g. `test/graph.test.ts:1-4` — which one grep cannot find).
- Title quality is mixed: strong exemplars name the failure (`'fails closed after the second invalid output — nothing persistable escapes'`, `'the critic BLOCKS an invented quote — uncited claims cannot release (E1)'`); the weak minority states only the happy path (`test/game-plan.test.ts:65 'returns a validated plan from one call'`, `test/store.test.ts:68 'creates exactly the eight expected tables'`, `test/tools.test.ts:114 'returns the full text + provenance for a known document'`).

## Existing seams you MUST reuse

- The `// Guards:` comment convention (`test/obs.test.ts` is the exemplar: a one-liner above a describe/case naming what regression it catches) — extend THIS convention; do not invent a new tag.
- The em-dash title style already in the suite (`'<behavior> — <what breaking it means>'`) for the renames.
- `eval/collector.ts:EvalRecord` — `id` (STABLE — `<suite>.<case>`, referenced by reports/history; NEVER rename) vs `description` (*"One-line human description of what the case checks"* — safe to sharpen).
- `eval/baseline.json` — keyed by category rates; description edits don't touch it, but run the gate to prove that, and never hand-edit it (standing rule 2).
- `W2_ARCHITECTURE.md` §11 (`## 11. Testing strategy (REQ: G8) — [SHIPPED: layer table verified vs the shipped suites 2026-07-14 · TARGET: per-test failure-mode naming (G8's strict clause)]`) — the header TARGET this ticket clears, and where the convention gets one documenting paragraph.

## Files to create/modify

- **Modify** (comments/titles only): the 21 `sidecar/test/*.test.ts` files lacking `Guards:`, all 14 `sidecar/eval/*.eval.ts`, all 6 `sidecar/panel/src/test/*.tsx` — plus title renames for the weak minority wherever found.
- **Modify** `sidecar/eval/*.eval.ts` — sharpen generic `description` fields only (ids untouched).
- **Modify** `W2_ARCHITECTURE.md` — §11 header + one paragraph documenting the convention.
- Trackers: `docs/w2/requirements.md`, `docs/internal/build-status.html`.
- **No source files under `src/` change. No assertion changes. No new tests.**

## Step-by-step implementation

1. **Convention (the deliverable's definition — put this exact contract in §11):**
   - Every test file under `sidecar/test/`, `sidecar/eval/` (`*.eval.ts`), and `sidecar/panel/src/test/` contains at least one `// Guards:` comment; every `describe` block is covered by one (file-header `Guards:` covering all describes is fine for single-topic files; multi-topic files get one per describe). The comment names the failure mode(s) — what production breakage the tests catch — not a restatement of the title.
   - `it` titles state behavior + stakes where the title alone would otherwise be ambiguous; happy-path-only titles get the em-dash clause.
   - Grep ratchets (both must hold): `grep -rL "Guards:" <the three dirs' test globs>` → empty; the generic-title regex → zero matches.
2. **Normalize existing prose headers**: files like `test/graph.test.ts` whose header already lists failure modes get the literal token added (e.g. `// Failure modes guarded:` → `// Guards:` or prepend `Guards:` inside the existing sentence) — smallest diff that makes one grep find everything.
3. **Fill the gaps**: for each of the 41 files lacking the token, read the describes and write honest `// Guards:` lines. Derive them from what the assertions actually pin (e.g. `chunker.test.ts` → "Guards: a threshold table split from its qualifying text — the chunk-integrity rule S2/R3 exists for"). Where you cannot say what failure a test guards, that is a finding — title it after what it truly checks; do not invent drama.
4. **Rename the weak titles**: sweep `grep -rn "it('" over the three dirs`; rename only titles that state a happy path with no condition/stakes (the three sampled above are in scope; expect a few dozen total). Keep renames truthful and short — house style, not purple prose.
5. **Eval descriptions**: sweep the ~59 `recordEval` `description` fields; sharpen only genuinely generic ones to name the failure mode (the sampled ones — e.g. phi-log-sweep's — are already strong). **Do not touch `id`.** Run `npm run eval` — same case count, GATE PASS, `docs/execution/eval-results.md` regenerates with the new descriptions (that regenerated file rides the same commit; it is generated output, not a hand edit).
6. **§11**: add a short paragraph after the layer table — the convention from step 1 + the two grep commands — and flip the header TARGET (see Trackers).
7. Trackers, ship.

## What NOT to do

- Do NOT change any assertion, fixture, timeout, or test structure — a diff line outside comments/strings (titles, descriptions) is scope creep; if you find a real bug while reading, file it in the PR body, don't fix it here.
- Do NOT rename `EvalRecord.id` values or edit `eval/baseline.json` — ids are the stable keys; descriptions are the mutable surface.
- Do NOT delete or reword the informative header comments that exceed the convention — the token is additive.
- Do NOT bulk-generate identical boilerplate Guards lines ("Guards: regressions in X") — a comment that names no concrete failure is the thing G8's clause forbids, wearing the right syntax.
- Do NOT gate CI on the greps this ticket — they are review ratchets documented in §11; wiring a lint job is future work if drift actually happens.

## Acceptance checks

```bash
cd sidecar && grep -rL "Guards:" test/*.test.ts eval/*.eval.ts panel/src/test/*.tsx   # → no output
cd sidecar && grep -rEn "it\((['\`])(works|should |handles |basic |test )" test eval panel/src/test   # → no output
cd sidecar && npm test && npm run eval    # same counts as before this ticket, GATE PASS — zero behavior change proven
cd sidecar/panel && npx vitest run        # panel titles-only edits still green
git diff --stat                            # only test files, eval files, docs, trackers
```

(Case-count note: 58/58 — or 59/59 if H.14 landed first; whatever `npm run eval`
printed before this ticket must be what it prints after.)

## Tests to add

None — this ticket edits how existing tests are NAMED. The acceptance greps are
the added enforcement surface, documented in §11.

## Tracker updates

- `docs/w2/requirements.md` — under **G8** (~:571), flip to `[x]` (verbatim lines):

  ```
  - [ ] W2_ARCHITECTURE.md section: what is unit-tested (schema validators, tool
    functions, gate math), integration-tested (ingestion flow, RAG pipeline,
    graph), evaluated via golden set (agent behavior), and **not tested and
    why**; every test names the failure mode it guards against.
    *(§11 layer table verified 2026-07-14 — unit/contract/stubbed-integration/
    58-case golden/live-opt-in/baseline layers plus not-tested-and-why. Open
    strictly on the last clause: per-test failure-mode naming is not enforced
    test-by-test.)*
  ```

  Update the annotation's last sentence to: `Closed by H.17: Guards:-comment convention across test/, eval/, panel tests + weak-title renames; grep ratchets documented in §11.`
- `docs/internal/build-status.html` DATA block: ticket `H.17` (L460) `s: "pending"` → `"done"`; reqGroups: `G8` row `done: 0, total: 1` → `done: 1`, `s: "done"`.
- `W2_ARCHITECTURE.md` — §11 header: `· TARGET: per-test failure-mode naming (G8's strict clause)]` → `· per-test failure-mode naming SHIPPED (H.17)]`.

## Verify + ship ritual

```bash
cd sidecar && npm test && npm run typecheck && npm run eval && npm run build
```

Panel test files were touched (titles/comments only) — run the panel leg too:

```bash
cd sidecar/panel && npx tsc -p tsconfig.json --noEmit && npx vitest run && npm run build
```

Then: conventional commit with `--trailer "Assisted-by: Claude Code"`
(trackers in the SAME commit) →
`git push -u origin claude/merged-eval-course-plan-ky6ulh` → update PR #16
body (checklist line for H.17) → SendUserFile
`docs/internal/build-status.html` (rendered inline).
