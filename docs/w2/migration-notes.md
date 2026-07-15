# Week 2 Schema Migration Notes (REQ G1)

Every schema change from the Week 1 baseline is recorded here, in the PR that
makes it. "Migration" below means *contract* migration — data migrations, when
needed, get their own numbered SQL file under `sidecar/migrations/` and a row
here.

## #1 — Citation contract v2 (`sidecar/src/schemas/citations.ts`)

**PR:** Wave A ticket A.2. **Data migration required: none** — all additions
are optional/defaulted; every stored Week 1 citation parses unchanged
(pinned by `test/extraction-schemas.test.ts` "backward compatibility").

Changes:

1. `source_type` gains `guideline_evidence` — a retrieved practice-protocol
   chunk. This is the typed half of the grounding split (patient-record vs
   guideline evidence can never blur; REQ S2/R3). Panel mirrors updated
   (`panel/src/types.ts`, `sourceLabels.ts`, `ui.tsx`).
2. `excerpt_location` is now a discriminated union:
   `character_range` (Week 1, unchanged) | `page_bbox` (word-box grounding
   hit; normalized [0,1] coords, top-left origin) | `page` (page-level
   fallback). Readers narrow on `type`; the citation gate's exact-range check
   applies only to `character_range`, and every other location verifies
   through the existing verbatim-search path (`gate/citationGate.ts`).
3. New optional fields `page_or_section` (human-readable locator) and
   `field_or_chunk_id` (machine locator: extraction field path or corpus
   chunk id), both `null`-defaulted.
4. `toSpecCitation(ref)` projects the assignment's minimum machine-readable
   shape `{source_type, source_id, page_or_section, field_or_chunk_id,
   quote_or_value}` for the wire/eval layer. Field mapping (single stored
   shape, no duplicated storage — G1 data authority):
   - `source_id` ≡ `source_document_id` (falls back to the citation `id`)
   - `quote_or_value` ≡ `excerpt_text`
   - `page_or_section` falls back to a rendering of `excerpt_location`

## #2 — Extraction contracts added (`sidecar/src/schemas/extraction.ts`)

**PR:** Wave A ticket A.1. **New schemas, no existing data affected.**

`LabPdfExtractionSchema` and `IntakeFormExtractionSchema` (discriminated
union `ExtractionResultSchema` on `doc_type ∈ {lab_pdf, intake_form}`) are
the canonical contracts for VLM document extraction (G3: raw model output
never bypasses them; all objects `.strict()` so invented keys fail closed).
Every extracted field group carries an `ExtractionCitationSchema` with the
grounding ladder `word_box | page | unverified` — `unverified` fields are
visible but can never be cited (R5/P2).

## #3 — Zod contracts on the remaining unchecked W2 shapes (H.11, 2026-07-15)

**PR:** ticket H.11. **Data migration required: none** — these schemas
formalize EXISTING wire shapes; no wire-shape change.

`IngestionRecord` (+ status/stage/grounding-summary) / `RetrievalResult` /
`SearchOptions` / `QueryContext` / `BuiltQuery` / `EhrVitalPayload`
formalized as Zod schemas (`src/schemas/{ingestion,retrieval,ehrWrites}.ts`);
runtime types are now inferred (`z.infer`) from the same source modules as
before, so no importer changed. Parses sit at real boundaries only:
record-store `save()`, `HybridRetriever.search()` options, outbound
`addVital()` (fails closed, kind `validation`, before any network call), and
the upload route's mime/filename gate (`UploadFileMetaSchema`; the size check
stays the multipart `limits` stream cap → 413, by design). The graph's
`EvidenceSnippetSchema` mirror in `src/graph/contracts.ts` was de-duplicated —
`src/schemas/retrieval.ts` is its single home.
