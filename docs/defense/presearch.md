# Pre-Search Checklist — Explicit Answers

*The project brief's appendix ("Pre-Search Checklist", questions 1–16 across
three phases) is a thinking aid: "use this list to ensure you've thought
through a variety of perspectives in your planning." This document answers
every item explicitly in one place. Each answer is self-contained; a **Deep
dive** pointer names the deliverable that carries the full argument. Nothing
here is new design — it collates decisions already made in `USERS.md`,
`AUDIT.md`, `ARCHITECTURE.md`, `docs/defense/architecture-defense.md`, and
`docs/defense/PRD-clinical-copilot.md`.*

**Map at a glance**

| # | Item | Primary source |
|---|---|---|
| 1 | Domain selection | `USERS.md`; `ARCHITECTURE.md` §2 |
| 2 | Scale & performance | `ARCHITECTURE.md` §6, §11 |
| 3 | Reliability requirements | `ARCHITECTURE.md` §4, §9; `AUDIT.md` Compliance |
| 4 | Team & skill constraints | this document |
| 5 | Agent framework | `ARCHITECTURE.md` §1, §5 |
| 6 | LLM selection | `ARCHITECTURE.md` §6; defense "Key architecture choices" |
| 7 | Tool design | `ARCHITECTURE.md` §5; port manifest §6 |
| 8 | Observability | `ARCHITECTURE.md` §7 |
| 9 | Eval approach | `ARCHITECTURE.md` §8 |
| 10 | Verification design | `ARCHITECTURE.md` §4 |
| 11 | Failure modes | `ARCHITECTURE.md` §9; defense "Failure modes" |
| 12 | Security | `AUDIT.md` S1–S5; `ARCHITECTURE.md` §3, §10 |
| 13 | Testing strategy | `ARCHITECTURE.md` §8; PRD Tier 1/2 units |
| 14 | Open source planning | this document |
| 15 | Deployment & operations | `deploy/railway-runbook.md`; `ARCHITECTURE.md` §7 |
| 16 | Iteration planning | PRD tiers; this document |

---

## Phase 1: Define Your Constraints

### 1. Domain Selection

**Why this domain, against the universe of EHR products that could be
built.** The obvious AI-in-EHR products are scribes (dictation → template),
coding/billing assistants, patient-facing chatbots, inbox triage, and
standalone diagnostic imaging tools. We rejected the whole scribe-adjacent
category on our design partner's founder testimony — Dan built and sold the
category-leading ophthalmology EHR, and his diagnostic test for teams that
misunderstand the opportunity is exactly that framing: *"They're building,
quote, an AI scribe on top of a template system. No, I don't want to be
involved in this."* A scribe makes it easier to pour more text into notes;
the actual disease is on the *read* side. His foundational complaint, in his
words: *"20 pages where one page would have done"* — *"you looked at the
screen, it's just loaded with information. 90% of it is not relevant."*

That yields our three core assertions, which precede any feature list:

1. **This is a presentation failure, not a data failure.** The record
   already holds what the doctor needs; templates buried it. The product is
   relevance filtering — per patient, per provider, per visit. The one-page
   brief is the *anti-template*, and Dan explicitly warns against rebuilding
   templates with AI.
2. **The consumption window is ~90 seconds, so latency is the binding
   constraint** on every interactive surface. Any design that searches,
   re-reads, or "thinks" while the doctor stands at the door has already
   failed.
