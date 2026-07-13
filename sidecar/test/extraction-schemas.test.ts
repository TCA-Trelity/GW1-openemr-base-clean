// A.1/A.2 (REQ R2, R5, G3, D3): the extraction contracts fail closed — a VLM payload that
// invents keys, omits required fields, or bends a type never reaches persistence — and
// citation contract v2 stays backward-compatible with every stored Week 1 citation.
import { describe, expect, it } from 'vitest';
import {
    CitationRefSchema,
    ExtractionCitationSchema,
    ExtractionResultSchema,
    IntakeFormExtractionSchema,
    LabPdfExtractionSchema,
    toSpecCitation,
} from '../src/schemas/index.js';

const citation = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    page: 1,
    bbox: { x: 0.12, y: 0.4, w: 0.2, h: 0.02 },
    quote: 'eGFR 42 mL/min/1.73m2 (L)',
    grounding: 'word_box',
    ...overrides,
});

const validLab = (): Record<string, unknown> => ({
    doc_type: 'lab_pdf',
    document_patient: { name: 'Margaret L. Chen', dob: '1967-03-14', citation: citation() },
    performing_lab: 'Orlando Diagnostic Laboratories',
    collection_date: '2024-12-20',
    collection_date_citation: citation({ quote: 'Collected: 12/20/2024' }),
    results: [
        {
            test_name: 'eGFR',
            value: '42',
            value_numeric: 42,
            unit: 'mL/min/1.73m2',
            reference_range: '>60',
            abnormal_flag: 'low',
            citation: citation(),
        },
    ],
});

const validIntake = (): Record<string, unknown> => ({
    doc_type: 'intake_form',
    demographics: { name: 'Margaret L. Chen', dob: '1967-03-14', sex: 'F', citation: citation({ quote: 'Margaret L. Chen' }) },
    chief_concern: { text: 'Flashes of light, right eye, ~2 weeks', laterality: 'OD', citation: citation({ quote: 'flashes of light' }) },
    current_medications: [
        { name: 'Hydroxychloroquine', dose: '200mg', frequency: 'daily', start_date: '2019-01', citation: citation({ quote: 'Hydroxychloroquine 200mg daily' }) },
    ],
    allergies: [{ substance: 'Penicillin', reaction: 'hives', citation: citation({ quote: 'Penicillin - hives' }) }],
    family_history: [{ relative: 'Father', condition: 'Glaucoma', citation: citation({ quote: 'Father: glaucoma' }) }],
    patient_goals: { text: "Recovered for Emily's wedding photos", citation: citation({ quote: 'wedding' }) },
    vitals: { height_in: 64, weight_lb: 138, bp_systolic: 128, bp_diastolic: 78, citation: citation({ quote: 'BP 128/78' }) },
    form_date: '2024-12-26',
});

describe('LabPdfExtraction (A.1)', () => {
    it('parses a valid extraction with all seven spec fields present', () => {
        const parsed = LabPdfExtractionSchema.parse(validLab());
        expect(parsed.results[0]?.test_name).toBe('eGFR');
        expect(parsed.results[0]?.abnormal_flag).toBe('low');
        expect(parsed.collection_date).toBe('2024-12-20');
    });

    it('rejects a result missing its citation (spec: source citation is required)', () => {
        const lab = validLab();
        delete (lab['results'] as Record<string, unknown>[])[0]?.['citation'];
        expect(LabPdfExtractionSchema.safeParse(lab).success).toBe(false);
    });

    it('rejects a result missing test_name', () => {
        const lab = validLab();
        delete (lab['results'] as Record<string, unknown>[])[0]?.['test_name'];
        expect(LabPdfExtractionSchema.safeParse(lab).success).toBe(false);
    });

    it('rejects an empty results array — an extraction that read nothing is a failure, not a success', () => {
        expect(LabPdfExtractionSchema.safeParse({ ...validLab(), results: [] }).success).toBe(false);
    });

    it('fails closed on invented keys (strict schema, G3)', () => {
        expect(LabPdfExtractionSchema.safeParse({ ...validLab(), hallucinated_summary: 'looks fine' }).success).toBe(false);
        const lab = validLab();
        ((lab['results'] as Record<string, unknown>[])[0] as Record<string, unknown>)['clinical_interpretation'] = 'renal decline';
        expect(LabPdfExtractionSchema.safeParse(lab).success).toBe(false);
    });

    it('rejects a malformed abnormal_flag instead of coercing it', () => {
        const lab = validLab();
        ((lab['results'] as Record<string, unknown>[])[0] as Record<string, unknown>)['abnormal_flag'] = 'kinda-low';
        expect(LabPdfExtractionSchema.safeParse(lab).success).toBe(false);
    });
});

describe('IntakeFormExtraction (A.1)', () => {
    it('parses a valid intake with goals and laterality-tagged chief concern', () => {
        const parsed = IntakeFormExtractionSchema.parse(validIntake());
        expect(parsed.chief_concern.laterality).toBe('OD');
        expect(parsed.patient_goals.text).toContain('wedding');
        expect(parsed.vitals?.bp_systolic).toBe(128);
    });

    it('rejects a bad laterality value', () => {
        const intake = validIntake();
        (intake['chief_concern'] as Record<string, unknown>)['laterality'] = 'RIGHT';
        expect(IntakeFormExtractionSchema.safeParse(intake).success).toBe(false);
    });

    it('rejects a medication entry without its citation', () => {
        const intake = validIntake();
        delete (intake['current_medications'] as Record<string, unknown>[])[0]?.['citation'];
        expect(IntakeFormExtractionSchema.safeParse(intake).success).toBe(false);
    });

    it('fails closed on unknown top-level keys', () => {
        expect(IntakeFormExtractionSchema.safeParse({ ...validIntake(), assessment: 'stable' }).success).toBe(false);
    });
});

