# Clinical Co-Pilot — AI Integration Architecture

*How we integrate an AI clinical co-pilot into this OpenEMR fork. This plan
traces to `USERS.md` (every capability points to a use case) and builds on
`AUDIT.md` (the findings that shaped it). The full defense — with rejected
alternatives argued at length, cost/scale numbers, and the imaging surface —
is `docs/defense/architecture-defense.md`; the tiered build plan is
`docs/defense/PRD-clinical-copilot.md`.*

---

## Summary

A physician has ~90 seconds between rooms to answer five questions: who is
this patient, why are they here, what changed, what's on file, and what
matters today. Our design partner Dan — a retina surgeon who founded the EHR
that leads his specialty — calls today's answer "20 pages where one page would
have done… 90% of it is not relevant." Our diagnosis is **a presentation
failure, not a data failure**: the record already holds what he needs, buried
in clutter that exists for verified reasons (billing, certification,
configurability). So we change **what the doctor sees, never how the EHR
stores data** — an additive layer above the record that cites into it and is
removable without a trace.

The product is a **multi-turn, tool-invoking clinical agent**, and its central
idea is to **move the agent's thinking to where time is free.** After
check-in, patients wait 5–20 minutes before the doctor enters. In that gap the
agent works proactively: a deep-reader model (Claude Sonnet 5) reads the full
record, extracts typed facts — each with a source pointer, confidence,
verification status, and laterality — reconciles contradictions, runs
medication-risk arithmetic, and pre-selects the visit's scans. What it
prepared greets the doctor as the agent's **opening move**: a one-page brief
in under a second, scans one sub-second toggle away. From there the physician
*talks to the agent* (Claude Haiku 4.5, streaming): the conversation persists
and carries context turn to turn, and eight read-only, patient-scoped tools let
it fetch and reason over what no summary carries — full documents, OCT
measurement trends, pairwise scan comparisons, the whole-imaging-story
overview, a direct (quarantined) look at a stored scan, medication-risk
arithmetic, record search, open questions — with tool activity streamed
visibly into the panel. This dissolves speed-vs-completeness — completeness at preparation
time, speed at read-and-reply time — and it is the *only* shape OpenEMR's
performance model allows, because the platform has no async queue (`AUDIT.md`
P-section): heavy work must live outside the EHR.

**Where it lives.** A sidecar service (Node.js + Fastify + Zod) beside an
untouched OpenEMR, talking to it only through the FHIR R4 API and
OAuth2/SMART-on-FHIR. The doctor-facing panel is a React app (ported prototype
design system) embedded in the patient chart via OpenEMR's own module events.
State: a PostgreSQL fact store that is a **derived view** — wipeable and
rebuildable from the record, so the EHR stays the single source of truth.
Preparation runs on a BullMQ/Redis queue the sidecar owns; scans live in
object storage.

