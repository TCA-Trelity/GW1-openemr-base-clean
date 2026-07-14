# USER-ACTIONS — the key-drop & click checklist (human-only steps)

> **STATUS: ARCHIVE (2026-07-14).** Every item below is complete and verified
> live (item 4 on hold by user decision). Nothing here requires action —
> kept as reference for credential re-dos and troubleshooting. Remaining W2
> work lives on the build board (manual test plan + open matrix rows).

> **Human surface: [`../user-actions.html`](../user-actions.html)** — the same
> checklist as an interactive form (checkboxes persist in-browser, copy
> buttons, navigation links). This markdown stays the canonical source agents
> read; **update both together** when actions change.

REQ: 0.3, 0.5, S2/R3, R7, S1/R1 enablement · Plan tickets: 0.3 / 0.5 / F.6 prerequisites · Band: 2–3

These are the steps only **you** (the account owner) can do: pasting secrets
into Railway, clicking GitHub settings, registering an OAuth client on the
deployed EHR. Everything in the sidecar is built to no-op cleanly until these
land — nothing below blocks a merge. Each item: exact names → where to click →
**how to verify it took**.

**Order that unblocks the most, first: 0 → 7 → 5 → 1 → 3 → 6 → 2 → 4 → 8.**

**Progress (recorded as you report it):**

| # | Item | State |
|---|---|---|
| 0 | Laptop setup | ✅ done (2026-07-13) |
| 7 | Branch protection | ✅ done (2026-07-13) — `Run eval suite` REQUIRED on `main` |
| 5 | OpenEMR document-write | ✅ done + **verified live** (2026-07-14: `document_storage: ok`, and it SURVIVED subsequent merge redeploys — EHR data persists; id-only auth, see the note in item 5) |
| 1 | Cohere | ✅ done + **verified live** (2026-07-14 post-merge: `reranker: ok`) |
| 3 | Langfuse | ✅ done (2026-07-14) — Cloud keys live, verified against today's deploy; graph spans join post-merge |
| 6 | Dev-login secret | ✅ done (2026-07-14) — verified against today's deploy |
| 2 | pgvector | ✅ done + **verified live** (2026-07-14: script `AVAILABLE` v0.8.4; post-merge `retriever_index: ok`) |
| 4 | LangSmith | ⏸ ON HOLD (user, 2026-07-14) — single-service posture; revisit only if a separate demo service appears |
| 8 | Eval dispatch | ✅ done (user, 2026-07-14) — verified via the Actions API: `workflow_dispatch` on `main` at 11:39 UTC, success, `eval-results` artifact present |

> ⚠️ **Deploy sequencing — read before running any `/ready` verify.** Railway
> deploys `main`, and until **PR #9 merges** (then Railway auto-redeploys) the
> deployed sidecar is **Week 1 code**: the W2 probes (`document_storage`,
> `retriever_index`, `reranker`) are absent from `/ready` — `jq` prints
> `null` — and the W2 routes (`/api/documents` upload, `/api/evidence/search`)
> 404. **A `null` there is expected and does NOT mean your key drop failed**;
> the variables sit staged on Railway and take effect on the post-merge
> redeploy. Verifies that DO work pre-merge: item 3's `langfuse` flip +
> prep trace, item 6's dev-login, and item 2's laptop `verify:pgvector` run
> (it runs from your clone, which is checked out on the W2 branch).

---

## 0. One-time laptop setup (prerequisite for items 2 and 5)

Terminal commands in this checklist run **from inside a local clone of this
repo** — a bare `cd sidecar` from your home directory fails because the folder
only exists inside the clone. One-time setup on your machine:

```bash
# Needs Node 22 (check: node --version; install via nvm if older)
git clone https://github.com/TCA-Trelity/GW1-openemr-base-clean.git ~/GW1-openemr-base-clean
cd ~/GW1-openemr-base-clean
git checkout claude/openemr-rag-requirements-x25vzm   # or main, after PR #9 merges
cd sidecar && npm ci                                   # takes a couple of minutes
```

