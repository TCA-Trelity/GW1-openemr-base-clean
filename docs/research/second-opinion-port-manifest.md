# second-opinion → Clinical Co-Pilot: full port manifest

*Component-level research for PRD Tier-1 units. Source repo: the private
`second-opinion` prototype (React/Vite/Tailwind/shadcn on base44). All paths
below are into that repo. Corrections vs earlier assumptions: (a) only ONE
synthetic corpus exists (`margaret-chen/`) — William Thompson has an imaging
trajectory only, no source-document corpus; (b) there are TWO independent,
divergent medication-risk engines — reconcile before porting (PRD F9).*

## 1. Port manifest table

| Asset | Source path(s) | Classification | Target |
|---|---|---|---|
| HCQ dose engine (`computeMedicationRiskFlags`, `parseDuration`, `extractDailyDose`) | `src/components/utils/medicationRiskFlags.jsx:6-150,155-190` | VERBATIM (inject thresholds via providerProfile) | sidecar engines + evals (U1.2) |
| `MEDICATION_RISK_PROFILES` (13 drug classes: HCQ, chloroquine, ethambutol, tamoxifen, corticosteroids, tamsulosin/alfuzosin IFIS, topiramate, PDE5/NAION, isotretinoin, amiodarone, vigabatrin…) + `evaluateMedicationRisks` | `src/components/services/medicationRiskService.jsx:11-199,230-276` | VERBATIM data table + evaluator; MERGE with above into one engine | U1.2 |
| Other utils-engine flags (bleeding, steroid IOP, IFIS, diabetic, custom regex meds) | `medicationRiskFlags.jsx:58-143` | ADAPT — de-dupe vs profile table; replace substring match with normalized drug-name match | U1.2 |
| Interval analyzer `analyzeIntervalPatterns` | `src/components/utils/imagingAnalysis.jsx:351-431` | VERBATIM (pure, plain arrays) | U1.2 + evals |
| HCQ progression `analyzeHCQProgression` (GC decline ≥10µm → progression, ≥15 high; RPE escalation) | `imagingAnalysis.jsx:436-523` | VERBATIM | U1.2 |
| `computeComparison` (CRT Δ>20µm; response classifier) / `computeTreatmentContext` | `imagingAnalysis.jsx:161-254,315-346` | VERBATIM | U1.2 |
| Formatters (`formatFindingType`, `formatMeasurementType`, `formatTreatmentResponse`, `severityToNumber`) | `imagingAnalysis.jsx:537-582` | VERBATIM | panel + sidecar |
| `analyzeOCT` | `imagingAnalysis.jsx:41-156` | **SKIP** — fabricates findings via `Math.random()`; keep only as spec of output fields | T3 spec |
| Brief 4-tab structure (Overview / Medical Background / Diagnosis & Care / Sources; "Page N of 4") | `src/pages/PatientBriefing.jsx:696-779` | REBUILD-TO-SPEC | U1.7 |
| Overview (`ReadyToWalkIn`) order | `src/components/briefing/ReadyToWalkIn.jsx:113-210` | REBUILD-TO-SPEC | U1.7 |
| Patient-goals card ("What They're Hoping For") | `ReadyToWalkIn.jsx:154-171` | REBUILD-TO-SPEC | U1.7 |
| `suggestedApproach` (6 coaching bullets) + `patientStatements` | `PatientBriefing.jsx:129-154,271-288` | VERBATIM as seed narrative (note: suggestedApproach is defined but never rendered in prototype) | seed data |
| ClinicalDetail 13 sections (order below §4) + `CollapsibleSection`/`DataTable` primitives | `src/components/briefing/ClinicalDetail.jsx` (sections at 363,516,551,568,574,580,586,594+643,653,664,673,692,708; primitives 31-119) | REBUILD-TO-SPEC; primitives ADAPT | U1.7 |
| CitationRef factory (`buildCitationsFromSources`, `buildCitation`, `findExcerptLocation`, `formatSourceLabel`, `buildDeepLink`, `getAttributionDisplayText`) | `src/components/citations/citationHelpers.jsx:91-177` | VERBATIM | U1.1/U1.8 |
| CitationBubble (hover excerpt + context highlight + "view in context") / CitationGroup | `citations/CitationBubble.jsx` (deep link build 113-153), `CitationGroup.jsx` | ADAPT (replace full-page nav with panel routing) | U1.7 |
| SourcesView (char-range OR excerpt-text highlight; reads `?sourceId&start&end&excerpt`) | `briefing/SourcesView.jsx:48-98,108-134` | REBUILD-TO-SPEC (highlight/deep-link contract is the spec) | U1.7 |
| VerificationAuditPanel (verified/disputed/pending counts, filterable facts, audit feed) | `briefing/VerificationAuditPanel.jsx` (+ `verificationService`, `auditTrailService`) | REBUILD-TO-SPEC | U1.7 |
| MedicationRiskFlags display | `briefing/MedicationRiskFlags.jsx` | ADAPT (always receive flags from sidecar; calls the *service* engine in prototype) | U1.7 |
| Imaging workstation (Timeline/Compare/Trends/Viewer tabs; interval footer bar) | `src/pages/ImagingView.jsx` + `components/imaging/{ImagingTimeline,ImageComparison,TrendAnalysis,IntervalAnalysis,ImageViewer,AIFindingsPanel}.jsx` | REBUILD-TO-SPEC (`IntervalAnalysis` ~50 lines trivial; charts Recharts) | U2.3 |
| Consult chat panel (quick prompts, optimistic send) | `src/components/consult/ConsultChatPanel.jsx` (prompts 12-19; persistence 41-85; suggested questions 153-158) | REBUILD-TO-SPEC | U1.8 |
| Context assembly + prompt + citation parse-back | `src/components/services/consultContextService.jsx` (gather 13-224; categorize 256; format 535-684; system prompt 483-528; send 693-721 w/ web grounding at 709; parse 728-760) | REBUILD-TO-SPEC | U1.8 |
| `processProviderNote` 4-axis classifier prompt | `base44/functions/processProviderNote/entry.ts:84-140+` | REBUILD-TO-SPEC (taxonomy for fact extraction) | U1.6 |
| ProviderProfile defaults + getters | `src/components/contexts/ProviderContext.jsx:8-100,215-256` | VERBATIM data / ADAPT context | U1.1/U2.6 |
| Verification tier constants + `canVerifyFactType` | `src/components/lib/permissions.jsx:267-306` | VERBATIM | U1.1/U1.7 |
| realtimeSync (in-tab EventEmitter + query-invalidation map 66-101) | `src/components/services/realtimeSync.jsx` | REBUILD-TO-SPEC on SSE (NOT cross-user in prototype despite PRD claim) | U1.7 |
| Margaret Chen corpus (12-13 docs, 4 contradictions, patientSummary, timeline) | `src/components/data/synthetic/margaret-chen/{index,sourceData,timeline}.jsx`, `patientBriefingData.jsx` | VERBATIM data / REBUILD loaders | U1.9/U1.10 |
| Synthetic loaders (temporal slicing `loadPatientSourcesUpToDate` 90-126) | `data/synthetic/loaders/loadPatientSources.jsx` | ADAPT (high-value for eval harness) | U1.10 |
| William Thompson imaging (7 OCT OD Jun–Dec 2025 + 4 Eylea; over-extension: inj #3 at 49d → recurrent SRF at 71d → back to q8w) | `data/sampleImagingData.jsx:22-586,993-1114` | VERBATIM data | U1.9 |
| Intake suite (22 files; `branchingLogic.jsx`, `SafetyFlag.jsx`, supervised/phone modes) | `src/components/intake/*`, `pages/IntakeChat.jsx` | SKIP now; mine at T3 | T3 |
| base44 Deno functions (`processProviderNote`, `processScribeTranscript`, `submitProviderNote`, `processAbandonedIntakes`) | `base44/functions/*` | REBUILD-TO-SPEC | U1.6/T3 |

## 2. Schema extraction (verbatim shapes → Zod)

**PatientFact** (PRD §6.2; usage `consultContextService.jsx:265-312`):
`id, patient_id, fact_type ∈ {medication, allergy, condition, clinical_finding, imaging_finding, procedure_history, vital_sign, social_history, family_history, patient_goal, chief_complaint}, content {varies}, is_current: bool, source_document_id (required), sources: CitationRef[], verification {status ∈ unverified|verified|disputed|patient_reported, verified_by_user_id, verified_at, verifier_role}, laterality ∈ OD|OS|OU|null, created_date, updated_date`.
Content shapes (§6.10): medication `{name, generic_name, dose, frequency, route, start_date, end_date, prescriber, indication, risk_flags[]}` · allergy `{substance, reaction, severity, verified, source}` · condition `{name, icd10, status ∈ active|controlled|resolved, since, severity}` · vital_sign `{name ∈ IOP|VA|CRT|BP|HR, value, units, laterality, captured_at}` · imaging_finding `{finding_type, severity, confidence, measurements{}, laterality, source_image_id}` · clinical_finding `{finding, body_part, laterality, severity, source}` · family_history `{relative, condition, age_at_diagnosis, outcome}` · social_history `{category ∈ caregiver|occupation|tobacco|alcohol|…, value, notes}`.

**CitationRef** (`citationHelpers.jsx:91-152`):
`id, fact_id?, source_label, source_type ∈ {intake_transcript, provider_note, pharmacy_record, imaging_report, lab_report, prior_visit_note, referral_letter, patient_self_report, clinical_observation, external_ehr_import, scribe_transcript}, excerpt_text, excerpt_location {type:'character_range', start_char, end_char, context_before, context_after}, attribution {speaker_role ∈ patient|family_member|physician|nurse|technician|pharmacist|external_provider|system, speaker_name, speaker_relationship, confidence}, source_document_id, document_date, deep_link_url`.

**Contradiction — two shapes exist; port the rich one (b):**
(a) runtime entity: `id, patient_id, status ∈ active|resolved, severity ∈ critical|high|moderate|low, type, description, suggested_question, source_a{}, source_b{}`.
(b) synthetic/rich (`margaret-chen/index.jsx:120-300`): `contradiction_id, type, category, severity, clinical_significance, source_documents[{filename, claim, exact_text, certainty ∈ definitive|hedged|uncertain|patient_reported}], ground_truth {accurate_value, source, rationale}, detection_strategy {method, keywords[], expected_automation, detection_difficulty}, clinical_impact {affects_care, urgency_level, explanation, recommended_action}, physician_workflow {surface_in_briefing, auto_generate_question, suggested_briefing_language, note?}`. (a) is a lossy projection of (b).

**SourceDocument** (PRD §6.3 + `sourceData.jsx:7-178`):
`document_type ∈ {referral_letter, pharmacy_record, lab_report, clinical_note, external_import, tech_workup, imaging, patient_portal_message, patient_upload, intake_transcript, scribe_transcript}, document_date, received_date?, received_method?, content {format ∈ text|structured, text_content?, ocr_quality? 0..1, ocr_artifacts?[], structured_content?}, extracted_data {}, intentional_issues {key: {issue, actual, clinical_impact}} (DEMO/eval-only — keep out of EHR), metadata {source_system, imported_at, imported_by, original_filename, pages}`.

**Verification tiers** (`permissions.jsx:267-282`): `DELEGATED_VERIFICATION_ALLOWED = [social_history, family_history, patient_goal, chief_complaint]`; `PHYSICIAN_VERIFICATION_REQUIRED = [allergy, medication, condition, clinical_finding, imaging_finding, procedure_history]`; gate `canVerifyFactType(role, factType)` (296-306).

**ProviderProfile defaults** (`ProviderContext.jsx:47-60`): `risk_sensitivity {alert_threshold ∈ standard|cautious|aggressive, suppressed_alerts[{alert_type, reason}], custom_alert_rules[], thresholds {hcq_high_risk_years:5, treatment_interval_warning_weeks:10, stale_verification_days:180, iop_warning_threshold:21, iop_critical_threshold:30, crt_change_warning_microns:50, va_change_warning_lines:2}}`; `relevance_configuration.fact_type_weights {medication:0.8, allergy:1.0, condition:0.8, procedure_history:0.7, family_history:0.5, social_history:0.4, imaging_finding:0.7, vital_sign:0.5}`.

**Imaging/Treatment fields the pure engines read** (exact paths, w/ fallbacks): image → `image_metadata.capture_date` (fallback `capture_date`), `.modality`, `.laterality`; `ai_analysis.measurements[{measurement_type ∈ central_retinal_thickness|ganglion_cell_thickness, value}]`; `ai_analysis.findings[{finding_type ∈ rpe_changes|retinal_thinning, severity, confidence}]`; `ai_analysis.comparison_to_prior.treatment_response.assessment ∈ good_response|worsened|no_response|partial_response`; `id`. Treatment → `treatment_date`, `injection_details.{medication, dose, injection_number}`; seed shape also carries `treatment_type`, `pre_treatment_assessment{indication, oct_findings, visual_acuity}`, `outcome{assessed_at, response, oct_change, notes}`, `performed_by`.

## 3. Pure-function notes

- `medicationRiskFlags.jsx` is fully pure, zero imports; HCQ severity: `yearsOnMed ≥ hcq_high_risk_years(5)` OR `cumulativeDoseGrams ≥ 1000` → high; `≥ years-2` → medium; default dose 200 mg; source string "AAO HCQ Screening Guidelines 2016 (revised 2020)".
- `medicationRiskService.jsx` pure; `calculateMedicationDuration` (204) uses `new Date()` → inject a clock.
- `imagingAnalysis.jsx` module is tainted by one import (`base44Client` for `generateAnalysisSummary:259-261`) — split the four pure analyzers into their own file. `analyzeIntervalPatterns` confidence: ≥5 samples → high, ≥3 → medium.

## 4. Brief information architecture (validated content spec)

Tabs: **Overview · Medical Background · Diagnosis and Care · Sources** ("Page N of 4" footer). Urgency banner renders ABOVE tabs (`PatientBriefing.jsx:672-680`).
**Overview order** (`ReadyToWalkIn.jsx:113-210`): contradiction alert banner (live) → symptom images (live, if any) → imaging section (demo-hardcoded) → "Why They're Here" (merged) → **"What They're Hoping For"** (merged) → Key Discussion Points (live LLM) → Questions to Confirm (live) → Medication Risk Flags (live) → Provider Notes (live) → Diagnostic Suggestions (hardcoded).
**Medical Background order** (ClinicalDetail): Key Facts → Considerations for Exam → Questions to Confirm → Medication Risk Alerts → Visit History → Provider Notes → Symptom Profile → Medication Detail (+HCQ cumulative-exposure note) → Family Ocular History → Data Conflicts & Inconsistencies → Risk Factor Summary → Recommended Exam Components → HCQ Screening Protocol.
**Hardcoded-vs-live (critical):** the preparation pipeline must GENERATE what the prototype hardcodes: urgency object, diagnostic suggestions + differentials + confidence, entire care-plan tab (`carePlanData` `PatientBriefing.jsx:300-367`: findings by eye, assessment, plan, considerations w/ confidence %, 7-task follow-up protocol), symptom profile, risk-factor checklists, recommended-exam list, HCQ protocol text, patient statements, excerpt-level citations. Genuinely live in prototype: chief complaint, patient goal, meds, contradictions, med-risk flags, questions, provider notes. The Key-Facts `contextMap` (`ClinicalDetail.jsx:407-433`) fabricates citation excerpts — demo-only, drop.

## 5. Chat/consult mechanics (template for Haiku chat)

- `gatherConsultContext`: ONE parallel `Promise.all` over 6 entity types (PatientFact current / IntakeRecord / ProviderNote processed / SourceDocument / PatientContradiction active / Patient), each `.catch(()=>[])`; then demo-data fallback layers (DISCARD); `categorizeFacts` buckets meds/conditions/allergies/vitals/clinicalFindings; interval analysis injected.
- System prompt (`buildConsultSystemPrompt:483-528`): role framing → patient-context markdown → strict citation contract `[PATIENT: source_type | excerpt]`, `[LITERATURE: title | url]`, `[REASONING]` → 6 guidelines → preferred sources (PubMed/AAO/UpToDate/Cochrane).
- Parse-back (728-760): regex `\[PATIENT:\s*([^|]+)\s*\|\s*([^\]]+)\]` and literature equivalent → structured citations for UI.
- Persistence: `ConsultConversation {patient_id, patient_name, messages[{id, role, content, citations[], literatureSources[], timestamp}], last_message_at, title (first 50 chars), status:'active'}`; history filter `status:'active'`, sort `-last_message_at`, limit 10; reset per patient switch.
- Quick prompts (dropdown, 6): Summarize case / Treatment options / Guidelines check / Risk factors / Next steps / Differential diagnosis. Empty-state suggestions (4): GC-IPL thinning significance / adjust treatment interval / AAO guidelines / summarize findings.
- LLM call-site census (~11): brief-gen (KeyDiscussionPoints:36, questionGeneration:421, carePlanGeneration:26+426, imagingAnalysis:261, contradictionDetection:750), chat (consultContextService:707 — the only web-grounded one), intake (IntakeChat:79), backend note/transcript processors.

## 6. Seed-data conversion (→ OpenEMR)

**Margaret Chen:** 12–13 source docs (referral letter 2024-12-15; SureScripts pharmacy pull 2024-12-26; rheumatology note 2024-09-10; CMP+CBC 2024-11-01; portal message 2024-12-20; patient photo; tech workup; OCT OD/OS; Fundus OD/OS; intake transcript); 4 contradictions (HCQ duration — high; sulfa allergy NKDA-vs-reported — critical; MTX compliance gap — moderate; nocturnal photopsias — moderate); 5 meds, 1 allergy, 2 family-hx, 2 conditions; 6 imaging scans + medication_start event 2021-12-01.
**William Thompson:** imaging-only (7 OCT OD + 4 Eylea with the didactic 49d→71d over-extension). No source corpus (build one at T2 if wanted).

| Prototype asset | OpenEMR home |
|---|---|
| Demographics | `patient_data` / FHIR Patient |
| Meds | `lists`(medication) + `prescriptions` / MedicationStatement,Request |
| Allergy | `lists`(allergy) / AllergyIntolerance |
| Conditions | `lists`(medical_problem) / Condition |
| Family hx | `history_data` / FamilyMemberHistory |
| Social/caregiver/goals context | weak fit — mostly fact-store only |
| Visits | `form_encounter` / Encounter |
| Imaging + findings | `documents` + `procedure_*`; VA/IOP/CRT → `form_eye_*` / ImagingStudy, Observation, Media |
| Injections | `procedure_result` or eye-form log / Procedure |
| Labs | `procedure_order`+`procedure_result` / Observation, DiagnosticReport |
| Source docs | `documents` + categories / DocumentReference |
| **No OpenEMR home → sidecar fact store:** | Contradiction(b), CitationRef provenance, verification state+tiers, ProviderProfile, `intentional_issues`/`ocr_quality` (eval fixtures only), telemetry, ConsultConversation |

**Not found (confirmed absent):** William Thompson source corpus; cross-user realtimeSync transport; any render path for `suggestedApproach`; a unified med-risk engine.
