// Chat tool tests (TC1; IC1 added get_imaging_overview): each of the seven read-only tools,
// happy path + unresolved-input
// error path, against a small FactBundle fixture. Every happy output is validated against its
// own Zod output schema (contracts are the source of truth). Tools never throw — bad input
// degrades to a structured { error } with ok:false.
import { describe, expect, it } from 'vitest';
import {
    checkMedRisk,
    checkMedRiskOutputSchema,
    compareScans,
    compareScansOutputSchema,
    getFullDocument,
    getFullDocumentOutputSchema,
    getImagingOverview,
    getImagingOverviewOutputSchema,
    getMeasurementTrend,
    getMeasurementTrendOutputSchema,
    getOpenQuestions,
    getOpenQuestionsOutputSchema,
    searchRecord,
    searchRecordOutputSchema,
    ALL_CHAT_TOOLS,
} from '../src/chat/tools/index.js';
import type { FactBundle, StoredContradiction, StoredFact, StoredImageRecord, StoredTreatment } from '../src/store/index.js';

const DOC_TEXT =
    'Current medications: Plaquenil 200 mg daily since January 2019 for lupus. Eliquis 5 mg twice daily. Allergies: penicillin (rash).';

function medFact(id: string, name: string, dose: string): StoredFact {
    return {
        id,
        patient_id: 'p1',
        fact_type: 'medication',
        content: { name, dose },
        is_current: true,
        laterality: null,
        verification: { status: 'unverified' },
        source_document_id: 'doc-1',
        sources: [],
        created_date: null,
        updated_date: null,
    };
}

function image(id: string, date: string, laterality: 'od' | 'os', gc: number, findingType: string): StoredImageRecord {
    return {
        id,
        patient_id: 'p1',
        image_metadata: { capture_date: date, modality: 'oct', laterality },
        ai_analysis: {
            findings: [{ finding_type: findingType, ...(findingType === 'normal' ? {} : { severity: 'moderate' }) }],
            measurements: [{ measurement_type: 'ganglion_cell_thickness', value: gc, unit: 'microns' }],
        },
    };
}

function treatment(): StoredTreatment {
    const payload = {
        id: 'tx-1',
        patient_id: 'p1',
        treatment_type: 'anti_vegf_injection',
        treatment_date: '2024-05-01',
        injection_details: { medication: 'aflibercept', injection_number: 2 },
    };
    return { id: 'tx-1', patient_id: 'p1', treatment_date: '2024-05-01', payload };
}

function contradiction(id: string, status: 'active' | 'resolved', payload: Record<string, unknown>): StoredContradiction {
    return { id, patient_id: 'p1', status, severity: 'high', payload };
}

function toolBundle(): FactBundle {
    return {
        patient: { id: 'p1', openemr_patient_id: null, name: 'Test Patient', demographics: {} },
        facts: [medFact('med-1', 'Plaquenil', '200 mg'), medFact('med-2', 'Eliquis', '5 mg')],
        contradictions: [
            contradiction('c1', 'active', { description: 'Plaquenil duration mismatch', suggested_question: 'How long on Plaquenil?' }),
            contradiction('c2', 'active', { type: 'allergy_discrepancy', physician_workflow: { auto_generate_question: 'Confirm penicillin allergy?' } }),
            contradiction('c3', 'resolved', { description: 'already handled', suggested_question: 'n/a' }),
        ],
        images: [
            image('img-1', '2024-01-01', 'od', 80, 'subretinal_fluid'),
            image('img-2', '2024-06-01', 'od', 65, 'normal'),
            image('img-os', '2024-03-01', 'os', 72, 'normal'),
        ],
        treatments: [treatment()],
        documents: [
            { id: 'doc-1', document_type: 'pharmacy_record', document_date: '2024-11-01', content: { text_content: DOC_TEXT }, metadata: {}, extras: {} },
        ],
    };
}

describe('tool registry', () => {
    it('registers all seven tools with unique names and valid JSON schemas', () => {
        expect(ALL_CHAT_TOOLS.map((t) => t.name)).toEqual([
            'get_full_document',
            'get_measurement_trend',
            'compare_scans',
            'get_imaging_overview',
            'check_med_risk',
            'search_record',
            'get_open_questions',
        ]);
        for (const tool of ALL_CHAT_TOOLS) {
            expect(tool.inputJsonSchema['type']).toBe('object');
        }
    });
});

