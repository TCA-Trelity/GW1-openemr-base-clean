# H.16 — Tier-0: the chat evidence path reads pinned evidence before live retrieval

REQ: S3/R4 (evidence-pinning box) · Depends on: — (touches the same graph node H.9 rewires — rebase over whichever lands first) · Band: merged-plan Track 1 · Priority: P2 (per merged-plan.md)

## Why

C.6 shipped ingestion-time pinning: extraction-driven retrievals persist their
chunks per patient (`src/graph/pins.ts`), so an in-visit guideline ask can be a
Tier-0 lookup. But the read side was never built — the register box's own
annotation says it: *"Remaining: chat bundle consumes pins as the Tier-0 read
path."* Verified harder: `PinnedEvidenceStore.listFor` has **zero production
callers**, and — a gap the merged plan under-stated — the production upload
route calls `IngestionService.attachAndExtract` directly (`routes/ingest.ts:116`),
never the graph, so in the deployed app **nothing writes pins either** (only
tests/evals/baselines run `document_upload` asks). This ticket ships both
halves cheaply: pins get written on the real upload path (no LLM involved),
and `needs_evidence` chat turns read them before paying a live search. Real
latency win, not paperwork.

## Existing seams you MUST reuse

- `src/graph/pins.ts` — `PinnedEvidence { patient_id; ingestion_id; pinned_at; snippets: EvidenceSnippet[] }`; `PinnedEvidenceStore { save(pin): Promise<void>; listFor(patientId): Promise<PinnedEvidence[]> }` (newest first); `MemoryPinnedEvidenceStore` (replace-on-same-ingestion behavior).
- `src/graph/graph.ts:148-212` — the `evidence_retriever` node: the pin WRITE leg to extract into a helper (:184-200 — `deps.pins.save({...})` + the `evidence_pinned` info event `{correlation_id, patient_id, ingestion_id, pinned}`), and the place the Tier-0 READ goes (before the budget race at :158); `conceptsFromIngestion(record)` (:256, exported); `handoff(state, from, to, reason)` (:105-112).
- `src/routes/chat.ts:207-214` — the needs_evidence lane invoking `runClinicalGraph`; the `status` event text at :208 (`'checking practice protocols…'`) if you differentiate the Tier-0 status.
- `src/routes/ingest.ts:117-119` — the fire-and-forget `deps.service.attachAndExtract(input).catch(...)` block — the production write-side hook point; `IngestRouteDeps` (:17-25) — where the optional pinning deps land.
- `src/server.ts:553-563` — the chat graph deps: `pins: new MemoryPinnedEvidenceStore()` (:559) is a private instance — HOIST it so the upload route and the chat graph share ONE store; `deps.ingest` and `evidence.retriever` are both in scope in that boot block (~:505-565; lines drifted when H.3/H.5 landed — re-grep `MemoryPinnedEvidenceStore` if they move again).
- `src/retrieval/bm25.ts:19` — `export function tokenize(text: string): string[]` and `src/retrieval/retriever.ts:80-87` — `COVERAGE_STOPWORDS` (module-private today — export it) + the coverage-floor idiom at :181-190 (content terms ≥3 chars, best-candidate coverage ≥ 0.5) — reuse for pin relevance; do not invent a second relevance vocabulary.
- `src/graph/contracts.ts:parseEvidencePayload` — pinned snippets re-parse through the same worker-output contract before composing (stored data is still a boundary).
- `test/graph.test.ts:makeDeps(invent, pins?)` (:70-93) + the existing case `extraction-driven retrieval pins chunks per patient, keyed to the ingestion; chat turns never pin` (:255) — the write-side behavior that must KEEP passing.
- `W2_ARCHITECTURE.md` §10 storage matrix row (:396): pins are deliberately ephemeral/in-process — sharing one instance does not change that posture.
- Latency-note seam: `src/scripts/w2-baselines.ts` graph leg (:136-157) + `docs/execution/baselines.md` §Week 2.

## Files to create/modify

- **Modify** `sidecar/src/graph/pins.ts` — add the shared helper `pinEvidenceForIngestion(...)` (write leg) and `selectPinnedEvidence(...)` (read-relevance leg) so graph node and route share ONE implementation.
- **Modify** `sidecar/src/graph/graph.ts` — evidence_retriever: Tier-0 read first for chat turns; write leg delegates to the helper.
- **Modify** `sidecar/src/retrieval/retriever.ts` — `export` `COVERAGE_STOPWORDS` (one-word change).
- **Modify** `sidecar/src/routes/ingest.ts` — optional pinning deps + post-extraction pin call in the fire-and-forget block.
- **Modify** `sidecar/src/server.ts` — hoist one shared `MemoryPinnedEvidenceStore`; pass to both the ingest route deps and the chat graph deps.
- **Modify** `sidecar/src/scripts/w2-baselines.ts` + `docs/execution/baselines.md` — the Tier-0 latency note.
- **Modify tests**: `sidecar/test/graph.test.ts`, `sidecar/test/ingest-routes.test.ts`.
- Trackers: `docs/w2/requirements.md`, `docs/internal/build-status.html`, `W2_ARCHITECTURE.md` §4.

