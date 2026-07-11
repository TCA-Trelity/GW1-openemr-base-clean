# Target User & Use Cases

*This document is the source of truth that `ARCHITECTURE.md` traces back to.
Every agent capability we build points to a use case here, and every use case
states explicitly why a conversational agent — not a dashboard, a sorted list,
or a better chart — is the right shape.*

---

## The user: Dan, retina surgeon

We deliberately reject the failed thesis "physicians need help finding
information." Our user is one specific person in one specific workflow.

**Who he is.** A retina surgeon of ~35 years at a ~30-surgeon practice under a
~300-physician retina network. He founded the EHR that became the category
leader in ophthalmology — so he is simultaneously our **target user**, the
**domain's founding builder**, and the **harshest critic our design will ever
face**. He is not AI-averse: he already pastes screenshots into ChatGPT
between rooms because it is "so incredibly valuable," and he frames AI as "a
really smart partner… but he's not perfect… the doctor is still responsible
for that answer."

**His day, in numbers.**
- **~70 patients per day.** Volume multiplies every inefficiency by 70.
- **~90 seconds between rooms** to reconstruct who this patient is and what
  matters today.
- **A 5–20 minute gap** between technician check-in/workup and the moment he
  walks in — dead time today, our compute window by design.
- **Follow-ups are image-first:** an injection patient is seen ~10×/year with
  one full exam; "at least 90, 95% of the story is in those images."

**What he is doing in the 30 seconds before the co-pilot enters his day.** He
has just left the previous room. The next patient has been checked in and
worked up by a technician (no doctor present); their chart — a 20-page
template where "90% is not relevant" — is available but not yet triaged. He
needs, in the seconds before he opens the door: who is this, why are they
here, what changed since last time, what's on file, and what actually matters
today.

**What makes his triage specialty-specific** (why a generic co-pilot fails
him): imagery dominates the visit and is disconnected from the record today;
every finding has a laterality (OD/OS/OU); chronic care runs on cadence math
(treat-and-extend intervals, cumulative drug toxicity) he recomputes by hand;
patients arrive elderly, by referral, with fragmented multi-source records;
and — his own emphasis — "what she's hoping for" is clinical information that
today's billing-shaped EHR simply doesn't carry.

**His tolerances** (these become hard product constraints):
- **Latency:** seconds, not minutes. "Every second counts… 30 seconds at the
  end of seeing 70 patients… that's another half an hour of clinic time."
- **Error posture:** he tolerates model mistakes *if* he can verify — "I'm not
  at all bothered by the fact AI makes a mistake here and there… I'm
  responsible for the answer" — but demands per-fact confidence, a visible
  source, and to know who last updated a fact.
- **Refusal:** the agent must say what it doesn't know or couldn't reach, not
  paper over gaps — a silently-wrong brief is worse than no brief.

---

## Use cases

Each use case names the moment it fires, what the agent produces, what Dan
does with it, and why an agent is the right shape.

### UC-1 — The 90-second pre-visit brief (the anti-template)
**Moment.** Dan opens the next patient's chart in the seconds before entering.
**Agent behavior.** Present a single precomputed, triaged, one-page brief:
why they're here, what changed, active problems and current meds, laterality-
tagged findings, the risk flags that matter today, and "what they're hoping
for" — everything cited to its source.
**What he does with it.** Reads it in ~90 seconds and walks in oriented.
**Why an agent (not a dashboard).** A dashboard shows *everything* at fixed
weight — that is exactly the 20-page template Dan says produced EHR hatred. A
dashboard cannot decide that *this* medication interaction matters for *this*
patient *today* and the other 18 facts don't. The agent's job is the
per-patient, per-provider, per-visit relevance judgment a fixed layout
structurally cannot make. (The brief is the agent's opening turn; UC-2 is the
follow-up.)

