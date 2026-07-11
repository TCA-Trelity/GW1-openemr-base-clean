# Execution Plan — Clinical Co-Pilot build-out

> **Live status dashboard** (browser, hand-refreshed at each milestone):
> https://claude.ai/code/artifact/1233bba0-f8df-4b68-bf32-cef52531ffa6 — a
> visual read of this file (phases, waves, per-ticket status, and the
> "needs you" actions). This markdown remains the source of truth; the
> dashboard renders from it. The dashboard's HTML source is versioned at
> `docs/execution/build-status.html` (survives sessions — edit it and
> republish to the SAME url per its header comment; never mint a new URL).

*Ticket-level execution tracker for Tier 1 (Early Submission, Thu 11:59 PM CT)
and Tier 2 (Final, Sun 12:00 PM CT). This file is the **single source of
truth** for scope and status — it survives context windows, sessions, and
machines. Rules: every commit references a ticket ID in its body; a ticket's
checkbox flips in the same PR that completes it; scope changes edit this file
first. Grain: one ticket ≈ one reviewable diff. The PRD
(`docs/defense/PRD-clinical-copilot.md`) remains the *why*; this file is the
*what/when/who*.*

**Agent legend** — who executes each ticket:
- **main** — the primary Claude Code session (orchestrator + integrator; owns
  merges, deploys, and anything touching more than one area)
- **sub/wt** — parallel subagent in an isolated git worktree; returns a
  reviewed diff (used for self-contained units: schema ports, pure engines,
  frontend components, corpus authoring)
- **user** — dashboard/browser actions only the human can do (Railway UI,
  secrets, video)
- **railway** — scripts that must run *inside* the Railway project because the
  dev session cannot reach the live app (seeding, OAuth registration)
- **ci** — GitHub Actions; public runners CAN reach the live URL, so live
  smoke/e2e verification runs here

**Verification channel** per ticket: `unit` (vitest in repo), `ci-live` (smoke
against the deployed URL), `screenshot` (user confirms UI), `logs` (Railway
deploy logs).

---

## Phase 0 — Platform stabilization (serial, blocks everything)

| ID | Ticket | Agent | Depends | Verify | Done |
|---|---|---|---|---|---|
| P0.1 | Attach Railway volume at `/var/www/localhost/htdocs/openemr/sites` on the OpenEMR service (stops DB reset per push) | user | — | logs: next boot shows setup skipped | ☑ |
| P0.2 | Set Watch Paths on OpenEMR service to ignore `sidecar/**` and `docs/**` | user | — | push a docs commit → no rebuild | ☑ |
| P0.3 | Verify demo data + admin login stable across a push; change admin password from demo default | user | P0.1 | screenshot | ☑ |
| P0.4 | Commit this plan + update `docs/HANDOFF.md` with locked decisions (imaging metadata authored-at-seed; Kermany-style public OCT imagery; all-four imaging features Thu; embedded panel Thu; F9→`medicationRiskFlags` canonical; scan storage = sidecar volume behind `ImageStore` interface) | main | — | in repo | ☑ |

## Phase 1 — Walking skeleton (goal: one real prep runs end-to-end on Railway)

**Wave A — parallel (subagents in worktrees, no shared files):**

| ID | Ticket | Agent | Depends | Verify | Done |
|---|---|---|---|---|---|
| S1.1 | `sidecar/` scaffold: Fastify + TS strict + pino logging with correlation-ID middleware (ID on every log line, propagated to tool + LLM calls), config loader, error envelope, Dockerfile, `railway.json`, `/health` + `/ready` (ready = real checks: OpenEMR reachable, Anthropic key valid, Langfuse reachable, Postgres/Redis up) | main | P0.4 | unit + logs | ☑ |
| S1.2 | Port Zod schemas verbatim from port manifest §2: `PatientFact` (11 fact types, content shapes), `CitationRef` (character-range excerpt), rich `Contradiction`, `SourceDocument`, `ProviderProfile` thresholds, image/treatment shapes. Contracts = source of truth; exported for panel reuse | sub/wt | — | unit (schema fixtures) | ☑ |
| S1.3 | Port pure engines + unit tests w/ golden numbers: `medicationRiskFlags` (canonical per F9; AAO thresholds), `computeTreatmentContext`, `computeComparison`, `analyzeIntervalPatterns`, `analyzeHCQProgression`; inject clock (manifest §3); document the failure mode each test guards | sub/wt | S1.2 | unit | ☑ |
| S1.4 | Author seed corpus: Margaret Chen (12 source docs, 4 contradictions w/ ground truth, HCQ series w/ authored GC-thinning trend) + William Thompson (7 OCT + 4 injections, 49→71d over-extension) as OpenEMR-ready payloads; source public OCT B-scans (CNV-class for fluid visits, normal post-tx; normal for HCQ) + `docs/data-sources.md` attribution (CC BY) | sub/wt | S1.2 | unit (corpus validates against schemas) | ☑ |

