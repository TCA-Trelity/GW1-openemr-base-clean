# E.7 — Sidecar OpenAPI 3.0 spec + contract test

REQ: G16 · Depends on: A.3 (routes stable) · Band: 2

## Why

G16: the sidecar has **no** OpenAPI spec today (`swagger/openemr-api.yaml` is
core-OpenEMR-only); Week 2 requires one covering all W2 endpoints, with a
contract test that fails on drift. For graders this is the map of Dan's whole
API surface — and the contract test is what keeps it truthful after E.9 lands.

## Existing seams you MUST reuse

- The full registered route surface (verified against `src/routes/*.ts`; re-grep before writing YAML):

| METHOD | PATH | file:line |
|---|---|---|
| GET | `/health` | health.ts:111 |
| GET | `/ready` | health.ts:113 |
| POST | `/api/dev-login` | auth.ts:28 |
| GET | `/api/me` | auth.ts:52 |
| POST | `/api/chat/:patientId` (SSE) | chat.ts:92 |
| GET | `/api/chat/:patientId` | chat.ts:224 |
| POST | `/api/facts/:patientId/:factId/verify` | verify.ts:27 |
| POST | `/api/patients/:patientId/documents` (multipart → 202) | ingest.ts:67 |
| GET | `/api/ingestions/:id` | ingest.ts:114 |
| GET | `/api/patients/:patientId/ingestions` | ingest.ts:122 |
| GET | `/api/ingestions/:id/file` (binary) | ingest.ts:128 |
| POST | `/api/evidence/search` | ingest.ts:153 |
| POST | `/api/prep/:patientId` | prep.ts:61 |
| GET | `/api/brief/:patientId` | prep.ts:131 |
| GET | `/api/facts/:patientId` | prep.ts:142 |
| GET | `/api/prep-runs/:patientId` | prep.ts:155 |
| GET | `/api/usage` | prep.ts:162 |
| GET | `/api/patients` | overview.ts:136 |
| GET | `/api/overview/:patientId` | overview.ts:143 |
| POST | `/api/ehr-sync/:patientId` | ehr.ts:23 |

- `test/ingest-routes.test.ts:makeApp()` (:58-76) — the boot pattern: `buildServer(loadConfig({ NODE_ENV: 'test' }), { checkPostgres, runMigrations, prep: {} as never, overview: {} as never, chat: {} as never, ingest: { service, records }, evidence: { retriever } })`. The contract test extends it so **every** dep group is wired (routes registered conditionally: `registerIngestRoutes`/`registerEvidenceRoutes` return early without deps; `authRoutes` needs `devTokens` for dev-login to exist meaningfully).
- Response shapes to document from source, not memory: `src/prep/budget.ts:UsageSummary` (:43-51), `src/ingest/service.ts:IngestionRecord` (:38-55) + `IngestionStatus` (:24-30), `src/retrieval/retriever.ts:RetrievalResult` (:34-41) + `EvidenceSnippet` (:19-32), dev-login reply (`src/routes/auth.ts:41-49`), chat SSE event vocabulary (`src/routes/chat.ts` writeEvent calls: `seed|delta|citation|tool_use|tool_result|done|error`, plus `status` once E.9 lands).
- `sidecar/package.json` — has **neither** `yaml` nor `js-yaml`. Add `js-yaml` + `@types/js-yaml` to `devDependencies` in `sidecar/package.json` ONLY (standing rule 4).
- `.github/workflows/sidecar-ci.yml` — job `sidecar (test + typecheck + build)` runs `npm test`; the contract test rides it. **No new workflow.**

## Files to create/modify

- **Create** `sidecar/openapi.yaml` — OpenAPI 3.0.3, all 20 paths above.
- **Modify** `sidecar/src/server.ts` — a tiny enumeration seam (step 1) so the test can list registered routes without parsing `printRoutes()` text.
- **Create** `sidecar/test/openapi.test.ts` — the contract test.
- **Modify** `sidecar/package.json` — `js-yaml`, `@types/js-yaml` (devDependencies).

## Step-by-step implementation

1. **Enumeration seam** (`server.ts`, right after `Fastify(...)` is constructed and before any `register*` call):

```ts
const routeTable: { method: string; url: string }[] = [];
app.addHook('onRoute', (route) => {
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
        routeTable.push({ method, url: route.url });
    }
});
app.decorate('routeTable', routeTable);
// + module augmentation next to the existing fastify declare block:
declare module 'fastify' { interface FastifyInstance { routeTable: { method: string; url: string }[] } }
```

   (Zero runtime cost; the hook must be added before the first route registers,
   which is why it lives in `buildServer`, not the test.)
