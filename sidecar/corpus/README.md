# Clinical-guideline corpus (practice-protocol RAG source)

This directory is the **retrieval corpus** for the Week 2 hybrid RAG pipeline
(requirement **S2/R3**). It is a small set of **authored practice-protocol
documents** — the "agreed clinical practices the office follows" — for a
fictional retina practice serving the user persona in
[`USERS.md`](../../USERS.md) (Dan, retina surgeon). Each protocol is written
in-house and grounded in named, real clinical guidelines that it cites as
references.

These documents are the *evidence* the evidence-retriever worker returns and
the answer model grounds on. Clinical accuracy therefore matters: the numeric
thresholds here become the practice's cited clinical evidence.

## What this is (and is not)

- **Is:** internal, practice-adopted operating protocols — screening cadences,
  staging ladders, dosing thresholds, treatment-selection rules, and
  documentation standards — for one fictional practice.
- **Is not:** a reproduction of any guideline's text, a patient record, or a
  medical-search knowledge base. The agent grounds answers about *this
  practice's protocols* on these documents; it does not answer generic medical
  questions untethered from the record (see `USERS.md` non-goals).

## Licensing stance: authored, not copied

Every document is **written in our own words**. Real guidelines (AAO Preferred
Practice Patterns, the AAO 2016 hydroxychloroquine screening statement, ADA
Standards of Care, DRCR Retina Network protocols, and named trials) are cited
by **name and year as references** — their text is never copied. Numeric
thresholds are facts, not creative expression, and each is stated with its
source attribution inline. This keeps the corpus **license-clean** and safe to
commit to the repository.

## Zero PHI by construction

There are **no patients, no charts, and no PHI** anywhere in this corpus — these
are policy documents, not records. This is a structural property (the retrieval
queries built against this corpus are de-identified clinical concepts only per
S2/R3), not a scrubbing step.

## Frontmatter metadata contract

Every `.md` protocol begins with YAML frontmatter in exactly this shape. The
chunker (ticket B.2) and index builder (B.3) depend on these keys; the disease
and laterality filters (E5) read `disease_tags` and `laterality_applicability`.

```yaml
---
id: hcq-screening                       # kebab-case, stable; becomes the chunk-id prefix
title: Hydroxychloroquine Retinopathy Screening Protocol
guideline_source: "AAO Statement: ... (2016 revision)"   # the named real source(s)
version: "2026-07"                      # corpus version stamp
effective_date: "2026-07-01"            # when this practice version takes effect
disease_tags: [hydroxychloroquine-retinopathy, drug-toxicity]  # kebab-case tags for filtering
laterality_applicability: OU            # OU | OD | OS | NA
recommendation_strength: practice-adopted
---
```

Field notes:

- **`id`** is stable and kebab-case. It is the prefix for machine-readable
  citation chunk ids of the form `\<id\>#\<section-anchor\>` (e.g.
  `hcq-screening#major-risk-factors`) — see the `field_or_chunk_id` field in
  `sidecar/src/schemas/citations.ts`. Do not rename an `id` without a migration note.
- **`guideline_source`** names the real guideline(s) the protocol is grounded
  in — this is the provenance shown with `guideline_evidence` citations.
- **Section metadata is per-chunk, not in frontmatter.** The structure-aware
  chunker derives each chunk's `section` from the `##` heading it falls under
  and header-prefixes the chunk text, so section titles are written to be
  self-describing and every numeric threshold is kept in the same section as its
  qualifying conditions and population.
- **`laterality_applicability`** is `OU` for the bilateral disease protocols and
  `NA` for pure-process documents (intake standards).
- **`recommendation_strength`** is `practice-adopted` throughout: these are the
  office's adopted practices, grounded in — but distinct from — the source
  guidelines' own strength gradings.

## The documents

| File | Protocol | Primary source |
|------|----------|----------------|
| `hcq-screening.md` | Hydroxychloroquine retinopathy screening | AAO 2016 revised recommendations (Marmor et al.) |
| `diabetic-retinopathy-management.md` | DR staging, follow-up, DME, treatment | AAO PPP Diabetic Retinopathy; DRCR protocols |
| `systemic-risk-factors-dr.md` | Glycemic/BP/lipid/renal targets + PCP coordination | AAO PPP Diabetic Retinopathy; ADA Standards of Care |
| `amd-management.md` | AMD classification, AREDS2, nAMD anti-VEGF | AAO PPP Age-Related Macular Degeneration; AREDS/AREDS2 |
| `anti-vegf-treat-and-extend.md` | Treat-and-extend regimen | AAO PPPs (AMD, RVO) + T&E consensus/trials |
| `rvo-management.md` | RVO workup, macular edema, neovascular surveillance | AAO PPP Retinal Vein Occlusions |
| `renal-function-ocular-drug-safety.md` | eGFR bands → HCQ toxicity tier + interval | AAO 2016 HCQ statement + practice policy |
| `intake-documentation-standards.md` | Intake fields, verification, unverified-record handling | Practice-adopted policy |

## Requirement mapping

- **S2/R3 (hybrid RAG + rerank):** this corpus satisfies the "6–10 authored
  practice-protocol markdown docs grounded in named real guidelines" acceptance
  criterion — 8 documents, each with the full per-doc metadata contract, citing
  its named source guideline plus version/date, license-clean and PHI-free.
  Retrieval goldens (ticket B.6) assert the right protocol is returned for
  HCQ / DR / AMD asks and that an out-of-corpus ask refuses.
- **G18 (reproducible from repo, privacy audit):** the corpus lives entirely in
  the repository as plain markdown — **no DB-only state**. The golden set and
  retrieval index are reproducible from these files alone, satisfying the
  "golden set reproducible from the repo alone" backup/recovery invariant.

## The index is derived (rebuildable by script)

These markdown files are the **single source of truth**. The persisted
`pgvector` (Cohere) embeddings in `corpus_embeddings` are a **derived index**,
synced from this directory at boot (content-hashed per chunk — unchanged
chunks are never re-embedded) and rebuildable on demand with
`npm run corpus:index` (`--rebuild` wipes first) — never hand-edited. The
keyword leg is an in-process BM25 index built from the same files at boot. If
the index is lost, re-running the build against this directory reconstructs
it exactly. To
change practice content, edit the markdown here and re-run the build; bump
`version` / `effective_date` in the frontmatter when a protocol's clinical
content changes.
