# K.4 — Ophthalmology/Retina scoping: dashboard context (module) + narrowed main menu (per-user custom menu)

REQ: roadmap (no W2 register REQ) · Depends on: running EHR stack (local dev or the deployed EHR) for verification; K.5 sequencing note below · Band: merged-plan Track 1 (K, trimmed) · Priority: P0 within sub-track K (per merged-plan.md; "whenever there's spare time, not deadline-bound")

> **Scope honesty banner — read before estimating.** The merged plan says
> "this repo already has a purpose-built module for exactly this
> (`oe-module-dashboard-context/`, an admin-configurable menu/dashboard
> scoping tool)". **Investigated and corrected:** the module scopes
> **patient-dashboard WIDGETS only** — its entire runtime surface is
> demographics-page widget visibility (`DashboardContextService.php`
> `MANAGEABLE_WIDGETS`/`WIDGET_TO_HIDDEN_CARD_MAP`); its only menu code
> ADDS one "Admin → Dashboard Contexts" item (`src/Bootstrap.php:159
> addCustomMenuItem` on `MenuEvent::MENU_UPDATE`) and scopes nothing. Main-
> menu narrowing is NOT in its capability surface. The honest K.4 is
> therefore two legs: **(a)** author an Ophthalmology/Retina context inside
> the module (widget scoping), and **(b)** narrow the main menu via
> OpenEMR's supported per-user custom-menu mechanism — which, verified, is
> **NOT** "drop a json into `interface/main/tabs/menu/menus/`": custom menus
> load from the site directory (`sites/<site>/documents/custom_menus/*.json`)
> and are selected per user via `users.main_menu_role`.

## Why

Confirmed: the product currently adds one card on one dashboard page inside
an otherwise completely untouched, full generic OpenEMR menu (~2,300-line
`standard.json`) — Fees, Batch Communication Tool, DICOM viewer, etc., all in
Dan's face. A retina surgeon's demo login should land on a menu and a patient
dashboard scoped to the retina workflow. Both legs are configuration-shaped
and reversible; neither touches stock OpenEMR core files.

## Existing seams you MUST reuse (all verified against source)

**Leg (a) — the dashboard-context module** (`interface/modules/custom_modules/oe-module-dashboard-context/`):

