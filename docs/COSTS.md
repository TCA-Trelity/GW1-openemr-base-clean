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
