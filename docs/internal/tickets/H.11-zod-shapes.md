# H.11 — Zod contracts on the four unchecked data shapes

REQ: G1 (contracts box; R2 adjacent — see Tracker notes) · Depends on: — (pairs with H.13; land before H.14 if possible — H.14 reuses the new ingestion schema) · Band: merged-plan Track 1 · Priority: P1 (per merged-plan.md)

## Why

G1's open box requires typed contracts on the W2 interfaces; four shapes are
still plain TypeScript with no runtime parse: the ingestion job record, the
retriever's query/response shapes, the vitals write payload, and the upload
endpoint's mime/size checks (its `doc_type` is ALREADY Zod — merged-plan
correction #4: this fix is smaller than originally scoped). Schemas become the
source of truth beside the existing ones in `src/schemas/`; types are inferred
via `z.infer`; parsing happens at real boundaries only.

## Existing seams you MUST reuse

- `src/ingest/service.ts:38` — `interface IngestionRecord` (fields: id, patient_id, doc_type: DocType, filename, mime_type, sha3_512, correlation_id, status: IngestionStatus, stages: IngestionStage[], openemr_document_id: string|null, source_document_id: string|null, grounding: GroundingSummary|null, facts_persisted: number, vitals_written: boolean, error: string|null, created_at) and `:59` `interface IngestionRecordStore { save(record): void; get(id): IngestionRecord|undefined; findByHash(patientId, hash): …; listForPatient(patientId): IngestionRecord[] }`; `IngestionStatus` union at :24-30; `IngestionStage` at :32-36.
- `src/ingest/grounding.ts:14-21` — `interface GroundingSummary { total; word_box; page; unverified; confidence: number }` (embedded in the record — needs a schema too).
- `src/retrieval/retriever.ts:36` — `interface RetrievalResult { snippets: EvidenceSnippet[]; searched_query: string; rerank_applied: boolean; empty: boolean }` and `:45` `interface SearchOptions { topK?: number; context?: QueryContext; identifiers?: PatientIdentifiers; correlationId?: string }`; `EvidenceSnippet` at :21-34.
- `src/retrieval/queryPolicy.ts:64` — `interface QueryContext { concepts?: readonly string[]; diseaseTags?: readonly string[]; laterality?: 'OD'|'OS'|'OU' }` and `:71` `interface BuiltQuery { query: string; filters: { diseaseTags?: readonly string[] } }`; `PatientIdentifiers` at :14-22. (Merged-plan correction #3: these are the real names — not "SearchOptions-type".)
- `src/openemr/standardApi.ts:103` — `interface EhrVitalPayload { bps?; bpd?; pulse?; respiration?; temperature?; oxygen_saturation?; weight?; height?: number; note?: string }` (every field optional; US units); `addVital(pid, eid, payload)` at :340 — the outbound boundary; `StandardApiError(path, status, detail)` with `kind: 'validation'` for 400s. (The merged plan and board row cite :97 — pre-H.5 numbering; the shape is unchanged.)
- `src/routes/ingest.ts:27` — `const ACCEPTED_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg'])`, used at :90 (415); multipart size limit at :66 (`limits: { fileSize: deps.maxFileBytes ?? 10 * 1024 * 1024, files: 1 }`) surfaced as 413 at :97; `doc_type` already parsed via `DocTypeSchema.safeParse` at :86 — leave it.
- `src/graph/contracts.ts:53-66` — `EvidenceSnippetSchema` (".strict()", mirrors `EvidenceSnippet` field-for-field) — this is a SECOND hand-kept mirror of the retriever shape; H.11 makes `src/schemas/retrieval.ts` the single home and `contracts.ts` imports it (do not create a third copy).
- `src/schemas/index.ts` — the barrel ("import from here"); `src/schemas/extraction.ts` shows the house schema style (`.strict()`, doc comments, `z.infer` type exports).
- `docs/w2/migration-notes.md` — G1's schema-change log (these schemas formalize existing wire shapes — record that as a no-wire-change entry).

## Files to create/modify

- **Create** `sidecar/src/schemas/ingestion.ts` — `IngestionStatusSchema`, `IngestionStageSchema`, `GroundingSummarySchema`, `IngestionRecordSchema`, `UploadFileMetaSchema`.
- **Create** `sidecar/src/schemas/retrieval.ts` — `EvidenceSnippetSchema` (moved), `RetrievalResultSchema`, `QueryContextSchema`, `PatientIdentifiersSchema`, `SearchOptionsSchema`, `BuiltQuerySchema`.
- **Create** `sidecar/src/schemas/ehrWrites.ts` — `EhrVitalPayloadSchema`.
- **Modify** `sidecar/src/schemas/index.ts` — barrel exports for the three new modules.
- **Modify** `sidecar/src/ingest/service.ts`, `src/ingest/grounding.ts`, `src/retrieval/retriever.ts`, `src/retrieval/queryPolicy.ts`, `src/openemr/standardApi.ts` — replace each interface with `export type X = z.infer<typeof XSchema>;` **exported from the same module as today** (so no importer changes anywhere); add the boundary parses below.
- **Modify** `sidecar/src/graph/contracts.ts` — import `EvidenceSnippetSchema` from `../schemas/retrieval.js` (delete the local copy; keep `parseEvidencePayload` + `GraphContractError` unchanged).
- **Modify** `sidecar/src/routes/ingest.ts` — mime/filename check via `UploadFileMetaSchema` (same 415 status + message shape).
- **Modify tests**: `sidecar/test/ingest.test.ts`, `test/retrieval.test.ts`, `test/openemr-documents.test.ts`, `test/ingest-routes.test.ts`.
- **Modify** `docs/w2/migration-notes.md` — one entry.
- Trackers: `docs/w2/requirements.md`, `docs/internal/build-status.html`.

## Step-by-step implementation

1. **Schemas** — mirror the interfaces exactly (nullable vs optional matters: record fields are `T | null`, search options are optional). Style: `.strict()` objects, doc comments carrying the same semantics as today's interface comments. Sketch of the trickiest one:

   ```ts
   export const IngestionStatusSchema = z.enum(['received', 'complete', 'blocked_patient_mismatch', 'failed_validation', 'failed_extraction', 'failed_storage']);
   export const IngestionStageSchema = z.object({ stage: z.string().min(1), at: z.string().min(1), detail: z.string().optional() }).strict();
   export const IngestionRecordSchema = z.object({
       id: z.string().min(1), patient_id: z.string().min(1), doc_type: DocTypeSchema,
       filename: z.string().min(1), mime_type: z.string().min(1), sha3_512: z.string().length(128),
       correlation_id: z.string().min(1), status: IngestionStatusSchema,
       stages: z.array(IngestionStageSchema), openemr_document_id: z.string().nullable(),
       source_document_id: z.string().nullable(), grounding: GroundingSummarySchema.nullable(),
       facts_persisted: z.number().int().min(0), vitals_written: z.boolean(),
       error: z.string().nullable(), created_at: z.string().min(1),
   }).strict();
   export const UploadFileMetaSchema = z.object({
       mimetype: z.enum(['application/pdf', 'image/png', 'image/jpeg']),
       filename: z.string().min(1),
   }); // NOT .strict() — it parses a slice of @fastify/multipart's file object
   ```

   `EhrVitalPayloadSchema`: all fields `z.number().positive().optional()` (`bps`/`bpd`/`pulse`/`respiration` `.int()`), `note: z.string().optional()`, `.strict()` — an invented key must fail closed before it reaches OpenEMR.
2. **Type swaps** — in each source module: `export type IngestionRecord = z.infer<typeof IngestionRecordSchema>;` etc. Every current importer keeps importing from the same place. Watch `exactOptionalPropertyTypes` (standing rule 8): inferred optionals become `k?: T | undefined` — existing conditional-spread call sites remain valid; if a mismatch appears, fix the caller with the conditional-spread idiom, never with a cast.
3. **Boundary parses** (parse, don't validate — at trust boundaries only):
   - `MemoryIngestionRecordStore.save()` parses via `IngestionRecordSchema.parse(record)` — the store interface is the contract the future PG swap honors; cheap at demo volume (~8 small parses per ingestion).
   - `HybridRetriever.search()` parses `options` via `SearchOptionsSchema` at entry (multiple caller classes: routes, graph, scripts, evals). The RESULT stays construction-typed — the graph already parses snippets through `parseEvidencePayload`, and double-parsing the hot path buys nothing (assert result shape in tests instead).
   - `StandardApiClient.addVital()` parses `payload` via `EhrVitalPayloadSchema.safeParse`; failure → `throw new StandardApiError(path, 400, 'vitals payload failed contract: …issues')` (kind `'validation'`) BEFORE any network call.
   - `routes/ingest.ts`: replace the `ACCEPTED_MIME.has(...)` check with `UploadFileMetaSchema.safeParse({ mimetype: file.mimetype, filename: file.filename })` → same `415` + `unsupported media type … (pdf/png/jpeg only)` message on failure (keep `ACCEPTED_MIME` deleted or derived from the schema enum — one source of truth). **Size stays enforced by the multipart `limits` stream cap + the 413 mapping** — that is the correct layer for a size check (a schema cannot pre-measure a stream); say so in a comment where `limits` is set.
4. **contracts.ts**: swap the local `EvidenceSnippetSchema` for the `schemas/retrieval.js` import; run the graph tests — byte-identical behavior expected.
5. **migration-notes.md**: one dated entry — "H.11: IngestionRecord / RetrievalResult / SearchOptions / QueryContext / BuiltQuery / EhrVitalPayload formalized as Zod schemas (src/schemas/{ingestion,retrieval,ehrWrites}.ts); types now inferred; no wire-shape change."
6. Tests, trackers, ship.

## What NOT to do

- Do NOT keep (or create) duplicate schema copies — after this ticket the retriever shape lives in exactly one schema module; `contracts.ts` imports it.
- Do NOT move the size check into Zod or read the whole stream to measure it — the multipart `limits` cap is the enforcement point; H.11 documents it, not replaces it.
- Do NOT change any wire shape, status code, or error message the panel/Bruno/OpenAPI contract tests pin (`test/openapi.test.ts` will catch drift — if it fails, you changed a shape, revert).
- Do NOT parse in hot inner loops (per-chunk, per-fact) — boundaries only, as listed.
- Do NOT touch the R2 extraction schemas — they are already canonical; this ticket is the OTHER four shapes.
- Do NOT silence type fallout with `@ts-expect-error`/casts — fix at the source (CLAUDE.md static-analysis rules).

## Acceptance checks

```bash
cd sidecar && npm test && npm run typecheck
grep -rn "EvidenceSnippetSchema" sidecar/src | grep -v schemas/retrieval   # only imports remain (contracts.ts, tests)
grep -n "ACCEPTED_MIME" sidecar/src/routes/ingest.ts                        # gone or schema-derived
cd sidecar && npx vitest run test/ingest-routes.test.ts                     # 415/413/400 behavior byte-identical
```

## Tests to add

- `test/ingest.test.ts` — `it('the record store rejects a hand-built record violating the ingestion contract — drift fails at save, not in a consumer')` (invalid status / missing field → throws with the field named); `it('every stage of a real run saves a schema-valid record')` (parse each saved record).
- `test/retrieval.test.ts` — `it('search() rejects malformed options at the boundary (topK 0, unknown key) instead of misbehaving downstream')`; `it('a real search result parses under RetrievalResultSchema')`.
- `test/openemr-documents.test.ts` — `it('addVital parses the payload before any network call — a negative bps or invented key never reaches OpenEMR')` (fetch spy: zero calls on invalid payload; valid payload still POSTs).
- `test/ingest-routes.test.ts` — regression pins: bad mime → 415 (same message), oversize → 413, bad doc_type → 400 (all pre-existing behavior, now schema-backed).

## Tracker updates

- `docs/w2/requirements.md` — under **G1** (~:476), flip to `[x]` (verbatim lines):

  ```
  - [ ] Zod contracts on: upload API, ingestion job state, extraction outputs
    (R2), retriever query/response, graph state + handoffs, vitals write
    payload, citation v2.
  ```

  Append annotation: `*(Closed by H.11: ingestion job state, retriever query/response, vitals write payload, upload mime/filename (size = multipart limits by design, doc_type was already Zod). Extraction outputs, graph contracts, citation v2 were already schema'd.)*`
- **Adjacent, do NOT flip here** — under **R2** (~:131), verbatim lines:

  ```
  - [ ] Schemas exported from the shared schema module (same one-schema-serves-
    API-and-UI pattern as Week 1) and used by: extraction validation, fact-store
    persistence, panel rendering, eval assertions.
  ```

  That box closes in **H.14** (panel rendering + eval assertions are its missing legs); H.11 only cross-references it.
- `docs/internal/build-status.html` DATA block: ticket `H.11` (L454) `s: "pending"` → `"done"`; reqGroups: `G1` row `done: 2, total: 3` → `done: 3`, `s: "done"`, and trim its `t` annotation `(open: Zod on the vitals-write payload — route pending)`.
- `W2_ARCHITECTURE.md` — no status-marker owner for this box; leave headers alone (§10's validation column already reads correctly).

## Verify + ship ritual

```bash
cd sidecar && npm test && npm run typecheck && npm run eval && npm run build
```

Panel untouched — skip the panel leg. Then: conventional commit with
`--trailer "Assisted-by: Claude Code"` (trackers in the SAME commit) →
`git push -u origin claude/merged-eval-course-plan-ky6ulh` → update PR #16
body (checklist line for H.11) → SendUserFile
`docs/internal/build-status.html` (rendered inline).
