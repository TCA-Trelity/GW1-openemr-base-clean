# DECISIONS.md — Clinical Co-Pilot build-out

*Audit trail per the software-factory skill: every judgment call gets one
line + rationale, surfaced as a `DECISION:` line in chat when vetoable in
real time. Newest entries at the bottom. Deeper argumentation lives in
`ARCHITECTURE.md` / the PRD; this file is the ledger.*

## Production-factory block swaps

The software-factory production stack lists 11 default blocks with the rule
"swap a block when the project demands it, log the swap." This build swaps
five — each driven by the brownfield EHR context and the already-submitted
architecture docs:

- DECISION: Work record = `docs/execution/execution-plan.md` (repo-native) over Linear — evaluators must see scope/status in the public repo; no external tracker access to grant.
- DECISION: Observability = self-hosted Langfuse over LangSmith — traces of clinical conversations stay inside the deployment boundary (`ARCHITECTURE.md` §7); also the committed, submitted choice.
- DECISION: Delivery target = Railway over Vercel+Supabase — the sidecar must live beside the OpenEMR EHR in one private network; one platform for app+db+queue+observability.
- DECISION: Orchestrator = plain pipeline + single tool-using chat loop over LangGraph — latency is the binding constraint and the submitted defense argues against orchestration frameworks; gates are process (plan approval, deploy sign-off), not `interrupt()` nodes.
- DECISION: Memory = `docs/HANDOFF.md` (session state) + this file + execution plan over `memory/*.md` — same mechanism, evaluator-friendly locations that already exist.

## Domain escalation (healthcare)

- DECISION: Verification design runs at production grade regardless of tier per the skill's domain-escalation rule — citation gate, deterministic clinical arithmetic, and role-gated human verification are Tier 1 scope, not polish. (Matches `ARCHITECTURE.md` §4.)

## Build decisions (2026-07-07 planning session)

- DECISION: Imaging metadata authored at seed time — analytics engines consume authored `ai_analysis` ground truth; a live vision read slots in later behind the same schema. Deterministic, evaluable, honestly labeled.
- DECISION: Scan imagery from public research OCT datasets (Kermany-class mapping: CNV for fluid visits, normal post-treatment/HCQ) — CC BY attribution recorded in `docs/data-sources.md` when sourced.
- DECISION: All four imaging features (timeline+context badges, treat-and-extend, trend charts, side-by-side) are Thursday scope — they share one data spine; marginal cost per tab is small.
- DECISION: Panel embedded in the OpenEMR chart is Thursday scope (user call, against the de-risk recommendation) — built standalone-first as the iframe target; embed timeboxed to Thu AM with a 1 PM CT fallback decision (chart link to standalone panel).
- DECISION: Fence F9 resolved — `medicationRiskFlags.jsx` is the canonical med-risk engine (fully pure, carries AAO source citation); the divergent service copy is not ported.
- DECISION: Fence F10 upheld — `analyzeOCT`'s fabricated (Math.random) pixel analysis is never ported; nothing fabricates clinical data.
- DECISION: Scan storage = sidecar Railway volume behind an `ImageStore` interface — object storage becomes a config swap at pilot scale.
- DECISION: Sidecar lives in this repo under `sidecar/` as its own Railway service with Watch Paths — sidecar iterations must not trigger 15-minute EHR rebuilds.
- DECISION: Keep BullMQ/Redis and the two-tier model split (Sonnet 5 prep / Haiku 4.5 chat) exactly as submitted — doc/build consistency is an interview asset.
- DECISION: Live verification runs in GitHub Actions (public runners reach the Railway URL; the dev session cannot) — CI smoke is the arbiter of "works in the live environment."
- DECISION: OAuth registration + corpus seeding execute as scripts on the Railway sidecar service, not from the dev session (same egress constraint).
- DECISION: Corpus keeps HCQ at 200mg daily since 2019-01-15 (per every cited document excerpt) over the ticket's 400mg/2021-12-01 — the corpus-as-eval-truth invariant outranks ticket text; risk flag still fires via the ≥5-year AAO branch (~5.9 years). The 2021-12-01 anchor survives as the medication_start event for the imaging series.

## Ops notes (2026-07-08 Railway volume postmortem)

