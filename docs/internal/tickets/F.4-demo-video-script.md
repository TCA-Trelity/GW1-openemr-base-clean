# F.4 — Demo video script + shot list (execution-plan ticket **F.5**, D6)

REQ: D6, S5 · Plan ticket: **F.5** in `docs/w2/execution-plan.md` · Depends on: E.1/E.2 (shipped), E.9, D.7 (rehearsal — shipped) · Band: 3

## Why

D6: a 3–5 minute video covering, in order, the six spec items — document
upload, extraction, evidence retrieval, citations, eval results,
observability — synthetic data only. This ticket's committable deliverable is
the **script/shot-list document**; the recording itself is a human action
(flag it). Every shot maps to a REQ id and a `USERS.md` use case so the video
doubles as the defense's capability-to-user mapping (S5: "explain why each
capability maps back to the Week 1 user and workflow").

## Existing seams you MUST reuse

- `USERS.md` — persona **Dan, retina surgeon** (~35 years, founded the category-leading ophthalmology EHR); use cases UC-1 (90-second pre-visit brief), UC-2 (iterative verification and drill-down), UC-3 (contradiction surfacing), UC-4 (auto-computed medication-toxicity risk), UC-5 (treat-and-extend interval guidance), UC-6 (imaging in context), UC-7 (patient-goal-aware care), UC-8 (imaging drill-down thread), UC-9 (recommendation-shaped asks as thought partner), plus `## Non-goals` (the refusal posture).
- Fixtures: `sidecar/eval/fixtures/documents/renal-panel-clean.pdf` (hero, declining eGFR), `renal-panel-lowdpi.pdf` / `intake-update-scanned.pdf` (the degradation-ladder docs that yield the **unverified** grounding outcome).
- Hero patient: `margaret-chen` (locked #8 — the HCQ-monitoring patient; renal panel → eGFR → HCQ risk re-tier arc, UC-4).
- The evidence question that exercises E.9 end-to-end: **"What screening interval do the guidelines recommend for HCQ with reduced renal function?"**
- `npm run gate-rehearsal` (`sh eval/rehearsal/run-rehearsal.sh`) + `docs/w2/gate-rehearsal.md` — the three-injected-regressions run for shot 6; `docs/execution/eval-results.md` — the per-category table.
- Panel surfaces: upload card (role switcher → nurse = front-desk persona), Sources tab PDF preview + bbox overlay (three visibly distinct grounding outcomes), Medical Background fact list, chat drawer (status line + guideline chips).
- Deployed URLs (README L28/L30) or local stack — script both options; RUNBOOK §D for dev-login.

## Files to create/modify

- **Create** `docs/w2/demo-script.md` — the shot list below, written out with exact clicks, exact spoken beats, and per-shot REQ/UC captions.
- **Modify** `README.md` — the video link line lands in the Week 2 deliverables table **when the recording exists** (placeholder row until then).

## Step-by-step implementation

1. Write `docs/w2/demo-script.md` with: a pre-flight checklist (stack up
   [local or Railway], `DEV_LOGIN_SECRET` set, `margaret-chen` seeded +
   prepped, fixtures downloaded to the recording machine, roles ready in the
   switcher, browser at 1080p, notifications off, **synthetic data banner
   stated up front**); a timing budget totaling ≤ 4:30; then the seven shots.
   Each shot block: *on screen* (exact clicks), *voice-over beat* (1–2
   sentences), *caption* (REQ ids + UC), *target duration*.

| # | Shot (what the viewer sees) | Spec item | REQ | UC | ~sec |
|---|---|---|---|---|---|
| 1 | Role switcher → nurse ("front desk"); drag `renal-panel-clean.pdf` onto the upload card as lab_pdf; staged ingestion progress to `complete` | document upload | S1/R1, S5 (locked #7/#14) | UC-4 arc opens | 40 |
| 2 | Sources tab → open the stored PDF; click citations showing the **three grounding outcomes**: tight bbox (word-geometry), page-region (VLM page), and — after uploading the degraded fixture (`renal-panel-lowdpi.pdf`) — the **unverified, uncitable** row, visibly flagged | extraction (+ its honesty) | R5, E2, P2, A.5 | UC-2 | 45 |
| 3 | Medical Background: extracted `lab_result` facts with source chips; the HCQ risk flag **re-tiered** by the declining eGFR — open details to show the eGFR value + provenance | extraction → clinical meaning | S1/R1 (persistence), UC-4's engine | UC-4 | 30 |
| 4 | Chat: ask the HCQ screening-interval question → "checking practice protocols…" status → cited answer with a guideline chip; click the chip | evidence retrieval + citations | S2/R3, S3/R4, R5, E1 (E.9) | UC-4, UC-9 (UC-5 family) | 45 |
| 5 | Ask an out-of-corpus question (e.g. a glaucoma-surgery protocol) → honest "no practice protocol on file covers this question" — no invention | refusal / missing-data | S4/R6 (`safe_refusal`), USERS.md Non-goals | UC-9 posture | 20 |
| 6 | Terminal: `npm run gate-rehearsal` montage (sped up) — three injected regressions, three caught, each naming its category; cut to the per-category table in `eval-results.md` | eval results | S4/R6, D5, D.7 | trust substrate for every UC | 40 |
| 7 | Langfuse trace of the shot-4 turn (trace id = the response's correlation id); if the demo env has LangSmith keys, the LangGraph run tree — **only if keys landed** (USER-ACTIONS.md), else show the structured `worker_handoff` log lines from `docs/w2/trace-example.md`'s query instead | observability | R7, G4, G13 | — | 25 |

   Plus intro (10 s: "Dan, retina surgeon; synthetic data only") and outro
   (10 s: deliverables pointer). Total ≈ 4:15.
2. Dry-run the script click-by-click against a running stack; fix any step
   that doesn't reproduce (e.g. which degraded fixture actually yields an
   unverified row — verify by uploading both candidates and checking the
   overlay legend; write down the one that does).
3. **Flag for the human**: recording + hosting (Loom/YouTube-unlisted) is a
   user action — the script doc ends with a "Recording checklist" section
   saying exactly that. Add the README placeholder row.
4. Trackers, ship (the script; the video link lands in a follow-up commit
   when recorded).

## What NOT to do

- Do NOT show real patient data, real names, or a production screen — the
  synthetic-data statement is shot 0 and non-negotiable (HIPAA framing).
- Do NOT script capabilities that have not landed (check E.9 is merged
  before scripting shot 4's status line; if LangSmith keys are absent,
  shot 7 uses the log-lines fallback — never fake a trace screenshot).
- Do NOT exceed 5:00 or reorder the six spec items — the order is graded.
- Do NOT mark the D6 deliverable done on committing the script — done =
  video linked in README.

## Acceptance checks

```bash
git diff docs/w2/demo-script.md README.md   # script with 7 shots + pre-flight + REQ/UC captions
# Dry run: every click in the script reproduces against a running stack;
# shot 2's unverified fixture named from observation, not assumption.
```

Video (user action): 3–5 min, six items in order, linked in README.

## Tests to add

None — a script document. (Ship ritual still runs.)

## Tracker updates

- `docs/w2/requirements.md` — **D6 is a table row** (section 3): no checkbox; annotate the row "script committed (docs/w2/demo-script.md); recording pending" until the link exists.
- `docs/internal/build-status.html` — DATA (starts L189): ticket **`F.5`** (`{ id: "F.5", … }` — NOT "F.4"; spec filename differs from the plan ticket) → `s: "active"` on script commit, `s: "done"` only when the video is linked in README; bump the Deliverables (D6) reqGroup count at that point.
- `W2_ARCHITECTURE.md` — no section marker owned by this ticket; skip.

## Verify + ship ritual

```bash
cd sidecar && npm test && npm run typecheck && npm run eval && npm run build
```

Panel untouched — skip the panel leg. Then: conventional commit with
`--trailer "Assisted-by: Claude Code"` (trackers in the SAME commit) →
`git push -u origin claude/openemr-rag-requirements-x25vzm` → update PR #9
body → SendUserFile `docs/internal/build-status.html`.
