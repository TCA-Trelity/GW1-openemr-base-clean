# Clinical Co-Pilot — Architecture Defense Slides
*Full copy for 8 slides. Design/aesthetics handled separately; everything below is the actual content. The architecture diagram for Slide 5 is pre-generated (`architecture-diagram.svg`).*

---

## SLIDE 1 — This is Dan

**Headline:** This is Dan.

**Subhead:** Retina surgeon, 35 years. He built the EHR that leads his own specialty — and he wants it replaced.

**Stat tiles (large numbers):**
- **70** patients a day
- **90 sec** between exam rooms
- **5–20 min** each patient waits before he walks in
- **×70** — the multiplier on every recurring delay

**Pull-quote 1:**
> "That template is a huge problem for EHR because it ends up being 20 pages where one page would have done… You looked at the screen, it's just loaded with information. 90% of it is not relevant."

**Pull-quote 2:**
> "I'm taking screenshots every once in a while and sneaking back to my office to chat with ChatGPT about it… because it's so incredibly valuable."

**Footer line:** One person, three roles: our target user, the domain's founding builder, and the harshest critic our design will ever face.

---

## SLIDE 2 — The economic proposition

**Headline:** Minutes become patients.

**Anchor quote (Dan, verbatim):**
> "Every second counts. If it takes me 30 seconds at the end of seeing 70 patients, that's quite a bit of time. That's another half an hour of clinic time, which is very, very expensive."

