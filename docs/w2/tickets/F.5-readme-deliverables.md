# F.5 — README restructure: W1 vs W2, no-guessing setup, deliverables map (execution-plan ticket **F.3**, D1)

REQ: D1 · Plan ticket: **F.3** in `docs/w2/execution-plan.md` · Depends on: Wave E landed (document what ships) · Band: 3

## Why

D1's acceptance is literal: a grader runs the core W2 flow "**without guessing
which branch, environment variable, or service is required**." Today the fork
README (top of `README.md`, above the upstream OpenEMR README) has deployed
links and two deliverables tables but **no env-var section at all** (setup is
scattered across RUNBOOK §A–§D). This ticket makes README the single front
door: W1-baseline vs W2-multimodal behavior, one quickstart, one env table,
one doc map.

## Existing seams you MUST reuse

- `README.md` as-is: `# AgentForge Clinical Co-Pilot (OpenEMR fork)` (L19); **Live EHR** + **Live agent** Railway URLs (L28/L30); branch note (L33-34: `main` = stable/instructor-facing); Week 1 deliverables table (L36-55); `### Week 2 — Multimodal Evidence Agent (in progress)` (L57-69); the **upstream OpenEMR README begins at L73 (`# OpenEMR`) — leave everything from there down untouched**.
- `sidecar/src/config.ts` — the authoritative env-var list (table below is derived from it; re-check against the file before committing — config keys may have grown).
- `docs/RUNBOOK.md` §A–§D (activation detail README links to, not duplicates), `CONTRIBUTING.md`/`docker/development-easy` (OpenEMR dev stack), `sidecar/package.json` scripts (`npm ci`, `npm run dev|build|test|eval`), `sidecar/panel/package.json` (`npm run dev|build|test`, `typecheck`).
- Doc map targets: `ARCHITECTURE.md` (W1), `W2_ARCHITECTURE.md`, `docs/w2/requirements.md`, `docs/w2/execution-plan.md`, `docs/w2/gate-rehearsal.md`, `docs/w2/trace-example.md`, `docs/RUNBOOK.md`, `docs/COSTS.md`, `docs/execution/baselines.md`, `docs/execution/eval-results.md`, `docs/execution/observability.md`, `sidecar/openapi.yaml` (post-E.7), `sidecar/api-collection/` (post-E.8).

## Files to create/modify

- **Modify** `README.md` — restructure the fork section (L19–~L70) only.

## Step-by-step implementation

