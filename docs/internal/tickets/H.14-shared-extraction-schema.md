# H.14 — Shared extraction schema: panel imports it, one eval asserts against it

REQ: R2 (shared-module box), D3 · Depends on: — (cleaner after H.11 — step 3 branches on it) · Band: merged-plan Track 1 · Priority: P2 (per merged-plan.md)

## Why

R2's open box: schemas exported from the shared module and used by extraction
validation, fact-store persistence, **panel rendering, eval assertions**. The
first two are done (merged-plan correction #5 — the "zero usage" claim was
wrong); the real gap is exactly the last two: the panel hand-rolls duplicate
shapes (its own header admits it: *"Hand-maintained: the sidecar owns the
schemas — keep field names in lockstep"* — `sidecar/panel/src/types.ts:1-2`),
and no eval asserts an extraction result against the schema via `safeParse`.
A drifted field name would today surface as a rendering bug, not a compile or
gate failure.

## Existing seams you MUST reuse

- `src/schemas/extraction.ts` — the canonical module: `DocType`/`DocTypeSchema` (:13-15), `ABNORMAL_FLAGS`/`AbnormalFlag` (:57-59), `ExtractionResultSchema` (discriminated union, :175-179), `LabPdfExtractionSchema`, `IntakeFormExtractionSchema`. Imports only `zod` — safe for panel type-imports.
- `src/schemas/facts.ts:91-101` — `LabResultContentSchema` / `export type LabResultContent = z.infer<...>` (:101) — the shape the panel duplicates. Also imports only `zod`.
- Panel duplicates (verified):
  - `sidecar/panel/src/types.ts:213-224` — hand-rolled `interface LabResultContent` (comment: *"mirrors schemas/facts.ts LabResultContentSchema"*), incl. the `abnormal_flag` union literal at :220 duplicating `ABNORMAL_FLAGS`.
  - `sidecar/panel/src/api.ts:189-200` — `interface IngestionRecordView` mirroring a subset of `IngestionRecord` (+ the grounding-summary shape inline at :197); `doc_type: 'lab_pdf' | 'intake_form'` unions also at api.ts:192/:206.
- **Panel CI constraint (verified — this is why zod must be added):** the `panel` CI job runs `npm ci` in `sidecar/panel` ONLY (`.github/workflows/sidecar-ci.yml`), so `sidecar/node_modules` is absent there; a type-only import of a zod-typed module still needs `zod`'s types to resolve → add `zod` to `sidecar/panel/package.json` devDependencies pinned to the sidecar's range (`"zod": "^3.24.1"`, matching `sidecar/package.json:38`). Type-only imports are erased by vite/tsc — zero runtime/bundle change.
- **Panel tsconfig constraint (verified):** `sidecar/panel/tsconfig.json` has `lib: [ES2022, DOM]`, `types: ["vite/client"]`, no `@types/node` — so the panel may type-import ONLY from modules whose transitive imports are zod-pure (`schemas/extraction.ts`, `schemas/facts.ts`, and H.11's `schemas/ingestion.ts`). Importing types from `src/ingest/service.ts` would drag `node:crypto` types in and break the panel typecheck.
- `eval/extraction.eval.ts` — the extraction goldens (imports `../src/...` directly — the eval-side import path precedent); `eval/collector.ts:recordEval(record: EvalRecord)` with `category?: EvalCategory`, `enforce?: 'hard' | 'soft'`; `VlmExtractor` + fixture bytes already loaded at the top of the file (:8-28).
- Standing rules: baseline only via `npm run eval:baseline` with an explained diff (tickets/README.md rule 2); the suite currently reports **58** cases — this ticket adds one.

## Files to create/modify

- **Modify** `sidecar/panel/package.json` (+ `package-lock.json` via `npm install` inside `sidecar/panel`) — devDependency `"zod": "^3.24.1"`.
- **Modify** `sidecar/panel/src/types.ts` — hand-rolled extraction shapes → type re-exports from the shared module.
- **Modify** `sidecar/panel/src/api.ts` — `IngestionRecordView` and the `doc_type` unions derive from shared types.
- **Modify** `sidecar/eval/extraction.eval.ts` — one new schema-assertion case.
- **Possibly modify** `sidecar/eval/baseline.json` — ONLY via `npm run eval:baseline` if the gate asks for it (see step 5).
- Count surfaces (same commit): `W2_ARCHITECTURE.md` §7 header ("58 deterministic cases across 14 suites"), `docs/internal/build-status.html` stamp + S4/R6 row text where "58" is quoted.
- Trackers: `docs/w2/requirements.md`, `docs/internal/build-status.html`.

## Step-by-step implementation

1. **zod devDep** (panel): add + `npm install` in `sidecar/panel` so `package-lock.json` updates (CI uses `npm ci` — a missing lock entry fails the leg).
2. **types.ts**: delete the hand-rolled `LabResultContent` interface; replace with `export type { LabResultContent } from '../../src/schemas/facts.js';` (type-only re-export — erased at build). Call sites import from `./types` today, so nothing else moves. Where the file uses abnormal-flag literals, import `type { AbnormalFlag }` from `../../src/schemas/extraction.js` instead of restating the union. Leave the OTHER mirrored families (citations/sources/contradictions/provider) alone — they predate W2, partly runtime consts (`SOURCE_TYPES` array), and are not this box's scope; add a one-line comment scoping the lockstep warning to them only.
3. **api.ts**: `import type { DocType } from '../../src/schemas/extraction.js';` — `doc_type: DocType` in `IngestionRecordView` and `uploadDocument(patientId, file, docType: DocType)`. For the record shape, branch on H.11:
   - **H.11 landed** (`sidecar/src/schemas/ingestion.ts` exists): `import type { IngestionRecord } from '../../src/schemas/ingestion.js';` and `export type IngestionRecordView = IngestionRecord;` — the GET `/api/ingestions/:id` route returns the full record, so the narrower hand mirror was only drift surface. (Verify the module is zod-pure before importing — it must not import from `ingest/service.ts`.)
   - **H.11 not landed:** keep `IngestionRecordView` but derive its `doc_type` from `DocType` and leave a `// TODO(H.11): replace with the shared IngestionRecord schema type` marker — do NOT import from `src/ingest/service.ts` (node-types breakage, see seams).
4. **Eval assertion** (`eval/extraction.eval.ts`): one new case in the existing lab-fixture describe — run the extractor over `renal-panel-clean.pdf` (reuse the file's existing scripted-VLM plumbing), then:

   ```ts
   const parsed = ExtractionResultSchema.safeParse(outcome.extraction);
   recordEval({
       id: 'extraction.shared-schema-contract',
       description: 'Extraction output parses under the shared ExtractionResultSchema via safeParse — the panel and eval consume the SAME contract module (R2)',
       metric: 'ExtractionResultSchema.safeParse(...).success',
       value: String(parsed.success),
       threshold: 'true',
       pass: parsed.success,
       category: 'schema_valid',
   });
   ```

   (Import `ExtractionResultSchema` from `../src/schemas/extraction.js`.)
5. **Gate/baseline + count surfaces**: run `npm run eval`. A new PASSING `schema_valid` case can only raise the category rate, so the tiered gate should pass without a re-baseline; if `eval/gate.ts` still reports a baseline mismatch, run `npm run eval:baseline` and commit the diff with an explanation in the PR body (standing rule 2 — never hand-edit). Update the case-count strings in the SAME commit: W2_ARCHITECTURE §7 header and the build board's stamp/S4-R6 row (58 → 59, 14 suites unchanged). Do not chase "58" through historical docs (gate-rehearsal.md etc. record what was true then).
6. Panel leg + tests, trackers, ship.

## What NOT to do

- Do NOT import anything with runtime effect from `sidecar/src` into the panel — type-only imports (`import type` / `export type ... from`) exclusively; the panel bundle must not grow a zod dependency at runtime.
- Do NOT import panel types from `src/ingest/service.ts` (drags `node:crypto` types into a DOM-lib tsconfig — typecheck breaks; verified constraint).
- Do NOT loosen or restate the schema on the eval side — the assertion imports the real module; a paraphrased schema would defeat the point.
- Do NOT hand-edit `eval/baseline.json` (standing rule 2) and do NOT change any existing case's `id` or expected behavior.
- Do NOT unify the panel's non-extraction mirrored types in this ticket — scope is the extraction-data shapes named by the R2 box.

## Acceptance checks

```bash
cd sidecar && npm run eval          # 59/59, GATE PASS, new case extraction.shared-schema-contract listed
cd sidecar && npm test && npm run typecheck
cd sidecar/panel && npx tsc -p tsconfig.json --noEmit && npx vitest run && npm run build
grep -n "interface LabResultContent" sidecar/panel/src/types.ts   # no hits — re-export instead
grep -rn "safeParse" sidecar/eval/extraction.eval.ts              # the schema assertion present
```

## Tests to add

- The eval case in step 4 (it IS the test; rides the gate as a `schema_valid` boolean).
- Panel: no new test files needed — the existing `sidecar/panel/src/test/upload.test.tsx` (+ full panel suite) passing against the re-exported types is the drift-proof; if `upload.test.tsx` declares its own doc_type literals, switch them to the shared `DocType` import so the compiler owns lockstep there too.

## Tracker updates

- `docs/w2/requirements.md` — under **R2** (~:131), flip to `[x]` (verbatim lines):

  ```
  - [ ] Schemas exported from the shared schema module (same one-schema-serves-
    API-and-UI pattern as Week 1) and used by: extraction validation, fact-store
    persistence, panel rendering, eval assertions.
  ```

  Append annotation: `*(H.14: panel type-imports the shared extraction/facts types (hand-rolled duplicates deleted; zod added to panel devDeps for type resolution only); eval case extraction.shared-schema-contract asserts a live extraction result via ExtractionResultSchema.safeParse.)*`
- `docs/internal/build-status.html` DATA block: ticket `H.14` (L457) `s: "pending"` → `"done"`; reqGroups: `R2` row `done: 4, total: 5` → `done: 5`, `s: "done"`; update the stamp's `eval 58/58 GATE PASS` figure to the new count.
- `W2_ARCHITECTURE.md` — §7 header count `58` → `59` (suite count 14 unchanged); no status-marker flip owed.

## Verify + ship ritual

```bash
cd sidecar && npm test && npm run typecheck && npm run eval && npm run build
```

Panel WAS touched — additionally:

```bash
cd sidecar/panel && npx tsc -p tsconfig.json --noEmit && npx vitest run && npm run build
```

Then: conventional commit with `--trailer "Assisted-by: Claude Code"`
(trackers in the SAME commit) →
`git push -u origin claude/merged-eval-course-plan-ky6ulh` → update PR #16
body (checklist line for H.14) → SendUserFile
`docs/internal/build-status.html` (rendered inline).
