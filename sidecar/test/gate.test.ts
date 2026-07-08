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