3. **In this specialty, imagery is where the value concentrates.** Retina
   runs on scans — *"the image tells the whole story — at least 90, 95% of
   the story is in those images"* — yet imaging is disconnected from the
   clinical record, to the point that Dan photographs his own monitor to ask
   a consumer chatbot about scans. Images must be one toggle away, chosen
   for the visit, annotated with clinical context ("taken six weeks after
   their last injection").

**Why ophthalmology/retina specifically:** an image-driven, high-volume
specialty (~70 visits/day makes minutes-per-patient the economics), a
referral-heavy intake with genuinely fragmented multi-source history (the
fax pathway is real and current), and — decisively — a design partner who is
simultaneously the target user, a domain founder, and our ground truth for
what belongs on one page.

**What specific use cases will you support?** The seven in `USERS.md`
(UC-1–UC-7) follow from the assertions rather than preceding them: the
90-second brief (assertion 1), iterative chat drill-down (assertions 1+2),
contradiction surfacing across fragmented sources, auto-computed
medication-toxicity risk, treat-and-extend interval guidance, the imaging
toggle (assertion 3), and patient-goal-aware care. The medication-risk
case earns flagship status not because our prototype had a calculator but
because it is Dan's every-visit grind and stated fear: *"I've got to go
through the system of trying to calculate what their total risk factor is…
every time they come back into the office"* and *"it kind of scares me to
death that I'm missing a subtle toxicity."* Non-goals are equally explicit:
the agent never recommends treatment, never writes to the record, never
orders anything.

**What are the verification requirements for this domain?** The strictest
available: every clinical claim shown to a physician must carry a resolvable
citation into the record (enforced by a deterministic gate — code, not a
model), every clinical number must come from hand-checkable arithmetic
rather than model generation, and fact verification is role-gated (a
physician verifies medications, allergies, conditions, findings; delegated
staff may verify social history, goals, chief complaint). Source-reliability
weighting is the design partner's own requirement — *"this source is
typically highly accurate. This one is questionable… has to be weighted
differently as you bring it in."* Anything unsupported by the record must be
phrased as absence or uncertainty.

**What data sources will you need access to?** OpenEMR's FHIR R4 API only:
Patient, Condition, MedicationRequest/MedicationStatement,
AllergyIntolerance, Encounter, Observation, DiagnosticReport,
DocumentReference. (The audit found lab results are FHIR-only in this fork,
which settled FHIR-first.) Scans live in object storage referenced from the
fact store. This week the corpus is synthetic and seeded by us; no real PHI.

*Deep dive: `USERS.md` (Dan and UC-1–7); `ARCHITECTURE.md` §2; defense "The diagnosis" and "What ophthalmology specifically demands".*

### 2. Scale & Performance

**Expected query volume?** Design point is one retina practice's day: ~70
visits. Each visit costs one preparation job (a handful of model calls) plus
a few chat turns — order of a few hundred model calls per clinic-day.
Preparation is elastic: it hides inside the 5–20 minute check-in-to-doctor
gap, so bursts widen the worker pool, not the latency budget.

**Acceptable latency for responses?** The budget is derived from the
90-second window, not aspiration: brief open **< 1 s** (stored read, no
model in the hot path); scan toggle **< 1 s** (pre-fetched); chat first
token **< 2 s** (streaming Haiku over prepared facts); chat full answer
**< 10 s**; preparation **≤ ~5 min** per patient, invisible inside the gap.

**Concurrent user requirements — and what scaling looks like
architecturally.** Two properties make scale a solved-shape problem rather
than a redesign: the chat/API tier is **stateless** (all per-patient state
is the prepared fact bundle in Postgres), and the workload **shards
perfectly by patient** — no query ever joins across patients, so there is
no cross-tenant data gravity. Scaling is then a staged widening, with the
hot path unchanged at every stage (the brief is a stored read everywhere):

- **One clinic (pilot).** Everything colocated beside the practice's EHR:
  one sidecar, one Postgres, one queue. Single-tenant, 1–5 concurrent
  users. This is what Tier 1 deploys.
- **A practice group (tens of clinics — e.g., a ~30-surgeon retina group).**
  Two options: (a) *stack-per-clinic* — replicate the whole sidecar per
  site; maximal isolation, but N ops burdens and N upgrade trains; or (b)
  *shared multi-tenant sidecar* — one regional deployment, per-clinic
  OAuth credentials into each clinic's EHR, `tenant_id` row isolation in
  the fact store. We'd choose (b): statelessness makes the shared fleet
  trivial, and the per-clinic *integration* surface is credentials, not
  code. The EHR stays wherever the clinic runs it; the sidecar only ever
  speaks outbound FHIR.
- **Hundreds of clinics (a national specialty network — ~300 physicians).**
  Split control plane from data plane: a stateless chat/API fleet behind a
  load balancer; preparation workers autoscaling on queue depth (the
  elastic load — clinic mornings arrive in waves across time zones);
  Postgres partitioned per tenant (or schema-per-tenant) with per-tenant
  encryption keys; Redis clustered; per-tenant observability and cost
  rollups. Prompt caching and batch precompute start to matter — system
  prompts and rubric text are shared across tenants, so cached-input
  pricing compounds.
- **Thousands of clinics / multi-EHR.** The deliberate payoff of the
  integration choice: the sidecar touches **FHIR R4 + SMART-on-FHIR only**
  — never OpenEMR internals — so the identical architecture attaches to any
  US Core-certified EHR (the ONC certification universe: the specialty
  incumbents, Epic, and the rest). At this scale the deployment becomes
  regional **cells** (data residency + blast-radius isolation), a thin
  routing/control plane above them, and per-cell observability. Nothing in
  the agent, the fact schema, or the latency budget changes.

**Cost constraints for LLM calls?** ~$0.20–0.30 per prepared brief (Sonnet 5
deep read) plus ~1¢ per chat turn (Haiku 4.5) ≈ **~$20 per 70-patient day**,
against ~35 minutes of reclaimed clinic time — an easy trade at any margin.
Cost scales with *visits*, not seats or clinics; at network scale, model
spend is dominated by preparation, which is batchable and cache-friendly
(both carry provider discounts), so unit cost *falls* with scale.

*Deep dive: `ARCHITECTURE.md` §6, §11; defense "Cost & scale, in numbers".*

### 3. Reliability Requirements

**What's the cost of a wrong answer in your domain?** As high as it gets: a
silently wrong clinical fact can direct patient care. The costs are
asymmetric — unavailability costs minutes; silent wrongness costs trust and
potentially safety. Hence the governing rule stated in every design doc:
**the system may be unavailable; it may never be silently wrong.**

**What verification is non-negotiable?** (a) 100% citation validity — the
deterministic gate between generation and display blocks any claim whose
citation does not resolve to a real record entry, by construction. (b) No
model-generated numbers — toxicity and interval math is deterministic code.
(c) Missing data displays as missing, never papered over.

**Human-in-the-loop requirements?** The physician *is* the loop: the agent
retrieves, organizes, computes, and cites — it never recommends. Fact
verification is an explicit human act, role-gated as above, recorded with
who/when/role. Resident supervision (verify-then-countersign) is designed
into the same mechanism and deliberately deferred past this week.

**Audit/compliance needs?** Every record access lands in OpenEMR's native
`api_log` (with ATNA available) — an audit trail the platform already does
well, which we lean on rather than rebuild. Every request carries a
correlation ID through tools, model calls, and record reads. This week is
synthetic-data-only; the pilot posture (BAA-covered model calls, BAA-capable
hosting, de-identification at the clinic edge) is recorded in
`ARCHITECTURE.md` §10 and `AUDIT.md` Compliance.

*Deep dive: `ARCHITECTURE.md` §4, §9, §10; `AUDIT.md` "Compliance & regulatory audit".*

### 4. Team & Skill Constraints

**Familiarity with agent frameworks?** Deliberately not load-bearing. This
is a solo build (with AI pair-programming) on a one-week clock, so the plan
optimizes for one person's review bandwidth: the agent is a direct
Anthropic-SDK loop plus five closed tools — no LangChain/LangGraph-class
framework. The reasoning (argued in `ARCHITECTURE.md` §5) is that frameworks
add abstractions to debug without adding capability; the skill constraint
and the architecture argument point the same direction.

**Experience with your chosen domain?** The builder is not a clinician. That
gap is closed by the design partner — a retina surgeon with 35 years in
practice who founded the EHR that leads his specialty — whose discovery
sessions define the use cases, the brief's information hierarchy, and the
acceptance bar ("defensible to Dan"). Clinical arithmetic comes from
published sources (AAO dosing thresholds), never improvised.

**Comfort with eval/testing frameworks?** Strong on conventional
fixture-based testing (the stack's standard runners), no dependence on
hosted eval platforms. That shaped two choices: evals are plain fixtures
with ground truth planted in the seeded corpus (no eval-platform learning
curve), and observability is self-hosted Langfuse rather than a SaaS
platform. TypeScript end-to-end was likewise chosen where skill and reuse
align: it is the strongest available stack *and* the prototype's validated
calculators port unchanged. The near-zero starting depth in OpenEMR's PHP
internals is mitigated structurally — the sidecar bolt-on touches the
monolith at exactly one module, and the brownfield review process that
produced `AUDIT.md` is committed to the repo as a reusable skill.

*Deep dive: this document (canonical); rationale echoes in `ARCHITECTURE.md` §5 and the defense's "Key architecture choices".*

---

## Phase 2: Architecture Discovery

### 5. Agent Framework Selection

**Single agent or multi-agent architecture?** Single agent, stated as a
decision with its rejected alternative: control flow is a linear preparation
pipeline plus one tool-using chat loop. Multi-agent was rejected because
extra agents add latency to the one surface where latency is the binding
constraint, and add coordination failure modes without adding capability
for this task shape (retrieve → organize → cite).

**State management requirements?** Three stores, each with one job: a
PostgreSQL **fact store** holding typed facts — explicitly a *derived view*,
wipeable and rebuildable from the record, so the EHR remains the single
source of truth; **BullMQ on Redis** for preparation queue state; and the
conversation itself, which reasons over the prepared fact bundle (no live
EHR reads in the chat hot path).

**Tool integration complexity?** Low by design: five closed, read-only
tools (fetch fact bundle · drill into a fact's source · run calculators ·
list gaps/contradictions · mark fact verified), every input and output
validated against Zod schemas shared with the UI, so a malformed payload is
rejected before it propagates and contracts cannot drift.

*Deep dive: `ARCHITECTURE.md` §1, §5.*

### 6. LLM Selection

**OpenAI vs Claude vs open source?** Claude via the Anthropic API, under a
healthcare BAA. Grounds: BAA availability for the pilot path, long-context
quality for whole-record reads, and strong structured-output behavior for
typed fact extraction. Open-source/local models were rejected *for this
week* on velocity and quality-per-hour grounds; turnkey "medical AI"
products were rejected because the task is retrieving, organizing, and
citing *this record* — not generating medical knowledge.

**Structured output support requirements?** Hard requirement. The deep
reader emits typed facts (`content · source pointer · confidence ·
verification status · laterality`) validated against Zod schemas; invalid
extractions are rejected and retried, never silently coerced.

**Context window needs?** One patient's prepared record fits comfortably in
a frontier context window. This single observation eliminates the hardest
retrieval problem: no vector database, no chunking pipeline, no relevance
tuning — whole-patient context instead (a rejected-alternative argued in
the defense).

**Cost per query acceptable?** Yes with headroom: two tiers match cost to
the job — Sonnet 5 where depth matters and time is free (preparation,
$0.20–0.30/patient), Haiku 4.5 where speed matters and the input is small
(chat, ~1¢/turn). See item 2 for the day-level economics.

*Deep dive: `ARCHITECTURE.md` §6, §11; defense "Key architecture choices — and the alternatives we rejected".*

### 7. Tool Design

**What tools does your agent need?** Exactly five (item 5 lists them). The
set is closed and write-free: the agent cannot write to the record, order
anything, or reach outside the launch patient — capability boundaries are
structural, not behavioral.

**External API dependencies?** Three, all server-side: OpenEMR's FHIR R4
API (OAuth2/SMART-on-FHIR), the Anthropic API (the only call that crosses
the deployment boundary, BAA-covered), and object storage for imaging. The
browser never holds a provider key.

**Mock vs real data for development?** Synthetic-but-messy seeded corpus,
converted from the validated prototype's seed shapes into OpenEMR (port
manifest §6), with **planted, ground-truthed contradictions** — so the same
corpus is simultaneously demo data, development fixture, and eval ground
truth. No real PHI at any point this week.

**Error handling per tool?** Zod-validate at both edges; failures produce
typed errors that the agent must *name* to the user ("I couldn't reach the
imaging store"), never absorb silently. Tool failures land in the trace
with the correlation ID and count toward the tool-failure alert threshold.

*Deep dive: `ARCHITECTURE.md` §5, §9; `docs/research/second-opinion-port-manifest.md` §6.*

### 8. Observability Strategy

**LangSmith vs Langfuse vs Braintrust vs other?** Self-hosted **Langfuse**.
The deciding constraint is data boundary, not features: traces of clinical
conversations are PHI-adjacent, and a SaaS observability platform would be a
second place patient-derived text leaves the deployment boundary. Langfuse
self-hosted keeps traces inside; LangSmith/Braintrust were rejected on that
single axis.

**What metrics matter most?** The ones that guard the two promises (fast
and never-silently-wrong): p50/p95 latency per surface (brief open, scan
toggle, chat first token, chat complete), error rate, tool-call and retry
counts, **verification pass/fail rate at the citation gate**, and token
spend per visit.

**Real-time monitoring needs?** Three alerts — p95 latency, error rate,
tool-failure rate — plus split `/health` (process up) and `/ready`
(OpenEMR, model provider, and Langfuse actually reachable) endpoints.

**Cost tracking requirements?** Token spend is recorded per correlation ID
and rolled up to per-visit and per-day cost, so the ~$20/day figure in item
2 is continuously measured rather than estimated.

*Deep dive: `ARCHITECTURE.md` §7.*

### 9. Eval Approach

**How will you measure correctness?** As faithfulness to known ground
truth. The seeded corpus plants contradictions and facts *with recorded
correct answers* (e.g., two conflicting medication start dates plus which
one is right), so correctness is checkable mechanically: did the brief
surface the contradiction, did the citation resolve, did the calculator
produce the golden number. **Every demo is a test run** — demo corpus and
eval corpus are the same corpus.

**Ground truth data sources?** The authored synthetic corpus (for
extraction, contradiction, and citation checks) and published clinical
thresholds (AAO hydroxychloroquine dosing) for calculator goldens.

**Automated vs human evaluation?** Automated for everything provenance can
reach: citation validity (must be 100%), calculator goldens, boundary cases
(missing data, empty record, malformed input), and security invariants
(cross-patient attempts denied, injection corpus resisted). Human — the
design partner — for the one failure automation cannot see: **exclusion
quality**, i.e., a correctly-cited brief that buried the one thing that
mattered. That review is a standing pilot-phase activity.

**CI integration for eval runs?** The suite runs on every change and gates
deploy; the repo's CI already validates commits and code quality, and the
eval fixtures join that pipeline with the Tier 1 sidecar (PRD U1.x).

*Deep dive: `ARCHITECTURE.md` §8; PRD Tier 1 eval unit.*

### 10. Verification Design

**What claims must be verified?** Every clinical assertion shown to the
user, in both the brief and chat. Two enforcement layers: the deterministic
citation gate (every claim must carry a citation that resolves to a real
record entry — unsourced claims are blocked and rewritten as absence, by
construction) and deterministic arithmetic for every clinical number (the
model presents results; it never computes them).

**Fact-checking data sources?** The record itself. This system verifies
*provenance* — "the record supports this claim" — not external medical
truth; that scoping is what makes 100% verification achievable rather than
aspirational. The gate's honest blind spot is interpretation (a model can
summarize a cited fact clumsily); mitigations are one-click source access
on every claim and the faithfulness evals in item 9.

**Confidence thresholds?** Every typed fact carries confidence and
verification status. Low-confidence extractions render as flagged/uncertain
language, never as clean assertions; human verification (role-gated)
upgrades status explicitly and auditably.

**Build-status honesty (2026-07-09).** The verification gate (source
attribution) and domain-constraint enforcement (AAO dosage/duration engine)
are implemented and eval-covered; EHR-origin facts pass the same gate. The
*authorization* half of "verification & trust" — patient-bound SMART
enforcement + physician/nurse/resident roles — is the one designed-but-not-yet
-enforced piece, tracked as Wave AZ (`docs/execution/execution-plan.md`); the
sidecar API is unauthenticated at the demo boundary until it lands. Chat tool
invocation (item 7) is moving from bundle-preloaded to a real Haiku tool-use
loop (Wave TC), each tool read-only, patient-scoped, and Zod-contracted.

**Escalation triggers?** Contradictions are *surfaced, never auto-resolved*
(UC-3) — the physician adjudicates. Gate failure → claim becomes a stated
absence. Repeated tool failure → degrade per the ladder in item 11 and say
so. Anything touching treatment choice → outside the agent's surface
entirely (non-goals).

**How citations appear in the UI.** Every claim in the brief and every chat
answer renders with a small inline **citation chip** (a numbered bubble at
the end of the claim, plus laterality OD/OS/OU and verification-state badges
where relevant). Clicking a chip opens a **source card** — not a raw
document dump: the source's type badge (referral letter, pharmacy record,
lab report, prior visit note, intake transcript…), its date, its attribution
(*who said it* — patient, physician, pharmacist, external provider — which
is how patient-reported facts stay visibly distinct), and the **verbatim
excerpt with the cited span highlighted** in its surrounding context. From
the card, one more click deep-links to the full source document (the
panel's Sources tab, which lists every document preparation consumed, each
carrying its reliability weighting). The mechanism under the chip is the
same `CitationRef` object the gate verifies — source document ID +
character-range excerpt + attribution — so the UI affordance and the
verification primitive are one thing: a chip *cannot render* unless its
excerpt resolves inside a stored source document. In chat, the model emits
citations in a strict inline token format that the sidecar parses back into
the same chip component, so brief and chat share one citation system.