## Step-by-step implementation

1. **Helpers** (`pins.ts`), signatures to implement:

   ```ts
   /** Write leg (shared by the graph node and the upload route): retrieve for the
    *  ingestion's concepts and pin the chunks against the patient. Never throws —
    *  pinning is an optimization; failures warn and return 0. */
   export async function pinEvidenceForIngestion(
       deps: { retriever: HybridRetriever; pins: PinnedEvidenceStore; logger?: GraphLogger; now?: () => string },
       record: IngestionRecord,
       extraConcepts: readonly string[],
       correlationId: string,
   ): Promise<number>;

   /** Read leg: newest-first pins whose snippets clear the same coverage floor the
    *  retriever uses (content terms ≥3 chars minus COVERAGE_STOPWORDS; best snippet
    *  coverage ≥ 0.5). Returns the winning pin or null — null means live retrieval. */
   export function selectPinnedEvidence(pins: readonly PinnedEvidence[], question: string): PinnedEvidence | null;
   ```

   `pinEvidenceForIngestion` body = the current graph write leg moved: concepts
   = `[...extraConcepts, ...conceptsFromIngestion(record)]`, `retriever.search(concepts.join(' '), { correlationId, topK: 4, context: { concepts } })`,
   save + emit `evidence_pinned` (same event shape — the PHI sweep already
   captures this path; keep ids/counts only). Import types from graph/retriever
   modules; if an import cycle appears (graph.ts ↔ pins.ts via `conceptsFromIngestion`),
   move `conceptsFromIngestion` into pins.ts and re-export from graph.ts — callers unchanged.
2. **Graph node read** (`graph.ts` evidence_retriever, before the budget race): for `state.ask.kind === 'chat_turn'` with `deps.pins` present and a question: `const pin = selectPinnedEvidence(await deps.pins.listFor(state.ask.patientId), query)`; on hit → `evidence: parseEvidencePayload(pin.snippets)`, info event `evidence_tier0 {correlation_id, patient_id, ingestion_id, pinned: n}`, handoff reason `` `tier0: ${n} pinned chunk(s) from ingestion ${pin.ingestion_id}` `` → straight to critic, skipping live retrieval AND the budget timer (that is the win). On miss → existing live path untouched. The `needs_extraction` flow must NOT read pins (its job is to write them — keep the existing route-check).
3. **Graph node write** delegates to `pinEvidenceForIngestion` (same conditions as today: pins present, route `needs_extraction`, ingestion non-null, snippets non-empty — the non-empty check moves inside naturally since the helper searches itself; preserve the observable behavior the existing test pins: pins saved keyed to the ingestion, chat turns never pin).
4. **Production write path** (`routes/ingest.ts`): `IngestRouteDeps` gains `pinning?: { retriever: HybridRetriever; pins: PinnedEvidenceStore }`; in the fire-and-forget block chain: `deps.service.attachAndExtract(input).then(async (record) => { if (record.status === 'complete' && deps.pinning !== undefined) { await pinEvidenceForIngestion({ ...deps.pinning, logger: request.log-shaped wrapper }, record, [], request.id as string); } }).catch(existing warn)`. No LLM call, ~one retrieval per completed upload. 202 semantics unchanged.
5. **Shared store** (`server.ts` boot block): `const sharedPins = new MemoryPinnedEvidenceStore();` where `evidence` resolves; pass into `deps.ingest.pinning = { retriever: evidence.retriever, pins: sharedPins }` (shape per step 4 — note `deps.ingest` is built in `buildDeps` before the retriever exists, so attach the pinning field in the boot block like `deps.chat.evidenceGraph` is) and use `pins: sharedPins` at :531. Keyless/corpus-absent deploys simply never set `pinning` — pins off, everything degrades to today's behavior.
6. **Latency note**: in `w2-baselines.ts`, add a Tier-0 variant of the graph leg — pre-populate a pin for the bench patient (run one `document_upload` graph ask first, or call the helper), then time the same needs_evidence question; report beside the live-retrieval number (`graph evidence turn — tier0 pins`). Record both in `baselines.md` §Week 2 with one sentence naming what Tier-0 removes (the retrieval leg + budget window) — offline numbers are small; the honest claim is the *live* delta (rerank round-trips) which lands post-keys, say so.
7. Tests, trackers, ship.

