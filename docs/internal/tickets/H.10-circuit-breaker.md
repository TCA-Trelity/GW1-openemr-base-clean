# H.10 — Hand-rolled circuit breaker per dependency (Cohere, Anthropic, OpenEMR)

REQ: G2 (circuit box), G14 · Depends on: **H.5** (timeout/retry on OpenEMR calls; `sidecar/src/lib/httpRetry.ts`) · Band: merged-plan Track 1 · Priority: P1 (per merged-plan.md)

## Why

G2's open circuit box: after N consecutive failures of a dependency,
short-circuit with a degraded response instead of hammering it, and `/ready`
must reflect the open state. The register's own wording allows *"simple breaker
or documented equivalent fallback"*, and the merged plan's out-of-scope list
bans a commercial breaker library — so this is a hand-rolled counter: trip
after N consecutive failures, short cooldown, one half-open probe. Do this
AFTER H.5: the breaker counts "a failure" as *a timed-out-and-retried call
that still failed*, which only exists once H.5's timeouts land.

**Gate:** H.5 landed 2026-07-15 (`fix(sidecar): timeout + bounded retry on all
OpenEMR egress`; `sidecar/src/lib/httpRetry.ts` exists) — verified at
spec-writing time. Still re-run `ls sidecar/src/lib/httpRetry.ts` before
starting; if it has vanished (revert), STOP and restore H.5 first.

## Existing seams you MUST reuse

- `src/lib/httpRetry.ts:47` (H.5, landed) — `export async function withTimeoutAndRetry<T>(operation: string, timeoutMs: number, attempt: (signal: AbortSignal) => Promise<T>, options?: TimeoutRetryOptions): Promise<T>` with `TimeoutRetryOptions { retries?: 0 | 1; onTimeout?: (operation, timeoutMs) => Error }` (:28-40) and `HttpTimeoutError` (:16) — writes/uploads/registration run `retries: 0` by design (a retried write can double-file a document). The breaker composes OUTSIDE this helper: one `exec` = one logical call = ONE breaker failure, whether or not the helper retried inside.
- `src/retrieval/embeddings.ts:EmbeddingsProvider` — `{ readonly id: string; readonly dims: number; embed(texts: readonly string[], inputType: EmbedInputType, correlationId: string): Promise<number[][]> }` — decorate, don't modify.
- `src/retrieval/rerank.ts:Reranker` — `{ readonly id: string; rerank(query, candidates: readonly RerankCandidate[], topK, correlationId): Promise<RerankOutcome> }`; `RerankOutcome = { order: { id: string; score: number }[]; rerankApplied: boolean }`; `PassthroughReranker.rerank` (:88-99) is the degraded-order shape to mirror when the Cohere breaker is open.
- `src/retrieval/retriever.ts:154-156` — the dense leg already skips gracefully when `embed` yields no vector (`const [queryVector] = …; if (queryVector !== undefined)`) — an open-breaker embed decorator that returns `[]` degrades to keyword-only search with zero retriever changes.
- `src/prep/anthropic.ts:110` — `class AnthropicClient` with `async complete(...)` (:131), per-call idle/total timeouts (:126-127), `isTransientAnthropicError` (:78). Every caller of `complete` already has a fallback lane (router → `fast_path`, composer/chat → Week 1 loop or error event, extractor → `failed_extraction`), so for Anthropic a fast `CircuitOpenError` throw IS the degraded behavior.
- `src/openemr/standardApi.ts:441` (`private async request` — already inside H.5's `withTimeoutAndRetry` with method-aware `retries`), `:592` (`uploadPatientDocumentDeduped`'s multipart POST), `src/openemr/fhir.ts:97` (`private async request`), `src/openemr/auth.ts:263` + `:367` (the two `getAccessToken` token mints) — the OpenEMR egress points H.5 already wrapped with timeouts; ONE shared `'openemr'` breaker now guards all of them (same host, one dependency), sitting outside the existing wrappers.
- `src/routes/health.ts:16` — `interface DepCheck` and `HealthProbes` (:36-49; note H.2 landed: probes are `HealthProbe`s that may resolve a `detail` string, and `checkReranker` reports last-observed-traffic outcome — never a per-poll Cohere call) — the injection seam; existing dep names to reflect breaker state onto: `openemr`, `anthropic`, `reranker`.
- `src/server.ts:buildDeps` (:113+, prep AnthropicClient at :123) and `buildEvidenceDeps` (search for `export async function buildEvidenceDeps`) — the two construction sites where breaker instances are created and threaded; router/composer AnthropicClients at :520/:530.
- `docs/internal/merged-plan.md` out-of-scope list: *"A commercial circuit-breaker library or anything resembling full service-mesh-grade infrastructure — this project's own written requirements explicitly allow a simple, hand-rolled version."*

## Files to create/modify

