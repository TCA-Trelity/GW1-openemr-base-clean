// Corpus-faithful test fixtures: a handcrafted BriefContent + FactBundle derived from
// sidecar/seed/margaret-chen.json shapes (documents shortened; citation offsets computed
// against the fixture text so range-based highlighting is exercised for real).
import type {
    BriefContent,
    CarePlan,
    ChiefComplaintContent,
    CitationRef,
    FactBundle,
    FactType,
    ImageRecord,
    OverviewDocumentMeta,
    OverviewPayload,
    PatientFact,
    PatientGoalContent,
    PatientRecord,
    RuntimeContradiction,
    SourceDocumentRecord,
    StoredBrief,
    StoredContradictionRow,
} from '../types';

// ---- Source documents (shortened but faithful to the corpus voice) ----

const RHEUM_NOTE_TEXT = `ORLANDO RHEUMATOLOGY ASSOCIATES
Anita Patel, MD — Rheumatology

PROGRESS NOTE — September 10, 2024
RE: Margaret L. Chen, DOB 03/14/1967

Mrs. Chen has been on hydroxychloroquine 200mg daily since January 15, 2019 - approaching her 6-year anniversary of continuous use.

CURRENT MEDICATIONS (confirmed with patient):
1. Hydroxychloroquine 200mg PO daily - initiated 01/15/2019
2. Methotrexate 15mg PO weekly (6 tablets of 2.5mg) - initiated 03/2021

ASSESSMENT: Rheumatoid arthritis, well controlled on current regimen.
PLAN: Continue current medications. Annual ophthalmologic screening recommended given HCQ duration.`;

const INTAKE_TEXT = `CONVERSATIONAL INTAKE TRANSCRIPT — December 26, 2024
Patient: Margaret Chen

ASSISTANT: Good morning! What's the main reason for your visit today?

PATIENT: I've been seeing these floaters in my vision, especially in my right eye. They look like little cobwebs or spots that drift around when I move my eyes.

ASSISTANT: How long has this been happening?

PATIENT: About two or three weeks now. It started around the time I was helping my daughter move.

PATIENT: I really want to understand what's causing these floaters and make sure I don't have what my mother had. She had a retinal detachment and needed surgery.

PATIENT: Oh, and I should mention — I got a rash from a sulfa antibiotic years ago.`;

function citationFor(
    id: string,
    factId: string,
    docId: string,
    docText: string,
    excerpt: string,
    overrides: Partial<CitationRef>,
): CitationRef {
    const start = docText.indexOf(excerpt);
    if (start < 0) {
        throw new Error(`fixture excerpt not found in document ${docId}: ${excerpt}`);
    }
    return {
        id,
        fact_id: factId,
        source_label: 'Source',
        source_type: 'provider_note',
        excerpt_text: excerpt,
        excerpt_location: {
            type: 'character_range',
            start_char: start,
            end_char: start + excerpt.length,
            context_before: docText.slice(Math.max(0, start - 48), start),
            context_after: docText.slice(start + excerpt.length, start + excerpt.length + 48),
        },
        attribution: null,
        source_document_id: docId,
        document_date: null,
        ...overrides,
    };
}

export const HCQ_EXCERPT = 'Hydroxychloroquine 200mg PO daily - initiated 01/15/2019';
export const CC_EXCERPT = "I've been seeing these floaters in my vision, especially in my right eye.";

export const hcqCitation = citationFor('cit-mc-001', 'fact-mc-med-001', 'doc-mc-003', RHEUM_NOTE_TEXT, HCQ_EXCERPT, {
    source_label: 'Rheumatology office note - Dr. Anita Patel',
    source_type: 'prior_visit_note',
    attribution: { speaker_role: 'physician', speaker_name: 'Anita Patel, MD', confidence: 0.95 },
    document_date: '2024-09-10',
});

export const ccCitation = citationFor('cit-mc-014', 'fact-mc-cc-001', 'doc-mc-012', INTAKE_TEXT, CC_EXCERPT, {
    source_label: 'Conversational intake transcript',
    source_type: 'intake_transcript',
    attribution: { speaker_role: 'patient', speaker_name: 'Margaret Chen', confidence: 0.95 },
    document_date: '2024-12-26',
});

/** A citation with no excerpt — the chip's fallback path. */
export const bareCitation: CitationRef = {
    id: 'cit-mc-bare',
    source_label: 'SureScripts pharmacy history',
    source_type: 'pharmacy_record',
    excerpt_text: null,
    excerpt_location: null,
    attribution: { speaker_role: 'system', speaker_name: 'SureScripts' },
    source_document_id: 'doc-mc-002',
    document_date: '2024-12-26',
};

