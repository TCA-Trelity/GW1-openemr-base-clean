# Synthetic patient corpus (seed data = eval ground truth)

This corpus is simultaneously the demo data and the eval fixture set: **every
planted issue carries its recorded correct answer**, so every demo run is a test
run. Converted faithfully from the `second-opinion` prototype (see
`docs/research/second-opinion-port-manifest.md` §6); all patients and documents
are entirely synthetic.

## Files

- `margaret-chen.json` — new patient, floaters/PVD, RA on hydroxychloroquine.
  12 full-text source documents, 4 planted contradictions with
  `ground_truth {accurate_value, source, rationale}`, 6 authored OCT records
  whose GC-IPL series (82→80→78→75→72→70 µm, plus RPE severity mild→moderate in
  the last two) encodes the HCQ-toxicity trend, `medication_start` event 2021-12-01.
- `william-thompson.json` — wet AMD on Eylea treat-and-extend. 7 OCT OD records +
  4 injections authored so the interval analyzer finds "stable at 7 weeks but
  leaked at 10 weeks" (49-day cycles good, 71-day extension → CRT 264→331 with
  `worsened` response), plus minimal demographics, AMD conditions, and 2 brief docs.
- `images/manifest.json` — Kermany-class (CC BY 4.0) OCT stand-in per image record
  (`CNV` for William's fluid visits, `NORMAL` otherwise); files fetched later by a
  sourcing script. Attribution: `docs/data-sources.md`.

## Eval assertions this corpus supports

1. Contradiction detection finds all 4 planted contradictions (severities
   critical/high/moderate/moderate) and no others from the document set.
2. `analyzeHCQProgression` over Margaret's images reports GC decline ≥10 µm and
   RPE progression (alert level high).
3. `analyzeIntervalPatterns` over William's images+treatments recommends 7-week
   intervals (max good 7 w, min bad 10 w, confidence high).
4. Every `sources[].excerpt_text` and contradiction `exact_text` resolves verbatim
   (character range) inside its referenced document's `content.text_content`.

Note: `intentional_issues` blocks and `ground_truth` fields are demo/eval
fixtures only — never import them into the EHR or expose them to the panel.
