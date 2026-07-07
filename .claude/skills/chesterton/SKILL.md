---
name: chesterton
description: Empathetic evaluation of brownfield (existing/legacy/inherited) codebases, ending in an execution-ready PRD. Named for Chesterton's fence — never recommend removing something until you understand why it's there. Runs four phases, Understand → Interpret → Plan → Execute, with user checkpoints after Interpret and Plan. Use this skill whenever the user wants to assess, evaluate, audit, or plan changes to an existing codebase or repo they didn't write or know poorly — phrases like "I inherited this codebase", "evaluate this project", "assess this repo", "why is this code like this", "modernize this legacy app", "plan a refactor", "what would it take to add X to this codebase", or any mention of chesterton. Trigger even if they only ask for a "code review of the whole project" or "help me understand this codebase before I change it."
---

# Chesterton: Empathetic Brownfield Codebase Evaluation

> "Don't ever take a fence down until you know the reason why it was put up." — G.K. Chesterton

Code that looks wrong usually encodes knowledge that isn't written down anywhere else: a production incident, a vendor quirk, a deadline, a browser bug that no longer exists, a customer contract that very much still does. The naive reviewer sees clutter; the empathetic reviewer sees fences. This skill produces an assessment and change plan that treats the existing codebase as evidence of decisions, not as a pile of mistakes — and ends with a single deliverable: a PRD ready to hand to an execution skill.

## Operating rules (apply throughout)

**The evidence gate.** Never recommend removing, rewriting, or bypassing code whose purpose you cannot explain, unless the PRD explicitly labels it an *accepted unknown risk* with a mitigation (feature flag, revert plan, canary). "This looks obsolete" is not evidence. "The commit that added it references bug #412, and that bug's conditions no longer exist because the API it worked around was removed in commit abc123" is evidence. Every change recommendation in the final PRD carries a fence status: **Explained** (reason found and no longer applies / accounted for), **Load-bearing** (reason found and still applies — plan around it), or **Unknown** (no reason found — flag as risk, don't silently remove).

**Assessment before ambition.** The user likely has limited exposure to this codebase — that's why they're here. Always start from Understand even if they arrive with a change already in mind; hold their goal as a lens, not a shortcut past the assessment.

**Checkpoints are real.** Pause and confer with the user after Interpret and after Plan (details below). Use the AskUserQuestion tool if available, otherwise ask in plain conversation. The user may hold institutional knowledge that no amount of archaeology will surface — a checkpoint question is cheaper than a wrong hypothesis compounding through the plan.

**One deliverable.** Everything — codebase map, fence findings, tradeoff analysis — is embedded in the final PRD, not scattered across side documents. Intermediate notes are working memory, not outputs.

## Phase 1 — Understand

Goal: an accurate mental model of what this system is, where its boundaries are, and how it runs.

1. **Orient cheaply first.** Read the README, top-level directory listing, manifest files (package.json, pyproject.toml, go.mod, Gemfile, pom.xml, .csproj…), CI config, and any docs/ or ADR directory. Identify: language(s), framework(s), build/test commands, deployment story, and the apparent module boundaries.
2. **Fan out subagents per boundary.** For anything beyond a trivially small repo, launch parallel Explore (read-only) subagents — one per major module/boundary — rather than reading everything in the main context. Each agent reports: the module's responsibility, its public surface, what it depends on and what depends on it, data models it owns, test coverage impression, and the 3–5 oddest things it saw (candidate fences — file paths and line references required). Keep the main context for synthesis. For a small repo (a few dozen files), read directly and skip the fan-out.
3. **Trace one or two real flows end-to-end** (a request, a job, a CLI invocation) to verify the synthesized model against reality. Boundaries on paper and boundaries in the call graph often disagree; trust the call graph.
4. **Record the codebase map** as working notes: stack, boundaries, module responsibilities, data flow, build/test/run commands, external integrations, and the candidate-fence list collected from the agents.

Do not evaluate quality yet. Phase 1 describes; Phase 2 judges — mixing them produces premature contempt.

## Phase 2 — Interpret / Empathize

Goal: for each odd, clunky, or legacy-looking thing, the most likely reason it exists — with evidence and a confidence level.

For each candidate fence, run the archaeology techniques in `references/archaeology.md` (read it now if you haven't): git blame and log on the relevant lines, commit-message and PR/issue trails, comments and TODO strata, and tests-as-intent (a weird test pinning weird behavior means someone was burned). Then write a hypothesis:

```
Fence: retry loop with hardcoded 7s sleep in payments/client.py:88
Evidence: added in 2019 commit "fix: PSP rate limits us during BF" ; test_psp_backoff pins the 7s value
Hypothesis: works around payment provider's rate limiter under load
Confidence: High
Still applies? Unknown — need to check current PSP contract/limits
```

Also form a view of the system's *core goals*: what is this product for, what does the code say its authors valued (speed of iteration? correctness? operability?), and what direction does recent commit history suggest it's heading. This becomes the "current vision" that Phase 3 plans must align with.

**CHECKPOINT 1.** Present to the user: the codebase map in brief, the fence hypotheses with confidence levels, and your read on the system's goals. Ask them to confirm, correct, or annotate — especially the Unknowns and the goals. Wait for their input before planning. Incorporate corrections as first-class evidence (mark them "per user").

## Phase 3 — Plan

Goal: a small set of well-chosen changes with honest tradeoffs.

1. **Generate candidates** from three sources: the user's stated goal (if any), problems surfaced in Phases 1–2 (risk hotspots, drag on iteration speed, operability gaps), and cheap wins the archaeology revealed (fences whose reason verifiably no longer applies).
2. **For each candidate, analyze tradeoffs**: implementation cost, performance impact, risk (weighted by fence status — touching Unknown fences is expensive by definition), and alignment with the product vision from Phase 2. Kill candidates that don't clear the evidence gate or don't serve the vision, and say so — a good plan is notable for what it declines to do.
3. **Sequence the survivors**: dependencies between changes, what must land first, what can proceed in parallel, where the verification points are.

**CHECKPOINT 2.** Present the candidate list with tradeoffs and your recommended scope. Get the user's sign-off on direction and scope before writing the PRD. This is where they trim ambition or add a constraint you couldn't see.

## Phase 4 — Execute (produce the PRD)

Write a single PRD following `references/prd-template.md` (read it before writing). It embeds the codebase map, the fence register, and the tradeoff analysis as context sections, then specifies the approved changes as discrete implementation units — each with files touched, dependencies, complexity, and acceptance criteria. That structure is deliberate: it is exactly what the **prd-optimizer** skill consumes to decompose work into Claude Code sessions.

Save the PRD as `PRD-<short-name>.md` in the repo or the outputs folder (user's choice if a repo is mounted). Then offer the handoff: "Want me to run prd-optimizer on this to turn it into a session-by-session execution spec?"

## Practical notes

- If no folder/repo is connected yet, request access before starting (in Cowork, use the request-directory tool).
- If git history is unavailable (tarball, shallow clone), say so — archaeology weakens, confidence levels drop, and more fences stay Unknown. Suggest fetching full history if possible (`git fetch --unshallow`).
- Cite everything: file paths with line numbers, commit hashes, issue numbers. The PRD's authority comes from its evidence.
- If run non-interactively (scheduled, subagent) where checkpoints are impossible, don't block: record what you would have asked as "Open questions" in the PRD and proceed with clearly-labeled assumptions.
