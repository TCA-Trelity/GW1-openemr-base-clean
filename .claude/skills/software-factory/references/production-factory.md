# Production Factory — Full Stack

Read this only for Production tier, or when graduating an MVP/Demo. Everything here is deliberately skipped at lower tiers.

## The 11 building blocks

| # | Block | Role | Default |
|---|-------|------|---------|
| 1 | Record | Where work is tracked | Linear |
| 2 | Memory | How agents share context | `memory/*.md` |
| 3 | Orchestrator | Order of operations | LangGraph state machine in `orchestrator/` |
| 4 | Execution env | Where agents run | Docker container |
| 5 | Agent runtime | The agent's brain | Claude Code agent SDK |
| 6 | Integration layer | Agents ↔ tools | MCPs (Supabase, Slack, GH, Vercel, ...) |
| 7 | Quality gates (HITL) | Human control points | LangGraph `interrupt()` |
| 8 | Delivery target | Where the app lives | Vercel (frontend) + Supabase (db) |
| 9 | Observability | Seeing what's happening | LangSmith traces |
| 10 | Skills | What agents know | Claude skill MDs |
| 11 | Identity & secrets | How agents auth | `.env` mounted into Docker |

These are defaults, not law. Swap a block when the project demands it, log the swap in DECISIONS.md, and surface it as a DECISION: line. The two HITL gates (post-plan, pre-deploy) map to LangGraph `interrupt()` nodes at this tier — the gate placement never changes, only the mechanism.

## Graduation path (MVP → Production)

Don't rebuild — layer in. Typical order, each step independently shippable:

1. Local files → Supabase (data + auth)
2. Local run → Vercel deploy behind preview URLs
3. Ad-hoc sessions → Linear-tracked tasks, memory/ MDs formalized
4. Single agent → LangGraph orchestrator with interrupt() gates
5. Console output → LangSmith tracing
6. Bare host → Docker with mounted .env

## Production checklist

Work through these before GATE 1 at Production tier. Answers go in the PRD; unresolved ones go in Open Decisions.

**Failure modes**
- Tool failure handling per tool (retry? fallback? surface?)
- Ambiguous-query behavior; rate limiting; graceful degradation

**Security**
- Prompt injection surfaces (any user-supplied text reaching an agent)
- Data leakage paths; API key management (never in code, .env only, rotate)
- Audit logging for anything compliance-adjacent

**Verification & evals**
- What claims must be verified, against which ground truth
- Confidence thresholds and escalation triggers to HITL
- Automated eval set in CI; adversarial/regression cases

**Ops**
- CI/CD for agent updates; rollback strategy
- Monitoring + alerting (LangSmith + delivery-target metrics)
- Cost tracking per LLM call path

**Iteration**
- User feedback capture mechanism
- Eval-driven improvement loop cadence

## Domain escalation

Healthcare, finance, legal, insurance: verification design is non-negotiable regardless of tier. Even an MVP in these domains gets the Verification & evals block above, plus explicit HITL on any user-facing claim. Cost of a wrong answer sets the floor, not the tier.