- `src/Services/DashboardContextService.php:26-35` — the system contexts are PHP constants (`CONTEXT_PRIMARY_CARE = 'primary_care'` … `CONTEXT_GERIATRIC`); **no ophthalmology context exists** (confirmed; README's table matches).
- `src/Services/DashboardContextService.php:373-386` — `getAvailableContexts(): array` returns `[context_key => xl('Label')]`; a new system context needs a row here.
- `src/Services/DashboardContextService.php:107` — `private const DEFAULT_CONTEXT_WIDGETS = [ self::CONTEXT_X => ['<widget_id>' => true, …], … ]` — per-context default widget visibility; `getDefaultContextWidgets()` (line 403) falls back to primary_care for unknown keys.
- `src/Services/DashboardContextService.php:47-76` — `MANAGEABLE_WIDGETS` (the legal widget ids, e.g. `labdata_ps_expand`, `medication_ps_expand`).
- Alternative DB path (deployment-only, no code): `createCustomContext()` (line 446) inserts into `dashboard_context_definitions` with `is_global=1` — the Admin UI's "Contexts" tab (`public/admin.php`) drives it. Key is auto-generated `custom_<slug>_<timestamp>`.
- `sql/install.sql` — tables only, **zero INSERTs**: stock contexts are code-defined, so "following how its existing contexts are defined" = the code path, not a SQL seed.
- Module install/enable: `README.md` — Admin > System > Modules → Install → Enable; registry row lands in the `modules` table (see K.5's seams).

**Leg (b) — the main-menu mechanism** (`src/Menu/`):

- `src/Menu/MainMenuRole.php:117-127 getMenuRole()` — reads `users.main_menu_role` for the logged-in user; empty ⇒ `"standard"`.
- `src/Menu/MainMenuRole.php:52-59 getMenu()` — value **without** `.json` ⇒ loads `interface/main/tabs/menu/menus/<name>.json` (stock: `standard`, `answering_service`, `front_office`, plus a legacy `chart_review`); value **with** `.json` ⇒ loads `OE_SITE_DIR . "/documents/custom_menus/" . <value>` — i.e. `sites/<site>/documents/custom_menus/`.
- `src/Menu/MainMenuRole.php:83-110 displayMenuRoleSelector()` — the per-user "Main Menu Role" dropdown = 3 hardcoded stock options + every `*.json` found in the site's `custom_menus` dir. **This is why a new file in `interface/main/tabs/menu/menus/` is NOT selectable** — only `custom_menus/` files auto-appear. (This corrects the merged-plan briefing's "custom menus land in interface/main/tabs/menu/menus/".)
- `src/Menu/MenuRole.php:69 menuApplyRestrictions()` — per-item `acl_req` / `global_req` filtering (`menuAclCheck` → `AclMain::aclCheckCore`). Menu JSON entries keep their ACL semantics — copy entries verbatim from standard.json, and per-item ACL keeps working.
- User assignment surface: Administration → Users → (user) → **Main Menu Role** select (rendered by `displayMenuRoleSelector`).
- Deployment wrinkle (DECISIONS.md 2026-07-08 ops note + USER-ACTIONS item 5): the deployed EHR mounts a Railway **volume at `/var/www/localhost/htdocs/openemr/sites`** and the EHR DB persists across redeploys. A repo commit under `sites/` therefore does NOT reach the deployed instance (the volume shadows it) — the deployed copy must be placed into the volume (Railway SSH, as RUNBOOK §A already does for scripts) or uploaded via an admin path.

## Files to create/modify

- `interface/modules/custom_modules/oe-module-dashboard-context/src/Services/DashboardContextService.php` — new constant + `getAvailableContexts()` row + `DEFAULT_CONTEXT_WIDGETS` entry (leg a).
- `interface/modules/custom_modules/oe-module-dashboard-context/README.md` — add the new context row to its "Available Contexts" table.
- `sites/default/documents/custom_menus/ophthalmology-retina.json` — new (leg b). **Verified:** this directory exists in the repo, is NOT git-ignored, and already carries a tracked exemplar `Custom.json` (78 KB — a full stock-menu copy shipped as the customization starting point; there is also `patient_menus/Custom.json`). Commit the new menu beside `Custom.json`; deployment placement onto the volume-backed live EHR is still the documented step in the wrinkle above.
- `docs/RUNBOOK.md` — short new subsection under §B (the chart-embed/EHR-config section): how the context + menu are applied per user, incl. the volume copy-in for the deployed EHR.
- File headers: preserve existing author/copyright lines and append per CLAUDE.md's header rules when editing the module PHP.

## Step-by-step implementation

1. **Re-verify the investigation** (cheap, keeps the spec honest against drift): `grep -rin "menu" interface/modules/custom_modules/oe-module-dashboard-context/src/` — expect only the Bootstrap `MenuEvent::MENU_UPDATE` *additive* listener. If a future module version grew real menu scoping, STOP and re-scope leg (b) onto it.
2. **Leg (a) — the context, code path** (matches how the 9 stock contexts are defined):
   - Add `public const CONTEXT_OPHTHALMOLOGY_RETINA = 'ophthalmology_retina';` beside the other constants (line ~35).
   - Add `self::CONTEXT_OPHTHALMOLOGY_RETINA => xl('Ophthalmology / Retina'),` in `getAvailableContexts()`.
   - Add a `DEFAULT_CONTEXT_WIDGETS` entry. Starting visibility set (true = shown), chosen for the retina workflow — review with the user in the PR, it is product surface: `allergy_ps_expand`, `medical_problem_ps_expand`, `medication_ps_expand`, `prescriptions_ps_expand`, `labdata_ps_expand`, `vitals_ps_expand`, `appointments_ps_expand`, `clinical_reminders_ps_expand`, `demographics_ps_expand`, `pnotes_ps_expand`. Omit (⇒ hidden): billing, insurance, portal, disclosures, amendments, immunizations, tracks, recalls, care-preference pair, photos, adv directives, health concerns, medical devices, careteam. Use only ids present in `MANAGEABLE_WIDGETS` (line 47) — anything else silently no-ops.
3. **Leg (b) — the menu.** Construct `ophthalmology-retina.json` by **deletion from a copy of `interface/main/tabs/menu/menus/standard.json`** — never hand-author entries (labels/menu_ids/targets must stay byte-identical for translation + tab-JS targeting). Keep top-level sections: Calendar, Messages, Patient/Client (trim children to Patients/New-Search/Current), Modules, Admin (its `acl_req` already restricts it to admins), Reports (trim to clinical reports), Miscellaneous (trim). Delete: Fees, Procedures (unless the practice orders labs through it — user call, ask in PR), Portal, and the misc bloat. The co-pilot chart card is dashboard-embedded (RUNBOOK §B), not a menu item — nothing to add for it.
4. **Local verification stack** (PHP leg needs a running EHR): `cd docker/development-easy && docker compose up --detach --wait` (honest note: the dev container is likely NOT already running in this repo's executing environment; budget its first boot, and all in-container commands go through `openemr-cmd`). Then in the running EHR (localhost:8300, admin/pass):
   - Admin > System > Modules → install + enable "Dashboard Context Service" (its registry row is DB state — a fresh dev DB ships without it; see K.5's `modules` table seams).
   - Copy the menu json into the site dir if the container path differs from the bind mount; confirm it appears in Administration → Users → admin → Main Menu Role dropdown; select it.
   - Patient dashboard → Dashboard Context widget → select "Ophthalmology / Retina" → widgets narrow per Step 2's set.
5. **Per-role proof (merged-plan verification section):** log in as each demo role (the three Wave-P clinician users — credentials are with the user, never in repo; on local dev create three users with Physician/Nurse/Front-office profiles), set each user's Main Menu Role to the custom menu, screenshot landing menu + patient dashboard **before and after** — attach to the PR. Selenium/Panther (CLAUDE.md "Browser debugging via Selenium") can drive + screenshot this reproducibly.
6. **Deployment placement** (deployed EHR): document in the RUNBOOK subsection — copy the json into the volume-backed `sites/default/documents/custom_menus/` via Railway SSH (same access RUNBOOK §A uses), then per-user Main Menu Role via the admin UI. DB + volume persist across redeploys, so this is one-time.
7. PHP quality pass + tests + trackers + ship.

## What NOT to do

- Do NOT hand-edit `interface/main/tabs/menu/menus/standard.json` — shared, upstream, confirmed untouched history-wide; the merged plan forbids it explicitly.
- Do NOT put the new menu file in `interface/main/tabs/menu/menus/` expecting it to be selectable — verified: the selector only enumerates the site `custom_menus/` dir; a core-dir file would also be an upstream-tree edit.
- Do NOT implement menu scoping INSIDE the dashboard-context module (e.g. a MENU_UPDATE listener that prunes entries) — tempting, but it duplicates a supported core mechanism (custom menus + per-user role), hides menu shape in event-listener code, and breaks the module's single widget-scoping purpose. Leg (b) uses the core mechanism.
- Do NOT delete ACL'd admin entries from the custom menu to "clean up" — `acl_req` already hides them from non-admins; deleting them locks admins out too.
- Do NOT edit `sql/install.sql` to seed the context — stock contexts are code-defined; a SQL seed would create a second source of truth (and `install.sql` runs only on module install).
- Do NOT disable the module as part of this ticket (that interaction belongs to K.5 — see its dashboard-context conditional).
- PHP standards apply (CLAUDE.md): strict edits, no new baseline entries for code you touch — run phpstan and fix what your diff introduces.

## Acceptance checks

```bash
openemr-cmd pst
openemr-cmd pr
php -l interface/modules/custom_modules/oe-module-dashboard-context/src/Services/DashboardContextService.php
python3 -m json.tool sites/default/documents/custom_menus/ophthalmology-retina.json > /dev/null && echo MENU_JSON_VALID
```

Manual/Selenium: per-role login shows the narrowed menu (not stock), the
Dashboard Context dropdown offers "Ophthalmology / Retina", and selecting it
hides the Step-2 omitted widgets. Before/after screenshots attached to PR #16
(the merged plan's stated evidence for K.4/K.5).

## Tests to add

- If the module has no test coverage hook in this repo's PHP suites (check `tests/Tests/` for custom-module coverage patterns first), the minimum is: a unit test asserting `getAvailableContexts()` contains `ophthalmology_retina` and `getDefaultContextWidgets('ophthalmology_retina')` returns only keys present in `getManageableWidgets()` — home it following the existing unit-test layout under `tests/Tests/Unit/` (mirror a neighboring service test's namespace/structure).
- Menu json: no PHP test harness exists for custom menus; the `python3 -m json.tool` parse check above plus the Selenium screenshot flow is the regression evidence.

## Tracker updates

- `docs/internal/build-status.html` DATA block: ticket `K.4` (T1 section) → `s: "done"`.
- `docs/w2/requirements.md` — no checkbox; do not invent one.
- `W2_ARCHITECTURE.md` — no section covers EHR menu config; no edit.

## Verify + ship ritual

PHP-side ticket — per merged-plan standing rule 3 + CLAUDE.md, the checks run
in the openemr container (`openemr-cmd phpstan`, `openemr-cmd psr12-report`,
`openemr-cmd unit-test` for the touched suite), with the honest note that the
dev stack may need `cd docker/development-easy && docker compose up --detach
--wait` first. Sidecar untouched, but the PR gate runs the eval suite anyway:

```bash
cd sidecar && npm test && npm run typecheck && npm run eval && npm run build
```

Panel untouched — skip the panel leg. Then: conventional commit
(`feat(dashboard-context): ophthalmology/retina context + narrowed per-user menu`)
with `--trailer "Assisted-by: Claude Code"` (trackers in the SAME commit) →
`git push -u origin claude/merged-eval-course-plan-ky6ulh` → update the
PR #16 body → SendUserFile `docs/internal/build-status.html`.
