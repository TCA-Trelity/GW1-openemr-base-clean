# E.5 — LangSmith tracing, fenced to the demo environment

REQ: R7 (locked decision #2), P5 · Depends on: C.3 (graph — shipped) · Band: 2

## Why

Locked decision #2: Langfuse is the committed observability posture;
**LangSmith is a demo-environment overlay only** (synthetic data, never
production — pitfall P5 forbids raw-PHI-adjacent SaaS tracing). LangGraph.js
traces natively to LangSmith via environment variables, so this is mostly an
env + documentation ticket with one line of code: a boot log stating whether
LangSmith tracing is on. It buys grader-friendly LangGraph visuals for Dan's
demo without any posture reversal.

## Existing seams you MUST reuse

- `src/config.ts:92-94` — the keys already exist and are boot-crash-proof:
  - `LANGSMITH_TRACING: z.enum(['true', 'false']).default('false')`
  - `LANGSMITH_API_KEY: z.string().min(1).optional()`
  - `LANGSMITH_PROJECT: z.string().min(1).default('clinical-copilot-w2-demo')`
  with the fencing comment ("Tracing engages only when explicitly 'true' AND the API key is present; production configs simply never set these").
- `@langchain/langgraph` (^1.4.7) + `@langchain/core` (^1.2.2) in `sidecar/package.json` — LangChain's callback layer reads `LANGSMITH_TRACING` (alias `LANGCHAIN_TRACING_V2`), `LANGSMITH_API_KEY`, and `LANGSMITH_PROJECT` from `process.env` **natively**; `buildClinicalGraph` needs **no code change** for basic run traces. Verify the transitive client exists before claiming traces will render: `cd sidecar && npm ls langsmith` — it ships as a dependency of `@langchain/core`. If it were ever absent, tracing silently no-ops (acceptable for a fenced demo; do NOT add a direct dep just in case).
- `src/server.ts` boot block (:344-382) — where the existing boot-signal log lines live (`'guideline retriever ready'`, `'EHR sync configured'`); the LangSmith line joins them.
- `docs/RUNBOOK.md` §C (Langfuse) — the observability activation section the fencing note extends.
- `README.md` L57 `### Week 2 — Multimodal Evidence Agent (in progress)` — where the one-line posture note lands.

## Files to create/modify

- `sidecar/src/server.ts` — one boot log line (step 1). No other code.
- `docs/RUNBOOK.md` — new short subsection after §C: `## C2. LangSmith (demo environment ONLY)` (or a `### LangSmith overlay` under §C — match the doc's heading style).
- `README.md` — one line in the Week 2 section: Langfuse = committed posture; LangSmith = demo-env overlay, synthetic data only.
- (No config.ts change — keys exist. If `test/config.test.ts` lacks a LANGSMITH case, add one; check first.)

## Step-by-step implementation

1. **Boot log** (server.ts boot block, beside the retriever/EHR lines):

```ts
const langsmithOn = config.LANGSMITH_TRACING === 'true' && config.LANGSMITH_API_KEY !== undefined;
app.log.info(
    { langsmithTracing: langsmithOn, langsmithProject: langsmithOn ? config.LANGSMITH_PROJECT : undefined },
    langsmithOn ? 'langsmith tracing ON (demo-env overlay — synthetic data only)' : 'langsmith tracing off',
);
```

   Never log the key. Note the graph traces via `process.env` directly
   (LangChain reads it), so this line is *reporting*, not *enabling* — say so
   in a code comment to stop a future reader "wiring" it into the graph.
2. **RUNBOOK subsection** — content requirements:
   - Where: **the demo Railway service only**. Set `LANGSMITH_TRACING=true`,
     `LANGSMITH_API_KEY=<from smith.langchain.com → Settings → API Keys>`,
     `LANGSMITH_PROJECT=clinical-copilot-w2-demo`. Production/committed
     posture: these variables are simply never set (config default is
     `'false'`).
   - Why fenced (locked #2, P5): LangSmith is a third-party SaaS; only
     synthetic demo data may ever ride it. Langfuse remains the committed
     posture (§C).
   - How to verify: redeploy the demo service → boot log shows
     `langsmith tracing ON` → run one evidence chat turn → a LangGraph run
     tree renders under the project at smith.langchain.com.
   - How to revoke: unset the three vars, redeploy; boot log shows `off`.
3. **README line** (Week 2 section): "Observability: Langfuse (committed
   posture, RUNBOOK §C); LangSmith renders LangGraph traces in the demo
   environment only (RUNBOOK §C2 — synthetic data, never production)."
4. Confirm `test/config.test.ts` covers the three keys (added in Wave 0.4);
   if any is untested, add: `it('LANGSMITH_TRACING defaults to false and tolerates junk')`
   asserting default `'false'` and `.catch` fallback on an invalid value.
5. Trackers, ship.

## What NOT to do

- Do NOT add `langsmith` as a direct dependency, wrap the graph in tracing
  callbacks, or thread config values into `buildClinicalGraph` — native env
  reading is the whole mechanism; code coupling here is pure liability.
- Do NOT set LANGSMITH_* on the production Railway service, in any committed
  env file, in CI, or in `environments/*.bru` — demo service only, set by the
  user (USER-ACTIONS.md).
- Do NOT log or echo the API key anywhere (boot line carries a boolean + project name only).
- Do NOT present LangSmith as the observability answer in any doc — Langfuse
  is the committed posture; keep the hierarchy explicit everywhere it is
  mentioned.

## Acceptance checks

```bash
cd sidecar && npm test && npm run typecheck
# Keyless boot → log line: "langsmith tracing off"
LANGSMITH_TRACING=true LANGSMITH_API_KEY=x npm run dev | head -40
# → "langsmith tracing ON (demo-env overlay — synthetic data only)" with project name
```

Post key-drop (demo env, user action): one evidence turn → LangGraph run tree
visible in the `clinical-copilot-w2-demo` project; production service's boot
log still says `off`.

## Tests to add

- `sidecar/test/config.test.ts` — only if missing: `it('LANGSMITH_TRACING defaults to false and falls back on invalid values')` (parse `{}` → `'false'`; parse `{ LANGSMITH_TRACING: 'yes' }` → `'false'` with the warn fallback).

## Tracker updates

- `docs/w2/requirements.md` — under **R7** flip: `- [ ] LangSmith enabled **only** in the demo environment (locked), documented as a demo-env overlay with synthetic data — never the committed production posture (P5 guard).` → `- [x]` once the docs + boot log land (the env-var flip itself is the user's USER-ACTIONS.md step; annotate "(demo-env vars: user action)" if they haven't been set yet).
- `docs/w2/build-status.html` — DATA (starts L189): `{ id: "E.5", … s: "pending" }` → `s: "done"`; bump the R7 reqGroup done-count by the flipped delta.
- `W2_ARCHITECTURE.md` — §8 already states the fencing; no marker change unless §8's TARGET list names LangSmith wiring — if it does, mark that item shipped.

## Verify + ship ritual

```bash
cd sidecar && npm test && npm run typecheck && npm run eval && npm run build
```

Panel untouched — skip the panel leg. Then: conventional commit with
`--trailer "Assisted-by: Claude Code"` (trackers in the SAME commit) →
`git push -u origin claude/openemr-rag-requirements-x25vzm` → update PR #9
body → SendUserFile `docs/w2/build-status.html`.
