# PRD: Clinical Co-Pilot (AgentForge Week 1)

## 1. Summary

Build an AI pre-visit brief with one-toggle imaging and chat drill-down, embedded in OpenEMR, for a high-volume retina practice (design partner: Dan). The approved architecture defense (`docs/defense/architecture-defense.md`) fixes the design: a TypeScript sidecar (Node.js + Fastify + Zod) beside an untouched OpenEMR fork, a PostgreSQL fact store as a derived view, preparation precomputed in the check-in-to-doctor gap (Claude Sonnet 5), chat over prepared facts (Claude Haiku 4.5), a deterministic citation gate, and dual credentials (SMART patient-bound interactive / read-only system preparer). This PRD converts that design into **tiered implementation units with explicit cutoffs**: **Tier 0** = tonight's MVP hard gates (deployed fork + `AUDIT.md` + `USERS.md` + `ARCHITECTURE.md` + demo video); **Tier 1** = Thursday's Early Submission (working agent, evals, observability); **Tier 2** = Sunday's Final (production hardening, load tests, cost analysis); **Tier 3** = post-course pilot roadmap (unscheduled). Assets identified in the second-opinion port manifest (Appendix B) are referenced by unit.

## 2. Codebase map

- **Stack:** OpenEMR fork — PHP 8.2, Laminas/Symfony hybrid, MariaDB, Twig, PHPStan level 10, Doctrine DBAL 4 (`CLAUDE.md`). New code: TypeScript sidecar (Node.js 22, Fastify, Zod), React panel (Tailwind/shadcn, ported design system), PostgreSQL, Redis + BullMQ, GCS/S3 object storage, Anthropic API under BAA, self-hosted Langfuse.
- **Boundaries:**
  - *OpenEMR core* — untouched; consumed via FHIR R4 API + OAuth2/SMART (`apis/routes/_rest_routes_fhir_r4_us_core_3_1_0.inc.php`, `src/RestControllers/AuthorizationController.php`).
  - *`interface/modules/custom_modules/oe-module-clinical-copilot/`* (new) — PHP module: patient-chart card injection, check-in listener, SMART app registration. Follows `oe-module-comlink-telehealth` skeleton.
  - *`sidecar/`* (new, top-level dir in fork) — agent runtime, fact store access, preparation pipeline, chat, citation gate.
  - */home/user/second-opinion* — asset source only; never deployed. Port manifest in Appendix B.
