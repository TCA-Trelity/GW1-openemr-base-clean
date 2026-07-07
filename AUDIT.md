# OpenEMR Fork — System Audit

*Audit performed on the fork at commit `ef3d490` (single squashed import of
OpenEMR master, pruned). Findings cite `path:line`. This audit is the input
to `ARCHITECTURE.md`; the AI integration plan traces back to it.*

---

## Summary

We audited this OpenEMR fork before designing the Clinical Co-Pilot, across
five dimensions. The single most consequential finding is an **authorization
gap**: OpenEMR enforces role/section permissions correctly at the API layer,
but its per-patient access check is unimplemented —
`BearerTokenAuthorizationStrategy::checkUserHasAccessToPatient()`
(`src/RestControllers/Authorization/BearerTokenAuthorizationStrategy.php:479-485`)
is a hardcoded `return true;` with a TODO. Any authenticated clinician can
read any patient's record through the API. This is not a bug we fix in core
(it is upstream, load-bearing, and out of scope) — it is a constraint that
**shapes our entire design**: the co-pilot constructs patient-level access
control it cannot inherit, via SMART-on-FHIR launch tokens bound to a single
patient for the interactive surface, and a separate read-only credential for
background preparation.

**Security.** Beyond the per-patient gap, the API layer is otherwise sound:
every route runs both an OAuth2 scope check and a phpGACL role/section ACL
(defense-in-depth; `HttpRestRouteHandler::checkSecurity()` +
`AuthorizationListener::onRestApiSecurityCheck()`). Three lesser issues: the
top-level dispatcher leaks raw exception messages in 500 responses
(`apis/dispatch.php:41-44`), contradicting the repo's own coding standard; a
`background_service/$run` route is intentionally unauthenticated
(`_rest_routes_standard.inc.php:705-716`); and the ROPC password grant exists
behind a global flag. None blocks the MVP; all are recorded for hardening.

**Performance.** The patient summary screen is assembled from three
overlapping mechanisms (hardcoded Twig cards, ViewCard objects, event-
dispatched cards) with many lazy AJAX fragment loads — dense and chatty, but
not our latency path. The load-bearing performance constraint for us is
architectural: **OpenEMR has no async queue** (no Symfony Messenger; cron +
synchronous listeners only), so any long-running AI work must live outside
the EHR. Our preparation pipeline owns its own queue in the sidecar; the
in-EHR check-in listener only fires a non-blocking notification.

**Architecture.** Integration points are first-class and well-suited to our
"additive layer" approach: a modern custom-module system with card-injection
events, a FHIR R4 API surface, OAuth2/SMART support, and a real audit-log
subsystem. We integrate through these, touching no core data structures.

**Data quality.** The fork ships **14 demographics-only sample patients**
(`sql/example_patient_data.sql`) — no encounters, medications, problems,
labs, or eye exams, and zero ophthalmology content, despite a full 17-table
eye-exam schema existing (`form_eye_*`). Any credible demo or agent eval must
seed its own realistic clinical data; we do (Margaret Chen + William Thompson,
converted from the validated prototype corpus).

**Compliance.** API access is genuinely audit-logged with user identity
(`api_log` table via `ApiResponseLoggerListener`), and the fork adds a
pluggable IHE-ATNA syslog sink and a breakglass concept — a strong compliance
foundation. The BAA-with-LLM-provider requirement is satisfied by assumption
per the project brief; PHI handling is deferred (synthetic data only).

---

## Security audit

### S1 — No per-patient access control for clinicians *(Critical)*
`BearerTokenAuthorizationStrategy::checkUserHasAccessToPatient()`
(`src/RestControllers/Authorization/BearerTokenAuthorizationStrategy.php:479-485`)
returns `true` unconditionally (TODO in source). The gacl ACL
(`src/Common/Acl/AclMain.php:166-238`) is **section/role**-level only — e.g.
`patients/med`, `encounters/notes` — with no provider-to-patient-panel
scoping, and superuser short-circuits to allow-all (`:174`). Net: any user
who passes the section ACL can read **any** patient via the API. The
patient-context binding that *does* exist applies only to the `patient` role
(SMART patient launch), not to staff.
**Impact on our design:** we cannot rely on OpenEMR for patient-scope
authorization for staff. We construct it — SMART EHR-launch tokens bound to
one patient (interactive surface) and a read-only, pipeline-scoped credential
(background preparer). See `ARCHITECTURE.md` §Authorization.

### S2 — Exception-message disclosure in API 500s *(Medium)*
`apis/dispatch.php:41-44` returns `$e->getMessage()` in the JSON body of a
500. This can leak SQL fragments or file paths, and directly contradicts the
repo's own rule ("Never expose `$e->getMessage()` in user-facing output",
`CLAUDE.md`). Deeper handlers (`HttpRestRouteHandler`) correctly return
generic messages, so the exposure is confined to unhandled top-level errors.
**Disposition:** upstreamable fix; scheduled Tier 2 (PRD U2.4).