**Left panel — For the practice: time returned, at trivial cost**
- **30 seconds saved per patient × 70 patients = ~35 minutes of clinic time, every day.** At a ~7-minute follow-up slot, that is **~5 more patients seen per day** — or the same schedule finishing on time. Per surgeon, per year: **~145 hours** of clinic capacity.
- **The AI bill for that day: ~$20.** (~$0.20–0.30 to prepare each patient's brief; ~1¢ per chat question.) The trade is twenty dollars of compute against half an hour of the most expensive time in the building.
- **It removes standing per-visit taxes, not just seconds:** the hydroxychloroquine risk Dan recomputes by hand *every* visit; treat-and-extend interval analysis — *"that's massive… it just takes a lot of time to try to figure that out"*; fiddling with imaging software — *"that can take a lot of time in the clinic… to get it to show what I want to see"*; and history spelunking — *"I may actually miss out on a few gems in there… that happens all the time."*
- **Cognitive load is an economic cost too.** *"It kind of scares me to death that I'm missing a subtle toxicity that's coming up."* A physician carrying that fear across 70 encounters is slower and more error-prone than one who isn't.
- **The network multiplies it linearly:** the same preparation pipeline serves every surgeon in a ~30-physician practice group — no per-doctor configuration, because the brief adapts per patient and per provider instead of being hand-templated.

**Right panel — For the patient: care that knows what they care about**
- The brief surfaces **patient goals as first-class, verified facts** — the field Dan singled out on sight: *"You've got something in here — what she's hoping for… That's really an important thing that in medicine you're not going to see, because it's not a billing field… but it's really important."*
- **Concretely:** the treatment plan reads differently when the system surfaces that the patient is a mother who wants to be back in her contact lenses in two weeks for photos at her daughter's wedding. The clinical options don't change — the conversation, the sequencing, and the follow-up plan do.
- **Patients are already arriving AI-armed** — *"sometimes the questions they're asking are very, very probing… because they're actually looking at AI already."* A physician holding a dynamically-prepared brief meets those questions prepared, not surprised.
- **Fewer misses is patient value, not just efficiency:** intake gaps in today's workflow can bury emergency-level findings; a brief that triages by relevance is a safety layer as much as a time-saver.

**Footer (adoption line, Dan verbatim):**
> "Once doctors see how this works, they're going to go gaga and say this has to be the way you do it from now on."

---

## SLIDE 3 — Our stance: a presentation failure, not a data failure

**Headline:** The data is already there. It's buried in the clutter.

**Body copy:**
The EHR faithfully stores the medications, the history, the exam findings. What's broken is the organization of the screen: every fact renders at equal weight on an overcrowded page, so the physician digs through the clutter manually, on the clock, seventy times a day.

**Callout box — "Why is the chart so cluttered? (We checked the code.)"**
Three forces produced today's screen, and none of them is incompetence:
- **Billing** — insurance and payment fields share the physician's view because they pay the clinic.
- **Regulation** — compliance widgets (reminders, disclosures, amendments) are certification requirements, not clinician requests.
- **Configurability** — site-defined custom forms append themselves to the page automatically.

**The discipline (emphasized line):**
The cluttered record is load-bearing. **So we change what the doctor sees — never how the EHR stores data.** Our layer sits above the record, cites into it, and is removable without a trace.

**Right panel — "And 'relevant' is specialty-specific. Ophthalmology demands:"**
- **Images first.** *"When I'm doing my follow-ups… I'm just looking at images… at least 90, 95% of the story is in those images."* The 90 seconds is spent on scans more than text.
- **Laterality.** Every finding belongs to the left eye, right eye, or both — a first-class attribute, not prose.
- **Cadence math.** Treat-and-extend intervals and cumulative drug toxicity are longitudinal calculations across visits.
- **Fragmented arrivals.** Elderly, referral-heavy patients with multi-source, unverified records — provenance matters from day one.

---

## SLIDE 4 — Our approach: move the thinking to where time is free

**Headline:** Move the thinking to where time is free.

**Diagram (horizontal visit timeline):**
`Patient checks in` → **[5–20 minute waiting gap]** → `Doctor opens chart` → `90-second review` → `Doctor enters room`

**Under the waiting gap, label the hidden work:**
**Deep reader (Claude Sonnet 5)** runs here: reads the full record → extracts typed, cited facts → reconciles contradictions → computes medication risks → pre-selects this visit's scans → assembles the one-page brief.

**Under the 90-second review, label the surfaces:**
**Brief** (precomputed, instant) ⇄ **Scans** (one toggle) ⇄ **Chat** (fast responder — Claude Haiku 4.5 — answering from prepared facts, streaming).

**Key line (emphasized):**
This dissolves speed-vs-completeness rather than balancing it: **completeness is achieved at preparation time, where minutes are available; speed at read time, where only seconds are.**

**Latency targets table:**

| Surface | Target | Why it's achievable |
|---|---|---|
| Opening the brief | < 1 s | Precomputed; a database read |
| Toggling to scans | < 1 s | Visit-relevant images pre-selected & pre-fetched |
| Chat — first words on screen | < 2 s | Fast model + small prepared input; streams |
| Chat — complete answer | < 10 s | Nothing searched or re-read in the hot path |
| Preparation per patient | ≤ ~5 min | Hidden inside the 5–20 min waiting gap |

**Footer line:** Two model tiers aren't a preference — they're a consequence: a deep reader where time is free, a fast responder where it isn't.

---

## SLIDE 5 — System architecture

**Headline:** A sidecar beside the EHR — never code inside it.

**Visual: use the pre-generated diagram (`architecture-diagram.svg`).** It shows: OpenEMR (untouched, single system of record) with the embedded React panel; the Node.js + Fastify + Zod sidecar; PostgreSQL fact store; BullMQ-on-Redis preparation queue triggered by check-in; GCS/S3 object storage for scans; self-hosted Langfuse; the dashed trust boundary around the whole single-VM Docker Compose stack; and the single boundary crossing — BAA-covered TLS to the Anthropic API (Claude Sonnet 5 deep reader / Claude Haiku 4.5 chat).

**Callout (also printed on the diagram):** The fact store is a **view, not a second source of truth** — rollback = redeploy the previous image; worst case, wipe and re-prepare. Safe by construction.

**Footer — how it scales:** Scaling is a queue problem, not a model problem. The chat service is stateless — a 500-bed hospital with 300 concurrent clinical users means more identical instances behind a load balancer and a wider preparation worker pool. Inflections: **~1K users** — split the single host · **~10K** — dedicated prep workers + prompt caching, morning batches on discounted async processing · **~100K** — multi-tenant isolation dominates, and per-patient fact bundles already shard naturally.

---

## SLIDE 6 — Trust: built to be defensible to Dan

**Headline:** Every claim carries its receipt.

**Framing line:** Dan's trust model is a working partner who is *accountable to him* — and he told us exactly what that requires:

> "I'm not at all bothered by the fact AI makes a mistake here and there… The doctor is still responsible for that answer."
> "AI should come back with a confidence level on certain facts… I would like to know how confident it is in what it's telling me."
> "You probably want to know who updated that fact… I think that is important."

**His requirements, mapped to mechanisms (three rows):**
- *"Is it a reliable fact?"* → **The typed fact:** `{ content · source pointer (document, entry) · confidence · verification status (who confirmed, in what role) · laterality (OD/OS/OU) }`
- *"Show me where it came from."* → **The citation gate:** a deterministic checker — plain code, not a model — sits between generation and display and verifies every citation points to a real record entry. An unsourced claim is blocked **by construction**, not by trusting the model to behave.
- *"Don't make me redo the math."* → **Domain rules are arithmetic, not opinion.** Hydroxychloroquine toxicity = daily dose × days vs. published thresholds; treat-and-extend = scan outcomes correlated with injection intervals → *"stable at 8 weeks, leaked at 12 — recommend 8-week interval."* The model presents results; it never performs the calculation. Both engines ported unchanged from the prototype Dan validated.

**Pipeline diagram:**
`record → typed facts → model answer → ⛔ CITATION GATE → doctor's screen`

**Honest-limitation strip (bottom):**
This guarantees **provenance** (every claim has a real source), not perfect **interpretation** (a model can still summarize a cited fact clumsily). Mitigations: the source is one click from every claim; the test suite measures faithfulness against ground truth. The doctor drives; the system shows its work.

---

## SLIDE 7 — Authorization: the credential is the boundary, not the model's judgment

**Headline:** We don't inherit patient-level access control. We construct it.

**The audit finding (callout, verbatim from our audit):**
OpenEMR enforces role-level permissions correctly at its API — but its per-patient access check is **unimplemented: the function returns "allow" unconditionally.** Any clinician can read any patient. This finding shaped the entire authorization design.

**Two credentials (two badge cards):**
1. **Interactive surface** (brief + chat + scans): SMART-on-FHIR launch token, bound to **one patient and one logged-in user**. If the agent is manipulated — a crafted question, malicious text inside a referral document — it structurally cannot reach other patients.
2. **Background preparer**: separate **read-only** server credential. *The honest tradeoff:* it can read across the practice's patients, because preparing today's schedule requires it. *Mitigations:* read-only; scoped to the preparation pipeline only; never touches the interactive surface; every access written to the EHR's own audit log with identity and timestamp.

**Role panel:**
Role shapes capability, not just access: verifying a medication, allergy, or clinical finding requires a **physician's** session; social history and patient goals are verifiable by **delegated staff**. Resident supervision (verify-then-countersign) slots into the same mechanism — designed now, deferred past this week.

**Security strip (bottom):**
Prompt injection is treated as a certainty. Referral documents and patient-reported text are **data to be quoted and cited, never instructions.** Blast radius is capped three ways: patient-bound credential + a toolset with no write or outbound action + the citation gate.

---

## SLIDE 8 — Tradeoffs, proof, and the road ahead

**Headline:** Every decision was a choice — and every demo is a test run.

**Decision table:**

| We chose | Over | Because |
|---|---|---|
| A presentation layer | Restructuring the EHR's data | The clutter is load-bearing (billing, certification); a layer is reversible — a migration is one-way |
| A sidecar service (Node.js) | Building inside OpenEMR's PHP | EHR stays upgrade-safe; independent failure domain & scaling; modern AI tooling is thin in the monolith |
| Frontier model under a healthcare BAA | Turnkey medical-AI products & medical fine-tunes | Our task is retrieving, organizing, and citing *this patient's own record* — no vendor supplies our fact-store / provenance / EHR-embedding layer |
| Whole-patient context (exact lookup) | Vector / semantic search | One patient's facts fit in the model's context — the hardest retrieval problem never arises |
| One agent, plain SDK loop | Agent frameworks / multi-agent | Frameworks add someone else's abstractions to debug; extra agents add latency where latency is *the* constraint |
| TypeScript end-to-end | Python (the AI default) | The validated clinical calculators are already JavaScript — they port unchanged; one schema file serves API and UI, so contracts cannot drift |

**Failure-design strip:**
**The system may be unavailable; it may never be silently wrong.** Prep didn't run → the panel says so, with a timestamp. A source fails mid-chat → the agent names what it couldn't reach. Model provider down → chat degrades to the already-prepared brief. EHR unreachable → panel becomes a link to the standard chart.

**Proof panel — "Every demo is a test run":**
Synthetic retina patients ship with **planted, ground-truthed contradictions** (two conflicting medication start dates — with the recorded right answer). The same corpus seeds the demo and the test suite. Every test exercises a boundary (missing data, empty record), an invariant (100% citation validity — guaranteed by construction, tested anyway), or a regression risk (cross-patient access attempts, injection via documents). Runs on every change.

**Closing block — "Before a real physician relies on this":**
1. Real-record ingestion goes behind a de-identification pipeline (PHI stripped at the clinic edge — Dan's pilot posture).
2. The deployment gains high availability — no single host.
3. The brief's **exclusion decisions** get clinically validated with Dan — because the failure that worries us most is not a wrong fact (the gate catches those) but a *correctly-cited brief that buried the one thing that mattered.* A triage failure, invisible to provenance checking, measurable only by physician review.

**Final line:** Next phase: the model reads the scans themselves. The schema already has the slot.
