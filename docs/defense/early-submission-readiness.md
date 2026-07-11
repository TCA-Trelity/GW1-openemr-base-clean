# Early Submission — Readiness

*Requirement-by-requirement trace of the Week 1 AgentForge case study against this
repository, as of 2026-07-09. Live EHR:
`https://gw1-openemr-base-clean-production.up.railway.app` · Live agent (sidecar + panel):
`https://enchanting-mercy-production-5d32.up.railway.app` · Everything cited below is on
`main`.*

## Requirements trace

**MVP gates (submitted Tier 0, all standing)**

| Requirement | How it is fulfilled |
|---|---|
| Run locally, setup documented | Docker dev environment + setup in `README.md` / `CONTRIBUTING.md`; demo dataset loads via `DEMO_MODE=standard`. |
| Public deployment, URL in every submission | Railway project: OpenEMR + MariaDB (private networking) and the sidecar (Node/Fastify, serves the panel). URLs above; deploys track `main`. |
| `./AUDIT.md` with ~500-word summary | Security / performance / architecture / data-quality / compliance passes, summary-first. Findings drove the build (e.g. S1 "no per-patient authz in core" → the sidecar's patient-bound PEP; S2 error-disclosure → fixed in `apis/dispatch.php`). |
| `./USERS.md` (+ `./USER.md`) | Narrow user (ophthalmologist, ~70-patient clinic day) + concrete use cases; each maps to a shipped capability, and each agent capability traces back (the "agent surface = user need" rule). |
| `./ARCHITECTURE.md` with ~500-word summary | Sidecar-beside-untouched-EHR design, verification strategy, trust boundaries, tradeoffs; kept honest against built status (G3 alignment pass). |

**Agent requirements**

| Requirement | How it is fulfilled |
|---|---|
| Agentic chatbot: multi-turn, context, invokes tools | `sidecar/src/chat/` — streaming multi-turn chat over the prepared fact bundle with conversation persistence, plus a tool-use loop and eight read-only, patient-scoped, Zod-contracted tools (`get_full_document`, `get_measurement_trend`, `compare_scans`, `get_imaging_overview`, `describe_scan`, `check_med_risk`, `search_record`, `get_open_questions`). Tool invocations render in the chat drawer so tool use is visible, not claimed; imaging results render inline (sparkline / compare thumbnails) and deep-link into the viewer. |
| Verification: source attribution | Every claim carries a citation resolving to a stored source excerpt (details in the provenance section below); unattributable claims are rewritten as absence — never stated as fact. |
| Verification: domain constraints | Clinical rules are deterministic code, not prompts: AAO medication-risk thresholds (`medicationRiskFlags`), treat-and-extend interval analysis, HCQ progression trends — computed from stored facts and unfalsifiable by the model. Role-gated human verification workflow on top (`POST /api/facts/:pid/:factId/verify`). |
| Observability wired in and used | Correlation ID on every request/log/tool call/LLM call; per-stage trace spans; per-call token/cost ledger (Postgres `llm_calls`, surfaced at `GET /api/usage`); `prep_runs` stage/error rows answer "where did it die"; Langfuse tracing engages via env (cloud for the demo — synthetic data only; self-host documented as the in-boundary path). It is *used*: today's deploy debugging was driven end-to-end from these signals. |
| Evaluation framework in place | Three layers (see Testing & Eval below): 341 sidecar + 75 panel unit/contract tests, a golden-corpus eval suite with committed results (`docs/execution/eval-results.md`), and a live smoke that exercises the deployed agent end-to-end in CI. |

**Engineering requirements**

| Requirement | How it is fulfilled |
|---|---|
| Boundary/invariant/regression tests, failure mode documented per test | House rule enforced across the suites — every test names the failure mode it guards. Boundaries: empty record, unlinked patient, malformed model output. Invariants: claims must cite; cross-patient must 403. Regressions: each of today's live fixes landed with a replay test. |
| Correlation ID across service boundaries | Fastify `genReqId` honoring inbound `x-correlation-id`; the ID rides every log line, FHIR call header, tool call, LLM call, trace, and ledger row — a full request reconstructs from logs alone. |
| Canonical Zod contracts as source of truth | `sidecar/src/schemas/` barrel (facts, citations, contradictions, sources, imaging, provider, verification) is the single contract for store, pipeline, tools, and panel; model output is schema-validated with a feedback-retry, and inserts re-validate at the store. |
| Dashboard: requests, errors, latency, tool calls, retries, verification pass/fail | Tile spec mapped to already-emitted signals in `docs/execution/observability.md`; Langfuse (cloud) renders traces/usage now, custom tiles being assembled from the same data. Interim, every metric is queryable directly (`/api/usage`, `/api/prep-runs/:id`, logs). |
| Runnable API collection | Bruno collection at `sidecar/api-collection/` — health/ready, OAuth registration, trigger prep, get brief, chat turn, verify fact — runnable by graders without reading source. |
| Separate `/health` and `/ready`, meaningful readiness | `sidecar/src/routes/health.ts`: `/health` is dependency-free liveness; `/ready` really checks OpenEMR, Anthropic, Postgres, and Langfuse (configured deps that fail ⇒ 503). |
| ≥3 alerts with on-call response | A1 p95 latency, A2 error rate, A3 verification/tool failure — thresholds and the on-call runbook for each in `docs/execution/observability.md`. A3 is the clinical-safety alert. |
| Baseline CPU/memory/latency/throughput | Committed in `docs/execution/baselines.md` from a live capture against the enforced-auth deployment (2026-07-10): 290 req/s / p95 46 ms @10, 430 req/s / p95 193 ms @50, 0% errors at both levels; CPU/memory read-off windows and in-band evidence documented there. |
| Load tests at 10 and 50 concurrent | CI workflow (`sidecar-load.yml`) ran serialized 10- and 50-concurrent probes against production with a 1500 ms p95 SLO gate — both PASS with 32× / 7.8× headroom (run 29105511473); numbers + methodology + the discarded first capture in `docs/execution/baselines.md`. |

**Submission deliverables:** repo (this), audit/user/architecture docs (above), eval dataset + results (`sidecar/eval/`, `docs/execution/eval-results.md`), AI cost analysis (`docs/COSTS.md` — actual dev spend plus 100/1K/10K/100K projections with the architecture inflection at each tier, and a live $5/day spend guard enforcing the cost model), deployed app with the agent working live (verified today), demo video (submitted 2026-07-10; script in `docs/defense/demo-script.md`).

## Testing & evaluation approach

Three layers, each answering a different question. **(1) Unit and contract tests** (341 sidecar, 75 panel, in CI on every push) answer "does the machinery hold at the boundaries?" — every case exercises a boundary, invariant, or named regression: empty patient records, markdown-fenced or null-riddled model output, cross-patient token → 403, prompt-injection text inside a seeded referral letter, citation offsets that must resolve verbatim. **(2) The eval suite** answers "is the agent *clinically* right?" — the seed corpus doubles as ground truth (authored contradictions with known answers, calculator golden numbers, citation-validity = 100% as a hard invariant, cross-patient denial, missing-data behavior), with results committed, not just run. **(3) Live smoke in CI** answers "does it work *deployed*?" — GitHub runners drive the real URL through readiness, EHR sync, a full prep, and gate assertions on the produced brief. This layer earns its keep: today it caught an extraction-contract violation (model emitting `"severity": null`) that unit tests structurally could not see; the fix landed with a replay test — the eval-driven loop the requirements describe, exercised in anger. Next: the flagged-output→fixture loop (panel flag → eval case) to make that loop routine.

## Tracing & provenance of citations (chat and UI)

Provenance is structural, not stylistic. Every fact in the store carries `CitationRef`s pointing at a stored source document with **character-range excerpt offsets**; briefs keep those refs per item. Chat uses Anthropic's native Citations API — source documents are passed as document blocks, so every model claim arrives with the exact quoted span — and then the sidecar's **citation gate re-verifies every cited span verbatim against the stored document server-side**. A citation that fails re-verification is reported as unverified and the claim is rendered as absence; unverifiable text is never displayed as provenance. In the UI, citations appear as source-name chips ("Provider note", "Pharmacy", "Imaging report", "EHR") that open the source with the cited span highlighted; facts pulled live from OpenEMR carry EHR origin badges and belong to a wipeable "EHR snapshot" document so even live-synced data passes the same gate. The whole chain — prompt, tool calls, generation, gate verdicts — shares one correlation ID, so any on-screen claim can be traced from pixel to source excerpt to LLM call from logs alone.

## HIPAA / PHI handling on the API side

Posture: **demo data only** — the corpus is entirely synthetic patients, per the case study's constraint, and we operate as if a BAA exists with the LLM provider (no training on submitted data). The architecture is built so that swapping synthetic for real PHI changes configuration, not design: (1) **Access is patient-bound and typed** — the sidecar is a SMART resource server; interactive tokens bind to one patient, and a global policy-enforcement hook 401s missing/invalid tokens, 403s any cross-patient request structurally, and gates capabilities by role (physician / nurse / resident), failing closed to least privilege. The background preparer uses a separate read-only system client, audit-logged in OpenEMR's own `api_log`. (2) **PHI never leaks through error surfaces** — exception messages are logged, never returned (generic bodies on 500s, typed envelopes on upstream failures); request logs carry metadata and correlation IDs, not record payloads. (3) **Transport and storage** — TLS everywhere externally; the fact store is a *derived view* of the EHR (wipeable/rebuildable, never a second source of truth) living in the same Railway project; secrets exist only in platform variables, never the repo. (4) **LLM and observability egress** — patient context goes to Anthropic under the assumed BAA; tracing for the demo uses Langfuse Cloud *because the data is synthetic*, with the self-hosted in-boundary deployment documented as the production path. (5) **Honest gaps, tracked**: `dev-login` is a demo-only credential issuer (documented, disabled for real deployments); OpenEMR core itself lacks per-patient authorization (audit finding S1) — the sidecar constructs that control rather than patching core; retention/breach-notification policies are documented as out of demo scope in `AUDIT.md`'s compliance pass.

## Known-partial at submission time

Langfuse dashboard build-out (cloud tracing live, custom tiles in progress), live browser SMART EHR-launch (verifier + token plumbing built and tested; dev-login stands in for grading).
