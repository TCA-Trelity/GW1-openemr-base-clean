# H.15 — Measure supervisor routing latency vs the ~200–400 ms target

REQ: S3/R4 (supervisor-as-entry box), G11, G2 · Depends on: F.1 (shipped — `npm run baseline:w2` exists) · Band: merged-plan Track 1 · Priority: P2 (per merged-plan.md)

## Why

Locked decision #4 states the router budget: a routing decision *"in ~200–400
ms"* (register S3/R4 box wording), and §9's SLO row caps it at *"≤ 0.4 s
router"*. F.1 measured the deterministic rules path (µs-scale) and honestly
left the model tie-break as *"the 200–400 ms figure stays a stated target
until measured"* (`docs/execution/baselines.md:81`). The S3/R4 box's own
annotation says it flips when the router baseline is measured. This ticket
finishes that: measure the decision mix (how often a turn even pays the model
call) deterministically, and the live Haiku tie-break p50/p95 via an opt-in
leg of the existing baselines script.

## Existing seams you MUST reuse

- `src/scripts/w2-baselines.ts` — the script to EXTEND (F.1's tool; ethos in its header: measures, never fabricates; names its backends). It already times the rules path: `routeAsk({ kind: 'chat_turn', question: … }, undefined, id)` loop → row `router — deterministic rules path` + `json['router_rules_path']` (:158-166). Env-knob style: `W2_BASE_RUNS`/`SCALE`. Run: `npm run baseline:w2`.
- `src/graph/router.ts:44` — `export async function routeAsk(input: RouteInput, model: RouterModel | undefined, correlationId: string): Promise<RoutingDecision>`; `RoutingDecision = { route: 'fast_path'|'needs_evidence'|'needs_extraction'; reason: string; decided_by: 'rule' | 'model' }`; `EVIDENCE_PATTERNS` (:23-30) and `FAST_PATTERNS` (:33-37) define what the rules catch — ambiguous questions are the ones falling through to the model.
- `src/graph/routerModel.ts:34` — `class LlmRouterModel implements RouterModel { constructor(client: RouterLlmClient, logger?); decide(question, correlationId): Promise<Route> }` — never-throws, defaults `fast_path`.
- `src/server.ts:520-529` — the production construction to REPLICATE exactly in the live leg: `new LlmRouterModel(new AnthropicClient({ apiKey, model: config.ANTHROPIC_MODEL_CHAT, maxTokens: 16, idleTimeoutMs: 3_000, totalTimeoutMs: 5_000 }), graphLogBase)` (model default `claude-haiku-4-5`, `src/config.ts`; H.3 routed its logger through the structured graph logger — mirror the current call site, not this spec, if it drifts again).
- `docs/execution/baselines.md` — extend the `## Week 2 flows` section (:50+) and the SLO-verdicts table (the Router row at :81); update `## Reproducing (Week 2)` (:98) with the new command.
- `W2_ARCHITECTURE.md` §9 SLO table row 4 — `Fast-path chat first token | < 2 s (+ ≤ 0.4 s router) | router rules path µs-scale; model tie-break measured post-keys | …` — the measured cell to update.
- Register wording being satisfied (S3/R4, ~:221): *"…then a small fast-model call — emitting `fast_path | needs_evidence | needs_extraction` in ~200–400 ms"*.
- Environment reality (merged-plan header note): this sandbox's egress to api.anthropic.com is not assumed — the live leg must be opt-in, skip-with-reason, and runnable from the user's laptop (keys exist there per USER-ACTIONS) or a keyed CI job.

## Files to create/modify

- **Modify** `sidecar/src/scripts/w2-baselines.ts` — decision-mix stats + opt-in live tie-break timing.
- **Modify** `docs/execution/baselines.md` — new rows + updated Router SLO verdict + Reproducing command.
- **Modify** `W2_ARCHITECTURE.md` — §9 measured cell (+ §4 header TARGET).
- Trackers: `docs/w2/requirements.md`, `docs/internal/build-status.html`.
- No new files; no test files (measurement script — F.1 precedent; `npm run typecheck` covers it since it lives under `src/`).

## Step-by-step implementation

1. **Question set** (in the script, committed): ~20 fixed questions in three labeled groups — guideline-shaped (hit `EVIDENCE_PATTERNS`), record-shaped (hit `FAST_PATTERNS`), and genuinely ambiguous (hand-check each against the two pattern lists: it must match NEITHER, e.g. "Is her current dose still appropriate given the new labs?"). Assert in-script that every "ambiguous" question actually falls through (run `routeAsk` with `model: undefined` and check `reason` is the safe-default one) — a pattern edit later must not silently hollow out the live sample.
2. **Decision-mix leg** (always runs, deterministic): route all questions with `model: undefined`; report `% decided_by rules` per group + overall, as a table row + `json['router_decision_mix']`. This is the honest context for the SLO: most turns never pay the model call at all.
3. **Live tie-break leg** (opt-in): gate on `process.env['ANTHROPIC_API_KEY'] !== undefined && process.env['W2_BASE_ROUTER_LIVE'] === '1'`; when off, print exactly why it was skipped and the command to run it. When on: construct the client + `LlmRouterModel` exactly as server.ts does (step seams; model from `ANTHROPIC_MODEL_CHAT` env ?? `claude-haiku-4-5`); time `routeAsk(ambiguousQuestion, model, id)` end-to-end (so the measured number includes the rules pass, matching what a real turn pays) for each ambiguous question, 2 rounds (~20–40 tiny 16-token Haiku calls — cost is a fraction of a cent; the script prints the call count; the ledger/SpendGuard is not in this script's path, so keep N small and say so in the output). Report p50/p95/p99/max + `json['router_model_tiebreak']`, and print the verdict line against the 200–400 ms target + the 0.4 s SLO cap. Also report how many decisions returned `decided_by: 'model'` (a failure-degraded `fast_path` from `LlmRouterModel`'s catch is still a timing sample but flag if any call errored).
4. **baselines.md**: under Week 2 flows add the two rows (decision mix; model tie-break p50/p95 — with backend legend `live Haiku, maxTokens 16, 3 s idle / 5 s total caps`); rewrite the Router SLO-verdict row (:81) from "stays a stated target until measured" to the measured verdict; add to Reproducing: `W2_BASE_ROUTER_LIVE=1 ANTHROPIC_API_KEY=sk-… npm run baseline:w2` (fully filled-in besides the secret — no `<placeholders>`, per standing rule 9's spirit the secret name itself is the instruction).
5. **Where the live numbers come from**: run the live leg yourself if the environment reaches api.anthropic.com with a key; otherwise ship the script + decision mix, record the exact command in baselines.md, and post the one-liner for the user to run from their laptop (their clone + keys exist — USER-ACTIONS item 0/5 flow); fold their pasted output into the docs in the same PR if it arrives before shipping, else follow the tracker's annotate-then-flip guidance below.
6. **§9 cell**: `router rules path µs-scale; model tie-break measured post-keys` → the measured figure (e.g. `rules µs-scale (>X% of turns); tie-break p95 ≈ N ms live Haiku`), or the honest pending form if step 5 ran laptop-relayed and numbers are not yet in hand.
7. Trackers, ship.

## What NOT to do

- Do NOT fabricate, extrapolate, or "estimate" the model-path number — a stub-timed model call measures the stub (F.1's ethos; the current docs already refuse this, keep refusing).
- Do NOT make the live leg a CI job or gate — dev-machine profiling tool (F.1 rule), and CI has no Anthropic secret by design (G17).
- Do NOT measure `LlmRouterModel.decide` in isolation only — time `routeAsk` end-to-end so the number is what a turn actually pays.
- Do NOT touch `eval/baseline.json` — latency baseline ≠ eval baseline (F.1's warning, still true).
- Do NOT raise `maxTokens`/timeouts to make numbers look better — measure the production construction verbatim.
- Do NOT hard-code today's date or numbers in this spec's wording into the docs — record what the run actually prints.

## Acceptance checks

```bash
cd sidecar && npm run baseline:w2
# → prints the existing three flows + "router decision mix" row + either the live
#   tie-break p50/p95 row or a one-line skip reason naming W2_BASE_ROUTER_LIVE.
cd sidecar && W2_BASE_ROUTER_LIVE=1 npm run baseline:w2   # keyless → skips WITH reason, exits 0
cd sidecar && npm run typecheck
git diff docs/execution/baselines.md W2_ARCHITECTURE.md    # rows + verdict + §9 cell updated
```

With a key (laptop or permitted env): the live row prints and the verdict line
compares p95 against 400 ms.

## Tests to add

None (measurement script — F.1 precedent). The in-script assertion that every
"ambiguous" fixture question genuinely bypasses both rule lists is the
self-check; `npm run typecheck` covers compilation.

## Tracker updates

- `docs/w2/requirements.md` — under **S3/R4** (~:221), the box (verbatim lines):

  ```
  - [ ] Supervisor-as-entry routing (locked decision): every chat turn passes a
    routing decision — deterministic short-circuits first, then a small
    fast-model call — emitting `fast_path | needs_evidence | needs_extraction`
    in ~200–400 ms; `fast_path` delegates to the unchanged Week 1 chat loop;
    document upload events enter the graph directly (Tier 2, prep-time).
    *(Shipped: rules + `LlmRouterModel` tie-break, never-throw, fast_path-safe
    defaults, tested — and the chat delegation wiring (E.9): needs_evidence
    turns run the graph and stream status→cited answer; everything else takes
    the untouched Week 1 loop. Box flips when F.1 measures the ~200–400 ms
    router baseline.)*
  ```

  Flip to `[x]` when the live tie-break p50/p95 is recorded in baselines.md and within ~the stated budget; update the annotation to name the measured numbers + `npm run baseline:w2` provenance. If the live leg is still pending a laptop run at ship time, do NOT flip — update the annotation to `*(…rules path µs + decision mix measured (H.15); model-path p50/p95 pending the one-command live run recorded in baselines.md §Reproducing.)*` and flip in the PR that lands the numbers.
- `docs/internal/build-status.html` DATA block: ticket `H.15` (L458) `s: "pending"` → `"done"`; reqGroups: `S3/R4` row `done` +1 only when the box flips (mirror the register, not the aspiration).
- `W2_ARCHITECTURE.md` — §9 SLO table router cell (step 6); §4 header: drop `routing-latency baseline (F.1)` from TARGET once measured (name H.15).

## Verify + ship ritual

```bash
cd sidecar && npm test && npm run typecheck && npm run eval && npm run build
```

Panel untouched — skip the panel leg. Then: conventional commit with
`--trailer "Assisted-by: Claude Code"` (trackers in the SAME commit) →
`git push -u origin claude/merged-eval-course-plan-ky6ulh` → update PR #16
body (checklist line for H.15) → SendUserFile
`docs/internal/build-status.html` (rendered inline).