// Wire-faithful: the store lifts id/type/date/content/metadata and keeps the rest in extras.
export const documents: SourceDocumentRecord[] = [
    {
        id: 'doc-mc-003',
        document_type: 'clinical_note',
        document_date: '2024-09-10',
        content: { format: 'text', text_content: RHEUM_NOTE_TEXT, ocr_quality: 0.88 },
        metadata: { original_filename: 'rheum_note_sept2024.pdf' },
        extras: { filename: 'rheumatology-note-2024-09-10.txt', received_method: 'patient_upload', received_date: '2024-12-16' },
    },
    {
        id: 'doc-mc-012',
        document_type: 'intake_transcript',
        document_date: '2024-12-26',
        content: { format: 'text', text_content: INTAKE_TEXT },
        extras: { filename: 'intake-transcript-2024-12-26.txt' },
    },
];

// ---- Facts (facts_by_type as the brief carries them) ----

const emptyFacts: Record<FactType, PatientFact[]> = {
    medication: [],
    allergy: [],
    condition: [],
    clinical_finding: [],
    imaging_finding: [],
    procedure_history: [],
    vital_sign: [],
    social_history: [],
    family_history: [],
    patient_goal: [],
    chief_complaint: [],
    lab_result: [],
};

const base = { patient_id: 'margaret-chen', is_current: true, created_date: '2024-12-26T09:53:00Z' };

const ccContent: ChiefComplaintContent = {
    statement: 'Floaters and flashes x 2-3 weeks, worse OD',
    onset: 'approximately 2-3 weeks before 2024-12-26 visit',
    progression: 'slightly worsening / more noticeable',
    pertinent_negatives: ['No curtain or shadow', 'No vision loss', 'No trauma'],
};

const goalContent: PatientGoalContent = {
    goal: 'Understand what is causing the floaters and rule out the retinal detachment her mother had',
    specific_concerns: [
        'Worried about having the same condition as her mother (retinal detachment)',
        "Daughter Emily's wedding in about 6 weeks - wants good vision for it",
    ],
    verbatim_quotes: ["I really can't afford any vision problems right now"],
};

const factsByType: Record<FactType, PatientFact[]> = {
    ...emptyFacts,
    medication: [
        {
            ...base,
            id: 'fact-mc-med-001',
            fact_type: 'medication',
            content: {
                name: 'Hydroxychloroquine (Plaquenil)',
                dose: '200mg',
                frequency: 'daily',
                route: 'PO',
                start_date: '2019-01-15',
                prescriber: 'Anita Patel, MD (Rheumatology)',
                indication: 'Rheumatoid arthritis',
            },
            source_document_id: 'doc-mc-003',
            sources: [hcqCitation, bareCitation],
            verification: { status: 'unverified' },
            laterality: null,
        },
        {
            ...base,
            id: 'fact-mc-med-002',
            fact_type: 'medication',
            content: { name: 'Methotrexate', dose: '15mg', frequency: 'weekly', route: 'PO', indication: 'Rheumatoid arthritis' },
            source_document_id: 'doc-mc-003',
            sources: [],
            verification: { status: 'verified', verifier_role: 'physician' },
            laterality: null,
        },
    ],
    allergy: [
        {
            ...base,
            id: 'fact-mc-allergy-001',
            fact_type: 'allergy',
            content: { substance: 'Sulfa antibiotics', reaction: 'rash', severity: 'moderate' },
            source_document_id: 'doc-mc-012',
            sources: [],
            verification: { status: 'patient_reported' },
            laterality: null,
        },
    ],
    condition: [
        {
            ...base,
            id: 'fact-mc-cond-001',
            fact_type: 'condition',
            content: { name: 'Rheumatoid arthritis', icd10: 'M06.9', status: 'controlled', since: '2018' },
            source_document_id: 'doc-mc-003',
            sources: [],
            verification: { status: 'verified', verifier_role: 'physician' },
            laterality: null,
        },
    ],
    clinical_finding: [
        {
            ...base,
            id: 'fact-mc-find-001',
            fact_type: 'clinical_finding',
            content: { finding: 'Floaters, cobweb-like', laterality: 'OD', severity: 'mild' },
            source_document_id: 'doc-mc-012',
            sources: [ccCitation],
            verification: { status: 'unverified' },
            laterality: 'OD',
        },
    ],
    family_history: [
        {
            ...base,
            id: 'fact-mc-fam-001',
            fact_type: 'family_history',
            content: { relative: 'Mother', condition: 'Retinal detachment', outcome: 'surgical repair' },
            source_document_id: 'doc-mc-012',
            sources: [],
            verification: { status: 'patient_reported' },
            laterality: null,
        },
    ],
    chief_complaint: [
        {
            ...base,
            id: 'fact-mc-cc-001',
            fact_type: 'chief_complaint',
            content: ccContent,
            source_document_id: 'doc-mc-012',
            sources: [ccCitation],
            verification: { status: 'unverified' },
            laterality: 'OD',
        },
    ],
    patient_goal: [
        {
            ...base,
            id: 'fact-mc-goal-001',
            fact_type: 'patient_goal',
            content: goalContent,
            source_document_id: 'doc-mc-012',
            sources: [
                citationFor('cit-mc-013', 'fact-mc-goal-001', 'doc-mc-012', INTAKE_TEXT,
                    "I really want to understand what's causing these floaters and make sure I don't have what my mother had.", {
                        source_label: 'Conversational intake transcript',
                        source_type: 'intake_transcript',
                        attribution: { speaker_role: 'patient', speaker_name: 'Margaret Chen' },
                        document_date: '2024-12-26',
                    }),
            ],
            verification: { status: 'unverified' },
            laterality: null,
        },
    ],
};

