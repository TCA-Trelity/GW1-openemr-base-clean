# Operations & production-readiness

How the Clinical Co-Pilot is deployed, kept stable, observed, and rolled back —
and an honest account of what is production-grade versus demo-scoped. Companion
to `ARCHITECTURE.md` (design), `AUDIT.md` (security findings), `RUNBOOK.md`
(activation steps), and `RELEASE.md` (branch model).

## 1. Topology

| Piece | What runs | Where |
|---|---|---|
| **EHR** | OpenEMR (untouched core + the Co-Pilot chart module) | Railway service `gw1-openemr-base-clean` |
| **Sidecar** | Node 22 · Fastify 5 · the agent runtime, prep pipeline, fact store, citation gate, chat, auth PEP; also serves the React panel | Railway service `enchanting-mercy` |
| **Fact store** | PostgreSQL — a **derived view** of the EHR, wipeable and rebuildable | Railway Postgres (sidecar `DATABASE_URL`) |
| **Panel** | React SPA, built into the sidecar image, served same-origin | inside the sidecar |

The sidecar never becomes a second source of truth: every fact traces to an EHR
document, and the store can be wiped and rebuilt from the record.

## 2. Stability model — how a bad change cannot take production down

Five independent layers, each of which alone prevents a class of outage:

1. **Branch gate (`RELEASE.md`).** `main` is stable/instructor-facing; all
   development lands on the working branch. `main` only advances by a deliberate,
   CI-green promotion. A broken commit never reaches instructors.
2. **Sidecar CI (`.github/workflows/sidecar-ci.yml`).** Every push touching
   `sidecar/` runs both test suites (sidecar + panel), typecheck, and the exact
   `tsc`/`vite` builds the Docker image uses. Green on the working-branch HEAD is
   the promotion precondition.
3. **Health-gated deploys.** `railway.json` sets `healthcheckPath: /health`.
   Railway does not switch traffic to a new deployment until `/health` responds,
   and keeps the previous healthy deployment serving if the new one never becomes
   healthy — so a boot failure cannot replace a working version.
4. **Boot-crash-proof config (`sidecar/src/config.ts`).** Every environment
   variable `.catch()`es its own parse failure: a malformed value (a URL missing
   its scheme, a mistyped `AUTH_MODE`, a too-short `DEV_LOGIN_SECRET`, a
   non-numeric override) logs a warning naming the variable and falls back to a
   safe default, disabling *that feature* rather than throwing and restart-looping
   the process. `loadConfig` cannot throw. Covered by `test/config.test.ts`.
5. **Fail-safe request path.** The auth PEP (`sidecar/src/auth/middleware.ts`)
   never 500s: in `off` mode a token that fails to verify for any reason is
   ignored and the request proceeds; in `enforced` mode an unexpected verifier
   error fails *closed* with 401, never a leaked 500.

**Rollback.** `main` is always the last proven commit and each promotion is
tagged `stable-YYYY-MM-DD`. To roll production back: Railway → the service →
Deployments → redeploy the last green deployment (10 seconds, no code), or check
out the latest `stable-*` tag.

## 3. Authorization posture

Dual-credential model (full detail in `ARCHITECTURE.md` §3, `AUDIT.md` S1/S6):

- **Interactive surface** — a SMART resource-server verifier (`sidecar/src/auth/`)
  behind one global PEP: 401 unauthenticated, **403 cross-patient** (token's bound
  patient ≠ requested patient — structural), and a role-capability gate. Two token
  paths, dispatched strictly on JWT `alg` (the alg-confusion defense): RS256
  OpenEMR SMART tokens (JWKS signature + `aud`/`iss`/`exp`, then `/introspect` for
  the bound patient) and HS256 sidecar dev tokens.
- **Background preparer** — a separate read-only client-credentials token, used
  before any doctor session exists; read-only, pipeline-scoped, audit-logged in
  OpenEMR's own `api_log`.
- **Gated by `AUTH_MODE`** (default `off`; `enforced` turns on rejection — see
  `RUNBOOK.md` §D). **Fails closed:** a SMART user whose role can't be derived
  gets the least-privileged role. **Demo-scoped:** `dev-login` is a passwordless
  credential issuer for grading and must never be enabled in a real deployment;
  production authentication is SMART EHR-launch.

## 4. Observability

- **Correlation IDs** on every request, log line, tool call, and LLM interaction
  (honoring an inbound `x-correlation-id`), so a full trace reconstructs from logs
  alone.
- **`/health`** (process liveness, dependency-free) and **`/ready`** (real checks
  against OpenEMR, the model provider, and Langfuse) are separate.
- **`llm_calls` ledger** (Postgres) prices every model call; **`GET /api/usage`**
  surfaces the rolling 24h spend now, without any external service.
- **`GET /api/prep-runs/:id`** exposes per-run stage + error for "why did this
  fail / is it stuck".
- **Langfuse** (self-hosted, when deployed — `RUNBOOK.md` §C) turns the emitted
  spans/generations/scores into the dashboard + three alerts specified in
  `docs/execution/observability.md`.

## 5. Cost control

Haiku 4.5 for all LLM calls ($1/$5 per MTok); per-document map-reduce extraction
to bound output. A spend guard enforces a rolling **$5/day** budget: the prep and
chat routes precheck it and answer `429 llm_budget_exceeded` rather than
overspend. Rates and the ceiling are env-tunable (`LLM_DAILY_BUDGET_USD`,
`LLM_*_USD_PER_MTOK`). See `docs/COSTS.md` for the 100→100K-patient projection.

## 6. Scaling path (what changes past the demo)

The current build is a single-replica, in-process design chosen for demo
clarity; the seams to scale are already in place:

- **Async work** is a fire-and-forget in-process pipeline behind concurrency +
  budget guards. The seam to a durable queue (BullMQ on the already-present
  `REDIS_URL`) is isolated to the prep route; workers scale horizontally.
- **The sidecar is stateless** apart from Postgres; run N replicas behind the
  Railway proxy. Migrations are idempotent + advisory-locked, so concurrent
  replicas serialize safely at boot.
- **The fact store is a derived view**, so it can be sharded/rebuilt per-tenant
  without being a system of record.
- **Auth** already verifies tokens statelessly (JWKS cached, introspection per
  token), so no shared session store is needed.

## 7. Known gaps (tracked, not silent)

| Gap | Status |
|---|---|
| Live browser SMART EHR-launch (module → `launch/patient` → code exchange) | Verifier + panel Bearer plumbing built + tested; live wiring is the remaining step (AZ3). Dev-login stands in for the graded demo. |
| Role derivation for real SMART users | Fails closed to least-privilege today; real derivation from OpenEMR user attributes (`users.authorized` + `physician_type` + gacl) is the follow-up. |
| Langfuse dashboard live | Signals emit; the self-hosted deploy + dashboard/alerts is a user activation (G2). |
| Load tests + latency baselines (10/50 concurrent) | Harness built — `npm run load-test` (dependency-free, deterministic read path) + the dispatchable **Sidecar load probe** CI workflow at concurrency 10/50 with a p95 SLO gate. Real baselines are produced on the next run against the live URL (S3.1). |
| `dev-login` openness | By design for grading; documented (`AUDIT.md` S6); disabled in production. |
| EHR per-patient authz (upstream OpenEMR) | Unimplemented in core (`AUDIT.md` S1); we construct patient-scope control the platform doesn't provide, rather than patch core. |
