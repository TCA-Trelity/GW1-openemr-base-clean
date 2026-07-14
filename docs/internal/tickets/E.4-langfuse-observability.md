# E.4 — Observability build-out: graph spans in Langfuse, ops tiles, alerts A4–A6

REQ: R7, G6, G13, G15 · Depends on: C.5 (handoff events — shipped), 0.3 (Langfuse keys — user action) · Band: 2

## Why

R7 requires each encounter to be reconstructable as a trace hierarchy (G13),
G6 requires dashboard tiles that "tell a grader whether the system is healthy
without reading logs", and G15 requires alerts A4–A6 with response actions.
The graph already emits everything needed (`worker_handoff`, `evidence_pinned`,
`evidence_degraded`, `critic_flags` — worked example in
`docs/w2/trace-example.md`); this ticket is an **adapter over the existing
event stream, not new instrumentation**. For Dan's demo it is the Langfuse
screen in shot 7 of the video.

## Existing seams you MUST reuse

- `src/graph/graph.ts:GraphLogger` — `{ info(obj: Record<string, unknown>, msg: string): void; warn(obj: Record<string, unknown>, msg: string): void }`; injected as `ClinicalGraphDeps.logger?`. Events emitted: `'worker_handoff'` (info; obj has `correlation_id, patient_id, from, to, routing_reason`), `'evidence_pinned'` (info; `correlation_id, patient_id, ingestion_id, pinned`), `'evidence_degraded'` (warn; `correlation_id, budget_ms`), `'critic_flags'` (warn; `correlation_id, blocked, prescriptive_flags`).
- `src/obs/langfuse.ts:LangfuseLike` — `trace(body: {id?, name?, metadata?, tags?}): LangfuseTraceLike`; `flushAsync(): Promise<unknown>`.
- `src/obs/langfuse.ts:LangfuseTraceLike` — `span(body: {name, startTime?, endTime?, metadata?, level?, statusMessage?})`, `update(body)`, `score(body)`.
- `src/obs/langfuse.ts:LangfuseTracer.startTrace` (:85) — the pattern to copy: trace id = correlation id ("the joining key across logs, prep_runs, llm_calls, and traces"), and the `guarded()` wrapper (:98) — **observability may NEVER fail a run**.
- `src/server.ts:130-143` — Langfuse constructed only when `LANGFUSE_HOST + LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY` are all present (`new Langfuse({ baseUrl, publicKey, secretKey, requestTimeout: 10_000 })`); copy the same guard.
- `docs/w2/trace-example.md` — the committed span skeleton (handoff chain = span sequence); cite it in code comments rather than inventing a new hierarchy.
- `docs/execution/observability.md:41-45` — alert table format `| # | Alert | Condition | On-call response |` (A1–A3); A4–A6 must match it.
- `docs/execution/ops-status.html` — stat-tile markup: `.statgrid` div at L173–194, each tile `<div class="stat"><div class="k">LABEL</div><div class="v">VALUE</div><div class="u">caption</div></div>`; panels follow the `<div class="panel">` pattern from L197.
- `test/obs.test.ts` — `describe('LangfuseTracer')` with a fake `LangfuseLike`; mirror its style (incl. the "never throws when the SDK throws at every call site" case).

## Files to create/modify

- **Create** `sidecar/src/obs/graphTracer.ts` — the adapter (below).
- **Modify** `sidecar/src/server.ts` — where graph deps are assembled (E.9 wires `ChatRouteDeps` graph deps; this ticket wraps the logger passed there). If E.9 has not landed yet, export the factory and wire it in the ingest path's graph logger instead — whichever graph entry exists when this executes.
- **Modify** `docs/execution/observability.md` — append A4–A6 rows to the alerts table; update `## Status`.
- **Modify** `docs/execution/ops-status.html` — add W2 stat tiles (see step 5). This edit is allowed here because the ops page is this ticket's deliverable (G6).
- **Modify** `sidecar/test/obs.test.ts` — new `describe('graph tracer')`.

