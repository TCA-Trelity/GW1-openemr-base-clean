# F.2 — Cost & latency report (D7): ledger-backed spend, unit costs, bottlenecks

REQ: D7, R7 (cost-ledger acceptance) · Depends on: F.1 (measured p50/p95) · Band: 3

## Why

D7: "actual dev spend, projected production cost, p50/p95 latency, bottleneck
analysis" — every number traceable to the `llm_calls` ledger or the F.1
baselines, never invented. For Dan this is the "what does this cost my
practice per day" answer; for graders it is the W1-vs-W2 comparison in one
document.

## Existing seams you MUST reuse

- `docs/COSTS.md` — **read it first**; extend, don't rewrite. Its section set: `## 1. Measured actuals …`, `## 2. Unit economics per patient-visit`, `## 3. Cost controls already enforced in code`, `## 4. Projections by daily patient-visits`, `## 5. Dev-phase spend`. Its style: pipe tables, bold key dollars, `≈`/`~` for estimates, em-dash ranges, and a derivation line up top naming model + pinned rates ("$1 input / $5 output per MTok", Haiku 4.5).
- `src/prep/budget.ts:priceCall(call: LlmCallUsage, rates: LlmRates): number` (:25) — `(inputTokens * inputUsdPerMtok + outputTokens * outputUsdPerMtok) / 1_000_000`; rate defaults in `config.ts`: `LLM_INPUT_USD_PER_MTOK=1`, `LLM_OUTPUT_USD_PER_MTOK=5`.
- `src/ingest/extractor.ts:ExtractOutcome` (:72-77) — `usage: { input_tokens: number; output_tokens: number; model: string }[]` (1 entry, 2 when the validation-feedback retry fired) — the per-document token source. Get real token counts by running one live extraction if a key is available, else from the stub's recorded fixture sizes + a stated tokens-per-page estimate labeled as such.
- The ledger: `llm_calls` table (`SELECT purpose, COUNT(*), SUM(input_tokens), SUM(output_tokens), SUM(est_cost_usd) FROM llm_calls GROUP BY purpose`) and `GET /api/usage` (`UsageSummary`: `{ window: '24h', calls, input_tokens, output_tokens, est_cost_usd, budget_usd, remaining_usd }`).
- `docs/execution/baselines.md` — F.1's W2 tables (source for every latency figure; cite the section, don't restate raw runs).
- `W2_ARCHITECTURE.md` §8 cost bullet — the projections to reconcile against: "extraction ~$0.03–0.10/doc, corpus embedding ~one-time, rerank ~$0.002/query → ~$20–25 per 70-patient day vs Week 1's ~$20". §9 — the SLO targets the latency section compares against.

## Files to create/modify

- **Modify** `docs/COSTS.md` only. New top-level section `## 6. Week 2 — multimodal agent costs & latency (D7)` with the five subsections below (or fold into §1–§5 if that reads better against the existing structure — keep ONE approach, cross-linked from the README deliverables table by F.3/README ticket).

## Step-by-step implementation

1. **Per-document extraction cost model.** Table: doc type × (input tokens,
   output tokens, calls incl. retry rate, est. cost via `priceCall` at the
   pinned $1/$5 rates). Source tokens from `ExtractOutcome.usage`: if
   `ANTHROPIC_API_KEY` is available locally, run one live extraction per
   fixture and use real counts (each such call also lands in the ledger —
   note it in §5/dev-spend); if keyless, compute from fixture byte/page sizes
   with the estimation method stated inline and labeled **estimate**. Include
   the retry column (a feedback retry doubles the cost of that document —
   worst case 2×).
