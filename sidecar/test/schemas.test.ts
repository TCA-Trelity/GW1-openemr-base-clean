// Schema contract tests for the S1.2 verbatim port. Fixtures are drawn from the
// second-opinion prototype's seed data (Margaret Chen corpus, William Thompson imaging).
// Each test names the failure mode it guards (project convention).
import { describe, expect, it } from 'vitest';
import {
    CitationRefSchema,
    ContradictionSchema,
    DEFAULT_PROVIDER_PROFILE,
    DELEGATED_VERIFICATION_ALLOWED,
    FACT_TYPES,
    ImageRecordSchema,
    PatientFactSchema,
    PHYSICIAN_VERIFICATION_REQUIRED,
    projectContradiction,
    ProviderProfileSchema,
    RuntimeContradictionSchema,
    SeedSourceDocumentSchema,
    SourceDocumentSchema,
    TreatmentRecordSchema,
    canVerifyFactType,
} from '../src/schemas/index.js';

const validCitation = {
    id: 'fact-hcq-source-0',
    fact_id: 'fact-hcq',
    source_label: 'Referral Dec 15',
    source_type: 'referral_letter',
    excerpt_text: 'Hydroxychloroquine (Plaquenil) 200mg daily - for RA, ~4 years duration',
    excerpt_location: {
        type: 'character_range',
        start_char: 1042,
        end_char: 1113,
        context_before: 'CURRENT MEDICATIONS (as documented in chart):\n1. ',
        context_after: '\n2. Methotrexate - weekly',
    },
    attribution: {
        speaker_role: 'external_provider',
        speaker_name: 'Sarah Warren, MD',
        speaker_relationship: null,
        confidence: 0.92,
    },
    source_document_id: 'doc-referral-2024-12-15',
    document_date: '2024-12-15',
    deep_link_url: '/PatientBriefing?sourceId=doc-referral-2024-12-15&view=sources&start=1042&end=1113',
};

const validMedicationFact = {
    id: 'fact-hcq',
    patient_id: 'margaret-chen',
    fact_type: 'medication',
    content: { name: 'Hydroxychloroquine', generic_name: 'hydroxychloroquine', dose: '200mg', frequency: 'daily', indication: 'RA' },
    is_current: true,
    source_document_id: 'doc-referral-2024-12-15',
    sources: [validCitation],
    verification: { status: 'unverified', verified_by_user_id: null, verified_at: null, verifier_role: null },
    laterality: null,
};

describe('PatientFactSchema', () => {
    // Guards: a well-formed medication fact from the corpus being rejected by the port.
    it('accepts a valid medication fact with citation sources', () => {
        const parsed = PatientFactSchema.parse(validMedicationFact);
        expect(parsed.fact_type).toBe('medication');
        if (parsed.fact_type === 'medication') {
            expect(parsed.content.name).toBe('Hydroxychloroquine');
        }
    });

    // Guards: silently persisting a fact with no provenance (source_document_id is required).
    it('rejects a fact missing source_document_id', () => {
        const { source_document_id: _omitted, ...withoutSource } = validMedicationFact;
        expect(PatientFactSchema.safeParse(withoutSource).success).toBe(false);
    });

    // Guards: a 12th fact type sneaking in outside the closed 11-value enum.
    it('rejects an unknown fact_type', () => {
        expect(PatientFactSchema.safeParse({ ...validMedicationFact, fact_type: 'lab_result' }).success).toBe(false);
    });

    // Guards: content/fact_type mismatch (medication content on an allergy fact).
    it('rejects allergy facts whose content lacks a substance', () => {
        const bad = { ...validMedicationFact, fact_type: 'allergy' }; // content has name, not substance
        expect(PatientFactSchema.safeParse(bad).success).toBe(false);
    });

    // Guards: imaging's lowercase laterality leaking into fact-level OD|OS|OU.
    it('rejects lowercase laterality on facts', () => {
        expect(PatientFactSchema.safeParse({ ...validMedicationFact, laterality: 'od' }).success).toBe(false);
        expect(PatientFactSchema.parse({ ...validMedicationFact, laterality: 'OD' }).laterality).toBe('OD');
    });

    // Guards: verification statuses outside unverified|verified|disputed|patient_reported.
    it('rejects unknown verification statuses and defaults absent verification to unverified', () => {
        const bad = { ...validMedicationFact, verification: { status: 'ai_suggested' } };
        expect(PatientFactSchema.safeParse(bad).success).toBe(false);
        const { verification: _omitted, ...noVerification } = validMedicationFact;
        expect(PatientFactSchema.parse(noVerification).verification.status).toBe('unverified');
    });

    // Guards: regressions in the inferred-from-source chief_complaint shape (factExtraction.jsx:121-127).
    it('accepts a chief_complaint fact with the prototype extraction shape', () => {
        const fact = {
            ...validMedicationFact,
            id: 'fact-cc',
            fact_type: 'chief_complaint',
            content: { raw_statement: 'Floaters in right eye x 3 weeks', category: 'visual_disturbance', onset: '3 weeks ago', duration: '3 weeks', severity: 'moderate' },
        };
        expect(PatientFactSchema.safeParse(fact).success).toBe(true);
    });
});