- **Create** `sidecar/src/lib/circuitBreaker.ts` — the breaker + typed open error (beside H.5's `httpRetry.ts`).
- **Modify** `sidecar/src/prep/anthropic.ts` — optional `breaker?: CircuitBreaker` in `AnthropicClientOptions`; `complete` runs through `breaker.exec` when present.
- **Modify** `sidecar/src/openemr/standardApi.ts`, `fhir.ts`, `auth.ts` — optional `breaker?: CircuitBreaker` option; wrap each egress call site (composing with H.5's retry helper: breaker outside, retry inside).
- **Modify** `sidecar/src/server.ts` — create one breaker per dependency (`openemr`, `anthropic`, `cohere`); thread into clients; wrap the Cohere providers in `buildEvidenceDeps` with degrading decorators; feed breaker state into the health probes.
- **Modify** `sidecar/src/routes/health.ts` — `HealthProbes` gains `breakerStates?: () => Record<string, 'closed' | 'open' | 'half_open'>`; a dep whose breaker is `open` reports `failed` with a `circuit_open` error without invoking its live check.
- **Create** `sidecar/test/circuit-breaker.test.ts`; **modify** `sidecar/test/server.test.ts`, `sidecar/test/retrieval.test.ts`.
- Trackers: `docs/w2/requirements.md`, `docs/internal/build-status.html`, `W2_ARCHITECTURE.md` §9.

## Step-by-step implementation

1. **Breaker** (`src/lib/circuitBreaker.ts`) — sketch (real shape, keep this small):

   ```ts
   export type BreakerState = 'closed' | 'open' | 'half_open';

   export class CircuitOpenError extends Error {
       constructor(public readonly dependency: string, public readonly retryAtMs: number) {
           super(`${dependency} circuit open — short-circuiting until ${new Date(retryAtMs).toISOString()}`);
           this.name = 'CircuitOpenError';
       }
   }

   export interface CircuitBreakerOptions {
       name: string;
       failureThreshold?: number;      // default 5 consecutive failures
       cooldownMs?: number;            // default 30_000
       now?: () => number;             // injectable clock (tests)
       onTransition?: (from: BreakerState, to: BreakerState) => void;  // structured log hook
   }

   export class CircuitBreaker {
       get state(): BreakerState;
       async exec<T>(fn: () => Promise<T>): Promise<T>;
   }
   ```

   Semantics: `closed` — failures bump a consecutive counter (success resets to
   0); counter ≥ threshold → `open` (stamp openedAt). `open` — `exec` throws
   `CircuitOpenError` WITHOUT invoking `fn` until `now() ≥ openedAt + cooldownMs`,
   then `half_open`. `half_open` — exactly one in-flight probe passes through;
   success → `closed` (reset), failure → `open` with a fresh cooldown;
   concurrent calls while the probe is in flight get `CircuitOpenError`.
   `exec` never wraps the underlying error (rethrow as-is). `onTransition`
   logs `{ dependency, from, to }` — ids/states only, PHI-free by construction.
2. **Anthropic**: `AnthropicClientOptions` gains `breaker?: CircuitBreaker`; inside `complete`, wrap the whole existing attempt in `this.breaker.exec(...)` when present. In `server.ts`, create ONE `const anthropicBreaker = new CircuitBreaker({ name: 'anthropic', onTransition: … })` in the boot scope and pass it to every `new AnthropicClient(...)` (prep :123, router :520, composer :530) — one dependency, one counter.
3. **OpenEMR**: same optional-`breaker` pattern on `StandardApiClientOptions`, `FhirClient` options, and both auth clients; wrap each fetch-bearing call site as `breaker.exec(() => withTimeoutAndRetry(...existing H.5 wrapping...))`. One shared `openemrBreaker` instance created in `buildDeps` and passed to `ehrTokenProvider`, `ehrDocsClient`, and the FHIR client (:248).
4. **Cohere** (`buildEvidenceDeps`): when `COHERE_API_KEY` is set, create `cohereBreaker` and wrap the two providers with ~10-line decorators that (a) run calls through `breaker.exec`, (b) catch **only** `CircuitOpenError` and degrade honestly with a warn log `circuit_open_degraded { dependency: 'cohere' }`: embed → return `[]` (dense leg skips; keyword+fusion still serves), rerank → PassthroughReranker-shaped order with `rerankApplied: false`. All other errors propagate unchanged (they are what feeds the breaker).
5. **/ready reflects open state**: `HealthProbes.breakerStates?: () => Record<string, BreakerState>`; in the `/ready` handler (or `buildChecks`, :51+), before running a configured dep's `check()`, consult `breakerStates?.()[dep.name]` — `'open'` → `results[dep.name] = { status: 'failed', error: 'circuit_open (N consecutive failures; cooling down)' }` without calling out (that's the point: no hammering, not even from the probe). This composes with H.2's traffic-outcome reranker probe: breaker open wins (reported without consulting the traffic record); otherwise the H.2 probe answers as it does today. Map names: `anthropic`, `openemr`, `reranker` (← cohere). `server.ts` supplies the closure from its three instances.
6. Tests, trackers, ship.

## What NOT to do

- Do NOT pull in a breaker/resilience library (opossum, cockatiel, …) — explicitly banned; a counter + two timestamps is the whole design.
- Do NOT put the breaker INSIDE `withTimeoutAndRetry` — the retry pair is one logical call; counting each attempt would double-trip.
- Do NOT let an open Cohere breaker fail a search — the degrade path (keyword-only, passthrough order) is the requirement; conversely do NOT swallow real (non-open) errors in the decorators.
- Do NOT mark any dep `requiredInProduction: true` or change readiness semantics beyond the open-state reflection (E.6's degraded-not-binary rule stands).
- Do NOT share one breaker across dependencies or create per-call breakers — one instance per dependency, created once at boot.
- Do NOT log payloads/prompts in transition events — dependency name + states only (G18/P5).

## Acceptance checks

```bash
cd sidecar && npx vitest run test/circuit-breaker.test.ts     # state machine green
cd sidecar && npm test && npm run typecheck
```

Kill test (manual, matches merged-plan verification for H.5/H.10): in a test or
local run, make a mock OpenEMR fetch fail 5 times → 6th call throws
`CircuitOpenError` immediately (no fetch invoked); advance the injected clock
past the cooldown → one probe passes through; `/ready` with an injected
`breakerStates` reporting `openemr: 'open'` returns 503 with
`dependencies.openemr.error` containing `circuit_open` while siblings report
independently.

## Tests to add

- `test/circuit-breaker.test.ts` — `describe('CircuitBreaker (H.10)')`:
  - `it('trips open after N consecutive failures and short-circuits without invoking the call')` (spy fn call count stops at threshold).
  - `it('a success in closed state resets the consecutive counter — intermittent failures never trip it')`.
  - `it('half-opens after the cooldown: probe success closes, probe failure re-opens with a fresh cooldown')` (injected `now`).
  - `it('rethrows the underlying error unchanged and throws CircuitOpenError with the dependency name when open')`.
- `test/retrieval.test.ts` — `it('an open cohere breaker degrades search to keyword-only + passthrough order instead of failing the query')` — build the retriever with the wrapped providers around an always-`CircuitOpenError` breaker; `search()` resolves, `rerank_applied === false`, snippets still served.
- `test/server.test.ts` — `it('GET /ready reports a dependency failed with circuit_open when its breaker is open, without probing it')` — inject `breakerStates: () => ({ reranker: 'open' })` plus a `checkReranker` spy; 503, spy not called, siblings unaffected.

## Tracker updates

- `docs/w2/requirements.md` — under **G2** (~:499), flip to `[x]` (verbatim lines):

  ```
  - [ ] Circuit-breaking behavior per dependency: after N consecutive failures,
    short-circuit with degraded response + `/ready` reflects it (simple breaker
    or documented equivalent fallback — no silent hammering).
  ```

  Append annotation: `*(H.10: hand-rolled CircuitBreaker (src/lib/circuitBreaker.ts) — 5 consecutive failures → 30 s cooldown → half-open probe; one instance per dependency (openemr, anthropic, cohere); open state degrades (embed→keyword-only, rerank→passthrough, LLM callers' existing fallback lanes) and surfaces on /ready as circuit_open.)*`
  Note: the sibling G2 timeout/retry box (~:490) is already `[x]` — H.5 flipped it 2026-07-15; leave it alone.
- `docs/internal/build-status.html` DATA block: ticket `H.10` `s: "pending"` → `"done"`; reqGroups: `G2` row bump `done` by 1 (H.5 already bumped its own — re-read the row's current counts and make the total reflect 2 of 3 boxes `[x]` + this one → `done: 3, s: "done"`).
- `W2_ARCHITECTURE.md` — §9 header: remove `circuit-breaker documentation per dependency (H.10)` from TARGET → add to SHIPPED (e.g. `hand-rolled per-dependency circuit breakers w/ /ready circuit_open reflection (H.10)`); update the §9 `Circuit behavior:` bullet from future to present tense naming threshold/cooldown.

## Verify + ship ritual

```bash
cd sidecar && npm test && npm run typecheck && npm run eval && npm run build
```

Panel untouched — skip the panel leg. Then: conventional commit with
`--trailer "Assisted-by: Claude Code"` (trackers in the SAME commit) →
`git push -u origin claude/merged-eval-course-plan-ky6ulh` → update PR #16
body (checklist line for H.10) → SendUserFile
`docs/internal/build-status.html` (rendered inline).