describe('get_full_document', () => {
    it('returns the full text + provenance for a known document', () => {
        const inv = getFullDocument.invoke(toolBundle(), { document_id: 'doc-1' });
        expect(inv.ok).toBe(true);
        expect(getFullDocumentOutputSchema.safeParse(inv.output).success).toBe(true);
        expect(inv.output['text_content']).toBe(DOC_TEXT);
        expect(inv.output['document_type']).toBe('pharmacy_record');
        expect(inv.provenance).toHaveLength(1);
        expect(inv.provenance[0]!.source_document_id).toBe('doc-1');
        expect(DOC_TEXT.startsWith(inv.provenance[0]!.excerpt)).toBe(true);
    });

    it('returns a structured error for an unknown document id', () => {
        const inv = getFullDocument.invoke(toolBundle(), { document_id: 'doc-nope' });
        expect(inv.ok).toBe(false);
        expect(String(inv.output['error'])).toContain('doc-nope');
        expect(inv.provenance).toEqual([]);
    });
});

describe('get_measurement_trend', () => {
    it('returns the OD ganglion-cell series sorted by date for a shorthand metric', () => {
        const inv = getMeasurementTrend.invoke(toolBundle(), { metric: 'GC-IPL', laterality: 'OD' });
        expect(inv.ok).toBe(true);
        expect(getMeasurementTrendOutputSchema.safeParse(inv.output).success).toBe(true);
        expect(inv.output['metric']).toBe('ganglion_cell_thickness');
        const series = inv.output['series'] as { date: string; value: number }[];
        expect(series.map((p) => p.value)).toEqual([80, 65]);
        expect(series.every((p) => p.date >= '2024-01-01')).toBe(true);
    });

    it('returns a structured error when the metric is absent from the record', () => {
        const inv = getMeasurementTrend.invoke(toolBundle(), { metric: 'not_a_real_metric' });
        expect(inv.ok).toBe(false);
        expect(String(inv.output['error'])).toContain('not_a_real_metric');
    });
});

describe('compare_scans', () => {
    it('runs computeComparison chronologically (earlier=prior, later=current)', () => {
        const inv = compareScans.invoke(toolBundle(), { image_id_a: 'img-1', image_id_b: 'img-2' });
        expect(inv.ok).toBe(true);
        expect(compareScansOutputSchema.safeParse(inv.output).success).toBe(true);
        expect(inv.output['current_image_id']).toBe('img-2');
        expect(inv.output['prior_image_id']).toBe('img-1');
        const comparison = inv.output['comparison'] as { overall_change: string; changes: { change_type: string }[] };
        expect(comparison.overall_change).toBe('improved');
        expect(comparison.changes.some((c) => c.change_type === 'resolved')).toBe(true);
        expect(inv.provenance).toEqual([]); // derived, not document-quoting
    });

    it('returns a structured error for an unknown image id', () => {
        const inv = compareScans.invoke(toolBundle(), { image_id_a: 'img-1', image_id_b: 'img-nope' });
        expect(inv.ok).toBe(false);
        expect(String(inv.output['error'])).toContain('img-nope');
    });
});

describe('get_imaging_overview', () => {
    it('returns the whole imaging story: chronological timeline with treatment context + both analyses', () => {
        const inv = getImagingOverview.invoke(toolBundle(), {});
        expect(inv.ok).toBe(true);
        expect(getImagingOverviewOutputSchema.safeParse(inv.output).success).toBe(true);
        expect(inv.output['scan_count']).toBe(3);
        expect(inv.output['first_capture_date']).toBe('2024-01-01');
        expect(inv.output['latest_capture_date']).toBe('2024-06-01');
        const timeline = inv.output['timeline'] as {
            image_id: string;
            treatment_context: { days_since_last_treatment: number | null };
        }[];
        expect(timeline.map((entry) => entry.image_id)).toEqual(['img-1', 'img-os', 'img-2']); // capture order, not insert order
        expect(timeline[0]!.treatment_context.days_since_last_treatment).toBeNull(); // predates tx-1
        expect(timeline[2]!.treatment_context.days_since_last_treatment).toBe(31); // 2024-05-01 -> 2024-06-01
        expect(inv.output['interval_analysis']).toBeDefined();
        expect(inv.output['hcq_progression']).toBeDefined();
        expect(inv.output['derived']).toBe(true);
        expect(inv.provenance).toEqual([]); // derived, not document-quoting
    });

    it('treats zero scans as data, not an error', () => {
        const inv = getImagingOverview.invoke({ ...toolBundle(), images: [] }, {});
        expect(inv.ok).toBe(true);
        expect(getImagingOverviewOutputSchema.safeParse(inv.output).success).toBe(true);
        expect(inv.output['scan_count']).toBe(0);
        expect(inv.output['first_capture_date']).toBeNull();
        expect(inv.output['latest_capture_date']).toBeNull();
        expect(inv.output['timeline']).toEqual([]);
    });

    it('skips malformed treatment payloads instead of throwing', () => {
        const bundle = toolBundle();
        bundle.treatments = [{ id: 'tx-bad', patient_id: 'p1', treatment_date: '2024-02-01', payload: { nonsense: true } }];
        const inv = getImagingOverview.invoke(bundle, {});
        expect(inv.ok).toBe(true);
        const timeline = inv.output['timeline'] as { treatment_context: { last_treatment: unknown } }[];
        expect(timeline.every((entry) => entry.treatment_context.last_treatment === null)).toBe(true);
    });
});

