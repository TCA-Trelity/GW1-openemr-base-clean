# H.8 — Correlation-ID walk: one ID survives all 7 boundaries

REQ: G4 (+G5) · Depends on: — (coordinate with H.7 on the ingestion-logger wiring, step 4) · Band: merged-plan Track 1 · Priority: P1 (per merged-plan.md)

> **Drift note (2026-07-15, recorded at execution):** H.7 landed first and already
> wired the structured-JSON `ingestionLogger` into `buildDeps`' `IngestionService`
> (`server.ts:204-214` — `logger: ingestionLogger`). Step 4 below is therefore DONE
> upstream: H.8 verified the wiring instead of re-implementing it, and touched
> `server.ts` not at all. H.5 (clients wrapped in `withTimeoutAndRetry`), H.9
> (`attach_and_extract` graph tool threads the graph `correlationId` via
> `GraphToolContext`), and H.11 (Zod schemas single-homed in `src/schemas/`) also
> landed since this spec was written — line anchors below drifted accordingly; the
> code was trusted over the anchors, per step 3.

## Why

G4's open box: the Week 1 correlation ID must propagate through upload →
OpenEMR document write → extraction job + VLM calls → graph supervisor + both
workers → retrieval (embed/rerank) calls → vitals write → answer + citations.
`docs/w2/trace-example.md` documents the intent; this ticket walks the actual
code leg by leg and fixes the drops. Two are already verified (do not rediscover
them, fix them): the OpenEMR standard-API client stamps a **per-instance** id
instead of the request's id, and the production `IngestionService` is built
**without a logger**, so its stage events never reach production logs at all
*(the second was fixed by H.7 in the interim — see drift note)* —
both break "reconstructable from the correlation ID alone" for exactly the flow
a grader exercises (upload → cited answer).

## Existing seams you MUST reuse

