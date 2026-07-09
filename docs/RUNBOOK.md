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

3. **Set three sidecar variables** (Railway → **enchanting-mercy** → **Variables**):
   | Variable | Value |
   |---|---|
   | `OPENEMR_BASE_URL` | `https://gw1-openemr-base-clean-production.up.railway.app` |
   | `OPENEMR_CLIENT_ID` | the printed client id |
   | `OPENEMR_CLIENT_KEY` | the printed one-lined PEM (paste exactly as printed) |

   The variable names match the script's output exactly. The service redeploys.

4. **Enable the client** (system-scope clients start disabled). EHR admin →
   **Administration → System → API Clients** → row **Clinical Co-Pilot Sidecar**
   → **Enable**. (An unenabled client fails token requests with `invalid_client`.)

5. **Seed the EHR** (idempotent; creates/refinds the 5 patients + their
   problems/allergies/medications). `<admin-password>` is your EHR admin login;
   `OPENEMR_BASE_URL` / `OPENEMR_CLIENT_ID` / `DATABASE_URL` are read from the
   vars set in step 3:
   ```
   railway ssh --service enchanting-mercy \
     "OPENEMR_SEED_USERNAME=admin OPENEMR_SEED_PASSWORD=<admin-password> node dist/scripts/seed-ehr.js"
   ```
   Expect one log line per patient (`created` first run, `found` on re-runs),
   ending `seed-ehr complete`. On failure the script names the gate that broke
   (`invalid_client` → not enabled; `unsupported_grant_type` → password grant
   off; `invalid_scope` → re-register).

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