Every later command below is written from `~/GW1-openemr-base-clean` — adjust
the path if you cloned elsewhere.

**Verify:** `cd ~/GW1-openemr-base-clean/sidecar && npm test` runs green
(keyless by design).

### Finding the right Railway service (used by items 1, 3, 4, 5, 6)

railway.app → your project canvas shows several cards (two app services + at
least one Postgres). Which app service is which: click a card → **Settings →
Networking** shows its public domain —

- `enchanting-mercy-production-5d32.up.railway.app` = **the sidecar** (where
  almost all variables below go);
- `gw1-openemr-base-clean-production.up.railway.app` = **the EHR (OpenEMR)**.

To set a variable: service card → **Variables** tab → **New Variable** → name +
value → repeat as needed → Railway stages the changes and shows an
**Apply/Deploy** banner — click it and watch the Deployments tab go green
(variable changes only take effect after that redeploy).

## 1. Cohere (live dense embeddings + rerank — S2/R3) — ✅ DONE (user, 2026-07-14; key staged, verify post-merge)

**Get the key:** dashboard.cohere.com → sign in → **API Keys** (left nav). A
free **Trial key** exists by default — copy it (trial is rate-limited but fine
for demo volume). While you're there, note the pricing/tier numbers for
`docs/COSTS.md` §6.2's "verify at key-drop" cells.

**Set on the SIDECAR service** (Variables tab, per the click path above):

| Variable | Value |
|---|---|
| `COHERE_API_KEY` | the key you copied |
| `COHERE_EMBED_MODEL` | do not set (defaults to `embed-english-v3.0`) |
| `COHERE_RERANK_MODEL` | do not set (defaults to `rerank-english-v3.0`) |