## Step-by-step implementation

1. **Adapter** — a decorator over `GraphLogger`, consuming events by `msg` name:

```ts
// src/obs/graphTracer.ts
import type { GraphLogger } from '../graph/graph.js';
import type { LangfuseLike, LangfuseTraceLike } from './langfuse.js';

interface WarnLogger { warn(obj: Record<string, unknown>, msg: string): void; }

/** Decorates a GraphLogger: every event still reaches `inner` unchanged; graph events
 *  additionally become Langfuse spans on a correlation-scoped trace. Guarded throughout —
 *  a Langfuse failure logs one warning and the run proceeds (same rule as LangfuseTracer). */
export function tracingGraphLogger(
    inner: GraphLogger | undefined,
    client: LangfuseLike,
    log: WarnLogger,
): GraphLogger
```

   Internals: a `Map<string, LangfuseTraceLike>` keyed by `correlation_id`
   (bounded FIFO, cap ~64 — copy the eviction idiom from
   `MemoryUploadFileStore` in `src/routes/ingest.ts:36-56`). First event for a
   correlation id → `client.trace({ id: correlationId, name: 'graph', tags: ['graph'] })`.
   Then per event:
   - `worker_handoff` → `trace.span({ name: `${from}→${to}`, startTime: new Date(), metadata: { routing_reason } })` — from/to are node names; parent is the correlation-scoped trace (the committed skeleton in trace-example.md).
   - `evidence_pinned` → `trace.span({ name: 'evidence_pinned', metadata: { ingestion_id, pinned } })`.
   - `evidence_degraded` → `trace.span({ name: 'evidence_degraded', level: 'WARNING', metadata: { budget_ms } })`.
   - `critic_flags` → `trace.span({ name: 'critic_flags', level: 'WARNING', metadata: { blocked, prescriptive_flags } })`.
   Every SDK call sits inside a local `guarded(what, fn)` copied from `langfuse.ts:98-104`. `inner?.info/warn` is called FIRST, unconditionally — tracing must never eat the log line.
2. **Metadata discipline**: pass through ONLY the fields named above — ids and
   counts. Never `state.ask.question`, never snippet text (PHI rule G18/P5;
   `routing_reason` is safe — it is a rule label, never patient text).
3. **Wiring** (server.ts): next to the existing tracer construction (:130-143),
   when the Langfuse client exists, wrap the graph logger:
   `const graphLogger = langfuseClient !== undefined ? tracingGraphLogger(app.log-shaped inner, langfuseClient, console) : inner;`
   No keys → the plain inner logger — everything no-ops without keys (keys are
   a USER-ACTIONS.md item; do not block on them).
4. **Alerts** — append to `docs/execution/observability.md` alerts table, same
   four-column format as A1–A3:
   - `| A4 | **Extraction failure rate** | ingestion_failed / ingestion_started > 20% over 1 h | Check the VLM key/model first (ANTHROPIC_API_KEY, ANTHROPIC_MODEL_PREP); then read the \`ingestion_failed\` log events by correlation_id — a Zod-parse failure names the field, a timeout names the stage. Persisted state is safe: failures persist nothing (G3). |`
   - `| A5 | **RAG retrieval latency** | retrieval p95 > 2.5 s incl. rerank, sustained 10 min | Check Cohere status page. No action needed to keep serving: the PassthroughReranker fallback engages automatically (fusion order still serves) and \`/ready\` shows \`reranker\` degraded. Investigate before the next demo. |`
   - `| A6 | **Eval regression** | any category >5% below baseline or a safety-tier case flips (also fails the gate) | Read the category gate output (\`npm run eval\`) — it names the category and the newly-failing case ids; follow the triage procedure in \`docs/w2/gate-rehearsal.md\`. Never re-baseline to silence it. |`