// ---- Contradictions (named so the stored-row fixtures can reuse the runtime shape) ----

export const allergyContradiction: RuntimeContradiction = {
    id: 'contra-mc-002',
    patient_id: 'margaret-chen',
    status: 'active',
    severity: 'critical',
    type: 'allergy_discrepancy',
    description: 'Referral letter documents NKDA; patient reported a sulfa allergy during intake',
    suggested_question: 'Can you confirm your reaction to sulfa antibiotics and when it occurred?',
    source_a: { type: 'referral_letter', value: 'NKDA', document_id: 'doc-mc-001', excerpt: 'ALLERGIES: NKDA' },
    source_b: {
        type: 'intake_transcript',
        value: 'sulfa allergy (rash)',
        document_id: 'doc-mc-012',
        excerpt: 'I got a rash from a sulfa antibiotic years ago',
    },
};

export const hcqContradiction: RuntimeContradiction = {
    id: 'contra-mc-001',
    patient_id: 'margaret-chen',
    status: 'active',
    severity: 'high',
    type: 'temporal_discrepancy',
    description: 'HCQ duration conflicts across sources: referral says ~4 years, pharmacy first-fill implies 5 years 11 months',
    suggested_question: 'How long have you actually been taking hydroxychloroquine?',
    source_a: { type: 'referral_letter', value: '~4 years', document_id: 'doc-mc-001', excerpt: '~4 years duration' },
    source_b: { type: 'pharmacy_record', value: '5 years 11 months', document_id: 'doc-mc-002', excerpt: '"first_fill_date": "2019-01-15"' },
};

// ---- The brief ----

