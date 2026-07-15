# K.5 — Toggle off the 7 non-applicable modules for this deployment

REQ: roadmap (no W2 register REQ) · Depends on: K.4 (governs the dashboard-context leg — see the conditional below) · Band: merged-plan Track 1 (K, trimmed) · Priority: P1 (per merged-plan.md; not deadline-bound)

> **Deployment-state ticket, mostly not a code ticket.** The toggle is
> **EHR database state** (`modules.mod_active`), applied per deployment via
> the admin UI (or its SQL equivalent) — and the deployed EHR's DB persists
> across redeploys (verified: USER-ACTIONS item 5, "the EHR database
> persists … no per-merge ritual"). So "files to modify" is deliberately
> thin: the documented click path + this repo's runbook record, not a
> migration. Post-grading timing is not strictly required, but do it with
> K.4 so the before/after screenshots come from one pass.

## Why

Stock-plus-fork OpenEMR ships eight custom modules; exactly one is this
product. The other seven are real UI/menu/registry surface for integrations
this deployment does not use (telehealth vendor, lab routing, EHI export,
fax/SMS, prior auth, eRx) — clutter and, worse, half-configured integration
screens a pilot user can wander into. OpenEMR's standard module toggle is
fully reversible (disable ≠ uninstall; no code or module tables are deleted),
so this is safe to revisit for any future deployment that needs one back.

## The 7 targets (directory names verified on disk; display names from each module's `info.txt`)

| # | `mod_directory` (= dirname under `interface/modules/custom_modules/`) | Display name (info.txt) | Merged-plan alias |
|---|---|---|---|
| 1 | `oe-module-comlink-telehealth` | Comlink Telehealth Module v2.0.0 | telehealth video vendor |
| 2 | `oe-module-dorn` | Diagnostic Ordering Result Network (DORN) | lab routing |
| 3 | `oe-module-ehi-exporter` | Electronic Health Information Exporter v1.0.1 | "health-info-exchange exporter" — **naming corrected:** it is the ONC **EHI** (Electronic Health Information) **export** module, not an HIE feed |
| 4 | `oe-module-faxsms` | Fax SMS Email Voice Module | fax/SMS |
| 5 | `oe-module-prior-authorizations` | Advanced Prior Auth | prior-auth |
| 6 | `oe-module-weno` | Weno EZ Integration eRx Module | eRx |
| 7 | `oe-module-dashboard-context` | Dashboard Context Service v1.0.0 | **conditional — see below** |

**NEVER touch:** `oe-module-clinical-copilot` (Clinical Co-Pilot v1.0.0 — the product).

**The dashboard-context conditional (resolves the merged plan's ambiguous
"once K.4 above has repurposed it" wording):** if K.4 has NOT landed yet, the
module is unconfigured generic clutter — disable it (the "pre-K.4" state). If
K.4 HAS landed, the module hosts the Ophthalmology/Retina context and **must
stay enabled** — the list is then 6. Since this spec's Depends-on is K.4,
the expected execution order makes it 6 toggles + an explicit "kept enabled:
dashboard-context (K.4 repurposed)" line in the PR body.

## Existing seams you MUST reuse (verified)

- Admin UI path: **Modules → Manage Modules** — `interface/main/tabs/menu/menus/standard.json:495-509`: label "Manage Modules", url `/interface/modules/zend_modules/public/Installer`, `acl_req ["admin","manage_modules"]`.
- Registry table: `modules` (`sql/database.sql:7786-7808`) — key columns `mod_directory`, `mod_active` (module on/off), `mod_ui_active`. A fresh database seeds ONLY the five legacy zend modules (`Immunization`, `Syndromicsurveillance`, `Documents`, `Ccr`, `Carecoordination` — database.sql inserts); **custom modules get a `modules` row only when installed via the UI**, so each deployment's current state must be queried, not assumed.
- SQL equivalent of the toggle, taken from in-repo code — `interface/modules/custom_modules/oe-module-dashboard-context/src/Services/ModuleService.php:52-57 setModuleState()`:

  ```sql
  UPDATE `modules` SET `mod_active` = ?, `mod_ui_active` = ? WHERE `mod_id` = ? OR `mod_directory` = ?
  ```

- Installer internals (background reading if the UI misbehaves): `interface/modules/zend_modules/module/Installer/src/Installer/Model/InstModuleTable.php:357-372` — the same `mod_active = 1/0` updates behind the Enable/Disable buttons.
- Deployed-EHR access: the EHR admin UI at `https://gw1-openemr-base-clean-production.up.railway.app` (admin credentials per USER-ACTIONS); DB persistence across redeploys verified (item 5's note).
- Verification tooling: Selenium/Panther flow per CLAUDE.md ("Browser debugging via Selenium") for reproducible before/after screenshots on the local stack.

## Files to create/modify

- `docs/RUNBOOK.md` — new short subsection (place beside K.4's, under §B): "Module posture for this deployment" — the table above, the click path, the SQL inventory/toggle equivalents, and the reversibility note. This is the durable record; the DB state itself is per-deployment.
- NO sql migration, NO seed file — justification: (1) `modules` rows are site state created by the installer UI, and a fresh install legitimately starts without them; (2) the deployed DB persists, so a one-time admin action sticks; (3) a migration forcing `mod_active=0` would fight any future deployment that legitimately re-enables one. The documented click path + recorded inventory IS the deliverable, per the merged plan's "deployment-specific" framing.

## Step-by-step implementation

1. **Inventory current state first** (per target environment — local dev stack and the deployed EHR). Admin UI: Modules → Manage Modules shows each module's Registered/Installed/Enabled state. SQL equivalent (local dev: `openemr-cmd shell` then the mysql client; deployed: the Railway DB console):

   ```sql
   SELECT mod_directory, mod_name, mod_active, mod_ui_active FROM modules WHERE mod_directory LIKE 'oe-module-%' ORDER BY mod_directory;
   ```

   Record the result in the PR body. Three possible states per module: no row (never registered — **nothing to disable**, record as such), row with `mod_active=1` (disable it), row with `mod_active=0` (already off, record).
2. **Disable via the admin UI (mechanism of record):** Modules → Manage Modules → each target module's row → **Disable** (the button label pair is Enable/Disable once installed). Do NOT click Unregister/uninstall — that path runs `sql/uninstall.sql` where present (e.g. dashboard-context's drops its config tables) and is NOT the reversible posture this ticket promises.
3. **SQL fallback** (only if a module's UI row misrenders): the `setModuleState` UPDATE above with `mod_active=0, mod_ui_active=0` and the `mod_directory` from the table — one statement per module, then reload Manage Modules to confirm the UI agrees.
4. **Apply to both environments:** the local dev stack (so screenshots/dev match) and the deployed EHR (the actual deliverable). Deployed-EHR steps are admin-UI clicks by whoever holds the admin login — if that is user-only, mirror the exact steps as a new USER-ACTIONS item and mark the ticket blocked-on-user for that half (update `docs/internal/user-actions.html` together with it, per the footer rule).
5. **Per-role verification (merged-plan verification section):** log in as each demo role, confirm the module-contributed menu items/screens are gone (Comlink telehealth widgets, fax/SMS toolbar entries, Weno eRx menu, etc.), and the co-pilot card still renders (clinical-copilot untouched). Capture **before/after screenshots** and attach to PR #16. With K.4 landed, also confirm the Ophthalmology/Retina context still works (dashboard-context stayed enabled).
6. **Write the RUNBOOK subsection** (table + click path + inventory SQL + "disable, never unregister" + the dashboard-context conditional).
7. Trackers, ship ritual.

## What NOT to do

- Do NOT touch `oe-module-clinical-copilot` in any way.
- Do NOT Unregister/uninstall — `uninstall.sql` scripts drop module tables (verified for dashboard-context); the merged plan promises a toggle that "doesn't delete any code" AND no data loss. Disable only.
- Do NOT disable `oe-module-dashboard-context` if K.4 has landed (the conditional above) — you would be turning off the K.4 deliverable.
- Do NOT ship a migration/seed that forces `mod_active=0` (justified under Files above).
- Do NOT delete module directories from the repo — reversibility is the point; a future deployment may re-enable any of these.
- Do NOT assume the deployed EHR's module states match local dev — inventory each environment (Step 1) before and after.

## Acceptance checks

```bash
echo "SELECT mod_directory, mod_active FROM modules WHERE mod_directory LIKE 'oe-module-%' ORDER BY mod_directory;"
```

Run that query in each environment (per Step 1's access paths): every row in
the 6/7-target list shows `mod_active = 0` (or "no row — never registered",
recorded); `oe-module-clinical-copilot` shows its pre-ticket state unchanged;
with K.4 landed, `oe-module-dashboard-context` shows `mod_active = 1`.
UI check: Manage Modules page screenshot showing the disabled states;
per-role landing screenshots show no module-contributed clutter.

## Tests to add

None in-repo (deployment DB state). The executable evidence is the Step-1/
acceptance query output (before + after) and the screenshot pair, all
attached to PR #16.

## Tracker updates

- `docs/internal/build-status.html` DATA block: ticket `K.5` (T1 section) → `s: "done"` (note in the row text if the deployed-EHR half waited on a user click).
- `docs/w2/requirements.md` — no checkbox; do not invent one.
- `W2_ARCHITECTURE.md` — no edit (module posture is deployment state; the RUNBOOK subsection is the record).

## Verify + ship ritual

The repo diff here is docs-only (RUNBOOK subsection) — if any PHP file was
touched after all, run the merged-plan rule-3 PHP checks (`openemr-cmd
phpstan`, `openemr-cmd psr12-report`; dev container may need
`cd docker/development-easy && docker compose up --detach --wait` first).
The PR gate's eval suite runs regardless:

```bash
cd sidecar && npm test && npm run typecheck && npm run eval && npm run build
```

Panel untouched — skip the panel leg. Then: conventional commit
(`docs(runbook): record module posture for the retina deployment (K.5)`)
with `--trailer "Assisted-by: Claude Code"` (trackers in the SAME commit) →
`git push -u origin claude/merged-eval-course-plan-ky6ulh` → update the
PR #16 body → SendUserFile `docs/internal/build-status.html`.
