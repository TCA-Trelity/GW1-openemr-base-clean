# Week 2 Architecture — Multimodal Evidence Agent

*How the Clinical Co-Pilot learns to read the documents Dan's front desk
actually receives — a scanned outside lab and a paper intake form — route the
work across a small supervisor/worker graph, ground every claim in retrievable
evidence, and prove it all with a PR-blocking eval gate.*

*This document is the Week 2 counterpart to [`ARCHITECTURE.md`](ARCHITECTURE.md)
(Week 1 baseline, which remains accurate for everything it covers). Requirements
and acceptance criteria: [`docs/w2/requirements.md`](docs/w2/requirements.md)
(the canonical anti-drift register — REQ IDs cited throughout). Sequencing:
[`docs/w2/execution-plan.md`](docs/w2/execution-plan.md). Defense:
[`docs/w2/defense-outline.md`](docs/w2/defense-outline.md).*

**Status discipline.** Week 1's docs drifted from code in four known places
(see §16). This document prevents a repeat by marking every subsection:
**[SHIPPED]** exists in code today · **[TARGET]** designed here, built in the
waves. Statuses flip in the same PR that lands the code.

---

## 1. Summary

Week 1 built a brief-first, tool-using clinical agent beside an untouched
OpenEMR: preparation runs where time is free (the 5–20-minute waiting gap), a
deterministic citation gate sits between generation and display, and chat
answers from prepared facts in under two seconds. All of that stands.

Week 2 adds three capabilities the assignment mandates and the product needed
anyway (REQ: S1–S5):

1. **Multimodal ingestion** — `attach_and_extract` takes a scanned lab PDF or
   intake form, stores the original in OpenEMR (the record keeps the source of
   truth), extracts strict-schema facts with a vision model, and **grounds
   every extracted value in the document's own OCR geometry** before it may be
   cited. The VLM proposes; deterministic geometry disposes.
2. **Hybrid RAG over practice guidelines** — a small authored corpus of
   practice protocols (grounded in named AAO guidelines) indexed
   keyword+dense in the Postgres we already run, fused, and reranked with
   Cohere. Patient facts still ship whole-context; guidelines were never
   patient-shaped, which is why Week 1 left pgvector as declared headroom.
3. **A supervisor/worker graph** — LangGraph.js, three nodes (supervisor,
   intake-extractor, evidence-retriever) plus Week 1's gate promoted to the
   answer-side critic. The supervisor fronts every ask with a bounded, logged
   routing decision; the expensive branches run at prep/tool time.

Quality is enforced by growing the 24/24 eval harness into a **50-case,
five-category, PR-blocking gate** with tiered regression math — rehearsed
against injected regressions before graders inject theirs (REQ: S4/R6).

Governing rule, unchanged: **the system may be unavailable; it may never be
silently wrong.**

## 2. Why the architecture evolves (and why it is not a reversal)

Week 1 rejected two things Week 2 now ships. Both rejections were scoped, and
both scopes still hold:

- **"Whole-patient context over vector search"** was an argument about *one
  patient's facts*. The guideline corpus is practice-scoped, versioned,
  cross-patient knowledge — the exact "corpus outgrows the context" headroom
  case Week 1 named when it installed pgvector and left it dark. Patient facts
  still ship whole; guidelines are retrieved, reranked, and cited at chunk
  granularity. The shipped precedent: UC-9 already answers "per AAO screening
  guidelines…" from attribution hardcoded in the arithmetic engines — RAG
  generalizes one hardcoded guideline into 6–10 with the same provenance
  discipline (REQ: S2/R3).
- **"No multi-agent orchestration"** was an argument about the latency-critical
  chat loop. Week 2's new work genuinely branches (extract vs. retrieve vs.
  answer), the assignment grades the inspectability of that branching, and the
  heavy branches run where time is free. The graph is the smallest one that
  can be called a graph, its nodes wrap services that already exist, and the
  fast path pays only a bounded ~200–400 ms routing decision (REQ: S3/R4).

