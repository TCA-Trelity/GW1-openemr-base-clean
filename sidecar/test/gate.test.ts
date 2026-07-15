// Citation-gate tests: the "claims must always cite a source" invariant the
// project brief names explicitly, plus the corpus-wide proof that every seeded
// citation resolves (every demo is a test run — ARCHITECTURE.md §8).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkCitation, runCitationGate, type Claim, type DocumentTextResolver } from '../src/gate/citationGate.js';
import type { CitationRef } from '../src/schemas/index.js';

const DOC_TEXT = 'Patient reports taking hydroxychloroquine 200mg daily since January 2019.';

function citation(overrides: Partial<CitationRef> = {}): CitationRef {
    const excerpt = 'hydroxychloroquine 200mg daily';
    const start = DOC_TEXT.indexOf(excerpt);
    return {
        id: 'cit-1',
        source_label: 'Referral letter',
        source_type: 'referral_letter',
        excerpt_text: excerpt,
        excerpt_location: {
            type: 'character_range',
            start_char: start,
            end_char: start + excerpt.length,
            context_before: '',
            context_after: '',
        },
        attribution: { speaker_role: 'external_provider', speaker_name: 'Dr. R.', speaker_relationship: '', confidence: 0.95 },
        source_document_id: 'doc-1',
        document_date: '2024-12-15',
        ...overrides,
    } as CitationRef;
}

const resolver: DocumentTextResolver = (id) => (id === 'doc-1' ? DOC_TEXT : undefined);

describe('checkCitation', () => {
    // Guards: the happy path — an exact character range must verify.
    it('verifies an exact character-range match', () => {
        expect(checkCitation(citation(), resolver)).toEqual({ result: 'ok_range' });
    });

    // Guards: silent provenance loss after document re-import shifts offsets.
    it('recovers a drifted range when the excerpt still exists verbatim', () => {
        const drifted = citation();
        drifted.excerpt_location = { ...drifted.excerpt_location, start_char: 0, end_char: 5 };
        const check = checkCitation(drifted, resolver);
        expect(check.result).toBe('ok_search');
        if (check.result === 'ok_search') {
            expect(DOC_TEXT.slice(check.correctedRange.start_char, check.correctedRange.end_char)).toBe(
                'hydroxychloroquine 200mg daily',
            );
        }
    });

    // Guards: a citation pointing at a document that does not exist.
    it('fails when the source document is unknown', () => {
        expect(checkCitation(citation({ source_document_id: 'nope' }), resolver)).toEqual({
            result: 'missing_document',
        });
    });

    // Guards: THE invariant — a fabricated excerpt must never verify.
    it('fails when the excerpt text does not appear in the document', () => {
        expect(checkCitation(citation({ excerpt_text: 'insulin 10 units nightly' }), resolver).result).toBe(
            'excerpt_mismatch',
        );
    });

    // Failure mode (live regression): the corpus carries OCR-style double spaces; models
    // collapse them when quoting, and 5-6 citations per prep died on invisible spacing.
    // Whitespace runs are equivalent; every non-whitespace character must still match.
    it('resolves an excerpt whose whitespace the model collapsed', () => {
        const spaced = 'Visual acuity  OD (right):  20/40.  Plaquenil continued.';
        const spacedResolver: DocumentTextResolver = (id) => (id === 'doc-1' ? spaced : undefined);
        const collapsed = citation({
            excerpt_text: 'Visual acuity OD (right): 20/40. Plaquenil continued.',
            excerpt_location: null,
        });
        const check = checkCitation(collapsed, spacedResolver);
        expect(check.result).toBe('ok_search');
        if (check.result === 'ok_search') {
            expect(spaced.slice(check.correctedRange.start_char, check.correctedRange.end_char)).toBe(spaced);
        }
    });

    // Guards: whitespace flexibility must not admit paraphrase — reworded text still fails.
    it('still rejects a paraphrased excerpt despite whitespace flexibility', () => {
        const spaced = 'Patient reports taking  hydroxychloroquine 200mg daily.';
        const spacedResolver: DocumentTextResolver = (id) => (id === 'doc-1' ? spaced : undefined);
        const paraphrase = citation({ excerpt_text: 'takes hydroxychloroquine 200 mg every day', excerpt_location: null });
        expect(checkCitation(paraphrase, spacedResolver).result).toBe('excerpt_mismatch');
    });
});

describe('runCitationGate', () => {
    // Guards: unsourced claims reaching the display layer.
    it('blocks a claim with no citations', () => {
        const result = runCitationGate([{ id: 'c1', citations: [] }], resolver);
        expect(result.verdicts[0]).toMatchObject({ status: 'blocked', reason: 'unsourced' });
    });

    // Guards: partial provenance passing as full provenance.
    it('blocks a claim when any one citation fails', () => {
        const claims: Claim[] = [
            { id: 'c1', citations: [citation(), citation({ source_document_id: 'nope' })] },
        ];
        const result = runCitationGate(claims, resolver);
        expect(result.verdicts[0]).toMatchObject({ status: 'blocked', reason: 'citation_failed' });
        expect(result.metrics).toMatchObject({ claims: 1, verified: 0, blocked: 1, citationsFailed: 1 });
    });

    // Guards: metrics feeding the observability verification pass/fail rate.
    it('verifies clean claims and counts them', () => {
        const result = runCitationGate([{ id: 'c1', citations: [citation()] }], resolver);
        expect(result.verdicts[0]?.status).toBe('verified');
        expect(result.metrics).toMatchObject({ claims: 1, verified: 1, blocked: 0, citationsFailed: 0 });
    });
});

