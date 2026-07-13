# F.1 — W2 baselines: ingestion / retrieval / graph p50-p95, W1 regression check

REQ: G11, S3/R4 (router-latency remainder) · Depends on: Wave E landed (measure what ships) · Band: 3

## Why

G11: record real latency profiles for the W2 flows and compare against Week 1
(p95 **46 ms @10 / 193 ms @50** on the read path) to prove shared paths did
not regress. The SLO table in §9 currently states targets with no measured
column — a decisive defense needs numbers, honestly labeled by backend (stub
VLM / offline retrieval now; live numbers after the user's key drop).

## Existing seams you MUST reuse

- `src/scripts/load-test.ts` — the measurement ethos and output format to copy ("this script measures; it never asserts a fabricated number"). Env: `LOAD_BASE_URL` (required), `LOAD_CONCURRENCY` (10), `LOAD_DURATION_SEC` (20), `LOAD_P95_MAX_MS` (1500), `LOAD_PATIENT` (margaret-chen), `LOAD_BEARER` (enforced-auth deploys). Run: `npm run load-test`. Probes `/api/patients` + `/api/overview/:patient` only.
- `docs/execution/baselines.md` — the W1 doc to EXTEND (never rewrite): table format `| Concurrency | Requests (20 s) | Throughput | Error rate | p50 | p95 | p99 | max | p95 SLO (…) |`, a findings section, and a `## Reproducing` section naming the command.
- In-process components + their offline stubs (identical to the test suite, so measured code = shipped code): `IngestionService` + `VlmExtractor` over a scripted `AnthropicCompletion` (copy `stubVlm()` from `test/ingest-routes.test.ts:29-40`), `HybridRetriever.build(loadCorpusChunks(corpusDir), { embeddings: new HashEmbeddings(), reranker: new PassthroughReranker() })`, `runClinicalGraph(deps, ask, correlationId)` with the stub composer from `test/graph.test.ts:34-68` (`makeDeps` at :70-93 is the assembly to copy).
- Fixture: `eval/fixtures/documents/renal-panel-clean.pdf` (plus `renal-panel-lowdpi.pdf` for a degraded-doc data point).
- `W2_ARCHITECTURE.md` §9 SLO table — the five rows to fill with measured numbers: ingestion ≤90 s/doc; retrieval ≤2.5 s incl. rerank; evidence turn ≤5 s; fast-path first token <2 s + ≤0.4 s router; W1 read path 46/193 ms floor.

## Files to create/modify

- **Create** `sidecar/src/scripts/w2-baselines.ts` — in-process benchmark runner.
- **Modify** `sidecar/package.json` — script `"baseline:w2": "tsx src/scripts/w2-baselines.ts"`.
- **Modify** `docs/execution/baselines.md` — new `## Week 2 flows (2026-07-…)` section + refreshed W1 regression row.
- **Modify** `W2_ARCHITECTURE.md` — §9 table gains a "Measured (stub backends)" column; header `[TARGET]` → mixed marker.

## Step-by-step implementation

1. **Runner** (`w2-baselines.ts`), same header discipline as load-test.ts
   (comment: measures, never fabricates; names its backends in the output).
   Measure three flows with `performance.now()`, reporting p50/p95/p99/max
   and the run count:
   - **Ingestion** (default 25 runs): fresh `IngestionService` per run
     (deterministic dedupe would short-circuit re-runs of identical bytes —
     that would measure the cache, not the pipeline; note this in a comment),
     `attachAndExtract` over `renal-panel-clean.pdf` with the scripted VLM.
     Report clean + lowdpi variants.
   - **Retrieval** (default 200 runs): one `HybridRetriever.build` (report
     build time once, separately — it is boot cost), then `search()` over a
     rotating set of ~6 corpus-shaped queries (HCQ screening, DR follow-up,
     AMD treat-and-extend, RVO, out-of-corpus control…).
   - **Full graph** (default 50 runs): `runClinicalGraph` with a
     `needs_evidence` chat ask (stub composer); plus 50 `routeAsk` rules-path
     decisions timed on their own (the router-latency figure).
   Env knobs mirroring load-test style: `W2_BASE_RUNS`, `W2_BASE_FIXTURE`.
   Output: a ready-to-paste Markdown table + a JSON line. Exit non-zero only
   on errors — SLO judgment lands in the doc, not the script (stub numbers
   passing a 90 s SLO proves nothing; do not gate).
2. **W1 regression check**: run the EXISTING harness against a locally
   booted sidecar (`LOAD_BASE_URL=http://localhost:8080 LOAD_CONCURRENCY=10 npm run load-test`, then `LOAD_CONCURRENCY=50`) and record beside the
   2026-07-10 numbers. The comparison claim: shared read path within noise of
   46/193 ms. If it regressed >20%, STOP and investigate before shipping the
   doc (that is the whole point of the floor).
3. **baselines.md**: append a Week 2 section — the three flow tables, the
   backend legend, and an SLO verdict table with three honesty rows:
   - ingestion ≤90 s/doc p95: **trivially met with the stub VLM** (measured
     n ms); *live-VLM numbers await the Anthropic key on the measuring
     machine* — say exactly that.
   - retrieval ≤2.5 s: passthrough-rerank numbers now; *Cohere-rerank numbers
     after the key drop* (USER-ACTIONS.md), expected +1 network round trip.
   - router ~200–400 ms: rules path measured now (µs-scale); the
     `LlmRouterModel` tie-break is a live Haiku call — *measure after keys*,
     until then the 200–400 ms figure stays a stated target.
   Update `## Reproducing` with both commands.
4. **§9 table**: add the measured column with the same three-way honesty
   labels; keep targets untouched.
5. Trackers, ship.

## What NOT to do

- Do NOT fabricate, extrapolate, or average-away numbers — every figure in
  the docs traces to a command someone can re-run (load-test.ts ethos).
- Do NOT present stub-backend numbers as production SLO compliance — label
  every table with its backends.
- Do NOT make `baseline:w2` a CI job or PR gate — it is a dev-machine
  profiling tool (CI variance would make it noise).
- Do NOT touch `eval/baseline.json` — "baseline" here is latency, not the
  eval gate; the two must never blur.
- Do NOT rewrite the Week 1 sections of baselines.md — append.

## Acceptance checks

```bash
cd sidecar && npm run baseline:w2        # prints three p50/p95 tables + backends legend
LOAD_BASE_URL=http://localhost:8080 npm run load-test    # W1 path re-measured, 0% errors
git diff docs/execution/baselines.md W2_ARCHITECTURE.md  # numbers + honesty labels present
```

## Tests to add

None (a measurement script, not product code). Keep `npm run typecheck`
covering it (it lives under `src/`, so `tsc -p tsconfig.json` already does).

## Tracker updates

- `docs/w2/requirements.md` — under **G11** flip: `- [ ] Baselines recorded for W2 flows (ingestion, extraction, retrieval, full graph run) — latency p50/p95, CPU/memory where obtainable, throughput — and compared against Week 1 baselines (p95 46 ms @10 / 193 ms @50)…` → `- [x]`. Under **S3/R4**: the supervisor-as-entry box's remaining item is "measured ~200–400 ms baseline" — flip it if the rules-path measurement + stated-target treatment of the model path satisfies the register wording; otherwise annotate "(model-path measurement awaits keys — F.6/live run)". Under **G2**, the SLO box `- [x] SLOs stated (locked)…` gains "measured against baselines (G11)" truth — verify its annotation.
- `docs/w2/build-status.html` — DATA (starts L189): `{ id: "F.1", … s: "pending" }` → `s: "done"`; bump G11 reqGroup; refresh the `slos` DATA array (L342, mirrors §9) with the measured labels.
- `W2_ARCHITECTURE.md` — §9 header `— [TARGET]` → `[SHIPPED: measured stub-backend baselines + W1 regression check · TARGET: live-backend numbers post key-drop]`.

## Verify + ship ritual

```bash
cd sidecar && npm test && npm run typecheck && npm run eval && npm run build
```

Panel untouched — skip the panel leg. Then: conventional commit with
`--trailer "Assisted-by: Claude Code"` (trackers in the SAME commit) →
`git push -u origin claude/openemr-rag-requirements-x25vzm` → update PR #9
body → SendUserFile `docs/w2/build-status.html`.
