# Week 2 Architecture Defense — 6-Slide Outline (Content Only)

*Format: ~5-minute defense. Each slide = one headline claim + 3–4 on-slide beats;
talk track and the anticipated attack live in the notes below each slide. Design
is handled elsewhere — this file is content. Deck title suggestion:*
**Seeing Documents, Routing Work, Gating Change — Week 2 Without Breaking Week 1.**

*Decisions this deck reflects are locked in
[`docs/w2/requirements.md`](requirements.md) (requirements register) and
[`../../W2_ARCHITECTURE.md`](../../W2_ARCHITECTURE.md) (full architecture).*

*For Q&A of the form "where does course technique X live in the code?": [`docs/w2/gauntlet-alignment.md`](gauntlet-alignment.md) indexes every technique's implementing file and status.*

---

## Slide 1 — Same Doctor, Same Thesis, New Inputs

**Headline:** Week 2 teaches Dan's existing co-pilot to read the two documents his front desk actually receives — and everything lands in the same 90-second brief, behind the same gate.

**On-slide beats:**
- The scenario is Dan's Tuesday verbatim: the front desk uploads an outside **renal/metabolic lab PDF** and an **updated intake form** for tomorrow's hydroxychloroquine-monitoring patient — the "gems in that past medical history that I can't even get to" (UC-3).
- One document arc, three shipped systems: the lab's **declining eGFR re-tiers HCQ toxicity risk** through the existing `check_med_risk` engine (UC-4); the intake's med change and "what she's hoping for" line land as first-class cited facts (UC-7).
- Week 1 compounds, measured: deterministic citation gate, 8 Zod-validated patient-scoped tools, correlation IDs end-to-end, $5/day cost ledger, **24/24 evals passing**.
- The evolution claim, up front: same two theses — *move thinking to where time is free* and *provenance by construction* — extended to inputs the record never carried: scanned paper, and practice guidelines.

**Speaker notes (~45 s):**
Week 1's diagnosis was a presentation failure, not a data failure. Week 2 is the corollary: the most important recent information isn't in the record at all — it's in a scanned outside lab and a paper intake form. That is Dan's practice verbatim: referral-heavy, elderly, fragmented records. So the product doesn't change shape. The renal panel feeds the hydroxychloroquine calculator we already ship — declining kidney function is a major AAO risk multiplier, the thing Dan says "scares me to death" to miss. The intake carries the med change and the patient-goals field he singled out on sight. Same brief, same gate, same eval harness — 24 of 24 passing today. And the debt ledger stays honest: BullMQ, object storage, and the SMART browser launch remain documented, off-path debt; the one debt Week 2 needs — deployed traces — goes first on the critical path.

**Anticipated attack:** *"The assignment says Week 1 debt should be resolved before adding surface area — you're carrying four items."*
All four are documented with written activation paths, and none sits on the Week 2 path: ingestion runs prep-time in-process exactly like the pipeline it extends; source documents live in OpenEMR — that's the round-trip requirement itself, not the missing object store; dev-login already exercises the full auth model including the cross-patient 403. The one debt Week 2 depends on is deployed traces — so Langfuse activation is first on the critical path, not a footnote. Named, bounded, off-path debt is a schedule decision; denied debt is rot. We have the first kind.

---

## Slide 2 — One Small Graph, Same Trust Boundary

**Headline:** A three-node LangGraph supervisor routes every ask with a sub-half-second, logged decision — and Week 1's deterministic gate is promoted to the critic every answer must pass.