**Verify (post-merge only — the `reranker` probe and the evidence-search
route ship with PR #9; on the deployed `main` build they return `null`/404):**
```bash
curl -s https://enchanting-mercy-production-5d32.up.railway.app/ready | jq '.dependencies.reranker'
# no jq? use:  curl -s .../ready | python3 -m json.tool | grep -A2 '"reranker"'
# before: "not_configured"   after: "ok"
```
Deploy logs (service → Deployments → View logs) show the
`guideline retriever ready` line flip `dense: 'hash-offline'` → `'cohere'`.
Then one live search returns `"rerank_applied": true`:
```bash
curl -s -X POST https://enchanting-mercy-production-5d32.up.railway.app/api/evidence/search \
  -H 'content-type: application/json' -d '{"q":"hydroxychloroquine screening interval"}' | grep -o '"rerank_applied":[a-z]*'
```

## 2. pgvector decision (Wave 0.1 — dense index backend) — step by step — ✅ DONE (user, 2026-07-14: AVAILABLE, v0.8.4)

One command, run **from your laptop clone** (item 0), that asks the **Railway
Postgres** whether the `pgvector` extension exists. Whichever answer it
prints, one step later you're done — **both outcomes are fully supported**.

**Step 1 — freshen the clone** (the branch moves daily):
```bash
cd ~/GW1-openemr-base-clean
git pull
cd sidecar
```

**Step 2 — find the sidecar's Postgres card on Railway.** Project canvas →
the **PostgreSQL** card (usually just named "Postgres"). If you see more than
one database card: open the **sidecar** card → Variables → its `DATABASE_URL`
row shows a reference like `${{Postgres.DATABASE_URL}}` — the name inside
`${{…}}` is the database card you want.

**Step 3 — copy the PUBLIC connection URL.** On that Postgres card →
**Variables** tab → the row named **`DATABASE_PUBLIC_URL`** (⚠️ not
`DATABASE_URL`). Values are masked — click the **copy icon** at the right end
of that row (safer than revealing and hand-selecting). Sanity-check the
paste: it must contain `proxy.rlwy.net:` followed by a port number. If it
contains `railway.internal`, you copied the wrong row — that host only
resolves *inside* Railway and hangs from a laptop.

**Step 4 — run the check** (still inside `sidecar/` from step 1):
```bash
DATABASE_URL='PASTE-THE-URL-HERE' npm run verify:pgvector
```
- Replace `PASTE-THE-URL-HERE` with the step-3 URL — **keep the single
  quotes**, keep everything on **one line**, one space before `npm`.
- Yes, the left-hand name stays `DATABASE_URL` even though the *value* came
  from the `DATABASE_PUBLIC_URL` row: the script reads the variable *named*
  `DATABASE_URL`; you're handing it the public value.
- Filled-in example — **DO NOT RUN THIS; illustration only** (the host and
  credentials are fake, so running it prints a `query failed:` error). It
  exists to show what the finished command *looks like*:
```text
DATABASE_URL='postgresql://postgres:AbC123xYz456@maglev.proxy.rlwy.net:43210/railway' npm run verify:pgvector
```

**Step 5 — read the result.** The exact lines the script prints, and what
each means:

| The output says | Meaning | What you do |
|---|---|---|
| `pgvector AVAILABLE (already installed, version …)` **or** `pgvector AVAILABLE (installed now, version …)` | best outcome — extension present ("installed now" = the script enabled it; that's its job, not an error) | **nothing** — leave `RETRIEVER_DENSE_BACKEND` unset. Item 2 done. |
| `pgvector NOT AVAILABLE on this Postgres image.` | Railway's Postgres image ships without the extension | add ONE variable on the **sidecar** card (item-0 click path): name `RETRIEVER_DENSE_BACKEND`, value `memory` → Apply/Deploy. Fully supported fallback at this corpus size. Item 2 done. |
| `verify:pgvector — query failed: getaddrinfo ENOTFOUND …railway.internal` (or it hangs ~30 s, then times out) | you pasted the internal URL | redo step 3 — copy the `DATABASE_PUBLIC_URL` row |
| `verify:pgvector — query failed: password authentication failed …` | the URL got truncated or edited in the paste | redo step 3 using the row's copy icon; re-paste the whole thing between the quotes |
| `verify:pgvector — DATABASE_URL is not set; nothing to verify (exit 2)` | the inline variable never reached the command (name typo'd, or the command split across lines) | retype step 4 as ONE line starting exactly `DATABASE_URL='` |
| `Cannot find module …` / `tsx: command not found` | dependencies missing in this clone | run `npm ci` inside `sidecar/`, then rerun step 4 |
| any other `query failed: …` | — | paste the full line in chat; the agent diagnoses it |

**Step 6 — report the outcome in chat** (`AVAILABLE` or `NOT AVAILABLE`) —
the agent records the decision in `W2_ARCHITECTURE.md` §15 / board ticket 0.1.

**Verify:** step 5's first two rows ARE today's verification (the run works
now — your clone is on the W2 branch). The `/ready` echo is post-merge:
`.dependencies.retriever_index.status` reads `ok` once PR #9's build is
deployed.

## 3. Langfuse (committed observability posture — R7, 0.3) — ✅ DONE (user, 2026-07-14)

**Get the keys:** cloud.langfuse.com → sign up / sign in → create an
**Organization**, then a **Project** (any name; synthetic-data demo posture) →
**Project Settings → API Keys → Create new API keys**. The dialog shows three
things — copy all three **exactly as displayed**, including the host, which is
region-dependent (`https://cloud.langfuse.com` EU, `https://us.cloud.langfuse.com`
US — use whichever the dialog shows).

**Set on the SIDECAR service** — all three or tracing stays off by design:

| Variable | Value |
|---|---|
| `LANGFUSE_HOST` | the host from the key dialog |
| `LANGFUSE_PUBLIC_KEY` | `pk-lf-…` |
| `LANGFUSE_SECRET_KEY` | `sk-lf-…` |

**Verify:** `/ready` → `.dependencies.langfuse` flips `not_configured → ok`.
Then trigger one prep (panel: open Margaret Chen → AI Insights → prepare; or
`POST /api/prep/margaret-chen`) → a `prep` trace appears in the Langfuse
project whose id equals the response's `x-correlation-id` header. One evidence
chat turn additionally shows a `graph` trace with `supervisor→…` spans (E.4).
Full walkthrough: `docs/RUNBOOK.md` §C.

## 4. LangSmith (DEMO service only — locked #2, P5) — ⏸ ON HOLD (user, 2026-07-14)

**Fence: only on the demo Railway service. Never on production. Synthetic
data only.** (Running a single sidecar service today? Skip this until a
separate demo service exists — do not put it on the main service.)

**Get the key:** smith.langchain.com → sign in → **Settings** (gear, bottom of
the left rail) → **API Keys** → **Create API Key** (looks like `lsv2_pt_…`).
No need to pre-create the project — it auto-creates on the first trace under
the `LANGSMITH_PROJECT` name.

**Set on the DEMO service only:**

| Variable | Value |
|---|---|
| `LANGSMITH_TRACING` | `true` |
| `LANGSMITH_API_KEY` | `lsv2_…` |
| `LANGSMITH_PROJECT` | `clinical-copilot-w2-demo` |

**Verify:** demo-service deploy log prints `LangSmith tracing ON — demo
environment posture (synthetic data only)`; one evidence turn → a LangGraph
run tree under that project at smith.langchain.com. Confirm the production
service's log still says `LangSmith tracing off — production posture`.

## 5. OpenEMR document-write enablement (S1/R1) — four sub-steps, in order — ✅ DONE (user, 2026-07-14)

The sidecar stores uploaded PDFs in OpenEMR via a **password-grant user
token**. OAuth grants are **intersected with the client's registered scopes**,
so a client registered before `user/document.read`/`user/document.write`
existed can NEVER receive them — the client must be **re-registered**.

**5a. Enable the API connectors in OpenEMR** (one-time; registration fails
without this): log into the deployed EHR
(`https://gw1-openemr-base-clean-production.up.railway.app`, `admin`/`pass`) →
**Administration → Globals → Connectors** → enable **"OpenEMR Standard REST
API"** and **OAuth2 password grant** (pick the on-value that includes password
grant) → Save.

**5b. Re-register the client** (from your laptop clone — item 0):
```bash
cd ~/GW1-openemr-base-clean/sidecar
OPENEMR_BASE_URL='https://gw1-openemr-base-clean-production.up.railway.app' npx tsx src/scripts/register-oauth.ts
```
The script generates a fresh RSA keypair, registers "Clinical Co-Pilot
Sidecar" with the full scope list (FHIR reads **and** the standard-API write
scopes including the two document scopes), and **prints TWO variables to
copy**: the new `OPENEMR_CLIENT_ID=…` and a one-lined
`OPENEMR_CLIENT_KEY=…` (paste as-is — the `\n` escapes are expected).

