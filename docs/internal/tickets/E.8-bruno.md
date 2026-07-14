# E.8 — Bruno collection: documents + evidence folder (06-documents)

REQ: G10 · Depends on: E.3 (auth on upload), E.6 (ready probes) · Band: 2

## Why

G10 requires a runnable API collection covering upload, extraction status,
evidence retrieval, and the full W2 flow — headless (`bru run`) against local
and Railway. It is the grader's push-button proof that Dan's document flow
works over plain HTTP, no panel required.

## Existing seams you MUST reuse

- `sidecar/api-collection/` anatomy (copy it exactly): folders `01-health` … `05-images`, each with a `folder.bru`; `bruno.json` = `{ "version": "1", "name": "clinical-copilot-sidecar", "type": "collection", "ignore": ["node_modules", ".git"] }`; environments `environments/local.bru` (`vars { baseUrl: http://localhost:8080 … }`) and `environments/railway.bru` (`vars { baseUrl: https://enchanting-mercy-production-5d32.up.railway.app … }`).
- `.bru` block DSL as used in this repo (see `01-health/02-ready.bru`, `03-prep/01-trigger-prep.bru`, `04-chat/01-chat-message.bru`):
  - `meta { name: …\n type: http\n seq: N }`
  - `get { url: {{baseUrl}}/path\n body: none\n auth: none }` / `post { … body: json … }`
  - `body:json { { "q": "…" } }`
  - `script:post-response { … bru.setVar('conversationId', …); }`
  - `tests { test("desc", function () { expect(res.getStatus())… }); }` — `res.getStatus()`, `res.getBody()`, `res.getHeader()`
  - declarative `assert { res.status: eq 200\n res.body.ready: eq true }`
  - `docs { # Markdown }`