### S3 — Unauthenticated background-service route *(Medium, by design)*
`POST /api/background_service/$run` has no `request_authorization_check`
(`apis/routes/_rest_routes_standard.inc.php:705-716`), documented as
intentional. Abuse requires knowledge of internal service names, but a
force-run of privileged services should be confirmed impossible.
**Disposition:** exposure accepted and documented for Tier 0; verified /
neutralized in Tier 2.

### S4 — First-party ROPC password grant *(Low)*
A `password` grant (`CustomPasswordGrant`) is available behind the
`oauth_password_grant` global (`AuthorizationController.php:736`). Fine for
first-party use; must stay disabled for any third-party client. Our sidecar
uses authorization-code/SMART (interactive) and client-credentials
(preparer) — never ROPC.

### S5 — Broad `system/` client-credentials scopes *(Low, inherent)*
`system/*.read` and bulk `$export` scopes are patient-unbound by design. Our
preparer uses the narrowest system scopes it needs, read-only, and every
access is audit-logged (see Compliance).

**Enforcement that is correct (for the record):** every standard route calls
`RestConfig::request_authorization_check()` before its controller
(`src/RestControllers/Config/RestConfig.php:180-194`), and the pipeline runs
a two-stage PEP (token+scope at `kernel.request`, per-route scope via
`RestApiSecurityCheckEvent`) — `AuthorizationListener.php:1-13,134-196`. API
authorization is **not** UI-only.

---

## Performance audit

- **No async job queue.** `symfony/messenger` is absent from `composer.json`;
  background work is cron-driven `bin/console` commands
  (`Documentation/MIGRATION_GUIDE_CRONJOBS.md`) plus synchronous event
  listeners. **Constraint:** long AI work cannot run inside a request or a
  synchronous listener. Our design puts the queue (BullMQ/Redis) in the
  sidecar; the in-EHR check-in listener does a ≤250 ms fire-and-forget POST
  and never blocks the tracker save.
- **Patient summary composition cost.** `interface/patient_file/summary/demographics.php`
  (2,080 lines) assembles the screen from hardcoded Twig cards, ViewCard
  objects, and per-item `CardRenderEvent` dispatches, many hydrated by lazy
  AJAX `*_fragment.php` calls. This is chatty but it is the *legacy* screen,
  not our surface — our brief is a single precomputed read.
- **Clinical data shape.** Problems/allergies/medications share one
  polymorphic `lists` table (`sql/database.sql:7671`); encounters use a
  `form_encounter` header + a `forms` join spine (`:2022`, `:2460`); labs are
  `procedure_order/report/result` (`:10369+`). Reads for a single patient are
  modest; nothing here threatens our <1 s brief-open target, which is served
  from the precomputed bundle regardless.
- **Latency implication for the agent.** Because OpenEMR can't do the heavy
  lifting inline, the "move the thinking to the waiting-room gap" design is
  not just preferable — it is the only shape the platform's performance model
  allows. Interactive latency then reduces to a database read plus a fast-
  model chat turn, neither of which touches OpenEMR in the hot path.

---

## Architecture audit

- **Custom-module system** (`interface/modules/custom_modules/`, PSR-4,
  Symfony-event based; lifecycle in `src/Core/ModulesApplication.php:132-179`).
  Clean skeletons exist to copy — `oe-module-comlink-telehealth` (embeds an
  external session + injects scripts on every page) and
  `oe-module-dashboard-context` (drops UI into the demographics title bar).
- **Documented UI-injection points:** patient-summary card events
  (`src/Events/Patient/Summary/Card/` — `CardInterface`, `RenderEvent`,
  `SectionEvent`), page-heading/nav injection
  (`PageHeadingRenderEvent`), body/script injection
  (`Main/Tabs/RenderEvent::EVENT_BODY_RENDER_POST`), and menu mutation
  (`MenuEvent`). Our brief card injects via `SectionEvent`/`CardRenderEvent`.
- **Check-in signal exists** (derived, not first-class): appointment status
  flows through `PatientTrackerService` emitting
  `ServiceSaveEvent::EVENT_POST_SAVE`, filtered by
  `AppointmentService::isCheckInStatus()`. Shipped precedent:
  `interface/modules/zend_modules/module/PatientFlowBoard/.../PatientFlowBoardEventsSubscriber.php`
  does exactly this. This is our preparation trigger.
- **API surface** (integration point for the sidecar): FHIR R4 US Core
  (`apis/routes/_rest_routes_fhir_r4_us_core_3_1_0.inc.php`, 38 controllers —
  Patient, Condition, MedicationRequest/Statement, AllergyIntolerance,
  Encounter, Observation, DiagnosticReport, DocumentReference, etc.), standard
  REST (`_rest_routes_standard.inc.php`), OAuth2 + SMART
  (`src/RestControllers/SMART/`, `.well-known/smart-configuration`). **Lab
  results are FHIR-only** (`DiagnosticReport`/`Observation`) — no standard-API
  lab endpoint — which pushes the sidecar to FHIR-first reads.
- **Deploy shape:** `docker/flex` builds OpenEMR from a configurable fork repo
  at container start (`FLEX_REPOSITORY*` env vars) — the mechanism our Railway
  deploy uses; `docker/production` is the minimal self-contained stack.