// v2 evidence types (H.6): reject-path proof for the two Week 2 citation classes.
// The gate's verbatim rule is generic (citationGate.ts:55-57) — these tests pin that
// it actually REJECTS unverifiable quotes arriving as document-extraction citations
// (page/page_bbox locations, the shape factsOf() builds after grounding) and as
// guideline_evidence citations (chunk-id sources, the shape the composer emits).
const LAB_TEXT = 'RENAL FUNCTION PANEL — Margaret Chen. eGFR 42 mL/min/1.73m2 (Low). Creatinine 1.58 mg/dL (High).';

const labResolver: DocumentTextResolver = (id) => (id === 'doc-lab-renal' ? LAB_TEXT : undefined);

function pageBboxCitation(overrides: Partial<CitationRef> = {}): CitationRef {
    return citation({
        id: 'cit-doc-1',
        source_label: 'Outside lab PDF',
        source_type: 'lab_report',
        excerpt_text: 'eGFR 42 mL/min/1.73m2',
        excerpt_location: { type: 'page_bbox', page: 1, x: 0.12, y: 0.4, w: 0.2, h: 0.03 },
        source_document_id: 'doc-lab-renal',
        page_or_section: 'page 1',
        field_or_chunk_id: 'results[0].value',
        ...overrides,
    });
}

// Mirrors the critic's source-resolution seam (graph.ts:217-218): only chunk ids
// retrieved this turn resolve, and they resolve to the chunk's quote body.
const GUIDELINE_CHUNK_ID = 'hcq-screening#risk-factors';
const GUIDELINE_CHUNK_TEXT =
    'Renal disease is a major risk factor; begin annual screening at initiation when eGFR is reduced.';

const chunkResolver: DocumentTextResolver = (id) => (id === GUIDELINE_CHUNK_ID ? GUIDELINE_CHUNK_TEXT : undefined);

function guidelineCitation(overrides: Partial<CitationRef> = {}): CitationRef {
    return citation({
        id: 'cit-guideline-1',
        source_label: 'AAO 2016 hydroxychloroquine screening recommendations',
        source_type: 'guideline_evidence',
        excerpt_text: 'Renal disease is a major risk factor',
        excerpt_location: null,
        attribution: null,
        source_document_id: GUIDELINE_CHUNK_ID,
        document_date: null,
        page_or_section: '§ Risk factors',
        field_or_chunk_id: GUIDELINE_CHUNK_ID,
        ...overrides,
    });
}

