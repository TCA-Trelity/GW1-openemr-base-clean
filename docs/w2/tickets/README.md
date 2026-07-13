# Week 2 ticket specs — how to read and execute these

This directory holds one implementation spec per remaining Week 2 ticket.
Each spec is written to be executed **cold**: a coding agent with zero session
memory must be able to open one file and ship the ticket without asking
questions. If a spec and the code disagree, **trust the code and update the
spec in the same PR** — line numbers drift; seam names and contracts should not.

Canonical context (read only what the spec cites):

- Requirements register: [`../requirements.md`](../requirements.md) — REQ IDs
  (`S#`/`R#`/`E#`/`D#`/`G#`/`P#`), acceptance checkboxes. The ticket is done
  when its cited checkboxes flip, not when code exists.
- Sequencing: [`../execution-plan.md`](../execution-plan.md) — wave/ticket IDs.
- Architecture: [`../../../W2_ARCHITECTURE.md`](../../../W2_ARCHITECTURE.md)
  (sections cited as §). Statuses flip `[TARGET]`→`[SHIPPED]` in the same PR
  that lands the code.
- Build board: [`../build-status.html`](../build-status.html) — embedded
  `DATA` block mirrors the register; update it in the same commit.

---

## Spec template (every file in this directory follows it)

```markdown
# <ID> — <title>

REQ: … · Depends on: … · Band: …

## Why
2–4 sentences. Tie to REQ ids and to Dan the retina surgeon's demo.

## Existing seams you MUST reuse
One line each: `path/to/file.ts:Symbol` — exact signature, copied from source.

## Files to create/modify
Exact paths; what changes in each file.

## Step-by-step implementation
Numbered, smallest safe increments. Code sketches for interfaces, Zod
schemas, and route shapes — real signatures, not paraphrases.

## What NOT to do
Guardrails: the tempting shortcuts this ticket must refuse.

## Acceptance checks
Exact commands + expected output.

## Tests to add
File path + describe/it names + what each asserts.

## Tracker updates
- The exact `docs/w2/requirements.md` checkbox lines to flip (quoted).
- `docs/w2/build-status.html` DATA block: ticket ids to mark done + reqGroup
  done-counts to bump.
- The `W2_ARCHITECTURE.md` section header whose status marker to edit.

## Verify + ship ritual
The verbatim block below.
```

## Verify + ship ritual (verbatim, every ticket)

```bash
cd sidecar && npm test && npm run typecheck && npm run eval && npm run build
```

When the panel was touched, additionally:

```bash
cd sidecar/panel && npx tsc -p tsconfig.json --noEmit && npx vitest run && npm run build
```

Then:

1. Conventional commit (`feat(...)`/`fix(...)`/`docs(...)`) **with the
   trailer**: `git commit --trailer "Assisted-by: Claude Code" -m "..."` —
   tracker edits (requirements.md, build-status.html, W2_ARCHITECTURE.md) ride
   the SAME commit as the code.
2. `git push -u origin claude/openemr-rag-requirements-x25vzm`
3. Update the PR #9 body (checklist line for the ticket).
4. Send the user the refreshed dashboard: SendUserFile
   `docs/w2/build-status.html` (rendered inline).

---

## Standing rules (apply to every ticket; they override convenience)

1. **Never bypass or weaken the eval gate.** No skipping `npm run eval`, no
   env-flagging it off, no loosening a comparator to get a PR through.
2. **Never edit `sidecar/eval/baseline.json` by hand.** The only legitimate
   path is `npm run eval:baseline`, with the resulting diff committed and
   explained in the PR body. An unexplained baseline diff is a blocked review.
3. **The $5/day SpendGuard cap is untouchable** (`LLM_DAILY_BUDGET_USD`,
   locked decision #16). If a ticket threatens it, stop and alert the user —
   never raise it silently.
4. **New npm deps go in `sidecar/package.json` or
   `sidecar/panel/package.json` — NEVER the repo-root `package.json`** (that
   one belongs to OpenEMR core).
5. **All LLM/VLM/embed/rerank calls must be stubbed or injectable in tests.**
   Zero live keys in CI (G17). Every new client takes its transport as a
   constructor seam.
6. **Logs and traces carry ids, hashes, and counts — never document text,
   patient identifiers, or extracted clinical values** (G18, P5). The PHI
   sweep evals (`eval/phi-log-sweep.eval.ts`) enforce this: a leaked value is
   a failed gate, not a style nit.
7. **Trackers update in the SAME commit as code** (anti-drift, standing rule
   from the register): requirements.md checkboxes, build-status.html DATA,
   W2_ARCHITECTURE.md status markers.
8. **Strict TypeScript.** `exactOptionalPropertyTypes` is on: never assign
   `x: maybeUndefined` into an optional property — use conditional spreads,
   e.g. `...(x === undefined ? {} : { x })` (this exact pattern is all over
   `src/server.ts` and `src/routes/ingest.ts`; copy it).

## Ticket index

| Spec file | Plan ticket | One-liner |
|---|---|---|
| [E.3-write-path-auth.md](E.3-write-path-auth.md) | E.3 | 401/403 on write paths (upload; verify already done) |
| [E.4-langfuse-observability.md](E.4-langfuse-observability.md) | E.4 | Graph spans in Langfuse + ops tiles + alerts A4–A6 |
| [E.5-langsmith-demo.md](E.5-langsmith-demo.md) | E.5 | LangSmith tracing fenced to the demo env |
| [E.6-ready-probes.md](E.6-ready-probes.md) | E.6 | `/ready` probes: document_storage, retriever_index, reranker — **reference (implemented)** |
| [E.7-openapi.md](E.7-openapi.md) | E.7 | Sidecar OpenAPI 3.0 spec + contract test |
| [E.8-bruno.md](E.8-bruno.md) | E.8 | Bruno collection: documents + evidence folder |
| [E.9-evidence-turn-and-composer.md](E.9-evidence-turn-and-composer.md) | E.9 | Production AnswerComposer + chat-route graph wiring + status SSE |
| [F.1-baselines.md](F.1-baselines.md) | F.1 | W2 latency baselines (p50/p95) vs SLOs |
| [F.2-cost-latency-report.md](F.2-cost-latency-report.md) | F.2 | Cost & latency report (D7) |
| [F.3-data-model-backup.md](F.3-data-model-backup.md) | **F.4** | Backup/recovery runbook + §10 data-authority completion |
| [F.4-demo-video-script.md](F.4-demo-video-script.md) | **F.5** | Demo video shot list (D6) |
| [F.5-readme-deliverables.md](F.5-readme-deliverables.md) | **F.3** | README restructure (D1) |
| [USER-ACTIONS.md](USER-ACTIONS.md) | 0.3/0.5/F.6 | The user's key-drop + branch-protection checklist |

> Numbering note: three spec filenames (F.3/F.4/F.5) were assigned before the
> execution-plan wave-F numbering settled; the **Plan ticket** column above is
> authoritative for requirements/tracker references. Each spec's metadata line
> repeats its plan ticket id.