**On-slide beats:**
- **LangGraph.js StateGraph** inside the existing TypeScript sidecar: supervisor → `intake-extractor` | `evidence-retriever`. Nodes wrap shipped services — orchestration changes, business logic doesn't.
- **Supervisor-as-entry:** every chat turn gets one cheap routing decision (deterministic short-circuits + a small Haiku call, **~200–400 ms**): `fast_path` → the unchanged Week 1 chat loop; `needs_evidence` → a streamed ~5 s retrieval turn; document upload → the full prep-time graph inside the 5–20-minute gap.
- **Gate-as-critic:** the citation gate + prescriptiveness lint become the answer-side critic node — the spec's "extension" critic, delivered by promoting proven code, not by a fourth LLM.
- **Inspectable by requirement:** every handoff logs correlation ID + routing reason; worker spans are children of the supervisor span — one ID reconstructs the entire multi-agent trace.

**Speaker notes (~45 s):**
Week 1 rejected multi-agent orchestration with a scoped argument: no capability gain for real latency cost, on a linear pipeline plus one tool loop. Week 2's work genuinely branches — extract, retrieve, or answer — and the graded artifact is inspectable routing. So we bought the smallest graph that can be called one: a supervisor and two workers, each node wrapping a service that already exists and is already tested. The supervisor now fronts chat with a bounded routing decision — a few hundred milliseconds, deterministic short-circuits for the obvious cases — so routing is visible on every turn, not just at upload. Retrieval-grade turns cost about five seconds and stream their status; the expensive graph work still runs where time is free. And the critic isn't new code pretending to be an agent — it's Week 1's deterministic gate, promoted to a graph node every answer must pass.

**Anticipated attack:** *"Your Week 1 defense called orchestration frameworks 'someone else's abstractions to debug.' What changed — the requirements or your convictions?"*
The workload changed shape. Week 1's control flow was linear; a graph there was overhead — and on the fast path it still is, which is why routing is bounded to ~0.3 s of deterministic-first decision and the heavy branches run at prep/tool time. Week 2's flow branches for real, and the assignment grades the inspectability of that branching; a hand-rolled dispatcher is inspectable only to its author. We adopted LangGraph without the LangChain ecosystem — three nodes wrapping our own services. If the graph ever creeps into the latency budget, the Week 1 argument re-applies and it comes out.

---

## Slide 3 — Seeing Without Inventing

**Headline:** The VLM proposes; deterministic geometry disposes — an extracted value either locates in the document's own word boxes or it is flagged unverified and can never be cited.

**On-slide beats:**
- One tool, whole flow: `attach_and_extract(patient_id, file, doc_type)` → original stored in **OpenEMR Documents** (the record keeps the source of truth) → **sha3-512 dedupe** → prep-time extraction job.
- **Strict Zod schemas are the canonical contracts** — `lab_pdf`: test, value, unit, reference range, collection date, abnormal flag, citation; `intake_form`: demographics, laterality-tagged chief concern, meds, allergies, family history, patient goals. Raw VLM output cannot bypass validation.
- **Geometric grounding:** every value must locate in the document's OCR word boxes → page + bounding-box citation (page-level fallback); unlocatable → **visible but unverified, never citable** — behind the required click-to-source overlay.
- **Round-trip honesty:** intake vitals write to OpenEMR's native vitals endpoint; lab values live in the fact store with declared authority and full lineage (this fork has no FHIR Observation-create path) — one source of truth per data type.

**Speaker notes (~45 s):**
The assignment's first hard problem is vision extraction without invention, and our answer is Week 1's answer: the model proposes, deterministic code disposes. The original document is stored in OpenEMR first — the record keeps the source of truth — deduped on the hash OpenEMR stores but doesn't enforce. Extraction runs as a prep-time job: Claude vision reads the page, but its output is a proposal until two checks pass — strict schema validation, because the schema is the source of truth, not what the model happens to return; then geometric grounding, where every value must be found in the document's own OCR geometry. Found: a citable fact with a bounding-box overlay. Not found: displayed as unverified, excluded from citations. Week 1 quarantined the model's eyes in `describe_scan`; Week 2 gives them a verifier. And the round-trip claim is honest: vitals write natively; lab authority is declared, not fudged into a field that doesn't fit.