describe('CitationRefSchema', () => {
    // Guards: losing the character-range deep-link contract (SourcesView highlight spec).
    it('accepts a citation with a character_range excerpt location', () => {
        const parsed = CitationRefSchema.parse(validCitation);
        expect(parsed.excerpt_location?.start_char).toBe(1042);
        expect(parsed.excerpt_location?.end_char).toBe(1113);
    });

    // Guards: alternative location types silently passing where only character_range is valid.
    it('rejects excerpt locations that are not character_range', () => {
        const bad = { ...validCitation, excerpt_location: { ...validCitation.excerpt_location, type: 'page_offset' } };
        expect(CitationRefSchema.safeParse(bad).success).toBe(false);
    });

    // Guards: negative offsets corrupting the highlight range arithmetic.
    it('rejects negative start_char', () => {
        const bad = { ...validCitation, excerpt_location: { ...validCitation.excerpt_location, start_char: -1 } };
        expect(CitationRefSchema.safeParse(bad).success).toBe(false);
    });

    // Guards: source types outside the 11-value enum from citationHelpers.jsx typeLabels.
    it('rejects unknown source_type', () => {
        expect(CitationRefSchema.safeParse({ ...validCitation, source_type: 'fax' }).success).toBe(false);
    });

    // Guards: attribution speaker roles outside the prototype's 8-role set.
    it('rejects unknown attribution speaker_role', () => {
        const bad = { ...validCitation, attribution: { ...validCitation.attribution, speaker_role: 'caregiver' } };
        expect(CitationRefSchema.safeParse(bad).success).toBe(false);
    });
});

// Abridged from margaret-chen/index.jsx mc_contradiction_001 (HCQ duration).
const richContradiction = {
    contradiction_id: 'mc_contradiction_001',
    type: 'temporal_discrepancy',
    category: 'medication_duration',
    severity: 'high',
    clinical_significance: 'Affects HCQ screening urgency and risk stratification',
    source_documents: [
        {
            filename: 'referral-letter-pcp-2024-12-15.txt',
            claim: 'Hydroxychloroquine ~4 years duration',
            exact_text: 'Hydroxychloroquine (Plaquenil) 200mg daily - for RA, ~4 years duration',
            certainty: 'hedged',
        },
        {
            filename: 'pharmacy-pull-2024-12-26.json',
            claim: 'First fill date 2019-01-15 = 5 years 11 months',
            exact_text: '"first_fill_date": "2019-01-15"',
            certainty: 'definitive',
        },
    ],
    ground_truth: {
        accurate_value: '5 years 11 months (as of Dec 26, 2024)',
        source: 'pharmacy-pull-2024-12-26.json',
        rationale: 'Pharmacy fill records are most reliable for medication start dates',
    },
    detection_strategy: {
        method: 'temporal_extraction_comparison',
        keywords: ['hydroxychloroquine', 'HCQ', 'Plaquenil', 'years', 'duration'],
        expected_automation: true,
        detection_difficulty: 'moderate',
    },
    clinical_impact: {
        affects_care: true,
        urgency_level: 'high',
        explanation: 'AAO guidelines recommend annual HCQ retinopathy screening after 5 years.',
        recommended_action: 'Immediate comprehensive retinal examination',
    },
    physician_workflow: {
        surface_in_briefing: true,
        auto_generate_question: 'Can you confirm when you started this medication?',
        suggested_briefing_language: 'IMPORTANT: Medication duration discrepancy may affect screening urgency',
    },
} as const;