*Deep dive: `ARCHITECTURE.md` §4; `USERS.md` UC-2/UC-3; port manifest §2
(`CitationRef`), §4 (brief tabs incl. Sources), §5 (chat citation contract).*

---

## Phase 3: Post-Stack Refinement

### 11. Failure Mode Analysis

**What happens when tools fail?** The agent names what it couldn't reach
and answers from what it has; the failure lands in the trace and counts
toward alerts. A partial brief is never presented as complete — if prep
didn't run, the panel says so with the last-good timestamp.

**How to handle ambiguous queries?** State the ambiguity and ask, or answer
with explicit uncertainty — the phrasing rules from item 10 apply to
questions as much as facts. The agent structurally cannot "guess across
patients": the credential binds it to the launch patient.

**Rate limiting and fallback strategies?** Two different regimes.
Preparation is elastic — queue backpressure and retry with jitter are free
because the deadline is "before the doctor enters," minutes away. Chat is
not — so its fallback is architectural: the already-prepared brief needs no
live model, meaning a model-provider outage degrades chat but never the
core deliverable.

**Graceful degradation approach?** A ladder, worst-case last: full
experience → brief-only (model down) → "prep unavailable, here's the
last-good brief with timestamp" → panel becomes a link to the standard
chart (EHR unreachable). Every rung tells the user which rung they're on.

