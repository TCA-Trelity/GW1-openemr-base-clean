# USER-ACTIONS — the key-drop & click checklist (human-only steps)

REQ: 0.3, 0.5, S2/R3, R7, S1/R1 enablement · Plan tickets: 0.3 / 0.5 / F.6 prerequisites · Band: 2–3

These are the steps only **you** (the account owner) can do: pasting secrets
into Railway, clicking GitHub settings, registering an OAuth client on the
deployed EHR. Everything in the sidecar is built to no-op cleanly until these
land — nothing below blocks a merge. Each item: exact names → where to click →
**how to verify it took**.

Railway click path (used throughout): railway.app → project → select the
**service** → **Variables** tab → *New Variable* → paste → **Deploy** (Railway
redeploys on variable change; confirm the deploy goes green).

---

## 1. Cohere (live dense embeddings + rerank — S2/R3)

Variables, on the **sidecar** service:

| Variable | Value |
|---|---|
| `COHERE_API_KEY` | from dashboard.cohere.com → API Keys |
| `COHERE_EMBED_MODEL` | leave unset (default `embed-english-v3.0`) or pin explicitly |
| `COHERE_RERANK_MODEL` | leave unset (default `rerank-english-v3.0`) or pin explicitly |

**Verify:**
```bash
curl -s https://enchanting-mercy-production-5d32.up.railway.app/ready | jq '.dependencies.reranker'
# before: {"status":"not_configured"}   after: {"status":"ok"}
```
Boot log also flips `dense: 'hash-offline'` → `'cohere'` (`guideline retriever ready` line).
Then one live search: `POST /api/evidence/search` with `{"q":"hydroxychloroquine screening interval"}` → response has `"rerank_applied": true`.

## 2. pgvector decision (Wave 0.1 — dense index backend)

Run against the **Railway Postgres** the sidecar uses:

```bash
cd sidecar && DATABASE_URL='postgres://…railway…' npm run verify:pgvector
```

Expected outcomes (the script prints exactly one):
- `AVAILABLE` → leave `RETRIEVER_DENSE_BACKEND` unset (default `pgvector`).
- `NOT AVAILABLE` (exit 1) → set `RETRIEVER_DENSE_BACKEND=memory` on the sidecar service (in-process cosine over the same interface — fully supported at this corpus size).
- `NO DATABASE` (exit 2) → the URL was wrong; fix and rerun.

**Verify:** `/ready` → `.dependencies.retriever_index.status` is `ok` after redeploy; record the outcome in `W2_ARCHITECTURE.md` §15 (the 0.1 acceptance).

## 3. Langfuse (committed observability posture — R7, 0.3)