describe('ContradictionSchema (rich) and runtime projection', () => {
    // Guards: the eval-ground-truth shape drifting from the seeded corpus contradictions.
    it('accepts the Margaret Chen HCQ-duration contradiction', () => {
        const parsed = ContradictionSchema.parse(richContradiction);
        expect(parsed.source_documents).toHaveLength(2);
        expect(parsed.ground_truth.source).toBe('pharmacy-pull-2024-12-26.json');
    });

    // Guards: certainty values outside definitive|hedged|uncertain|patient_reported.
    it('rejects unknown claim certainty', () => {
        const bad = {
            ...richContradiction,
            source_documents: [{ ...richContradiction.source_documents[0], certainty: 'probable' }],
        };
        expect(ContradictionSchema.safeParse(bad).success).toBe(false);
    });

    // Guards: a contradiction with no supporting documents (nothing to verify against).
    it('rejects an empty source_documents array', () => {
        expect(ContradictionSchema.safeParse({ ...richContradiction, source_documents: [] }).success).toBe(false);
    });

    // Guards: the (a)-projection losing the fields the panel renders (question, sources).
    it('projects the rich shape to a valid runtime contradiction', () => {
        const runtime = projectContradiction(ContradictionSchema.parse(richContradiction), {
            id: 'ctr-1',
            patientId: 'margaret-chen',
        });
        expect(RuntimeContradictionSchema.safeParse(runtime).success).toBe(true);
        expect(runtime.status).toBe('active');
        expect(runtime.suggested_question).toBe('Can you confirm when you started this medication?');
        expect(runtime.source_a?.document_id).toBe('referral-letter-pcp-2024-12-15.txt');
        expect(runtime.source_b?.excerpt).toBe('"first_fill_date": "2019-01-15"');
    });

    // Guards: rejecting real detector output — contradictionDetection.jsx emits severity 'medium'.
    it("accepts the runtime detector's 'medium' severity", () => {
        const detectorShaped = {
            id: 'ctr-2',
            patient_id: 'margaret-chen',
            status: 'active',
            severity: 'medium',
            type: 'medication_omission',
            description: 'Pharmacy shows active medication, but patient did not mention during intake',
            suggested_question: 'Are you currently taking this medication?',
            source_a: { type: 'intake_transcript', value: 'Medication not mentioned in intake', document_id: 'intake-1' },
            source_b: { type: 'pharmacy_record', value: 'Active prescription', document_id: 'rx-1' },
            confidence: 0.7,
        };
        expect(RuntimeContradictionSchema.safeParse(detectorShaped).success).toBe(true);
    });
});

// Abridged from margaret-chen/sourceData.jsx referralLetter.
const referralDocument = {
    document_type: 'referral_letter',
    document_date: '2024-12-15',
    received_date: '2024-12-16',
    received_method: 'fax',
    content: {
        format: 'text',
        text_content: 'RE: REFERRAL FOR OPHTHALMOLOGY EVALUATION ...',
        ocr_quality: 0.92,
        ocr_artifacts: ['slight blur on fax header', 'signature partially legible'],
    },
    extracted_data: { chief_complaint: 'Floaters in right eye x approximately 3 weeks' },
    metadata: {
        source_system: 'fax_intake',
        imported_at: '2024-12-16T09:30:00Z',
        imported_by: 'front_desk',
        pages: 1,
        original_filename: 'referral_chen_margaret_20241215.pdf',
    },
};

describe('SourceDocumentSchema / SeedSourceDocumentSchema', () => {
    // Guards: the seeded corpus failing validation at import time (S1.4 depends on this).
    it('accepts a corpus-shaped text document', () => {
        expect(SourceDocumentSchema.safeParse(referralDocument).success).toBe(true);
    });

    // Guards: demo-only planted-issue annotations leaking into the EHR-facing store.
    it('rejects documents carrying intentional_issues on the persisted schema', () => {
        const withIssues = {
            ...referralDocument,
            intentional_issues: {
                hcq_duration: { issue: "Duration stated as '~4 years'", actual: '5 years 11 months', clinical_impact: 'Underestimates time on HCQ' },
            },
        };
        expect(SourceDocumentSchema.safeParse(withIssues).success).toBe(false);
        // ...while the seed/eval wrapper accepts the same payload.
        expect(SeedSourceDocumentSchema.safeParse(withIssues).success).toBe(true);
    });

    // Guards: OCR confidence outside the documented 0..1 range.
    it('rejects ocr_quality above 1', () => {
        const bad = { ...referralDocument, content: { ...referralDocument.content, ocr_quality: 92 } };
        expect(SourceDocumentSchema.safeParse(bad).success).toBe(false);
    });

    // Guards: rejecting the corpus patient-upload doc (format 'image' is real, manifest missed it).
    it("accepts the corpus 'image' content format", () => {
        const upload = {
            document_type: 'patient_upload',
            document_date: '2025-12-20',
            content: { format: 'image', image_content: { filename: 'my_eye_12_20.jpg' } },
        };
        expect(SourceDocumentSchema.safeParse(upload).success).toBe(true);
    });

    // Guards: manifest-spelled document types replacing the source-of-truth spellings.
    it('uses the source spellings external_records / imaging_internal', () => {
        expect(SourceDocumentSchema.safeParse({ ...referralDocument, document_type: 'external_records' }).success).toBe(true);
        expect(SourceDocumentSchema.safeParse({ ...referralDocument, document_type: 'external_import' }).success).toBe(false);
        expect(SourceDocumentSchema.safeParse({ ...referralDocument, document_type: 'imaging_internal' }).success).toBe(true);
        expect(SourceDocumentSchema.safeParse({ ...referralDocument, document_type: 'imaging' }).success).toBe(false);
    });
});

