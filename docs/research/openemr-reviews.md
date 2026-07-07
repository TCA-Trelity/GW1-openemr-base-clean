# OpenEMR fork — codebase review notes (Understand phase)

*Condensed technical findings from the two parallel reviews that fed
`AUDIT.md` and the PRD's fence register. Kept as working reference for
Tier-1 implementation; `AUDIT.md` is the graded document.*

## API + auth surface

- **Routing:** all REST enters `apis/dispatch.php` → `ApiApplication`
  (`src/RestControllers/ApiApplication.php`) on Symfony HttpKernel with an
  event-subscriber pipeline (SiteSetup, CORS, OAuth2Authorization,
  Authorization, RoutesExtension, ViewRenderer, ApiResponseLogger,
  SessionCleanup, ExceptionHandler, Telemetry). Route maps:
  `apis/routes/_rest_routes_standard.inc.php` (717 lines),
  `_rest_routes_fhir_r4_us_core_3_1_0.inc.php` (876 lines), portal routes.
- **Standard API domains:** patient (76-104), problem list (209-252), meds
  (298-330) + prescriptions/drugs (652-680), allergies (253-297), encounters
  + soap/vitals (105-186), appointments (397-433), documents (496-515).
  **No standard lab endpoint — labs are FHIR-only** (DiagnosticReport/
  Observation).
- **FHIR R4 US Core:** ~31 resource types incl. Patient (rw), Practitioner
  (rw), Organization (rw), Condition, MedicationRequest, AllergyIntolerance,
  Encounter, Observation, DiagnosticReport, DocumentReference (+`$docref`),
  Provenance, Bulk `$export`. Most clinical resources read/search only.
- **OAuth2** (`AuthorizationController.php:697-761`): authorization_code+PKCE,
  refresh_token, password (gated by `oauth_password_grant` global),
  client_credentials (JWT assertion, `system/` scopes). Dynamic client
  registration (RFC 7591), introspection. **SMART-on-FHIR:**
  `src/RestControllers/SMART/`, `.well-known/smart-configuration`, EHR-launch
  + standalone; patient-context tokens bind to one patient UUID.
- **Enforcement is real at the API layer (two stages):** PEP1 token+scope
  (`BearerTokenAuthorizationStrategy::authorizeRequest:141-235`), PEP2
  per-route (`HttpRestRouteHandler::checkSecurity:141-200` →
  `RestApiSecurityCheckEvent` → `AuthorizationListener:134-196`); plus every
  route closure calls `RestConfig::request_authorization_check()` (gacl
  section check, `RestConfig.php:180-194`).
- **THE gap:** `checkUserHasAccessToPatient()` =`return true;`
  (`BearerTokenAuthorizationStrategy.php:479-485`, TODO). gacl is
  section/role-level only (`AclMain.php:166-238`; superuser short-circuit
  :174; deny-over-allow :232-237). No provider↔patient panel scoping for
  staff.
- **Local API path:** `LocalApiAuthorizationController` — `APICSRFTOKEN`
  header + session ⇒ skips OAuth scopes (`skipAuthorization`,
  `AuthorizationListener:154`) but still runs route ACLs; excluded from API
  logging. We do NOT use it (sidecar is cross-origin; SMART chosen).
- **Audit:** `api_log` (user_id, patient_id, ip, method, request, response
  at option 2) via `ApiResponseLoggerListener:39-104`; token auth events →
  `log` (`BearerTokenAuthorizationStrategy:299-316`); fork-added pluggable
  sinks: `LogTablesSink`, `MultiSink`, `AtnaSink` (IHE ATNA/TCP),
  `BreakglassChecker` force-logging (`EventAuditLogger.php:409`).
- **Weaknesses noted:** dispatch.php `$e->getMessage()` in 500s (:41-44);
  unauthenticated `POST /api/background_service/$run` (:705-716, by design);
  ROPC exists; `system/` scopes patient-unbound (by design).
- **Fork modernizations:** OEHttpKernel pipeline, `OEGlobalsBag`,
  `OpenEMR\BC` DI/DBAL layer (Doctrine DBAL 4 behind ADODB surface),
  strict-typed authorization strategies.

## Integration points + data model + ops

