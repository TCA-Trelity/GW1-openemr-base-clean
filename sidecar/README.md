# Clinical Co-Pilot Sidecar

Node.js + Fastify + Zod service beside an untouched OpenEMR: the agent runtime, the
preparation pipeline, the fact store, the chat API, and the verification layer. The
architecture (and every decision behind it) is [`/ARCHITECTURE.md`](../ARCHITECTURE.md);
how every response is checked before it reaches the user is
[`/docs/VERIFICATION.md`](../docs/VERIFICATION.md).

## Map

```
src/
  gate/            THE VERIFICATION LAYER — every check between generation and display:
                   citationGate.ts (prep: blocks unsourced facts), chatCitations.ts
                   (verbatim re-verification), responseGate.ts (chat choke point:
                   unverified provenance never leaves the server), prescriptivenessLint.ts
  chat/            the multi-turn agent: chat.ts (tool-use loop), openingMove.ts (M9),
                   tools/ (8 read-only, Zod-validated, patient-scoped tools)
  prep/            the proactive pipeline: extraction, citation gate stage, brief assembly,
                   Anthropic client, spend budget
  engines/         deterministic clinical arithmetic (medication risk, imaging analysis) —
                   the model presents these results, never computes them
  routes/          Fastify routes: chat (SSE), prep, ehr, overview, verify, health, auth
  auth/            SMART resource-server verification (RS256 EHR tokens / HS256 dev tokens)
  openemr/         FHIR R4 + standard-API clients, EHR sync/seed
  store/           PostgreSQL fact store (a derived view — wipeable, rebuildable)
  schemas/         Zod schemas — the single contract serving API and UI
  obs/             Langfuse tracing (correlation-ID keyed)
  scripts/         seed, seed-ehr, register-oauth, load-test
panel/             the React panel (SMART-launched, embedded in the patient chart)
eval/              the eval suite — committed results: /docs/execution/eval-results.md
test/              unit/route tests (vitest)
api-collection/    runnable Bruno collection against local or Railway
migrations/        SQL migrations
```

## Run

```bash
npm ci
npm run dev        # tsx watch src/server.ts
npm test           # vitest suite
npm run eval       # eval suite — regenerates docs/execution/eval-results.md
npm run typecheck  # tsc --noEmit (typecheck:eval for the eval tsconfig)
npm run load-test  # deterministic read-path probe (see docs/execution/baselines.md)
```

Config is environment-driven and Zod-parsed at boot (`src/config.ts`); the service runs
in a degraded scaffold mode without a database (routes answer 503) so `/health` and
`/ready` stay meaningful everywhere. Operations — dashboard, alerts, baselines, runbooks —
start at [`/docs/OPERATIONS.md`](../docs/OPERATIONS.md).