- DECISION: The day-one volume (attached at the old whole-app mount path) had half-applied into Railway's environment config: counted by the deploy validator, never rendered on canvas, never mounted at runtime, undeletable from the UI. Resolution: repointed the existing volume instance to `/var/www/localhost/htdocs/openemr/sites` via the public GraphQL API (`volumeInstanceUpdate(volumeId, environmentId, input:{mountPath})`) rather than deleting it. Lesson: Railway staged-change validation errors cite volume IDs — a constant ID across attempts means a live server-side attachment regardless of what the canvas shows.
- DECISION: Railway watch-path globs are unreliable for dotfiles (a `.dockerignore`-only push built; a watched shell-script push skipped) — treat any push containing dot-path files as potentially build-triggering, and never push during a volume-population boot.
- DECISION: Schema-corpus contract reconciled in the schemas' direction (corpus field names for patient_goal/chief_complaint; nullable tolerances; 'imaging'/'prior_visit_note' doc types; optional deep_link_url) — the corpus is the eval ground truth, so contracts bend to it, and test/corpus-conformance.test.ts now locks the contract: every seed record must strictly parse on every test run.
- DECISION: temperature:0 dropped from prep LLM calls — claude-sonnet-5 rejects non-default sampling params (400); determinism comes from the strict prompt + Zod validation + one retry-with-errors, and a test locks the param's absence from the request body.
- DECISION (revisits the BullMQ line above): Tier-1 prep runs in-process fire-and-forget with errors captured in prep_runs — a queue adds two services with no Thursday payoff at single-replica demo scale, and prep hides in the check-in gap regardless. BullMQ/Redis remains the pilot-scale design; revisit at Final.
- DECISION: Anthropic client streams (SSE) with a 64K output budget (`LLM_MAX_OUTPUT_TOKENS`, sonnet-5 ceiling 128K) — the first live prep truncated mid-JSON at the old 16K non-streaming cap (extraction re-quotes source text per citation, so output scales with input; adaptive thinking also bills as output). Streaming is required above ~16K anyway; unused budget costs nothing. Hung calls now die on a 90s idle timeout (15-min absolute ceiling) instead of wedging the run + its dedupe slot.
- DECISION: Prep-run observability = 15s streaming heartbeat logs + stage stamping on prep_runs + `GET /api/prep-runs/:patientId` — "is it stuck / where did it die" answers over HTTP; the smoke workflow dumps it on brief-poll failure.
- DECISION: S2.6 tracing pulled forward — `langfuse` npm SDK added (the one dependency exception: it owns the ingestion wire format + batching, which we cannot verify offline to hand-roll safely); one trace per prep run keyed by correlation ID, spans per stage, generations per LLM attempt, outcome scores (run_success, citations_failed, facts_blocked). Engages only when LANGFUSE_HOST + both keys are set; every emit is guarded so observability can never fail a run. Langfuse itself deploys self-hosted on Railway (the submitted boundary argument); dashboard + 3 alerts doc completes S2.6 after data flows.
- DECISION: One fresh transient retry per extraction (timeout/overloaded/5xx/429) on top of the single validation retry — a one-off Anthropic stall no longer kills the prep run; 4xx contract errors never retry; worst case 3 calls per run, all ledgered.

## Extraction rework (2026-07-08, after two live max_tokens failures)

- Postmortem: run 0 (streaming code) burned 2 × 64,000 output tokens and still truncated, while attempt 2's input grew only ~100 tokens over attempt 1 — meaning attempt 1's visible text was tiny and ~the whole 64K was adaptive-thinking spend. The prompt's exact-character-offset demand is the prime suspect: models cannot count characters, and Sonnet 5's default thinking ground on it indefinitely.
- DECISION (revisits "two-tier model split" above): Haiku 4.5 (`claude-haiku-4-5`) for ALL LLM calls for now (user directive, 2026-07-08 — cost control). No default thinking to spiral, 1/5 Sonnet's price; ledger rates now default $1/$5 per MTok. Sonnet restorable via `ANTHROPIC_MODEL_PREP` env without a deploy.
- DECISION: Extraction is map-reduce — one bounded call per document (output structurally limited by one document's content, `LLM_MAX_OUTPUT_TOKENS` default 8192) + one contradiction pass over compact fact summaries. Never the full corpus in a single mega-call. Per-doc progress stamps `llm_extraction:N/12` onto prep_runs.
- DECISION: Character offsets are best-effort BY CONTRACT — the prompt tells the model estimates are fine and to never count characters; the citation gate verifies excerpt_text verbatim and corrects ranges (`ok_search`), so provenance strictness is unchanged. context_before/context_after are always null (panel derives context from stored document text).
- DECISION: Truncation (stop_reason max_tokens) is never feedback-retried — feeding a cut-off response back cannot fix a structural cap hit and doubles the burn. One fresh retry, then fail the call with a clear error.
