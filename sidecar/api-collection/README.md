# Clinical Co-Pilot — Bruno API Collection

A self-contained, runnable API collection for the Clinical Co-Pilot sidecar.
It requires **no source access, no credentials, and no secrets** — every
request targets the public sidecar API through a single `baseUrl` variable.

- **Live deployment (default):** `https://enchanting-mercy-production-5d32.up.railway.app`
- **Local dev:** `http://localhost:8080` (the sidecar's default port)

Each request carries a `docs` tab explaining **what it proves** about the
architecture, plus assertions/tests that verify the response, so a full run
doubles as an acceptance check.

## Running it

### Option A — Bruno desktop app

1. Install [Bruno](https://www.usebruno.com/downloads).
2. *Open Collection* and select this folder (`sidecar/api-collection/`).
3. Pick the **railway** environment from the environment selector
   (top-right), or **local** if you are running the sidecar yourself.
4. Open any request; the **Docs** tab explains it, *Send* runs it, and the
   **Assert/Tests** results show pass/fail.
5. Right-click the collection and *Run* to execute everything in order.

### Option B — bru CLI (no GUI)

```bash
npm install -g @usebruno/cli

cd sidecar/api-collection
bru run -r --env railway         # whole collection against the live deployment
bru run -r --env local           # against a local sidecar on :8080
bru run -r 01-health --env railway   # just one folder
```

`bru run` prints per-request assert/test results and exits non-zero if any
fail — CI-friendly.

To point at any other deployment without editing files:

```bash
bru run -r --env railway --env-var baseUrl=https://your-deploy.example.com
```

## Suggested run order

The folder/`seq` numbering already encodes this, so a plain `bru run -r`
does the right thing:

| # | Folder | Requests | Cost |
|---|--------|----------|------|
| 1 | `01-health` | `/health`, `/ready` | free |
| 2 | `02-patient-data` | `/api/patients`, `/api/overview/...`, `/api/facts/...` | free, deterministic — no LLM |
| 3 | `03-prep` | `POST /api/prep/...`, `/api/prep-runs/...`, `/api/brief/...`, `/api/usage` | **POST spends LLM budget** |
| 4 | `04-chat` | `POST /api/chat/...` (SSE), `GET /api/chat/...` (replay) | **POST spends LLM budget** |
| 5 | `05-images` | `/api/images/oct-normal-macula-1.jpg` | free |

Two ordering dependencies worth knowing:

- **Brief after prep:** on a cold deployment `GET /api/brief/...` returns
  `404 {"status":"not_prepared"}` (the tests accept this). To see the 200
  path, POST the prep, poll `/api/prep-runs/...` until the newest run is
  `complete`, then re-run the brief request.
- **Replay after chat:** the chat POST's post-response script captures the
  `conversation_id` from the SSE `done` event into the `conversationId`
  variable, which the replay GET uses. A full run handles this
  automatically; run standalone, the replay still returns `200` with an
  empty `messages` array.

## Note on LLM spend

`POST /api/prep/:patientId` and `POST /api/chat/:patientId` trigger **real
LLM calls** on the deployment and spend from its **guarded** daily budget
(rolling 24h window, default $5). The guards are part of what the
collection demonstrates:

- A recent brief is **reused** instead of re-generated (`?force=true`
  bypasses — the param ships disabled on the prep request).
- Duplicate/parallel preps are deduped and concurrency-capped.
- When the budget is exhausted, prep and chat both answer
  `429 {"error":"llm_budget_exceeded", ...}` instead of spending.

`GET /api/usage` shows the live spend-vs-budget numbers — snapshot it
before and after the POSTs to watch the metering move. Everything else in
the collection is deterministic reads and costs nothing.

## Environments

| File | `baseUrl` |
|------|-----------|
| `environments/railway.bru` | `https://enchanting-mercy-production-5d32.up.railway.app` |
| `environments/local.bru` | `http://localhost:8080` |

Both also define a placeholder `conversationId` (overwritten at runtime by
the chat POST). No secrets are stored anywhere in this collection — the
sidecar API is unauthenticated by design for the demo, and all
provider/database credentials live server-side.
