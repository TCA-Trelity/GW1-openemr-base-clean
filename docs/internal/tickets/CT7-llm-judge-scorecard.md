# CT7 — Informational-only LLM-judge scorecard for the full-answer cases

REQ: S4/R6 (quality measurement — informational leg only; merged-plan standing rule 6 forbids gate coupling) · Depends on: USER-ACTIONS item 13 (one-time human-expert scoring batch); live ANTHROPIC_API_KEY at run time · Band: merged-plan Track 2 (CT) · Priority: P2 (per merged-plan.md)

> **PARKED — post-submission-crunch.** Track 2 sequencing: "CT6 and CT7 wait
> until after the submission crunch." Also gated on the user's ~30-minute
> expert-scoring batch (item 13).

## Why

The 58-case gate is deliberately deterministic — it proves structure
(citations verified, PHI absent, routing correct), not prose quality. For the
handful of cases that end in a full composed answer, a second model can score
*quality* dimensions a structural check cannot: does the answer stick to the
retrieved evidence, is it clinically useful to a retina practice, does it
stay inside the product's scope discipline. This is purely informational by
locked design: merged-plan standing rule 6 — "the automated pass/fail gate
never depends on an AI model's subjective judgment"; CLAUDE.md's CT5 section
restates it. The scorecard's whole value depends on that separation staying
provable.

## Which cases produce full composed answers (verified)

The deterministic gate's model outputs are SCRIPTED (`multi-turn-chat.eval.ts`
header: "the model scripted through the same mocked-SSE seam";
`graph-path.eval.ts` builds a stub composer at its `composer()` helper), so
judging *gate-run* text would judge scripts — meaningless. The judge instead
**re-produces answers live** for the questions of the composed-answer suites,
using the production composer path, then scores those:

