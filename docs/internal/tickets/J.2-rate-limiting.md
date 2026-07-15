# J.2 — Per-route rate limiting on the write/expensive endpoints

REQ: G2 (resilience) · protects locked decision #16 ($5/day SpendGuard) · Depends on: — · Band: merged-plan Track 1 (J) · Priority: P0 within sub-track J (per merged-plan.md)

> **PARKED — post-grading.** Sub-track J is "post-grading hardening"
> (merged-plan.md, Track 1). Do not land this while graders may be exercising
> the deployed demo — a mis-tuned limit could 429 a grader mid-flow.

## Why

Nothing today stops a runaway client (a stuck retry loop, a scripted grader
probe, an accidental `while true; curl`) from hammering the two endpoints
that cost real money and write real state: document upload (VLM extraction
spend + OpenEMR document writes) and the chat turn (LLM spend per POST). The
$5/day SpendGuard (locked #16) is the backstop, but draining it means the
demo is dead for the rest of the day — rate limiting keeps one bad client
from spending the whole budget. Per-route only: the panel legitimately polls
status endpoints every few seconds, and a blanket global limit would break
that.

## Existing seams you MUST reuse

- `sidecar/package.json:34` — `"fastify": "^5.2.0"`. The plugin major must match Fastify 5: **`@fastify/rate-limit` v10.x** is the Fastify-5 line — confirm against the plugin README's compatibility table at install time before pinning.
- `sidecar/src/server.ts:294 buildServer(config: Config, deps?: AppDeps): FastifyInstance` — the single Fastify construction point; plugin registration goes here, before the route registrations at server.ts:336-342.
- `sidecar/src/routes/ingest.ts:68` — `app.post<{ Params: { patientId: string } }>('/api/patients/:patientId/documents', ...)` — the upload route (limit target 1).
- `sidecar/src/routes/chat.ts:102` — `app.post<ChatPost>('/api/chat/:patientId', ...)` — the chat-turn/SSE route (limit target 2). Note the pre-stream guards there (400/404/429-budget) answer as plain JSON *before* the SSE opens — a rate-limit 429 fits the same pre-stream contract.
- `sidecar/src/routes/auth.ts:28` — `app.post('/api/dev-login', ...)` — optional third target (brute-force guard on the shared secret).
- **Panel polling routes that MUST stay unlimited** (verified against the panel source):
  - `GET /api/ingestions/:id` — polled by `sidecar/panel/src/UploadCard.tsx:66-81` via `fetchIngestion` (`sidecar/panel/src/api.ts:234-236`).
  - `GET /api/prep-runs/:patientId` — polled by `sidecar/panel/src/AiInsights.tsx:119-200` via `fetchPrepRuns` (`api.ts:636-638`).
  - Plus the landing reads: `GET /api/overview/:patientId`, `GET /api/patients`, `GET /api/chat/:patientId` (history, chat.ts:289), `/health`, `/ready`.
- `sidecar/src/config.ts:22 EnvSchema` — new tunables follow the `z.coerce.number().int().positive().default(N).catch(orWarn(N, 'NAME'))` pattern (see `LLM_MAX_CONCURRENT_PREPS`, config.ts:53).
- `POST /api/prep/:patientId` already has four cost guards (reuse window → in-flight dedupe → concurrency cap → budget precheck; `sidecar/src/routes/prep.ts:1-4` header) — it does NOT need this ticket's limiter; leave it alone.

## Files to create/modify

- `sidecar/package.json` — add `@fastify/rate-limit` (^10, per the compat check above). New deps go here, never repo-root package.json (standing rule 4).
- `sidecar/src/config.ts` — `RATE_LIMIT_UPLOAD_PER_MINUTE` (default 10), `RATE_LIMIT_CHAT_PER_MINUTE` (default 20), `RATE_LIMIT_DEV_LOGIN_PER_MINUTE` (default 30).
- `sidecar/src/server.ts` — register the plugin with `global: false`; thread the three limits into the route deps (or read config at registration and pass per-route `config.rateLimit`).
- `sidecar/src/routes/ingest.ts`, `sidecar/src/routes/chat.ts`, `sidecar/src/routes/auth.ts` — per-route `config: { rateLimit: { max, timeWindow: '1 minute' } }` on the three POSTs only.
- `sidecar/test/server.test.ts` (or a new `sidecar/test/rateLimit.test.ts`) — see Tests.
- `sidecar/openapi.yaml` — add the 429 response to the three routes (`test/openapi.test.ts` gates spec↔implementation drift both directions; skipping this fails CI).

## Step-by-step implementation

1. Confirm the plugin major: open the `@fastify/rate-limit` README compatibility table; install the line that declares Fastify ^5 support (v10.x at spec-writing time). `cd sidecar && npm install @fastify/rate-limit@^10`.
2. Register once in `buildServer` (server.ts:294 block), **before** route registration:

   ```ts
   void app.register(rateLimit, { global: false });
   ```

   (Matches the file's existing `void app.register(...)` style — see server.ts:349.)
3. **Client keying behind Railway's proxy.** Check the Fastify factory options in `buildServer`: if `trustProxy` is not set, every request's `request.ip` is Railway's edge, and one bucket would throttle *all* clients collectively (self-inflicted outage). Set `trustProxy: true` on the factory (or a keyGenerator on `x-forwarded-for`'s first hop) and verify locally with a spoofed `x-forwarded-for` header that two "clients" get two buckets.
4. Add per-route config, upload first:

   ```ts
   app.post<{ Params: { patientId: string } }>('/api/patients/:patientId/documents', {
       config: { rateLimit: { max: deps.uploadPerMinute ?? 10, timeWindow: '1 minute' } },
   }, async (request, reply) => { /* existing handler body unchanged */ });
   ```

   Then chat POST (chat.ts:102) with the chat limit, then `/api/dev-login` (auth.ts:28) with its limit. Handler bodies stay byte-identical — only the route options object is added.
5. Thread config → deps: extend `IngestRouteDeps` / `ChatRouteDeps` / `AuthRouteDeps` with optional `…PerMinute?: number` members, populated from config in `buildDeps` via conditional spread (exactOptionalPropertyTypes, standing rule 8).
6. Defaults sanity: 10 uploads/min and 20 chat turns/min are far above any human demo pace but cap a runaway loop at minutes-scale spend instead of budget-drain-scale; state this arithmetic in the PR body. SpendGuard remains the authoritative dollar cap — the limiter only slows the drain (never remove or weaken the budget precheck at chat.ts:119-130).
7. openapi.yaml 429 entries; tests; trackers; ship.

## What NOT to do

- Do NOT set `global: true` or add a default limit to every route — the panel's polling (seams above) would trip it and the plan explicitly forbids breaking normal polling.
- Do NOT rate-limit `GET /api/ingestions/:id`, `GET /api/prep-runs/:patientId`, `/health`, `/ready`, or any read the panel issues on load.
- Do NOT treat the limiter as the budget control — locked #16's SpendGuard stays untouched and authoritative.
- Do NOT key buckets on `request.ip` without resolving the proxy question (Step 3) — collective throttling is worse than none.
- Do NOT add Redis/distributed state for the limiter — single-replica demo scale; the in-memory default store is correct here (same right-sizing rationale as the circuit-breaker out-of-scope note).
- Do NOT return a custom 429 body shape that collides with the existing budget 429 (`{ error: 'llm_budget_exceeded', ... }`, chat.ts:126) — keep them distinguishable (`error: 'rate_limited'` via `errorResponseBuilder` or accept the plugin default and document it in openapi.yaml).

## Acceptance checks

```bash
cd sidecar && npm test && npm run typecheck && npm run build
# Manual burst proof against a local dev boot:
for i in $(seq 1 25); do curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  localhost:8080/api/chat/margaret-chen -H 'content-type: application/json' \
  -d '{"message":"hi"}'; done | sort | uniq -c
# expect a mix: 2xx/4xx-domain for the first ~20, then 429s
# Polling exemption proof (must be all 200/404, zero 429):
for i in $(seq 1 60); do curl -s -o /dev/null -w '%{http_code}\n' \
  localhost:8080/api/prep-runs/margaret-chen; done | sort | uniq -c
```

## Tests to add

`sidecar/test/rateLimit.test.ts` (inject-based, mirroring server.test.ts patterns):

- `it('429s the upload route after RATE_LIMIT_UPLOAD_PER_MINUTE requests in a window')` — build server with `uploadPerMinute: 2`, inject 3 multipart POSTs, third is 429.
- `it('429s the chat POST after the chat window is exhausted while GET history stays open')` — chat POST limited; 50 injected `GET /api/chat/:patientId?conversation_id=x` all non-429.
- `it('never rate-limits the panel polling routes')` — 50 injected GETs to `/api/ingestions/x` and `/api/prep-runs/x` → zero 429.
- `it('rate-limit 429 body is distinguishable from the budget 429')` — assert the two error markers differ.

## Tracker updates

- `docs/internal/build-status.html` DATA block: ticket `J.2` (T1 section) → `s: "done"`.
- `W2_ARCHITECTURE.md` §9 header (SLOs, resilience, readiness): CT4's §18 guardrails table marks a rate-limit leg `[TARGET: J.2]` — flip that marker to SHIPPED in the same PR.
- `docs/w2/requirements.md` — no checkbox exists for this follow-on; do not invent one.

## Verify + ship ritual

```bash
cd sidecar && npm test && npm run typecheck && npm run eval && npm run build
```

Panel untouched — skip the panel leg. Then: conventional commit with
`--trailer "Assisted-by: Claude Code"` (trackers in the SAME commit) →
`git push -u origin claude/merged-eval-course-plan-ky6ulh` → update the
PR #16 body → SendUserFile `docs/internal/build-status.html`.