export const briefContent: BriefContent = {
    urgency: {
        level: 'high',
        reason: 'Critical contradiction in the record: Referral letter documents NKDA; patient reported a sulfa allergy during intake',
    },
    contradiction_alerts: [allergyContradiction, hcqContradiction],
    why_they_are_here: { fact_id: 'fact-mc-cc-001', content: ccContent },
    what_they_are_hoping_for: { fact_id: 'fact-mc-goal-001', content: goalContent },
    // Structured items (R4) plus one legacy plain string — the panel must tolerate both.
    key_discussion_points: [
        {
            text: 'Hydroxychloroquine (Plaquenil): HIGH retinal toxicity risk',
            kind: 'risk_flag',
            fact_ids: ['fact-mc-med-001'],
            contradiction_id: null,
        },
        {
            text: 'Referral letter documents NKDA; patient reported a sulfa allergy during intake',
            kind: 'contradiction',
            fact_ids: [],
            contradiction_id: 'contra-mc-002',
        },
        'Family history of retinal detachment (mother) with new floaters',
    ],
    questions_to_confirm: [
        'Can you confirm your reaction to sulfa antibiotics and when it occurred?',
        'How long have you actually been taking hydroxychloroquine?',
    ],
    medication_risk_flags: [
        {
            medication: 'Hydroxychloroquine (Plaquenil)',
            flag_type: 'retinal_toxicity',
            severity: 'high',
            message: 'High risk of retinal toxicity: 5.9 years of hydroxychloroquine use with ~430g cumulative dose',
            recommendation: 'Baseline and annual OCT plus visual field screening',
            source: 'AAO HCQ Screening Guidelines 2016 (revised 2020)',
            details: { duration_years: 5.9, cumulative_dose_grams: 430, daily_dose_mg: 200 },
        },
    ],
    imaging: {
        timeline_summary: [
            {
                image_id: 'img-mc-001',
                capture_date: '2024-12-26T10:15:00Z',
                modality: 'oct',
                laterality: 'od',
                treatment_context: { days_since_last_treatment: null, last_treatment: null, interval_from_prior_image: null, treatment_cycle_number: null },
            },
            {
                image_id: 'img-mc-002',
                capture_date: '2024-12-26T10:22:00Z',
                modality: 'oct',
                laterality: 'os',
                treatment_context: { days_since_last_treatment: null, last_treatment: null, interval_from_prior_image: null, treatment_cycle_number: null },
            },
        ],
        interval_analysis: {
            intervals: [],
            pattern_summary: { total_cycles: 0, good_response_count: 0, poor_response_count: 0, average_interval: null },
            optimal_interval: null,
            recommendation: '',
            confidence: 'low',
        },
        hcq_progression: {
            gc_thickness_trend: [{ value: 82 }, { value: 70 }],
            rpe_changes_trend: [],
            progression_detected: true,
            progression_description: 'Ganglion cell layer declined 12µm across serial OCTs',
            alert_level: 'medium',
            recommendation: 'Correlate with visual fields; discuss HCQ dosing with rheumatology',
        },
    },
    facts_by_type: factsByType,
    gate_metrics: { claims: 14, verified: 13, blocked: 1, citationsChecked: 18, citationsFailed: 1 },
    prepared_at: '2024-12-26T11:00:00Z',
    correlation_id: 'corr-fixture-001',
};

export const storedBrief: StoredBrief = {
    id: 'brief-fixture-001',
    patient_id: 'margaret-chen',
    prepared_at: briefContent.prepared_at,
    correlation_id: briefContent.correlation_id,
    content: briefContent,
    status: 'complete',
};

// ---- Patients + deterministic overview (S2.11 realignment) ----

export const margaretChen: PatientRecord = {
    id: 'margaret-chen',
    openemr_patient_id: null,
    name: 'Margaret Chen',
    demographics: {
        dob: '1967-03-14',
        sex: 'F',
        mrn: 'FPA-2019-4521',
        appointment_date: '2024-12-26',
        appointment_time: '10:30',
        visit_type: 'new_patient',
    },
};

export const williamThompson: PatientRecord = {
    id: 'william-thompson',
    openemr_patient_id: null,
    name: 'William Thompson',
    demographics: {
        dob: '1946-08-22',
        sex: 'M',
        mrn: 'MEC-2025-1187',
        appointment_date: '2024-12-26',
        appointment_time: '13:15',
        visit_type: 'established_patient',
    },
};

/** Deliberately unsorted — the sidebar must order by appointment_time (Margaret 10:30 first). */
export const patients: PatientRecord[] = [williamThompson, margaretChen];

/** Stored rows carry the raw jsonb payload: one runtime detector shape + one rich seed shape. */
export const storedContradictions: StoredContradictionRow[] = [
    {
        id: 'contra-mc-002',
        patient_id: 'margaret-chen',
        status: 'active',
        severity: 'critical',
        payload: allergyContradiction as unknown as Record<string, unknown>,
    },
    {
        id: 'contra-mc-001',
        patient_id: 'margaret-chen',
        status: 'active',
        severity: 'high',
        payload: {
            contradiction_id: 'contra-mc-001',
            patient_id: 'margaret-chen',
            type: 'temporal_discrepancy',
            category: 'medication_duration',
            severity: 'high',
            status: 'active',
            clinical_significance:
                'HCQ duration conflicts across sources: referral says ~4 years, pharmacy first-fill implies 5 years 11 months',
            source_documents: [
                {
                    source_document_id: 'doc-mc-001',
                    filename: 'referral-letter-pcp-2024-12-15.txt',
                    claim: '~4 years duration',
                    exact_text: 'Hydroxychloroquine (Plaquenil) 200mg daily - for RA, ~4 years duration',
                    certainty: 'hedged',
                },
                {
                    source_document_id: 'doc-mc-002',
                    filename: 'pharmacy-pull-2024-12-26.json',
                    claim: 'First fill 2019-01-15 = 5 years 11 months',
                    exact_text: '"first_fill_date": "2019-01-15"',
                    certainty: 'definitive',
                },
            ],
            physician_workflow: {
                surface_in_briefing: true,
                auto_generate_question: 'How long have you actually been taking hydroxychloroquine?',
                suggested_briefing_language: 'IMPORTANT: Medication duration discrepancy may affect screening urgency',
            },
        },
    },
];

