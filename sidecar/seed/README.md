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

## Seeding the patients into OpenEMR itself (E1)

`src/scripts/seed-ehr.ts` creates these five patients *inside* OpenEMR via the
standard REST API — demographics, problem list (with ICD-10), allergies
(reaction/severity in comments), and medication list (dose/frequency in the
title; the standard API has no prescription write route) — then writes each
returned patient uuid into the sidecar store's `patients.openemr_patient_id`,
so FHIR reads resolve to real EHR records. Idempotent: patients are matched by
name+DOB and list entries by title, so re-runs converge.

Runbook, in order (full details in the script header):

1. OpenEMR admin, Administration → Config → Connectors: enable
   **OpenEMR Standard REST API** and **OAuth2 Password Grant**.
2. `railway ssh "node dist/scripts/register-oauth.js"` and set the printed
   `OPENEMR_CLIENT_ID` / `OPENEMR_CLIENT_KEY` on the sidecar service. (Clients
   registered before E1 lack the write scopes — re-register.)
3. OpenEMR admin, Administration → System → API Clients: **Enable** the client.
4. `railway ssh "OPENEMR_SEED_USERNAME=admin OPENEMR_SEED_PASSWORD=... node dist/scripts/seed-ehr.js"`

Locally: `npm run seed-ehr` (needs the same env vars plus `DATABASE_URL`).

Note: re-running `seed.js` wipes and reloads each patient row, which clears the
`openemr_patient_id` link — re-run `seed-ehr.js` afterwards to restore it (the
EHR side is untouched; the run just re-finds the existing charts).