### UC-2 — Iterative verification and drill-down
**Moment.** The brief surfaces something Dan wants to confirm or dig into —
"has that penicillin allergy been previously verified?", "when did they
actually start that medication?", "what did the referring note say about the
swelling?"
**Agent behavior.** Multi-turn chat over the already-prepared facts: answers
with citations, drills into source documents, flags what's unverified,
records his verification (who confirmed it, in what role).
**What he does with it.** Confirms or corrects facts before acting on them;
his verifications persist for the next physician who sees the patient.
**Why an agent (not a search box or static view).** Dan's verification is
inherently a *thread*: each answer determines the next question, and the
questions aren't enumerable in advance. He described this exact
back-and-forth — "this is going to be somewhat of an iterative process… if I
come up with a fact that doesn't jive with the first box, it's going to have
to inform me." Only multi-turn conversation carries that context from one
question to the next; a search box drops it every query.

### UC-3 — Contradiction surfacing across fragmented sources
**Moment.** A referral-heavy patient's record disagrees with itself — two
medication start dates, an allergy asserted in one source and denied in
another.
**Agent behavior.** During preparation, detect cross-source contradictions,
rank by clinical severity, and surface them in the brief with the trustworthy
source identified and a ready-to-ask clarifying question.
**What he does with it.** Resolves the conflict in seconds instead of missing
it — "there might be some gems in that past medical history that I can't even
get to… I may actually miss out on a few gems. That happens all the time."
**Why an agent.** Contradiction detection requires reading and cross-
referencing every source in natural language, weighting reliability, and
judging clinical impact — reasoning work, not a query. No sorted list finds
"these two documents disagree and it changes management."

### UC-4 — Auto-computed medication-toxicity risk
**Moment.** A patient on hydroxychloroquine (or another retina-toxic systemic
drug) presents; Dan currently recomputes cumulative-dose risk **by hand every
visit** — "that's always a pain in the neck… I'm trying to figure that out
every time they come back… it kind of scares me to death that I'm missing a
subtle toxicity."
**Agent behavior.** Deterministically compute cumulative dose × duration
against published thresholds, and flag new systemic medications with retinal
effects, in the brief — with the numbers shown so he can check them.
**What he does with it.** Reads a result he used to derive manually; catches
the new-medication interaction he'd otherwise miss.
**Why an agent (as the surface, not the calculator).** The calculation itself
is deterministic arithmetic (and we keep it that way — the model never does
the math). But *deciding this patient needs it today*, pulling the dose and
start-date facts from a messy multi-source record, and placing the result
where it's read in 90 seconds — that's the agent. This is the flagship "no
EHR does it like this" moment.