describe('ExtractionResultSchema discriminates on doc_type', () => {
    it('routes lab_pdf and intake_form to their schemas', () => {
        expect(ExtractionResultSchema.parse(validLab()).doc_type).toBe('lab_pdf');
        expect(ExtractionResultSchema.parse(validIntake()).doc_type).toBe('intake_form');
    });
    it('rejects unknown doc types', () => {
        expect(ExtractionResultSchema.safeParse({ ...validLab(), doc_type: 'referral_fax' }).success).toBe(false);
    });
});

describe('ExtractionCitation grounding ladder (R5)', () => {
    it('accepts a page-level fallback citation with no bbox', () => {
        const parsed = ExtractionCitationSchema.parse({ page: 2, quote: 'Creatinine 1.58', grounding: 'page' });
        expect(parsed.bbox).toBeNull();
    });
    it('rejects out-of-range bbox coordinates', () => {
        expect(ExtractionCitationSchema.safeParse(citation({ bbox: { x: 1.2, y: 0, w: 0.1, h: 0.1 } })).success).toBe(false);
    });
    it('rejects an empty quote — nothing to ground means nothing to cite', () => {
        expect(ExtractionCitationSchema.safeParse(citation({ quote: '' })).success).toBe(false);
    });
});

describe('Citation contract v2 (A.2, REQ R5)', () => {
    it('still parses a stored Week 1 citation unchanged (backward compatibility)', () => {
        const week1 = {
            id: 'cit-mc-001',
            source_label: 'Rheumatology office note',
            source_type: 'provider_note',
            excerpt_text: 'hydroxychloroquine 200mg daily',
            excerpt_location: { type: 'character_range', start_char: 120, end_char: 151, context_before: null, context_after: null },
            attribution: null,
            source_document_id: 'doc-mc-002',
            document_date: '2024-11-02',
        };
        const parsed = CitationRefSchema.parse(week1);
        expect(parsed.page_or_section).toBeNull();
        expect(parsed.field_or_chunk_id).toBeNull();
    });

    it('accepts guideline_evidence with a chunk id (the grounding split)', () => {
        const parsed = CitationRefSchema.parse({
            id: 'cit-guideline-1',
            source_label: 'HCQ screening protocol',
            source_type: 'guideline_evidence',
            excerpt_text: 'renal disease is a major risk factor',
            source_document_id: 'hcq-screening',
            field_or_chunk_id: 'hcq-screening#risk-factors',
            page_or_section: '§ Risk factors',
        });
        expect(parsed.source_type).toBe('guideline_evidence');
    });

    it('accepts page_bbox excerpt locations and rejects malformed ones', () => {
        const ok = CitationRefSchema.safeParse({
            id: 'cit-doc-1',
            source_label: 'Outside lab PDF',
            source_type: 'lab_report',
            excerpt_text: 'eGFR 42',
            excerpt_location: { type: 'page_bbox', page: 1, x: 0.1, y: 0.5, w: 0.2, h: 0.02 },
            source_document_id: 'doc-lab-renal',
        });
        expect(ok.success).toBe(true);
        const bad = CitationRefSchema.safeParse({
            id: 'cit-doc-2',
            source_label: 'Outside lab PDF',
            source_type: 'lab_report',
            excerpt_location: { type: 'page_bbox', page: 0, x: 0.1, y: 0.5, w: 0.2, h: 0.02 },
        });
        expect(bad.success).toBe(false);
    });

    it('toSpecCitation projects the assignment minimum shape', () => {
        const ref = CitationRefSchema.parse({
            id: 'cit-doc-3',
            source_label: 'Outside lab PDF',
            source_type: 'lab_report',
            excerpt_text: 'eGFR 42 mL/min/1.73m2',
            excerpt_location: { type: 'page_bbox', page: 1, x: 0.1, y: 0.5, w: 0.2, h: 0.02 },
            source_document_id: 'doc-lab-renal',
            field_or_chunk_id: 'results[0].value',
        });
        expect(toSpecCitation(ref)).toEqual({
            source_type: 'lab_report',
            source_id: 'doc-lab-renal',
            page_or_section: 'page 1',
            field_or_chunk_id: 'results[0].value',
            quote_or_value: 'eGFR 42 mL/min/1.73m2',
        });
    });

    it('toSpecCitation renders character ranges and falls back to the citation id', () => {
        const ref = CitationRefSchema.parse({
            id: 'cit-legacy',
            source_label: 'Provider note',
            source_type: 'provider_note',
            excerpt_text: 'started 2019',
            excerpt_location: { type: 'character_range', start_char: 5, end_char: 17, context_before: null, context_after: null },
        });
        expect(toSpecCitation(ref)).toEqual({
            source_type: 'provider_note',
            source_id: 'cit-legacy',
            page_or_section: 'chars 5–17',
            field_or_chunk_id: null,
            quote_or_value: 'started 2019',
        });
    });
});