/** Ascending capture_date, as GET /api/overview serves them; no storage_key -> ScanImage placeholder. */
export const overviewImages: ImageRecord[] = [
    { id: 'img-mc-001', patient_id: 'margaret-chen', image_metadata: { capture_date: '2024-12-26T10:15:00Z', modality: 'oct', laterality: 'od' } },
    { id: 'img-mc-002', patient_id: 'margaret-chen', image_metadata: { capture_date: '2024-12-26T10:22:00Z', modality: 'oct', laterality: 'os' } },
];

export const overviewDocuments: OverviewDocumentMeta[] = documents.map((doc) => ({
    id: doc.id ?? '',
    document_type: doc.document_type,
    document_date: doc.document_date,
    metadata: doc.metadata ?? {},
    extras: doc.extras ?? {},
}));

export const emptyImaging: BriefContent['imaging'] = {
    timeline_summary: [],
    interval_analysis: {
        intervals: [],
        pattern_summary: { total_cycles: 0, good_response_count: 0, poor_response_count: 0, average_interval: null },
        optimal_interval: null,
        recommendation: '',
        confidence: 'low',
    },
    hcq_progression: {
        gc_thickness_trend: [],
        rpe_changes_trend: [],
        progression_detected: false,
        progression_description: '',
        alert_level: 'low',
        recommendation: '',
    },
};

/** What buildOverview derives for Margaret: HCQ risk flag + HCQ trend monitoring, no protocol. */
export const margaretCarePlan: CarePlan = {
    active_condition_fact_ids: ['fact-mc-cond-001'],
    protocol: null,
    monitoring: [
        {
            text: 'Baseline and annual OCT plus visual field screening',
            severity: 'high',
            source: 'AAO HCQ Screening Guidelines 2016 (revised 2020)',
        },
        {
            text: 'Correlate with visual fields; discuss HCQ dosing with rheumatology',
            severity: 'medium',
            source: 'imaging trend analysis',
        },
    ],
    follow_up: { recommendation: null, optimal_interval_weeks: null, confidence: 'low' },
};

export const emptyCarePlan: CarePlan = {
    active_condition_fact_ids: [],
    protocol: null,
    monitoring: [],
    follow_up: { recommendation: null, optimal_interval_weeks: null, confidence: 'low' },
};

export const overviewPayload: OverviewPayload = {
    patient: margaretChen,
    facts_by_type: briefContent.facts_by_type,
    medication_risk_flags: briefContent.medication_risk_flags,
    care_plan: margaretCarePlan,
    contradictions: storedContradictions,
    documents: overviewDocuments,
    images: overviewImages,
    imaging: briefContent.imaging,
    latest_brief: { id: 'brief-fixture-001', prepared_at: briefContent.prepared_at, correlation_id: briefContent.correlation_id },
    generated_at: '2024-12-26T09:55:00Z',
};

export const overviewNoBrief: OverviewPayload = { ...overviewPayload, latest_brief: null };

export const williamOverview: OverviewPayload = {
    patient: williamThompson,
    facts_by_type: {},
    medication_risk_flags: [],
    care_plan: emptyCarePlan,
    contradictions: [],
    documents: [],
    images: [],
    imaging: emptyImaging,
    latest_brief: null,
    generated_at: '2024-12-26T09:55:00Z',
};

export const factBundle: FactBundle = {
    patient: { id: 'margaret-chen', openemr_patient_id: null, name: 'Margaret Chen', demographics: {} },
    facts: [],
    contradictions: [],
    images: [],
    treatments: [],
    documents,
};

// ---- EHR sync (E3): the snapshot document + EHR-origin facts as GET /api/overview serves
// them after a live FHIR pull (openemr/ehrSync.ts buildEhrSnapshot shape). ----

export const EHR_SNAPSHOT_DOC_ID = 'ehr-snapshot-margaret-chen';

/** An EHR-provenance citation: external_ehr_import, pointing at the ehr-snapshot document. */
function ehrCitation(factId: string, excerpt: string): CitationRef {
    return {
        id: `${factId}-c1`,
        fact_id: factId,
        source_label: 'OpenEMR EHR',
        source_type: 'external_ehr_import',
        excerpt_text: excerpt,
        excerpt_location: null,
        attribution: { speaker_role: 'system' },
        source_document_id: EHR_SNAPSHOT_DOC_ID,
        document_date: '2026-07-08',
    };
}

