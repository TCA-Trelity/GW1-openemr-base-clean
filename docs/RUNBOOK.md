# Activation runbook — bring the live features online

Three one-time activations, independent of each other. The deployed agent
already works without any of them; these light up the EHR-integration story,
the in-chart embed, and the observability dashboard. All Railway commands run
from your machine with the `railway` CLI linked to the **project** (`railway
link` once, pick the project + `production` environment).

Live sidecar: `https://enchanting-mercy-production-5d32.up.railway.app`
Live EHR: `https://gw1-openemr-base-clean-production.up.railway.app`

---

## A. EHR data flow (E1 seed + E2 sync) — makes "layer on the EHR" real

**Goal:** create the 5 corpus patients *inside* OpenEMR, then have the sidecar
pull them back over FHIR so the **EHR Record** tab and origin badges show real
OpenEMR data.

Project services (same Railway project): sidecar = **`enchanting-mercy`**, EHR =
**`gw1-openemr-base-clean`**. Run `railway link` once first (pick the project +
the `production` environment).

1. **Enable OpenEMR connectors** (admin UI). Log into the EHR as `admin` →
   **Administration → Config → Connectors** → turn ON all four (Save after):
   - *Enable OpenEMR Standard REST API* (`rest_api`) — `api:oemr` + `user/*` seed writes
   - *Enable OpenEMR Standard FHIR REST API* (`rest_fhir_api`) — `api:fhir` + FHIR reads
   - *Enable OpenEMR FHIR System Scopes* (`rest_system_scopes_api`) — the `system/*.read`
     scopes the client-credentials FHIR reader uses. **Registration 400s with
     `invalid_scope` if this is off** — `system/*` only enters the accepted-scope
     list when it is enabled (`ServerScopeListEntity.php:62,115`).
   - *OAuth2 Password Grant* — the user-role seed token

2. **Register the sidecar OAuth client** (mints credentials with both FHIR-read
   and standard-API-write scopes). `OPENEMR_BASE_URL` is passed inline so this
   works before any sidecar variable is set:
   ```
   railway ssh --service enchanting-mercy \
     "OPENEMR_BASE_URL=https://gw1-openemr-base-clean-production.up.railway.app node dist/scripts/register-oauth.js"
   ```
   It prints `OPENEMR_CLIENT_ID=…` and `OPENEMR_CLIENT_KEY=…` (a one-lined PEM,
   **shown once** — copy both now). The client registers as *Clinical Co-Pilot
   Sidecar*.