describe('ProviderProfileSchema defaults', () => {
    // Guards: drift in the exact clinical thresholds the risk engines are calibrated to
    // (ProviderContext.jsx:51-59) — a silently changed default changes alerting behavior.
    it('carries the exact numeric threshold defaults', () => {
        expect(DEFAULT_PROVIDER_PROFILE.risk_sensitivity.thresholds).toEqual({
            hcq_high_risk_years: 5,
            treatment_interval_warning_weeks: 10,
            stale_verification_days: 180,
            iop_warning_threshold: 21,
            iop_critical_threshold: 30,
            crt_change_warning_microns: 50,
            va_change_warning_lines: 2,
        });
    });

    // Guards: drift in relevance ranking weights (ProviderContext.jsx:35-44).
    it('carries the exact fact_type_weights defaults', () => {
        expect(DEFAULT_PROVIDER_PROFILE.relevance_configuration.fact_type_weights).toEqual({
            medication: 0.8,
            allergy: 1.0,
            condition: 0.8,
            procedure_history: 0.7,
            family_history: 0.5,
            social_history: 0.4,
            imaging_finding: 0.7,
            vital_sign: 0.5,
        });
    });

    // Guards: alert_threshold widening beyond standard|cautious|aggressive or losing its default.
    it('defaults alert_threshold to standard and rejects unknown values', () => {
        expect(DEFAULT_PROVIDER_PROFILE.risk_sensitivity.alert_threshold).toBe('standard');
        expect(ProviderProfileSchema.safeParse({ risk_sensitivity: { alert_threshold: 'paranoid' } }).success).toBe(false);
    });
});

describe('canVerifyFactType role matrix', () => {
    // Guards: non-physicians gaining blanket verification authority.
    it('physician can verify every fact type', () => {
        for (const factType of FACT_TYPES) {
            expect(canVerifyFactType('physician', factType)).toBe(true);
        }
    });

    // Guards: delegated verifiers (nurse) verifying physician-tier facts like allergies.
    it('nurse can verify only the delegated tier', () => {
        for (const factType of DELEGATED_VERIFICATION_ALLOWED) {
            expect(canVerifyFactType('nurse', factType)).toBe(true);
        }
        for (const factType of PHYSICIAN_VERIFICATION_REQUIRED) {
            expect(canVerifyFactType('nurse', factType)).toBe(false);
        }
    });

    // Guards: roles without either verify permission (incl. medical_assistant, which the
    // prototype's ROLES table does NOT grant fact:verify_delegated) verifying anything.
    it('non-verifying roles and unknown roles can verify nothing', () => {
        for (const role of ['technician', 'front_desk', 'medical_assistant', 'office_manager', 'not_a_role']) {
            expect(canVerifyFactType(role, 'social_history')).toBe(false);
            expect(canVerifyFactType(role, 'allergy')).toBe(false);
        }
    });

    // Guards: accidental overlap or coverage drift between the two tier lists
    // (vital_sign is intentionally in neither — permissions.jsx:267-282).
    it('tier lists are disjoint and cover all fact types except vital_sign', () => {
        const union = new Set<string>([...DELEGATED_VERIFICATION_ALLOWED, ...PHYSICIAN_VERIFICATION_REQUIRED]);
        expect(union.size).toBe(DELEGATED_VERIFICATION_ALLOWED.length + PHYSICIAN_VERIFICATION_REQUIRED.length);
        expect(FACT_TYPES.filter((t) => !union.has(t))).toEqual(['vital_sign']);
    });
});

