---
name: software-factory
description: End-to-end greenfield build pipeline - takes a raw product idea OR an existing PRD and drives it through planning, decomposition, execution, verification, and delivery with human approval gates. Use this skill whenever the user wants to build a new app, tool, prototype, MVP, demo, or product from scratch - phrases like "build me an app that...", "I have an idea for...", "turn this PRD into a working product", "spin up an MVP", "software factory", or any request to go from concept to working software. Also trigger when the user uploads a PRD, spec, or product doc and wants it built (not just analyzed). Do NOT use for modifying existing codebases (use chesterton) or for restructuring PRDs without building (use prd-optimizer alone).
---

# Software Factory

Take a greenfield idea or PRD to working software through a gated pipeline: **Intake → Plan → [GATE 1] → Build → Verify → [GATE 2] → Deliver**.

Two hard rules that exist because the user asked for exactly two points of control:

1. **GATE 1 — no code before plan approval.** The user approves the PRD + task decomposition before any implementation starts.
2. **GATE 2 — nothing leaves the local environment without sign-off.** Deploys, GH pushes, DB migrations, anything public or persistent requires explicit approval. Building and running locally is always fine.

Between the gates, run autonomously. Don't ask permission for routine work.

## Phase 0: Intake

Determine two things before anything else:

**What's the input?**
- **Raw idea** → run the product interview (below), then draft the PRD using `references/prd-template.md`. A raw idea is NOT a handoff — never take "spend tracker mvp" and execute a shot-in-the-dark draft. The entire value of starting from an idea is extracting the user's actual intent first.
- **Existing PRD/spec** → skip drafting. Read it, restate the deployment tier and any gaps in one short block, and go straight to decomposition. If the PRD is large or multi-session, apply prd-optimizer conventions (session-scoped chunks, parallelism markers) during decomposition.

**What's the deployment tier?** This drives every architecture decision. If the user hasn't said, ask — it's the one question that can't be defaulted:

| Tier | Meaning | Bias |
|------|---------|------|
| **MVP** (default when ambiguous) | Workable draft for the user to iterate on | Minimize complexity. Local-first. Simplest thing that runs. |
| **Demo** | Client-facing, low volume | Local HTML or GH Pages, basic password protection, polish over robustness |
| **Production** | Public-facing deployment | Full factory stack — read `references/production-factory.md` |

**Discovery — read `references/discovery.md` before interviewing.** It has two tracks:

- **Product & value discovery** runs deep for every raw idea at every tier: five question types (framing, value-driver, moment-of-use, taste, scope-edge), multi-round with follow-ups, and a stopping rule — every PRD scope line must trace to something the user said. A raw idea is never a handoff for a shot-in-the-dark draft.
- **Architecture discovery** is the 16-section checklist, tier-gated: a handful of [M]-tagged questions at MVP, more at Demo, the full checklist (failure modes, security, evals, ops) mandatory at Production or in regulated domains.

MVP minimalism applies to the architecture track, never the product track. Batch questions into AskUserQuestion rounds and pre-answer what context already tells you — the checklist is coverage insurance for you, not a questionnaire to read aloud.

## Phase 1: Plan

Produce two artifacts:

1. **PRD** (drafted or accepted) — scope, non-goals, tier, success criteria.
2. **Task decomposition** — ordered build tasks with dependencies. For MVP this can be 5-10 tasks in the PRD itself; for Production, session-scoped specs per prd-optimizer conventions.

**Architecture selection follows the tier**, not habit:

- **MVP**: Single-file HTML/JS or a Python script if it satisfies the PRD. Only reach for a framework (Next.js/TS) or a cloud DB (Supabase) when requirements demand persistence, auth, or real routing. Local retrieval over cloud paths. Markdown files (`memory/*.md`, `DECISIONS.md`) instead of orchestration infrastructure — MDs are the orchestrator at this tier.
- **Demo**: MVP rules plus presentability — a real visual pass, seeded demo data, basic pw gate if hosted.
- **Production**: The 11 building blocks (Linear, LangGraph orchestrator, Docker, CC agent SDK, MCPs, Vercel+Supabase, LangSmith). Read `references/production-factory.md` before planning this tier.