2. **openapi.yaml**: `openapi: 3.0.3`; `info` (title "Clinical Co-Pilot sidecar", version from package.json); `servers`: `http://localhost:8080` + the Railway URL from README (L30). One path item per row above, params as `{patientId}`/`{id}`/`{factId}`. Per-route musts:
   - `POST /api/patients/{patientId}/documents`: `requestBody` `multipart/form-data` with `doc_type` (enum `lab_pdf|intake_form`) + `file` (binary); responses `202` (`{ingestion_id, correlation_id, status_url}`), `400`, `401`, `403` (post-E.3), `413`, `415`.
   - `POST /api/chat/{patientId}`: request `{message, conversation_id?, viewing_image_id?}`; responses `200` with `content: text/event-stream` and a description enumerating the event union (`seed|status|delta|citation|tool_use|tool_result|done|error` — include `status` only if E.9 has landed; check `chat.ts` first) plus pre-stream JSON guards `400/404/429/503`.
   - `GET /api/ingestions/{id}/file`: `200` with `application/pdf` / `image/png` / `image/jpeg` binary + `404`.
   - `POST /api/evidence/search`: request `{q (3-500 chars), disease_tags?[≤6], top_k? (1-8)}`; `200` → RetrievalResult (`snippets[], searched_query, rerank_applied, empty`); `400`.
   - `POST /api/facts/{patientId}/{factId}/verify`: `200/401/403/404/503`.
   - `POST /api/dev-login`: `200/400/404`; `GET /api/me`: `200`; `GET /ready`: `200/503` with the `dependencies` map (statuses `ok|failed|not_configured`, incl. `document_storage|retriever_index|reranker`).
   - Everything else: `200` + its 4xx/503 guards as read from the handlers.
   Define `components.schemas` for `IngestionRecord`, `EvidenceSnippet`, `RetrievalResult`, `UsageSummary`, `CitationRef` (shallow but field-complete — copy field names from the TS types).
3. **Contract test** (`test/openapi.test.ts`), boot copied from `makeApp` but with ALL dep groups stubbed so the full surface registers (add: `authRoutes: { devTokens: new DevTokenService({ secret: 'test-secret-test-secret' }), patientExists: async () => true, mode: 'off' }`, `verify: { store: { verifyFact: async () => true } }`, `ehr: { service: … stub }`, `chat`/`prep`/`overview` per makeApp). Load the YAML with `js-yaml` (`load(readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8'))`). Assertions:
   - `it('every registered route appears in openapi.yaml')` — from `app.routeTable`, drop `HEAD`/`OPTIONS` methods and any url containing `*` (fastify-static/SPA), convert `:param` → `{param}`, assert each `(method, path)` exists in `paths`; also assert `app.routeTable` covered ≥ 20 entries (sanity floor: a silently-unregistered dep group must fail loudly, not shrink the check).
   - `it('every documented path+method is actually registered')` — inverse direction via `app.hasRoute({ method, url })` with `{param}` → `:param`.
   - `it('documented status codes cover what the test suite exercises')` — a small explicit table in the test (`upload: [202,400,401,403,413,415]`, `verify: [200,401,403,404]`, `chat POST: [200,400,404,429,503]`, `ready: [200,503]`, `dev-login: [200,400,404]`) asserted as a subset of each path's documented response keys. Update the table when tests grow — that IS the freshness check.
4. `npm i -D js-yaml @types/js-yaml` **inside `sidecar/`**. Trackers, ship.

## What NOT to do

- Do NOT create a new GitHub workflow — the test rides `sidecar-ci.yml`'s `npm test` (that mirrors the core `api-docs.yml` freshness intent without a second pipeline).
- Do NOT generate the YAML from code with a swagger plugin — the committed spec is the contract; generation would make drift invisible.
- Do NOT parse `printRoutes()` text — use the `onRoute` seam.
- Do NOT document routes that don't register (e.g. a vitals write route that doesn't exist yet).
- Do NOT add deps to the repo-root package.json.

## Acceptance checks

```bash
cd sidecar && npm test         # openapi.test.ts green with the rest
npm run typecheck
# Drift drill: temporarily delete one path from openapi.yaml → npm test fails on
# 'every registered route appears'; restore it.
```

## Tests to add

`sidecar/test/openapi.test.ts` — `describe('OpenAPI contract (G16)')` with the three `it`s from step 3.

## Tracker updates

- `docs/w2/requirements.md` — under **G16** flip: `- [ ] Sidecar OpenAPI 3.0 spec committed (today the sidecar has none; …) covering all W2 HTTP endpoints (…); contract tests verify implementation matches the spec; kept in sync (CI freshness check mirroring the core api-docs.yml pattern).` → `- [x]`.
- `docs/w2/build-status.html` — DATA (starts L189): `{ id: "E.7", … s: "pending" }` → `s: "done"`; bump the G16 reqGroup done-count.
- `W2_ARCHITECTURE.md` — no section header owns G16 directly; if §11 (Testing strategy) names the OpenAPI contract test, refresh it there, else no architecture edit.

## Verify + ship ritual

```bash
cd sidecar && npm test && npm run typecheck && npm run eval && npm run build
```

Panel untouched — skip the panel leg. Then: conventional commit with
`--trailer "Assisted-by: Claude Code"` (trackers in the SAME commit) →
`git push -u origin claude/openemr-rag-requirements-x25vzm` → update PR #9
body → SendUserFile `docs/w2/build-status.html`.