*Deep dive: `ARCHITECTURE.md` §9; defense "Failure modes".*

### 12. Security Considerations

**Prompt injection prevention?** Treated as a certainty, not a risk:
referral letters and documents are *data to quote and cite, never
instructions*. And because prevention-by-prompt is unreliable, the blast
radius is capped structurally: the interactive credential is bound to one
patient and one user, the toolset is write-free, and the citation gate
filters output. A manipulated agent has nothing to exfiltrate beyond the
chart already on screen and no ability to write anywhere.

**Data leakage risks?** One deployment boundary (OpenEMR, sidecar,
Postgres, Redis, object storage, Langfuse); the only crossing is the
BAA-covered model call. Logs and traces reference records by identifier,
not content, so observability never becomes a second PHI store. The browser
holds no secrets.

**API key management?** Server-side only, injected via the platform's
variable store (Railway Variables for the demo; a dedicated secret manager
in the pilot). Two OpenEMR credentials with least privilege each: the
patient-bound SMART token and the read-only system client — the
dual-credential design that exists *because* the audit found OpenEMR's
per-patient check unimplemented (S1).

**Audit logging requirements?** Covered in item 3: native `api_log`/ATNA on
every record access plus correlation-ID traces in Langfuse — two
overlapping trails, one platform-native, one agent-native.

