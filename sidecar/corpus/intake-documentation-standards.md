---
id: intake-documentation-standards
title: Intake Documentation and Verification Standards
guideline_source: "Practice-adopted policy (grounds missing-data and unverified-record handling)"
version: "2026-07"
effective_date: "2026-07-01"
disease_tags: [intake-documentation, data-verification, record-integrity]
laterality_applicability: NA
recommendation_strength: practice-adopted
---

## Purpose and scope

This protocol sets the practice's standards for new and updated intake
documentation: which fields are required, who may verify what, and how outside or
unverifiable records are handled. It is an internal policy (not a clinical guideline)
that grounds honest missing-data behavior — the co-pilot must state what is unknown
or unverified rather than paper over gaps. It applies to intake capture regardless
of laterality (clinical-finding field values still carry their own OD/OS/OU tag).

## Required intake fields

Every intake (new patient or update) must capture the following as first-class,
individually sourced fields. A field that is genuinely absent from the source is
marked **missing**, never silently defaulted or inferred.

| Field | Requirement |
|-------|-------------|
| Chief concern | Free text WITH laterality tag (OD / OS / OU) — laterality is required, not optional |
| Current medications | Each drug WITH dose and start date (start date drives cumulative-exposure math, e.g. HCQ) |
| Allergies | Each allergy WITH the specific reaction (e.g. rash, anaphylaxis), not just the agent |
| Family ocular history | Relevant hereditary/ocular conditions with the relation |
| Patient goals | "What the patient is hoping for" — captured as clinical information, not a billing field |

Patient goals are treated as first-class clinical information because they shape
sequencing and counseling; they are verified and cited like any other fact.

## Why start dates and reactions are mandatory, not optional

- **Medication start date** is a hard requirement because downstream engines compute
  cumulative dose × duration against published thresholds (e.g. hydroxychloroquine
  toxicity); a medication without a start date cannot feed those computations and is
  flagged incomplete, not assumed.
- **Allergy reaction** is required because "penicillin allergy" without the reaction
  (intolerance vs anaphylaxis) is not actionable; the reaction is part of the fact.

## Verification workflow (who may verify what)

Verification records **who** confirmed a fact and **in what role**, and it persists
for the next clinician. Roles have scoped authority:

| Role | May verify |
|------|-----------|
| Technician / front-desk | Transcription-level fields: demographics, medication list as stated, stated allergies, reason-for-visit text |
| Nurse | The above, plus reconciliation of medication lists against pharmacy/outside sources |
| Physician | Clinical facts and any fact that changes management — allergy severity interpretation, laterality of a finding, goal relevance, contradiction resolution |

A fact verified at one level is not automatically clinically verified: a
technician-confirmed medication list is "confirmed as transcribed," not
"clinically reconciled." The verifying role travels with the fact.

## Handling unverifiable and outside records

The core integrity rule: **mark unverified, never silently merge.**

- Facts from outside records load as **unverified (outside record)** with their
  source and date, and stay that way until confirmed by a role authorized to verify them.
- **Never silently merge or overwrite** a prior fact with an outside value. A newer
  dated value supersedes an older one with the lineage preserved; conflicting values
  are surfaced as a discrepancy, not collapsed into one.
- When two sources disagree (e.g. two medication start dates, an allergy asserted in
  one source and denied in another), present both with their sources and a
  clarifying question — the physician resolves it.
- A fact that cannot be located or confirmed in any source is reported as
  **unknown / unverifiable** — the co-pilot says so rather than guessing.

## Missing-data and refusal behavior (what this grounds)

This policy is the basis for the agent's honest-gap posture:

- If a required field is absent, the brief states it is **missing** and names the field.
- If a value exists but is unconfirmed, it is shown **unverified** with its source,
  never presented as established fact.
- If a computation's inputs are incomplete (e.g. a drug with no start date), the
  agent reports that it **cannot compute** rather than producing a number from an assumption.
- The agent must never fabricate a citation, a source, or a value to fill a gap — a
  silently-wrong brief is worse than an explicit gap.

## Documentation requirements

For every intake fact record: the value, its source, its collection/stated date, its
verification status and the role that set it, and (for clinical findings) its
laterality. Discrepancies are recorded as discrepancies with both sources retained.

## References

- Practice-adopted policy. Grounds the missing-data, unverified-record, and refusal
  behaviors described in the practice's user and use-case documentation
  (pre-visit brief integrity, iterative verification, contradiction surfacing,
  and patient-goal capture).