## What NOT to do

- Do NOT serve pins for every needs_evidence turn unconditionally — an off-topic pin composing an "evidence-backed" answer is a quality/safety regression; the coverage floor (reused from the retriever) is the guard, and the fallback is the live search.
- Do NOT run the full graph (composer LLM call) on the upload route to get pins written — `pinEvidenceForIngestion` exists precisely so the route pays one retrieval, zero LLM calls.
- Do NOT persist pins to Postgres — §10 declares them an ephemeral in-process freshness hint; keep that posture (re-pinned on next ingestion after restart).
- Do NOT let pinning failures fail an upload or a turn — the helper never throws (warn + 0).
- Do NOT duplicate the pin/relevance logic between route and graph — one helper, two callers (the point of step 1).
- Do NOT log question text or snippet text in the new `evidence_tier0` event — ids and counts only (G18/P5; the PHI sweep captures graph logs).

## Acceptance checks

```bash
cd sidecar && npx vitest run test/graph.test.ts test/ingest-routes.test.ts
cd sidecar && npm test && npm run typecheck && npm run eval    # incl. phi-log-sweep over the new event
grep -n "listFor" sidecar/src --include=*.ts -r               # now has production callers (pins.ts helper/graph)
cd sidecar && npm run baseline:w2                              # prints the tier0 graph row
```

## Tests to add

- `test/graph.test.ts`:
  - `it('a chat turn with a relevant pin answers Tier-0 — live retrieval is never invoked and the handoff names the ingestion')` — makeDeps with a pins store pre-seeded via one upload run (deterministic snippets); wrap `deps.retriever.search` with a spy for the chat turn; assert spy not called, answer cites the pinned chunk, handoff reason starts `tier0:`, `evidence_tier0` logged.
  - `it('an off-topic question falls through pins to live retrieval — the coverage floor rejects irrelevant pins')` — seeded pin + out-of-domain question → search called, behavior identical to today.
  - Existing `extraction-driven retrieval pins chunks per patient…` case keeps passing (write-leg refactor is behavior-preserving).
- `test/ingest-routes.test.ts`:
  - `it('a completed upload pins evidence against the patient through the shared store — the production Tier-0 write path')` — inject `pinning: { retriever, pins }` (offline retriever from the test corpus helpers); after the 202 + pipeline settles, `pins.listFor(patient)` holds a pin keyed to the ingestion id; and a case where `pinning` is absent → no pins, no errors.
- `selectPinnedEvidence` unit cases (same file as the graph tests or a small new describe): newest-first tie-break, coverage floor boundary, empty-pins → null.

## Tracker updates

- `docs/w2/requirements.md` — under **S3/R4** (~:247), flip to `[x]` (verbatim lines):

  ```
  - [ ] Ingestion-time evidence pinning: extraction findings trigger
    evidence-retriever during prep (e.g. HCQ in meds → screening protocol
    retrieved and pinned to the fact bundle), so most in-visit guideline asks
    resolve without live retrieval (latency Tier 0). *(Shipped: prep-time
    retrieval + per-patient pin store keyed to the ingestion id, replace-on-
    re-ingest. Remaining: chat bundle consumes pins as the Tier-0 read path.)*
  ```

  Replace the annotation with: `*(Complete H.16: needs_evidence turns read pins first (coverage-floor guarded, live-retrieval fallback); production uploads pin via the shared store on the route path (one retrieval, no LLM); evidence_tier0 event + tier0 handoff make the lane visible per correlation id.)*`
- `docs/internal/build-status.html` DATA block: ticket `H.16` (L459) `s: "pending"` → `"done"`; reqGroups: `S3/R4` row `done` +1 (→ `s: "done"` if H.7/H.15 flipped the other two boxes first — mirror the register's remaining count).
- `W2_ARCHITECTURE.md` — §4 header: append to the SHIPPED clause `Tier-0 pinned-evidence read path + route-side pinning (H.16)`; §10 storage-matrix pins row: wording stays valid (ephemeral, in-process) — touch only if you changed lifecycle (you should not have).

## Verify + ship ritual

```bash
cd sidecar && npm test && npm run typecheck && npm run eval && npm run build
```

Panel untouched — skip the panel leg. Then: conventional commit with
`--trailer "Assisted-by: Claude Code"` (trackers in the SAME commit) →
`git push -u origin claude/merged-eval-course-plan-ky6ulh` → update PR #16
body (checklist line for H.16) → SendUserFile
`docs/internal/build-status.html` (rendered inline).
