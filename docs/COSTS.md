# Costs — Clinical Co-Pilot

*Derived 2026-07-08. All LLM calls run on Haiku 4.5 (`claude-haiku-4-5`) at the
ledger's pinned rates of **$1 input / $5 output per MTok**
(`sidecar/src/config.ts`; model choice logged in `docs/execution/DECISIONS.md`).
Live actuals accrue in the **`llm_calls` Postgres ledger** — every Anthropic
call is priced at insert time (`sidecar/src/prep/budget.ts`) — and are readable
at **`GET /api/usage`** (trailing-24h totals vs. the $5/day budget). The numbers
below refresh from that ledger: this file is the narrative, the ledger is the
record.*

## 1. Measured actuals (2026-07-08 — early numbers, one live day)

| Item | Tokens (in / out) | Cost | Notes |
|---|---|---|---|
| 2 failed Sonnet 5 mega-call attempts | 28,228 / 128,000 | **$2.00** | Whole-corpus extraction, both truncated at the output cap; priced at the then-pinned Sonnet rates ($3/$15 per MTok). Postmortem in `DECISIONS.md` drove the per-document Haiku redesign |
| Per-document Haiku prep (expected) | ~30–40K / ~15–25K per prep | **~$0.10–0.16 / prep** | ~14 calls per prep: 12 documents + 1 contradiction pass + occasional retry. Derived from pipeline structure, not yet a large live sample |
| Chat turn | ~3–6K / ≤1K | **< $0.01 / turn** | The 1,024-token output ceiling caps the worst case |

The $2.00 line is the entire measurable spend of the abandoned mega-call
design; the Haiku rows are the expected steady state.

## 2. Unit economics per patient-visit

| Component | Est. cost |
|---|---|
| 1 prep (the 10-minute reuse window prevents double-pay on panel re-opens) | $0.10–0.16 |
| ~5–10 chat turns | $0.05–0.10 |
| **Total per visit (today)** | **≈ $0.15–0.25** |

## 3. Cost controls already enforced in code

Sources: `sidecar/src/routes/prep.ts`, `sidecar/src/prep/budget.ts`,
`sidecar/src/config.ts`.

| Control | Mechanism | Effect |
|---|---|---|
| Daily budget $5 (`LLM_DAILY_BUDGET_USD`) | `SpendGuard.assertBudget()` sums the trailing-24h ledger before any call | `429 llm_budget_exceeded`; re-checked inside the pipeline for in-flight runs |
| Per-call output ceilings | 8,192 tokens prep / 1,024 chat | Hard cap on worst-case cost per call |
| Brief reuse window (10 min) | A fresh-enough brief answers `POST /api/prep` with zero LLM spend | No double-pay; `?force=true` for an explicit re-prep |
| In-flight dedupe | One running prep per patient per process | `202 already_running` instead of a duplicate run |
| Concurrency cap (2) | Cross-patient in-flight cap per process | `429 too_many_preps` |
| Truncation never feedback-retried | One fresh retry, then the call fails with a clear error | A structural cap hit can't double the burn |
| Ledger on every call | One `llm_calls` row per call, priced at insert time | Spend is always reconstructable; feeds `GET /api/usage` |

## 4. Projections by daily patient-visits

LLM spend scales linearly with visits: `visits/day × $0.15–0.25/visit × ~30 days`.
Architecture stages mirror `ARCHITECTURE.md` §11. **All figures below are
estimates** — round numbers, not quotes.

| Visits/day | LLM $/day | LLM $/mo (est.) | Architecture stage (§11) | Infra $/mo (rough est.) |
|---|---|---|---|---|
| 100 | $15–25 | ~$450–750 | Single Railway instance (app + Postgres), as built today | ~$20–50 |
| 1,000 | $150–250 | ~$4.5K–7.5K | Service replicas behind a load balancer + BullMQ/Redis prep queue | ~$100–300 |
| 10,000 | $1.5K–2.5K | ~$45K–75K | Dedicated Postgres + read replicas; object storage for scan imagery | ~$1K–3K |
| 100,000 | $15K–25K | ~$450K–750K | Multi-region, per-tenant isolation | ~$10K–30K |