1. **Restructure the fork section** into this heading order (keep the
   existing URLs/tables' content, re-homed):
   1. Title + one-paragraph pitch (Dan, retina surgeon; synthetic data).
   2. `## Deployed` — both Railway services + auth note (RUNBOOK §D pointer).
   3. `## Week 1 baseline vs Week 2 additions` — two short columns/tables:
      W1 (brief/chat/citations gate/imaging on prepared facts — "unchanged")
      vs W2 (document ingestion + grounding overlay, hybrid RAG + rerank,
      supervisor/worker graph + critic, 58-case PR-blocking eval gate,
      write-path auth, OpenAPI/Bruno surface). Reuse the two existing tables'
      rows; the split sentence at current L61 becomes the section lede.
   4. `## Quickstart (no guessing)` — three fenced blocks:
      - OpenEMR (optional for sidecar-only grading): `cd docker/development-easy && docker compose up --detach --wait` (login `admin`/`pass`), or use the deployed EHR URL.
      - Sidecar: `cd sidecar && npm ci && DATABASE_URL=postgres://… npm run dev` (needs Node 22 + Postgres; keyless boot works — features degrade per the env table; `npm test` / `npm run eval` run keyless by design).
      - Panel: `cd sidecar/panel && npm ci && npm run build` (or `npm run dev` for the Vite proxy to :8080).
      Branch statement verbatim: work lands on `claude/openemr-rag-requirements-x25vzm` → PR #9 → `main` is the graded branch.
   5. `## Environment variables` — the full table (below), one row per
      config key: *Variable · Default · What it unlocks (absent = ?)*.
   6. `## Deliverables & doc map` — D1–D8 rows linking the doc-map targets
      above (video row from F.4's placeholder; tag/deploy from F.8).
2. **The env table** (derived from `config.ts`; verify + include every key):

| Variable | Default | Unlocks |
|---|---|---|
| `PORT` | `8080` | listen port |
| `NODE_ENV` | `development` | `production` makes openemr/anthropic required in `/ready` |
| `DATABASE_URL` | — | fact store: prep, chat, verify, facts, ledger (absent → 503 `store_not_configured`) |
| `ANTHROPIC_API_KEY` | — | prep extraction, chat turns, VLM ingestion, router tie-break, evidence composer (absent → evidence turns fall back to fast path) |
| `ANTHROPIC_MODEL_PREP` / `ANTHROPIC_MODEL_CHAT` | `claude-haiku-4-5` | model pins |
| `LLM_DAILY_BUDGET_USD` | `5` | SpendGuard cap (**do not raise**) |
| `LLM_MAX_OUTPUT_TOKENS` / `LLM_CHAT_MAX_OUTPUT_TOKENS` | `8192` / `1024` | per-call output ceilings |
| `LLM_INPUT_USD_PER_MTOK` / `LLM_OUTPUT_USD_PER_MTOK` | `1` / `5` | ledger pricing rates |
| `LLM_MAX_CONCURRENT_PREPS` / `PREP_REUSE_WINDOW_MINUTES` | `2` / `10` | prep throttles |
| `OPENEMR_BASE_URL` | — | EHR probes + FHIR sync + document storage base |
| `OPENEMR_CLIENT_ID` / `OPENEMR_CLIENT_KEY` | — | FHIR read client (E2 sync) |
| `OPENEMR_API_USERNAME` / `OPENEMR_API_PASSWORD` | — | password-grant document writes to OpenEMR (absent → sidecar-side storage only, stated) |
| `OPENEMR_OAUTH_SITE` | `default` | OAuth site path segment |
| `AUTH_MODE` | `off` | `enforced` turns on the PEP (401/403); upload+verify writes require a bearer in EVERY mode (E.3) |
| `DEV_LOGIN_SECRET` (≥16 chars) / `DEV_TOKEN_TTL_SECONDS` | — / `3600` | `POST /api/dev-login` demo tokens |
| `COHERE_API_KEY` | — | live dense embeddings + rerank (absent → offline hash-embed + passthrough rerank; `/ready` shows `reranker: not_configured`) |
| `COHERE_EMBED_MODEL` / `COHERE_RERANK_MODEL` | `embed-english-v3.0` / `rerank-english-v3.0` | Cohere model pins |
| `RETRIEVER_DENSE_BACKEND` | `pgvector` | `memory` = in-process cosine fallback (`npm run verify:pgvector` decides) |
| `LANGFUSE_HOST` / `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | — | tracing (all three or nothing) |
| `LANGSMITH_TRACING` / `LANGSMITH_API_KEY` / `LANGSMITH_PROJECT` | `false` / — / `clinical-copilot-w2-demo` | **demo env only** (locked #2) |
| `SCAN_IMAGES_DIR` | baked seed | scan pixels dir for `/api/images` |
| `REDIS_URL` | — | reserved (unused) |

   Footnote the boot-resilience property: an invalid value never crashes boot —
   the feature disables with a `[config]` warning (config.ts design).
3. **Grader path check**: follow your own README top-to-bottom on a clean
   clone — upload → extraction status → chat with citations must be reachable
   with only the README open. Fix what you stumbled on.
4. Trackers, ship.

## What NOT to do

- Do NOT touch the upstream OpenEMR README (L73+) — the fork section only.
- Do NOT duplicate RUNBOOK §A–§D procedure detail — link it; README states
  *which* variable, RUNBOOK states *how to mint it*.
- Do NOT document aspirational features (vitals write route, live-VLM
  numbers) as present — the table says what absence degrades to, honestly.
- Do NOT paste secrets or working keys as examples (`sk-…` placeholders only).
- Do NOT drop the synthetic-data statement.

## Acceptance checks

```bash
git diff README.md    # fork section: 6 headings, full env table, doc map; L73+ untouched
# The D1 test, literally: a colleague (or you, fresh shell) runs the quickstart
# from README alone and reaches upload → status → cited chat without opening
# another doc. Record "works from README alone: yes" in the PR body.
```

## Tests to add

None — documentation. (Ship ritual still runs.)

## Tracker updates

- `docs/w2/requirements.md` — **D1 is a table row** (section 3): verify its acceptance text now holds; annotate the row `(shipped — README restructure, <commit>)`.
- `docs/w2/build-status.html` — DATA (starts L189): ticket **`F.3`** (`{ id: "F.3", … }` — NOT "F.5"; spec filename differs from the plan ticket) → `s: "done"`; bump the Deliverables (D1) reqGroup count.
- `W2_ARCHITECTURE.md` — no marker owned; ensure README's doc map links it (D2 cross-link requirement).

## Verify + ship ritual

```bash
cd sidecar && npm test && npm run typecheck && npm run eval && npm run build
```

Panel untouched — skip the panel leg. Then: conventional commit with
`--trailer "Assisted-by: Claude Code"` (trackers in the SAME commit) →
`git push -u origin claude/openemr-rag-requirements-x25vzm` → update PR #9
body → SendUserFile `docs/w2/build-status.html`.