**Anticipated attack:** *"Your trust story rides on OCR word boxes; real documents are skewed faxes and handwriting. When geometry fails, do you lose the data or fake the citation?"*
Neither — the contract has three visibly distinct outcomes: a word-box hit renders a tight overlay; a geometry miss with a page-level citation renders a page-region highlight, still click-to-source; a value we can't locate at all renders present-but-unverified and can never be cited. The UI never fakes precision it doesn't have — which is Dan's stated tolerance exactly: mistakes he can verify, never confident fabrication. A deliberately degraded scan ships in the eval fixtures, so the fallback ladder is tested, not hoped.

---

## Slide 4 — RAG for Knowledge That Was Never Patient-Shaped

**Headline:** Week 1's "whole patient fits in context" argument still holds — the guideline corpus is practice knowledge, not patient data, and it gets exactly the retrieval stack Week 1 reserved headroom for.

**On-slide beats:**
- **Not a reversal:** Week 1 kept pgvector as declared headroom "for the day the corpus outgrows the context: cross-patient queries, literature." This assignment is that day. Patient facts still ship whole.
- **Corpus:** 6–10 authored practice-protocol documents grounded in named guidelines — AAO PPP (Diabetic Retinopathy, AMD, RVO), AAO hydroxychloroquine screening, anti-VEGF treat-and-extend — "agreed clinical practices the office follows." Zero PHI, license-clean, committed to the repo.
- **Pipeline:** Cohere embed → pgvector dense + tsvector keyword → reciprocal-rank fusion → **Cohere Rerank** → top-k chunks with source metadata; plus contextual retrieval (query rewriting + disease/laterality filters). **One new vendor — the one the spec names.**
- **Typed separation, PHI-free by construction:** `guideline_evidence` is a new citation `source_type` — record and guidance cannot blur, by schema; retrieval queries are built from de-identified clinical concepts, enforced by a deterministic scrubber + a CI check.

**Speaker notes (~45 s):**
This is the slide where we appear to reverse ourselves, so read Week 1's rejection precisely: one patient's facts fit in the model's context — and we left pgvector installed as declared headroom for the day the corpus outgrew it. That day is this assignment. Guidelines are practice-scoped knowledge; they were never patient-shaped, and the whole-context argument never covered them. The precedent already ships: UC-9 answers "per AAO screening guidelines" from attribution hardcoded in the arithmetic engines — RAG generalizes one hardcoded guideline into six to ten authored practice protocols under the same provenance discipline. The stack is deliberately boring: the Postgres we already run does dense and keyword retrieval, fusion merges them, and Cohere Rerank — the single new vendor, the one the spec names — orders the evidence. The separation is typed, so record facts and guideline evidence can never blur. And because queries are PHI-free by construction and checked in CI, the whole retrieval subsystem can be logged and traced freely.

**Anticipated attack:** *"You could paste 6–10 documents into the context window and skip the entire retrieval stack."*
At today's corpus size the recall lift is honestly small — what the stack buys is chunk-level provenance and evaluability. An in-context guideline blends into the model's parametric knowledge, can't be cited at `{chunk_id, quote}` granularity, and gives a `retrieval_grounded` eval nothing to measure. The contract matters more than the corpus size because the corpus is built to grow — practice protocols and literature are the exact headroom cases Week 1 named. The incremental machinery is two indexes inside a Postgres we already run plus one API call, and the spec itself mandates the hybrid-plus-rerank shape.

---

## Slide 5 — The Eval Gate Is the Feature

**Headline:** A proven 24/24 harness grows into a 50-case, five-category, PR-blocking gate — and we rehearse the graders' injected regression before they perform it.