// Abridged from sampleImagingData.jsx img-wt-002 (post-injection follow-up).
const validImageRecord = {
    id: 'img-wt-002',
    patient_id: 'william-thompson',
    study_id: 'study-wt-002',
    image_metadata: {
        capture_date: '2025-07-01T09:15:00Z',
        capture_device: 'Heidelberg Spectralis OCT',
        modality: 'oct',
        laterality: 'od',
        scan_type: 'Macular cube 512x128',
        scan_quality: 9,
    },
    image_url: 'https://example.test/oct/img-wt-002.png',
    treatment_context: {
        days_since_last_treatment: 28,
        last_treatment: { medication: 'Eylea', date: '2025-06-03', dose: '2mg' },
        interval_from_prior_image: 29,
        treatment_cycle_number: 1,
    },
    ai_analysis: {
        analysis_version: '1.0.0',
        analyzed_at: '2025-07-01T09:20:00Z',
        findings: [{ finding_id: 'f-wt-002-1', finding_type: 'drusen', location: 'macular', severity: 'moderate', confidence: 0.95 }],
        measurements: [{ measurement_type: 'central_retinal_thickness', value: 268, unit: 'microns' }],
        comparison_to_prior: {
            prior_image_id: 'img-wt-001',
            prior_image_date: '2025-06-02',
            interval_days: 29,
            overall_change: 'improved',
            changes: [{ finding_type: 'subretinal_fluid', change_type: 'resolved', description: 'Subretinal fluid has resolved' }],
            treatment_response: { assessment: 'good_response', confidence: 0.85, rationale: 'Macula dry at 4 weeks post-treatment' },
        },
        summary: { headline: 'Excellent treatment response', key_findings: ['SRF resolved'], alerts: [], clinical_impression: 'Continue Eylea.' },
    },
};

describe('ImageRecordSchema / TreatmentRecordSchema', () => {
    // Guards: breaking the exact field paths the pure engines read
    // (image_metadata.capture_date, ai_analysis.comparison_to_prior.treatment_response.assessment).
    it('accepts a William Thompson OCT record and preserves engine field paths', () => {
        const parsed = ImageRecordSchema.parse(validImageRecord);
        expect(parsed.image_metadata.capture_date).toBe('2025-07-01T09:15:00Z');
        expect(parsed.ai_analysis?.comparison_to_prior?.treatment_response?.assessment).toBe('good_response');
        expect(parsed.ai_analysis?.measurements[0]?.measurement_type).toBe('central_retinal_thickness');
    });

    // Guards: treatment responses outside good_response|worsened|no_response|partial_response,
    // which would break analyzeIntervalPatterns' outcome classification.
    it('rejects unknown treatment_response assessment', () => {
        const bad = structuredClone(validImageRecord);
        bad.ai_analysis.comparison_to_prior.treatment_response.assessment = 'excellent_response';
        expect(ImageRecordSchema.safeParse(bad).success).toBe(false);
    });

    // Guards: measurement types outside the formatMeasurementType set.
    it('rejects unknown measurement_type', () => {
        const bad = structuredClone(validImageRecord);
        bad.ai_analysis.measurements[0].measurement_type = 'foveal_avascular_zone';
        expect(ImageRecordSchema.safeParse(bad).success).toBe(false);
    });

    // Guards: fact-level uppercase laterality leaking into imaging metadata (lowercase od|os).
    it('rejects uppercase laterality in image_metadata', () => {
        const bad = structuredClone(validImageRecord);
        bad.image_metadata.laterality = 'OD';
        expect(ImageRecordSchema.safeParse(bad).success).toBe(false);
    });

    // Guards: drift in the injection shape the interval engines read
    // (treatment_date, injection_details.{medication,dose,injection_number}).
    it('accepts the over-extended Eylea injection record (tx-wt-003)', () => {
        const parsed = TreatmentRecordSchema.parse({
            id: 'tx-wt-003',
            patient_id: 'william-thompson',
            treatment_type: 'anti_vegf_injection',
            treatment_date: '2025-08-19',
            injection_details: { medication: 'eylea', dose: '2mg', laterality: 'od', injection_number: 3, interval_from_prior: 49 },
            pre_treatment_assessment: { indication: 'Maintenance', oct_findings: 'Dry', visual_acuity: '20/25' },
            outcome: { assessed_at: '2025-10-28', response: 'worsened', oct_change: 'Recurrent SRF at 10 weeks', notes: 'Extended interval too long' },
            performed_by: 'Dr. Sarah Morrison',
        });
        expect(parsed.injection_details?.injection_number).toBe(3);
    });

    // Guards: non-injection treatment events (HCQ medication_start has injection_details: null).
    it('accepts a medication_start event with null injection_details', () => {
        const parsed = TreatmentRecordSchema.parse({
            id: 'tx-mc-001',
            treatment_type: 'medication_start',
            treatment_date: '2021-12-01',
            injection_details: null,
            outcome: null,
            performed_by: 'Dr. Anjali Patel (Rheumatology)',
        });
        expect(parsed.injection_details).toBeNull();
    });
});
