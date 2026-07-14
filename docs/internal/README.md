# Internal working docs

Build-stage material — **not part of the graded deliverable set** and
deliberately not linked from README/EVALUATION. Kept in-repo so the build
tooling (session-start ritual, ticket specs, anti-drift protocol) has one
versioned home.

| File | What it is |
|---|---|
| [`build-status.html`](build-status.html) | The Week 2 build board (tickets by wave, requirements coverage, eval/SLO analytics). Its `DATA` block updates in the same PR as the code it describes. |
| [`user-actions.html`](user-actions.html) | **The operator checklist as an interactive form** — key drops, clicks, and verifications with copy buttons, progress saved locally in your browser. |
| [`tickets/`](tickets/README.md) | Cold-executable ticket specs (template + standing rules in its README) for any future coding agent. |
| [`tickets/USER-ACTIONS.md`](tickets/USER-ACTIONS.md) | The markdown source the form mirrors (agents read this; humans use the form). |

Public counterparts stay in `docs/w2/` (requirements register, execution plan,
trace example, defense outline) and `docs/execution/` (ops dashboard,
baselines, eval results).
