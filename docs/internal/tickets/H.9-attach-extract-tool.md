# H.9 — `attach_and_extract` as a first-class async graph tool

REQ: S1/R1 (chat/graph tool box) · Depends on: — (Wave C shipped) · Band: merged-plan Track 1 · Priority: P1 (per merged-plan.md)

## Why

S1/R1's open box: *"Equivalent chat/graph tool `attach_and_extract(patient_id,
file_path, doc_type)` wraps the same service path (name preserved from spec)."*
The capability exists as `IngestionService.attachAndExtract` and the graph's
`intake_extractor` node calls it **inline** (`src/graph/graph.ts:135`) — there
is no discrete, named tool object a model (or a future graph node) can be told
about and invoke by name. This ticket wraps it as an async **graph** tool and
rewires the inline call. Design constraint carried from the original
evaluation: this must NOT join the synchronous read-only chat tool list —
that list is deliberately fast/sync/read-only, and ingestion is neither.

## Existing seams you MUST reuse

- `src/ingest/service.ts:137` — `async attachAndExtract(input: AttachAndExtractInput): Promise<IngestionRecord>` on `class IngestionService` (:133); `AttachAndExtractInput` (:99-108): `{ patientId: string; docType: DocType; filename: string; mimeType: string; bytes: Uint8Array; correlationId?: string; expectedPatient?: ExpectedPatient }`.
- `src/graph/graph.ts:131-147` — the `intake_extractor` node: the inline call to rewire (`await deps.ingestion.attachAndExtract({ ...state.ask.upload, patientId: state.ask.patientId, correlationId: state.correlationId })`); `ClinicalGraphDeps.ingestion: IngestionService` (:61).
- `src/graph/contracts.ts:18-25` — `GraphUploadSchema` (`{ docType: z.enum(['lab_pdf','intake_form']); filename: z.string().min(1); mimeType: z.string().min(1); bytes: z.instanceof(Uint8Array).refine(byteLength > 0) }` `.strict()`) — REUSE it for the tool's input schema (compose, don't duplicate); `GraphContractError(boundary, issues)` (:8-16) is the loud-failure error type (its `boundary` union gains a member — see step 2).
- `src/chat/tools/types.ts:31-38` — `RegisteredTool` (`{ name; description; inputJsonSchema; invoke(bundle, rawInput): ToolInvocation }`) — the SYNC read-only surface you must NOT extend; note its contract difference: chat tools never throw, this graph tool MUST throw (an ingestion failure has to stay loud in the graph, not degrade into a model-readable `{error}`).
- `src/chat/tools/index.ts:25-34` — `ALL_CHAT_TOOLS` — the list this tool must NOT join (pin it with a test).
- `docs/w2/requirements.md` S1/R1 status note — spec's `file_path` parameter maps to `{filename, mimeType, bytes}` in this codebase (uploads arrive as bytes over multipart; a server-side path read would be a security hole). Preserve the NAME `attach_and_extract`; document the parameter mapping in the tool description.

## Files to create/modify

- **Create** `sidecar/src/graph/tools.ts` — the async graph-tool contract + the `attach_and_extract` tool object.
- **Modify** `sidecar/src/graph/graph.ts` — `intake_extractor` node invokes the tool instead of calling the service inline.
- **Modify** `sidecar/src/graph/contracts.ts` — `GraphContractError.boundary` union gains `'graph_tool'` (or reuse `'graph_entry'` if you prefer no union change — pick one, name it in the PR).
- **Create/modify tests** — `sidecar/test/graph.test.ts` (+ a small new `describe` for the tool itself; a separate `test/graph-tools.test.ts` is also fine).
- Trackers: `docs/w2/requirements.md`, `docs/internal/build-status.html`, `W2_ARCHITECTURE.md` §3 header.

## Step-by-step implementation

1. **Contract** (`src/graph/tools.ts`): an async, side-effectful tool surface distinct from `RegisteredTool` — real signatures, sketch:

   ```ts
   import { z } from 'zod';
   import { GraphContractError, GraphUploadSchema } from './contracts.js';
   import type { IngestionRecord, IngestionService } from '../ingest/service.js';

   export interface GraphToolContext { correlationId: string; }

   /** Async, write-capable graph tool: named + schema'd like chat tools, but it
    *  THROWS on failure (graph nodes need loud failures, not model-readable errors)
    *  and is never registered on the sync read-only chat surface. */
   export interface AsyncGraphTool<TInput, TOutput> {
       readonly name: string;
       readonly description: string;
       readonly inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>;
       /** JSON Schema mirror for advertising the tool to a model (future supervisor use). */
       readonly inputJsonSchema: Record<string, unknown>;
       run(rawInput: unknown, ctx: GraphToolContext): Promise<TOutput>;
   }

   export const AttachAndExtractInputSchema = z
       .object({ patient_id: z.string().min(1), upload: GraphUploadSchema })
       .strict();
   export type AttachAndExtractToolInput = z.infer<typeof AttachAndExtractInputSchema>;

   export function attachAndExtractTool(
       service: IngestionService,
   ): AsyncGraphTool<AttachAndExtractToolInput, IngestionRecord> { /* parse → delegate */ }
   ```

   `run` parses via `AttachAndExtractInputSchema.safeParse`; on failure throw
   `GraphContractError('graph_tool', issues)` naming the tool; on success
   delegate: `service.attachAndExtract({ patientId: input.patient_id, ...input.upload, correlationId: ctx.correlationId })`.
   The `description` states the spec mapping: *"the spec's
   attach_and_extract(patient_id, file_path, doc_type); file content arrives as
   {filename, mimeType, bytes}"*. Name literal: `'attach_and_extract'`.
2. **Rewire the node** (`graph.ts`): in `buildClinicalGraph`, construct the tool once (`const attachAndExtract = attachAndExtractTool(deps.ingestion);`) above the `StateGraph` builder; the `intake_extractor` node body becomes `const record = await attachAndExtract.run({ patient_id: state.ask.patientId, upload: state.ask.upload }, { correlationId: state.correlationId });` (keep the `state.ask.upload === undefined` guard throwing first, unchanged). Include the tool name in the handoff reason so the trace shows the tool by name, e.g. `` `attach_and_extract: extraction ${record.status}; pin protocol evidence for extracted findings` `` — check `docs/w2/trace-example.md` and eval assertions before rewording further (they grep handoff reasons; `eval/graph-path.eval.ts` and `test/graph.test.ts` pin behavior, not exact reason strings — verify, and prefer appending over rewriting if anything matches on the old text).
3. **Keep `ClinicalGraphDeps` unchanged** (`ingestion: IngestionService` stays the dep; the tool is an internal wrapper) — callers (`server.ts:528`, tests, `w2-baselines.ts`, phi sweep) need zero changes.
4. **Tests** (below), then trackers, ship.

## What NOT to do

- Do NOT add `attach_and_extract` to `ALL_CHAT_TOOLS` or anything under `src/chat/tools/` — the sync list is read-only-by-construction; pin this with a test.
- Do NOT give the tool the chat tools' never-throw semantics — a failed ingestion must fail the graph run loudly (the `IngestionRecord`'s own `failed_*` statuses still flow through as data when the service resolves; only contract violations and service throws propagate).
- Do NOT bypass or weaken `parseGraphAsk` — the entry contract still runs first; the tool's parse is the tool-boundary contract, not a replacement.
- Do NOT change `IngestionService.attachAndExtract`'s signature — the tool adapts to it, not vice versa.
- Do NOT wire the tool into the model's tool_use loop this ticket — advertising it to the supervisor model is future work; the deliverable is the discrete tool object + graph rewiring (the register box's wording).

## Acceptance checks

```bash
cd sidecar && npx vitest run test/graph.test.ts   # existing upload-path cases still green (behavior unchanged)
cd sidecar && npm test && npm run typecheck
grep -rn "attach_and_extract" sidecar/src/chat/   # exactly one expected hit-count: 0
grep -n "attachAndExtractTool" sidecar/src/graph/graph.ts   # node uses the tool
```

## Tests to add

- New `describe('attach_and_extract graph tool (H.9)')` (in `test/graph.test.ts` or `test/graph-tools.test.ts`):
  - `it('parses input at the boundary — a malformed payload throws GraphContractError naming the tool, never reaching the service')` — `run({ patient_id: '', upload: {...} })` and `run({ patient_id: 'p', upload: { ...bytes: new Uint8Array(0) } })` reject; a spy service records zero calls.
  - `it('delegates valid input to IngestionService.attachAndExtract with the graph correlation id')` — spy service returns a stub record; assert the exact `AttachAndExtractInput` passed (patientId/docType/filename/mimeType/bytes/correlationId).
  - `it('is not registered on the sync read-only chat tool list')` — `expect(ALL_CHAT_TOOLS.map((t) => t.name)).not.toContain('attach_and_extract')`.
- Existing graph upload-path tests (`document uploads run extraction then PIN evidence then critic (Tier 2)` etc.) must pass unmodified — they are the no-behavior-change proof.

## Tracker updates

- `docs/w2/requirements.md` — under **S1/R1** (~:64), flip to `[x]` (verbatim lines):

  ```
  - [ ] Equivalent chat/graph tool `attach_and_extract(patient_id, file_path,
    doc_type)` wraps the same service path (name preserved from spec).
  ```

  Append annotation: `*(H.9: async graph-tool object src/graph/tools.ts wrapping IngestionService.attachAndExtract; intake_extractor invokes it by name; deliberately NOT on the sync read-only chat tool list; file_path ≙ {filename, mimeType, bytes} — uploads are multipart bytes by design.)*`
- `docs/internal/build-status.html` DATA block: ticket `H.9` (L452) `s: "pending"` → `"done"`; reqGroups: `S1/R1` row `done: 5, total: 7` → `done: 6` (the remaining open box is the persistence split, H.13's territory).
- `W2_ARCHITECTURE.md` — §3 header: move `chat tool wrapper` out of the TARGET list → shipped wording, e.g. `… evidence pinning at prep time (C.6), attach_and_extract graph tool (H.9) · TARGET: live EHR write + vitals row (deploy), brief refresh]`.

## Verify + ship ritual

```bash
cd sidecar && npm test && npm run typecheck && npm run eval && npm run build
```

Panel untouched — skip the panel leg. Then: conventional commit with
`--trailer "Assisted-by: Claude Code"` (trackers in the SAME commit) →
`git push -u origin claude/merged-eval-course-plan-ky6ulh` → update PR #16
body (checklist line for H.9) → SendUserFile
`docs/internal/build-status.html` (rendered inline).