At every tier the model bill dominates the hosting bill, so the levers that
matter are on LLM spend:

| Future lever (not yet implemented) | Realistic savings (est.) | Why |
|---|---|---|
| Prompt caching | ~10–30% of LLM spend | Cache reads cost ~0.1× the input rate on repeated prefixes — the shared extraction prompt across ~14 calls/prep, the brief context across chat turns. Requires a ≥4,096-token shared prefix on Haiku 4.5 |
| Batch API for morning preps | ~30–50% of prep spend | 50% token discount for asynchronous processing; preps precompute overnight, so only same-day additions need the live path |

Applied together these plausibly land at ~$0.10–0.15/visit — unverified until
measured against the ledger.

## 5. Dev-phase spend

Demo-phase Anthropic spend is hard-bounded by the $5/day guard: worst case
~$155/month even if every day saturates the budget. This document and
`GET /api/usage` are estimates computed from the ledger's pinned rates — the
**Anthropic console is the authoritative invoice view**.

## 6. Week 2 — multimodal agent costs & latency (D7)

*Added 2026-07-13. Model legs run Haiku 4.5 at the same pinned $1/$5 per-MTok
ledger rates. **Zero live Week 2 LLM spend has accrued** — every W2 eval, CI
run, and baseline in this branch is keyless by design (G17: scripted
VLM/composer stubs, offline retrieval backends), so the `llm_calls` ledger
carries only the Week 1 actuals in §1. Live W2 calls begin at the key drop
(`docs/w2/tickets/USER-ACTIONS.md`) and will land in the same ledger under
purposes `evidence_composition` (wired in `src/graph/composer.ts`) and the
extraction purpose.*

### 6.1 Per-document extraction cost model (estimates — no live calls yet)

Method, stated: input = the PDF document block + the ~0.7K-token schema
instruction; a 1-page text-layer PDF ≈ 2–4K document tokens (image-block
scans run higher per page); output = the extraction JSON (the committed
renal-panel extraction serializes to ≈ 350–800 tokens). Priced via
`priceCall` at $1/$5 per MTok. A validation-feedback retry doubles that
document's cost (worst case 2×; the eval-measured retry path fires only on
malformed first output).

| Doc | Est. input | Est. output | Est. cost | With retry (2×) |
|---|---|---|---|---|
| 1-page text-layer lab PDF | ~3–5K | ~0.4–0.8K | **~$0.005–0.01** | ~$0.01–0.02 |
| 1-page image-only scan | ~2–4K (image tokens) | ~0.4–0.8K | **~$0.005–0.01** | ~$0.01–0.02 |
| Multi-page scanned packet (3–5 pp) | ~8–20K | ~1–2K | **~$0.02–0.03** | ~$0.04–0.06 |

*(All cells are labeled estimates until one live extraction per fixture runs
at the key drop; those calls will appear itemized in the ledger.)*

### 6.2 Per-query retrieval pricing (Cohere) — verify at key-drop

Query-time cost = 1 embed call (the query only; the 71-chunk corpus embeds
once at boot) + 1 rerank call over ≤12 fused candidates. **Cohere's pricing
and trial-tier pages were unreachable from this build sandbox (HTTP 403 via
the egress proxy), so per-unit prices are deliberately NOT quoted from
memory** — the cells below are filled at key-drop from
https://cohere.com/pricing / docs.cohere.com/docs/rate-limits:

| Item | Per unit | Demo-volume verdict |
|---|---|---|
| Embed (query-time) | *verify at key-drop* | Trial tier expected to cover demo volume (tens of asks/day) |
| Rerank | *verify at key-drop* | Same; the PassthroughReranker fallback serves fused order at $0 if capped |

