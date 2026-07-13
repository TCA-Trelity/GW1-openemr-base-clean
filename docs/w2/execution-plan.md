# Week 2 Execution Plan — Sequential Waves (No Day Framing)

**How to read this.** Work is sequenced in waves keyed to what each checkpoint
*expects* (MVP → Early Submission → Final), not to calendar days — parallelize
aggressively within and across waves wherever the dependency notes allow.
Every ticket cites its REQ IDs from
[`requirements.md`](requirements.md) — **the ticket is done when its cited
acceptance criteria check off there**, not when code merely exists. Any scope
change edits `requirements.md` in the same PR (anti-drift rule).

Architecture for every ticket: [`W2_ARCHITECTURE.md`](../../W2_ARCHITECTURE.md)
(section numbers cited as §).

**Checkpoint expectation bands:**

- **Band 1 — MVP expectation:** Waves 0, A, B, C, D. The spec's MVP table is
  explicit: two document types ingesting, hybrid RAG working, supervisor + 2
  workers with logged handoffs, **and** the 50-case PR-blocking eval gate,
  integrated and demoable.
- **Band 2 — Early Submission expectation:** Wave E (full UI/observability/
  engineering spine) + first baselines.
- **Band 3 — Final expectation:** Wave F (reports, video, hardening, rehearsal
  evidence, tag).

---

## Wave 0 — Preflight (all tickets parallel; tiny; unblock everything)

| ID | Ticket | REQ | Acceptance sketch | Depends on |
|----|--------|-----|-------------------|------------|
| 0.1 | Verify pgvector on Railway Postgres; enable extension or flip retriever to in-process fallback flag | S2/R3 | `CREATE EXTENSION vector` succeeds (or fallback documented + flag set); finding recorded in W2_ARCHITECTURE §15 | — |
| 0.2 | Register `user/document.write` scope for the sidecar's password-grant client; integration-test one document POST against dev OpenEMR | S1/R1, G7 | Test uploads + lists + hash-matches a PDF on a dev patient; scope change noted in RUNBOOK | — |
| 0.3 | Activate Langfuse (Cloud project, synthetic-data demo posture); existing prep tracer emits; keys in Railway | R7, §8; debt item #4 | A prep run renders a trace in Langfuse; `docs/RUNBOOK.md` §C updated | — |
| 0.4 | Add `COHERE_API_KEY`, LangSmith env vars to the boot-crash-proof config layer (invalid → feature off + warning, never crash) | S2/R3, R7, G2 | Config parse tests; missing key degrades cleanly | — |
| 0.5 | Wire branch protection: new eval workflow will be a required check on `main` (repo-admin action; document in RELEASE.md) | S4/R6, D5 | RELEASE.md promotion gate lists the eval check | — |

## Wave A — Ingestion spine (parallel with Wave B)

| ID | Ticket | REQ | Acceptance sketch | Depends on |
|----|--------|-----|-------------------|------------|
| A.1 | `LabPdfExtraction` + `IntakeFormExtraction` Zod schemas + validation tests | R2, D3, G3 | All seven lab fields / six+goals intake fields; invalid-fixture tests fail closed | — |
| A.2 | Citation contract v2: `guideline_evidence` source type, spec minimum shape, `page_bbox` variant; migration note | R5, G1 | Schema tests; Week 1 citations still parse (backward-compat test); migration note committed | — |
| A.3 | Upload endpoint `POST /api/patients/:pid/documents` (multipart) + doc-type registry + OpenEMR document write + sha3-512 dedupe + `attach_and_extract` tool wrapper | S1/R1, G1 | 202 + ingestion id; file visible in OpenEMR; byte-identical re-upload → same id, no second row | 0.2 |
| A.4 | Extraction job: Claude vision → Zod parse → one validation-feedback retry → `ingestion_failed` on second failure; timeouts + transient retry on VLM calls | S1/R1, G3, G2 | Stubbed-fixture integration test: valid doc → facts; malformed VLM output → failed, nothing persisted | A.1, A.3 |
| A.5 | Geometric grounding: OCR word boxes → tight bbox; VLM page citation → page-region; else `unverified` (uncitable) | R5, P2 | Grounding unit tests incl. near-miss values; degraded-scan fixture produces `unverified`, never a wrong citation | A.2, A.4 |
| A.6 | Persistence: facts + provenance + per-field confidence → fact store (deterministic IDs, wipe-and-rewrite); intake ht/wt/BP → native vitals write | S1/R1, G1 | Re-process accretes nothing; vitals row visible in OpenEMR UI; every fact carries `source_document_id` | A.4 |
| A.7 | Fixtures: hero renal-panel PDF (declining eGFR) + updated-intake form for the HCQ patient; degradation ladder (clean → skew/noise → low-DPI); HbA1c extra | S1 tailoring, D4 | Fixtures committed + regenerable by script; eGFR value re-tiers `check_med_risk` output in an integration test | — |