*Deep dive: `AUDIT.md` S1–S5; `ARCHITECTURE.md` §3, §10; defense "Authorization & access control".*

### 13. Testing Strategy

**Unit tests for tools?** Yes — calculators against golden numbers from
published thresholds, Zod schema acceptance/rejection at every tool edge,
and the citation gate itself (including the tested-anyway invariant that
gated output has 100% citation validity).

**Integration tests for agent flows?** The preparation pipeline against
seeded FHIR data (extraction → fact store → brief), the chat loop against
recorded model fixtures, and the SMART launch handshake end-to-end.

**Adversarial testing approach?** The injection corpus is *embedded in the
seeded documents* (a referral letter that tries to redirect the agent), so
adversarial cases run in the same suite as functional ones; cross-patient
access attempts must be denied by the credential, and that denial is a
test, not a hope.

**Regression testing setup?** The eval suite *is* the regression net:
fixtures are pinned, every flagged output becomes a new fixture (item 16),
and the suite runs in CI on every push — the same discipline the upstream
repo already applies to its PHP code (PHPStan level 10, full test suites in
CI), extended to the agent.

*Deep dive: `ARCHITECTURE.md` §8; PRD Tier 1/2 unit test expectations.*

### 14. Open Source Planning

**What will you release?** Everything in this repository is already public:
the fork (with its Railway deploy artifacts), the co-pilot module when it
ships, the sidecar, the seeded corpus and eval fixtures, and all planning
documents. The demo deployment URL is public by requirement.