3. **Set the sidecar variables** (Railway → **enchanting-mercy** → **Variables**).
   Secrets live here — typed into the UI once — so every command below is clean
   with nothing to fill in:
   | Variable | Value |
   |---|---|
   | `OPENEMR_BASE_URL` | `https://gw1-openemr-base-clean-production.up.railway.app` |
   | `OPENEMR_CLIENT_ID` | the client id printed in step 2 |
   | `OPENEMR_CLIENT_KEY` | the one-lined PEM printed in step 2 (paste exactly) |
   | `OPENEMR_SEED_USERNAME` | `admin` |
   | `OPENEMR_SEED_PASSWORD` | your EHR admin password |

   The variable names match the script's output exactly. Saving redeploys the
   service — **wait for the deploy to go green** before the SSH steps, because
   SSH connects to the currently-running container (a variable added seconds ago
   isn't visible until the new deploy is live; that is what `OPENEMR_CLIENT_ID is
   required` means).

4. **Enable the client** (system-scope clients start disabled). EHR admin →
   **Administration → System → API Clients** → row **Clinical Co-Pilot Sidecar**
   → **Enable**. (An unenabled client fails token requests with `invalid_client`.)

5. **Seed the EHR** (idempotent; creates/refinds the 5 patients + their
   problems/allergies/medications). With the step-3 variables live, every value
   comes from the environment — nothing to fill in:
   ```
   railway ssh --service enchanting-mercy "node dist/scripts/seed-ehr.js"
   ```
   Expect one log line per patient (`created` first run, `found` on re-runs),
   ending `seed-ehr complete`. On failure the script names the gate that broke:
   `OPENEMR_CLIENT_ID is required` → the variable isn't live in the container yet
   (wait for the green deploy, reconnect); `invalid_client` → client not enabled
   (step 4); `unsupported_grant_type` → password grant off (step 1);
   `invalid_scope` → re-register (step 2).

   To confirm what the container actually has before seeding, list the set
   variable names (no secret values printed):
   ```
   railway ssh --service enchanting-mercy "env | grep OPENEMR | cut -d= -f1"
   ```

6. **Pull it into the sidecar.** After the sidecar redeploys (step-3 env change),
   open the panel → **EHR Record** tab → **Sync now** (or `POST /api/ehr-sync/<id>`).
   The tab fills with live OpenEMR data and origin badges flip to **EHR**.

> If `railway ssh` is disabled on the service, run step 2 locally from `sidecar/`
> instead: `OPENEMR_BASE_URL=https://gw1-openemr-base-clean-production.up.railway.app npx tsx src/scripts/register-oauth.ts`
> (needs `npm ci` first). Step 5 also needs `DATABASE_URL`, so SSH is simpler there.

> Re-run `seed-ehr.js` after any `seed.js` (fact-store) reseed — the wipe clears
> the `openemr_patient_id` link.

---

## B. Chart embed module — Co-Pilot card inside the patient chart

**Goal:** a "Clinical Co-Pilot" card at the top of the OpenEMR patient
demographics screen, opening/embedding the panel for that patient.

1. **Confirm the module shipped.** It lives at
   `interface/modules/custom_modules/oe-module-clinical-copilot/` and deploys
   with the EHR image (already pushed). If the EHR was last rebuilt before that
   commit, trigger a redeploy of the EHR service first.

2. **Register → install → enable** (admin UI). EHR admin →
   **Administration → Modules → Manage Modules** → **Unregistered** tab →
   find **Clinical Co-Pilot** → **Register**, then **Install**, then **Enable**.

3. **Open any patient chart.** The card appears at the top of the demographics
   dashboard. If you ran section A, the 5 corpus patients already exist in
   OpenEMR, so their charts **auto-bind** (the module name-matches the chart
   patient against the sidecar's `/api/patients`). Otherwise the card links to
   the day view.

4. *(Optional)* point the module at a different sidecar: set
   `COPILOT_SIDECAR_URL` on the **OpenEMR** service (defaults to the live
   sidecar above).

---

## C. Langfuse observability (G2) — the live dashboard + 3 alerts

### C2. LangSmith — demo environment ONLY (Week 2, locked decision #2)

LangGraph.js reads `LANGSMITH_TRACING` / `LANGSMITH_API_KEY` /
`LANGSMITH_PROJECT` natively — no sidecar code path depends on them. The
fence is configuration: set the three vars **only on the demo Railway
service** (synthetic data), never on the production posture, whose committed
backend is Langfuse. The boot log states the posture on every start
(`LangSmith tracing ON — demo environment posture` vs `off — production
posture`). Key drop steps: `docs/w2/tickets/USER-ACTIONS.md`.

**Goal:** turn the emitted traces into the dashboard + alerts specified in
`docs/execution/observability.md`.

1. **Deploy Langfuse into the same Railway project.** Canvas → **+ New** →
   **Template** → search **Langfuse** → deploy. Heads-up: it brings ~6 services
   (web, worker, Postgres, ClickHouse, Redis, MinIO) — the heaviest add; it's
   the committed self-hosted choice (traces stay in the deployment boundary).

2. **Create keys.** Open the deployed **langfuse-web** public URL → sign up
   (first user = admin) → create an org + project → **Settings → API Keys** →
   create → copy `pk-lf-…` and `sk-lf-…`.

3. **Point the sidecar at it** (Railway → sidecar → **Variables**):
   | Variable | Value |
   |---|---|
   | `LANGFUSE_HOST` | the langfuse-web URL |
   | `LANGFUSE_PUBLIC_KEY` | `pk-lf-…` |
   | `LANGFUSE_SECRET_KEY` | `sk-lf-…` |
   Sidecar redeploys; the next prep/chat run emits a trace (verify in Langfuse →
   **Traces**, filtered by correlation ID).

4. **Build the dashboard + alerts** from `docs/execution/observability.md`:
   the tiles (requests, error rate, p50/p95, LLM calls, retries, verification
   pass/fail, token spend) and the three alerts (A1 p95 latency, A2 error rate,
   A3 verification/tool failure) with the thresholds + on-call responses in that
   doc. Configure alerts in Langfuse where supported; otherwise the doc records
   the query + threshold for each.

> Until Langfuse is live, the same signals are queryable now:
> `GET /api/usage` (spend), `GET /api/prep-runs/<id>` (run status/stage/error),
> and Railway logs by correlation ID.

---

## D. Turn on authorization (Wave AZ) — the patient-bound demo

**Goal:** flip the sidecar from open (demo default) to enforcing the patient-bound,
role-aware access model — 401 unauthenticated, 403 cross-patient, 403 role-gated
— so the demo can show the boundary is structural, not cosmetic. Order matters:
enable the token path *before* enforcement, or the panel 401s itself.

1. **Enable dev-login** (the demo/grading token path). Railway → **enchanting-mercy**
   → **Variables** → add a strong random secret:
   | Variable | Value |
   |---|---|
   | `DEV_LOGIN_SECRET` | a 32+ char random string (e.g. `openssl rand -hex 24`) |
   Its presence turns on `POST /api/dev-login` and the panel's role switcher. The
   panel now mints a patient-bound token on every patient/role switch. (Still no
   rejection yet — `AUTH_MODE` is `off` by default.)

2. **Flip enforcement on.** Add:
   | Variable | Value |
   |---|---|
   | `AUTH_MODE` | `enforced` |
   Sidecar redeploys. Now every per-patient route requires a valid, patient-bound
   token; the schedule list (`/api/patients`) stays open by design.

3. **Demo it.**
   - Open the panel → the role switcher (top-right) shows **Physician / Nurse /
     Resident**. Switch to **Nurse** → the AI-prep control disappears (read-only),
     and a prep POST 403s server-side.
   - **Cross-patient 403** (the headline): grab a bound token and aim it at another
     patient. From the browser console on the panel, or:
     ```
     # 401 — no token:
     curl -i https://enchanting-mercy-production-5d32.up.railway.app/api/overview/margaret-chen
     # mint a token bound to margaret, then request tren -> 403:
     TOK=$(curl -s -XPOST .../api/dev-login -H 'content-type: application/json' \
       -d '{"role":"physician","patient":"margaret-chen"}' | jq -r .access_token)
     curl -i -H "Authorization: Bearer $TOK" .../api/overview/tren-okafor   # 403 cross_patient
     curl -i -H "Authorization: Bearer $TOK" .../api/overview/margaret-chen # 200
     ```

4. **(Production path) Real SMART EHR-launch.** When `OPENEMR_BASE_URL` +
   `OPENEMR_CLIENT_ID` are set (from §A), the sidecar also verifies real
   OpenEMR-issued SMART tokens (RS256 via the EHR's JWKS + `/introspect` for the
   bound patient). Wiring the OpenEMR module to launch the panel with `launch/patient`
   and completing the code exchange in the browser is the remaining live step —
   dev-login covers the graded auth demo without it.

> To turn enforcement back off (e.g. an open kiosk demo), set `AUTH_MODE=off` (or
> remove it). The code still attaches a principal when a token is present; it just
> never rejects.

## E. Backup & recovery (G18)

*Operationalizes `W2_ARCHITECTURE.md` §14. The design property that makes this
section short: the fact store is a **derived view** — its recovery primitive is
wipe-and-rebuild, and this runbook's job is to make rebuild boring.*

### E1. What must be backed up — and what must not

| Store | Posture | Backup mechanism |
|---|---|---|
| OpenEMR DB + Documents | **System of record** (charts + uploaded originals) | Out of sidecar scope: OpenEMR's own guidance (open-emr.org wiki → Backup and Restore Guidelines) + Railway Postgres backups on the EHR service |
| Sidecar fact store (Postgres) | Derived view | Backup is convenience (fast restore); **rebuild is truth** (E4) |
| Corpus, fixtures, eval cases, `eval/baseline.json` | Repo artifacts | `git` IS the backup — clone = full recovery |
| `llm_calls` ledger | Non-derivable (audit/cost) | Rides the DB backup; loss acceptable in a rebuild (cost history, not clinical data). **Retention decision: keep 90 days.** |
| Ingestion records | **In-memory today** (`MemoryIngestionRecordStore`) | Known limitation, stated plainly: they do not survive a restart. The durable trail is OpenEMR Documents (the original) + persisted facts (the extraction); the staged record is progress telemetry. |

### E2. Automatic

Enable Railway Postgres backups on the sidecar DB: Railway dashboard → the
Postgres service → **Backups** (retention per the plan tier shown at click
time — a user action, USER-ACTIONS.md). If the tier lacks scheduled backups,
the documented alternative is a Railway cron service running:

```bash
pg_dump --format=custom "$DATABASE_URL" | gzip > "nightly-$(date +%F).dump.gz"
```

### E3. Manual

```bash
pg_dump --format=custom "$DATABASE_URL" -f "copilot-$(date +%F).dump"
pg_restore --clean --if-exists -d "$DATABASE_URL" "copilot-<date>.dump"
```

### E4. The true recovery path (wipe-and-rebuild)

1. Provision an empty Postgres; set `DATABASE_URL`.
2. Boot the sidecar — migrations run at boot (idempotent, advisory-locked).
3. Re-seed (`npx tsx src/scripts/seed.ts`) or EHR-sync the patients.
4. Trigger prep per patient (`POST /api/prep/:patientId`).
5. Re-upload any outside documents — the originals live in OpenEMR Documents;
   the preview cache and extracted facts regenerate deterministically
   (same bytes → same ingestion id → same fact ids).

**RPO = the last prep/ingestion run (≈0 for everything derivable; ≤24 h via
backups for the ledger). RTO = restore ≤30 min, or one full re-prep cycle —
minutes per patient.**

### E5. Golden-set invariant (G18)

Everything the eval gate needs is in-repo: fixture PDFs
(`sidecar/eval/fixtures/documents/`), the authored corpus (`sidecar/corpus/`,
re-indexed at every boot), the 58 cases, and the committed
`eval/baseline.json`. Recovery is `git clone` + `npm ci` + `npm run eval` —
no DB-only state anywhere in the gate.

### E6. Rehearsal record (executed 2026-07-13, scratch Postgres 16)

Performed against a seeded scratch cluster with the real sidecar booted on it
(migrations at boot, `seed.ts`, reads verified before and after):

```text
$ pg_dump --format=custom "$PGURL" -f /tmp/w2pg/copilot-2026-07-13.dump
  → 54,936 bytes
$ psql .../postgres -c "DROP DATABASE copilot;" -c "CREATE DATABASE copilot;"
  DROP DATABASE / CREATE DATABASE
$ pg_restore --clean --if-exists -d "$PGURL" /tmp/w2pg/copilot-2026-07-13.dump
$ psql "$PGURL" -A -t -c "SELECT COUNT(*) FROM patients"        → 5
                 -c "SELECT COUNT(*) FROM patient_facts"        → 33
                 -c "SELECT COUNT(*) FROM source_documents"     → 20
                 -c "SELECT COUNT(*) FROM image_records"        → 17
$ curl /api/patients   → 5 patients served post-restore
```

Counts match the seeded corpus (5 patients / 33 facts / 20 documents / 17
images) and the running sidecar served reads from the restored database
without a restart.