**On-slide beats:**
- **24/24 → 50:** wire the three authored-but-idle patient corpora + lab/intake fixtures (including a deliberately degraded scan), retrieval goldens, refusal and missing-data cases. Extraction-weighted mix: ~20 extraction / 10 retrieval / 8 citation / 7 refusal+missing / 5 PHI-safety.
- **Boolean categories per spec** — `schema_valid`, `citation_present`, `factually_consistent`, `safe_refusal`, `no_phi_in_logs` (+ `retrieval_grounded`). **Tiered math:** safety categories hard-fail on any newly-failing case; quality categories fail on >5% vs committed baseline or below threshold.
- **The honest delta:** evals run on push today — this week they become a required PR check + pre-push hook, fully deterministic on stubbed VLM/LLM fixtures (no live keys in CI); live suite runs pre-milestone. `no_phi_in_logs` is executable: seeded canary identifiers must never appear in captured logs.
- **Full rolling of the pipeline:** Langfuse activated (Cloud for the synthetic-data demo; self-hosted documented as pilot posture) — supervisor→worker→retrieval spans under one correlation ID; LangSmith fenced to the demo env for LangGraph-native visuals. Rehearsal: break a schema field, drop a citation, plant a canary — three categories trip.

**Speaker notes (~45 s):**
The assignment says a demo that cannot block regressions has not met the standard. We agree, and we didn't start from zero: 24 deterministic boolean evals pass today, every case a metric, a value, a threshold, and a pass flag. Week 2 grows that to 50, weighted toward the new multimodal surface, including one deliberately degraded scan. The gate math is tiered on purpose: a safety category — a refusal, a leaked canary, a missing citation — fails the build on a single newly-failing case; quality categories carry the five-percent baseline rule the spec asks for. The honest delta: today the suite runs on push, not as a PR gate — this week it becomes a required check plus a pre-push hook, deterministic on stubbed fixtures so nobody is ever tempted to disable it. Then we rehearse the graders' move before they make it: break a schema field, drop a citation, plant a canary, and watch three different categories fail the build — with the whole run visible as one trace, supervisor to worker to retrieval, under one correlation ID.

**Anticipated attack:** *"Your PR gate runs on stubbed models — a prompt change that degrades live answers sails through. What is the gate worth?"*
It catches the regression class that ships through code — schema breaks, citation-contract violations, gate bypasses, PHI leaks, refusal-logic errors — which is precisely the class a grader can inject deterministically and boolean rubrics can assert without flaking. Live-model drift is a different layer with different economics: the live suite runs before every milestone, and the verification pass/fail rate alert covers production drift. We split them deliberately: a flaky, token-billed PR gate gets disabled within a week, and a disabled gate blocks nothing. The gate that always runs is the only gate that always blocks.

---

## Slide 6 — Ops, Economics, Risks, Deliberate Cuts

**Headline:** Week 2 adds pennies per document, holds every Week 1 latency number, and is deliberately narrower than the spec — the strongest thing we ship is the list of things we didn't.

**On-slide beats:**
- **SLOs where the time budget lives:** ingestion p95 ≤ 90 s/document (inside the 5–20-min prep gap); retrieval p95 ≤ 2.5 s incl. rerank; evidence turns ≤ 5 s streamed; fast-path chat < 2 s first token + ≤ 0.4 s router. Week 1 read path holds its measured p95 46 ms / 193 ms baseline.
- **Economics:** extraction ~$0.03–0.10/doc, rerank ~$0.002/query → ~$20–25 per 70-patient day vs Week 1's ~$20 — dev spend stays behind the **unchanged $5/day SpendGuard** + per-call ledger. `/ready` gains vector-index, reranker, and doc-storage probes — degraded, not binary.
- **Risks, each with a first-day verification:** pgvector on Railway (verify immediately; in-process fallback is trivial at this corpus size) · degraded scans (grounding turns bad extraction into flagged-unverified, never wrong facts) · OpenEMR write scope (`user/document.write` registered + integration-tested first) · stubbed-gate blind spot (pre-milestone live evals + verification-rate alert).
- **Deliberate cuts, seams built:** no third document type until two work (referral fax is the designed-next slot); no ColQwen2/multi-vector for a 10-doc corpus; no lab-trend widget this week; no graph in the fast path; no SaaS traces near patient data. *"Narrower than the original spec and stronger because of it"* — the spec's words, our design rule.

