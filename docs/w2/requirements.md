# Week 2 Requirements Register — Multimodal Evidence Agent

**Purpose.** This is the canonical, exhaustive register of every Week 2
requirement from the assignment PDF ("AgentForge | Clinical Co-Pilot | Week 2
Project Requirements"), each with testable acceptance criteria, its Week 1
baseline status (verified against code, not doc claims), and the locked design
decision that satisfies it. It exists as the redundancy check against drift:
**every implementation ticket, PR, and eval case must reference the REQ IDs
below**, and any scope change must edit this file in the same PR
(with a migration note per G1).

**ID scheme.** `S#` MVP stage · `R#` core agent requirement · `E#` extension ·
`D#` deliverable · `G#` engineering requirement · `P#` pitfall (anti-pattern).
Status: ✅ have (Week 1) · ⚠️ partial · ❌ missing.

**Companion docs.** Architecture: [`W2_ARCHITECTURE.md`](../../W2_ARCHITECTURE.md).
Sequencing: [`execution-plan.md`](execution-plan.md) (wave/ticket IDs referenced
in the "Planned in" column). Defense: [`defense-outline.md`](defense-outline.md).

**Assignment checkpoints (as stated; execution sequencing is wave-based, not day-based):**

| Checkpoint | Deadline (spec, Central time) |
|---|---|
| Architecture Defense | 4 hours from assignment |
| MVP | Tuesday @ 11:59 PM |
| Early Submission | Thursday @ 11:59 PM |
| Final | Sunday @ Noon |

> Spec framing to honor throughout: *"The MVP is not a full medical-document AI
> platform. It is a controlled expansion of the Week 1 agent into two document
> types, two workers, and one regression gate."* And the final note: *"The best
> submissions will feel narrower than the original spec and stronger because of
> it."*

---

## 1. Core requirements (MVP stages S1–S5 + agent requirements R1–R7)

### S1/R1 — Document ingestion and extraction

> Spec: *"Implement `attach_and_extract(patient_id, file_path, doc_type)` or an
> equivalent tool. It must support `lab_pdf` and `intake_form`. It must store
> the source document in OpenEMR, return strict-schema JSON, and persist
> derived facts as appropriate FHIR resources or OpenEMR records."* Stage 1:
> *"accepts a file, associates it with a patient, stores the source document in
> OpenEMR, extracts structured JSON, and links every derived fact back to the
> source."* FHIR/OpenEMR integrity: *"Uploaded documents and derived
> observations must round-trip through OpenEMR without creating duplicate or
> untraceable records."*

**Status:** ❌ missing (strong foundations). No upload endpoint, no PDF/OCR
libs in the sidecar; `describe_scan` is the only vision path (quarantined);
seed `ocr_quality` metadata is pre-baked, not computed. OpenEMR standard API
document upload verified working: `POST /api/patient/:pid/document?path=<Category>`
(`src/RestControllers/DocumentRestController.php` → `DocumentService::insertAtPath`),
requires password-grant token + `user/document.write` scope (sidecar does
**not** register that scope today — `sidecar/src/openemr/auth.ts`).

**Acceptance criteria:**
- [x] Sidecar endpoint `POST /api/patients/:patientId/documents` (multipart)
  accepts `doc_type ∈ {lab_pdf, intake_form}` for PDF/PNG/JPEG; returns `202`
  with `{ingestion_id, correlation_id}`; rejects other types/oversize with a
  structured 4xx.
- [x] Equivalent chat/graph tool `attach_and_extract(patient_id, file_path,
  doc_type)` wraps the same service path (name preserved from spec).
  *(H.9: async graph-tool object `src/graph/tools.ts` wrapping
  `IngestionService.attachAndExtract`; the `intake_extractor` node invokes
  it by name; deliberately NOT on the sync read-only chat tool list —
  pinned by test; `file_path` ≙ `{filename, mimeType, bytes}` — uploads
  are multipart bytes by design.)*
- [x] Original file is stored in OpenEMR Documents under a per-doc-type
  category, associated to the correct patient (`documents.foreign_id = pid`),
  before extraction begins. OpenEMR remains the system of record for the file.
  *Incident note (evaluator-found, live 404s on both test patients 07-15): three
  stacked client bugs meant this box was implemented but not true in production
  — uuid passed where the route needs the numeric pid (silently filed to
  patient 0; fixed 07-14), category sent as `Lab Report` where the wire format
  is `Lab_Report` (silently orphaned the document), and the client parsed a
  `{data}` envelope where these routes return raw bodies + 404 on empty
  listings (killed the dedupe pre-check on every first upload). All fixed
  07-15 with post-write hash verification (a write that isn't listed under the
  category now throws instead of half-ingesting). Live re-verify = test plan
  A1/A2 after the next deploy.*
- [x] Idempotency: re-uploading byte-identical content creates **no** second
  OpenEMR document row and no duplicate facts (caller-side sha3-512 check —
  OpenEMR stores the hash but does not enforce uniqueness; sidecar
  `source_documents.id` derived deterministically from content hash,
  wipe-and-rewrite on re-process per `ehrSync.ts` pattern).
- [x] Extraction returns JSON that parses under the strict Zod schema for its
  doc type (R2); non-conforming output is rejected and retried, never persisted
  (G3).
- [x] Every derived fact row carries `source_document_id` + citation back to
  the stored document (no untraceable records); ingestion status queryable
  (`GET /api/ingestions/:id`) and fully reconstructable by correlation ID (G4).
- [ ] Persistence split (locked decision): source PDF → OpenEMR Documents;
  extracted facts → sidecar fact store with provenance; intake
  height/weight/BP → native OpenEMR vitals write
  (`POST /api/patient/:pid/encounter/:eid/vital`, scope `user/vital.write` —
  already registered); lab values → fact store only, with data authority
  documented (G1) because this fork's API has **no FHIR Observation create and
  no lab-table write path** (verified:
  `apis/routes/_rest_routes_fhir_r4_us_core_3_1_0.inc.php` — FHIR writes exist
  only for Patient/Organization/Practitioner).

**Ophthalmology tailoring (locked):** hero patient = existing HCQ-monitoring
corpus patient; lab fixture = outside **renal/metabolic panel with declining
eGFR** (feeds `check_med_risk` HCQ risk re-tier, UC-4); intake fixture =
**updated intake form** for the same patient (med change, new allergy, family
history addition, patient-goals line → UC-7). HbA1c panel remains as an
additional eval fixture only.

### R2 — Structured schemas

> Spec: *"Use Pydantic, Zod, or equivalent strict schemas. Required lab fields
> include at least test name, value, unit, reference range, collection date,
> abnormal flag, and source citation. Required intake fields include
> demographics fields, chief concern, current medications, allergies, family
> history, and source citation."*

**Status:** ⚠️ partial. Rich Zod citation schema exists
(`sidecar/src/schemas/citations.ts` — `source_type` enum already includes
`lab_report`, `referral_letter`, `intake_transcript`; `excerpt_location`
char-range variant; attribution block). No extraction schemas yet.

**Acceptance criteria:**
- [x] `LabPdfExtraction` Zod schema: per-result `{test_name, value, unit,
  reference_range, collection_date, abnormal_flag, citation}` — all seven spec
  fields present and required (nullable only where the document genuinely lacks
  the field, never silently defaulted).
- [x] `IntakeFormExtraction` Zod schema: `{demographics, chief_concern
  (laterality-tagged), current_medications, allergies, family_history,
  patient_goals, citation}` — spec's six + goals (UC-7) + laterality (domain
  requirement).
