# E.6 — `/ready` probes: document_storage, retriever_index, reranker

REQ: G14 · Depends on: A.3 (EHR write client), B.3 (retriever index) · Band: 2

> **Status: reference (implemented).** The main agent landed this ticket while
> these specs were being written; the shape below matches the working tree as
> observed (uncommitted diff on `src/routes/health.ts`, `src/server.ts`,
> `test/server.test.ts`). Use this spec to (a) review the as-built change,
> (b) restore it if it regresses, (c) mirror the pattern when adding future
> probes. If `git log` shows E.6 already committed, verify the facts below
> against `src` and fix any drift **in this spec**, not by re-implementing.

## Why

G14 requires `/ready` to report each Week 2 dependency with a **degraded
status per dependency, not binary up/down**: killing one dependency flips its
probe without taking readiness down for unrelated reasons. For Dan's demo this
is the one-glance answer to "will an upload actually store to OpenEMR, and is
the reranker live or in passthrough fallback?" — before he uploads anything.

## Existing seams you MUST reuse

- `src/routes/health.ts:DepCheck` — `{ name: string; requiredInProduction: boolean; check: () => Promise<void>; configured: boolean }`; a `check()` that throws marks the dep `failed`.
- `src/routes/health.ts:registerHealthRoutes(app: FastifyInstance, config: Config, probes?: HealthProbes): void` — the only registration point.
- `src/routes/health.ts` status semantics — `type DepStatus = 'ok' | 'failed' | 'not_configured'`; `not_configured` **never** fails readiness; any configured-but-throwing check → HTTP 503 with `{ ready: false, dependencies: {...} }`. Readiness = `!anyConfiguredFailed && !missingRequired` (missingRequired only bites in `NODE_ENV=production` for `requiredInProduction` deps).
- `src/routes/health.ts:HealthProbes` — the injection seam (optional `() => Promise<void>` members); `postgres` probe (`checkPostgres`) is the existing worked example, wired from `src/server.ts:buildDeps` as `async () => { await pool.query('SELECT 1'); }`.
- `src/openemr/auth.ts:OpenEmrPasswordAuthClient` — `.getAccessToken(): Promise<string>` proves base URL + client id + password-grant credentials in one round trip.
- `src/server.ts:buildEvidenceDeps(config)` → `{ retriever: HybridRetriever }` — the retriever index that the `retriever_index` probe reflects.

## Files to create/modify (as-built)