## Wave B — Corpus + retrieval (parallel with Wave A)

| ID | Ticket | REQ | Acceptance sketch | Depends on |
|----|--------|-----|-------------------|------------|
| B.1 | Author 6–10 practice-protocol docs (AAO PPP DR/AMD/RVO, HCQ screening, treat-and-extend) with full metadata | S2/R3, G18 | Docs committed; each cites its named source guideline + version/date; zero PHI | — |
| B.2 | Structure-aware chunker (thresholds stay with conditions; header prefixes; stable chunk_ids) | S2/R3 | Chunker unit tests on threshold tables; chunk schema validated | B.1 |
| B.3 | Index build: pgvector (Cohere embeddings) + tsvector tables + ingest script (rebuildable from repo) | S2/R3, G18 | `npm run corpus:index` rebuilds from scratch; counts logged; 0.1 fallback path works | 0.1, 0.4, B.2 |
| B.4 | Hybrid retrieve: parallel keyword + dense → RRF → Cohere Rerank → top-k(≤5) with metadata; timeouts + bounded retry + degraded path | S2/R3, G2 | Retrieval integration test (stubbed rerank in CI, live locally); miss → `retrieval_miss` event + honest empty result | B.3 |
| B.5 | PHI-free query construction: deterministic scrubber + query rewriting + disease/laterality filters | S2/R3, E5, G18, P5 | Scrubber unit tests with canary identifiers; rewritten queries logged as hashes | B.4 |
| B.6 | Retrieval goldens: `retrieval_grounded` cases (right protocol for HCQ/DR/AMD asks; out-of-corpus ask → refusal) | S4/R6 (partial), D4 | ~10 boolean retrieval cases pass; wired into harness categories | B.4, D.1 |

## Wave C — The graph (starts against stubs once A.4/B.4 interfaces exist)

