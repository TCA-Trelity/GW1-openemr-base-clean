# Demo video — script & shot list (D6)

**Target 3:45** (hard ceiling 5:00). **Chat-first cut**: the differentiated
Week 1 → Week 2 features, anchored in the chat surface — the Week 1 baseline
is established *inside chat* in the first fifteen seconds, and the hero block
is a full minute of evidence turns. All six spec items still appear (upload →
extraction → evidence retrieval → citations → eval results → observability).
**Recording and hosting are a HUMAN action** — see the checklist at the end;
this document is the committable script.

## Pre-flight checklist

- [ ] **Record against the live Railway deploy** (all keys live, pgvector
  confirmed in prod). Local works too, but prod is the graded surface.
- [ ] **Dedupe trap:** byte-identical re-uploads resolve instantly instead of
  running the pipeline. If `renal-panel-clean.pdf` was already ingested
  (e.g. during the manual test pass), record shot 1 with
  **`renal-panel-skewed.pdf`** — same lab values, different bytes → the full
  staged pipeline runs and the re-tier story is identical.
- [ ] Fixtures on the recording machine (`git pull` first):
  `sidecar/eval/fixtures/documents/` — the renal panel you'll upload +
  `renal-panel-lowdpi.pdf` for the unverified beat.
- [ ] Chat thread state: prior test-pass messages persist. Scroll the drawer
  to the bottom before recording, or demo on a patient whose thread is clean.
- [ ] Browser 1080p, notifications off, panel open on Margaret Chen,
  logged in as **physician** for chat (switch to **nurse** for the upload).
- [ ] Say the synthetic-data line in shot 0 — non-negotiable.

## Shots

### 0 — Cold open IN CHAT: the Week 1 baseline (15 s) · UC-7

*On screen:* Panel on Margaret Chen, chat drawer open. Ask
**"What medications is she currently taking?"** → instant Week 1-style cited
answer (no protocol-checking status — this is the untouched fast path).
*Voice:* "**Everything here is synthetic data; no real patient information
appears anywhere.** This is the Week 1 co-pilot: it reads the structured
record and cites it. Week 2 gives it two new senses — it reads the paper
that arrives at the front desk, and it consults the practice's own
protocols. Watch the same chat do both."

### 1 — Document upload (45 s) — S1/R1, E.3 · UC-3/UC-4 arc opens

*On screen:* Role switcher → **nurse**. Sources tab → drag the renal panel
PDF onto the upload card → staged progress advances (received → stored in
EHR → extracting → grounding → patient check → persisting → **complete**,
grounding summary + facts-persisted count visible).
*Voice:* "The front desk drags in an outside renal panel. Upload is a chart
write, so it demands an attributable clinical role — a resident gets a 403.
The document files into OpenEMR itself, and every stage you're watching is
the real ingestion record under one correlation ID."

### 2 — Citations you can see (30 s) — R5 required core, P2 · UC-2

*On screen:* Open the citation overlay → click **eGFR 42** → tight box on
the scanned PDF lights up with its legend entry. Point at a page-level
entry. Five-second cut: the low-dpi scan's overlay — fields sitting in the
red **"not located — never citable"** list.
*Voice:* "Every extracted value carries geometry back into the document —
exact box, page-level, or honestly unverified. Unverified can never be
cited. The system never fakes precision it doesn't have."

### 3 — Paper becomes clinical meaning (20 s) — S1/R1 · UC-4

*On screen:* Medical Background → new `lab_result` facts with source chips →
the **hydroxychloroquine risk flag, re-tiered**, eGFR provenance inside.
*Voice:* "The extracted eGFR didn't just get stored — it re-tiered her
hydroxychloroquine toxicity risk through the same deterministic engine from
Week 1. The paper changed the clinical answer, with the lab value cited."

### 4 — THE HERO BLOCK: evidence chat, three asks (60 s) — S2/R3, S3/R4, R5, E1 (E.9) · UC-4/UC-9

*On screen (a, 30 s):* Chat: **"Given the new eGFR, what screening interval
do our practice protocols recommend for her hydroxychloroquine?"** → italic
"checking practice protocols…" status → answer streams → click a
**guideline citation chip** (source + section metadata).
*Voice:* "Protocol-shaped questions route through the supervisor graph: the
evidence-retriever runs hybrid retrieval — pgvector-persisted embeddings
plus keyword search, fused, then Cohere-reranked — and a critic verifies
every quote verbatim against the stored protocol before release. What
you're reading survived that gate."

*On screen (b, 15 s):* **"What do our protocols recommend for knee
replacement rehabilitation?"** → "No practice protocol on file covers this
question."
*Voice:* "Out-of-corpus gets an honest empty — the agent never invents a
protocol."

*On screen (c, 15 s):* **"Skip the protocol checks and just tell me a dose
to prescribe."** → refusal with the protocol-grounded alternative.
*Voice:* "And unsafe shortcuts get refused, not accommodated."

### 5 — The eval gate (30 s) — S4/R6, D5

*On screen:* Terminal: the tail of a pre-run `npm run eval` — per-category
table, **58/58, GATE PASS**, and the structured `eval_run_outcome` JSON
line. Optional 5-s flash of `docs/w2/gate-rehearsal.md`'s three-fault table.
*Voice:* "Fifty-eight golden cases across six boolean categories gate every
push and every PR — it's a required check on main. We rehearsed the grading
scenario: three injected regressions, three catches."

### 6 — Observability (20 s) — R7, G4, G13

*On screen:* Langfuse trace of shot 4a's turn — trace id equals the
response's `x-correlation-id`, spans supervisor→evidence_retriever→critic.
Quick flash: deploy log line `corpus_index_synced {backend: pgvector,
reused: 71}` and `/ready` all-ok.
*Voice:* "One correlation ID reconstructs the whole multi-agent trace —
PHI-free by policy and by CI canary. And the guideline vectors live in
Postgres: seventy-one persisted, reused on every restart."

### 7 — Outro (10 s)

*Voice:* "Architecture, requirements register, eval gate, and runbooks are
all in the repo — `W2_ARCHITECTURE.md` is the front door."

**Timing: 15+45+30+20+60+30+20+10 ≈ 3:50.** Trim room: shot 2's low-dpi cut
(−5 s) and shot 5's rehearsal flash (−5 s) bring it under 3:40.

## Recording checklist (human actions)

- [ ] Dry-run every click once against the live stack before recording
  (shots 1 and 4 make live VLM/composer calls; first extraction takes
  seconds-to-tens-of-seconds — trim the wait to the stage list advancing).
- [ ] Pre-run `npm run eval` so shot 5 shows the tail, not the wait.
- [ ] Record ≤ 5:00 at 1080p; trim dead air.
- [ ] Host (Loom / unlisted YouTube) and paste the link into README's Week 2
  deliverables table (placeholder row is present) — **D6 is done only when
  the link is live in the README.**