const ehrBase = {
    patient_id: 'margaret-chen',
    is_current: true,
    created_date: '2026-07-08',
    source_document_id: EHR_SNAPSHOT_DOC_ID,
    verification: { status: 'unverified' as const },
    laterality: null,
};

/** Facts projected from the FHIR pull, plus one external medication so origin filtering shows. */
export const ehrFactsByType: Partial<Record<FactType, PatientFact[]>> = {
    condition: [
        {
            ...ehrBase,
            id: 'ehr-margaret-chen-1',
            fact_type: 'condition',
            content: { name: 'Rheumatoid arthritis', icd10: 'M06.9', status: 'active' },
            sources: [ehrCitation('ehr-margaret-chen-1', 'Condition: Rheumatoid arthritis (ICD-10 M06.9) — active')],
        },
    ],
    allergy: [
        {
            ...ehrBase,
            id: 'ehr-margaret-chen-2',
            fact_type: 'allergy',
            content: { substance: 'Sulfonamides', reaction: 'Rash' },
            sources: [ehrCitation('ehr-margaret-chen-2', 'Allergy: Sulfonamides — reaction: Rash')],
        },
    ],
    medication: [
        {
            ...ehrBase,
            id: 'ehr-margaret-chen-3',
            fact_type: 'medication',
            content: { name: 'Hydroxychloroquine', dose: '200 mg daily' },
            sources: [ehrCitation('ehr-margaret-chen-3', 'Medication: Hydroxychloroquine — 200 mg daily')],
        },
        {
            ...base,
            id: 'fact-ext-med-001',
            fact_type: 'medication',
            content: { name: 'Aspirin', dose: '81mg' },
            source_document_id: 'doc-mc-002',
            sources: [bareCitation], // pharmacy_record -> external
            verification: { status: 'verified' },
            laterality: null,
        },
    ],
    vital_sign: [
        {
            ...ehrBase,
            id: 'ehr-margaret-chen-4',
            fact_type: 'vital_sign',
            content: { name: 'IOP', value: 24, units: 'mmHg' },
            sources: [ehrCitation('ehr-margaret-chen-4', 'IOP: 24 mmHg')],
        },
    ],
};

export const ehrImportDoc: OverviewDocumentMeta = {
    id: EHR_SNAPSHOT_DOC_ID,
    document_type: 'ehr_import',
    document_date: '2026-07-08',
    metadata: { source_system: 'openemr_fhir', imported_at: '2026-07-08T13:55:00.000Z' },
    extras: {},
};

/** A conflict pitting the live EHR value against an external pharmacy pull (E3 origin test). */
export const ehrVsExternalContradiction: StoredContradictionRow = {
    id: 'contra-ehr-001',
    patient_id: 'margaret-chen',
    status: 'active',
    severity: 'high',
    payload: {
        type: 'medication_discrepancy',
        description: 'OpenEMR lists Hydroxychloroquine 200mg; the pharmacy pull shows a 400mg fill',
        suggested_question: 'Which hydroxychloroquine dose is current?',
        source_a: {
            type: 'external_ehr_import',
            value: 'Hydroxychloroquine 200 mg daily',
            document_id: EHR_SNAPSHOT_DOC_ID,
            excerpt: 'Medication: Hydroxychloroquine — 200 mg daily',
        },
        source_b: {
            type: 'pharmacy_record',
            value: 'Hydroxychloroquine 400 mg',
            document_id: 'doc-mc-002',
            excerpt: '400 mg fill 2026-06-01',
        },
    },
};

/** Overview after a sync: EHR facts + the ehr_import doc, no contradictions (badge test). */
export const ehrOverview: OverviewPayload = {
    ...overviewNoBrief,
    facts_by_type: ehrFactsByType,
    medication_risk_flags: [],
    contradictions: [],
    documents: [ehrImportDoc, ...overviewDocuments],
    images: [],
    generated_at: '2026-07-08T14:00:00.000Z',
};

/** Minimal overview carrying only the mixed EHR-vs-external conflict (contradiction origin test). */
export const ehrContradictionOverview: OverviewPayload = {
    ...williamOverview,
    patient: margaretChen,
    contradictions: [ehrVsExternalContradiction],
    generated_at: '2026-07-08T14:00:00.000Z',
};