2. **Per-query retrieval pricing.** Embed (query-time, 1 call) + rerank
   (1 call over ≤ fused-candidate count). **Cite Cohere's live pricing/tier
   page at write time** (do not trust memory; check
   https://cohere.com/pricing and the rate-limits doc): state trial/free-tier
   monthly + per-minute caps and the paid per-1K-unit prices, with the quoted
   date. Then the demo-realistic statement: at demo volume the free tier
   covers it; show the paid-tier math per 1K evidence asks anyway.
3. **Projected monthly for Dan's practice.** State assumptions EXPLICITLY,
   then multiply: `N docs/day` (suggest 10–20 outside labs/intakes for a
   70-patient clinic day — label as assumption), `M evidence asks/day`
   (suggest 20–40), 22 clinic days/month. Rows: extraction, evidence
   composition (E.9's ~1.5K-output calls), router tie-breaks, rerank/embed,
   Week 1 baseline load. Reconcile the total against §8's "~$20–25 per
   70-patient day" claim — if the numbers disagree, **fix §8 in the same
   commit** (anti-drift), don't fudge the report.
4. **Measured p50/p95 vs SLOs.** Small table citing F.1's baselines.md
   section: ingestion / retrieval / evidence turn / fast-path / W1 read
   path, target vs measured, with F.1's backend-honesty labels carried over
   (stub VLM, passthrough rerank, live-after-keys).
5. **Bottleneck analysis.** Name it plainly: the VLM extraction call
   dominates ingestion end-to-end (tens of seconds live vs ms for parsing);
   geometric grounding is ms-scale CPU; retrieval is fusion-cheap and
   rerank-bound (one network call); the evidence turn is composer-bound
   (~1–3 s LLM) with retrieval well inside budget. One paragraph each,
   numbers from F.1.
6. **Dev-spend-to-date, ledger-backed.** Run the ledger query (or
   `GET /api/usage` on the deployed service). **Zero live W2 spend so far —
   state exactly that** (all W2 eval/CI runs are keyless by design, G17),
   plus whatever Week 1 actuals §1/§5 already record; do not double-count
   them. If step 1 made live calls, show them itemized by `purpose`.
7. Trackers, ship.

## What NOT to do

- Do NOT invent Cohere prices or tier caps from memory — quote the live page
  with a date, or mark the cell "verify at key-drop".
- Do NOT present estimates as measurements — every estimated cell is labeled,
  every measured cell traces to the ledger or baselines.md.
- Do NOT touch `LLM_DAILY_BUDGET_USD` or SpendGuard while writing this — the
  $5/day cap is a finding to report, not a knob to tune (standing rule 3).
- Do NOT restate baseline tables wholesale — cite baselines.md and summarize.
- Do NOT let §8's projections and this report disagree silently.

## Acceptance checks

```bash
git diff docs/COSTS.md   # new W2 section: 5 subsections, assumptions labeled,
                         # Cohere citation dated, dev-spend statement present
# Ledger trace: the dev-spend numbers match
#   psql "$DATABASE_URL" -c "SELECT purpose, COUNT(*), SUM(est_cost_usd) FROM llm_calls GROUP BY purpose;"
# (or GET /api/usage on the deployed service for the 24h window)
```

Cross-check: §8 cost bullet and COSTS.md agree; F.1's baselines are cited not
duplicated.

## Tests to add

None — a report. (The eval gate still runs in the ship ritual; a docs-only
commit must not skip it, per standing rule 1.)

## Tracker updates

- `docs/w2/requirements.md` — **D7 is a table row, not a checkbox** (section 3, Deliverables): no checkbox to flip; verify the D7 acceptance text matches what shipped (COSTS.md extension chosen over a separate report file — annotate the row if needed). Under **R7**, the cost-ledger box `- [ ] Cost ledger extended: extraction and Cohere calls priced into llm_calls…` — flip only if E.9's `evidence_composition` recording plus this report satisfy it; Cohere calls are not ledger-priced until a Cohere pricing line exists — annotate honestly if partial.
- `docs/w2/build-status.html` — DATA (starts L189): `{ id: "F.2", … s: "pending" }` → `s: "done"`; bump the Deliverables reqGroup (D7) count.
- `W2_ARCHITECTURE.md` — §8: append "(D7 report: docs/COSTS.md §6)" to the cost-tracking bullet; reconcile the projection numbers if step 3 moved them.

## Verify + ship ritual

```bash
cd sidecar && npm test && npm run typecheck && npm run eval && npm run build
```

Panel untouched — skip the panel leg. Then: conventional commit with
`--trailer "Assisted-by: Claude Code"` (trackers in the SAME commit) →
`git push -u origin claude/openemr-rag-requirements-x25vzm` → update PR #9
body → SendUserFile `docs/w2/build-status.html`.