**Design direction — required for every build.** Every deliverable ships a visual UI surface, even headless builds (a pipeline still gets a minimal status/results view). Before GATE 1, read `references/design-research.md`: anchor on 1-2 best-in-class exemplars in the domain (tutoring → Brilliant/Khan Academy; finance → Wealthfront; real estate → Airbnb — research beyond the seed map when the domain is unfamiliar) and extract a 4-6 line design direction.

**GATE 1:** Present the PRD + decomposition + stack choice with a one-line rationale for each non-obvious pick, **plus the design direction** (exemplar, palette/layout/type summary, how it maps to the screens). Use AskUserQuestion if available. Wait for approval. Incorporate edits and re-gate only if scope changed materially.

## Phase 2: Build

Set up the project skeleton first: repo/folder, `memory/state.md` (current status, what's done, what's next — so any future session can resume cold), and `DECISIONS.md`.

**Code style — this is the user's voice, apply it everywhere:**
- Concise but clearly documented. Every file gets a 1-3 line header comment saying what it does and why it exists. Functions get a one-line purpose comment only when the name doesn't already say it.
- No speculative abstraction. Build for the PRD in hand, not the imagined v3. A duplicated 10-line block beats a premature framework.
- Prefer fewer files. Don't scatter an MVP across 15 modules.
- Dependencies are a cost. Each import beyond stdlib/framework-default needs to pull real weight.

**Communication style — decision-focused:**
- Stay quiet during routine work. Silence means progress.
- Surface every real judgment call as a one-liner the user can veto in real time: `DECISION: SQLite over Supabase — no multi-user requirement in PRD. Say the word to switch.` Then keep moving; don't block on it.
- Log all decisions (surfaced or not) to `DECISIONS.md` with one-line rationale.
- Judgment call = anything that would be annoying to reverse later or deviates from the approved plan. Variable naming is not a judgment call.

Update `memory/state.md` at each task boundary. This is cheap insurance: sessions die, contexts fill, and the next agent (or the user) should be able to resume from the file alone.

## Phase 3: Verify

Verification scales with tier — the cost of a wrong answer at MVP is a wasted iteration, not a lawsuit:

- **MVP**: Manual verify only. Actually run it. Exercise the primary flow end-to-end, screenshot or describe what works, and be honest about what doesn't. A "done" that doesn't run is worse than a "80% done, here's what's broken."
- **UI verification, every tier**: exercise the surface like a user — click every link and button, check formatting/spacing/overflow with realistic data, trigger empty/error states. Checklist in `references/design-research.md` step 4. Logic that passes while a button dead-ends is a failed verification.
- **Demo**: Manual verify plus walk the exact path the client will see. Broken demo flows are the embarrassing failure mode.
- **Production**: Formal tests, evals, adversarial checks per `references/production-factory.md`.

Report verification results as a short findings block — what was exercised, what works, what's known-broken or **untested** — and write it into `memory/state.md`, not just chat. The untested list is the part that protects the user later; a findings block without it is incomplete even when everything passed.

## Phase 4: Deliver

**GATE 2:** Before any deploy, push, or migration — present what's about to leave the local environment and where it's going. Wait for approval.

Then hand off with:
- Where the code lives and how to run it (exact commands)
- What was verified and what wasn't
- The 2-3 highest-leverage next iterations (MVPs are drafts — say what you'd do next, don't just declare victory)
- `DECISIONS.md` as the audit trail
- `ARCHITECTURE.md` — a short MD an engineer can read cold to understand and defend the build: system shape (components + data flow, a few lines), the 3-6 key decision points with the option chosen, alternatives considered, and why (pull the load-bearing entries up from DECISIONS.md and give them a paragraph each), design direction + exemplar, and what would change at the next tier. One page for MVP; this is the "explain it to the next engineer" doc, not a spec.

Keep the handoff tight. The user reads code and decision logs; don't narrate what they can read.

## Reference files

- `references/discovery.md` — product/value interview scaffolding (question types, depth, stopping rule) + the full 16-section architecture checklist with tier gates. Read at Phase 0 for every raw idea, and at Phase 1 for Production planning.
- `references/design-research.md` — exemplar seed map, design-direction extraction, UI quality bar, and UI verification checklist. Read before GATE 1 for every build.
- `references/prd-template.md` — PRD structure, interview round sequencing, DECISIONS.md and memory/state.md templates. Read when drafting a PRD from a raw idea.
- `references/production-factory.md` — the full 11-building-block architecture, graduation path, and production ops checklist. Read only for Production tier (or when the user asks to graduate an MVP).