describe('v2 evidence types: page/page_bbox + guideline_evidence citations', () => {
    // Accept-path sanity (no gate-unit case for this type existed): a page_bbox
    // location carries no character range, so a genuine quote must verify through
    // the verbatim-search path.
    it('verifies a page_bbox citation whose excerpt appears verbatim in the document text', () => {
        const check = checkCitation(pageBboxCitation(), labResolver);
        expect(check.result).toBe('ok_search');
        if (check.result === 'ok_search') {
            expect(LAB_TEXT.slice(check.correctedRange.start_char, check.correctedRange.end_char)).toBe(
                'eGFR 42 mL/min/1.73m2',
            );
        }
    });

    // Guards: THE invariant for document extraction — a value the model invented
    // (never printed on the page) must not verify just because the bbox looks plausible.
    it('blocks a page_bbox citation whose excerpt is absent from the document text', () => {
        expect(checkCitation(pageBboxCitation({ excerpt_text: 'eGFR 61 mL/min/1.73m2' }), labResolver).result).toBe(
            'excerpt_mismatch',
        );
    });

    // Guards: paraphrase sneaking through the whitespace-flexible fallback for
    // document-extraction citations (same rule the referral tests pin for W1 ranges).
    it('blocks a page_bbox citation that paraphrases the document instead of quoting it', () => {
        const paraphrase = pageBboxCitation({ excerpt_text: 'estimated GFR of 42, consistent with reduced renal function' });
        expect(checkCitation(paraphrase, labResolver).result).toBe('excerpt_mismatch');
    });

    // Guards: the page-level fallback shape (grounding found the page but no word
    // box) gets no extra leniency — the quote must still exist verbatim.
    it('blocks a page-fallback citation whose excerpt is absent from the document text', () => {
        const fabricated = pageBboxCitation({
            excerpt_text: 'Creatinine 0.90 mg/dL',
            excerpt_location: { type: 'page', page: 1 },
        });
        expect(checkCitation(fabricated, labResolver).result).toBe('excerpt_mismatch');
    });

    // Accept-path sanity (no gate-unit case for this type existed): a chunk-backed
    // guideline quote that IS verbatim must verify — locations are never present.
    it('verifies a guideline_evidence citation quoting its retrieved chunk verbatim', () => {
        expect(checkCitation(guidelineCitation(), chunkResolver).result).toBe('ok_search');
    });

    // Guards: an invented recommendation attributed to a real guideline chunk —
    // the exact fabrication the critic node exists to stop (E1).
    it('blocks a guideline_evidence citation whose quote is not verbatim in the referenced chunk', () => {
        const invented = guidelineCitation({ excerpt_text: 'Discontinue hydroxychloroquine when eGFR falls below 45' });
        expect(checkCitation(invented, chunkResolver).result).toBe('excerpt_mismatch');
    });

    // Guards: near-miss rewording of real guideline text ("kidney" for "renal") —
    // paraphrase is not provenance for guideline quotes either.
    it('blocks a guideline_evidence citation that paraphrases the chunk instead of quoting it', () => {
        const paraphrase = guidelineCitation({ excerpt_text: 'Kidney disease is a major risk factor' });
        expect(checkCitation(paraphrase, chunkResolver).result).toBe('excerpt_mismatch');
    });

    // Guards: a citation naming a chunk that was never retrieved this turn — the
    // critic's resolver only knows current evidence, so this must fail as missing,
    // never silently pass.
    it('blocks a guideline_evidence citation whose chunk id was never retrieved', () => {
        expect(checkCitation(guidelineCitation({ source_document_id: 'hcq-screening#dosing' }), chunkResolver)).toEqual({
            result: 'missing_document',
        });
    });

    // Guards: end-to-end — a claim backed by either v2 citation type with an
    // unverifiable quote must leave runCitationGate BLOCKED, and counted as failed.
    it('runCitationGate blocks claims carrying fabricated page_bbox or guideline quotes', () => {
        const resolve: DocumentTextResolver = (id) => labResolver(id) ?? chunkResolver(id);
        const result = runCitationGate(
            [
                { id: 'doc-claim', citations: [pageBboxCitation({ excerpt_text: 'eGFR 61 mL/min/1.73m2' })] },
                {
                    id: 'guideline-claim',
                    citations: [guidelineCitation({ excerpt_text: 'Discontinue hydroxychloroquine when eGFR falls below 45' })],
                },
            ],
            resolve,
        );
        expect(result.verdicts.map((v) => ({ id: v.id, status: v.status, reason: v.reason }))).toEqual([
            { id: 'doc-claim', status: 'blocked', reason: 'citation_failed' },
            { id: 'guideline-claim', status: 'blocked', reason: 'citation_failed' },
        ]);
        expect(result.metrics).toMatchObject({ claims: 2, verified: 0, blocked: 2, citationsFailed: 2 });
    });
});

describe('corpus invariant: 100% citation validity', () => {
    // Guards: the seeded corpus drifting out of provenance — if this fails, a
    // demo brief would contain citations the gate must block.
    it('every citation in margaret-chen.json resolves against its source document', () => {
        const corpus = JSON.parse(readFileSync(new URL('../seed/margaret-chen.json', import.meta.url), 'utf8'));
        const docs = new Map<string, string>(
            corpus.source_documents.map((d: { document_id: string; content: { text_content?: string } }) => [
                d.document_id,
                d.content.text_content ?? '',
            ]),
        );
        const resolveCorpus: DocumentTextResolver = (id) => docs.get(id);

        const factGroups = [
            ...corpus.medications,
            ...corpus.allergies,
            ...corpus.conditions,
            ...corpus.family_history,
            ...corpus.patient_goals,
            corpus.chief_complaint,
        ].filter(Boolean);

        const claims: Claim[] = factGroups.map((fact: { id: string; sources: CitationRef[] }) => ({
            id: fact.id,
            citations: fact.sources ?? [],
        }));

        const result = runCitationGate(claims, resolveCorpus);
        const blocked = result.verdicts.filter((v) => v.status === 'blocked');
        expect(blocked, JSON.stringify(blocked, null, 2)).toHaveLength(0);
        expect(result.metrics.citationsFailed).toBe(0);
        expect(result.metrics.citationsChecked).toBeGreaterThan(0);
    });

    // Guards: contradiction excerpts must also be quotable verbatim (they render
    // in the UI with the same source-card mechanism).
    it('every contradiction exact_text appears verbatim in its document', () => {
        const corpus = JSON.parse(readFileSync(new URL('../seed/margaret-chen.json', import.meta.url), 'utf8'));
        const byFilename = new Map<string, string>(
            corpus.source_documents.map((d: { filename: string; content: { text_content?: string } }) => [
                d.filename,
                d.content.text_content ?? '',
            ]),
        );
        for (const contradiction of corpus.contradictions) {
            for (const src of contradiction.source_documents) {
                const text = byFilename.get(src.filename);
                expect(text, `document ${src.filename} referenced by ${contradiction.contradiction_id}`).toBeDefined();
                expect(
                    text?.includes(src.exact_text),
                    `${contradiction.contradiction_id}: "${src.exact_text}" not found in ${src.filename}`,
                ).toBe(true);
            }
        }
    });
});
