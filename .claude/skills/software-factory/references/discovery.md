# Discovery Guide — Product Interview + Architecture Checklist

Two distinct discovery tracks. The **product track** runs for every raw idea, at every tier, and goes deep. The **architecture track** scales with tier — a few sections at MVP, the full checklist at Production. Confusing the two is the classic failure: either interrogating an MVP about CI/CD, or hand-waving a production system's eval strategy.

Save the interview answers into the PRD's rationale — every scope line should trace to something the user said.

---

## Part 1: Product & value discovery (all tiers, all raw ideas)

### Question types and what each is for

Use all five types. Each surfaces a different class of requirement that the others miss:

| Type | What it surfaces | Example |
|------|------------------|---------|
| **Framing** | The job-to-be-done and the user | "Who opens this, and what's the one thing it must do well?" |
| **Value-driver** | Why this beats what exists; the 'that's it' moment | "What would make you say 'yes, exactly' on first open? What's wrong with how you do this today?" |
| **Moment-of-use** | Real workflow requirements no feature list captures | "Walk me through the moment you'd reach for this — what did you just finish, what happens after?" |
| **Taste** | Visual/interaction preferences, density, polish | "Dense and utilitarian or polished? Name a product whose feel is 'like that'." |
| **Scope-edge** | Explicit in/out rulings on implied features | "The idea implies X, Y, Z — which are in v1? I'd cut Y because..." |

### Depth guidance

- **Round 1** (framing + value-driver + data + tier) is mandatory. Never draft from the prompt alone.
- **Round 2** (moment-of-use + taste + scope-edge + cost-of-wrong-answer + constraints) is expected for anything beyond a trivial utility.
- **Round 3+**: follow surprises. If an answer forks the design, ask about the fork. Propose concrete options with a recommendation rather than open-ended "what do you want?" — the user reacts better to a strawman than a blank page.
- **Stopping rule**: stop when every plausible v1 scope line is defensible from an answer, and the top 2-3 cut features have explicit rulings. If you're guessing on anything a wrong guess would cost an iteration on, ask.

### Value-driver probes (use 2-3, adapted)

- What do you do today instead, and what's the most annoying part?
- If v1 could only do ONE thing, which thing makes it worth opening?
- Who else sees this? (Just you → utilitarian; clients → presentability is a requirement, not polish.)
- What's the difference between the version you'd use once and the version you'd use weekly?

---

## Part 2: Architecture discovery checklist

Tier gates which sections run. Answers go in the PRD (Stack & architecture / Open decisions). Unanswerable ones become `DECISION:` lines at build time.

**Legend: [M] ask at MVP · [D] ask at Demo · [P] Production only (mandatory there)**

### Phase 1: Constraints

**1. Domain selection**
- [M] Which domain — and is it regulated (healthcare, insurance, finance, legal)? Regulated → Part 2 escalates regardless of tier (see production-factory.md).
- [M] Specific use cases supported in v1?
- [P] Verification requirements for this domain?
- [M] What data sources are needed, and where do they live? (Local-first at MVP.)

**2. Scale & performance**
- [P] Expected query volume? Concurrent users?
- [P] Acceptable latency?
- [D] Cost constraints for LLM calls / paid services? (Ask at Demo+ because even demos can burn API budget.)

**3. Reliability**
- [M] Cost of a wrong answer? (One question, always asked — it sets verification depth everywhere else.)
- [P] What verification is non-negotiable? HITL requirements? Audit/compliance needs?

**4. Team & skills**
- [D] Who maintains this after handoff, and what stack are they comfortable in? (Shapes language/framework choice more than fashion does.)

### Phase 2: Architecture

**5. Agent framework** (only if the product IS agentic)
- [P] LangGraph (default) vs alternatives — justify any deviation in DECISIONS.md.
- [P] Single vs multi-agent; state management; tool integration complexity.
- [M] At MVP: no framework. Markdown files + a loop. Graduate later.

**6. LLM selection** (only if the product calls LLMs)
- [D] Which model, function-calling needs, context window, cost per query acceptable?
- [M] At MVP: cheapest model that passes the primary flow; mock responses acceptable for layout work.

**7. Tool design**
- [D] What tools/external APIs? Mock vs real data during development?
- [P] Error handling per tool.

**8. Observability**
- [P] LangSmith (default). What metrics matter; real-time needs; cost tracking.
- [M] At MVP: console output and honest manual verification. That's the observability stack.

**9. Eval approach**
- [P] How is correctness measured? Ground truth source? Automated vs human? CI integration?

**10. Verification design**
- [P] Which claims must be verified, against what source, at what confidence threshold, escalating to HITL when?

### Phase 3: Post-stack refinement (Production only, pre-GATE 1)

**11. Failure modes** — per-tool failure handling, ambiguous-query behavior, rate limits/fallbacks, graceful degradation.
**12. Security** — prompt injection surfaces (any user text reaching an agent), data leakage paths, key management (.env only, never code), audit logging.
**13. Testing** — unit tests per tool, integration tests per flow, adversarial cases, regression setup.
**14. Open source** — releasing anything? License, docs, community plan.
**15. Deployment & ops** — hosting, CI/CD for agent updates, monitoring/alerting, rollback strategy.
**16. Iteration** — feedback capture, eval-driven improvement cadence, prioritization, maintenance owner.

### How to run this without exhausting the user

Don't read the checklist aloud. Batch by phase into AskUserQuestion rounds, pre-answer everything you can from context, and present inferred answers for confirmation ("I'm assuming X because you said Y — correct?"). The checklist is coverage insurance for YOU; the user should experience a short, sharp conversation where every question visibly matters.