- Routes under test (from `src/routes/ingest.ts`): `POST /api/patients/:patientId/documents` (multipart `doc_type` + `file` → 202 `{ingestion_id, correlation_id, status_url}`), `GET /api/ingestions/:id`, `GET /api/ingestions/:id/file`, `POST /api/evidence/search` (`{q, disease_tags?, top_k?}` → `{snippets, searched_query, rerank_applied, empty}`).
- Fixture: `sidecar/eval/fixtures/documents/renal-panel-clean.pdf` (committed, 57 KB — the hero declining-eGFR panel).
- Dev login (post-E.3): `POST /api/dev-login` body `{"role":"physician","patient":"margaret-chen"}` → `{access_token, …}`; requires `DEV_LOGIN_SECRET` on the target env.
- Hero patient id: `margaret-chen` (locked decision #8; also `load-test.ts`'s default).

## Files to create/modify

All under `sidecar/api-collection/06-documents/` (new folder):
`folder.bru`, `00-dev-login.bru` (conditional — see step 1), `01-upload-lab.bru`,
`02-ingestion-status.bru`, `03-ingestion-file.bru`, `04-evidence-search.bru`,
`05-full-flow.bru`. Optionally add `token`/`ingestionId` placeholder vars to
both `environments/*.bru`.

## Step-by-step implementation

1. **Check whether E.3 has landed** (`grep upload_requires_auth src/routes/ingest.ts`). If yes, the upload is 401 without a bearer **in every mode**, so `00-dev-login.bru` is required and `01-upload-lab.bru` carries `auth: bearer`. If E.3 has not landed, ship without `00-…` and note in `folder.bru` docs that it joins with E.3.
2. `folder.bru`:

```
meta {
  name: 06 — Documents & evidence (Week 2)
  seq: 6
}
```

3. `00-dev-login.bru` (seq 1):

```
meta {
  name: POST /api/dev-login — mint a physician token
  type: http
  seq: 1
}

post {
  url: {{baseUrl}}/api/dev-login
  body: json
  auth: none
}

body:json {
  { "role": "physician", "patient": "margaret-chen" }
}

assert {
  res.status: eq 200
}

script:post-response {
  bru.setVar('token', res.getBody().access_token);
}

docs {
  # Dev login (write-path auth, E.3)
  Requires DEV_LOGIN_SECRET on the target deployment (RUNBOOK §D). The minted
  bearer is a sidecar demo credential, not a SMART launch.
}
```

4. `01-upload-lab.bru` (seq 2) — multipart upload + capture:

```
meta {
  name: POST documents — upload the renal panel (multipart)
  type: http
  seq: 2
}

post {
  url: {{baseUrl}}/api/patients/margaret-chen/documents
  body: multipartForm
  auth: bearer
}

auth:bearer {
  token: {{token}}
}

body:multipart-form {
  doc_type: lab_pdf
  file: @file(../../eval/fixtures/documents/renal-panel-clean.pdf)
}

assert {
  res.status: eq 202
}

script:post-response {
  bru.setVar('ingestionId', res.getBody().ingestion_id);
}

tests {
  test("202 carries ingestion id + status url", function () {
    const body = res.getBody();
    expect(body.ingestion_id).to.be.a('string');
    expect(body.status_url).to.contain('/api/ingestions/');
  });
}
```

   **Path caveat (verify at run time):** Bruno versions differ on whether
   `@file()` resolves relative to the `.bru` file or the collection root. The
   path above is `.bru`-file-relative (from `06-documents/` up to `sidecar/`).
   If `bru run` reports the file missing, switch to the collection-root form
   `@file(../eval/fixtures/documents/renal-panel-clean.pdf)` and note which
   form worked in `folder.bru`'s docs.
5. `02-ingestion-status.bru` (seq 3): `get { url: {{baseUrl}}/api/ingestions/{{ingestionId}} … }`; `assert { res.status: eq 200 }`; `tests` asserting `res.getBody().status` is one of `received|complete|blocked_patient_mismatch|failed_validation|failed_extraction|failed_storage` and `res.getBody().stages` is an array. Docs: extraction is async after the 202 — a fresh upload may legitimately read `received`; byte-identical re-upload returns the same deterministic id (dedupe).
6. `03-ingestion-file.bru` (seq 4): `get { url: {{baseUrl}}/api/ingestions/{{ingestionId}}/file … }`; `assert { res.status: eq 200 }`; `tests`: `expect(res.getHeader('content-type')).to.contain('application/pdf')`. Docs: preview cache only — evicted/restarted entries 404 with a pointer to OpenEMR Documents (expected on a cold Railway instance; re-run 01 first).
7. `04-evidence-search.bru` (seq 5):

```
post {
  url: {{baseUrl}}/api/evidence/search
  body: json
  auth: none
}

body:json {
  { "q": "hydroxychloroquine screening interval with reduced renal function", "top_k": 4 }
}

assert {
  res.status: eq 200
}

tests {
  test("returns snippets with rerank flag", function () {
    const body = res.getBody();
    expect(body.snippets).to.be.an('array');
    expect(body).to.have.property('rerank_applied');
    expect(body.empty).to.equal(false);
  });
}
```

8. `05-full-flow.bru` (seq 6): a docs-first request — `get { url: {{baseUrl}}/health … }`, `assert { res.status: eq 200 }`, and a `docs` block narrating the chain: 00 mint token → 01 upload (202, `ingestionId` var) → 02 poll status to `complete` → 03 fetch stored file → 04 evidence search for the HCQ protocol — plus the panel/chat continuation (evidence turn) and which vars flow between steps. Keep it runnable-but-benign; the chain itself is steps 00–04 executed in folder order.
9. Run headless (step-level then folder), fix paths, trackers, ship.

## What NOT to do

- Do NOT invent new DSL block styles — copy the exact block anatomy from the existing folders (meta/method/body/script/tests/assert/docs).
- Do NOT hardcode a bearer or any secret in `.bru` files or env files — the token is always minted by `00-dev-login.bru` at run time.
- Do NOT point at a non-committed fixture or copy the PDF into the collection — reference the eval fixture in place.
- Do NOT assert on extraction *content* (fact values) — status-shape assertions only; content correctness is the eval gate's job.
- Do NOT add a `01-…` upload assert on `status: complete` — the 202 is immediate, extraction is async.

## Acceptance checks

```bash
cd sidecar && npm run dev &      # local sidecar with DEV_LOGIN_SECRET set (≥16 chars)
cd sidecar/api-collection && npx @usebruno/cli run 06-documents --env local
# → all requests green (00→05); 01 captures ingestionId; 04 returns snippets, empty=false
npx @usebruno/cli run . --env railway   # G10 acceptance: full collection incl. the new folder
```

(Railway leg needs `DEV_LOGIN_SECRET` configured there — USER-ACTIONS.md item.)

## Tests to add

None in vitest — the `.bru` `assert`/`tests` blocks ARE the tests (runnable
headless in both envs). Keep every request carrying at least one `assert`.

## Tracker updates

- `docs/w2/requirements.md` — under **G10** flip: `- [ ] Bruno collection (\`sidecar/api-collection/\`) adds: document upload, extraction status, evidence retrieval, and the full W2 agent flow; runnable headless (\`bru run\`) against local + railway envs; auth'd write requests documented with dev-login flow.` → `- [x]`.
- `docs/internal/build-status.html` — DATA (starts L189): `{ id: "E.8", … s: "pending" }` → `s: "done"`; bump the G10 reqGroup done-count.
- `W2_ARCHITECTURE.md` — no section marker owned by this ticket; skip.

## Verify + ship ritual

```bash
cd sidecar && npm test && npm run typecheck && npm run eval && npm run build
```

Panel untouched — skip the panel leg. Then: conventional commit with
`--trailer "Assisted-by: Claude Code"` (trackers in the SAME commit) →
`git push -u origin claude/openemr-rag-requirements-x25vzm` → update PR #9
body → SendUserFile `docs/internal/build-status.html`.