- `sidecar/eval/graph-path.eval.ts` — the evidence-path goldens whose output is a cited composed answer: ids `graph-path.upload-to-cited-answer`, `graph-path.out-of-corpus-honest`, `graph-path.pinned-evidence-on-topic` (the fourth, `graph-path.critic-blocks-invention`, is a gate-behavior case — exclude it; its "answer" is deliberately blocked content).
- `sidecar/eval/multi-turn-chat.eval.ts` — the multi-turn evidence conversations (structural in the gate; their *questions* are the judge's replay inputs).
- Category lens: these land in `retrieval_grounded` / `citation_present` / `factually_consistent` (eval/categories.ts) — the fact-check-style categories (`safe_refusal`, `no_phi_in_logs`, calculator/schema checks) have no prose to judge and are OUT of scope.

## Existing seams you MUST reuse (verified)

- `sidecar/src/graph/composer.ts:85 LlmAnswerComposer implements AnswerComposer` (+ `ComposerLlmClient` interface at :19, `ComposerSpend` at :24) — the production composer the judge's answer-production leg drives.
- `sidecar/src/graph/graph.ts:103 buildClinicalGraph(deps)` and the offline retrieval stack used by graph-path.eval.ts (`HashEmbeddings`, `PassthroughReranker`, `HybridRetriever`, `loadCorpusChunks` — its import block) — reuse the eval's own wiring so judged answers come from the same corpus/evidence the cases define; only the composer + judge calls are live.
- Live-call opt-in idiom: `sidecar/eval/prescriptiveness.eval.ts:133` — `process.env['LIVE_EVALS'] === '1' && ANTHROPIC_API_KEY !== ''`; the judge script requires the key and refuses to run without it (clear exit-2 message).
- Script home + idiom: `sidecar/src/scripts/` (residents: `w2-baselines.ts`, `load-test.ts`, `register-oauth.ts` — manual, tsx-run, package.json entries). **Home decision + justification:** `sidecar/src/scripts/judge-scorecard.ts`, NOT `sidecar/eval/judge/` — (1) the eval vitest config includes `eval/**/*.eval.ts` and `tsc -p eval` sweeps `eval/`; a judge under `eval/` is one glob-widening away from riding the gate path, while `src/scripts/` is structurally outside it; (2) `src/scripts/` is already the established home for manual operator scripts none of which the gate imports; (3) the acceptance greps below stay trivially clean.
- Gate-path files the judge must NEVER touch or be imported by: `sidecar/eval/run.ts`, `sidecar/eval/gate.ts`, `sidecar/eval/collector.ts` (`recordEval` throws on failure — the judge must not write EvalRecords at all), `.github/workflows/evals.yml` (job `Run eval suite`) and every other workflow.
- `docs/internal/tickets/USER-ACTIONS.md` item 13 + `docs/internal/user-actions.html` — the parked expert-batch placeholder this ticket fills in (update both together).

## Files to create/modify

- `sidecar/src/scripts/judge-scorecard.ts` — new: answer production (live composer over the case questions) + judging (second model call per answer per dimension) + scorecard rendering + `--sheet` / `--agreement` modes.
- `sidecar/package.json` — `"judge:scorecard": "tsx src/scripts/judge-scorecard.ts"`.
- `docs/execution/judge-scorecard.md` — the generated, committed, human-readable output (regenerated on each manual run; header stamps date + models used).
- `sidecar/src/config.ts` — `ANTHROPIC_MODEL_JUDGE: z.string().min(1).default('claude-haiku-4-5').catch(orWarn('claude-haiku-4-5', 'ANTHROPIC_MODEL_JUDGE'))` (override to a stronger tier for the agreement run if the user wants; producer model stays `ANTHROPIC_MODEL_CHAT`).
- `sidecar/test/judgeScorecard.test.ts` — new (see Tests).
- `docs/internal/tickets/USER-ACTIONS.md` item 13 + `docs/internal/user-actions.html`.

## Step-by-step implementation

1. **Rubric — three dimensions, anti-middle scale.** Forced-choice **1-4** (an even count: no defensible midpoint — the plan's explicit "no wishy-washy middle" requirement; never 1-5/3-of-5):
   - `evidence_adherence`: 1 = contradicts/invents beyond the supplied snippets · 2 = drifts past evidence in places · 3 = sticks to evidence with minor unsupported glue · 4 = every claim traceable to a supplied snippet.
   - `clinical_usefulness`: 1 = useless/wrong for a retina practice · 2 = technically true, not actionable · 3 = useful · 4 = exactly what the physician needed, concise (brevity contract).
   - `scope_discipline`: 1 = prescribes/directs care (violates the never-originate-clinical-direction non-goal) · 2 = edges toward directive language · 3 = in scope · 4 = in scope AND deflects out-of-scope asks correctly.
   Anchor text lives as a const in the script; the scorecard renders it so readers see the scale.
2. **Answer production.** For each in-scope case (table above): rebuild the case's evidence context exactly as its eval file does (copy the wiring, do not import the `.eval.ts` file — importing it would execute `recordEval` calls), run `LlmAnswerComposer` live over the case's question. Enforce an in-script budget: hard cap ~12 judged answers per run, print token totals + estimated cost at the end; abort if `ANTHROPIC_API_KEY` unset.
3. **Judging.** One judge call per answer returning strict JSON (Zod-parse it; one retry-with-errors, mirroring the codebase's validation-retry idiom): `{ scores: { evidence_adherence: 1|2|3|4, clinical_usefulness: 1|2|3|4, scope_discipline: 1|2|3|4 }, one_line_reason: string }`. Judge prompt includes the question, the supplied evidence snippets, the answer, and the anchors — nothing else.
4. **Scorecard output** (`docs/execution/judge-scorecard.md`): run header (date, producer model, judge model, case count, token/cost line) → per-case table (case id · question one-liner · 3 scores · reason) → per-dimension distribution (count of 1s/2s/3s/4s — the anti-middle scale makes bimodality visible) → the agreement section (Step 5, "pending" until the human batch exists). Plus a standing banner: "Informational only. Never consumed by the eval gate, CI, or any merge decision."
5. **Human-expert batch + agreement stat.** `npm run judge:scorecard -- --sheet` emits `docs/execution/judge-scoring-sheet.md`: the same cases/answers with EMPTY score cells + the anchor text — the user hands it to the domain expert (item 13, ~30 min). After the filled sheet is committed back, `npm run judge:scorecard -- --agreement` computes, per dimension and overall: **percent exact agreement** (judge == human) and **percent adjacent agreement** (|judge − human| ≤ 1), rendered into the scorecard's agreement section. Rewrite USER-ACTIONS item 13 with these exact steps (and mirror to user-actions.html).
6. **Prove the separation (the merged plan's verification wording, mirrored):** "running the new scoring script produces its report locally, and running the normal automated gate with or without ever having run the scoring script produces byte-for-byte identical gate output." Concretely — see Acceptance checks.
7. Tests, trackers, ship.

## What NOT to do

- Do NOT import the judge from `eval/run.ts`, `eval/gate.ts`, any `*.eval.ts`, or any workflow — the acceptance greps make this a hard check.
- Do NOT write EvalRecords / touch `eval/.results.jsonl`, `eval/baseline.json`, or `docs/execution/eval-results.md` from the judge — its output file is its own.
- Do NOT use an odd-point scale or add a "borderline" option — the anti-middle forced choice is the design.
- Do NOT judge the gate's scripted outputs (they are stubs — see the verified note above); do NOT let the judge's live answers feed back into eval expectations (CT5 rules: expected-answer edits are re-baselines, never judge-driven).
- Do NOT auto-run it anywhere (no cron, no workflow, no pre-push) — manual `npm run judge:scorecard` only.
- Do NOT exceed the in-script call budget or touch `LLM_DAILY_BUDGET_USD` (locked #16); if the budget guard trips, stop and tell the user.
- Do NOT put patient-identifying or document text into the scorecard beyond the evidence snippets the eval corpus already commits (the corpus is synthetic + repo-public — quoting it is fine; that is the G18-compatible line).

## Acceptance checks

```bash
cd sidecar && npm run eval
npm run eval:gate > /tmp/gate-before.txt
ANTHROPIC_API_KEY=<real key> npm run judge:scorecard
npm run eval:gate > /tmp/gate-after.txt
diff /tmp/gate-before.txt /tmp/gate-after.txt && echo GATE_BYTE_IDENTICAL
git diff --exit-code eval/ ../docs/execution/eval-results.md && echo GATE_INPUTS_UNTOUCHED
grep -rn "judge-scorecard\|judgeScorecard\|scripts/judge" eval/ ../.github/workflows/ ; test $? -eq 1 && echo NO_GATE_COUPLING
```

All three echoes print. `docs/execution/judge-scorecard.md` exists, renders
the per-case table + distributions + the informational-only banner. After the
item-13 batch: the agreement section shows percent-exact and
percent-adjacent per dimension.

## Tests to add

`sidecar/test/judgeScorecard.test.ts` (pure logic only — no live calls, G17):

- `it('parses a valid judge JSON and rejects out-of-range or midpoint-ish scores')` — 0, 5, 2.5, missing dimension all rejected by the Zod schema.
- `it('renders a scorecard containing the informational-only banner and per-dimension distributions')` — canned scores in, markdown out, banner asserted.
- `it('computes exact and adjacent agreement correctly')` — canned judge/human pairs: e.g. pairs (4,4),(3,2),(1,4) → exact 1/3, adjacent 2/3.
- `it('never writes to the eval ledger paths')` — the module exports its output path(s); assert none resolve under `eval/`.

## Tracker updates

- `docs/internal/build-status.html` DATA block: ticket `CT7` (T2 section) → `s: "done"` (append "agreement batch pending" to the row text if item 13 is still outstanding).
- `docs/w2/requirements.md` — no checkbox; do not invent one (D4's judge-configuration line is already satisfied by the committed gate config — do not retrofit CT7 into it).
- `W2_ARCHITECTURE.md` §7 (Eval gate) — one sentence noting the informational judge exists and is not part of the gate; keep it to a sentence.
- `docs/internal/tickets/USER-ACTIONS.md` item 13 + `docs/internal/user-actions.html` (same commit).

## Verify + ship ritual

```bash
cd sidecar && npm test && npm run typecheck && npm run eval && npm run build
```

Panel untouched — skip the panel leg. Then: conventional commit
(`feat(ct7): informational-only llm-judge scorecard (never gate-coupled)`)
with `--trailer "Assisted-by: Claude Code"` (trackers in the SAME commit) →
`git push -u origin claude/merged-eval-course-plan-ky6ulh` → update the
PR #16 body → SendUserFile `docs/internal/build-status.html`.