**Wave B — serial on main (integration spine):**

| ID | Ticket | Agent | Depends | Verify | Done |
|---|---|---|---|---|---|
| S1.5 | OpenEMR client: OAuth2 client_credentials (system, read-only) + SMART EHR-launch flow; FHIR R4 reads (8 resource types per ARCHITECTURE §2); registration script (`sidecar/scripts/register-oauth.ts`) runnable on Railway | main | S1.1 | ci-live | ☑ |
| S1.6 | Fact store: Postgres schema + migrations (facts, citations, contradictions, source docs, briefs, image records, treatments); derived-view wipe/rebuild command | main | S1.2 | unit | ☑ |
| S1.7 | Prep pipeline: BullMQ job → FHIR fetch → Sonnet 5 extraction to typed facts (schema-validated, retry on invalid) → contradiction detection → med-risk arithmetic → imaging analytics over authored metadata → brief assembly → store | main | S1.3, S1.5, S1.6 | unit (recorded LLM fixtures) + logs | ☑ |
| S1.8 | Citation gate: deterministic resolver (every claim's CitationRef must resolve to stored source excerpt; failures rewritten as absence + logged as verification-fail metric) | main | S1.6 | unit (invariant tests) | ☑ |
| S1.9 | Railway topology: sidecar + Postgres + Redis + Langfuse services in existing project; sidecar volume for scans; user adds `ANTHROPIC_API_KEY` in Variables; seed job (`sidecar/scripts/seed.ts`) runs on Railway against live EHR | main + user + railway | S1.1, S1.4 | logs + ci-live | ☑ |
| S1.10 | CI: sidecar unit tests on PR; live smoke workflow (hits `/ready`, triggers prep for seed patient, asserts brief exists + citations valid) — this is the session's eyes on prod | main | S1.9 | ci-live | ☑ |

**Phase 1 exit criteria:** smoke workflow green — a prepared brief for Margaret Chen exists on the live deployment, every fact cited, gate passing.

## Phase 2 — Surface + hard-gate deliverables

**Realignment (2026-07-08, user review):** the panel gated every visual behind a
successful LLM prep — wrong product shape. New invariant: **the landing page is
deterministic** (stored EHR facts + pure engines, <1s, no LLM in any load path);
LLM output is an async enhancement card, never a gate. Priority stack confirmed:
(a) instant landing page → (b) source rail/viewer → (c) real OCT images →
(d) chat → (e) chart embed → (f) LLM ingest polish.

| ID | Ticket | Agent | Depends | Verify | Done |
|---|---|---|---|---|---|
| S2.10 | Deterministic overview API: `GET /api/patients` (day-schedule sidebar) + `GET /api/overview/:patientId` (patient header, facts by type, engine-computed med-risk flags + imaging analytics, contradictions, document metadata, latest-brief ref) — pure store reads, zero LLM | main | S1.6 | unit | ☑ |
| S2.11 | Panel realignment: left day-schedule sidebar (second-opinion pattern) to toggle patients; Overview renders instantly from `/api/overview` incl. most-recent-scan toggle; AI-insights card async + non-blocking (no more blocking Prepare) | sub | S2.10 | screenshot | ☑ |
| S2.12 | Source rail elevated: all documents listed with type/date/received-method/OCR-quality badges; click → full text with cited-excerpt highlights (provenance display IS the feature) | sub | S2.10 | screenshot | ☑ |
| S2.13 | Real OCT imagery: CC-licensed public B-scans (attributed in `docs/data-sources.md`) wired through ImageStore — `/api/images/:key` route + `storage_key` on seeded image records; Imaging tab shows actual scans | main + sub | S2.2 | screenshot | ☑ |
| S2.1 | React panel shell: Vite + Tailwind/shadcn (ported design system), brief tabs per manifest §4 (Overview / Medical Background / Diagnosis & Care / Sources), citation chips → source cards (verbatim excerpt highlight, attribution, deep link) | sub/wt | S1.2 | screenshot | ☑ |
| S2.2 | Imaging spine + all four features: ImagingTimeline (+days-post-injection badges), TrendAnalysis (CRT/GC w/ thresholds), IntervalAnalysis (treat-and-extend recommendation), ImageComparison (≤4 side-by-side); images served from sidecar `ImageStore` | sub/wt | S1.4, S2.1 | screenshot | ☑ |
| S2.3 | Chat loop: Haiku 4.5 over prepared fact bundle, strict inline citation token contract + parse-back to chips (manifest §5), streaming, conversation persistence, quick prompts | main | S1.7, S1.8 | ci-live + screenshot | ☑ |
| S2.4 | **Embed (committed for Thu):** `oe-module-clinical-copilot` — brief card into patient chart via `SectionEvent`/`CardRenderEvent`, iframe → SMART-launched panel, patient-bound token. Timeboxed to Thu AM; fallback = chart link to standalone panel (decision point 1 PM CT) | main | S2.1, S1.5 | screenshot | ☑ |
| S2.5 | Eval suite as deliverable: fixtures from corpus ground truth (planted contradictions found; citation validity 100%; calculator goldens; empty/missing-record boundaries; cross-patient denial; injection corpus in a seeded referral letter); runs in CI; results exported to `docs/execution/eval-results.md` | sub/wt | S1.7, S1.8 | unit + ci-live | ☑ |
| S2.6 | Observability deliverable: Langfuse dashboard (requests, error rate, p50/p95 per surface, tool calls, retries, verification pass/fail, token spend) + 3 alerts documented w/ on-call response in `docs/execution/observability.md` | main | S1.9, S2.3 | screenshot | ☐ |
| S2.7 | Bruno collection (`sidecar/api-collection/`): health/ready, register, trigger prep, get brief, chat turn, verify fact — runnable by graders without source | main | S2.3 | ci-live | ☑ |
| S2.8 | `COSTS.md`: actual dev spend (Anthropic console + Langfuse tokens) + 100/1K/10K/100K projections w/ architecture inflections (from ARCHITECTURE §11) | main | S2.6 | review | ☑ |
| S2.9 | Demo video #2: script update (brief → drill-down chat → imaging story → contradiction verify → dashboards), user records | main + user | all above | — | ☐ |

### Wave R — UI refinement (user feedback, 2026-07-08 PM)

*Root causes behind the feedback: (1) brief assembly flattens facts into prose
strings, dropping their citation refs — that's why insight bullets have no
chips; (2) chat/brief prompts have no length contract — physicians get
paragraphs where they have seconds; (3) the Imaging tab shows scans and
analytics in separate sub-views instead of second-opinion's one-sweep
image+findings+measurements layout (`AIFindingsPanel`/`CombinedImagingSection`);
(4) Diagnosis & Care waits on the LLM instead of deriving a deterministic plan.
Citations verdict: adopt the **Anthropic native Citations API** (document
blocks, `citations_delta` streaming, exact cited_text + char ranges — supported
on Haiku 4.5) for chat, keeping our verbatim gate as server-side verification;
no model/vendor switch needed.*

**Execution shape: backend contracts first (main), then ONE panel agent for all
UI moves (avoids collisions in `sidecar/panel/`), corpus agent in parallel.**

| ID | Ticket | Agent | Depends | Verify | Done |
|---|---|---|---|---|---|
| R1 | Corpus: +3 lighter patients (5 total; plausible ophtho variety), staggered appointment times with **Margaret earliest so the panel lands on her**; reuse existing CC scans; reseed on Railway | sub | — | screenshot | ☑ |
| R2 | Panel IA: AI Insights becomes its own tab (right of Imaging) and leaves Overview; **Generate button moves into the patient header bar** (left of the time chip); **Recent scans move directly under Chief Complaint** | sub (panel batch) | R4, R5 | screenshot | ☑ |
| R3 | Deterministic Diagnosis & Care on first load (no LLM): active conditions w/ status, current treatment protocol from treatments/events, monitoring plan + follow-up recommendation from engines (HCQ cadence, treat-and-extend interval) | main (API) + sub (panel batch) | S2.10 | unit + screenshot | ☑ |
| R4 | Brevity contract system-wide: chat answers ≤3 bullets/~1 sentence each by default (hard prompt cap, expand-on-ask); brief assembly emits terse one-line items (conflict core only, no doc-id prose); insights/chat UI density pass | main + sub (panel batch) | — | screenshot | ☑ |
| R5 | Citations fixed end-to-end: (a) brief assembly carries fact/citation refs per item → chips render in the Insights tab like Conditions; (b) chat migrates to the native Citations API (documents as content blocks, citations_delta → chips with char-range deep-links, spans re-verified by the gate server-side); `[[fact:id]]` contract retired | main + sub (panel batch) | — | unit + screenshot | ☑ |
| R6 | Integrated image analysis (port second-opinion `AIFindingsPanel` + `CombinedImagingSection`): selecting any scan shows image beside findings (severity/trend icons), measurements grid w/ reference ranges, delta vs prior, adjacent trend — one sweep | sub (panel batch) | S2.13 | screenshot | ☑ |

### Wave E — EHR integration layer + Wave V imaging module (user review 2, 2026-07-08)

| ID | Ticket | Agent | Depends | Verify | Done |
|---|---|---|---|---|---|
| R7 | Data-conflicts card moves below Chief Complaint AND Recent Scans on Overview | sub | R2 | screenshot | ☑ |
| R8 | Citation chips: numeric bubbles → source-name labels ("Provider note", "Pharmacy", "Imaging report", "EHR"...) everywhere incl. chat, so provenance reads before the click | sub | — | screenshot | ☑ |
| E1 | Seed the EHR itself: script creates the 5 corpus patients INSIDE OpenEMR (patient_data + problems/allergies/medications via the standard REST API, payloads derived from corpus facts + synthetic fill for native fields), records returned uuids into sidecar `patients.openemr_patient_id`; OAuth client registration extended with write scopes; user's only click = enabling the API client in OpenEMR admin | sub + railway + user | S1.5 | logs + FHIR read-back | ☑ |
| E2 | EHR sync service: FHIR pull (Patient/AllergyIntolerance/Condition/MedicationRequest/Observation) for linked patients → facts with EHR provenance + citable "EHR snapshot" source documents through the same gate pipeline; refresh endpoint | main | E1 | unit + ci-live | ☑ |
| E3 | Panel: "EHR Record" view (systematic live-from-OpenEMR rendering w/ sync timestamp, refresh, open-in-chart link) + EHR/External origin badges on all facts & citations | sub | E2 | screenshot | ☑ |
| V1 | Imaging workspace revamp (second-opinion pattern): analytics dashboard row (CRT delta, GC-IPL vs reference band, interval status, alert level) + large dark-surround scan viewer with OD/OS toggle + thumbnail filmstrip + metadata/findings in the margins + trend charts beneath with selected-scan highlight | sub | R6 | screenshot | ☑ |

**Phase 2 exit criteria:** agent works in the live environment (embedded), eval results committed, dashboard live, video submitted.

## Phase 3 — Tier 2 / Final

| ID | Ticket | Agent | Depends | Verify | Done |
|---|---|---|---|---|---|
| S3.1 | Load tests: 10 + 50 concurrent vs live (k6 in CI), p50/p95/p99 + error rate; baseline CPU/mem/latency/throughput captured to `docs/execution/baselines.md`. *(Done — clean serialized capture 2026-07-10 vs enforced-auth prod: 290 req/s p95 46 ms @10, 430 req/s p95 193 ms @50, 0% errors, both inside the 1500 ms SLO gate; the flawed first capture + harness fixes are documented in baselines.md.)* | ci | Phase 2 | ci-live | ☑ |
| S3.2 | Hardening per PRD Tier 2: dispatch.php error-disclosure fix (S2), background_service route verification (F6/U2.4), secrets audit. *(dispatch.php 500-handler no longer returns `$e->getMessage()` — generic body, detail logged only; AUDIT S2 marked Fixed. background_service verification + secrets audit still open.)* | main | Phase 2 | unit + review | ◐ |
| S3.3 | Verification workflow polish: role-gated fact verification UI (physician vs delegated), disputed state, verify-audit trail. *(Delivered: capability-gated `POST /api/facts/:patientId/:factId/verify` — physician full, resident flagged needs-attending-sign-off, nurse 403, cross-patient blocked; panel Verify button gated by role; verification records who/role/when. Disputed-state UI still a nicety. +8 tests.)* | main | S2.1 | screenshot | ☑ |
| S3.4 | Eval expansion: flagged-output→fixture loop wired (panel flag control → Langfuse annotation), regression run on every push | main | S2.5, S2.6 | ci-live | ☐ |
| S3.5 | Production-thinking docs refresh: failure-mode drill results, rollback rehearsal (module disable + fact-store rebuild), interview prep sheet. *(`docs/OPERATIONS.md` written — deploy topology, the 5-layer stability model, rollback, auth posture, scaling path, honest gaps; live drill results still to capture.)* | main | S3.1–S3.4 | review | ◐ |
| S3.6 | Final demo video + social post | user | all | — | ☐ |
| S3.7 | **Deploy blocker root-caused + fixed:** every sidecar deploy since TC1/TC2 failed with `TS2307 ./tools/index.js`. Cause: `.gitattributes` had an *unanchored* `tools/ export-ignore` (gitignore semantics — matches at any depth), and Railway builds from the GitHub **source archive**, which honors export-ignore — so `sidecar/src/chat/tools/` was silently absent from every deploy build context while git checkouts (CI) stayed green. Fix: anchor `/tools/`, add `sidecar/** -export-ignore` carve-out, revert the CACHEBUST workaround, add an `export-parity` CI job (committed sidecar tree == `git archive` output) so any recurrence fails on push | main | — | ci + logs (next deploy) | ☑ |

## Wave AZ — Authorization (PDF hard-problem #1; user-approved 2026-07-09)

*Drift found in the requirements pass: `ARCHITECTURE.md` §authz documents the
dual-credential, patient-bound SMART model as if enforced, but the sidecar API
is unauthenticated — a doc-vs-code gap. This wave makes the code do what the
doc already claims. Decisions locked with the user: **full SMART EHR-launch**
(patient-binding is structural, not a runtime check); **physician / nurse /
resident roles with real capability differences**.*

| ID | Ticket | Agent | Depends | Verify | Done |
|---|---|---|---|---|---|
| AZ1 | Sidecar becomes a SMART resource server: verify OpenEMR-issued patient-bound access tokens (JWKS signature verify + `aud`/`exp`), extract `{user, patient, role, scopes}`; typed `Principal`; 401 on missing/invalid | main | S1.5 | unit | ☑ |
| AZ2 | Auth middleware on every patient route: 401 unauthenticated; **403 when token patient ≠ requested patient** (structural cross-patient block); role-capability gate (physician full; nurse read-only, no prep-trigger; resident verifications flagged needs-attending-sign-off) | main | AZ1 | unit + ci-live | ☑ |
| AZ3 | Interactive SMART EHR-launch wired end-to-end: OpenEMR module launches the panel with `launch/patient`; panel completes the code exchange, stores the patient-bound token, sends it as Bearer on every sidecar call; system client_credentials path stays background-preparer-only. *(Sidecar RS256/JWKS+introspection verifier and panel Bearer plumbing built + tested; the live browser launch — module `launch/patient` → code exchange — is the remaining step, stood in for by dev-login.)* | main + user | AZ2, S2.4 | ci-live + screenshot | ◐ |
| AZ4 | Demo access without breaking review: dev-login that mints a scoped token for the standalone panel (clearly labeled), so graders can exercise auth without the full launch; role switcher for the physician/nurse/resident demo | main | AZ2 | screenshot | ☑ |

## Wave TC — Tool-calling chat (PDF "invoke tools"; user-approved 2026-07-09)

*Chat reasons over a pre-loaded bundle today. This wave adds a Haiku tool-use
loop so drill-downs pull data not in the summary — satisfying "invoke tools to
retrieve and reason" honestly, each tool traced to a use case. Every tool is
read-only, patient-scoped (inherits the AZ patient-bound token → a tool
physically cannot cross patients), Zod-contracted in/out, and any surfaced fact
still passes the citation contract. All six approved.*

| ID | Ticket | Agent | Depends | Verify | Done |
|---|---|---|---|---|---|
| TC1 | Tool-use loop in the chat service (Haiku tool calls + results back into the stream), keeping the pre-loaded bundle for the instant common case; Zod schema per tool in/out (engineering-req: contracts are source of truth); per-tool error handling + trace | main | S2.3 | unit | ☑ |
| TC2 | The six tools (read-only, patient-scoped): `get_full_document`, `get_measurement_trend`, `compare_scans` (reuses `computeComparison`), `check_med_risk` (AAO engine), `search_record`, `get_open_questions` | main | TC1 | unit | ☑ |
| TC3 | Panel: render tool invocations in the chat drawer (which tool ran, cited result) so tool use is visible in the demo | sub | TC2 | screenshot | ☑ |

## Wave G — Early/Final gap closers (from the verbatim PDF requirements pass)

| ID | Ticket | Agent | Depends | Verify | Done |
|---|---|---|---|---|---|
| G1 | `docs/execution/observability.md`: dashboard metric spec (mapped to emitted Langfuse traces) + the 3 required alerts (p95 latency, error rate, tool-failure) with thresholds + on-call response | main | S2.6 | review | ☑ |
| G2 | Langfuse deployed live on Railway + 3 alerts configured; `/ready` langfuse check flips to required | user + main | G1 | screenshot | ☐ |
| G3 | Doc alignment to verbatim PDF: PRD tiers, `presearch.md`, `ARCHITECTURE.md`/`AUDIT.md` authz sections reflect the honest built status (no overclaim) | main | AZ2 | review | ☑ |
| G4 | Demo video (Early: brief → cited chat with tool use → imaging → EHR Record + origin badges → cross-patient 403) *(submitted 2026-07-10)* | user | AZ,TC | — | ☑ |

## Wave P — Production polish (user-approved 2026-07-10)

*Post-submission "icing" scoped with the user after the early submission locked
(baselines committed, video submitted). Decisions locked: interactive login is
the **full-redirect SMART standalone flow** (panel → OpenEMR login page → PKCE
code exchange → Bearer); sample users are created via the **admin-UI click
path** (no standard-API route creates login-capable users; SQL into
`users_secure` rejected as hash-coupled); the five patient **goal one-liners
are agent-authored** to fit each storyline. Build order: P5+P6 (pure UI) →
P4 → P1–P3 → P7/P8 rolling.*

| ID | Ticket | Agent | Depends | Verify | Done |
|---|---|---|---|---|---|
| P1 | Panel login gate + SMART standalone sign-in: unauthenticated panel shows "Sign in with OpenEMR" → real OpenEMR login → PKCE code exchange (public interactive client registered alongside the system client) → Bearer on every sidecar call; logout; dev-login demoted to a flag+`?dev=1` grader fallback (CI smoke keeps using it) | main | AZ2 | unit + screenshot + ci-live | ☐ |
| P2 | Clinician directory + the real `resolveRole` the verifier anticipated: seeded username→{role, display name} mapping for the three sample logins; introspection `sub` resolves through it (fail-closed to nurse unchanged); clinician-wide (patient-unbound) tokens get role-gated access to the demo patients; header shows the signed-in name + role | main | P1 | unit | ☐ |
| P3 | Three OpenEMR sample users — physician / nurse / resident — created via admin UI from an exact-values checklist (user clicks; passwords never in repo or chat); each login verified end-to-end incl. the capability differences (nurse: no prep trigger; resident: sign-off flag) | user + main | P1, P2 | screenshot | ☐ |
| P4 | EHR seed depth for all five patients: full demographics (email, phones, language, ethnicity, race, marital, occupation — no emergency-contact column pair on the API), primary insurance w/ find-or-create payer, 2–3 encounters each with vitals + SOAP notes, today+follow-up appointments; FHIR Encounter syncs back as procedure_history → EHR Record "Visits & encounters"; immunizations documented as no-write-route. *(Code shipped `85dc982`, 345+75 green; LIVE data lands on the user's re-register + reseed — commands in the turn report and seed-ehr.ts runbook.)* | main + user (re-register + reseed) | E1 | unit + ci-live | ◐ |
| P5 | Overview restructure: tab order Overview-first (EHR Record second); chief complaint becomes "Why are we here today?" with a centered one-line authored patient goal above the existing intake content (goals cite verbatim sentences already in each patient's corpus docs — no doc edits, no offset risk); "Data Conflicts" becomes a compact, collapsed-by-default, amber-capped "Facts to resolve"; Medication Risk moves above a collapsed-by-default Medications summary row. *(Done `00626b1`: 345+75 tests green, Chromium screenshots verified.)* | sub | R-wave | unit + screenshot | ☑ |
| P6 | Width + Recent Scans workspace: content width max-w-4xl → max-w-6xl (~14% wider per side); Recent Scans is a two-column workspace — scans stacked vertically (taller) on the left, an at-hand analytics rail on the right (HCQ alert + GC-IPL delta, or interval story) read from the overview payload's **existing** imaging block — no new fetch, no server change needed. *(Done `00626b1`; `dump-overview.ts` renders corpus payloads DB-free for the screenshot pass.)* | sub | P5 | unit + screenshot | ☑ |
| P7 | Visual verification pass: panel built in-session and screenshotted with the pre-installed Chromium for all five patients (before/after) and attached to the PR; full panel suite green | ci | P5, P6 | screenshot | ☐ |
| P8 | Docs sync: PRD Wave-P addendum, DECISIONS.md entries, demo-script notes for the login flow, dashboard tickets kept current | main | P1–P7 | review | ☐ |

## Wave Q — UI refinement round 2 (user review 2026-07-10; complete — 8/8 shipped)

| ID | Ticket | Agent | Depends | Verify | Done |
|---|---|---|---|---|---|
| Q1 | Sources tab: auto-select the first document so the viewer never opens empty (Margaret lands on her referral letter); deep-link focus wins over the auto-select; dismissal sticks. *(Done `b0035d0`, screenshot-verified.)* | sub | S2.12 | unit + screenshot | ☑ |
| Q2 | Sources tab: document-type filter chips over the rail (All + per-type counts). *(Done `b0035d0`.)* | sub | Q1 | unit + screenshot | ☑ |
| Q3 | Diagnosis & Care overhaul: an ophthalmology-focused "game plan" — who does what (nurse check-ins, forms, call-backs, meds to prescribe), deterministic skeleton from the engines + ONE bounded Haiku call riding the existing prep run; consultative game-plan feel, not a pool of data fields. *(Done `5b5822c` — `game_plan` pipeline stage after brief_assembly, gated-content-only projection, null-on-failure so the plan never gates the prep; owner-grouped run-sheet card on Diagnosis & Care, screenshot-verified via fixture. Live plan composes on the next real prep.)* | main | R3 | unit + screenshot | ☑ |
| Q4 | AI Insights redesign: ~10–15% of current length, bullet-first, consultative thought-partner tone ("a question you might want to ask"), calm palette — no red alarm dump; gate metrics stay as a small footer chip. *(Done `5b5822c` — calm amber-dot urgency line, "The plan:" frame line, Worth discussing ≤6 + Questions ≤4 with show-all, conflicts stay expanded for anchor deep-links, one-line provenance footer; screenshot-verified.)* | main | R4 | unit + screenshot | ☑ |
| Q5 | Imaging suite breakout width: the tab escapes the centered column (full viewport beside the sidebar); viewer takes all remaining width beside one 320px rail; scan height cap 26rem→42rem — ~2× image area at laptop widths. *(Done `1057f1f`, screenshot-verified.)* | sub | V1 | screenshot | ☑ |
| Q6 | Scan-image metric overlay: CRT / GC-IPL + polarity-toned Δ vs prior (top-left) and quality · cycle · post-tx context (bottom-right) as HUD chips on the scan's dead space; renders only when the data exists. *(First pass done `1057f1f` — eyeball and iterate.)* | sub | Q5 | screenshot | ☑ |
| Q7 | Medical Background curation: meds (with risk badges) + Medication Risk Alerts detail + allergies + conditions-as-Medical-History + family history; duplicated chief-complaint / patient-goal dumps removed. *(Done `b0035d0`.)* | sub | P5 | unit + screenshot | ☑ |
| Q8 | Overview minimalism: landing = why-are-we-here + recent scans + facts-to-resolve ONLY; meds, risk alerts, allergies, conditions relocated to Medical Background per the locked decision. Bonus: `?tab=` deep links. *(Done `b0035d0`.)* | sub | Q7 | unit + screenshot | ☑ |

## Wave M — Multi-turn agent emphasis + thought-partner guardrails (early-submission feedback; user-approved 2026-07-11)

*Grader feedback (Thu submission): evals + safety scored strongly, but the
rubric "explicitly excludes a report generator as the core interface" and our
brief-first ARCHITECTURE framing reads as that pattern — "promoting that
conversational surface to a primary role in both the doc and the demo … would
make that clear." Gap analysis: the shipped chat already IS the multi-turn
tool-invoking agent (persisted history, 4-round tool loop, six patient-scoped
tools, verified citations — TC waves), but zero of 11 committed evals exercise
a conversation, Bruno `04-chat` never sends a second message, the panel ships
chat closed behind a FAB, and ARCHITECTURE/USERS scope multi-turn to UC-2
alone. Separately (user, 2026-07-11): grounding guardrails are strong, but no
layer governs prescriptiveness — the agent must be a thought partner (cited
facts · attributed engine/guideline output · questions worth considering),
never a prescriber. Full rationale + acceptance in the PRD Wave-M addendum.
Wave M = prove (M1, M5) + guard (M2–M4) + promote (M6) + reframe (M7, M8).*

| ID | Ticket | Agent | Depends | Verify | Done |
|---|---|---|---|---|---|
| M1 | Multi-turn conversation evals (deterministic, mocked-SSE, existing collector/report): (a) context carry-over — turn-2 pronoun resolvable only via threaded history, golden reply; (b) tool-chain golden — scripted `get_measurement_trend` → `compare_scans`, asserting `tools_used` order, `tool_result` plumbing, provenance→citation mapping, calculator-golden numbers in the final reply; (c) mid-conversation cross-patient denial — turn-2 ask about William from Margaret's bundle stays refused; (d) MAX_TOOL_ROUNDS forced-final boundary — a tool-hungry model still yields a cited, tool-free answer; (e) tool-error recovery — `is_error` result recovered into a grounded reply. New "conversation" category in `eval-results.md`. *(Done: `eval/multi-turn-chat.eval.ts`, 5 cases, suite 16/16; tool_results asserted byte-equal to direct engine invocation; the img-wt-004→005 diff is honestly `mixed` overall — CRT worsened +67 µm + new SRF while the authored PED resolves — recorded in the eval's notes.)* | main | TC2, S2.5 | unit + ci | ☑ |
| M2 | Prompt & tone guide (`docs/prompt-guide.md`) + chat prompt update: one voice spec for physician-facing LLM surfaces (chat, game plan, insights copy) — consultative thought-partner, brief, calm, absence-as-absence — plus the non-prescriptiveness contract: never initiate/adjust/recommend treatment, dosing, or diagnosis as the agent's own advice; recommendation-shaped asks get the reframe (record facts cited · engine/guideline output attributed · questions worth considering; decision stays with the physician; relaying documented plans/guideline engine output WITH attribution is correct behavior). `buildChatSystemPrompt` hard rules + quick prompts aligned to the guide. *(Done: guide committed with enforcement map + ask→violation→reframe examples; chat prompt gains hard rule 5; quick prompt 4 swapped to the open-questions shape; contract phrases pinned in `test/chat.test.ts`.)* | main | TC1 | unit (prompt structural tests) | ☑ |
| M3 | Prescriptiveness lint (deterministic, post-generation): flag unattributed directive-advice patterns in chat replies; flagged turns logged + counted like unverified citations and surfaced in the obs verification metrics. *(Done: `src/chat/prescriptivenessLint.ts` — 4 rules (first-person advice, second-person directive, passive directive, clinical imperative), attribution carve-out + question exemption; wired into `ChatService.turn` → `prescriptive_flag_count` on the result and the SSE done event, warn-logged with rules+excerpts; metric row added to observability.md; 10 unit tests.)* | main | M2 | unit | ☑ |
| M4 | Prescriptiveness evals: "what dose should I start her on?" / "should I shorten the injection interval?" goldens — structural (lint over scripted replies, reframe shape asserted) + one budget-tagged live behavioral case, published to `eval-results.md` | main | M2, M3 | unit + ci | ☐ |
| M5 | Bruno `04-chat` becomes a runnable multi-turn workflow: 01 new conversation → 02 follow-up reusing `{{conversationId}}` with a pronoun reference → 03 tool-chain-provoking turn (assert `tools_used` non-empty) → 04 replay; assert conversation_id stable across turns. *(Done: four-request workflow authored; also fixed the stale pre-R5 `cited_fact_ids` done-event contract in 01 + 02-patient-data/03-facts docs (would have failed any grader who ran it). Live `bru run` is egress-blocked from the dev session by design — verify on next grader/user run against Railway.)* | main | TC2 | ci-live | ☑ |
| M6 | Panel: chat promoted to primary — opens with the patient (persistent pane at desktop widths, drawer at narrow); "Ask about this" seeding from brief/insight cards + "Ask about this scan" from the imaging workspace (both continue the same persisted conversation); copy/comment sweep removes chat-as-secondary framing | sub | TC3 | screenshot | ☐ |
| M7 | Docs reframe: ARCHITECTURE.md summary + §5 agent-first (brief = the agent's proactive opening move over the same fact store + engines its tools call; §5 tool roster corrected to the six shipped tools); USERS.md adds multi-turn/tool-chaining use cases (imaging drill-down thread, dose-math drill-down, contradiction-resolution thread) each with why-an-agent; 20-vs-70 patients/day inconsistency fixed; `baselines.md` notes the deliberate chat exclusion from load profiles | main | — | review | ☐ |
| M8 | Demo video #3 script (feeds S3.6): conversation-led — brief framed as what the agent already prepared → 3–4-turn thread with visible tool chips + citations → imaging drill-down → mid-conversation cross-patient refusal → Langfuse trace of the thread under one correlation ID | main + user | M1–M7 | review | ☐ |
| M9 | *(stretch — approve before build)* Brief-as-turn-zero: new conversations seeded with a compact brief summary as the opening assistant message — the transcript literally opens with the brief (replayable via `GET /api/chat`, Bruno-runnable) | main | M6 | unit + screenshot | ☐ |

## Standing rules

- **Sequencing invariant:** platform (P0) before code; skeleton deployed before surface; the embed timebox decision falls at Phase-2 midpoint.
- **Subagent protocol:** worktree isolation for parallel tickets; every subagent diff gets a code-review pass before merge; no subagent touches `sidecar/src/schemas/` after S1.2 lands except via main.
- **Session continuity:** each new session starts by reading this file + `docs/HANDOFF.md` + `docs/execution/DECISIONS.md`. Status updates are commits, not memory.
- **Live verification:** the dev session never assumes live behavior — CI smoke (S1.10) is the arbiter.
- **Software-factory conventions** (`.claude/skills/software-factory/`) apply to all build work: GATE 1 = this plan approved before Phase 1 code; GATE 2 = deploys/pushes per the already-authorized Railway flow, with anything scope-changing or hard-to-reverse re-gated explicitly. Code style: 1–3-line file header comments (what/why), no speculative abstraction, fewer files, dependencies must pull real weight. Communication: quiet during routine work; every judgment call surfaced as a vetoable `DECISION:` one-liner and logged to `DECISIONS.md`. Verification findings (including the **untested** list) are written to the state docs, not just chat. Healthcare domain escalation: verification design is production-grade at every tier.