- `src/server.ts:299` — `genReqId: (req) => (req.headers['x-correlation-id'] as string | undefined) ?? randomUUID()` and the `:303` onSend hook `reply.header('x-correlation-id', request.id)` — the request-scoped id source; everything downstream must carry THIS value.
- `src/routes/ingest.ts:105` — upload route already threads it: `correlationId: request.id` into `AttachAndExtractInput`; 202 body carries `correlation_id` (:121).
- `src/openemr/standardApi.ts:StandardApiClientOptions.correlationId?: string` — doc comment: *"Stamped on every request as x-correlation-id; defaults to one id per client instance"*. **This is the break** (re-verified after H.5 landed — still present): `uploadPatientDocumentDeduped(pidOrUuid, categoryPath, filename, bytes, mimeType)` (:592) and `listPatientDocuments(pidOrUuid, categoryPath)` (:545) have no per-call id; the headers built in `private async request(...)` (:441, inside H.5's `withTimeoutAndRetry` wrapper now) and in the multipart POST both send `this.correlationId`.
- `src/openemr/fhir.ts:97` — `private async request(path: string, correlationId: string)` — the per-call convention to copy (FhirClient already does this correctly; `ehrSync.ts:313` threads it through `sync(patientId, correlationId)`).
- `src/ingest/service.ts:137` — `attachAndExtract(input: AttachAndExtractInput): Promise<IngestionRecord>`: stamps `record.correlation_id` (:155), logs every stage as `ingestion_<stage>` with `correlation_id` (:166-173), passes it to the extractor (:210-215) which passes it to `AnthropicClient.complete` (`ingest/extractor.ts:96-120`). Code-side correct; the EHR upload call at :184 is where the id fails to cross.
- `src/server.ts:198-211` — `new IngestionService({ extractor, records, factSink: store, ...ehr })` — **no `logger:` key** — the production wiring gap. Structured-JSON console logger precedents: `retrievalBootLogger` (:480) and `graphLogBase` (:516-519). *(RESOLVED by H.7 before H.8 ran: `ingestionLogger` at server.ts:204-214 — verified, not re-implemented.)*
- `src/graph/graph.ts` — supervisor/worker legs verified green: `worker_handoff` events carry `correlation_id`; `evidence_retriever` passes `correlationId` into `retriever.search` (:151); Cohere legs stamp `x-correlation-id` per call (`retrieval/embeddings.ts:91`, `retrieval/rerank.ts:57`); `retrieval_hit|miss` logs carry it (`retriever.ts:230-242`).
- `src/routes/chat.ts` — answer leg verified green: SSE response header `x-correlation-id` (:194), both persisted chat messages carry `correlation_id: String(request.id)` (:217-230), graph invoked with `String(request.id)` (:210-214).
- Vitals leg: `IngestionServiceDeps.vitalsWriter?: (patientId: string, payload: EhrVitalPayload, correlationId: string) => Promise<boolean>` (`service.ts:116`, invoked :293) — the contract carries the id; the writer itself is not yet wired in server.ts (out of scope here — §10 TARGET).
- `docs/w2/trace-example.md` — the reference doc this walk lands its audit table in.

## Files to create/modify

- **Modify** `sidecar/src/openemr/standardApi.ts` — per-call correlation id on the document methods.
- **Modify** `sidecar/src/ingest/service.ts` — pass the ingestion's correlation id into the EHR upload call.
- **Modify** `sidecar/src/server.ts` — inject a structured logger into the `IngestionService` (skip if H.7 already did — check first). *(Checked: H.7 did — skipped, server.ts untouched by H.8.)*
- **Modify** `sidecar/test/openemr-documents.test.ts`, `sidecar/test/ingest.test.ts` — pinning tests.
- **Modify** `docs/w2/trace-example.md` — append the boundary-audit table.
- Trackers: `docs/w2/requirements.md`, `docs/internal/build-status.html`, `W2_ARCHITECTURE.md` §8.

## Step-by-step implementation

1. **Per-call id on the OpenEMR document surface** (`standardApi.ts`): add an optional trailing `correlationId?: string` parameter to `uploadPatientDocumentDeduped` and `listPatientDocuments` (and thread it through `resolveNumericPid` / the private `request` — give `request` an optional `correlationId?: string` last param). Header value: `correlationId ?? this.correlationId` (instance id remains the fallback so seed scripts and existing callers are untouched). Both fetch sites (:434 generic, :597 multipart) use it.
2. **Thread it from ingestion** (`service.ts:184`): `uploadPatientDocumentDeduped(pid, EHR_CATEGORY[input.docType], input.filename, input.bytes, input.mimeType, correlationId)` — the local `correlationId` already in scope (:139).
3. **Walk every other leg against trace-example.md and the list above** — expected result: no further code change (they were verified 2026-07-15 as listed in the seams). If the walk finds another drop (line numbers drift), fix it at the source and add it to the audit table; trust the code over this spec.
4. **Production ingestion logger** (`server.ts` `buildDeps`): *(DONE upstream — H.7 wired exactly this; see drift note.)* unless H.7 already wired it (grep first), add `logger: { info: (obj, msg) => console.log(JSON.stringify({ level: 'info', msg, ...(obj as Record<string, unknown>) })), warn: (…same with 'warn'…) }` to the `new IngestionService({...})` at :198 — the same structured-JSON shape as `graphLogBase`, so `ingestion_<stage>` / `extraction_field_outcome` events land in Railway's log stream greppable by `correlation_id`. (buildDeps runs before the Fastify app exists, so the console-JSON wrapper is the right tool — the `retrievalBootLogger` precedent.)
5. **Audit table** (append a new section to `docs/w2/trace-example.md`, e.g. `## Boundary audit (H.8, 2026-07-…)`) — one row per spec boundary: | # | Boundary | Carrier | File:symbol |, covering: (1) upload request → `genReqId` + 202 body; (2) OpenEMR document write → per-call `x-correlation-id` (fixed here); (3) extraction job + VLM → `record.correlation_id` + `extractor.extract({correlationId})`; (4) graph supervisor/workers → `worker_handoff` events; (5) retrieval embed/rerank → `search options.correlationId` → Cohere headers + `retrieval_hit|miss`; (6) vitals write → `vitalsWriter(…, correlationId)` contract (server wiring pending, §10 TARGET — say so); (7) answer + citations → SSE header + persisted `chat_messages.correlation_id`.
6. Tests, trackers, ship.

## What NOT to do

- Do NOT make `correlationId` a required parameter on the client methods — seed scripts (`seed-ehr.ts`, `check-doc-write.ts`) legitimately run per-process; the instance-id fallback stays.
- Do NOT mint a new id anywhere along the path — the fix is always "pass the one already in scope."
- Do NOT log any new value alongside the id: this ticket adds id plumbing, never payload logging (G18/P5 — the PHI sweep captures ingestion logs; keep events ids/stages/counts only).
- Do NOT wire the vitals writer in server.ts to "complete" boundary 6 — that is §10's TARGET (H.13 notes it too); here the id contract on the seam + a test is the deliverable.
- Do NOT rewrite trace-example.md's verbatim log sections — append the audit table only.

## Acceptance checks

```bash
cd sidecar && npx vitest run test/openemr-documents.test.ts test/ingest.test.ts
cd sidecar && npm test && npm run typecheck
grep -n "logger" sidecar/src/server.ts | grep -i -A2 -B2 ingestion   # logger wired into IngestionService
git diff docs/w2/trace-example.md                                     # audit table present, 7 rows
```

## Tests to add

- `test/openemr-documents.test.ts` — `it('threads the per-request correlation id into every OpenEMR call header — the boot-time instance id would break G4 trace reconstruction')`: recording `fetchImpl`; call `uploadPatientDocumentDeduped(…, 'corr-req-1')` (fresh-upload path: 404 listing → POST true → listing with hash); assert **every** captured request's `x-correlation-id` header is `corr-req-1` (resolve/list/post/verify-list); plus one case asserting the fallback: no arg → instance `correlationId` from options.
- `test/ingest.test.ts` — extend the EHR-wired path (or add one following the `client(fetchImpl)` harness from openemr-documents.test.ts): run `attachAndExtract({..., correlationId: 'corr-ing-7'})` with a real `StandardApiClient` over a recording fetch; assert the document-upload requests carried `corr-ing-7`.

## Tracker updates

- `docs/w2/requirements.md` — under **G4 — Correlation ID propagation** (~:514), flip to `[x]` (verbatim lines):

  ```
  - [ ] The Week 1 correlation ID propagates into: upload request → OpenEMR
    document write → extraction job + VLM calls → graph supervisor + both
    workers → retrieval (embed/rerank) calls → vitals write → answer + citations.
  ```

  Append annotation: `*(Walked + fixed H.8: OpenEMR document writes now carry the per-request id (was per-client-instance); production ingestion stage logging wired; vitals leg = contract-carried on the vitalsWriter seam, server wiring pending per §10. Audit table: docs/w2/trace-example.md.)*`
- `docs/internal/build-status.html` DATA block: ticket `H.8` (L451) `s: "pending"` → `"done"`; reqGroups: `G4` row `done: 1, total: 2` → `done: 2`, `s: "done"`.
- `W2_ARCHITECTURE.md` — §8 "Shipped spine" line: `correlation IDs end-to-end ('server.ts')` → append `(re-walked H.8: OpenEMR write leg now per-request; ingestion stage events live in production logs)`.

## Verify + ship ritual

```bash
cd sidecar && npm test && npm run typecheck && npm run eval && npm run build
```

Panel untouched — skip the panel leg. Then: conventional commit with
`--trailer "Assisted-by: Claude Code"` (trackers in the SAME commit) →
`git push -u origin claude/merged-eval-course-plan-ky6ulh` → update PR #16
body (checklist line for H.8) → SendUserFile
`docs/internal/build-status.html` (rendered inline).
