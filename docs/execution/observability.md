# Observability — dashboard & alerts (S2.6 / G1)

*The AgentForge engineering requirements demand a real-time dashboard and at
least three alerts with documented on-call response. This document is the
spec: it maps every dashboard tile and alert to signals the sidecar **already
emits** (Langfuse traces keyed by correlation ID + the `llm_calls` Postgres
ledger), so the dashboard is a view over live data, not new instrumentation.*

## What the sidecar emits (source signals)

| Signal | Where | Emitted by |
|---|---|---|
| One **trace** per prep run, id = correlation ID | Langfuse | `obs/langfuse.ts` `startTrace` |
| One **span** per pipeline stage (`load_sources`, `llm_extraction`, `citation_gate`, `medication_risk`, `imaging_analytics`, `brief_assembly`, `save_brief`) with duration | Langfuse | pipeline `runStage` |
| One **generation** per Anthropic call (per document + contradiction pass + chat turn) with model + input/output tokens | Langfuse | extraction / chat `onUsage` |
| Outcome **scores**: `run_success` (1/0), `citations_failed`, `facts_blocked` | Langfuse | trace `end` |
| Per-call **cost ledger**: `{correlation_id, purpose, model, input_tokens, output_tokens, est_cost_usd, created_at}` | Postgres `llm_calls` | `SpendGuard.recordCall` |
| Structured request logs (method, path, status, duration, correlation ID) | pino → Railway | Fastify `onSend` + `genReqId` |
| Prep-run stage/error rows | Postgres `prep_runs` | pipeline `setPrepRunStage` / `finishPrepRun` |

Correlation ID is the join key across all of them — the requirement "reconstruct
a full trace from logs alone" is satisfied by filtering any store on that ID.

## Dashboard tiles (the required minimum + agent-specific)

| Tile | Metric | Source | Answers the PDF's… |
|---|---|---|---|
| Requests | count over time, by route | request logs | "total requests" |
| Error rate | 5xx / total, by route | request logs | "error rate" |
| Latency | p50 / p95 per surface (overview, chat first-token, prep) | spans + request logs | "p50/p95 latency" |
| LLM calls | generations/min by `purpose` (prep_extraction, chat_turn) | Langfuse generations | "tool call counts" |
| Retries | transient-retry + validation-retry count | generation metadata | "retry counts" |
| **Verification pass/fail** | `citations_failed` = 0 rate; `facts_blocked` distribution | outcome scores | "verification pass/fail rate" |
| Token spend | `est_cost_usd` sum, 24h rolling, vs $5 budget | `llm_calls` | "tokens consumed and cost" |
| Run outcomes | `run_success` rate; failed-run stage histogram | scores + `prep_runs` | agent-specific |

## Alerts (≥3 required — thresholds + on-call response)

| # | Alert | Condition | On-call response |
|---|---|---|---|
| A1 | **p95 latency breach** | chat first-token p95 > 4 s **or** prep p95 > 4 min, sustained 5 min | Check Langfuse spans for the slow stage. `llm_extraction` slow → Anthropic latency (check status page) or a large corpus; `load_sources` slow → Postgres. If Anthropic-side, the 90 s idle-timeout already caps a single hung call; no action beyond noting. If Postgres, check connection pool + `/ready`. |
| A2 | **Error-rate breach** | 5xx rate > 5% over 10 min | Pull the correlation IDs of the failing requests; group by route. Store-configured 503s → `DATABASE_URL`/pool. Prep failures → `GET /api/prep-runs/:patientId` for the stage + error; a schema/extraction fault is a code fix, an Anthropic 5xx is transient (auto-retried once). Page only if sustained past one deploy. |
| A3 | **Tool / verification failure** | any prep run with `citations_failed > 0`, **or** chat `unverified_count > 0` rate > 1%, **or** tool-call error rate > 10% (Wave TC) | This is the clinical-safety alert: a claim reached (or nearly reached) a physician without resolving provenance. Inspect the trace; confirm the gate blocked it (it should have — unverified claims are dropped, not shown). A rising rate means extraction quality drift → add the failing case to the eval corpus (the flagged-output→fixture loop, S3.4) and re-tune the prompt. |

## Status

- **Emit side: live.** Traces + ledger + logs are produced now (Langfuse tracer engages when `LANGFUSE_HOST` + keys are set; the ledger + logs are always on).
- **Dashboard + alerts: pending Langfuse deploy (G2).** The Langfuse service deploys on Railway; the three variables (`LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`) go on the sidecar; the tiles above are built from the emitted traces and the alerts configured to these thresholds. Until then, the same signals are queryable directly: `GET /api/usage` (spend), `GET /api/prep-runs/:patientId` (run status/stage/error), and Railway logs (requests, by correlation ID).