## 3. Document ingestion flow (REQ: S1/R1, R2, G3) — [SHIPPED: upload route + attach_and_extract service, VLM extractor w/ feedback retry, geometric grounding on real fixtures, fact persistence w/ page_bbox citations, patient-mismatch block, dedupe idempotency, renal→HCQ re-tier, evidence pinning at prep time (C.6) · TARGET: chat tool wrapper, live EHR write + vitals row (deploy), brief refresh]

```
panel upload (front-desk role)                    chat/graph tool
POST /api/patients/:pid/documents  ──────────►  attach_and_extract(patient_id, file, doc_type)
        │  multipart: file + doc_type ∈ {lab_pdf, intake_form}
        ▼
 1. store original in OpenEMR Documents        ◄── OpenEMR = system of record for the file
    (standard API, password-grant client,          POST /api/patient/:pid/document?path=<category>
     user/document.write scope)
 2. sha3-512 dedupe (caller-side)              ◄── OpenEMR stores the hash but doesn't enforce it;
    byte-identical re-upload → existing id         sidecar checks the category listing first
 3. enqueue extraction job (in-process prep        deterministic source_documents.id from content
    pipeline, same pattern as Week 1 prep)         hash → re-process is wipe-and-rewrite, never accrete
        ▼
 4. VLM extraction (Claude vision, PDF/image pages)
        ▼
 5. strict Zod parse — LabPdfExtraction | IntakeFormExtraction
    fail → one validation-feedback retry → ingestion_failed (never partial persistence)
        ▼
 6. geometric grounding (deterministic, code not model):
    locate each extracted value in OCR word boxes → page + bbox citation
    else page-level VLM citation → page-region citation
    else → fact flagged unverified: visible, never citable
        ▼
 7. persist: facts → fact store (with provenance + confidence)
             intake height/weight/BP → native OpenEMR vitals write
             evidence pinning: extraction findings trigger evidence-retriever
             (e.g. hydroxychloroquine in meds → screening protocol pinned to bundle)
        ▼
 8. brief refresh + panel Sources tab shows document preview w/ bbox overlays
```

Design notes:

- **The schema is the source of truth, not what the model returns** (REQ: G3).
  The only path from VLM output to persistence is the Zod parse; a failure is
  retried once with validation feedback, then surfaced as `ingestion_failed`.
- **Grounding extends the Week 1 gate to pixels.** Week 1's gate verifies every
  cited span verbatim against stored text. Week 2 applies the same posture to
  vision: an extracted value must be *found in the document* (word-box match;
  page-level fallback) or it renders unverified and uncitable. This inherits
  the `describe_scan` quarantine lineage — model vision is untrusted until
  deterministically grounded (REQ: R5).
- **Three visibly distinct citation outcomes**: tight bbox overlay / page-region
  highlight / present-but-unverified. The UI never fakes precision it doesn't
  have.
- **Ophthalmology content (locked):** hero flow = existing HCQ-monitoring
  patient; lab fixture = outside renal/metabolic panel whose declining eGFR
  re-tiers hydroxychloroquine toxicity risk through the shipped
  `check_med_risk` engine (UC-4); intake fixture = updated intake for the same
  patient (med change, new allergy, family-history addition, patient-goals
  line → UC-7). An HbA1c panel ships as an additional eval fixture.

**OpenEMR write surface (verified, constrains the design):** this fork's FHIR
API is read-only except Patient/Organization/Practitioner — there is **no
FHIR Observation create and no lab-result write path**; the only
observation-shaped write is the fixed-field vitals endpoint. Hence the
persistence split above, with data authority declared per type (§10) rather
than shoehorning lab values into fields that don't fit.

## 4. The worker graph (REQ: S3/R4) — [SHIPPED: `sidecar/src/graph/` — 5-node StateGraph, deterministic router + LlmRouterModel tie-break (never-throw, fast_path-safe), Zod boundary contracts w/ GraphContractError, ≤5 s evidence budget w/ degraded handoff, per-patient pin store keyed to ingestion, worker_handoff events (worked example: docs/w2/trace-example.md); 15 tests · TARGET: ChatService fast_path delegation + production composer (answer leg), Langfuse span binding (E.4), routing-latency baseline]