**5c. Enable the new client** (freshly registered clients start DISABLED):
OpenEMR → **Administration → System → API Clients** → find "Clinical Co-Pilot
Sidecar" (the newest entry) → open it → **Enable Client**.

**5d. Set on the SIDECAR service** (all four — the new keypair replaces the
old one):

| Variable | Value |
|---|---|
| `OPENEMR_CLIENT_ID` | printed by 5b (the NEW id) |
| `OPENEMR_CLIENT_KEY` | printed by 5b (one-lined PEM, paste exactly) |
| `OPENEMR_API_USERNAME` | an OpenEMR **user** with patients/docs access — `admin` works for the demo |
| `OPENEMR_API_PASSWORD` | that user's password (`pass` on the demo EHR) |

**Verify (post-merge only — see the sequencing box up top):**
```bash
curl -s https://enchanting-mercy-production-5d32.up.railway.app/ready | jq '.dependencies.document_storage'
# not_configured → ok   (proves a live token mint against the new client)
```
> ℹ️ **`failed` + `invalid_client: Client authentication failed`** means
> Railway's `OPENEMR_CLIENT_ID` doesn't match an **enabled** client row in
> the EHR (password-grant auth is id-only — the key plays no part). Verified
> 2026-07-14 across two merge redeploys: **the EHR database persists**, so
> registrations and enables survive deploys — no per-merge ritual. The one
> live incident was an id mismatch among duplicate identically-named rows
> from repeated registrations. Fix: open **Administration → System → API
> Clients**, open any enabled sidecar row, copy its Client ID exactly, paste
> into Railway's `OPENEMR_CLIENT_ID`, Apply — 60 seconds.
`null` today is expected: the `document_storage` probe ships with PR #9, so
the deployed `main` build has no such key. Re-run after merge + redeploy.
Then upload once via the panel Sources tab (or Bruno `06-documents`) and
confirm the document appears in the OpenEMR chart (Patient → Documents); the
ingestion record shows `openemr_document_id` set.