- [x] Citation contract v2 (R5 shape) embedded in both schemas; every field
  group carries `source citation`.
- [ ] Schemas exported from the shared schema module (same one-schema-serves-
  API-and-UI pattern as Week 1) and used by: extraction validation, fact-store
  persistence, panel rendering, eval assertions.
- [x] Validation tests exist per schema (valid fixture parses; each missing
  required field fails; malformed VLM output fails closed) — part of D3.

### S2/R3 — Basic hybrid RAG plus rerank

> Spec: *"Create a small clinical-guideline corpus relevant to your user
> profile. The corpus should contain agreed clinical practices the
> hospital/office follows... Use keyword plus vector retrieval, rerank the
> candidate chunks, and return evidence snippets with source metadata...
> ColQwen2 and multi-vector indexing are stretch; the core requirement is a
> reliable hybrid retriever. Documents are not provided, so you need to find
> your own."* R3: *"Retrieve with sparse+dense search, rerank candidate chunks
> with Cohere Rerank or an equivalent reranker, and feed only the top grounded
> evidence to the answer model."*

**Status:** ⚠️ shipped behind injectable backends; live backends engage at
deploy. Hybrid BM25+dense → RRF → rerank, PHI query scrubber + CI canary,
corpus + chunker, `/api/evidence/search`, retrieval goldens all shipped
(B waves). pgvector on Railway Postgres **verified AVAILABLE 2026-07-14**
(user-run `verify:pgvector`: extension enabled, v0.8.4; backend default
`pgvector` stands). Cohere key staged (USER-ACTIONS 1) — live dense/rerank
verification is post-merge. *(Original register-time status: missing
entirely, pgvector unverified doc claim.)*

**Acceptance criteria:**
- [x] Corpus: 6–10 authored practice-protocol markdown docs (locked decision)
  grounded in named real guidelines — AAO PPP Diabetic Retinopathy / AMD / RVO,
  AAO hydroxychloroquine-retinopathy screening recommendation, anti-VEGF
  treat-and-extend protocol — committed to the repo (license-clean, zero PHI,
  reproducible per G18), with per-doc metadata `{guideline_source, section,
  recommendation_strength, disease_tags, laterality_applicability, version/date}`.
  *(Verified under-flip, corrected 2026-07-14: 8 authored docs in
  `sidecar/corpus/` with full YAML frontmatter — every required metadata
  field present and enforced by the 25-case corpus-conformance suite.)*
- [x] Structure-aware chunker keeps thresholds with their conditions
  (dose/interval/staging tables never split from their qualifying text);
  chunks carry stable `chunk_id`.
- [x] Hybrid retrieval: Postgres `tsvector` keyword + `pgvector` dense (Cohere
  embeddings) run in parallel → reciprocal-rank fusion. If pgvector is
  unavailable on Railway, in-process cosine over the same interface (corpus is
  10²–10³ chunks) — the retriever interface hides the backend.
  *(Shipped + re-scoped 2026-07-14: dense leg = pgvector-PERSISTED Cohere
  vectors (`corpus_embeddings`, migration 005) with content-hash sync — an
  unchanged corpus re-embeds nothing — plus the in-memory fallback proven
  live against an extensionless Postgres; `RETRIEVER_DENSE_BACKEND` genuinely
  branches now, and `npm run corpus:index` exists (`--rebuild` wipes first).
  Keyword leg re-scoped to in-process BM25 — same sparse-retrieval contract
  the spec asks for, deliberately not tsvector at this corpus size.
  CONFIRMED LIVE 2026-07-14: production deploy log `corpus_index_synced
  {backend: pgvector, total: 71, embedded: 0, reused: 71, deleted: 0}` — a
  restart reusing every persisted vector with zero re-embeds, the
  persistence proof itself.)*
- [x] Rerank: Cohere Rerank on fused candidates (locked decision — the vendor
  the spec names); only top-k (k ≤ 5) chunks reach the answer model.
- [x] Evidence snippets returned with full source metadata (doc, section,
  chunk_id, quote) — consumable as `guideline_evidence` citations (R5).
- [x] PHI boundary: retrieval queries constructed from de-identified clinical
  concepts only; deterministic scrubber in code + CI check (extends
  `no_phi_in_logs` to queries); corpus contains zero PHI by construction.
- [x] Timeouts + bounded retry on Cohere calls; on retrieval failure the
  answer path degrades to "record-only, guidelines unreachable" — stated, not
  silent (G2, failure-mode F3).
- [x] E5 (committed): query rewriting + disease/laterality metadata filters.
- [x] ColQwen2 / multi-vector: **not built** (stretch per spec); index schema
  leaves a seam (embeddings in their own table keyed by source id).