**Key decisions, each with its rejected alternative.** A presentation layer
over a data migration (the clutter is load-bearing; a layer is reversible). A
sidecar over code inside OpenEMR's PHP monolith (upgrade-safe, independent
failure domain). TypeScript end-to-end over Python (the prototype's validated
clinical calculators port unchanged, and one Zod schema file serves both the
API and the UI, so contracts cannot drift). A frontier model under a
healthcare BAA over turnkey medical-AI products (our task is retrieving,
organizing, and citing *this* record — not generating medical knowledge).
Whole-patient context over vector search (one patient's facts fit in the
model's context, so the hardest retrieval problem never arises).

**Trust and authorization are constructed, not assumed.** A deterministic
citation gate — plain code, not a model — sits between generation and display;
an unsourced claim is blocked by construction. Domain rules are arithmetic the
physician can hand-check. And the agent is a **thought partner, never a
prescriber**: it never originates treatment, dosing, or diagnosis direction —
a prompt-level contract backed by a deterministic prescriptiveness lint on
every reply and published evals (`docs/prompt-guide.md`). Our audit found OpenEMR's per-patient access check
unimplemented (returns "allow" unconditionally), so the interactive surface
holds a SMART token bound to one patient and one user, while the preparer
holds a separate read-only, fully audit-logged credential. The governing
failure rule: **the system may be unavailable; it may never be silently
wrong.**

---

## 1. Where the agent lives

Three components, one untouched EHR.

- **OpenEMR fork** — the system of record. We add exactly one thing to it: a
  custom module (`oe-module-clinical-copilot`) that injects the brief card
  into the patient summary (via `SectionEvent`/`CardRenderEvent`), registers
  the SMART app, and listens for check-in. We modify no core data structures
  (`AUDIT.md` fences F2/F3).
- **Sidecar service** — Node.js + Fastify + Zod, deployed beside the EHR. It
  owns the agent runtime, the preparation pipeline and its queue, the fact
  store, the chat loop, and the citation gate. It exists as a separate service
  precisely because OpenEMR cannot run long AI work inline (no async queue,
  `AUDIT.md`) and because coupling the AI's release cycle and failure domain
  to a 20-year-old PHP monolith would be a liability.
- **React panel** — embedded in the patient chart through the module,
  SMART-launched. Reuses the design system of the prototype Dan validated
  (Tailwind/shadcn).

Trust boundary: OpenEMR, sidecar, PostgreSQL, Redis, object storage, and
self-hosted Langfuse all sit inside one deployment boundary; the only crossing
is the BAA-covered call to the model provider.

## 2. How it accesses patient data

- **Reads via FHIR R4.** The preparer pulls Patient, Condition,
  Medication[Request|Statement], AllergyIntolerance, Encounter, Observation,
  DiagnosticReport, and DocumentReference. (Lab results are FHIR-only in this
  fork — `AUDIT.md` — which is why we go FHIR-first.)
- **Derived fact store.** Preparation writes typed facts to PostgreSQL. This
  store is never a second source of truth: it can be wiped and rebuilt from
  the record at any time, which is also what makes rollback safe by
  construction.
- **No live EHR reads in the chat hot path.** Chat reasons over the prepared
  fact bundle, not the live record — the source of the latency guarantee.
- **Scans** live in object storage, referenced (with clinical context) from
  the fact store; the preparer pre-selects and pre-fetches the visit-relevant
  images so the imaging toggle is sub-second.

## 3. Authorization boundaries

Multi-user clinical settings are the norm, and the audit's central finding
(`AUDIT.md` S1: per-patient access check unimplemented) means we cannot
inherit patient-level control. We construct it — two tasks, two credentials,
each minimally scoped:

> **Implementation status (2026-07-09).** This dual-credential model is the
> committed architecture, and the interactive half now exists in code. The
> **background preparer** credential is built (read-only `client_credentials`
> SMART Backend Services, RS384 JWT). The **interactive patient-bound
> enforcement** landed in **Wave AZ** (`docs/execution/execution-plan.md`): the
> sidecar is now a SMART resource server that verifies the caller's token and,
> through one global policy-enforcement point, 401s the unauthenticated, **403s
> any request whose bound patient ≠ the requested patient**, and gates provider
> actions by role (physician / nurse / resident). Two token paths feed one
> verifier that dispatches strictly on the JWT `alg` (the alg-confusion
> defense): RS256 OpenEMR SMART tokens (signature verified against the EHR's
> JWKS, then `/introspect` for the authoritative bound patient — it is not in
> the JWT) and HS256 sidecar dev tokens (the standalone demo/grading path).
> Enforcement is gated by `AUTH_MODE` (default `off` so the open demo keeps
> working; `enforced` turns on 401/403 — activation runbook §D) and is covered
> by unit tests. The remaining live step is the browser SMART EHR-launch itself
> (OpenEMR module → `launch/patient` → code exchange); the dev-login path
> exercises the full model — including the cross-patient 403 — without it.

1. **Interactive surface** (brief + chat + scans): a SMART-on-FHIR EHR-launch
   token bound to **one patient and one logged-in user**. If the agent is ever
   manipulated — a crafted question, malicious text inside a referral
   document — it *structurally* cannot reach another patient. The credential
   is the boundary, not the model's judgment.
2. **Background preparer**: a separate **read-only** client-credentials token,
   used before any doctor session exists. The honest tradeoff: it can read
   across the practice's patients because preparing today's schedule requires
   it. Mitigations — read-only, scoped to the preparation pipeline, never
   touching the interactive surface, and every access written to OpenEMR's own
   `api_log` with identity and timestamp (`AUDIT.md` Compliance).

**Role shapes capability, not just access.** The EHR knows whether the user is
a physician or a technician, and the agent inherits it: verifying a
medication, allergy, condition, clinical finding, imaging finding, or
procedure requires a physician session; social history, family history,
patient goals, and chief complaint are verifiable by delegated staff. Resident
supervision (verify-then-countersign) slots into the same mechanism —
designed, deferred past this week.

## 4. Verification & trust

Governing principle: **the agent may only assert what the record supports;
everything else must be phrased as absence or uncertainty.** This is exactly
what Dan requires of a partner he stays responsible for.

- **Typed facts** carry `{ content · source pointer · confidence ·
  verification status (who, in what role) · laterality }`.
- **Source attribution:** the chat model answers using only prepared facts and
  attaches each fact's citation to each claim.
- **Domain-constraint enforcement, two layers.** (a) A **deterministic
  citation gate** — code, not a model — runs between generation and display
  and verifies every citation resolves to a real record entry; an unsourced
  claim is blocked and rewritten as absence, by construction. (b) **Clinical
  rules are arithmetic:** hydroxychloroquine toxicity = daily dose × days vs.
  published thresholds; treat-and-extend = imaging outcomes correlated with
  injection intervals. The model presents these results; it never performs the
  calculation, so every number is hand-checkable.
- **Where verification happens, and its blind spot.** The gate sits after
  generation and before display — the one point where every claim exists in
  final form but nothing has reached the user. It guarantees *provenance* (a
  real source for every claim), not perfect *interpretation* (a model can
  still summarize a cited fact clumsily). Mitigations: the source is one click
  from every claim; the eval suite measures faithfulness against ground truth.

## 5. The agent's surface (traced to users)

**One conversational agent with two moments.** *Proactive:* the preparation
run in the waiting gap — its output, the brief, is the agent's opening move.
*Interactive:* the multi-turn, tool-invoking conversation that continues from
it. The core interface is the conversation; the brief is what the agent has
already done by the time the physician starts talking. Surface area is set by
user need, not technical interest:

- **Multi-turn conversation** → UC-2 (iterative verification), UC-8 (imaging
  drill-down thread), UC-9 (recommendation-shaped asks). Conversations persist
  server-side and replay across reloads; history rides turn to turn while the
  full document set re-attaches to only the newest turn, so context carries
  without compounding. Verification is a *thread* — each answer sets the next
  question; a search box drops that context every query.
- **Eight read-only tools, patient-scoped by construction** (each executes over
  the launch patient's bundle only): `get_full_document` ·
  `get_measurement_trend` · `compare_scans` (the deterministic comparison
  engine) · `get_imaging_overview` (the analytics rail's own derived imaging
  block, so chat and rail quote one source of truth) · `describe_scan`
  (attaches the stored scan's pixels for a bounded visual read, quarantined as
  "AI visual observation (not from the record)": never citable,
  morphology-only, banner on any reply that used it) · `check_med_risk` (the
  AAO arithmetic) · `search_record` ·
  `get_open_questions`. → UC-8 (trend → comparison chaining), UC-9 (attributed
  engine relays), UC-2 (source drill-down), UC-6 (the pixel-level read). Every
  tool input/output is
  Zod-validated — the contract is the source of truth, and a malformed payload
  is rejected before it propagates. A failing tool returns a structured error
  the model recovers from; the loop caps at four rounds before a final,
  tool-free answer is forced; tool activity streams into the panel as it
  happens — tool use is visible, not claimed. The toolset cannot write to the
  record, order anything, or reach outside the launch patient (fact
  verification is a separate, role-gated REST action beside the chat).
- **The brief** → UC-1 (the anti-template): precomputed so the agent's opening
  move opens in under a second.
- **Thought partner, never prescriber** → UC-9 and the non-goals. The agent
  never originates treatment/dosing/diagnosis direction; a recommendation-
  shaped ask gets the reframe — record facts cited, engine/guideline output
  attributed in the same sentence, questions worth weighing. Enforced at three
  layers: prompt hard rule, a deterministic prescriptiveness lint on every
  reply (surfaced and counted like citation failures), and published evals
  (`docs/prompt-guide.md`).
- **Contradiction surfacing** → UC-3; **medication-risk computation** → UC-4;
  **interval guidance** → UC-5; **imaging toggle** → UC-6; **patient goals** →
  UC-7.
- **One agent, no orchestration framework, no multi-agent.** The control flow
  is one tool-using conversation loop plus its proactive preparation pipeline —
  simple enough to own outright. Frameworks add abstractions to debug without
  adding capability; extra agents add latency to the one surface where latency
  is the constraint.

## 6. Models & latency

Two tiers, a consequence of the design rather than a preference:

| Surface | Model | Latency target | Why achievable |
|---|---|---|---|
| Brief open | — (stored read) | < 1 s | Precomputed in the waiting gap |
| Scan toggle | — (pre-fetched) | < 1 s | Images pre-selected during prep |
| Chat, first token | Haiku 4.5 | < 2 s | Small prepared input; streams |
| Chat, full answer | Haiku 4.5 | < 10 s | Nothing searched/re-read in hot path |
| Preparation / patient | Sonnet 5 | ≤ ~5 min | Hidden inside the 5–20 min gap |

## 7. Observability

Every request carries a **correlation ID** from the doctor's click through
every tool call, model call, and record access — so "what did the agent do, in
what order, how long did each step take, what did it cost" reconstructs from
logs alone (the PDF's four required questions). A self-hosted **Langfuse**
dashboard (traces never leave the boundary) tracks requests, errors, p50/p95
latency per surface, tool-call and retry counts, verification pass/fail rate,
and token spend, with three alerts (p95 latency, error rate, tool-failure
rate). `/health` and `/ready` are separate; `/ready` actually checks OpenEMR,
the model provider, and Langfuse are reachable. OpenEMR's native `api_log`
gives a second, overlapping audit trail.

## 8. Evaluation

Synthetic patients ship with **planted, ground-truthed contradictions** (e.g.
two conflicting medication start dates with the recorded correct answer), so
the same corpus seeds the demo and the test suite — **every demo is a test
run**. Every test exercises a boundary (missing data, empty record, malformed
input), an invariant (100% citation validity — guaranteed by construction,
tested anyway), or a regression risk (cross-patient access attempts,
prompt-injection via document content). The **conversation loop itself is
eval-covered**: history threading into follow-up turns, tool_result payloads
byte-equal to direct engine invocation, cross-patient denial holding at turn
2+, the round cap forcing a final answer, tool-error recovery — plus the
thought-partner suite, where the prescriptiveness lint must catch every
originated-direction shape and pass the sanctioned reframe. Committed results:
`docs/execution/eval-results.md`. The suite runs on every change.

## 9. Failure modes

**The system may be unavailable; it may never be silently wrong.** Prep didn't
run → the panel says so with the last-good timestamp, never a partial brief as
complete. A tool/source fails mid-chat → the agent names what it couldn't
reach. Model provider down → chat degrades to the already-prepared brief
(which needs no live model). EHR unreachable → the panel becomes a link to the
standard chart. Missing data displays as missing — clinically meaningful in
itself. Prompt injection is treated as a certainty: referral text is data to
quote and cite, never instructions; the blast radius is capped by the
patient-bound credential, the write-free toolset, and the citation gate.

## 10. Security & compliance posture

Synthetic data only this week; the only external transmission is to the model
provider under the assumed BAA (`AUDIT.md` Compliance). Secrets live
server-side; the browser never holds a provider key; logs reference records by
identifier, not content, so observability isn't a second PHI store. **Hosting
note:** the demo runs on a PaaS (Railway) for speed and simplicity; the pilot
moves to BAA-capable infrastructure, and real-record ingestion goes behind a
de-identification pipeline (the design partner's "strip PHI at the clinic
edge" posture). The strictest zero-retention model configs exclude some newest
tiers, so model-tier and retention policy are chosen together in the pilot.

## 11. Cost & scale

Per-visit: ~$0.20–0.30 to prepare a brief + ~1¢ per chat turn ≈ **~$20 for a
70-patient day**, against ~35 minutes of reclaimed clinic time. Scaling is a
queue problem, not a model problem: the chat service is stateless, so a
500-bed hospital with 300 concurrent users is more identical instances behind
a load balancer plus a wider preparation worker pool. Inflections: ~100 users
(single host as designed) → ~1K (split the host) → ~10K (dedicated prep
workers + prompt caching + batch precompute) → ~100K (multi-tenant isolation,
which the per-patient bundle already shards naturally). Cost scales with
*visits*, not seats.

## 12. Risks & how we address them

| Risk | Mitigation |
|---|---|
| Inherited per-patient authz gap (`AUDIT.md` S1) | Constructed dual-credential model; patient-bound SMART token |
| No async queue in EHR | Sidecar owns the queue; in-EHR listener is fire-and-forget |
| Thin/empty demo data | Seed a messy, ground-truthed corpus that doubles as eval truth |
| Model error reaching the doctor | Citation gate (provenance) + arithmetic domain rules (hand-checkable) |
| Prompt injection via documents | Documents are data-to-cite; credential + write-free toolset + gate cap blast radius |
| Latency regressions | No model in the brief hot path; streaming; p95 alerts |
| Contract drift between API and UI | One Zod schema file serves both |

## What the audit changed

`AUDIT.md`'s per-patient gap → the dual-credential design. Its no-async-queue
finding → the sidecar-owned pipeline with a fire-and-forget in-EHR listener.
Its thin-data finding → seeding as a first-class unit whose corpus is also the
eval ground truth. Its strong native audit logging (`api_log` + ATNA) → a
second, platform-native audit trail we lean on rather than rebuild.

## What changes before a physician relies on this

Real-record ingestion behind a de-identification pipeline; high availability
(no single host); and clinical validation *with Dan* of the brief's
**exclusion decisions** — because the failure that worries us most is not a
wrong fact (the gate catches those) but a correctly-cited brief that buried
the one thing that mattered. That is a triage failure, invisible to provenance
checking, measurable only by physician review of what the brief left out.