## 6. Dev-login secret (write-path demo auth — E.3/E.8, RUNBOOK §D) — ✅ DONE (user, 2026-07-14)

Generate locally, then set on the **sidecar** service:
```bash
openssl rand -hex 24
```
Set `DEV_LOGIN_SECRET` to the output (any ≥16 random chars works).

**Verify:**
```bash
curl -s -X POST https://enchanting-mercy-production-5d32.up.railway.app/api/dev-login \
  -H 'content-type: application/json' -d '{"role":"physician","patient":"margaret-chen"}'
# returns {"access_token":"…"}; a 404 means the secret is absent or too short
```

## 7. Branch protection: make the eval gate a REQUIRED check (0.5, D5)

GitHub → repo → **Settings → Branches → Add branch protection rule** (classic
UI). Field by field:

1. **Branch name pattern** = `main` — this field names **which branch is
   protected**. ⚠️ The check name does NOT go here (typing "Run eval suite"
   here creates a rule protecting a branch literally named that).
2. Check **Require status checks to pass before merging** ✅.
3. Leave "Require branches to be up to date before merging" unchecked (it
   forces a rerun on every main move — fine to skip for this repo).
4. Click into the box labeled **"Search for status checks in the last week for
   this repository"** and type `Run eval suite` → click the suggestion. That
   exact string is the **job name** inside `.github/workflows/evals.yml` (the
   workflow's *title* is "Sidecar Evals" — branch protection matches JOB
   names, not workflow titles).
   - **If nothing is suggested:** GitHub only offers checks that actually ran
     in the last 7 days. Fix: repo → **Actions → Sidecar Evals → Run
     workflow** (branch `claude/openemr-rag-requirements-x25vzm`) → wait for
     green → reload the branch-protection page → search again.
5. Recommended, same box: also add `sidecar (test + typecheck + build)` and
   `export parity (deploy archive == committed tree)` (the Sidecar CI jobs).
6. Optional hardening: check **"Do not allow bypassing the above settings"** —
   then even admins (you) cannot merge past a red gate. Strongest hard-gate
   story; leave unchecked if you want an escape hatch.
7. Leave everything else unchecked → **Create**.

**Verify:** open PR #9 → the merge box lists *Run eval suite — Required*. Note
the flip in `RELEASE.md`'s promotion gate (the 0.5 acceptance).

## 8. Live eval dispatch (pre-milestone sanity — F.6 prerequisite) — ✅ DONE (user, 2026-07-14; verified via Actions API)

Once items 1/3/5 are in: GitHub → **Actions** (top tab) → **Sidecar Evals**
(left sidebar) → **Run workflow** (grey dropdown, right side) → pick branch
`claude/openemr-rag-requirements-x25vzm` or `main` → green **Run workflow**
button. (CLI alternative, needs `gh auth login`:
`gh workflow run "Sidecar Evals" --ref main`.)

**Verify:** the run goes green; open it → the **Artifacts** section at the
bottom of the run page has `eval-results` (the regenerated
`docs/execution/eval-results.md`). The scheduled live-model suite
(`LIVE_EVALS=1`) rides ticket F.6 — this dispatch just proves the pipe.