| ID | Ticket | REQ | Acceptance sketch | Depends on |
|----|--------|-----|-------------------|------------|
| C.1 | LangGraph.js `StateGraph` skeleton + typed graph-state Zod schema + supervisor↔worker contract tests | S3/R4, G1, G7 | Malformed worker payload fails loudly in a contract test; graph compiles with 5 nodes (§4) | interfaces of A.4, B.4 |
| C.2 | Supervisor-as-entry router: deterministic short-circuits + small Haiku routing call (~200–400 ms) → `fast_path` \| `needs_evidence` \| `needs_extraction`; fast_path delegates to the unchanged Week 1 chat loop | S3/R4 (locked #4) | Routing decision + reason logged every turn; fast-path latency overhead measured ≤ 0.4 s in baseline | C.1 |
| C.3 | Worker nodes wrap A (intake-extractor) and B (evidence-retriever) services; evidence turn streams status, ≤ 5 s budget, degraded-on-timeout | S3/R4, G2 | End-to-end stubbed graph test: upload → extract; evidence ask → reranked chunks → cited answer | C.1, A.4, B.4 |
| C.4 | Critic node: promote citation gate + prescriptiveness lint to answer-side graph node | E1 | No answer path bypasses the critic (test asserts wiring); rejections logged with reason | C.1 |
| C.5 | Handoff logging + trace hierarchy: `worker_handoff` events; worker spans children of supervisor span; sub-calls children of workers | G4, G13, P3 | One correlation ID reconstructs a full multi-agent trace (worked example committed to docs) | C.3, 0.3 |
| C.6 | Ingestion-time evidence pinning: extraction findings trigger evidence-retriever during prep; pinned chunks ride the fact bundle | §4 Tier 0 | HCQ-in-meds fixture → screening protocol pinned; in-visit guideline ask answers without live retrieval | C.3 |

## Wave D — Eval gate + CI (D.1/D.3 start immediately, parallel with A/B)

| ID | Ticket | REQ | Acceptance sketch | Depends on |
|----|--------|-----|-------------------|------------|
| D.1 | Category framework: rubric-category tags on `EvalRecord`; committed per-category baseline file; **tiered comparator** (safety hard-fail per case; quality >5%-vs-baseline or threshold) | S4/R6 (locked #11) | Comparator unit tests: single safety flip fails; 4% quality drop passes; 6% fails; below-threshold fails | — |
| D.2 | Grow to 50 cases at mix ≈ 20/10/8/7/5; wire the 3 idle corpora; degraded-scan + near-miss extraction cases; refusal + missing-data cases | S4/R6, D4 | 50 committed cases, all tagged; `docs/execution/eval-results.md` regenerates with category table | A.7, B.6, D.1 |
| D.3 | Stubbed-fixture harness for the full ingestion→answer path (VLM/LLM/embed/rerank stubs; no live keys) | G17 | Full-path integration eval runs green in CI with network access blocked | A.4 stubs, B.4 stubs |
| D.4 | PR-blocking wiring: eval workflow on `pull_request` + required check + pre-push git hook (installable, documented) | S4/R6, D5 | A PR with an injected regression is blocked (screenshot/log committed); hook runs the same suite locally | D.1, 0.5 |
| D.5 | PHI canary system: canary identifiers seeded in fixtures; CI captures integration-run logs and asserts no canary / raw doc text / extracted values appear | G18, `no_phi_in_logs` | Planted canary in a log line fails CI (rehearsal case); scrub documented | D.3 |
| D.6 | Dependency audit + security scan on `main` PRs (npm audit + sidecar-scoped semgrep job; Dependabot covers `sidecar/` + panel) | G7 | Both run on a test PR; Dependabot config diff merged | — |
| D.7 | Hard-gate rehearsal: three injected regressions (schema field break / dropped citation / planted canary) each fail a different category; documented + repeatable | D5 evidence, S4/R6 | Rehearsal doc with the three failing runs linked/committed | D.2–D.5 |

## Wave E — Integration, UI, observability (Band 2: Early-Submission expectation)

| ID | Ticket | REQ | Acceptance sketch | Depends on |
|----|--------|-----|-------------------|------------|
| E.1 | Panel upload UI: drag-drop (front-desk role via role switcher), doc-type select, live ingestion status | S5 (locked #7) | Grader can upload the hero fixtures from the panel and watch extraction complete | A.3, A.4 |
| E.2 | PDF preview + bbox overlay + click-to-source in Sources tab (three visibly distinct citation outcomes) | R5, E2 | Clicking a lab citation opens the page with the region highlighted; unverified facts visibly flagged | A.5 |
| E.3 | Write-path auth: dev-login bearer + role gate on upload/vitals/verify; read/chat stay open | locked #14 | Unauthenticated upload → 401; wrong role → 403; documented in README/RUNBOOK | A.3 |
| E.4 | Observability build-out: graph/retrieval/extraction spans in Langfuse; dashboard tiles (ingestion count, field-level pass rate, retrieval hit rate, routing outcomes, eval per-category); alerts A4–A6 with response actions | R7, G6, G15 | Tiles render on the ops page; alert definitions committed in observability.md | C.5, 0.3 |
| E.5 | LangSmith demo-env wiring (fenced: demo env only, synthetic data) | R7 (locked #2), P5 | LangGraph trace renders in LangSmith from the demo env; production config has no LangSmith key | C.3 |
| E.6 | `/ready` probes: document storage (write-scoped client), vector index, reranker — degraded statuses | G14 | Killing each dependency flips its probe to degraded without taking `/ready` binary-down | A.3, B.3 |
| E.7 | Sidecar OpenAPI 3.0 spec (all W2 endpoints) + contract tests + CI freshness check | G16 | Spec committed; contract test fails on drift (mirrors core `api-docs.yml` pattern) | A.3 stable routes |
| E.8 | Bruno collection: upload, extraction status, evidence retrieval, full W2 flow (+ dev-login for write auth) | G10 | `bru run --env railway` green including the new folder | E.3, E.6 |
| E.9 | Evidence-turn streaming UX: "checking practice protocols…" status events; degraded message on retrieval timeout | §4 Tier 1, G2 | SSE shows status → evidence → cited answer; timeout path renders the honest fallback | C.3 |

## Wave F — Hardening + deliverables (Band 3: Final expectation)

| ID | Ticket | REQ | Acceptance sketch | Depends on |
|----|--------|-----|-------------------|------------|
| F.1 | W2 baselines: ingestion / extraction / retrieval / full-graph latency (p50/p95) + shared-path regression check vs Week 1 (46/193 ms) | G11 | `docs/execution/baselines.md` extended; SLO table (§9) updated with measured numbers | E.* landed |
| F.2 | Cost & latency report: ledger-backed dev spend, per-doc + per-query costs, p50/p95 vs SLOs, bottleneck analysis | D7 | Report committed; numbers traceable to `llm_calls` ledger + baselines | F.1 |
| F.3 | README restructure: Week 1 baseline vs Week 2 multimodal behavior; one no-guessing setup section (branch, env vars incl. Cohere/Langfuse/LangSmith/AUTH, both services); W2 deliverables table | D1 | A grader can run the core W2 flow from README alone | E.* |
| F.4 | Backup & recovery runbook: automatic + manual procedures, RPO/RTO, wipe-and-rebuild as recovery primitive, golden-set-in-repo invariant | G18 | Runbook committed; manual restore rehearsed once | — |
| F.5 | Demo video (3–5 min): upload → extraction → evidence retrieval → citations → eval results → observability | D6 | Video linked in README; covers all six spec items; synthetic data only | E.*, D.7 |
| F.6 | Pre-milestone live eval run (`LIVE_EVALS=1`) + live smoke on Railway; verification-rate alert sanity check | locked #9, S5 | Live results appended to eval-results.md; drift (if any) triaged before tag | D.2 |
| F.7 | Anti-drift sweep: every requirements.md checkbox verified or explicitly re-scoped (with migration note); statuses flipped in W2_ARCHITECTURE.md | G1, register purpose | No unchecked box without a recorded decision | all |
| F.8 | Stable tag + deploy verification (`stable-*` via tag workflow; `/ready` green/degraded-explained on prod) | D8, RELEASE.md | Tag minted; README links verified live | F.3, F.6 |

---

## Parallelization map (aggressive)

- **Immediately parallel from the start:** Wave 0 (all) ∥ A.1/A.2/A.7 ∥ B.1/B.2 ∥ D.1/D.3-scaffolding ∥ E.7-skeleton.
- **Two independent tracks:** Wave A (ingestion) ∥ Wave B (retrieval) end to end — they meet only at C.3 (workers) and C.6 (pinning).
- **Graph early-start:** C.1/C.2 need only the *interfaces* of A.4/B.4 — build against stubs, swap real services when A/B land.
- **Gate as a third track:** D.1 (comparator) and D.3 (stub harness) are pure harness work — no dependency on real extraction/retrieval quality; D.2's case count ramps as A.7/B.6 fixtures land.
- **UI last-mile:** E.1/E.2 depend on A; E.4/E.5 depend on C.5; E.7/E.8 depend only on route stability.
- **Critical path** (longest chain): 0.2 → A.3 → A.4 → A.5 → E.2 (the bbox overlay — required core R5). Start Wave 0 tickets first; everything else fans out.

## Standing rules for every wave (from the register)

1. Every PR references REQ IDs and flips its acceptance checkboxes in `requirements.md` (or records a re-scope with a migration note).
2. No raw VLM output past a Zod parse (G3); no citation without gate verification (R5); no PHI/extracted values in logs, traces, queries, or fixtures' log output (G18, P5).
3. Statuses in `W2_ARCHITECTURE.md` flip [TARGET]→[SHIPPED] in the same PR that lands the code — doc-vs-code drift is a Week 1 lesson, not a Week 2 feature.
4. $5/day SpendGuard stays; if extraction/eval iteration threatens it, **stop and alert the user** (locked #16) rather than raising it silently.
5. The eval gate is never skipped, softened, or env-flagged off to get a PR through; re-baselining is a reviewed diff (D.1).