Offline posture (today, and the permanent fallback): HashEmbeddings +
PassthroughReranker cost **$0.00** and hold the measured 0.78 ms p95.

### 6.3 Projected monthly for Dan's practice (assumptions labeled)

Assumptions: a 70-patient clinic day; **15 outside docs/day** ingested;
**30 evidence asks/day**; **22 clinic days/month**; Haiku rates as pinned.

| Line | Per day | Per month |
|---|---|---|
| Week 1 baseline (prep + chat, §2: $0.15–0.25/visit × 70) | $10.50–17.50 | $231–385 |
| W2 extraction (15 docs × ~$0.005–0.03) | $0.08–0.45 | $1.65–9.90 |
| W2 evidence composition (30 × ~$0.002–0.01; ≤1.5K output cap) | $0.06–0.30 | $1.32–6.60 |
| W2 router tie-breaks (subset of asks; 16-token output) | < $0.01 | < $0.25 |
| Cohere embed+rerank | verify at key-drop | trial tier expected $0 at this volume |
| **Total** | **≈ $10.65–18.30** | **≈ $234–402** |

**Reconciliation:** the Week 2 additions cost **well under $1/day** at Dan's
volumes — the multimodal agent rides almost free on the Week 1 budget, and
the $5/day SpendGuard comfortably covers a demo day (a full 70-visit
production day would need the cap raised, a deliberate go-live decision, not
a default). `W2_ARCHITECTURE.md` §8's earlier "~$20–25 per 70-patient day"
was conservative; it is reconciled to this table in the same commit.

### 6.4 Measured p50/p95 vs SLOs

Source: `docs/execution/baselines.md` §Week 2 (backend-honesty labels carried
verbatim; targets from `W2_ARCHITECTURE.md` §9).

| Flow | Target p95 | Measured | Backend caveat |
|---|---|---|---|
| Ingestion | ≤ 90 s/doc | 32.7 ms | stub VLM — live call will dominate |
| Retrieval | ≤ 2.5 s | 0.78 ms | Passthrough rerank — Cohere adds round trips |
| Evidence turn | ≤ 5 s | 9.5 ms mechanics | composer (live Haiku) owns the budget |
| Router | ≤ 0.4 s | µs (rules path) | model tie-break measured post-keys |
| W1 read path | 46/193 ms floor | byte-identical (git) | re-measure on deploy |

### 6.5 Bottleneck analysis

**Ingestion is VLM-bound.** The live extraction call will run seconds-to-tens
of seconds; everything deterministic around it — strict parse, pdf.js word
geometry, grounding, persistence — measured 32.7 ms p95 combined. The 90 s/doc
budget is therefore effectively a one-call budget, which is why it lives in
the prep-time gap, never a chat turn.

**Retrieval is rerank-bound.** Fusion over 71 chunks is sub-millisecond;
the only meaningful latency is the Cohere network call, and its failure mode
is a $0, 0.78 ms fallback that keeps serving fused order (`/ready` shows the
degradation).

**The evidence turn is composer-bound.** Graph mechanics (router, retrieval,
critic gate) measured 9.5 ms p95 — the ≤5 s budget is effectively all Haiku
composition, bounded by maxTokens 1500 and a 20 s hard timeout, and the
turn degrades honestly if either trips.

### 6.6 Dev-spend to date (ledger-backed)

Week 1 actuals: §1 (the $2.00 mega-call postmortem plus expected Haiku steady
state). **Week 2: $0.00 live LLM spend** — by design, not omission: the 58-case
eval gate, the rehearsal, CI, and the F.1 baselines all run scripted stubs.
The first W2 ledger rows will be the key-drop verification calls
(USER-ACTIONS.md), reconstructable via
`SELECT purpose, COUNT(*), SUM(est_cost_usd) FROM llm_calls GROUP BY purpose;`
or `GET /api/usage`.