**Licensing considerations?** OpenEMR is GPL-3, so the fork and any
modifications to it (the `oe-module-clinical-copilot` module included) are
necessarily GPL-3 — not a choice, an obligation, and one we're glad to
meet. The sidecar shares no OpenEMR code and communicates only over HTTP,
so it is arguably a separate work; while it lives in this repository we
release it under GPL-3 alongside the rest for simplicity and revisit only
if it is ever extracted as a standalone product. No proprietary components,
no dual licensing this week.

**Documentation requirements?** The README fronts a deliverable index; the
runbook (`deploy/railway-runbook.md`) makes the deployment reproducible
click-by-click; `ARCHITECTURE.md`/`AUDIT.md`/`USERS.md` document the system;
the module and sidecar each get a README as they land (PRD Tier 1).

**Community engagement plan?** Honest scope: none this week. The natural
long-term path is OpenEMR's own module ecosystem — the co-pilot integrates
through public module events, which is exactly the shape the community
accepts. Independently upstreamable artifacts already exist: the Railway
boot fixes (DB-wait wrapper, dev-mode rsync assumption) and the S1
per-patient authorization finding are candidates for upstream issues/PRs.

*Deep dive: this document (canonical); `AUDIT.md` notes the GPL-3 license context.*

### 15. Deployment & Operations