- **Traced data flow:** appointment check-in → `pc_apptstatus` change → `ServiceSaveEvent::EVENT_POST_SAVE` on `PatientTrackerService` (precedent: `PatientFlowBoard/.../PatientFlowBoardEventsSubscriber.php`) → module listener fire-and-forget POST to sidecar `/jobs` → BullMQ → worker pulls record via FHIR (system client) → Sonnet 5 extracts typed facts w/ citations → deterministic engines (HCQ, intervals) → brief assembled → PostgreSQL. Doctor opens chart → SMART EHR-launch → panel `GET /brief/:patientId` (<1 s, stored read) → chat turns via Haiku over the fact bundle → citation gate → screen.
- **Build/test/run:** OpenEMR: `openemr-cmd` (`ut`, `cq`, `pst`); dev stack `docker/development-easy`; deploy from `deploy/` compose (Tier 0). Sidecar: `npm run dev|test|build`, Vitest, k6, Bruno collection.
- **Conventions worth preserving:**
  - PHP: start every file `declare(strict_types=1)`; PSR-4 `OpenEMR\`; no `$GLOBALS` — use `OEGlobalsBag`; DB via `QueryUtils`/`DatabaseConnectionFactory`; module tables via module `sql/install.sql`; PHPStan 10 with zero new baseline entries; conventional commits with `Assisted-by` trailer.
  - TS: Zod schemas are the single source of truth for every tool/API payload; pure clinical logic lives in dependency-free modules; inject clock and thresholds — no `new Date()` or magic constants inside engines; stream all model responses.

## 3. Fence register

| # | Fence (path:line) | Hypothesized reason | Evidence | Confidence | Status |
|---|---|---|---|---|---|
| F1 | `src/RestControllers/Authorization/BearerTokenAuthorizationStrategy.php:479-485` — `checkUserHasAccessToPatient()` returns `true` | Upstream known-incomplete per-patient authz | Explicit TODO in code | High | **Load-bearing** — do not "fix" core; construct patient scoping in our layer (SMART patient-bound tokens) |
| F2 | `interface/patient_file/summary/demographics.php` density (billing/certification/LBF cards) | Revenue + regulatory + configurability forces | Code composition review | High | **Load-bearing** — never modify; our card is additive via events |
| F3 | `lists` polymorphic table (problems/meds/allergies) | 20-year legacy schema | `sql/database.sql:7671` | High | **Load-bearing** — access via services/FHIR only |
| F4 | Local-API session path skips OAuth scopes (`LocalApiAuthorizationController.php`) | First-class same-origin module path | Code + explicit design | High | **Load-bearing but unused by us** — we choose SMART/OAuth; leave intact |
| F5 | `apis/dispatch.php:41-44` returns `$e->getMessage()` in 500s | Oversight (contradicts repo's own standards) | Code + `CLAUDE.md` rule | Medium | **Explained defect** — audit finding; optional fix unit U2.4 |
| F6 | `POST /api/background_service/$run` has no auth check (`_rest_routes_standard.inc.php:705-716`) | Documented as intentional | Route comment | Low (reason found, risk unassessed) | **Unknown** — mitigate at proxy (U0.1 blocks path at Caddy); verify in U2.4 |
| F7 | No async queue in OpenEMR (no Messenger; cron + sync listeners) | Upstream simplicity | `composer.json`, `MIGRATION_GUIDE_CRONJOBS.md` | High | **Load-bearing** — module listener must be fire-and-forget; queue lives in sidecar |
| F8 | Fork history is a single squashed commit | Import hygiene | `git log` | High | Archaeology capped; confidence ceilings applied throughout |
| F9 | second-opinion has **two divergent med-risk engines** (`utils/medicationRiskFlags.jsx` vs `services/medicationRiskService.jsx`) — different callers, constants, outputs | Demo evolution, never reconciled | Port manifest §1/§3 | High | **Explained** — U1.2 merges into one engine before port |
| F10 | `imagingAnalysis.jsx:41-156` `analyzeOCT` fabricates findings via `Math.random()` | Demo stand-in for a real vision model | Port manifest §3 | High | **Explained** — never port as logic; spec-only for output fields |
| F11 | `form_eye_*` tables (17) exist with zero demo data | Upstream ships schema, not content | `sql/database.sql:13539+`, `example_patient_data.sql` | High | Seed units must create content (U1.9) |
| F12 | Prototype brief is hardcoded north-star content merged with live queries (`PatientBriefing.jsx:22-367`) | Dan-demo scaffolding | Port manifest §4 | High | **Explained** — treat as *content spec*; U1.6 must genuinely generate: urgency, diagnostic suggestions, care plan, symptom profile, risk factors, recommended exam, HCQ protocol, patient statements, excerpt citations |

## 4. Tradeoff analysis

Argued in full in the architecture defense; verdicts recorded here. **In scope:** presentation layer over data migration (reversible; F2/F3 load-bearing); sidecar over in-EHR PHP (upgrade-safe, independent failure domain); TypeScript over Python (validated JS engines port verbatim; one schema file for API+UI); frontier model under BAA over medical-tuned/turnkey products (task is retrieve-organize-cite, not knowledge generation); whole-patient context over vector search (bundle fits in context; hardest retrieval problem never arises). **Rejected:** agent frameworks and multi-agent (latency + defend-someone-else's-abstractions cost, no capability gain); fixing F1 in OpenEMR core (out of scope; mitigated structurally). **Deferred:** raw-pixel scan interpretation (T3 — schema slot reserved); intake surfaces (T3 — mine `branchingLogic.jsx`/`SafetyFlag.jsx` then); William Thompson *source-document* corpus (does not exist upstream — optional build, T2); semantic search (returns when corpus outgrows context).

## 5. Implementation units

> **TIER CUTOFF RULE:** a tier is *done* when all its units pass acceptance; nothing from a higher tier may block a lower tier's submission.

### ─── TIER 0 — MVP hard gates (tonight, Tue 11:59 PM CT) ───

**Unit 0.1: Public deploy of the OpenEMR fork**
- **What:** GCP Compute Engine VM (e2-standard-2, Ubuntu LTS); Docker Compose stack: MariaDB + OpenEMR built from this fork's source + Caddy TLS on a `sslip.io` hostname (domain swap later if provided). Caddy denies `/apis/default/api/background_service/*` from outside (F6 mitigation). Demo credentials rotated from defaults.
- **Files:** `deploy/docker-compose.yml`, `deploy/Caddyfile`, `deploy/README.md` (runbook), `Dockerfile.deploy` (fork-source image).
- **Depends on:** GCP credentials from user (open question Q1). **Fences:** F6. **Complexity:** medium.
- **Acceptance:** public HTTPS URL serves login; admin login works; sample patients visible; URL recorded in PR description.

**Unit 0.2: `AUDIT.md` (repo root)**
- **What:** ~500-word summary first, then Security (F1 stub w/ code cite, F5 error disclosure, F6 route, password-grant/system-scope notes, session/CSRF posture), Performance (page-composition costs, API latency observations, no-queue constraint F7), Architecture (module/event system, FHIR surface, integration points), Data Quality (14 demographics-only sample rows; no clinical/eye data; implications), Compliance (api_log + ATNA sink, breakglass, BAA posture, retention).
- **Files:** `AUDIT.md`. **Depends:** none (evidence already gathered). **Complexity:** medium.
- **Acceptance:** all five PDF-required sections present; every finding carries `path:line`; summary ≤ 1 page.

**Unit 0.3: `USERS.md` (repo root)**
- **What:** Dan as the target user (avatar, day-in-numbers), the 90-second workflow walkthrough, use cases each with an explicit "why is an agent the right shape" answer (brief = anti-template; chat = iterative verification; imaging toggle; HCQ/interval calculators; patient-goals surfacing), tolerances (latency targets, refusal behavior).
- **Files:** `USERS.md`. **Complexity:** light.
- **Acceptance:** every agent capability in ARCHITECTURE.md traces to a use case here (PDF hard requirement).

**Unit 0.4: `ARCHITECTURE.md` (repo root)**
- **What:** the approved defense doc restructured to the PDF deliverable format (500-word summary already written), plus a short "what the audit changed" section (F1 → dual-credential design; F7 → sidecar-owned queue; data-quality → synthetic seeding plan).
- **Files:** `ARCHITECTURE.md`. **Complexity:** light.
- **Acceptance:** begins with ~500-word summary; covers agent location, data access, authz boundaries, risks/mitigations, verification, observability, evals, failure modes, cost/scale.

**Unit 0.5: Demo video script (user records)**
- **What:** 3–5 min shot list: the problem in Dan's numbers → deployed URL walkthrough → top audit findings on screen → architecture diagram → tiered plan.
- **Files:** `docs/defense/demo-script.md`. **Complexity:** light.
- **Acceptance:** script timed ≤ 5 min; every hard gate visibly demonstrated.

**Unit 0.6: Submission housekeeping** — commit all of the above, push, update PR #1 description with the deployed URL. **Acceptance:** PR shows all gate files at required paths.

### ─── TIER 1 — Early Submission (Thu 11:59 PM CT): working agent, evals, observability ───

**Unit 1.1: Sidecar scaffold + contracts**
- **What:** Fastify app; `/health` + `/ready` (checks OpenEMR FHIR, Anthropic API, Langfuse reachability); correlation-ID middleware (ID on every log line, tool call, model call); Langfuse SDK wiring; **Zod schema package** transcribed field-for-field from Appendix B §schemas: `PatientFact` (11 fact types + per-type content shapes + verification object + laterality), `CitationRef` (excerpt_location character-range + attribution + deep_link), `Contradiction` (rich synthetic shape (b): source claims w/ certainty enum, ground_truth, detection_strategy, clinical_impact, physician_workflow), `SourceDocumentMeta` (ocr_quality, artifacts), `ProviderProfile` (thresholds verbatim: hcq_high_risk_years 5, interval warning 10 wk, IOP 21/30, CRT Δ50 µm, VA Δ2 lines + fact_type_weights), `ConsultConversation`, `PrepJob`.
- **Files:** `sidecar/src/{app,routes/health}.ts`, `sidecar/src/schemas/*.ts`, `sidecar/test/schemas.test.ts`.
- **Fences:** none. **Complexity:** medium.
- **Acceptance:** `/ready` returns dependency truth (kill Langfuse → not ready); schema tests round-trip the Margaret Chen fixtures unmodified.

**Unit 1.2: Port the pure clinical engines (reconciled)**
- **What:** single medication-risk engine: `MEDICATION_RISK_PROFILES` table (13 drug classes, `medicationRiskService.jsx:11-199`) as the data source + the utils engine's HCQ cumulative-dose math (`medicationRiskFlags.jsx:6-150`: `dailyDose×365×years/1000`, ≥1000 g or ≥threshold-years → high) with **injected** thresholds + clock (F9 resolved; `calculateMedicationDuration`'s `new Date()` becomes an injected clock). Port verbatim: `analyzeIntervalPatterns` (`imagingAnalysis.jsx:351-431`), `analyzeHCQProgression` (`:436-523`, GC decline ≥10/15 µm), `computeComparison` (`:161-254`, CRT Δ>20 µm), `computeTreatmentContext` (`:315-346`), formatters (`:537-582`), `parseDuration`/`extractDailyDose`. Split from the base44-tainted module (F10: `analyzeOCT` is NOT ported).
- **Files:** `sidecar/src/engines/{medicationRisk,intervals,hcqProgression,comparison,format}.ts`, `sidecar/test/engines/*.test.ts`.
- **Complexity:** medium. **Fences:** F9, F10.
- **Acceptance:** parity fixtures pass — Margaret Chen HCQ ≈ 292 g/high; William Thompson trajectory yields "stable at 8 weeks, leaked at ~10 (49→71 d over-extension)" recommendation with confidence ≥ medium; identical outputs to recorded prototype runs.

**Unit 1.3: Fact-store migrations** — PostgreSQL tables mirroring the Zod schemas (+ `prep_job`, indexes on `(patient_id, is_current)`); pgvector extension installed, unused. **Files:** `sidecar/migrations/*.sql`. **Complexity:** light. **Acceptance:** migrate up/down clean; wipe-and-rebuild leaves EHR state untouched (derived-view property demonstrated).

**Unit 1.4: OpenEMR module `oe-module-clinical-copilot`**
- **What:** PSR-4 module (telehealth-module skeleton): card injection into patient summary via `SectionEvent`/`CardRenderEvent`; menu entry; **check-in listener** on `ServiceSaveEvent::EVENT_POST_SAVE` + `AppointmentService::isCheckInStatus()` (PatientFlowBoard precedent) doing a fire-and-forget POST to sidecar `/jobs` (≤250 ms timeout, failure logged never thrown — F7); SMART app + API-client registration documented.
- **Files:** `interface/modules/custom_modules/oe-module-clinical-copilot/{openemr.bootstrap.php,src/Bootstrap.php,src/Listener/CheckInListener.php,sql/install.sql,templates/card.html.twig,README.md}`.
- **Fences:** F2 (additive only), F7. **Complexity:** medium-heavy (PHPStan 10 bar).
- **Acceptance:** card renders on demographics page; check-in visibly enqueues a job; `openemr-cmd pst` clean with zero new baseline entries.

**Unit 1.5: FHIR reader (system client)** — client_credentials auth; pulls Patient, Condition, MedicationRequest/Statement, AllergyIntolerance, Encounter, Observation, DocumentReference; normalizes into extraction inputs. **Files:** `sidecar/src/ehr/{auth,fhirReader}.ts`. **Complexity:** medium. **Acceptance:** full Margaret Chen pull < 30 s; every read visible in OpenEMR `api_log` with client identity.

**Unit 1.6: Preparation pipeline (deep reader)**
- **What:** BullMQ worker: FHIR pull → Sonnet 5 fact extraction with per-fact citations (adapt the `processProviderNote` 4-axis classifier taxonomy: DATA_TYPE × TEMPORAL_RELEVANCE × DISPLAY_TARGET × EXISTING_MATCH — port manifest §5) → contradiction detection across sources → deterministic engines (U1.2) → brief assembly generating **all sections the prototype hardcoded** (F12 list) → persist bundle. Structured outputs validated against Zod at every step; failures mark the brief partial-with-timestamp, never silently complete.
- **Files:** `sidecar/src/prep/{worker,extract,contradictions,assemble}.ts`, `sidecar/src/prompts/*.ts`.
- **Fences:** F12. **Complexity:** heavy.
- **Acceptance:** Margaret Chen end-to-end ≤ 5 min; detects ≥ 2 of 4 planted contradictions incl. the critical sulfa-allergy conflict, with correct ground-truth source preference; 100% of assembled facts carry resolvable citations.

**Unit 1.7: Brief UI (SMART-launched React panel)**
- **What:** Overview in the validated order (port manifest §4): contradiction banner → imaging thumbnails → "Why They're Here" → **"What They're Hoping For"** card → discussion points → questions-to-confirm → med-risk flags → notes; Medical Background with the 13 collapsible sections in prototype order; Sources tab with citation drill-in (ADAPT `CitationBubble`/`CitationGroup`, keep hover-excerpt + char-range highlight contract from `SourcesView.jsx:48-98`; replace full-page nav with panel routing) and rebuilt `VerificationAuditPanel`; verification actions gated by ported tier constants (`permissions.jsx:267-282`: physician-only for allergy/medication/condition/clinical_finding/imaging_finding/procedure_history; delegable for social_history/family_history/patient_goal/chief_complaint).
- **Files:** `sidecar/panel/src/**` (Vite build served by sidecar), embedded via module card iframe + SMART launch.
- **Complexity:** heavy. **Fences:** F1 (patient-bound token is the mitigation).
- **Acceptance:** brief opens < 1 s from stored bundle; every rendered claim exposes its citation; a technician session cannot verify a medication fact (tier gate observed); launch token scoped to launch patient only.

**Unit 1.8: Chat (fast responder) + citation gate**
- **What:** Haiku 4.5 streaming chat; system prompt scaffold + citation contract ported from `buildConsultSystemPrompt` (`consultContextService.jsx:483-528`) with `[PATIENT: source | excerpt]` markers; context = `formatContextForPrompt` port (`:535-684`) over the stored bundle (no live FHIR in hot path); closed toolset (fetch bundle, drill source, run calculators, list gaps, verify fact); **deterministic post-generation gate**: every `[PATIENT:...]` marker must resolve to a real fact/citation ID or the claim is blocked and rewritten as absence; quick-prompt chips copy ported.
- **Files:** `sidecar/src/chat/{route,gate,tools,prompts}.ts`.
- **Complexity:** heavy.
- **Acceptance:** p95 first-token < 2 s against deployed stack; adversarial suite: cross-patient asks refused, injected-document instructions quoted-not-followed, fabricated-citation attempts blocked by gate (logged).

**Unit 1.9: Seed data (demo = eval corpus)**
- **What:** Margaret Chen full conversion per port-manifest §6 mapping — demographics → `patient_data`; meds/allergy/conditions → `lists` (+`prescriptions`); family hx → `history_data`; encounters → `form_encounter`; labs → `procedure_*`; the 12 source documents → `documents` (with `intentional_issues` ground truth preserved *only* in the eval fixtures, not in the EHR); tech workup + VA/IOP → `form_eye_*`; imaging series + William Thompson trajectory (7 OCT + 4 Eylea events, `sampleImagingData.jsx:22-586,993-1114`) → `documents` + GCS files + fact-store imaging events. Seeding via OpenEMR services/SQL in-container (FHIR write surface is too narrow — most clinical resources are read-only).
- **Files:** `sidecar/seed/{margaretChen,williamThompson}.ts`, `sidecar/seed/fixtures/**`.
- **Complexity:** medium-heavy. **Fences:** F11.
- **Acceptance:** FHIR returns the seeded record; prep pipeline runs against it; imaging timeline renders both patients with treatment stamps.

**Unit 1.10: Eval suite** — corpus-driven: contradiction detection vs ground truth; citation-validity invariant (100%); boundary cases (empty record, missing meds, malformed doc); adversarial (unauthorized access, injection); faithfulness spot-checks; each test documents the failure mode it guards. CI on every push. **Files:** `sidecar/eval/**`, `.github/workflows/sidecar-ci.yml`. **Complexity:** medium. **Acceptance:** suite runs in CI; failing gate blocks merge; results file committed.

**Unit 1.11: Observability + API collection** — Langfuse dashboard (requests, errors, p50/p95 per surface, tool calls, retries, verification pass/fail, tokens/cost); 3 alerts (p95 latency, error rate, tool-failure rate) with documented responses; Bruno collection covering every agent endpoint. **Complexity:** light-medium. **Acceptance:** PDF's four log questions answerable from one correlation ID; graders can run Bruno collection cold.

**Unit 1.12: Deploy Tier-1 stack + demo video 2** — sidecar/panel/Postgres/Redis join the VM compose; Caddy routes; script for Thursday's video. **Acceptance:** agent works at the public URL (PDF requirement for Early).

### ─── TIER 2 — Final (Sun 12:00 PM CT): production-ready ───

- **U2.1 Load tests + baselines:** k6 at 10 and 50 concurrent users; p50/p95/p99 + error rate; CPU/mem/latency/throughput baselines committed.
- **U2.2 AI cost analysis:** actual dev spend + projections at 100/1K/10K/100K users with architecture inflections (single host → split → dedicated prep workers + prompt caching + batch API → multi-tenant isolation). Visits-not-seats model.
- **U2.3 Imaging surface (full):** one-toggle workstation — timeline interleaving scans/treatments, side-by-side compare, trend charts (CRT/GC vs normal range), interval-analysis bar (`IntervalAnalysis.jsx` port is trivial; `TrendAnalysis`/`AIFindingsPanel` rebuilt on our chart lib). Thumbnails shipped in U1.7 upgrade to this.
- **U2.4 Security hardening:** verify/neutralize F6 route; fix F5 (`dispatch.php` generic 500 body — upstreamable patch); rate limiting; secrets audit.
- **U2.5 Cost/latency optimization:** prompt caching on stable prefixes; morning-batch precompute via Batch API for scheduled patients.
- **U2.6 Provider personalization:** ProviderProfile thresholds surfaced (read-only UI) feeding U1.2 engines.
- **U2.7 Final demo video + social post** (PDF final-submission requirements).

### ─── TIER 3 — Post-course pilot roadmap (unscheduled; for Dan) ───

Multimodal scan interpretation (fills the reserved `imaging_finding` slot; replaces F10's fabricated spec with a real model); intake surfaces (mine `branchingLogic.jsx` + `SafetyFlag.jsx`); de-identification pipeline for real-PHI parallel operation (Dan's RCA "easy yes" posture); NexTech/fax referral ingestion; William Thompson source-document corpus as a second deep eval scenario; HA deployment; cross-patient/literature retrieval (pgvector activates).

## 6. Risks & mitigations

- **F6 (Unknown fence) touched by deploy:** blocked at Caddy in U0.1 *before* verification; spike in U2.4 resolves it to Explained.
- **Tonight's critical path is U0.1 and it depends on GCP credentials** (Q1): docs units 0.2–0.5 proceed in parallel regardless; if credentials slip, the runbook ships and the user executes it — acceptance unchanged.
- **Extraction quality below eval bar (U1.6):** the 4-axis classifier is a ported, validated taxonomy, and acceptance targets 2-of-4 contradictions minimum (the two single-hop ones) — stretch to 4 with an added cross-document pass.
- **Seeding via SQL drifts from OpenEMR invariants:** use service classes where they exist (`PatientService`, `ConditionService`); verify by reading everything back through FHIR (U1.9 acceptance).
- **Latency targets miss on the deployed VM:** streaming masks perceived latency; brief surface has no model in the hot path by design; alert thresholds catch regressions (U1.11).
- **PHI:** synthetic data only, all tiers; BAA assumption per project brief; Langfuse self-hosted so traces stay in-boundary.
- **Port divergence (F9):** parity tests in U1.2 are the contract; no engine ships without matching recorded prototype outputs.

## 7. Open questions

1. **GCP access** — project ID + service-account key (or SSH to a provisioned VM) needed for U0.1. *Assumption if unresolved: runbook handoff.*
2. **Domain** — none provided; *assumption: `sslip.io` hostname for TLS.*
3. **Anthropic + Langfuse keys** for the deployed sidecar (T1) — provisioning path TBD with U1.12.
4. **Demo video narration** — user records; scripts provided (U0.5, U1.12, U2.7).
5. **William Thompson source corpus** — build in T2 or skip; affects only eval breadth, not gates.
6. **Grader interpretation** — tonight's "deployed app" = OpenEMR fork without agent (per PDF: "The MVP is not a working agent"); *proceeding on that reading.*

## Appendix A: Evidence log

**OpenEMR fork (this session's reviews):** `BearerTokenAuthorizationStrategy.php:479-485` (F1); `HttpRestRouteHandler.php:141-200` + `AuthorizationListener.php` (PEP1/PEP2 enforcement); `_rest_routes_standard.inc.php:705-716` (F6); `apis/dispatch.php:41-44` (F5); `ApiResponseLoggerListener.php:39-104` + `LogTablesSink.php` (+ATNA, audit); `ModulesApplication.php:132-179` (module lifecycle); `src/Events/Patient/Summary/Card/*` (card injection); `PatientFlowBoardEventsSubscriber.php` (check-in precedent); `sql/example_patient_data.sql` (14 demographics-only rows); `sql/database.sql:13539+` (`form_eye_*`); single squashed commit `ef3d490` (F8).

**second-opinion (port manifest, this session):** `utils/medicationRiskFlags.jsx:6-150,155-190`; `services/medicationRiskService.jsx:11-199,230-276`; `utils/imagingAnalysis.jsx:41-156 (F10),161-254,315-346,351-431,436-523,537-582`; `citations/citationHelpers.jsx:91-152,158-177`; `citations/CitationBubble.jsx:113-153`; `briefing/SourcesView.jsx:48-98,108-134`; `lib/permissions.jsx:267-306`; `contexts/ProviderContext.jsx:47-60,215-256`; `pages/PatientBriefing.jsx:22-367,369-471,672-702`; `briefing/ReadyToWalkIn.jsx:113-210,154-171`; `briefing/ClinicalDetail.jsx:363-724 (13 sections),407-456`; `consult/ConsultChatPanel.jsx:12-19,41-85,153-158`; `services/consultContextService.jsx:13-224,483-528,535-684,693-760`; `base44/functions/processProviderNote/entry.ts:84-140` (classifier); `data/synthetic/margaret-chen/index.jsx:44-57,120-300,316-362`; `data/sampleImagingData.jsx:22-586,588-991,993-1114`; `data/synthetic/loaders/loadPatientSources.jsx:10-12,90-126`; `PRD.md` (718 lines) §§2.2, 4.13, 6, 9.3, 11–12.

**Voice of customer:** Dan Montzka discovery synthesis (four sessions, Dec 2025–Jan 2026) — quotes cited inline in `docs/defense/architecture-defense.md`.

## Appendix B: second-opinion port manifest (condensed)

| Asset | Source | Class | Target unit |
|---|---|---|---|
| HCQ dose engine + parsers | `utils/medicationRiskFlags.jsx:6-190` | VERBATIM (inject thresholds/clock) | U1.2 |
| `MEDICATION_RISK_PROFILES` (13 classes) + evaluator | `services/medicationRiskService.jsx:11-276` | VERBATIM data; merge w/ above (F9) | U1.2 |
| Interval analyzer | `utils/imagingAnalysis.jsx:351-431` | VERBATIM | U1.2 |
| HCQ progression analyzer | `utils/imagingAnalysis.jsx:436-523` | VERBATIM | U1.2 |
| Comparison + treatment-context + formatters | `imagingAnalysis.jsx:161-254,315-346,537-582` | VERBATIM | U1.2 |
| `analyzeOCT` simulation | `imagingAnalysis.jsx:41-156` | **SKIP** (fabricates data — spec only) | T3 |
| Brief 4-tab IA + section orders | `PatientBriefing.jsx`, `ReadyToWalkIn.jsx`, `ClinicalDetail.jsx` | REBUILD-TO-SPEC (F12: hardcoded = content spec) | U1.6/U1.7 |
| Patient-goals card ("hoping for") | `ReadyToWalkIn.jsx:154-171` | REBUILD-TO-SPEC | U1.7 |
| CitationRef factory + helpers | `citationHelpers.jsx:91-177` | VERBATIM | U1.1/U1.8 |
| CitationBubble/Group + deep-link | `citations/*.jsx` | ADAPT (panel routing) | U1.7 |
| SourcesView highlight contract | `SourcesView.jsx:48-134` | REBUILD-TO-SPEC | U1.7 |
| VerificationAuditPanel | `briefing/VerificationAuditPanel.jsx` | REBUILD-TO-SPEC | U1.7 |
| Verification tier constants + gate | `lib/permissions.jsx:267-306` | VERBATIM | U1.1/U1.7 |
| ProviderProfile thresholds + weights | `ProviderContext.jsx:47-60` | VERBATIM data | U1.1/U2.6 |
| Chat prompt scaffold + citation contract + serializer + parse-back | `consultContextService.jsx:483-760` | REBUILD-TO-SPEC (drop base44 + fallback layers) | U1.8 |
| `processProviderNote` 4-axis classifier | `base44/functions/processProviderNote/entry.ts:84+` | REBUILD-TO-SPEC (taxonomy) | U1.6 |
| Quick prompts + suggested questions copy | `ConsultChatPanel.jsx:12-19,153-158` | VERBATIM copy | U1.8 |
| ConsultConversation persistence shape | `ConsultChatPanel.jsx:41-85` | REBUILD-TO-SPEC | U1.1/U1.8 |
| Imaging workstation (timeline/compare/trends/interval bar) | `pages/ImagingView.jsx` + `components/imaging/*` | REBUILD-TO-SPEC | U2.3 |
| Margaret Chen corpus (12 docs, 4 contradictions, meds/allergy/hx) | `data/synthetic/margaret-chen/*` | VERBATIM data | U1.9/U1.10 |
| William Thompson imaging trajectory (7 OCT + 4 Eylea) | `data/sampleImagingData.jsx:22-586,993-1114` | VERBATIM data | U1.9 |
| Synthetic loaders (temporal slicing) | `loaders/loadPatientSources.jsx` | ADAPT | U1.10 |
| realtimeSync | `services/realtimeSync.jsx` | REBUILD-TO-SPEC (in-tab emitter only — not cross-user) | U1.7 (SSE) |
| Intake suite (branching, safety flags, supervised modes) | `components/intake/*` (22 files) | SKIP now / mine later | T3 |