### S3/R4 — Supervisor plus two workers

> Spec: *"Implement a small graph: one supervisor, one intake-extractor worker,
> and one evidence-retriever worker. The supervisor should decide when
> extraction is needed, when evidence retrieval is needed, and when the final
> answer is ready. Keep handoffs explicit."* R4: *"Use LangGraph, the OpenAI
> Agents SDK, or another inspectable orchestration framework. Required workers
> are intake-extractor and evidence-retriever. A critic agent is extension
> work, not core."*

**Status:** ⚠️ graph SHIPPED (`sidecar/src/graph/` — StateGraph, router +
LlmRouterModel tie-break, boundary contracts, ≤5 s evidence budget, pin
store; 15 tests). Remaining: chat-loop wiring (fast_path delegation +
production composer), Langfuse span binding (E.4), routing-latency baseline.

**Acceptance criteria:**
- [x] LangGraph.js `StateGraph` (locked decision) in the sidecar with exactly:
  supervisor node, `intake-extractor` worker (wraps the extraction pipeline),
  `evidence-retriever` worker (wraps hybrid RAG), gate/critic node (E1,
  promoted Week 1 gate), answer node. *(Answer assembly is the critic node's
  release step; the handoff chain logs `critic→answer` explicitly.)*
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
- [x] Supervisor decides all three spec conditions: extraction needed /
  evidence needed / final answer ready — each decision logged. *(Final-answer
  readiness = the critic's release decision, logged with verified/blocked
  counts on the `critic→answer` handoff.)*
- [x] Handoffs explicit: every supervisor→worker and worker→supervisor
  transition emits a structured log event `{correlation_id, from, to,
  routing_reason, timestamp}` (P3 anti-pattern guard: the supervisor is never a
  black box). *(Worked example: `docs/w2/trace-example.md`.)*
- [x] Tracing: worker invocations are child spans of the supervisor span;
  extraction/retrieval sub-calls are children of their worker spans (G13).
  *(Nested tree shipped + shape-asserted (H.7); visual confirm =
  USER-ACTIONS item 10.)*
- [x] Contract tests on the supervisor↔worker interface (typed state schema —
  G1/G7): a malformed worker payload fails the graph loudly, never propagates.
  *(`graph/contracts.ts`: entry ask + evidence payload, `.strict()` Zod;
  GraphContractError names the violated boundary.)*
- [ ] Ingestion-time evidence pinning: extraction findings trigger
  evidence-retriever during prep (e.g. HCQ in meds → screening protocol
  retrieved and pinned to the fact bundle), so most in-visit guideline asks
  resolve without live retrieval (latency Tier 0). *(Shipped: prep-time
  retrieval + per-patient pin store keyed to the ingestion id, replace-on-
  re-ingest. Remaining: chat bundle consumes pins as the Tier-0 read path.)*

### R5 — Citation contract

> Spec: *"Every clinical claim in the final response must include
> machine-readable citation metadata. Minimum citation shape: {source_type,
> source_id, page_or_section, field_or_chunk_id, quote_or_value}. A visual PDF
> bounding-box overlay is required."*

**Status:** ⚠️ partial (strong). Server-side verbatim citation verification +
withhold-at-server exists (`sidecar/src/gate/chatCitations.ts`,
`responseGate.ts`); panel `CitationChip` deep-links character ranges; no
page/bbox variant, no PDF preview overlay.

**Acceptance criteria:**
- [x] `CitationRefSchema` v2: adds `guideline_evidence` to the `source_type`
  enum; adds `page_or_section` + `field_or_chunk_id` + `quote_or_value`
  fields; adds `page_bbox` location variant `{page, x, y, w, h}` (normalized
  coords) alongside the existing `character_range` variant. Migration note
  accompanies the schema change (G1).
- [ ] Every clinical claim in a final response carries a machine-readable
  citation of the minimum spec shape — enforced by the existing deterministic
  gate (unverified citations withheld server-side), extended to the two new
  source classes (document-extraction facts, guideline chunks).
- [x] Geometric grounding: extracted values are located in OCR word-box
  geometry → tight bbox; page-level fallback (VLM page citation) → page-region
  highlight; unlocatable → fact renders **unverified and is never citable**.
  Three visibly distinct UI outcomes.
- [x] **Visual PDF bounding-box overlay in the panel (required, core):**
  clicking a document citation opens the stored PDF page with the cited
  region highlighted (E2 click-to-source delivered by this same surface).
- [x] Guideline citations verify quote-vs-stored-chunk through the same gate
  path as record citations. *(E.9: the critic node runs `runCitationGate`
  over composer claims against snippet bodies; blocked claims release zero
  citations end-to-end through the chat SSE — route-tested. H.6 (merged
  plan) adds gate-unit reject proof for both v2 citation types —
  page/page_bbox and guideline_evidence — in `sidecar/test/gate.test.ts`.)*

### S4/R6 — Eval-driven CI gate

> Spec: *"Create 50 synthetic or demo cases that exercise extraction, evidence
> retrieval, citations, refusals, and missing-data behavior. Use boolean
> rubrics, not 1-10 ratings. CI must fail on meaningful regression."* R6:
> *"Build a 50-case golden set and a PR-blocking Git Hook. Boolean rubric
> categories must include schema_valid, citation_present, factually_consistent,
> safe_refusal, and no_phi_in_logs. The build must fail if any category
> regresses by more than 5% or drops below the pass threshold."* **HARD GATE:**
> *"During grading, we will introduce a small regression and confirm your CI
> gate fails. If the eval gate does not block the regression, the Week 2 build
> does not pass."*

**Status:** ✅ complete (PR leg). **58/58 deterministic cases across 14 suites,
all six categories measured and baselined** (`eval/baseline.json`); rehearsal
proves the gate catches injected regressions (`docs/w2/gate-rehearsal.md`);
**`Run eval suite` is a required check on `main`** (branch protection flipped
2026-07-13). Remaining: the scheduled live-model suite (F.6, post key-drop).