Create a project at cloud.langfuse.com (synthetic-data demo posture, locked
#15) → Settings → API Keys. Variables on the **sidecar** service:
`LANGFUSE_HOST` (e.g. `https://cloud.langfuse.com`), `LANGFUSE_PUBLIC_KEY`
(`pk-lf-…`), `LANGFUSE_SECRET_KEY` (`sk-lf-…`) — all three or tracing stays
off by design.

**Verify:**
```bash
curl -s …/ready | jq '.dependencies.langfuse'    # not_configured → ok
```
Then trigger one prep (`POST /api/prep/margaret-chen`) → a `prep` trace whose
id equals the response's `x-correlation-id` header appears in the Langfuse
project. After E.4 lands, an evidence chat turn additionally shows a `graph`
trace with `supervisor→…` spans. Full walkthrough: `docs/RUNBOOK.md` §C.

## 4. LangSmith (DEMO service only — locked #2, P5)

**Only on the demo Railway service. Never on production. Synthetic data only.**
Variables: `LANGSMITH_TRACING=true`, `LANGSMITH_API_KEY` (smith.langchain.com
→ Settings → API Keys), `LANGSMITH_PROJECT=clinical-copilot-w2-demo`.

**Verify:** demo-service boot log prints `langsmith tracing ON (demo-env
overlay — synthetic data only)` (E.5's line); one evidence turn → a LangGraph
run tree under that project at smith.langchain.com. Confirm the production
service's boot log still says `langsmith tracing off`.

## 5. OpenEMR document-write credentials + OAuth client re-registration (S1/R1)

The sidecar stores uploaded PDFs in OpenEMR via a **password-grant user
token**, and OAuth grants are **intersected with the client's registered
scopes** — a client registered before `user/document.read` +
`user/document.write` existed can NEVER receive them
(`sidecar/src/openemr/auth.ts` `STANDARD_API_SEED_SCOPES`, comment at
L82-88: "A client registered before these existed must be RE-registered").

Steps against the **deployed** OpenEMR:
1. Re-register: `cd sidecar && OPENEMR_BASE_URL='https://gw1-openemr-base-clean-production.up.railway.app' npx tsx src/scripts/register-oauth.ts` (the Wave-0.2 script; full procedure in `docs/RUNBOOK.md` §A step 2). It registers a client whose scope list is `STANDARD_API_SEED_SCOPES` — now including the two document scopes — and prints the new `client_id`.
2. Enable it: OpenEMR UI → **Admin → System → API Clients** → find the new client → **Enable** (freshly registered clients start disabled).
3. Variables on the **sidecar** service: `OPENEMR_CLIENT_ID` (the NEW id), `OPENEMR_API_USERNAME` + `OPENEMR_API_PASSWORD` (an OpenEMR user with the patients/docs ACL — the token acts AS this user; `admin` works for the demo).

**Verify:**
```bash
curl -s …/ready | jq '.dependencies.document_storage'   # not_configured → ok  (token mint round-trip)
```
Then upload once via the panel (or Bruno `06-documents`) and confirm the
document appears in the OpenEMR chart (Patient → Documents) — the 202's
ingestion record shows `openemr_document_id` set.

## 6. Dev-login secret (write-path demo auth — E.3/E.8, RUNBOOK §D)

If not already set: `DEV_LOGIN_SECRET` (≥16 random chars; e.g.
`openssl rand -hex 24`) on the sidecar service. Uploads and fact-verification
require a minted bearer **in every mode** once E.3 lands.

**Verify:** `POST /api/dev-login` with `{"role":"physician","patient":"margaret-chen"}` returns an `access_token` (404 `dev_login_disabled` means the secret is absent/too short).

## 7. Branch protection: make the eval gate a REQUIRED check (0.5, D5)

GitHub → repo → **Settings → Branches → Branch protection rules → Add rule**
(or edit the existing `main` rule) → *Branch name pattern:* `main` → check
**Require status checks to pass before merging** → in the search box add:

> **`Run eval suite`**

— that exact string (it is the job `name:` in `.github/workflows/evals.yml`;
the workflow is titled "Sidecar Evals" but branch protection matches the JOB
name). Recommended additions while there: `sidecar (test + typecheck + build)`
and `panel (test + typecheck + build)` from `sidecar-ci.yml`.

**Verify:** open any PR touching `sidecar/**` → the merge box lists
*Run eval suite — Required*. The hard-gate rehearsal (`docs/w2/gate-rehearsal.md`)
is the evidence that the check actually blocks; note the required-check flip in
`RELEASE.md`'s promotion gate (the 0.5 acceptance).

## 8. Live eval dispatch (pre-milestone sanity — F.6 prerequisite)

Once keys 1/3/5 are in: GitHub → **Actions → Sidecar Evals → Run workflow**
(branch `claude/openemr-rag-requirements-x25vzm` or `main`), or:
```bash
gh workflow run "Sidecar Evals" --ref main
```
**Verify:** the run is green and uploads the `eval-results` artifact
(`docs/execution/eval-results.md`). The scheduled/live-model suite
(`LIVE_EVALS=1`) rides ticket F.6 — this dispatch just proves the pipe.

---

**Order that unblocks the most, first:** 7 (one click, hard-gate credit) → 5
(demo upload → EHR round-trip) → 1 → 3 → 6 → 2 → 4 → 8.
