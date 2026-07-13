# Clinical Co-Pilot — Architecture Defense

**What we're building:** an AI pre-visit brief with conversational drill-down, embedded in OpenEMR, designed for ophthalmology.
**Who it's for:** a high-volume retina practice. Our design partner and first user is Dan — a retina surgeon of 35 years who sees ~70 patients a day and founded the EHR that leads this specialty today.

---

## Summary (one page)

A physician has about 90 seconds between exam rooms to answer five questions: who is this patient, why are they here, what changed, what's on file, and what matters today. Our design partner, Dan — a retina surgeon of 35 years, seeing ~70 patients a day, who founded the EHR that leads his own specialty — describes today's answer as "20 pages where one page would have done… 90% of it is not relevant." Our diagnosis: **a presentation failure, not a data failure.** The record already contains what the doctor needs; it's buried in clutter that exists for verified reasons (billing, regulatory certification, site configurability). So we change **what the doctor sees, never how the EHR stores data** — a layer above the record that cites into it and is removable without a trace.

The central idea: **move the thinking to where time is free.** After check-in, patients wait 5–20 minutes before the doctor enters. In that gap a deep-reader model (Claude Sonnet 5) reads the full record, extracts typed facts — each carrying a source pointer, confidence, verification status, and laterality — reconciles contradictions, runs medication-risk arithmetic, pre-selects this visit's scans, and assembles a one-page brief. At the door, everything is retrieval: the brief opens in under a second, scans are one sub-second toggle away (timeline, comparison, and trend/interval analytics over structured measurements, ported from the prototype Dan validated), and a chat answers follow-ups in under two seconds to first words, because a fast responder (Claude Haiku 4.5) reasons over the already-prepared facts rather than searching live. This dissolves speed-vs-completeness: completeness at preparation time, speed at read time. The brief also carries patient goals as first-class facts — care aligned to what the patient cares about, not just what bills.