**Acceptance criteria:**
- [x] 50 committed golden cases, extraction-weighted (locked): ~20 extraction
  (lab + intake, incl. ≥1 deliberately degraded scan and near-miss values),
  ~10 retrieval/grounding, ~8 citation integrity, ~7 refusal + missing-data,
  ~5 PHI/safety. The 3 idle corpora (`james-whitfield`, `patricia-okafor`,
  `robert-alvarez`) get wired in. *(58 cases: 13 extraction-pipeline goldens
  over the committed fixtures + 4 full-path graph goldens, 12 retrieval, 13
  citation, 8 refusal, 3 PHI-sweep, plus per-corpus citation validity — all 5
  corpora wired. Deterministic PR leg; live-VLM extraction variants ride the
  opt-in live suite.)*
- [x] Rubric categories (booleans, no 1–10 scores): `schema_valid`,
  `citation_present`, `factually_consistent`, `safe_refusal`,
  `no_phi_in_logs`, plus `retrieval_grounded`. Judge configuration committed
  (deterministic checks preferred; any LLM-judge is boolean-rubric with
  committed config — D4).
- [x] Tiered regression math (locked): safety categories (`safe_refusal`,
  `no_phi_in_logs`, `citation_present`) hard-fail on **any** newly-failing
  case; quality categories (`schema_valid`, `factually_consistent`,
  `retrieval_grounded`) fail on **>5% drop vs committed per-category baseline
  OR below absolute pass threshold**. Baseline file committed and updated
  deliberately.
- [x] PR-blocking: eval workflow triggers on `pull_request`, is a required
  status check on `main`, **and** a pre-push git hook runs the same suite
  locally (spec says "Git Hook" — we deliver both). *(Complete 2026-07-13:
  the user flipped branch protection — `Run eval suite` is a required check
  on `main` (+ the Sidecar CI jobs). The pull_request trigger's path filter
  was removed so a required check can never wedge a docs-only PR.)*
- [x] PR suite is fully deterministic on stubbed VLM/LLM fixtures — no live
  keys in CI (G17); live-model suite runs on dispatch/schedule and before
  milestones (locked decision). *(All 58 PR-leg cases run keyless — scripted
  VLM + offline retrieval backends; the 2 live cases stay opt-in-skipped.
  Remaining: the scheduled live-suite workflow.)*
- [x] `no_phi_in_logs` is executable: fixtures seed canary identifiers; CI
  captures logs from the integration run and a PHI-detection pass asserts no
  canary (and no raw document text / extracted clinical values) appears (G18
  privacy audit). *(`eval/phi-log-sweep.eval.ts`: capturing logger over real
  ingestion + graph runs, planted name/DOB/family/allergy canaries, zero-leak
  threshold; plus the retrieval query-scrub canary case.)*
- [x] Hard-gate rehearsal documented and repeatable: three injected
  regressions (schema field break, dropped citation, planted canary) each
  fail the gate in a different category. *(`npm run gate-rehearsal` +
  `docs/w2/gate-rehearsal.md` with verbatim caught-regression output —
  citation_present and no_phi_in_logs via the safety tier, schema_valid via
  the >5%/threshold quality math.)*

### R7 — Observability and cost tracking

> Spec: *"Each encounter must log tool sequence, latency by step, token usage,
> cost estimate, retrieval hits, extraction confidence, and eval outcome. Logs
> must not contain raw PHI."*

**Status:** ⚠️ partial. Correlation IDs end-to-end; pino structured logs;
Postgres `llm_calls` ledger (per-call tokens + est. cost) + `SpendGuard`
$5/day budget + `GET /api/usage`; `prep_runs` stage tracking. Langfuse
**activated** (Cloud, user key-drop 2026-07-14): prep traces flow on the
deployed service; the W2 graph-span adapter (E.4) is shipped code that joins
when PR #9's build deploys. LangSmith fenced to the demo env (E.5); no OTEL.

**Acceptance criteria:**
- [ ] Per encounter, reconstructable from one correlation ID: tool/worker
  sequence, latency by step, token usage, cost estimate, retrieval hits
  (query-hash, chunk_ids, scores — never patient text), extraction confidence
  (per document and per field), eval outcome where applicable.