**Hosting approach?** Demo: a Railway project — OpenEMR app service (fork
source baked into an `openemr/openemr:flex`-derived image) + MariaDB over
private networking; Thursday adds sidecar, PostgreSQL, Redis, and Langfuse
as sibling services in the same project. Pilot: BAA-capable infrastructure;
the hosting posture and its honest limits are recorded in
`ARCHITECTURE.md` §10.

**CI/CD for agent updates?** Push-to-branch auto-deploys (already live and
demonstrated on this deployment); the repo's CI validates commits, style,
and static analysis; the eval suite joins as a deploy gate with Tier 1.

**Monitoring and alerting?** Item 8: Langfuse dashboard, three alerts,
split health/readiness probes, plus Railway's own service-level
crash/restart visibility, which surfaced every boot issue during initial
deployment.

**Rollback strategy?** Three independent levers, safest first: the EHR is
untouched, so disabling the module removes the co-pilot *without a trace*;
the fact store is a derived view, so schema or pipeline mistakes are fixed
by wipe-and-rebuild from the record, never by data surgery; and deploys are
image-based, so the platform rolls back to the previous image in one
action.

*Deep dive: `deploy/railway-runbook.md`; `ARCHITECTURE.md` §7, §10, §2 (derived view).*

### 16. Iteration Planning

**How will you collect user feedback?** Two channels. Structured: a
lightweight flag control on every brief section and chat answer, writing an
annotation onto the correlation-ID trace in Langfuse — so feedback arrives
already attached to the exact model calls and facts that produced the
output. Unstructured: a standing weekly review with the design partner,
walking real (synthetic) briefs against their charts, focused on the
question automation can't answer — *what did the brief leave out, and what
is noise?*

**Eval-driven improvement cycle?** Every flagged output is converted into
an eval fixture with a recorded correct answer; the suite only grows.
Prompt or model changes ship exclusively through a green suite — the same
gate as code. This makes quality monotonic by construction rather than by
vigilance.

**Feature prioritization approach?** The PRD's tier structure is the
prioritization instrument: tiers are re-scored after each design-partner
session, and two invariants outrank every feature — the latency budget and
the never-silently-wrong rule. A feature that threatens either is rejected
regardless of appeal (that discipline is why multi-agent and vector search
are already out).

**Long-term maintenance plan?** Kept cheap structurally: the fork tracks
upstream OpenEMR with the module as the only touchpoint (upgrade-safe by
design); the fact store's derived-view property makes schema evolution a
wipe-and-rebuild, not a migration project; model versions are pinned and
upgraded only through eval-gated changes; and the brownfield review skill
committed to `.claude/skills/chesterton/` makes future audits of the moving
upstream repeatable.

*Deep dive: PRD §5 (tiers), §7 (open questions), Tier 3 roadmap; `ARCHITECTURE.md` §8.*