Key decisions, each argued with its rejected alternative inside: a **presentation layer over a data migration** (the clutter is load-bearing; a layer is reversible — the PostgreSQL fact store is a derived view, wipeable and rebuildable); a **sidecar service over code inside the EHR** (Node.js + Fastify, speaking to OpenEMR only through its FHIR R4 API and OAuth2/SMART-on-FHIR); **TypeScript end-to-end** (the validated clinical calculators port unchanged; one Zod schema file serves API and UI, so contracts cannot drift); a **frontier model under a healthcare BAA over medical-tuned turnkey products** (the task is retrieving, organizing, and citing this patient's own record); and **whole-patient context over vector search** (one patient's facts fit in the model's context — the hardest retrieval problem never arises).

Trust is structural. A deterministic citation gate — code, not a model — sits between generation and display; an unsourced claim is blocked by construction. Domain rules are arithmetic the physician can check by hand. The stated limitation: provenance is guaranteed, interpretation is not — mitigated by one-click sources and faithfulness evals. Authorization is likewise constructed, not inherited: our audit found OpenEMR's per-patient access check unimplemented (it returns "allow" unconditionally), so the interactive surface holds a SMART launch token bound to one patient and one user, while the background preparer holds a separate read-only, fully audit-logged credential — an honest, mitigated tradeoff. Operationally: correlation IDs end-to-end, self-hosted observability, three defined alerts, and one failure rule — **the system may be unavailable; it may never be silently wrong.** Economics: ~$20 of compute per 70-patient day against ~35 minutes of reclaimed clinic time. Deliberately deferred: model interpretation of raw scan pixels (the schema already has the slot), semantic search, and recommendations — the doctor decides.

---

## The diagnosis: a presentation failure, not a data failure

A physician has about **90 seconds** between rooms to answer five questions: *who is this patient, why are they here, what changed since last time, what's on file, and what matters today.* Today's EHR answers by showing **everything** — a 20-page templated record in which, in Dan's words, "90% is not relevant."

Our core thesis: **the data is already there; it's buried in clutter.** The record faithfully stores the medications, history, and exam findings. What's broken is organization — every fact renders at equal weight on an overcrowded screen, so the physician digs through the clutter manually, on the clock, 70 times a day. And the density has causes we verified in the code: billing fields, compliance widgets, and site-configurable forms all share the physician's screen because revenue and regulation require them to exist. **So we change what the doctor sees, not how the EHR stores data.** The existing record stays intact and load-bearing; our layer sits above it, cites into it, and is removable without a trace.

## What ophthalmology specifically demands

The specialty's workflow, taken from Dan's practice, sets our requirements concretely:

- **Volume compresses time.** ~70 patients/day means every recurring delay is multiplied 70×; a 30-second wait repeated per patient costs the practice ~35 minutes of clinic time daily.
- **Follow-ups are image-driven — the 90 seconds is spent looking at scans more than reading text.** In Dan's words: *"When I'm doing my follow-ups… I'm just looking at images. Maybe I'm seeing them 10 times in a year and I'm doing one exam per year… The image tells the whole story — at least 90, 95% of the story is in those images."* Today's imaging software is disconnected from the clinical record entirely, and its fixed layouts show the same views regardless of disease. For an ophthalmology co-pilot, fast access to the right scans, in clinical context, is not a roadmap item — it is part of the core surface, and we design for it below.
- **Everything has a side.** Findings, procedures, and risks attach to the left eye, right eye, or both — laterality must be a first-class attribute on every fact, not a detail buried in prose.
- **Chronic care runs on cadence.** Treat-and-extend injection intervals and medication-toxicity monitoring (hydroxychloroquine cumulative dose — which Dan recomputes by hand every visit) are longitudinal calculations over repeated visits, not single-visit lookups.
- **Patients arrive by referral, elderly, with fragmented records** — multi-source history synthesis and unverified outside data are the norm, which is why per-fact provenance and verification status matter from day one.
- **What the patient is hoping for is clinical information too.** The brief carries patient goals as first-class, verifiable facts — the field Dan singled out in the prototype: *"you've got something in here — what she's hoping for… it's not a billing field… but it's really important."* A treatment plan reads differently when the system surfaces that the patient is a mother who wants to be back in contact lenses in two weeks for her daughter's wedding photos — care aligns to what the patient actually cares about, not just to what bills.

## The central idea: move the thinking to where time is free

Clinic workflow contains a built-in gap: after the technician checks the patient in and finishes the workup, the patient waits **5–20 minutes** before the doctor enters. Every expensive operation runs in that gap — reading the full record, extracting facts, reconciling contradictions, computing medication risks, assembling the brief. When the doctor opens the panel, serving the brief is a stored lookup: retrieval, not computation. **This is our answer to the speed-vs-completeness tradeoff: completeness is achieved at preparation time, where minutes are available; speed at read time, where only seconds are.** When preparation is incomplete, the brief says exactly what was and wasn't processed — partial coverage is displayed as partial, never silently passed off as complete, and per-fact confidence markers carry the uncertainty the rest of the way.

**Latency is the primary constraint on chat.** In a 90-second window the answer must effectively be instant, so the chat never searches or re-reads the record live — it reasons over the already-prepared facts. Two model tiers follow: a **deep reader** (thorough, slower) prepares in the gap where time is free; a **fast responder** answers from prepared facts, streaming words to the screen as they're generated.

| Surface | Latency target | Why it's achievable |
|---|---|---|
| Opening the brief | < 1 second | Precomputed; a database read |
| Toggling to scans | < 1 second | Today's relevant images selected and pre-fetched during preparation |
| Chat, first words on screen | < 2 seconds | Fast model + small prepared input; streams |
| Chat, complete answer | < 10 seconds | Nothing searched or re-read in the hot path |
| Preparation per patient | up to ~5 minutes | Hidden inside the 5–20 min waiting gap |

## The agent: shape, surface, and why conversation is the right form

The interface is a **brief-first conversational agent**: the precomputed one-page brief is the agent's opening move, and a chat thread attached to it handles everything the brief provokes. Each capability traces to an observed need of the user, not to what is technically interesting:

- **Multi-turn conversation** exists because Dan's verification behavior is inherently iterative — "has that allergy been previously verified?", "when did they actually start that medication?", "what did the referring doctor's note say?" Each answer prompts the next question; a search box or static view cannot carry that thread of context.
- **The tool set is small and closed.** The agent can: fetch the patient's prepared fact bundle; drill into a fact's source document; run the deterministic risk calculators; list known gaps and contradictions; and mark a fact verified (which records *who* verified it, in what role). It cannot write to the medical record, order anything, or reach outside the launch patient. Every tool input and output is validated against a strict, machine-checked schema — the contract, not the code, is the source of truth, and a malformed payload is rejected before it can propagate.
- **Tool chaining is allowed but shallow** (typically fetch → compute → cite), because the expensive multi-step reasoning already happened at preparation time. This is a latency decision as much as a simplicity one.
- **Why not just a dashboard?** The brief *is* the dashboard — for the 80% case it should be sufficient without a single question asked. Conversation earns its place only for the long tail the brief cannot anticipate: cross-referencing history ("was the swelling worse before or after the medication change?"), verification checkpoints, and referral-record archaeology. A system that forced those through fixed UI widgets would rebuild the template problem we exist to kill — Dan's explicit warning.
- **One agent, no orchestration framework.** The control flow is a linear preparation pipeline plus a tool-using chat loop — simple enough to own outright. An orchestration framework would add someone else's abstractions to debug and defend without adding capability; multiple coordinating agents would add latency to the one surface where latency is the constraint.

## The imaging surface: one toggle away

Because a retina follow-up is read off scans more than text, the brief carries a **single toggle to an imaging view** — the same gesture cost as switching tabs, held to the same sub-second latency target because preparation pre-selects and pre-fetches the images that matter for *this* visit (today's scan, the last comparison point, and the historical scan the disease course makes relevant — replacing the fixed same-four-images layout Dan complains imaging software imposes). The design and its analytic layer are ported from the prototype Dan validated:

- **A treatment-aware timeline** interleaves scans with clinical events, so every image is stamped with its context — *"taken 6 weeks after the last injection of Avastin."* This closes the imaging↔record disconnect Dan describes today: *"I'm taking screenshots every once in a while and sneaking back to my office to chat with ChatGPT about it… because it's so incredibly valuable."* A workflow tax that visible is the clearest demand signal in the corpus.
- **Side-by-side comparison** of any two scans, pre-loaded with the pair the preparation step judged most informative.
- **Trend analytics over measurements** already produced by the imaging devices: central retinal thickness and layer-thickness curves plotted against normal ranges, flagging gradual thinning a visit-by-visit reading misses (the early hydroxychloroquine-toxicity signature Dan says "scares me to death").
- **Treat-and-extend interval analysis**: deterministic logic correlates each scan's outcome with the interval since the preceding injection and states the finding plainly — *"stable at 8 weeks, leaked at 12 — recommend 8-week interval."* Like the dose calculator, this is arithmetic over recorded events, hand-checkable, ported unchanged from the validated prototype.

The honest boundary: everything above operates on **structured measurements and event data** the clinic already produces. Having a model interpret raw scan pixels — the capability Dan currently simulates by pasting screenshots into a chatbot — is the explicitly reserved next phase, and the schema is built for it now (every fact can carry an image link; every image carries its clinical context), so that phase adds a model, not a redesign.

## Key architecture choices — and the alternatives we rejected

**A presentation layer, not a data migration.** The alternative — restructuring OpenEMR's clinical tables around our brief — was rejected on three grounds: the current structures are load-bearing for billing and certification (changing them risks breaking what pays the clinic); a migration is one-way (a presentation layer can be turned off tomorrow); and our own thesis says the data isn't the problem. Concretely, the prepared facts live in a small companion store that is a **derived view, not a second source of truth** — wipeable and rebuildable from the record at any time, so the EHR remains the single system of record.

**A companion service beside the EHR, not code inside it.** The AI runtime is a sidecar — a Node.js service (Fastify for HTTP, Zod schemas as the tool and API contracts) deployed next to OpenEMR — that talks to the EHR only through its official, authenticated interfaces: the FHIR R4 API for clinical data, OAuth2/SMART-on-FHIR for credentials. The doctor-facing panel is a React app embedded in the patient chart through OpenEMR's own module extension points, reusing the validated prototype's design system (Tailwind + shadcn components). This keeps the EHR upgrade-safe, lets the AI layer scale and fail independently, and matches how the healthcare industry already embeds third-party apps into EHRs. The rejected alternative — building the agent inside the EHR's own PHP codebase — would couple the AI's release cycle, failure domain, and performance profile to a 20-year-old monolith, and modern AI tooling support there is thin.

**Written in TypeScript — chosen for reuse and one-language consistency.** The prototype Dan already validated contains the two most differentiated pieces of clinical logic — the hydroxychloroquine cumulative-dose calculator and the injection-interval analyzer — as self-contained JavaScript. In TypeScript those transfer essentially unchanged; in any other language they would be re-written by hand, and hand-translation risks introducing errors in exactly the logic this system exists to keep trustworthy. One language also spans the service, the doctor-facing screen, and the test suite, so the data contract between them is literally the same file — it cannot drift.

**A general frontier model under a healthcare agreement — not an off-the-shelf medical AI product.** Off-the-shelf options exist and we assessed them: model providers now sell HIPAA-ready offerings with signed Business Associate Agreements (Anthropic's Claude for Healthcare, launched January 2026, includes a click-to-accept BAA plus healthcare connectors such as Medicare coverage lookup; equivalent BAA-covered access exists through AWS Bedrock, Google Vertex AI, and Microsoft Azure/Foundry). **We use exactly that** — the Anthropic API under a BAA, as this project's brief instructs us to assume, with the two-tier split mapped to concrete models: **Claude Sonnet 5 as the deep reader** (preparation, where quality matters and time is free) and **Claude Haiku 4.5 as the fast responder** (chat, where the latency targets rule). What we deliberately *don't* use: turnkey medical AI products (scribes, medical Q&A services) or medical-fine-tuned models. Our task is not generating medical knowledge — it is faithfully retrieving, organizing, and citing *this patient's own record*, and no vendor product supplies the fact-store, provenance, and EHR-embedding layer where our actual value lives. One constraint worth naming: the strictest zero-data-retention configurations exclude some newest model tiers (which require 30-day retention), so model-tier selection and retention policy must be decided together. Purpose-built de-identification services become relevant in the later real-patient pilot phase, matching Dan's "strip PHI at the clinic edge" posture; this week runs synthetic data only.

**Context strategy: the whole patient fits.** A single patient's prepared fact bundle is small enough to hand to the model whole, so retrieval is an exact keyed lookup — no similarity search, no embedding database, no "did we retrieve the right chunk?" failure mode. This is the quiet advantage of scoping to one patient at a time: the hardest retrieval problem in AI systems simply doesn't arise. Concretely, the fact store is **PostgreSQL** (with the pgvector extension installed but unused in the hot path — headroom for the day the corpus outgrows the context: cross-patient queries, literature). Scan files live in **object storage (GCS or S3-compatible)** referenced by the fact store; the preparation queue runs on **BullMQ over Redis**, so a check-in event enqueues work without ever blocking the EHR.

**Concrete stack at a glance:**

| Component | Choice | Role |
|---|---|---|
| Embedded UI | React + Tailwind/shadcn (ported prototype design) | Brief, imaging toggle, chat — inside the patient chart |
| Sidecar service | Node.js + Fastify + Zod | Agent runtime; schemas are the contracts |
| Models | Claude Sonnet 5 (deep reader) / Claude Haiku 4.5 (chat) via Anthropic API under BAA | Two-tier split per the latency argument |
| Fact store | PostgreSQL (pgvector headroom) | Derived view of the record; wipeable, rebuildable |
| Imaging store | GCS / S3-compatible object storage | Scan files; metadata + clinical links live in the fact store |
| Queue | BullMQ on Redis | Waiting-room preparation pipeline |
| EHR integration | OpenEMR FHIR R4 API, OAuth2 + SMART-on-FHIR launch | The only doors we use |
| Observability | Langfuse (self-hosted) + structured logs w/ correlation IDs | Traces stay inside the deployment boundary |
| Deploy | Docker Compose on a single VM, Caddy for TLS | One stack beside the EHR's own containers |
| Testing | Vitest + eval corpus; k6 load tests; Bruno API collection | Unit, eval, load, and grader-runnable workflows |

## Authorization & access control

Clinical settings are multi-user by definition, and our design treats *who is asking* as a first-class input. Two tasks, two credentials, each with the minimum power its task requires:

1. **Interactive surface** (brief + chat): activates from within one patient's chart and receives a credential bound **only to that patient and that logged-in user** (the SMART-on-FHIR launch standard). If the agent is ever manipulated — a crafted question, malicious text hidden in a document — it still cannot reach other patients: **the credential is the boundary, not the model's judgment.**
2. **Background preparer**: runs before any doctor session exists, so it holds a separate read-only server credential. This is the design's honest tradeoff — the preparer can read across the practice's patients, because preparing briefs for today's schedule requires it. Mitigation: the credential is read-only, never touches the interactive surface, is scoped to the preparation pipeline only, and every access it makes is written to the EHR's own audit log with identity and timestamp.

**Role shapes capability, not just access.** The EHR already knows whether the user is a physician or a technician, and the agent inherits that: verifying a medication, allergy, or clinical finding requires a physician's session; social history or patient-goal facts can be verified by delegated staff. A resident-supervision model slots into the same mechanism (facts verified by a supervised role remain "pending" until countersigned) — designed now, deferred past this week.

The audit finding that forced this design: OpenEMR enforces *role-level* permissions correctly at its API, but its *per-patient* check is unimplemented — the function returns "allow" unconditionally. We don't inherit patient-level control; we **construct** it.

## Verification & trust

Governing principle: **the agent may only assert what the record supports; everything else must be phrased as absence or uncertainty.**

- Preparation extracts **typed facts**, each carrying a source pointer (which document, which entry), a confidence level, a verification status (who confirmed it, in what role), and laterality.
- The chat model answers **using only these facts**, attaching each fact's citation to each claim.
- A **deterministic checker — plain code, not a model —** confirms every citation points to real record text, on both paths. Preparation blocks an unsourced fact before the brief is assembled; chat withholds an unverified citation at the server, so it reaches no client at all — provenance is enforced *by construction*, not by trusting the model to behave (and not by a client-side rendering convention). Chat prose streams for latency, so enforcement is per payload: citations gate as they arrive, and the completed reply is screened at the message boundary. The file-by-file trace is `docs/VERIFICATION.md`.
- **Domain rules are arithmetic, not opinion.** Hydroxychloroquine toxicity risk = daily dose × days of exposure against published thresholds. The model presents the result; it never performs the calculation. Every number is hand-checkable.
- **Known limitation, stated honestly:** this guarantees *provenance* (every claim has a real source), not perfect *interpretation* (a model can still summarize a cited fact clumsily). Mitigations: the source sits one click from every claim, and the test suite measures faithfulness against ground truth.

## Security posture beyond authorization

- **Prompt injection is treated as a certainty, not a possibility.** Referral documents and patient-reported text are untrusted input; the agent processes them as *data to be quoted and cited*, never as instructions. The blast radius of a successful injection is capped structurally: the credential limits reach to one patient, the tool set has no write or outbound action, and the citation gate blocks fabricated output.
- **Secrets and keys** live server-side only (environment configuration on the deployment host); the browser never holds a model-provider key. Logs and traces reference records by identifier, not content, so observability doesn't become a second PHI store.
- **Adversarial evaluation is part of the test suite**: prompts that attempt cross-patient access, instruction injection via document content, and extraction of data the requester shouldn't see are standing regression tests, not one-off checks.

## Observability & operations

You cannot trust what you cannot reconstruct. Every request carries a **correlation ID** from the doctor's click through every tool call, model call, and record access — the full "what did the agent do, in what order, how long did each step take, what did it cost" story reconstructs from logs alone, and the EHR's audit log independently records our reads: two overlapping trails. A live **Langfuse** dashboard (self-hosted, so traces never leave the deployment boundary) tracks request counts, error rates, latency at the 50th/95th percentile per surface (against the targets above), tool-call and retry counts, verification pass/fail rate, and token spend. Three alerts are defined from day one: 95th-percentile latency over target, error rate over threshold, and tool-failure rate over threshold — each with a documented response. The service exposes two standard health endpoints (one answering "is the process alive," one verifying its dependencies — EHR, model provider, observability backend — are actually reachable), deploys as one container alongside the EHR's own stack on a single host, and rolls back by redeploying the previous image; the fact store's derived-view property makes rollback safe by construction (worst case: wipe and re-prepare). Load tests (k6) run at **10 and 50 concurrent users** against the deployed system, recording latency at the 50th/95th/99th percentile and error rate at each level, with baseline CPU, memory, and throughput profiles captured under the same scenarios — so every future performance change is measured against a recorded starting point, not a memory.

## Failure modes

Design rule: **the system may be unavailable; it may never be silently wrong.**

- Preparation didn't run → the panel says so, with the timestamp of the last good preparation — never a partial brief presented as complete.
- A tool or source fails mid-conversation → the agent names what it couldn't reach instead of answering around the hole.
- Missing data displays as missing — clinically meaningful in itself.
- The model provider is down or rate-limited → chat degrades gracefully to the already-prepared brief (which needs no live model), with retry and backoff behind the scenes.
- The EHR is unreachable → the panel degrades to a link to the standard chart; the doctor's workflow is never blocked by our failure.

## Cost & scale, in numbers

Per-visit economics at today's prices: preparation reads the record once with the deep-reader model (~50K words in, a few thousand out — roughly **$0.20–0.30 per patient**), and chat turns on the fast model cost about **a cent each**. A full 70-patient day lands around **$20 — noise against the ~35 minutes of clinic time the latency budget saves daily.** The morning batch can run on discounted asynchronous processing (half price) since the waiting-room gap only applies to same-day additions.

Scaling is a queue problem, not a model problem. The chat service is stateless (any instance can serve any request), so a 500-bed hospital with 300 concurrent clinical users means horizontally scaling identical service instances behind a load balancer and widening the preparation queue's worker pool — the per-patient work itself never changes shape. Inflection points: at **~100 users** (one large practice) the single-host stack runs as designed, unchanged; at **~1K** the single host splits (managed database, multiple service instances); at **~10K**, preparation moves to dedicated workers with prompt-caching to cut repeated-context cost; at **~100K**, multi-tenant isolation (per-practice fact stores and credentials) becomes the dominant design concern — which the per-patient bundle model already shards naturally. Cost does not scale linearly with users: preparation cost scales with *visits*, not seats, and caching plus batch processing bend the curve at each tier.

## Deliberately out of scope this week

**Model interpretation of raw scan pixels** — the imaging *surface* (toggle, timeline, comparison, trend and interval analytics over structured measurements) is in the architecture above; what's deferred is the multimodal model reading the scans themselves, sequenced second on Dan's own advice, with the schema already built to receive it. Also out: **semantic search** (rejected above — nothing to retrieve approximately at one-patient scale); **recommendations** (the system surfaces facts and computations; the doctor decides — the trust posture and the regulatory line); **multi-agent orchestration** (no capability gain for real latency cost).

## How we'll know it works

Our synthetic retina patients ship with **planted, documented contradictions** — e.g., two conflicting medication start dates with a recorded correct answer — so the same data seeds the demo and the test suite: every demo is a test run. Every test exercises a boundary (missing data, malformed input, empty record), an invariant (every claim cites a real source — must hold 100% by construction, tested anyway), or a known regression risk (adversarial access attempts, injection via documents), and the suite runs on every change, not on demand. Continuously measured: brief accuracy against ground truth, citation-validity rate, refusal correctness on unauthorized or ambiguous requests, latency at the 50th/95th percentile per surface against the targets above, and cost per visit.

**Before a real physician relies on this**, three things change: real-record ingestion goes behind the de-identification pipeline described above; the deployment gains high availability (no single host); and the brief's exclusion decisions — what it chose *not* to show — get clinically validated with Dan against real charts, because the failure mode that worries us most is not a wrong fact (the citation gate catches those) but a **correctly-cited brief that buried the one thing that mattered.** That is a triage failure, invisible to provenance checking, and only physician review of exclusions can measure it.
