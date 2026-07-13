# Demo video — script & shot list (D6)

**Target ≤ 4:30** (hard ceiling 5:00). The six spec items run **in the graded
order**: upload → extraction → evidence retrieval → citations → eval results →
observability. Every shot carries a REQ + `USERS.md` UC caption so the video
doubles as the capability-to-user mapping (S5). **Recording and hosting are a
HUMAN action** — see the recording checklist at the end; this document is the
committable script.

## Pre-flight checklist

- [ ] Stack up — Railway (URLs in README) or local (`docker compose` for
  OpenEMR if needed + `cd sidecar && npm run dev` with `DATABASE_URL`).
- [ ] **`ANTHROPIC_API_KEY` present on the stack** — shots 1–4 make live
  VLM/composer calls (extraction, evidence turn). Shots 5–6 run keyless.
- [ ] `DEV_LOGIN_SECRET` set (RUNBOOK §D) — the upload is write-gated (E.3).
- [ ] `margaret-chen` seeded (`npx tsx src/scripts/seed.ts`) and prepped once.
- [ ] Fixtures on the recording machine:
  `sidecar/eval/fixtures/documents/renal-panel-clean.pdf` and
  `renal-panel-lowdpi.pdf`.
- [ ] Browser 1080p, notifications off, panel open on Margaret Chen.
- [ ] Say the synthetic-data line in shot 0 — non-negotiable.

## Shots

### 0 — Intro (10 s)

*On screen:* the panel landing on Margaret Chen.
*Voice:* "This is the Clinical Co-Pilot for Dan, a retina surgeon — Week 2
adds a multimodal evidence agent. **Everything here is synthetic data; no
real patient information appears anywhere.**"

### 1 — Document upload (40 s) — S1/R1, locked #7/#14 · UC-4 arc opens

*On screen:* Role switcher → **nurse** ("intake staff can attach; watch the
resident get refused later if time allows"). Sources tab → drag
`renal-panel-clean.pdf` onto the upload card → doc type "Outside lab report
(PDF)" → staged progress advances (received → extracting → grounding →
patient check → persisting → **complete**, with the grounding summary and
facts-persisted count).
*Voice:* "The front desk drags in an outside renal panel. Upload is a chart
write, so it demands an attributable clinical role — and the pipeline stages
you're watching are the actual ingestion record; one correlation ID
reconstructs all of it."

### 2 — Extraction, with its honesty (45 s) — R5, E2, P2 · UC-2

*On screen:* "View document with citation overlay" → the PDF renders with
**tight amber boxes** on the extracted values (click eGFR 42 — the box and
the legend entry light up together); point at a **page-level** entry; then
upload `renal-panel-lowdpi.pdf` and open ITS overlay — every field sits in
the red **"not located — never citable"** list (the low-dpi scan is
image-only, so there is no text geometry to ground against; proven in the
eval case `extraction.degraded-scan-no-fabricated-geometry`).
*Voice:* "Extraction is only trusted where we can ground it in the document's
own geometry. Three outcomes, visibly distinct: located exactly, located on
the page, or not located — and 'not located' can never be cited. The system
never fakes precision it doesn't have."

### 3 — Extraction becomes clinical meaning (30 s) — S1/R1 persistence · UC-4

*On screen:* Medical Background tab → the new `lab_result` facts with source
chips → the **hydroxychloroquine risk flag, re-tiered** — open its details:
the eGFR value sits in the flag with its provenance.
*Voice:* "The extracted eGFR of 42 didn't just get stored — it re-tiered
Margaret's hydroxychloroquine toxicity risk through the same deterministic
engine the chart uses. That's the point of extraction: documents becoming
decisions-support, with provenance."

### 4 — Evidence retrieval + citations (45 s) — S2/R3, S3/R4, R5, E1 (E.9) · UC-4/UC-9

*On screen:* Chat drawer → ask **"What screening interval do the guidelines
recommend for HCQ with reduced renal function?"** → the italic
"checking practice protocols…" status line → the cited answer streams →
click the **guideline chip**.
*Voice:* "Guideline-shaped questions route through the supervisor graph:
hybrid retrieval over our authored practice protocols, then a critic — the
same deterministic citation gate from Week 1 — verifies every quote verbatim
before it can be released. What you're reading survived that gate."

### 5 — Honest refusal (20 s) — S4/R6 `safe_refusal` · Non-goals posture

*On screen:* Ask "What do the guidelines recommend for trabeculectomy
follow-up?" (out of corpus) → "No practice protocol on file covers this
question."
*Voice:* "Out-of-corpus questions get an honest empty answer — the retriever's
confidence floor refuses to force a match, and the agent never invents a
protocol."

### 6 — The eval gate, attacked on camera (40 s) — S4/R6, D5, D.7

*On screen:* Terminal, sped-up montage: `npm run gate-rehearsal` — three
injected regressions (dropped citations / deleted schema retry / logged PHI)
each caught by its intended category — then cut to the per-category table in
`docs/execution/eval-results.md` (58/58, six categories).
*Voice:* "The grading scenario is an injected regression, so we rehearse it:
three sabotages, three catches — safety categories fail on any single case,
quality categories on baseline drift. The gate blocks the push and the PR."

### 7 — Observability (25 s) — R7, G4, G13

*On screen:* **If Langfuse/LangSmith keys have landed** (USER-ACTIONS.md):
the Langfuse trace of shot 4's turn — trace id equals the response's
`x-correlation-id`, spans supervisor→evidence_retriever→critic→answer (and
the LangSmith run tree in the demo env, if keyed). **Keyless fallback — do
not fake a trace screenshot:** grep the structured `worker_handoff` lines by
correlation id, exactly as committed in `docs/w2/trace-example.md`.
*Voice:* "Every handoff you just saw is an event with the turn's correlation
ID — one ID reconstructs the whole multi-agent trace, in logs or in Langfuse."

### 8 — Outro (10 s)

*Voice:* "Architecture, requirements register, eval gate, runbooks, and this
script are all in the repo — `W2_ARCHITECTURE.md` is the front door."

**Timing: 10+40+45+30+45+20+40+25+10 ≈ 4:25.**

## Recording checklist (human actions)

- [ ] Dry-run every click above against the running stack once before
  recording (shots 1–4 need `ANTHROPIC_API_KEY`; expect the first extraction
  to take seconds-to-tens-of-seconds — it's the live VLM call, F.2 §6.5).
- [ ] Record ≤ 5:00 at 1080p; trim dead air in the shot-1 extraction wait
  (cut to the stage list advancing).
- [ ] Host (Loom / unlisted YouTube) and paste the link into README's Week 2
  deliverables table (placeholder row is present) — **D6 is done only when
  that link exists.**
