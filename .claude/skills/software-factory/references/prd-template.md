# PRD Template + Product Interview

## Product interview (raw ideas only)

A raw idea means the requirements live in the user's head, not the prompt. Your job is to get them out before drafting — extensively. Skip anything the user already answered, but err toward asking: a question that turns out to be unnecessary costs seconds; a wrong guess baked into the draft costs an iteration. Run multiple rounds; let answers spawn follow-ups.

**Round 1 — frame the product:**
1. **Tier**: MVP / client demo / production? (Mandatory if unstated.)
2. **Users & core job**: who uses it and what's the ONE thing it must do well?
3. **Value driver**: what makes this worth building vs. what already exists? What would make the user say "yes, that's it" on first open?
4. **Data**: what data does it need, where does it live, is any of it sensitive?

**Round 2 — requirements and taste** (shaped by round 1 answers):
5. **Walk the moment of use**: when and where does the user reach for this? What did they just do, what do they do next? (Surfaces real requirements no feature list captures.)
6. **Taste**: visual/interaction preferences — dense and utilitarian, or polished? Any product they'd point to as "like that"?
7. **Scope edges**: for 2-3 plausible features the idea implies, ask explicitly: in or out of v1?
8. **Cost of wrong answer**: what happens if it's wrong/broken? (Drives verification depth.)
9. **Constraints**: deadline, budget for paid services, must-use or must-avoid tech?

**Round 3+ — follow the threads.** If an answer surprised you or opened a fork, ask about it. Stop only when you could defend every scope line in the PRD by pointing at something the user said.

For question-type scaffolding, value-driver probes, depth/stopping rules, and the tier-gated 16-section architecture checklist, see `discovery.md` — that file is the source of truth for what to ask and how deep to go. At MVP, deferring the *architecture* questions IS the correct answer; deferring the *product* questions is malpractice.

## PRD structure

Keep it to 1-2 pages for MVP. Use this shape:

```markdown
# [Project name]

## Problem & user
One paragraph. Who, what pain, why now.

## Deployment tier
MVP | Demo | Production — and what that implies for this project.

## Scope (v1)
The 3-7 capabilities this version delivers. Each one verifiable.

## Non-goals
Explicitly out of scope. This section prevents scope creep more than
any other — be generous with it.

## Stack & architecture
Chosen stack with one-line rationale per non-obvious pick.
For MVP: default to the simplest thing that runs, local-first.

## Task decomposition
Ordered build tasks with dependencies. MVP: 5-10 tasks inline here.
Larger builds: session-scoped chunks per prd-optimizer conventions —
each chunk completable in one agent session with explicit inputs/outputs.

## Success criteria
How we know v1 is done. For MVP: "primary flow runs end-to-end" is
a legitimate criterion.

## Open decisions
Judgment calls deferred to build time — these get surfaced as
DECISION: lines during Phase 2 and logged to DECISIONS.md.
```

## DECISIONS.md format

```markdown
# Decisions

- 2026-07-06 | SQLite over Supabase | No multi-user requirement in PRD; swap path documented in README
- 2026-07-06 | Single index.html | PRD needs 3 views, all static; routing framework unjustified
```

Date, decision, one-line rationale. Append-only.

## memory/state.md format

```markdown
# State — [project]

**Tier:** MVP
**Status:** Task 4/7 — building CSV import

## Done
- [x] Task 1: skeleton + sample data
- [x] Task 2: core parsing
- [x] Task 3: main view

## Next
- [ ] Task 4: CSV import (in progress — parser done, UI wiring left)
- [ ] Task 5: filtering

## Context a cold session needs
Run with: python app.py / open index.html
Gotchas: [anything non-obvious discovered during build]
```

Update at every task boundary. Written for a reader with zero conversation context.