### UC-5 — Treat-and-extend interval guidance
**Moment.** An injection patient whose disease may be recurring as intervals
lengthen — "they start to worsen when you increase the interval… having that
information so I'm not overtreating and I'm not undertreating — that's massive
… it just takes a lot of time to try to figure that out."
**Agent behavior.** Correlate each imaging outcome with the interval since the
preceding injection and state the finding plainly ("stable at 8 weeks, leaked
at 12 — recommend 8-week interval").
**What he does with it.** Sets the next interval with evidence instead of
guesswork.
**Why an agent.** The analysis spans an entire longitudinal series and joins
imaging to treatment history — a synthesis across time, surfaced in context,
that no single chart view assembles.

### UC-6 — Imaging in clinical context, one toggle away
**Moment.** Mid-encounter, Dan needs the scans that matter for *this* visit —
today he fiddles with imaging software that "shows the same [views] no matter
what the disease is," or photographs his own monitor to ask ChatGPT.
**Agent behavior.** A one-toggle imaging view whose images are pre-selected
for this visit and stamped with clinical context ("taken 6 weeks after the
last injection of Avastin") — the disconnect he calls "crazy" is closed.
**What he does with it.** Reads the images — where most of the story is —
without leaving the record or breaking his flow.
**Why an agent.** Choosing *which* images are relevant for this disease at
this visit, and binding each to its clinical event, is a relevance-and-
synthesis judgment. (Pixel-level model interpretation, originally reserved for
the next phase, now ships as bounded observation: the chat's `describe_scan`
tool shows the model the actual B-scan, and its read is quarantined — labelled
"AI visual observation (not from the record)", never citable, morphology-only,
with a visible banner on any reply that used it.)

### UC-7 — Patient-goal-aware care
**Moment.** Planning the visit for a patient whose life context shapes what
"success" means — the mother who wants to be back in contact lenses in two
weeks for her daughter's wedding photos.
**Agent behavior.** Surface patient goals as first-class, verified facts in
the brief — the field Dan singled out on sight: "you've got something in
here — what she's hoping for… it's not a billing field… but it's really
important."
**What he does with it.** Aligns sequencing and counseling to what the patient
actually cares about — care, not just billing.
**Why an agent.** This information lives in intake conversation and referral
prose, not in structured billing fields; extracting it and elevating it
requires reading unstructured text and judging human relevance — exactly what
a fixed EHR schema omits.

### UC-8 — The imaging drill-down thread (multi-turn, tool-chaining)
**Moment.** The brief or the imaging workspace shows something that demands
interrogation, not a glance — an injection patient's October scan is worse.
Dan asks: "Did extending his interval hurt him?"
**Agent behavior.** A conversation that *works* for its answer. The attached
summary doesn't carry measurement series or pairwise scan diffs, so the agent
invokes its read-only tools mid-thread — `get_measurement_trend` (CRT across
all seven OCTs), then `compare_scans` (the two scans bracketing the 71-day
gap) — each result Zod-validated, each claim cited, tool activity streaming
visibly in the chat. Follow-ups ("what were the prior cycles holding at?",
"and the fluid?") continue the same persisted conversation; "his" and "those
two scans" resolve because the thread carries its own context.
**What he does with it.** Reads a longitudinal answer in seconds — trend,
delta, interval correlation — and sets the plan with evidence.
**Why an agent (and why multi-turn + tool chaining specifically).** The
questions are not enumerable in advance, and the data lives in stored analyses
rather than in any document or fixed view — only a tool-invoking agent can
fetch and reason over it mid-conversation, and only a conversation carries the
referents from one turn to the next. This is the use case that *requires* tool
chaining: trend → comparison → interval reasoning inside one thread. (The
machinery is eval-locked: history threading, verbatim tool-result plumbing,
round caps, error recovery — `docs/execution/eval-results.md`.)

### UC-9 — Recommendation-shaped asks, answered as a thought partner
**Moment.** The brief flags hydroxychloroquine toxicity risk as high.
Time-pressed, Dan asks the shortcut question every clinical chatbot gets:
"So what should I put her on?" — or mid-thread in UC-8, "should I just
shorten the interval?"
**Agent behavior.** Never a prescription. The reframe
(`docs/prompt-guide.md`): what the record shows, cited ("200 mg daily since
January 2019"); what the deterministic engines and named guidelines say,
attributed in the same sentence ("per AAO screening guidelines, five years at
this dose crosses the high-risk threshold — 365 g cumulative"); and the
questions worth weighing ("any new visual symptoms since December?"). The
decision stays with him.
**What he does with it.** Gets the decision-relevant numbers and their
provenance instantly — then makes the call himself, which is the only version
of this exchange a hospital CTO would deploy.
**Why an agent (and why the guardrail is the feature).** The ask arrives
conversationally and the correct answer is a synthesis — record + engine +
open question — that must *resist becoming advice*. A static view can't take
the question at all; a naive chatbot would answer it wrongly. Enforced at
three layers: a prompt hard rule, a deterministic prescriptiveness lint on
every reply (flagged turns surfaced and counted exactly like citation
failures), and published evals that plant violations and assert the reframe.

---

## Non-goals (what the agent will refuse to do)

- **It does not diagnose or prescribe.** It surfaces facts and computations
  and cites them; the physician decides. (Trust posture *and* the regulatory
  not-CDS line.) This is enforced, not aspirational: a prompt hard rule, a
  deterministic prescriptiveness lint on every chat reply, and published
  evals — see `docs/prompt-guide.md` and UC-9.
- **It does not write to the medical record** beyond recording fact
  verifications; no orders, no note authorship in this scope.
- **It does not answer generic medical questions** untethered from this
  patient's record — it is a co-pilot for *this chart*, not a medical search
  engine.
- **It does not reach beyond the launch patient** — structurally, via the
  patient-bound credential, not by policy.