- **Fork engineering bar:** PHPStan level 10 with custom rules
  (`tests/PHPStan/Rules/`), strict types, Doctrine Migrations for schema,
  isolated tests. Any PHP we add (the module) must clear this bar with zero
  new baseline entries.

---

## Data quality audit

- **Sample data is thin and non-clinical.** `sql/example_patient_data.sql`
  inserts **14 `patient_data` rows only** (demographics; San Diego addresses;
  DOBs 1933–1977) plus two provider users
  (`sql/example_patient_users.sql`). No encounters, issues, medications,
  vitals, labs, prescriptions, or eye exams ship. A grep for
  `ophthalm|glaucoma|retina|visual acuity|slit lamp` across the demo/schema
  matches only the `form_eye_*` schema definitions — **never** patient
  content.
- **Ophthalmology machinery exists, unused.** A full eye-exam form
  (`interface/forms/eye_mag/`) with 17 `form_eye_*` tables
  (`sql/database.sql:13539+` — acuity, refraction, anterior/posterior segment,
  impression/plan) is present but seeded with no patients.
- **No synthetic-data generator.** There is no faker/fixture tooling; seeding
  goes through the REST/FHIR API, the e2e harness, or direct service/SQL
  writes.
- **Agent-failure implications.** For a co-pilot, empty/degenerate data *is*
  the adversary: missing medication lists, absent encounter history, and the
  complete lack of imaging or contradictions would make any demo hollow and
  any eval trivially green. We therefore seed a realistic, deliberately
  *messy* corpus — Margaret Chen (12 source documents, 4 planted, ground-
  truthed contradictions, HCQ monitoring) and William Thompson (wet-AMD
  treat-and-extend imaging trajectory) — converted from the prototype Dan
  validated. The planted contradictions double as the eval suite's ground
  truth: every demo is a test run.

---

## Compliance & regulatory audit

- **API access is audit-logged with identity.** `ApiResponseLoggerListener::onRequestTerminated()`
  (`src/RestControllers/Subscriber/ApiResponseLoggerListener.php:39-104`)
  writes `api_log` (user_id, patient_id, IP, method, resource, URL, and — at
  option 2 — the response body) for every non-local API request when
  `api_log_option > 0`. Token auth success/failure is separately logged to
  `log` with client id + user id + IP
  (`BearerTokenAuthorizationStrategy.php:299-316`). **This gives our read-only
  preparer an independent, platform-native audit trail** — a second overlapping
  record beside the sidecar's own correlation-ID traces.
- **Fork-added compliance infrastructure.** The audit subsystem was refactored
  into a pluggable sink model — `LogTablesSink`, `MultiSink`, an IHE-**ATNA**
  syslog sink (`AtnaSink` / `Atna\TcpWriter`) for SIEM export, plus a
  **breakglass** emergency-access concept (`BreakglassChecker`,
  `AuditConfig::forceBreakglass`) that forces logging even when otherwise
  disabled (`EventAuditLogger.php:409`). These are 2026-copyright fork
  additions — a stronger audit posture than stock.
- **Audit-logging requirement (HIPAA §164.312(b)):** satisfied at the API
  layer for our reads; the sidecar adds request-level correlation IDs so a
  full "who asked what, which records were touched" trace reconstructs from
  logs alone.
- **Data retention / breach posture:** OpenEMR provides disclosure logging
  (`extended_log`) and the sink model above. For the pilot phase, retention
  and breach-notification policy attach to the BAA-capable host, not the demo
  host.
- **BAA implications of sending PHI to an LLM.** Per the project brief we act
  as if a BAA is signed with the LLM provider (Anthropic offers HIPAA-ready
  BAA-covered access as of Jan 2026). This week uses **synthetic data only**,
  so no PHI leaves the boundary regardless. One real constraint to carry
  forward: the strictest zero-data-retention model configurations exclude some
  newest tiers (which require 30-day retention), so model-tier and retention
  policy are chosen together in the pilot.
- **Not-CDS wording (regulatory line):** the co-pilot surfaces facts and
  computations and cites them; it does not state diagnoses or prescribe
  treatment. The physician drives. This keeps the tool clear of FDA clinical-
  decision-support regulation, matching the design partner's own guidance.

---

## How the audit changed the plan

1. **S1 → dual-credential authorization.** The unimplemented per-patient
   check is the reason the interactive surface uses a patient-bound SMART
   token and the preparer a separate read-only credential — we build the
   control OpenEMR doesn't provide.
2. **No async queue → sidecar-owned pipeline.** The platform can't run AI work
   inline, so the queue and workers live outside the EHR; the in-EHR listener
   only notifies.
3. **Thin, non-clinical demo data → seed a messy, ground-truthed corpus.** The
   data-quality gap is why seeding is a first-class unit, and why the seed
   doubles as the eval ground truth.
4. **Strong native audit logging → lean on it.** `api_log` + ATNA give us a
   second, platform-native audit trail beside our own traces — cited in the
   trust story rather than rebuilt.
