# H.7 — Span nesting: worker spans ⊂ supervisor span, asserted by test

REQ: G13, S3/R4 (tracing box), R7 · Depends on: E.4 (shipped — `src/obs/graphTracer.ts`); coordinate with H.8 on the ingestion-logger wiring (see step 5) · Band: merged-plan Track 1 · Priority: P1 (per merged-plan.md)

## Why

G13 requires worker invocations to be **child spans of the supervisor span**
(sub-calls children of their worker spans), and S3/R4's tracing box says the
same. The merged plan guessed this was "very likely already working" — **it is
not**: the shipped E.4 adapter emits every `worker_handoff` as a FLAT span
directly on the trace (`src/obs/graphTracer.ts:73-79`), so Langfuse renders
siblings, not a tree. USER-ACTIONS item 10 already anticipates this ("a
flat/sibling layout means H.7's code half has a bug to fix"). This ticket is
the code half: nest the spans and pin the tree shape with an automated test so
a regression can't hide behind "nobody eyeballed Langfuse this week." The
visual half stays a user action (USER-ACTIONS item 10).

## Existing seams you MUST reuse

- `src/obs/graphTracer.ts:tracingGraphLogger(inner: GraphLogger | undefined, client: LangfuseLike, log: WarnLogger): GraphLogger` — the adapter to rework; keep its guarantees: `guarded()` (observability never throws into a run), bounded trace map (`MAX_OPEN_TRACES = 64`), inner logger ALWAYS receives the event.
- `src/obs/langfuse.ts:LangfuseTraceLike` — `span(body: { name: string; startTime?: Date; endTime?: Date; metadata?: Record<string, unknown>; level?: 'DEBUG' | 'DEFAULT' | 'WARNING' | 'ERROR'; statusMessage?: string }): unknown` — the return type is `unknown` today; H.7 changes it to a child-capable `LangfuseSpanLike` (the real `langfuse` SDK's span client structurally satisfies it: it has `.span()` and `.end()`).
- `src/graph/graph.ts:GraphLogger` — `{ info(obj: Record<string, unknown>, msg: string): void; warn(...): void }`; the events the graph emits (do NOT add instrumentation points): `worker_handoff` `{correlation_id, patient_id, from, to, routing_reason}`, `evidence_pinned` `{…, ingestion_id, pinned}`, `evidence_degraded` `{…, budget_ms}` (warn), `critic_flags` `{…, blocked, prescriptive_flags}` (warn).
- `docs/w2/trace-example.md` — the committed span skeleton; Run 1's five verbatim log lines are the fixture your shape test should replay.
- `src/server.ts:560` — the single production wiring line: `logger: graphLangfuse === undefined ? graphLogBase : tracingGraphLogger(graphLogBase, graphLangfuse, console)`. (Line drifted from :532 when H.3/H.5 landed mid-planning — re-grep if it moves again.)
- `test/obs.test.ts` — existing `tracingGraphLogger (E.4)` describe block with a fake Langfuse client; extend its fakes (they currently return `number` from `span()` via `calls.push(...)` — they must now return a fake `LangfuseSpanLike`).
- `test/graph.test.ts:makeDeps(invent = false, pins?: PinnedEvidenceStore): Promise<{ deps: ClinicalGraphDeps; logs: string[] }>` (:70-93) — assembly to copy for the real-graph-run shape test; `runClinicalGraph(deps, ask, correlationId)` from `src/graph/graph.ts:274`.
- `docs/internal/tickets/USER-ACTIONS.md` item 10 — the human Langfuse eyeball this ticket's test complements; reference it, do not edit it out of existence.

## Files to create/modify

- **Modify** `sidecar/src/obs/langfuse.ts` — add `export interface LangfuseSpanLike { span(body: <same body type as trace.span>): LangfuseSpanLike; end?(body?: { endTime?: Date }): unknown; }`; change `LangfuseTraceLike.span(...)` return type `unknown` → `LangfuseSpanLike`. (`LangfuseTracer` ignores the return value — no behavior change there.)
- **Modify** `sidecar/src/obs/graphTracer.ts` — nest spans (see steps).
- **Modify** `sidecar/src/server.ts` — step 5 only (ingestion events into the same adapter), and only if H.8 hasn't already done it.
- **Modify** `sidecar/test/obs.test.ts` — child-capable fakes + shape tests.
- **Modify** `docs/w2/trace-example.md` — the "Where this goes next (E.4)" section: update to past tense, naming the shipped tree shape.
- Trackers: `docs/w2/requirements.md`, `docs/internal/build-status.html`, `W2_ARCHITECTURE.md` (§4 + §8 headers).

## Step-by-step implementation

1. **Interface** (`langfuse.ts`): add `LangfuseSpanLike` as above; `trace.span()` now returns it. Update the two fakes in `test/obs.test.ts` (the `LangfuseTracer` fake and the E.4 fake) to return a child-capable object — compile errors are the to-do list.
2. **Adapter state** (`graphTracer.ts`): replace `Map<string, LangfuseTraceLike>` with `Map<string, { trace: LangfuseTraceLike; supervisor?: LangfuseSpanLike; nodes: Map<string, LangfuseSpanLike> }>` (same FIFO eviction over the outer map).
3. **Mapping rules** (all inside the existing `guarded()`):
   - `worker_handoff` with `from === 'supervisor'`: open the `supervisor` span on the trace if absent (name `supervisor`, metadata `{ routing_reason }`), then open a span named `to` **as a child of the supervisor span** (`supervisor.span({...})`) and store it in `nodes` keyed by `to`.
   - `worker_handoff` with any other `from` (e.g. `intake_extractor→evidence_retriever`, `evidence_retriever→critic`, `critic→answer`): call `.end?.()` on `nodes.get(from)` if present, then open `to` as a child of the **supervisor** span (all graph nodes are workers ⊂ supervisor — the tree in trace-example.md), storing it in `nodes`. Metadata: `{ routing_reason }` only.
   - `evidence_pinned` / `evidence_degraded`: child of `nodes.get('evidence_retriever') ?? supervisor` (these are the retrieval sub-call events — G13's "sub-calls ⊂ worker"). Keep existing metadata + WARNING level for degraded.
   - `critic_flags`: child of `nodes.get('critic') ?? supervisor`, WARNING level.
   - `ingestion_*` and `extraction_field_outcome` events (they carry `correlation_id`): child of `nodes.get('intake_extractor') ?? supervisor` when a trace is open for that correlation id; **log-only when no trace exists** (route-path ingestions without a graph run must not open traces of their own — keep `traceFor` lazy-open only for the four graph event names, and look-up-only for ingestion events).
   - Unknown events: log-only (unchanged).
4. **PHI discipline unchanged**: metadata carries `routing_reason` (a rule label), ids, and counts — never question text, snippet text, or extracted values. Do not add new metadata keys beyond what the events already carry.
5. **Ingestion events reach the adapter** (production): in `src/server.ts` `buildDeps`, the `IngestionService` at :198 is constructed **without a logger** — its stage events are silent in production. H.8 owns fixing that (structured JSON console logger). Coordinate: `grep -n "logger" sidecar/src/server.ts` around the `new IngestionService(` — if H.8 already injected a logger there, additionally route the **graph-owned** service's events through the tracing logger by passing the same `tracingGraphLogger(...)` instance as that logger (the shapes are compatible: `IngestionServiceDeps.logger` is `{ info: (obj: unknown, msg: string) => void; warn: ... }`). If H.8 has not landed, wire `logger: graphLogBase`-style structured console logging yourself and note it in the PR so H.8 skips it.
6. **Tests** (see below), then trackers, then ship.

## What NOT to do

- Do NOT add instrumentation calls inside `src/graph/graph.ts` — the adapter consumes the existing event stream (E.4's design invariant, stated in its header).
- Do NOT let any tracer path throw — every emit stays inside `guarded()`; the "never throws when the SDK throws" test must keep passing.
- Do NOT change the trace id: it stays the correlation id (the joining key across logs/prep_runs/llm_calls/traces).
- Do NOT drop the "inner logger always receives the event" behavior — tracing must never eat a log line.
- Do NOT call live Langfuse from any test (standing rule 5 — injectable transport only).
- Do NOT mark USER-ACTIONS item 10 done or claim the visual half — that is the user's 2-minute eyeball after a live run posts a correlation id.

## Acceptance checks

```bash
cd sidecar && npx vitest run test/obs.test.ts    # new shape tests green
cd sidecar && npm test && npm run typecheck      # full suite + interface change compiles everywhere
```

Expected from the shape test run: the fake client records `supervisor` with
parent = trace, and `intake_extractor` / `evidence_retriever` / `critic` /
`answer` each with parent = `supervisor`; `evidence_pinned` with parent =
`evidence_retriever`. A flat layout (parent = trace for a worker) must fail.

## Tests to add (in `test/obs.test.ts`)

- Upgrade `fakeLangfuse()` so every `span()` returns a fake `LangfuseSpanLike` and records `{ name, parent }` (parent = `'trace'` or the parent span's name).
- `it('nests worker spans inside the supervisor span — the flat sibling layout is the G13 regression this guards')` — feed the five verbatim `worker_handoff`/`evidence_pinned` lines from trace-example.md Run 1 through the adapter; assert the tree above.
- `it('attaches evidence_pinned and evidence_degraded as children of the evidence_retriever span, critic_flags under critic')`.
- `it('a real graph run produces the nested tree and still delivers every line to the inner logger')` — copy `makeDeps` from `test/graph.test.ts:70-93`, wrap its logger with `tracingGraphLogger(innerLogger, fakeClient, silentWarn)`, `runClinicalGraph` a `document_upload` ask; assert tree shape + `logs` still contains every `worker_handoff` line + no span metadata value contains the question text or `'eGFR'`.
- Keep (and re-run) the existing `never throws` case against the new nested paths.

## Tracker updates

- `docs/w2/requirements.md` — under **S3/R4** (~:239), flip to `[x]` (verbatim lines):

  ```
  - [ ] Tracing: worker invocations are child spans of the supervisor span;
    extraction/retrieval sub-calls are children of their worker spans (G13).
    *(Span skeleton = the handoff events, documented in trace-example.md;
    Langfuse binding lands in E.4.)*
  ```

  Update its annotation to: `*(Nested tree shipped + shape-asserted (H.7); visual confirm = USER-ACTIONS item 10.)*`
- `docs/w2/requirements.md` — under **G13** (~:625), the box (verbatim lines):

  ```
  - [ ] Worker invocations are child spans of the supervisor span; extraction
    and retrieval sub-calls are children of their worker spans; verified
    visually in Langfuse (and LangSmith demo env) and by span-parent assertions
    in an integration test.
  ```

  Flip to `[x]` **with** an appended annotation: `*(Span-parent assertions shipped (H.7). Langfuse visual = USER-ACTIONS item 10 — a flat layout there reopens this box. LangSmith leg on hold with USER-ACTIONS item 4.)*` — the repo's precedent (R7's Langfuse box) flips with the remaining human step named.
- `docs/internal/build-status.html` DATA block: ticket `H.7` (L450) `s: "pending"` → `"done"`; reqGroups: `S3/R4` row `done: 4` → `5`; `G13` row `done: 0, total: 1, s: "pending"` → `done: 1, s: "done"`.
- `W2_ARCHITECTURE.md` — §4 header: remove `Langfuse span binding (E.4)` from the TARGET list (it plus H.7's nesting are shipped; word it e.g. `Langfuse span binding SHIPPED (E.4) + nested span tree asserted (H.7)`); §8 header SHIPPED list: append `nested worker⊂supervisor span tree (H.7)`.

## Verify + ship ritual

```bash
cd sidecar && npm test && npm run typecheck && npm run eval && npm run build
```

Panel untouched — skip the panel leg. Then: conventional commit with
`--trailer "Assisted-by: Claude Code"` (trackers in the SAME commit) →
`git push -u origin claude/merged-eval-course-plan-ky6ulh` → update PR #16
body (checklist line for H.7) → SendUserFile
`docs/internal/build-status.html` (rendered inline).