**Framework:** LangGraph.js `StateGraph` inside the existing TypeScript
sidecar. Nodes wrap existing services — the direct Anthropic client, Zod
contracts, and the gate layer are unchanged. LangGraph orchestrates; it does
not replace.

**Nodes:**

| Node | Wraps | Responsibility |
|---|---|---|
| `supervisor` | new (thin) | One routing decision per ask: `fast_path` \| `needs_evidence` \| `needs_extraction`; decides when the final answer is ready |
| `intake-extractor` | ingestion pipeline (§3) | Document → validated, grounded, persisted facts |
| `evidence-retriever` | hybrid RAG (§5) | PHI-free query → top-k reranked guideline chunks with metadata |
| `critic` (gate) | `sidecar/src/gate/` [SHIPPED, promoted] | Rejects uncited claims (withhold-at-server) + prescriptiveness lint — the spec's "critic agent" delivered as proven code, not a fourth LLM (REQ: E1) |
| `answer` | chat answer path | Composes the reply from prepared facts + pinned/retrieved evidence, citations attached |

**Routing tiers (locked decision #4):**

- **Tier 0 — fast path.** Deterministic short-circuits (e.g. brief lookups,
  pure record questions, follow-ups with no evidence need) plus a small Haiku
  routing call when rules don't decide: **~200–400 ms**, then the unchanged
  Week 1 chat loop. Most guideline asks also land here because evidence was
  **pinned at ingestion** (extraction findings trigger retrieval during prep,
  so the protocol is already in the bundle).
- **Tier 1 — evidence turn.** `needs_evidence` → evidence-retriever runs one
  hybrid+rerank pass (~0.3–0.8 s) inside a **≤ 5 s** streamed turn ("checking
  practice protocols…" status visible). Timeout → the answer says
  "answering from the record only; guidelines unreachable" — degraded, stated,
  never silent.
- **Tier 2 — prep-time graph.** Document upload events enter the graph
  directly; extraction + evidence pinning + brief refresh run inside the
  5–20-minute waiting gap (**≤ 90 s/doc p95** budget).

**Inspectability (REQ: G4, G13, P3):** every handoff emits a structured log
event `{correlation_id, from, to, routing_reason}`; worker invocations are
child spans of the supervisor span; extraction/retrieval sub-calls are children
of their worker spans. One correlation ID reconstructs the full multi-agent
trace — the spec's test, verbatim.

## 5. Hybrid RAG design (REQ: S2/R3, E5) — [SHIPPED: hybrid BM25+dense → RRF → Cohere rerank behind injectable backends, PHI query scrubber + CI canary, disease-tag filters, coverage floor w/ stopword-hardening, /api/evidence/search, retrieval goldens · TARGET: pgvector/tsvector backends at deploy (0.1), production composer (answer leg, chat integration)]

**Corpus (locked decisions #3, #6).** 6–10 short authored **practice-protocol
documents** — "agreed clinical practices the office follows" — each grounded
in and citing named real guidelines: AAO Preferred Practice Patterns
(Diabetic Retinopathy, AMD, Retinal Vein Occlusion), the AAO
hydroxychloroquine-retinopathy screening recommendation, and an anti-VEGF
treat-and-extend protocol. Authored in-house → license-clean for a public
repo, zero PHI, fully reproducible from the repo (REQ: G18). Metadata per doc:
`{guideline_source, section, recommendation_strength, disease_tags,
laterality_applicability, version/date}` — guidelines get revised, so version
rides every citation.

**Chunking.** Structure-aware: thresholds stay with their conditions
(dose cutoffs, screening intervals, staging tables never split from their
qualifying text); section headers prefix chunk text; stable `chunk_id`s.
Clinical text is threshold-dense — this is where generic chunkers fail hardest.

**Index.** The Postgres the fact store already runs on: `pgvector` for dense
(Cohere embeddings) + `tsvector` full-text for keyword. No new infra service.
pgvector availability on Railway Postgres is **verified on day one**; the
fallback at this corpus size (10²–10³ chunks) is an in-process cosine scan
behind the same retriever interface.

**Retrieval.** Parallel keyword + dense → reciprocal-rank fusion →
**Cohere Rerank** → top-k (k ≤ 5) chunks to the answer model. Hybrid is not
decoration here: clinical queries are terminology-dense (Plaquenil ↔
hydroxychloroquine, DME, OD/OS) — exact-match strength for drug names and
doses, semantic match for phrasing, and the reranker makes top-3 actually
on-point since only top-k is fed forward. **Contextual retrieval (committed,
REQ: E5):** query rewriting + disease/laterality metadata filters.

**Grounding split (the assignment's "evidence grounding" hard problem).**
`patient_record` and `guideline_evidence` are distinct citation
`source_type`s end-to-end: separate stores, separate rendering, and the gate
enforces that claims about *this patient* cite patient sources while claims
about *practice standards* cite guideline chunks. Guideline citations verify
quote-vs-stored-chunk through the same deterministic gate as record citations.

**PHI boundary (REQ: P5, G18).** The corpus is public text; the only
patient-adjacent data that could reach Cohere is the query. Queries are
constructed from de-identified clinical concepts only (drug, dose band,
disease stage, interval math — no names/DOB/MRN), enforced by a
**deterministic scrubber in code** plus a CI canary check (`no_phi_in_queries`
alongside `no_phi_in_logs`). Patient-document extraction runs entirely on the
Anthropic BAA path; Cohere never sees documents or facts.

**Stretch explicitly not built:** ColQwen2 / multi-vector visual retrieval.
The seam exists (embeddings live in their own table keyed by source id), but
retrieval over scan pixels is sequenced behind the two document types working
reliably (REQ: P1).

## 6. Citation contract v2 (REQ: R5) — [SHIPPED: schema v2 + gate narrowing + panel mirrors (A.2) · TARGET: grounding producer (A.5) and overlay UI (E.2)]

Extends the shipped `CitationRefSchema` (`sidecar/src/schemas/citations.ts`)
— migration note per G1:

- `source_type` adds `guideline_evidence` (enum already carries `lab_report`,
  `referral_letter`, `intake_transcript`, …).
- Adds the spec's minimum shape fields: `{source_type, source_id,
  page_or_section, field_or_chunk_id, quote_or_value}`.
- `excerpt_location` gains a `page_bbox` variant `{page, x, y, w, h}`
  (normalized) alongside `character_range`.
- **Visual PDF bounding-box overlay is required-core:** clicking a document
  citation opens the stored page with the cited region highlighted — which
  also delivers the click-to-source extension (REQ: E2) on the same surface.

Enforcement is unchanged in kind: the deterministic gate verifies citations
server-side and withholds unverified ones before any client sees them — now
across three source classes (record text, document extractions, guideline
chunks).

## 7. Eval gate (REQ: S4/R6, D4, D5) — [SHIPPED: 58 deterministic cases across 14 suites, ALL six categories measured + baselined; extraction goldens over committed fixtures, full-path graph goldens (D.3), PHI log-capture sweep (D.5), all 5 corpora wired; PR trigger + pre-push hook (D.4); hard-gate rehearsal proven — 3 injected regressions caught (`npm run gate-rehearsal`, docs/w2/gate-rehearsal.md) · TARGET: branch-protection required-check flip (user 0.5), scheduled live-model suite]

**From 24 to 50.** The shipped harness (`sidecar/eval/`,
`EvalRecord{metric, value, threshold, pass}`, deterministic, auto-generating
`docs/execution/eval-results.md`) grows to 50 committed cases,
extraction-weighted (locked #10): ~20 extraction (lab + intake, incl. ≥1
deliberately degraded scan and near-miss values), ~10 retrieval/grounding, ~8
citation integrity, ~7 refusal + missing-data honesty, ~5 PHI/safety. The
three authored-but-idle corpora (`james-whitfield`, `patricia-okafor`,
`robert-alvarez`) get wired in.

**Categories (boolean, per spec):** `schema_valid`, `citation_present`,
`factually_consistent`, `safe_refusal`, `no_phi_in_logs`, plus
`retrieval_grounded`. Deterministic judges preferred; any LLM-judge is
boolean-rubric with committed config (REQ: P4).

**Tiered regression math (locked #11).** Safety categories (`safe_refusal`,
`no_phi_in_logs`, `citation_present`) hard-fail the build on **any**
newly-failing case. Quality categories (`schema_valid`,
`factually_consistent`, `retrieval_grounded`) fail on **>5% drop vs the
committed per-category baseline or below the absolute pass threshold** — the
spec's letter, exceeded where it matters.

**PR-blocking (the honest delta).** Today evals run on push only, with no
hooks installed anywhere and no baseline math. This week: the eval workflow
triggers on `pull_request` and becomes a required check on `main`, **and** a
pre-push git hook runs the same suite locally (the spec says "Git Hook" — we
ship both). The PR suite is fully deterministic on stubbed VLM/LLM/embed/rerank
fixtures — no live keys in CI (REQ: G17); the live-model suite runs on
dispatch/schedule and before milestones (locked #9): a flaky, token-billed PR
gate gets disabled within a week, and a disabled gate blocks nothing.

**The hard gate, rehearsed.** Graders will inject a regression and expect the
gate to fail. We rehearse first: break a schema field (`schema_valid` trips),
drop a citation (`citation_present` hard-fails), plant a canary identifier in
a log line (`no_phi_in_logs` hard-fails). Three injections, three categories,
documented and repeatable (REQ: D5 evidence).

## 8. Observability & cost (REQ: R7, G4–G6, G13, G15) — [TARGET on top of SHIPPED spine]

**Shipped spine:** correlation IDs end-to-end (`server.ts`), pino structured
logs, `llm_calls` cost ledger + `SpendGuard` ($5/day, unchanged — locked #16)
+ `GET /api/usage`, `prep_runs` stage tracking, Langfuse client wired into
prep (emit-side) but **not deployed**.

**Week 2 additions:**

- **Langfuse activated** (locked #2/#15): Cloud project for the synthetic-data
  demo now, self-hosted deploy documented as the pilot posture ("traces never
  leave the boundary"). Spans extend beyond prep to supervisor → workers →
  extraction/retrieval sub-calls (G13 hierarchy). **LangSmith is fenced to the
  demo environment only** for LangGraph-native visuals — never the committed
  production posture (REQ: P5).
- **New log events** (same pino schema — G12): `ingestion_started/completed/
  failed`, `extraction_field_outcome`, `retrieval_hit/miss`, `worker_handoff`,
  `eval_run_outcome`.
- **Per-encounter record** reconstructable from one correlation ID: tool/worker
  sequence, latency by step, tokens, cost estimate, retrieval hits
  (query-hash + chunk_ids + scores — never patient text), extraction
  confidence (per doc + per field), eval outcome.
- **Dashboard tiles** (extending `docs/execution/observability.md`): ingestion
  count, extraction field-level pass rate, retrieval hit rate, routing
  decisions by outcome, eval pass/fail per category.
- **Alerts A4–A6** (with response actions, extending A1–A3): extraction
  failure rate; RAG retrieval latency; eval regression >5%.
- **Cost tracking:** extraction and Cohere calls priced into the ledger so the
  D7 report is ledger-backed. Projections: extraction ~$0.03–0.10/doc, corpus
  embedding ~one-time, rerank ~$0.002/query → ~$20–25 per 70-patient day vs
  Week 1's ~$20.

**Trace privacy rule (spec, verbatim intent):** traces, logs, eval datasets,
and cost reports contain no patient identifiers, no raw document text, and no
extracted clinical values — identifiers and hashes only, verified by the CI
canary check (REQ: G18).

## 9. SLOs, resilience, readiness (REQ: G2, G14) — [TARGET]

| Flow | SLO (p95) | Where the budget lives |
|---|---|---|
| Document ingestion (upload → facts + pinned evidence) | ≤ 90 s/doc | Inside the 5–20-min waiting gap |
| Evidence retrieval (hybrid + rerank) | ≤ 2.5 s | Tool time, streamed status |
| Evidence chat turn (full answer) | ≤ 5 s | Tier 1, visible progress |
| Fast-path chat first token | < 2 s (+ ≤ 0.4 s router) | Unchanged Week 1 target |
| Week 1 read path (regression floor) | p95 46 ms @10 / 193 ms @50 | Measured baseline, must hold |

- **Timeouts + bounded retries on every outbound call** — VLM, embed, rerank,
  FHIR, vitals write (closing the Week 1 gap where the FHIR client had no
  timeout and chat had no retry: new calls all get the
  transient-classification retry pattern).
- **Circuit behavior:** after N consecutive failures of a dependency, the
  caller short-circuits to its degraded path and `/ready` reflects the
  dependency as degraded (no silent hammering, no binary up/down — G14).
- **`/ready` additions:** document storage (write-scoped OpenEMR client),
  vector index (extension/table presence + chunk count), reranker (Cohere
  reachability) — joining the existing OpenEMR/Anthropic/Langfuse/Postgres
  probes.

## 10. Data model, authority, lineage (REQ: G1, G18) — [TARGET]

| Artifact | Authoritative owner | Writers | Readers | Lineage | Validation |
|---|---|---|---|---|---|
| Source document (PDF/image) | **OpenEMR Documents** | sidecar ingestion (password-grant, `user/document.write`) | sidecar, OpenEMR UI | upload event, sha3-512, uploader role, correlation ID | mime/size checks; category must exist |
| Extracted lab observations | **Fact store** (derived view; no API path into native lab tables — declared, not fudged) | intake-extractor only | brief, chat, panel, evals | `source_document_id` + page/bbox + extraction confidence + model + prompt version | `LabPdfExtraction` Zod parse + geometric grounding |
| Intake facts | **Fact store**; height/weight/BP also round-trip to **OpenEMR vitals** (native write) | intake-extractor; vitals writer | brief, chat, panel, evals; OpenEMR UI (vitals) | as above | `IntakeFormExtraction` parse + grounding |
| Guideline chunks | **Repo** (authored corpus is source; index is derived) | ingest script | evidence-retriever | doc → chunker version → chunk_id; guideline version/date | chunk schema; metadata required |
| Citation records | **Fact store** | gate-verified paths only | panel, evals | citation v2 schema with verification status | deterministic gate |
| Eval golden set | **Repo** (reproducible alone — G18) | humans via PR | eval runner, CI | case files + fixtures + baseline JSON | schema-checked at load |

**Overwrite policy (G1 "no silent overwrites"):** all derived stores use
deterministic IDs + wipe-and-rewrite on re-processing (the shipped
`ehrSync.ts` pattern); OpenEMR documents are append-only with caller-side
hash dedupe. Schema changes from Week 1 carry migration notes — the first is
citation v2 (§6).

## 11. Testing strategy (REQ: G8) — [TARGET]

| Layer | What | Failure mode it guards |
|---|---|---|
| Unit | Zod schema validators (R2); grounding matcher (value→word-box); RRF fusion math; gate-math comparator (tiered rules); query scrubber | Malformed VLM output persisted; citation pointing at absent text; regression math drift; PHI in queries |
| Contract | Supervisor↔worker state schema; OpenAPI-vs-implementation (G16); citation v2 backward compatibility | Graph state drift; spec/implementation divergence; breaking Week 1 clients |
| Integration (stubbed — G17) | Full upload→extract→ground→persist→pin→answer path on fixture documents with stubbed VLM/LLM/embed/rerank; vitals write against a mocked OpenEMR | End-to-end wiring breaks that unit tests can't see; CI must pass with no live APIs |
| Golden set (evals) | 50 boolean cases across six categories (§7) | Behavior regressions — the graders' injected regression class |
| Live (opt-in, pre-milestone) | `LIVE_EVALS=1` behavioral suite + live smoke on Railway | Model-behavior drift the stubbed gate cannot see |
| Load/baseline | `npm run load-test` extended to ingestion/retrieval endpoints (G11) | Latency regressions vs Week 1's measured floor |

**Not tested, and why:** pixel-accuracy of bbox *rendering* (visual QA in the
demo checklist — automating screenshot diffs is not worth the flake this
week); Cohere ranking *quality* beyond the golden retrieval cases (vendor
model, covered by `retrieval_grounded` outcomes, not re-benchmarked);
OpenEMR's own document storage internals (upstream-tested; we test our client
contract against it).

## 12. Failure modes & incident response (REQ: G9) — [TARGET]

| Failure | How you see it (logs/traces) | Recovery action |
|---|---|---|
| Document ingestion fails (upload/OpenEMR write) | `ingestion_failed` event + correlation ID; `/ready` doc-storage probe degraded if systemic | Panel shows failed state with reason; retry is safe (hash dedupe); if OpenEMR write path is down, uploads queue as failed-visible — never half-ingested |
| Extraction schema violation | `extraction_field_outcome` failures; ingestion ends `ingestion_failed` after one validation-feedback retry | Nothing persisted; fixture-replay the document locally; fix schema/prompt; re-upload is idempotent |
| Extraction grounding misses (bad scan) | Facts flagged `unverified` with per-field confidence in trace | No action required for safety (unverified = uncitable); improve fixture/OCR handling; the degraded-scan eval case pins expected behavior |
| RAG returns no results | `retrieval_miss` event with query-hash | Answer states "no protocol on file for this question" (never silently answers from parametric knowledge); check corpus coverage; add protocol doc if genuinely missing |
| Reranker/embedding API down | Retrieval span error; circuit opens; `/ready` reranker degraded | Tier-1 turns degrade to "record-only, guidelines unreachable"; keyword-only fallback path may serve pinned evidence; recovers automatically on probe success |
| Supervisor routing error (wrong worker / loop) | `worker_handoff` trail under one correlation ID makes the misroute visible; round caps bound loops | Graph state is per-ask and disposable — no persistence to clean; fix routing rule/prompt; add the transcript as an eval case |
| Eval gate false-positive blocking a PR | Category comparison in the gate report artifact | Baselines are committed — a deliberate re-baseline is a reviewed diff, never an env flag that skips the gate |
| pgvector unavailable at deploy | Day-one probe fails; `/ready` vector-index degraded | Flip retriever backend to in-process scan (same interface); file infra follow-up; corpus size makes this a non-event |

(Existing Week 1 failure rules — prep didn't run, model down, EHR unreachable —
are unchanged; see `ARCHITECTURE.md` §9.)

## 13. Security & privacy posture (REQ: G18, P5) — [TARGET deltas on SHIPPED model]

- **Auth (locked #14):** write paths (document upload, vitals write, fact
  verification) require a dev-login bearer with role gate (front-desk/physician)
  even in the open demo; read/chat surfaces stay open for graders. The Week 1
  SMART/dev-token dual-path verifier and cross-patient 403 are unchanged.
- **Prompt injection:** uploaded documents are the new injection surface and
  get the Week 1 treatment — document text is data to quote and cite, never
  instructions; the blast radius stays capped by the patient-bound credential,
  the write-scoped-but-narrow toolset (vitals only, fixed fields), and the
  citation gate. Injection-resistance eval cases extend to document
  ingestion.
- **PHI discipline:** synthetic data only; prompts, extracted fields, document
  images, traces, screenshots treated as sensitive per the spec; the
  scrubber + CI canary checks make the policy executable (§7, §8).
- **Vendor boundary:** Anthropic (BAA-assumed) sees documents; Cohere sees
  only public corpus text and scrubbed concept queries; LangSmith sees only
  the synthetic demo environment; Langfuse Cloud sees synthetic-demo traces
  with the self-hosted posture documented for pilot.

## 14. Backup & recovery (REQ: G18) — [TARGET]

- **Postures by store:** OpenEMR (documents + vitals) is the system of record —
  its existing DB/documents backup guidance applies (deploy runbook). The fact
  store is a **derived view**: the recovery primitive is wipe-and-rebuild
  (re-sync from EHR + re-run ingestion on stored documents), which also makes
  rollback safe. The guideline corpus and eval golden set live **in the repo**
  — recovery is `git checkout`; the index rebuilds from the corpus by script.
- **Automatic:** Railway Postgres scheduled backups (fact store) — enable +
  document; repo is inherently versioned.
- **Manual:** documented `pg_dump`/restore procedure for the fact store; the
  rebuild-from-record procedure as the preferred path.
- **Estimates:** RPO — fact store ≤ 24 h via scheduled backup but effectively
  ~0 for anything rebuildable (rebuild recomputes from sources); RTO —
  restore ≤ 30 min, full re-prep of the demo corpus ≤ 1 h.
- **Invariant (spec):** the eval golden set is reproducible from the repo
  alone — it never lives only in a database.

## 15. Risks & tradeoffs

| Risk | Mitigation (with first-day verification where applicable) |
|---|---|
| pgvector not available on Railway Postgres (Week 1 "installed" was a doc claim) | Verify day one; in-process cosine fallback behind the same interface — trivial at 10²–10³ chunks |
| Degraded scans defeat OCR grounding | The ladder degrades visibly (bbox → page → unverified); a degraded-scan eval case pins behavior; wrong facts cannot enter citations by construction |
| OpenEMR write path friction (`user/document.write` not yet registered; standard API rejects client-credentials) | Register scope + integration-test the password-grant client first (Wave A); vitals payload already exists in `standardApi.ts` |
| Stubbed PR gate blind to live-model drift | Deliberate split: live suite pre-milestone + verification-rate alert (A-series) in traces |
| Supervisor becomes a black box (spec pitfall) | Handoff events + routing reasons + span hierarchy are acceptance criteria, not aspirations |
| LangGraph dependency surface in a deliberately lean codebase | Adopt the graph, not the ecosystem: nodes wrap our services; direct Anthropic client stays; removal path is a thin dispatcher |
| SaaS trace exposure (LangSmith/Langfuse Cloud) | Synthetic data only; PHI-free trace rule + CI canary; self-hosted Langfuse documented as pilot posture |
| $5/day budget pressure from vision extraction iteration | Free tiers expected to cover Cohere/LangSmith/Langfuse; ledger tracks per-purpose spend; **explicitly alert the user** if the cap threatens the schedule (locked #16) |

## 16. Week 1 debt register (spec: "documented and resolved before adding new surface area")

| Debt (doc claim ≠ code) | Week 2 treatment |
|---|---|
| BullMQ/Redis queue (docs claim; in-process async shipped) | **Documented, stays.** Ingestion uses the same in-process prep pattern deliberately; queue remains the scale path, not this week's need |
| Object storage for scans (docs claim; local seed images shipped) | **Documented, stays.** Week 2 documents live in OpenEMR — which is the requirement itself; object storage remains deferred |
| SMART browser EHR-launch (docs claim; dev-login + name-matched iframe shipped) | **Documented, stays.** Dev-login exercises the full auth model incl. cross-patient 403; write-path auth enforcement (locked #14) tightens the demo posture |
| Langfuse deployed (docs claim; emit-side only) | **Resolved this week** — activation is first on the critical path because Week 2's grading depends on traces (§8) |

## 17. Deliberately out of scope (REQ: P1; spec final note)

Third document type (referral fax is the designed-next slot — schema enum and
doc-type registry are extension points); ColQwen2/multi-vector visual
retrieval (seam: embeddings table keyed by source id); lab-trend chart widget
(extracted lab facts already carry the fields `Trends.tsx` would need);
graph in the fast path beyond the bounded router; SaaS traces near real
patient data; raising the $5/day budget. *"The best submissions will feel
narrower than the original spec and stronger because of it."*