- **Module system:** one `modules` DB table; type 1 = Laminas
  (`interface/modules/zend_modules/`), type 0 = custom
  (`interface/modules/custom_modules/`). Loader
  `src/Core/ModulesApplication.php` — custom modules `include` their
  `openemr.bootstrap.php` with `$module` + `$eventDispatcher` in scope
  (:132-179); missing bootstrap auto-disables; `MODULES_LOADED` event (:163).
  Enable via Admin → Modules (Installer Laminas module). Skeletons to copy:
  `oe-module-dashboard-context` (clean 23-line bootstrap; menu + heading
  injection), `oe-module-comlink-telehealth` (full UI+external-service module:
  `src/Bootstrap.php:153+` wires AppointmentSetEvent, Twig override, body-
  script injection, globals), `oe-module-faxsms` (external HTTP providers).
- **UI injection events:** patient-summary cards
  `src/Events/Patient/Summary/Card/{CardInterface,RenderEvent,SectionEvent}.php`
  (consumed in `demographics.php`); `PatientDemographics/RenderEvent`
  section hooks; `UserInterface/PageHeadingRenderEvent` (title-bar);
  `Main/Tabs/RenderEvent::EVENT_BODY_RENDER_POST` (global scripts);
  `Menu/MenuEvent` (menus JSON at `interface/main/tabs/menu/menus/`);
  `Events/Encounter/*`; REST extension via `Events/RestApiExtend/*`.
- **Patient summary as-is:** `demographics.php` (2080 lines) = hardcoded Twig
  cards (allergies/problems/meds/rx :1090-1250) + ViewCards
  (demographics/billing/insurance/care-team :1253-1348) + event-dispatched
  cards per section (:1385-2019) with lazy `*_fragment.php` AJAX. Density
  forces: billing cards, certification artifacts (reminders/disclosures/
  amendments/care-prefs), LBF auto-append (`lbf_fragment.php`).
- **Clinical tables:** `lists` (:7671, polymorphic problems/allergies/meds +
  `lists_medication`), `issue_encounter` (:3437), `prescriptions` (:8698),
  `form_vitals` (:2418), `form_encounter` (:2022) + `forms` spine (:2460),
  `form_clinical_notes`/`form_soap`, labs `procedure_order/report/result`
  (:10369/10467/10493), appointments `openemr_postcalendar_events` (:8261,
  `pc_apptstatus`; statuses in `list_options` `apptstat` :4457 — `@` arrived
  flag), tracker `patient_tracker(+_element)` (:8558), `documents` (:1391),
  `history_data` (:2916). **Ophthalmology:** eye_mag form with 17
  `form_eye_*` tables (:13539-14053: base,hpi,ros,vitals,acuity,refraction,
  biometrics,external,antseg,postseg,neuro,locking + mag_dispense/prefs/
  orders/impplan/wearing); logic in
  `interface/forms/eye_mag/php/eye_mag_functions.php`.
- **Demo data:** `sql/example_patient_data.sql` = 14 `patient_data` rows
  only + 2 providers (`example_patient_users.sql`). No clinical content, no
  eye content, no generator tooling.
- **Check-in hook:** `library/appointment_status.inc.php`
  `updateAppointmentStatus()` → `manage_tracker_status()`
  (`library/patient_tracker.inc.php`) → `PatientTrackerService` emits
  `ServiceSaveEvent::EVENT_POST_SAVE`; filter with
  `AppointmentService::isCheckInStatus()`. Precedent:
  `PatientFlowBoard/.../PatientFlowBoardEventsSubscriber.php`. No first-class
  "check-in" event; no Symfony Messenger (cron `bin/console` only —
  `Documentation/MIGRATION_GUIDE_CRONJOBS.md`).
- **Docker:** `docker/flex` builds image whose entrypoint clones
  `FLEX_REPOSITORY`@`FLEX_REPOSITORY_BRANCH` at first boot, runs composer/npm,
  auto-configures DB (`MYSQL_*`, `OE_USER/OE_PASS`), idempotent via
  `sites/docker-completed` (`openemr.sh:458,1094`); source lives at
  `/var/www/localhost/htdocs/openemr` (volume there persists everything).
  `docker/production` = pinned-image minimal stack.
- **Engineering bar for our PHP:** strict_types, PSR-4, PHPStan lvl 10 w/
  custom rules (`tests/PHPStan/Rules/`), no `$GLOBALS` (OEGlobalsBag), no new
  baselines, module SQL install or Doctrine migrations, Twig render-test
  expectations, conventional commits.