- `src/routes/health.ts` — `HealthProbes` gains `checkDocumentStorage?`, `checkRetrieverIndex?`, `checkReranker?` (all `HealthProbe = () => Promise<string | void>`; H.2 — a probe that resolves a string attaches it as the dependency's `detail` on `ok`); `buildChecks()` appends three `DepCheck` entries named `document_storage`, `retriever_index`, `reranker`, each `requiredInProduction: false`, `configured: probes?.<fn> !== undefined`, `check: probes?.<fn> ?? (async () => {})`.
- `src/server.ts` — `AppDeps` gains `checkDocumentStorage?: () => Promise<void>`. `buildDeps` hoists the password-grant client into a shared `ehrTokenProvider` (used by both `StandardApiClient` and the probe) and returns `...(ehrTokenProvider !== undefined ? { checkDocumentStorage: async () => { await ehrTokenProvider.getAccessToken(); } } : {})`. The `registerHealthRoutes(...)` call site passes all wired probes (postgres + document_storage always from deps; retriever_index/reranker join where `buildEvidenceDeps` resolves in the boot block — a retriever that holds chunks answers, otherwise the probe is absent → `not_configured`). The reranker probe (H.2) is built in `buildEvidenceDeps` beside the `CohereReranker` and carried on `EvidenceRouteDeps.checkReranker`: it reports the outcome of the **last real rerank made by traffic** (`CohereReranker.lastOutcome`), never key presence and never a per-poll live call.
- `test/server.test.ts` — new E.6 cases (see Tests).

## Step-by-step implementation

Already implemented; the increments were:

1. Extend `HealthProbes` with the three optional probe functions (doc comments state the degraded semantics: absent probe = subsystem not wired on this deployment = `not_configured`, visible, never binary-down).
2. Append three `DepCheck` entries to `buildChecks()` following the existing `postgres` entry pattern verbatim.
3. In `buildDeps`, share one `OpenEmrPasswordAuthClient` between the docs client and the probe; expose `checkDocumentStorage` via conditional spread (exactOptionalPropertyTypes).
4. Wire probes into the `registerHealthRoutes` call. Probe meanings:
   - `document_storage`: token mint via `ehrTokenProvider.getAccessToken()` — no chart data touched.
   - `retriever_index`: resolves only when the guideline index holds chunks (reject/throw on an empty or absent index).
   - `reranker` (semantics fixed by H.2): reports the outcome of the last **real** rerank
     call made by actual traffic. Keyed but not yet exercised → `ok` with
     `detail: "keyed (unverified since boot — no rerank traffic yet)"`; last observed
     rerank succeeded → `ok` with a `verified by live traffic (…)` detail; a failure more
     recent than the last success → `failed` (503) until traffic succeeds again. Absent =
     PassthroughReranker fallback, which is honestly `not_configured` (fusion order still
     serves). Key presence alone is **not** reported as health — and the probe never makes
     its own Cohere call (trial keys are rate-limited; every rerank call has a cost).
5. Tests, then trackers.

## What NOT to do

- Do NOT mark any new probe `requiredInProduction: true` — that reverses the
  "degraded, not binary-down" requirement and would 503 the deploy the moment
  a key is missing.
- Do NOT have `reranker` report `ok` when `PassthroughReranker` is active —
  the fallback is a *degraded* posture and `/ready` must say so.
- Do NOT make the `reranker` probe issue a live Cohere call per poll — readiness
  is polled, trial keys are rate-limited, and every rerank call costs money. The
  probe reads `CohereReranker.lastOutcome` (H.2); the only rerank calls are the
  ones traffic makes anyway.
- Do NOT call OpenEMR chart/document endpoints from the probe; a token mint is
  the whole check (PHI never rides a readiness probe).
- Do NOT add per-probe HTTP handlers; everything flows through the one
  `buildChecks` table.

## Acceptance checks

```bash
cd sidecar && npm test          # server.test.ts E.6 cases green
curl -s localhost:8080/ready | jq '.dependencies | {document_storage, retriever_index, reranker}'
# keyless dev boot →
#   {"document_storage":{"status":"not_configured"},
#    "retriever_index":{"status":"ok"},           # corpus ships in-repo → index holds chunks
#    "reranker":{"status":"not_configured"}}      # no COHERE_API_KEY → passthrough
# and top-level "ready": true (not_configured never fails readiness).
# keyed boot, before any rerank traffic (H.2) →
#   "reranker":{"status":"ok","detail":"keyed (unverified since boot — no rerank traffic yet)"}
# after traffic: detail flips to "verified by live traffic (last rerank ok at …)";
# a rerank failure more recent than the last success → {"status":"failed", ...} + 503.
```

Kill test (G14 acceptance): configure a probe that throws → its dep shows
`"status":"failed"` with an `error` string and `/ready` returns 503, while
other deps still report independently.

## Tests to add (as-built, in `test/server.test.ts`)

- `it('GET /ready reports the W2 deps as not_configured when their subsystems are absent')` — keyless `buildServer` → all three new keys present with `not_configured`; `ready` unaffected.
- `it('GET /ready flips retriever_index to failed when the injected probe throws')` — inject `checkRetrieverIndex: async () => { throw ... }` → `dependencies.retriever_index.status === 'failed'`, response 503, siblings unaffected.
- H.2 additions: a reranker probe that resolves a string surfaces it as
  `dependencies.reranker.detail` on `ok`; a throwing reranker probe → `failed` + 503
  (`test/server.test.ts`), and `CohereReranker` outcome memory — success/failure/
  no-call-on-empty-candidates — is covered in `test/retrieval.test.ts`.
  (Exact names may differ slightly in the working tree — trust the file; the behaviors above are what must stay covered.)

## Tracker updates

- `docs/w2/requirements.md` — under **G14 — Health/readiness**, flip:
  - `- [ ] \`/ready\` adds probes: document storage (OpenEMR standard API` … `(existing pattern extended).` → `- [x]`
- `docs/internal/build-status.html` — DATA block: ticket `E.6` → done status; bump the G14 reqGroup done-count by its checkbox delta.
- `W2_ARCHITECTURE.md` — §9 header (`## 9. SLOs, resilience, readiness (REQ: G2, G14) — [TARGET]`): move the readiness-probe portion to SHIPPED (e.g. `[SHIPPED: W2 /ready probes · TARGET: rest]` — match the mixed-marker style of §3/§5 headers).

## Verify + ship ritual

```bash
cd sidecar && npm test && npm run typecheck && npm run eval && npm run build
```

Panel untouched — skip the panel leg. Then: conventional commit with
`--trailer "Assisted-by: Claude Code"` (trackers in the SAME commit) →
`git push -u origin claude/openemr-rag-requirements-x25vzm` → update PR #9
body → SendUserFile `docs/internal/build-status.html`.