**Speaker notes (~45 s):**
The economics stay noise: three to ten cents to extract a document, a fifth of a cent to rerank a query — a two-document visit lands around twenty to forty-five cents, and the seventy-patient day projects at twenty to twenty-five dollars against Week 1's measured twenty, all still behind the five-dollar daily budget gate we deliberately did not raise. SLOs sit where their time budgets live: ninety seconds inside a twenty-minute gap costs the doctor nothing; two and a half seconds at tool time is visible and streamed; the fast path keeps its sub-two-second first token plus a bounded router. Readiness reports degraded, not binary. Four risks are on the slide, each with a first-day verification, not a hope. And the cuts are the strength: two document types that work, one retrieval stack we can eval, one small graph, no SaaS traces near patient data. Narrower and stronger — the spec's own closing note is our design rule.

**Anticipated attack:** *"The spec says persist derived facts as 'appropriate FHIR resources or OpenEMR records' — you're keeping lab values in your own Postgres. Failed core requirement?"*
We verified this fork's actual write surface: FHIR here is read-only except Patient, Organization, Practitioner — no Observation.create, no lab-table API — and the only observation-shaped write is the fixed-field vitals endpoint. So "appropriate" splits by data type: intake vitals round-trip natively (a true OpenEMR write), source documents round-trip into OpenEMR Documents with hash dedupe, and lab values live in the fact store with declared authority and full lineage back to their in-EHR source PDF — per the spec's own "one source of truth per data type." Shoehorning an HbA1c into a vitals field would be cosmetic compliance and a silent authority violation — the exact thing the engineering requirements ban.

---

## Narrative spine (one sentence per slide)

1. Week 2 doesn't change who this is for — it teaches Dan's co-pilot to read the two documents his front desk actually receives, landing everything in the same 90-second brief.
2. The graph is Week 1's thesis extended, not reversed: a bounded, logged routing decision fronts every ask, the heavy work runs where time is free, and the deterministic gate is promoted to critic.
3. Nothing enters an answer without provenance: extracted values must locate in the document's own geometry or they render unverified and uncitable.
4. Guidelines get retrieval because they were never patient-shaped — typed separation and PHI-free queries make the stack both grounded and traceable.
5. The eval gate is the feature: 50 boolean cases, tiered regression math, PR-blocking, rehearsed against injected regressions before graders inject theirs.
6. Pennies per document, every Week 1 number held, and deliberately narrower than the spec — which is exactly why it's stronger.

## Numbers to memorize for Q&A

1. **24/24 → 50** eval cases; mix ≈ 20/10/8/7/5; safety categories hard-fail per case, quality categories **>5%** vs baseline.
2. **~200–400 ms** supervisor routing decision · **≤5 s** evidence turns (streamed) · **<2 s** fast-path first token, unchanged.
3. **≤90 s/doc** ingestion p95 (inside the 5–20-min prep gap) · **≤2.5 s** retrieval p95 incl. rerank.
4. **p95 46 ms @ 10 / 193 ms @ 50 concurrent, 0% errors** — Week 1 measured load baseline, the regression floor.
5. **$0.03–0.10/doc extraction · ~$0.002/rerank query · ~$20–25/day** projected vs Week 1's ~$20 — behind the unchanged **$5/day** SpendGuard.
6. **3 graph nodes, 8 chat tools unchanged, 1 new vendor** (Cohere embed + rerank — the vendor the spec names).
7. **6–10 authored practice protocols** grounded in AAO PPPs (DR/AMD/RVO), AAO HCQ screening, treat-and-extend; zero PHI; committed to repo.
8. **365 g** — the hydroxychloroquine cumulative-dose golden (5 y × 200 mg/day crosses the AAO high-risk threshold), already eval-locked; the demo lab's declining eGFR is the risk *multiplier* that re-tiers it.