- [x] Langfuse activated (locked: Cloud for the synthetic-data demo,
  self-hosted documented as pilot posture); spans extended beyond prep to
  supervisor → workers → retrieval/extraction sub-calls (G13 hierarchy).
  *(Activated 2026-07-14: Cloud keys live on the sidecar service, prep
  trace verified. The supervisor→worker span hierarchy is shipped code
  (E.4) — its visual check completes when PR #9's build deploys.)*
- [x] LangSmith enabled **only** in the demo environment (locked), documented
  as a demo-env overlay with synthetic data — never the committed production
  posture (P5 guard).
  *(Fenced by configuration: env vars read natively by LangGraph.js; boot
  log states the posture; RUNBOOK §C2 + USER-ACTIONS document the demo-only
  key drop. Visual trace check completes after keys land.)*
- [ ] Logs/traces contain identifiers and hashes, never raw document text,
  patient identifiers, or extracted clinical values (spec privacy audit
  language — G18); extraction confidence and retrieval scores are logged as
  numbers.
- [x] Cost ledger extended: extraction and Cohere calls priced into
  `llm_calls` (or a parallel ledger line) so D7's dev-spend number is
  ledger-backed; **$5/day SpendGuard unchanged** (locked — alert the user if
  this becomes infeasible).
  *(Closed 2026-07-14: evidence_composition calls ledger-priced (E.9);
  extraction usage priced in the D7 model (COSTS.md §6); Cohere embed/rerank
  calls now write unit-counted `llm_calls` rows (`cohere_embed` /
  `cohere_rerank`) at est_cost 0 — accurate for the trial key in use;
  production per-unit pricing remains COSTS.md §6.2's verify-at-key-drop
  cells, deliberately never memory-quoted. SpendGuard cap unchanged.)*

### S5 — Integrate, deploy, and defend

> Spec: *"Expose the Week 2 flow in the deployed app, capture observability
> traces, record a demo, and prepare to explain why each capability maps back
> to the Week 1 user and workflow."*

**Status:** ✅ mostly (two public Railway services; health-gated deploys;
`/health` + `/ready` with real dependency probes).

**Acceptance criteria:**
- [ ] Deployed Railway app serves the full W2 flow: panel upload → extraction
  status → brief/chat with document + guideline citations → bbox overlay.
- [x] Upload UI: panel drag-drop with front-desk persona via existing role
  switcher (locked decision); extraction status + document preview in the
  Sources tab.
  *(Shipped E.1/E.3: drag-drop upload with live staged progress, loud
  terminal states, and document preview in the Sources tab. Uploader persona
  = physician/nurse via the existing role switcher — no separate front-desk
  label was added; resident demonstrates the 403.)*
- [x] Demo auth (locked): write paths (upload, vitals write, verify) require a
  dev-login bearer with role gate; read/chat surfaces stay open for graders.
  *(Shipped: upload requires an attributable principal with the new
  `documentsWrite` capability REGARDLESS of AUTH_MODE — 401 tokenless, 403
  resident, physician/nurse allowed; verify already gated; the vitals write
  gate lands with the dedicated vitals route. Panel maps 401/403 to friendly
  role guidance.)*
- [ ] Traces of the demo flow captured and linkable (Langfuse demo project).
- [x] Every capability maps to a UC in `USERS.md` (defense-outline slide 1
  carries the mapping).
  *(Verified 2026-07-14: slide 1 maps ingestion→UC-3/UC-7 and the renal
  re-tier→UC-4; the RAG slide maps guideline evidence→UC-9 — every shipped
  W2 capability lands on a named UC.)*

---

## 2. Extensions (E1–E5) — commitment status locked

| ID | Spec item | Status / decision |
|----|-----------|-------------------|
| E1 | *"Critic agent that rejects uncited claims or unsafe action suggestions."* | **Committed.** Week 1's deterministic citation gate + prescriptiveness lint promoted to the graph's answer-side critic node. Acceptance: no answer leaves the graph without passing the critic node; rejections logged with reason. H.6 (merged plan) adds gate-unit reject proof for page/page_bbox + guideline_evidence citations — 7 reject-path cases in `sidecar/test/gate.test.ts`; the gate rejected both on first run. |
| E2 | *"Click-to-source UI for citation snippets, with a simple document preview."* | **Delivered via R5** (required bbox overlay implies preview + click-to-source). Acceptance folded into R5. |
| E3 | *"A third document type such as referral fax or medication list."* | **Not committed** — framed "seam built, sequenced next" (schema enum + doc-type registry designed for extension; referral fax is the designed slot, UC-3). |
| E4 | *"Lab trend chart widget that uses extracted Observation data."* | **Not committed** this week — seam: extracted lab facts carry `{test_name, value, unit, collection_date}` sufficient for the panel's existing `Trends.tsx` pattern to consume later. |
| E5 | *"Contextual retrieval improvements such as better chunking, query rewriting, or domain-specific filters."* | **Committed** (scoped): structure-aware chunking + query rewriting + disease/laterality metadata filters (acceptance under S2/R3). |

**Spec ambiguity note (recorded so it can't drift):** the PDF's "Core
Deliverables" bullet list contains 10 items; the first 5 restate the MVP, the
last 5 (E1–E5) are the extension items — but R4's text explicitly says the
critic is "extension work, not core." We treat bullets 6–10 as extensions and
commit E1 + E5 by decision, deliver E2 via R5, and defer E3 + E4 with seams.

---

## 3. Deliverables (D1–D8)

| ID | Deliverable (spec wording condensed) | Acceptance criteria |
|----|--------------------------------------|---------------------|
| D1 | Repository: Week 1 fork with Week 2 changes, setup guide, deployed link, clear env-var documentation. *(Spec says "GitLab Repository"; this project is the GitHub fork — equivalence noted.)* | README separates **Week 1 baseline behavior vs Week 2 multimodal behavior**; graders can run the core W2 flow "without guessing which branch, environment variable, or service is required" — one setup section lists branch (`main`), all env vars (incl. `COHERE_API_KEY`, Langfuse/LangSmith keys, `AUTH_MODE`, dev-login), and both Railway services. **Shipped** — README restructured: W1-vs-W2 split, no-guessing quickstart, full 34-key env table, D1–D8 doc map. |
| D2 | `./W2_ARCHITECTURE.md`: document ingestion flow, worker graph, RAG design, eval gate, risks, tradeoffs. | Exists at repo root; also carries G8 testing strategy and G9 failure modes; cross-linked from README deliverables table. **Full draft committed this session.** |
| D3 | Schemas: Zod schemas for `lab_pdf` and `intake_form` incl. source-citation fields and validation tests. | Schemas per R2; validation test files exercising valid/invalid/missing-field/malformed-VLM cases; tests run in `sidecar-ci.yml`. |
| D4 | Eval dataset: 50 synthetic/demo cases with expected behavior, boolean rubrics, judge configuration, and results. | Cases + expected behavior + rubric category **and difficulty tier** per case committed under `sidecar/eval/`; judge config committed; results auto-regenerate `docs/execution/eval-results.md` (incl. coverage-by-difficulty + retrieval hit-rate/average-rank, CT2/CT3); reproducible from repo alone (G18). |
| D5 | CI evidence: Git Hook or equivalent that runs the eval suite and blocks regressions. | Pre-push hook (installable, documented) + `pull_request`-triggered required check; screenshot/log evidence of a blocked regression committed with the hard-gate rehearsal (S4/R6). |
| D6 | Demo video: 3–5 min showing document upload, extraction, evidence retrieval, citations, eval results, and observability. | Video link in README; walkthrough covers all six spec items in order; synthetic data only. **Script committed** (`docs/w2/demo-script.md`, 7 shots ≤4:30, REQ/UC captions); recording = human action. |
| D7 | Cost and latency report: actual dev spend, projected production cost, p50/p95 latency, bottleneck analysis. | `docs/COSTS.md` extended (or `docs/w2/cost-latency-report.md`): ledger-backed dev spend, per-doc extraction + per-query retrieval costs, p50/p95 for ingestion/retrieval/evidence-turn/fast-path vs SLOs, named bottleneck analysis, W1-vs-W2 comparison (G11). |
| D8 | Deployed application: publicly accessible with the Week 2 core flow working. | Railway URLs in README; `/ready` green (or explicitly degraded) incl. new dependency probes; upload→extract→cite flow demonstrable by a grader using README instructions alone. |

---

## 4. Engineering requirements (G1–G18) — graded, non-optional

### G1 — Contracts, schema evolution, data authority
> Spec: *"Every interface between Week 2 components — document ingestion, RAG
> retrieval, supervisor handoffs, FHIR writes — must have a typed contract...
> Any schema change from Week 1 must be accompanied by a migration note. Data
> authority must be explicit: one source of truth per data type, no silent
> overwrites."*

- [ ] Zod contracts on: upload API, ingestion job state, extraction outputs
  (R2), retriever query/response, graph state + handoffs, vitals write
  payload, citation v2.
- [x] `docs/w2/migration-notes.md` (or section in W2_ARCHITECTURE.md) records
  every schema change from Week 1 (citation v2 is the first entry).
- [x] Data-authority table (in W2_ARCHITECTURE.md §data-model): per data type —
  owner system, writers, readers, overwrite policy. Idempotent re-processing
  is wipe-and-rewrite by deterministic ID, never silent accretion.
  *(§10 as verified; overwrite policy = deterministic ids + wipe-and-rewrite.)*

### G2 — SLOs, timeouts, retries, circuit breakers
- [x] SLOs stated (locked): ingestion p95 ≤ 90 s/doc; retrieval p95 ≤ 2.5 s
  incl. rerank; evidence turns ≤ 5 s streamed; fast-path chat < 2 s first
  token + ≤ 0.4 s router. Measured against baselines (G11).
- [x] Every outbound LLM/VLM/embed/rerank/FHIR call has an explicit timeout +
  bounded retry (transient-error classification per Week 1's
  `isTransientAnthropicError` pattern; chat-path retry gap closed for new
  calls). Known Week 1 gap to not replicate: FHIR client has no timeout today
  *(closed by H.5, 2026-07-15: helper moved to `src/lib/httpRetry.ts`;
  FHIR/standard-API reads + token mints get 10 s timeout + one bounded
  retry; writes, uploads (30 s), and client registration get timeouts with
  NO auto-retry — a retried write can double-file a document; JWKS/
  introspection and the doc-write diagnostic script covered too).*
- [ ] Circuit-breaking behavior per dependency: after N consecutive failures,
  short-circuit with degraded response + `/ready` reflects it (simple breaker
  or documented equivalent fallback — no silent hammering).

### G3 — Schemas are canonical
- [x] Raw VLM output never bypasses validation: the only path from model
  output to persistence is through the R2 Zod parse; failures are
  logged + retried with validation feedback, then surfaced as ingestion
  failure — never stored partially.
  *(Shipped A.4 and re-verified in the 2026-07-14 sweep: extractor output
  reaches persistence only via the Zod parse; one validation-feedback retry,
  then `failed_validation` with nothing persisted — pinned by ingest tests
  and the schema_valid eval category.)*

### G4 — Correlation ID propagation
- [ ] The Week 1 correlation ID propagates into: upload request → OpenEMR
  document write → extraction job + VLM calls → graph supervisor + both
  workers → retrieval (embed/rerank) calls → vitals write → answer + citations.
- [x] *"A full multi-agent trace must be reconstructable from the correlation
  ID alone"* — demonstrated in docs with one worked example (log query +
  Langfuse trace link). *(`docs/w2/trace-example.md`: verbatim handoff lines
  from a real run, both tiers; Langfuse trace link joins at E.4.)*

### G5 — Structured logs, searchable
- [x] New W2 event types extend the Week 1 pino schema (no parallel
  convention — G12): `ingestion_started/completed/failed`,
  `extraction_field_outcome`, `retrieval_hit/miss`, `worker_handoff`,
  `eval_run_outcome`.
  *(Closed in the 2026-07-14 PDF sweep: ingestion stage changes log as
  `ingestion_<stage>` (incl. the three `failed_*` stages);
  `extraction_field_outcome` — one per field, positional labels, no values;
  `retrieval_hit`/`retrieval_miss` — query-hash + chunk_ids from every
  caller; `worker_handoff` (C wave); `eval_run_outcome` — structured JSON
  line per gate run. All exercised by tests + the PHI canary sweep.)*
- [x] Logs searchable by case ID, event ID, correlation ID; PHI-free (R7).
  *(Structured JSON throughout: every event carries `correlation_id` (+
  `ingestion_id` where applicable) and a stable event name as `msg` —
  greppable in Railway log search; eval case ids live in the committed
  results + `eval_run_outcome` categories. PHI-freedom is CI-verified by
  the `no_phi_in_logs` canary sweep, which captures these same streams.)*

### G6 — Dashboards
- [x] Dashboard (Langfuse + ops-status page) adds W2 tiles: document ingestion
  count, extraction field-level pass rate, retrieval hit rate, supervisor
  routing decisions (by outcome), eval pass/fail per category. *"The dashboard
  should tell a grader whether the system is healthy without reading logs."*
  *(Four W2 tiles on ops-status.html — static from eval output until the
  Langfuse key-drop; the graph span adapter is live code behind the keys.)*

### G7 — CI pipeline
- [x] On every PR to `main`: build, lint/typecheck, tests, coverage, **npm
  audit (dependency audit)**, **semgrep (security scan)** — note today
  `semgrep.yml`/`api-docs.yml`/`pre-commit.yml` are branch-filtered to
  `master`/`rel-*` and never fire on `main` PRs; W2 adds sidecar-scoped
  equivalents that do.
  *(Shipped: `sidecar-ci.yml` (test/typecheck/build ×2 legs + export parity)
  + `sidecar-security.yml` (npm audit high+, semgrep). Semgrep green'd
  2026-07-14: the Express direct-response-write XSS rule excluded as a
  Fastify-JSON false positive; one deliberate Railway TLS line suppressed
  with inline justification.)*
- [x] Contract tests for the supervisor–worker interface (G1) run in CI.
  *(`test/graph.test.ts` boundary-contract cases run in `sidecar-ci.yml` on
  every push + PR.)*
- [x] Extraction regression tests are part of the PR-blocking suite (S4/R6).
  *(13 extraction goldens run inside `Run eval suite` — a REQUIRED check on
  `main` since 2026-07-13.)*
- [x] Dependabot (or equivalent) covers `sidecar/` + `sidecar/panel/` (today it
  covers only `/` and `/ccdaservice`).
  *(Shipped: `.github/dependabot.yml` carries `/sidecar` and `/sidecar/panel`
  npm ecosystems.)*

### G8 — Testing strategy documented
- [ ] W2_ARCHITECTURE.md section: what is unit-tested (schema validators, tool
  functions, gate math), integration-tested (ingestion flow, RAG pipeline,
  graph), evaluated via golden set (agent behavior), and **not tested and
  why**; every test names the failure mode it guards against.
  *(§11 layer table verified 2026-07-14 — unit/contract/stubbed-integration/
  58-case golden/live-opt-in/baseline layers plus not-tested-and-why. Open
  strictly on the last clause: per-test failure-mode naming is not enforced
  test-by-test.)*

### G9 — Failure modes & incident response
- [x] W2_ARCHITECTURE.md section covering at minimum: document ingestion
  failures, extraction schema violations, RAG retrieval returning no results,
  supervisor routing errors — each with: how to identify in logs (event +
  correlation ID) and the recovery action.
  *(§12 verified 2026-07-14 — identification column corrected to the real
  emitted signals: `ingestion_<stage>` stage logs incl. the three
  `failed_*` stages, `evidence_degraded`, `worker_handoff` trail; each row
  carries its recovery action. Alerts A4–A6 with response actions live in
  docs/execution/observability.md.)*

### G10 — Runnable API collection
- [x] Bruno collection (`sidecar/api-collection/`) adds: document upload,
  extraction status, evidence retrieval, and the full W2 agent flow;
  runnable headless (`bru run`) against local + railway envs; auth'd write
  requests documented with dev-login flow.
  *(Shipped: `06-documents/` — dev-login → multipart upload of the committed
  renal fixture → staged status → stored file → evidence search, with a
  narrated full-flow doc; headless-runnable; Railway leg awaits
  DEV_LOGIN_SECRET there — USER-ACTIONS.md.)*

### G11 — Baseline profiles
- [x] Baselines recorded for W2 flows (ingestion, extraction, retrieval, full
  graph run) — latency p50/p95, CPU/memory where obtainable, throughput —
  and **compared against Week 1 baselines** (p95 46 ms @10 / 193 ms @50) to
  verify no regression in shared paths (`docs/execution/baselines.md`
  extended).
  *(`npm run baseline:w2`: ingestion 32.7 ms p95 / retrieval 0.78 ms p95 /
  graph 9.5 ms p95 on stub backends, honestly labeled; W1 floor evidenced
  byte-identical via git (no Postgres in this sandbox — re-measure command
  documented); live-backend numbers await the key drop.)*

### G12 — Consistent structured logging
- [x] No plain-text log output from W2 components; same pino schema/format;
  extended event vocabulary only (see G5).
  *(Verified 2026-07-14: every W2 module (ingest/, retrieval/, graph/, obs/,
  W2 routes) logs via the injected pino-shaped logger. The only console.*
  sites in src/ are Week 1-era bootstrap paths — config parse before the
  logger exists, migrate CLI — plus two structured-JSON wrappers; none are
  W2 components. H.3, 2026-07-15: the one gap at the wiring layer — the
  boot block handed raw `console` to LlmRouterModel/LlmAnswerComposer —
  now injects the structured graphLogBase instead, so the claim holds at
  the boot seam too.)*

### G13 — Distributed tracing hierarchy
- [x] Worker invocations are child spans of the supervisor span; extraction
  and retrieval sub-calls are children of their worker spans; verified
  visually in Langfuse (and LangSmith demo env) and by span-parent assertions
  in an integration test. *(Span-parent assertions shipped (H.7). Langfuse
  visual = USER-ACTIONS item 10 — a flat layout there reopens this box.
  LangSmith leg on hold with USER-ACTIONS item 4.)*

### G14 — Health/readiness
- [x] `/ready` adds probes: document storage (OpenEMR standard API
  reachability with the write-scoped client), vector index (pgvector/table
  presence + count), reranker API (Cohere reachability). Degraded status per
  dependency, not binary up/down (existing pattern extended). *(Shipped:
  document_storage = password-grant token mint (cached provider);
  retriever_index = fails on zero chunks; reranker (as-built by H.2,
  2026-07-15) = outcome of the last REAL rerank made by traffic — keyed
  but unexercised reports ok with detail "keyed (unverified since boot)",
  a failure newer than the last success reports failed/503; never a
  per-poll Cohere call (trial-key rate limits + per-call cost); unkeyed
  reports not_configured with the Passthrough fallback active. Absent
  probes degrade to not_configured, never binary-down.)*

### G15 — Alerts
- [x] Three new alert definitions with thresholds + documented response
  actions (extending `docs/execution/observability.md` A1–A3): **A4**
  extraction failure rate, **A5** RAG retrieval latency, **A6** eval
  regression (>5% category drop triggers alert as well as gate failure).
  *(A4–A6 committed in `docs/execution/observability.md`, same table as A1–A3.)*

### G16 — OpenAPI 3.0
- [x] Sidecar OpenAPI 3.0 spec committed (today the sidecar has **none**;
  `swagger/openemr-api.yaml` is core-only) covering all W2 HTTP endpoints
  (upload, ingestion status, retrieval/evidence, health/ready, chat entry);
  contract tests verify implementation matches the spec; kept in sync (CI
  freshness check mirroring the core `api-docs.yml` pattern).
  *(Shipped: `sidecar/openapi.yaml` — all 21 endpoints incl. the W2 surface;
  `test/openapi.test.ts` gates drift both directions (inventory↔spec) and
  probes registration; rides the normal CI suite.)*

### G17 — Integration tests, no live APIs
- [x] Full ingestion→answer integration test using fixture documents (stored
  PDFs/images) + stubbed VLM/LLM/embed/rerank responses; passes in CI with no
  live API access (extends Week 1's mocked-SSE pattern). *(Graph tests +
  `eval/graph-path.eval.ts`: committed fixture PDF → scripted VLM → real
  grounding → offline hybrid retrieval → critic → cited answer, keyless.)*

### G18 — Data model, privacy audit, backup/recovery
- [x] Data-model doc (W2_ARCHITECTURE.md): for each W2 artifact — extracted
  lab observations, intake facts, guideline chunks, citation records —
  defined owner (authoritative system), lineage (where it came from), access
  control (who reads/writes), validation rules.
  *(§10 verified against code 2026-07-13; the native-vitals row carries an
  honest TARGET annotation — seam shipped, server wiring pending.)*
- [x] Privacy audit: traces, logs, eval datasets, and cost reports contain
  **no patient identifiers, no raw document text, no extracted clinical
  values**; scrubbing approach documented; **verified in CI with a
  PHI-detection check** (canary-based, see S4/R6).
  *(Shipped: `no_phi_in_logs` canary sweep — planted name/DOB/family/allergy
  canaries over real pipeline runs — rides the REQUIRED gate (D.5); PHI-free
  retrieval-query scrubber + CI canary (B.5); eval corpora and COSTS
  artifacts are synthetic/identifier-free by construction.)*
- [x] Backup & recovery: automatic + manual procedures documented for
  extracted documents (OpenEMR-side + fact store), derived records, and the
  eval golden set; RPO/RTO estimates stated; fact store's derived-view
  wipe-and-rebuild property documented as the recovery primitive; **golden
  set reproducible from the repo alone** (no DB-only state).
  *(Shipped: RUNBOOK §E with an EXECUTED dump→drop→restore rehearsal
  (2026-07-13 — row counts verified, live reads post-restore), RPO/RTO
  stated, wipe-and-rebuild documented as the recovery primitive; the golden
  set and corpus are repo-committed. The register-time "runbook does not
  exist" gap is closed.)*

---

## 5. Pitfalls register (spec "Common Pitfalls and Watch-Outs" → standing anti-patterns)

| ID | Spec pitfall | Our guard |
|----|--------------|-----------|
| P1 | "Trying to support five document types before two work reliably." | Two types only; E3 deferred behind a seam. |
| P2 | "Using a VLM answer directly without schema validation or source metadata." | G3 + geometric grounding; unlocatable = unciteable. |
| P3 | "Letting the supervisor become a black box. Handoffs must be logged and explainable." | Handoff log events + routing reasons + span hierarchy (S3/R4, G13). |
| P4 | "Using llm-as-a-judge without clear rubric. Use boolean rubrics so failures are actionable." | Boolean-only rubrics; deterministic judges preferred; committed judge config (D4). |
| P5 | "Logging raw document text, patient identifiers, or screenshots to SaaS observability tools." | PHI-free trace policy + CI canary check; LangSmith fenced to synthetic-data demo env; self-hosted Langfuse documented as pilot posture (R7, G18). |

**HIPAA framing (spec):** demo/synthetic data only; do not log raw PHI; treat
prompts, extracted fields, document images, traces, and screenshots as
sensitive.

---

## 6. Locked decision register (user-confirmed, 2026-07-13)

| # | Decision | Choice | One-line rationale |
|---|----------|--------|--------------------|
| 1 | Orchestration | LangGraph.js StateGraph; nodes wrap existing services | Spec-named, inspectable, zero business-logic rewrite |
| 2 | Tracing | Langfuse (Cloud for demo, self-hosted documented) + LangSmith demo-env only | Continuity + grader visuals without posture reversal |
| 3 | RAG vendors | Cohere embed + Cohere Rerank | One new vendor; the reranker the spec names |
| 4 | Chat routing | Supervisor-as-entry cheap router (~200–400 ms; deterministic short-circuits) | Routing visible every turn; fast path bounded |
| 5 | EHR writes | Docs → OpenEMR; facts → fact store; intake vitals → native vitals; lab authority documented | Matches verified API surface; no silent authority violation |
| 6 | Corpus | 6–10 authored practice protocols grounded in named AAO guidelines | License-clean, PHI-free, repo-reproducible |
| 7 | Upload surface | Panel drag-drop (front-desk persona) | One coherent demo surface; R5 needs the preview anyway |
| 8 | Demo patient | Retrofit existing corpora; hero = HCQ patient; renal-panel→eGFR→HCQ-risk lab arc; one patient carries both docs | Deepest tie to shipped engines (UC-4) |
| 9 | Gate mode | Stubbed deterministic PR gate + live suite scheduled/pre-milestone | A gate that always runs is the only gate that always blocks |
| 10 | Case mix | Extraction-weighted 20/10/8/7/5 | Weight the new multimodal surface |
| 11 | Gate math | Tiered: safety hard-fail per case; quality >5%-vs-baseline or threshold | Spec's letter, exceeded where it matters |
| 12 | SLOs | Stated now: 90 s / 2.5 s / 5 s / <2 s+0.4 s | Decisive defense; revise against baselines at MVP |
| 13 | Extensions | Commit E1 (critic node) + E5 (contextual retrieval); E2 via R5; defer E3/E4 with seams | Narrower and stronger |
| 14 | Demo auth | Enforce writes only (dev-login bearer + role) | No public unauthenticated EHR write path |
| 15 | Langfuse home | Cloud now (synthetic), self-host as pilot path | Fastest to live traces; posture documented |
| 16 | Budget | Keep $5/day SpendGuard | Free tiers expected to suffice; alert user if not |
| 17 | Doc scope today | Full W2_ARCHITECTURE.md draft | Defense reference sheet |
| 18 | Execution plan | Wave-based, no day framing, aggressive parallelization | Sequencing by MVP/Early/Final expectations |
| 19 | API keys | Cohere/LangSmith/Langfuse available before build | No stub-blocked sequencing needed |
| 20 | Defense format | ~5 minutes, 6 slides, content-only | Per user; density set accordingly |