5. **Ops tiles** — inside `.statgrid` (ops-status.html L173–194 pattern) add
   four W2 tiles reading **static committed metrics** (state this in the `u`
   caption — they are hand-updated from eval output until Langfuse deploys):
   ingestion count (eval fixture runs), extraction field pass rate (grounding
   confidence from `docs/execution/eval-results.md`), retrieval hit rate
   (retrieval category pass count), routing outcomes (rule vs model counts
   from the router tests). Caption e.g. `static until Langfuse deploy — source: eval-results.md`.
6. Tests, trackers, ship.

## What NOT to do

- Do NOT add instrumentation calls inside `graph.ts` nodes — the logger seam
  is the whole contract; new emit points belong to a different ticket.
- Do NOT let any tracer error propagate: every SDK touch is guarded; the
  "SDK throws at every call site" test is mandatory.
- Do NOT put question text, snippet text, or patient values in span metadata.
- Do NOT construct the Langfuse client when any of the three env vars is
  missing, and never make its absence a boot warning louder than one line.
- Do NOT convert ops-status.html to a JS-data page — it is inline-markup by
  design; follow the existing tile markup.

## Acceptance checks

```bash
cd sidecar && npm test && npm run typecheck   # green
# Keyless boot: no behavior change, no langfuse log lines beyond the existing ones.
# With keys (post key-drop): run one evidence ask → a 'graph' trace appears in
# Langfuse Cloud whose id equals the x-correlation-id response header, with
# supervisor→evidence_retriever→critic→answer spans (matches trace-example.md).
```

Tiles: open `docs/execution/ops-status.html` — four new W2 tiles render in the
stat grid. Alerts: `docs/execution/observability.md` shows A1–A6 in one table.

## Tests to add

`sidecar/test/obs.test.ts`, new `describe('tracingGraphLogger')`:

- `it('opens one trace per correlation id and maps worker_handoff to spans')` — fake `LangfuseLike` recording calls; two handoff events, same correlation id → one `trace()` call with `id = correlationId`, two `span()` calls named `supervisor→evidence_retriever` etc.
- `it('always forwards events to the inner logger, even when the SDK throws')` — SDK whose every method throws; inner logger still receives both info and warn calls; nothing propagates.
- `it('maps evidence_degraded and critic_flags to WARNING spans with counts only')` — asserts metadata keys are exactly the id/count fields (no free text beyond routing_reason).

## Tracker updates

- `docs/w2/requirements.md` — flip under **G15**: `- [ ] Three new alert definitions with thresholds + documented response actions…` → `- [x]`. Flip under **G6**: `- [ ] Dashboard (Langfuse + ops-status page) adds W2 tiles…` → `- [x]` (tiles committed; note "static until deploy" inline). Under **R7** and **G13**, flip only what is true: the spans-adapter + span assertions land here; "Langfuse activated"/"verified visually" complete after the key drop (USER-ACTIONS.md) — annotate rather than flip if keys are still absent.
- `docs/internal/build-status.html` — DATA block (starts L189): ticket `E.9`-adjacent entry `{ id: "E.4", … s: "pending" }` (L248 region) → `s: "done"`; bump reqGroups `G6`, `G15` done-counts (+1 each) and `R7` by the checkbox delta; the DATA `alerts` array (L350) entries A4–A6 change `status: "spec at E.4"` → `status: "committed"`.
- `W2_ARCHITECTURE.md` — §8 header `## 8. Observability & cost (REQ: R7, G4–G6, G13, G15) — [TARGET on top of SHIPPED spine]` → move tiles/alerts/graph-span adapter into a SHIPPED list, keep key-activation TARGET.

## Verify + ship ritual

```bash
cd sidecar && npm test && npm run typecheck && npm run eval && npm run build
```

Panel untouched — skip the panel leg. Then: conventional commit with
`--trailer "Assisted-by: Claude Code"` (trackers in the SAME commit) →
`git push -u origin claude/openemr-rag-requirements-x25vzm` → update PR #9
body → SendUserFile `docs/internal/build-status.html`.
