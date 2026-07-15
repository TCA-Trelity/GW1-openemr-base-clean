# K.1 — Lock "stay narrow: retina/medical-retina depth over ophthalmology breadth" in DECISIONS.md

REQ: roadmap (no W2 register REQ — product-scope decision) · Depends on: — · Band: merged-plan Track 1 (K, trimmed) · Priority: P1 (per merged-plan.md; not deadline-bound)

## Why

The single biggest "don't build" call carried over from Plan A: this product
wins on depth in one subspecialty workflow (HCQ monitoring, OCT-driven
medical-retina follow-up, lab→risk re-tiering), not on breadth against
established full-ophthalmology EHRs. That call currently lives only inside
`docs/internal/merged-plan.md` (an internal working doc). Un-ledgered
decisions get silently re-litigated by every future session; this ticket
makes it one paste into the project's chronological decision ledger, with an
explicit revisit condition so it stays a deliberate, revisitable choice.

## Existing seams you MUST reuse

- `docs/execution/DECISIONS.md` — the decision ledger. **Format facts, verified:** it is an UNNUMBERED chronological ledger — `- DECISION: …` bullet lines grouped under dated `## <topic> (YYYY-MM-DD…)` section headers, "Newest entries at the bottom" (file header, lines 3-6). It is *not* the numbered register.
  - **Correction vs the merged-plan briefing:** the "locked decision #N" numbering (e.g. #16 SpendGuard) lives in `docs/w2/requirements.md` **§6 "Locked decision register (user-confirmed, 2026-07-13)"** — a 20-row table scoped to the Week-2 build. K.1's entry goes in DECISIONS.md (the file the merged plan names), NOT as row 21 of that W2 table.
- `docs/internal/merged-plan.md` — Track 1 Sub-track K item K.1 (the mandate + the example revisit condition), the "Explicitly out of scope" list (its "Broadening the product's clinical focus…" bullet is the same decision, cross-reference it), and context decision #4 (the user's trim of Wave K).
- `W2_ARCHITECTURE.md` §17 ("Deliberately out of scope") — the architecture-side twin of this scope stance; the entry cross-references it, no edit needed there.
- Existing DECISIONS.md entry style to mirror: one bullet = decision + rationale + (where applicable) explicit supersede/revisit language — see "DECISION (revisits the BullMQ line above)…" for the revisit idiom.

## Files to create/modify

- `docs/execution/DECISIONS.md` — append ONE new section at the bottom of the file (newest-at-bottom rule).

## Step-by-step implementation

1. Append to the very end of `docs/execution/DECISIONS.md` (stamp the actual execution date in the heading — every section header in the file carries one):

   ```markdown
   ## Product scope (2026-MM-DD, merged-plan K.1)

   - DECISION: Stay narrow — retina/medical-retina depth over ophthalmology
     breadth. The co-pilot competes on depth in one subspecialty workflow
     (HCQ monitoring, lab→eGFR→risk re-tiering, OCT-driven medical-retina
     follow-up) rather than on feature parity with established full-scope
     ophthalmology EHR products (refraction/optical workflows, surgical
     scheduling breadth, general-ophtho menu surface). New product work that
     broadens clinical scope is out of scope unless it deepens the
     medical-retina workflow. REVISIT CONDITION: revisit this decision when
     a second paying customer's primary need is a different ophthalmic
     subspecialty (e.g. glaucoma or anterior segment), or when the pilot
     practice's real usage shows a sustained majority of co-pilot sessions
     falling outside medical retina — and revisiting means a deliberate
     scope conversation with the user, never silent scope creep via
     individual tickets. (Cross-refs: merged-plan Track 1 K.1 + its
     "Explicitly out of scope" list; W2_ARCHITECTURE.md §17; the three
     medically-judgment-heavy roadmap pieces deliberately excluded from the
     merged plan remain excluded until that conversation.)
   ```

   Executing this ticket is: stamp the date, paste, commit. Do not reword the
   decision line in ways that weaken the revisit condition — its two triggers
   (second customer with a different subspecialty; sustained real-usage
   drift) are the substance.
2. Read the appended file once end-to-end for format consistency (bullet
   indentation and `- DECISION:` prefix match the neighbors).
3. Trackers, ship ritual.

## What NOT to do

- Do NOT add a row to `docs/w2/requirements.md` §6 — that table is the
  user-confirmed W2 build register (rows 1-20, dated 2026-07-13); K.1 is a
  product-roadmap decision and belongs in the chronological ledger. Mixing
  the two ledgers is exactly the drift this repo's docs fight.
- Do NOT renumber, re-sort, or edit any existing DECISIONS.md entry —
  append-only, newest at the bottom.
- Do NOT expand the entry into the three excluded judgment-call topics
  (imaging-scenario deepening, the glaucoma-patient mismatch, first-run UI
  explainer) — the merged plan explicitly reserves those for their own
  conversation; this entry only references their exclusion.
- Do NOT link DECISIONS.md from README/grader-facing docs as part of this
  change (it is already linked where it should be; standing rule 7 applies
  to the internal plan docs cited).

## Acceptance checks

```bash
tail -25 docs/execution/DECISIONS.md
grep -n "Stay narrow" docs/execution/DECISIONS.md
grep -c "REVISIT CONDITION" docs/execution/DECISIONS.md
```

The new section is the last one in the file; the grep hits exactly once; the
heading carries the real execution date.

## Tests to add

None (ledger entry). The acceptance greps are the executable evidence.

## Tracker updates

- `docs/internal/build-status.html` DATA block: ticket `K.1` (T1 section) → `s: "done"`.
- `docs/w2/requirements.md` — no checkbox; do not invent one (and per the guardrail above, no §6 row either).
- `W2_ARCHITECTURE.md` — no edit (§17 already states the out-of-scope stance; the ledger entry references it).

## Verify + ship ritual

```bash
cd sidecar && npm test && npm run typecheck && npm run eval && npm run build
```

(Docs-only PR — belt-and-braces; the `Run eval suite` required check runs on
every PR regardless.) Panel untouched — skip the panel leg. Then:
conventional commit (`docs(decisions): lock stay-narrow product scope (K.1)`)
with `--trailer "Assisted-by: Claude Code"` (trackers in the SAME commit) →
`git push -u origin claude/merged-eval-course-plan-ky6ulh` → update the
PR #16 body → SendUserFile `docs/internal/build-status.html`.