describe('check_med_risk', () => {
    it('flags HCQ and anticoagulant risk across all medications', () => {
        const inv = checkMedRisk.invoke(toolBundle(), {});
        expect(inv.ok).toBe(true);
        expect(checkMedRiskOutputSchema.safeParse(inv.output).success).toBe(true);
        expect(inv.output['medications_checked']).toBe(2);
        const flags = inv.output['flags'] as { flag_type: string }[];
        expect(flags.some((f) => f.flag_type === 'retinal_toxicity')).toBe(true);
        expect(flags.some((f) => f.flag_type === 'bleeding_risk')).toBe(true);
    });

    it('narrows to a named medication', () => {
        const inv = checkMedRisk.invoke(toolBundle(), { medication_name: 'plaquenil' });
        expect(inv.ok).toBe(true);
        expect(inv.output['medications_checked']).toBe(1);
        const flags = inv.output['flags'] as { flag_type: string }[];
        expect(flags.every((f) => f.flag_type === 'retinal_toxicity')).toBe(true);
    });

    it('returns a structured error when the named medication is absent', () => {
        const inv = checkMedRisk.invoke(toolBundle(), { medication_name: 'zzz-nonexistent' });
        expect(inv.ok).toBe(false);
        expect(String(inv.output['error'])).toContain('zzz-nonexistent');
    });
});

describe('search_record', () => {
    it('matches across documents (with provenance) and facts', () => {
        const inv = searchRecord.invoke(toolBundle(), { query: 'Plaquenil' });
        expect(inv.ok).toBe(true);
        expect(searchRecordOutputSchema.safeParse(inv.output).success).toBe(true);
        const matches = inv.output['matches'] as { kind: string; source_document_id: string; snippet: string }[];
        expect(matches.some((m) => m.kind === 'document')).toBe(true);
        expect(matches.some((m) => m.kind === 'fact')).toBe(true);
        // Document matches carry verbatim provenance the citation gate can verify.
        expect(inv.provenance.length).toBeGreaterThan(0);
        expect(DOC_TEXT.includes(inv.provenance[0]!.excerpt)).toBe(true);
    });

    it('returns a structured error for a blank query', () => {
        const inv = searchRecord.invoke(toolBundle(), { query: '   ' });
        expect(inv.ok).toBe(false);
        expect(String(inv.output['error'])).toContain('empty');
    });
});

describe('get_open_questions', () => {
    it('lists active contradictions and their suggested questions from either payload shape', () => {
        const inv = getOpenQuestions.invoke(toolBundle(), {});
        expect(inv.ok).toBe(true);
        expect(getOpenQuestionsOutputSchema.safeParse(inv.output).success).toBe(true);
        expect(inv.output['count']).toBe(2); // c3 is resolved -> excluded
        const questions = inv.output['open_questions'] as { contradiction_id: string; suggested_questions: string[]; summary: string }[];
        const c1 = questions.find((q) => q.contradiction_id === 'c1')!;
        expect(c1.suggested_questions).toEqual(['How long on Plaquenil?']);
        expect(c1.summary).toBe('Plaquenil duration mismatch');
        const c2 = questions.find((q) => q.contradiction_id === 'c2')!;
        expect(c2.suggested_questions).toEqual(['Confirm penicillin allergy?']);
        expect(c2.summary).toBe('allergy_discrepancy'); // falls back to `type`
    });

    it('returns an empty, non-error result when there are no active contradictions', () => {
        const bundle = toolBundle();
        bundle.contradictions = [];
        const inv = getOpenQuestions.invoke(bundle, {});
        expect(inv.ok).toBe(true);
        expect(inv.output['count']).toBe(0);
        expect(inv.output['open_questions']).toEqual([]);
    });
});
