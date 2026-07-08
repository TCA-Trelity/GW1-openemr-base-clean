// William Thompson imaging fixtures, faithful to sidecar/seed/william-thompson.json
// (7 OCT records across 4 Eylea cycles, incl. the 10-week leak) with ai_analysis trimmed
// to the fields the panel renders. Treatments carry the payload-wrapped wire shape that
// GET /api/facts returns; interval_analysis matches analyzeIntervalPatterns' exact output.
import type {
    BriefContent,
    FactBundle,
    HcqProgressionAnalysis,
    ImageRecord,
    IntervalPatternAnalysis,
    OverviewPayload,
    PatientRecord,
    TreatmentWireRecord,
} from '../types';
import { briefContent, factBundle } from './fixtures';

interface WtImageSpec {
    id: string;
    capture_date: string;
    headline: string;
    crt: number;
    overall_change?: 'improved' | 'worsened' | 'stable';
    assessment?: 'good_response' | 'worsened';
    days_since_last_treatment: number | null;
    last_treatment_date: string | null;
    treatment_cycle_number: number | null;
}

const IMAGE_SPECS: WtImageSpec[] = [
    { id: 'img-wt-001', capture_date: '2025-05-05T10:30:00Z', headline: 'Active wet AMD with subretinal fluid', crt: 385, days_since_last_treatment: null, last_treatment_date: null, treatment_cycle_number: null },
    { id: 'img-wt-002', capture_date: '2025-06-24T09:15:00Z', headline: 'Excellent response - macula dry at 7 weeks', crt: 266, overall_change: 'improved', assessment: 'good_response', days_since_last_treatment: 49, last_treatment_date: '2025-05-06', treatment_cycle_number: 1 },
    { id: 'img-wt-003', capture_date: '2025-08-12T14:00:00Z', headline: 'Stable - macula dry at 7 weeks', crt: 270, overall_change: 'stable', assessment: 'good_response', days_since_last_treatment: 49, last_treatment_date: '2025-06-24', treatment_cycle_number: 2 },
    { id: 'img-wt-004', capture_date: '2025-09-30T11:20:00Z', headline: 'Macula dry at 7 weeks - extension to 10 weeks trialed', crt: 264, overall_change: 'stable', assessment: 'good_response', days_since_last_treatment: 49, last_treatment_date: '2025-08-12', treatment_cycle_number: 3 },
    { id: 'img-wt-005', capture_date: '2025-10-22T11:30:00Z', headline: 'Fluid recurrence at extended 10-week interval', crt: 331, overall_change: 'worsened', assessment: 'worsened', days_since_last_treatment: 71, last_treatment_date: '2025-08-12', treatment_cycle_number: 3 },
    { id: 'img-wt-006', capture_date: '2025-11-19T10:05:00Z', headline: 'Rescue injection effective - macula dry at 4 weeks', crt: 268, overall_change: 'improved', assessment: 'good_response', days_since_last_treatment: 28, last_treatment_date: '2025-10-22', treatment_cycle_number: 4 },
    { id: 'img-wt-007', capture_date: '2025-12-10T09:40:00Z', headline: 'Macula dry at 7 weeks - stable on 7-week cycle', crt: 262, overall_change: 'stable', assessment: 'good_response', days_since_last_treatment: 49, last_treatment_date: '2025-10-22', treatment_cycle_number: 4 },
];

export const wtImages: ImageRecord[] = IMAGE_SPECS.map((spec) => ({
    id: spec.id,
    patient_id: 'william-thompson',
    image_metadata: {
        capture_date: spec.capture_date,
        capture_device: 'Heidelberg Spectralis OCT',
        modality: 'oct',
        laterality: 'od',
    },
    treatment_context: {
        days_since_last_treatment: spec.days_since_last_treatment,
        last_treatment:
            spec.last_treatment_date === null ? null : { medication: 'Eylea', date: spec.last_treatment_date, dose: '2mg' },
        interval_from_prior_image: null,
        treatment_cycle_number: spec.treatment_cycle_number,
    },
    ai_analysis: {
        measurements: [
            { measurement_type: 'central_retinal_thickness', value: spec.crt, unit: 'microns', reference_range: { normal_min: 240, normal_max: 280 } },
        ],
        comparison_to_prior:
            spec.assessment === undefined
                ? null
                : {
                      ...(spec.overall_change !== undefined ? { overall_change: spec.overall_change } : {}),
                      treatment_response: { assessment: spec.assessment },
                  },
        summary: { headline: spec.headline },
    },
}));

export const wtTreatments: TreatmentWireRecord[] = [1, 2, 3, 4].map((injectionNumber) => ({
    id: `tx-wt-00${injectionNumber}`,
    patient_id: 'william-thompson',
    treatment_date: ['2025-05-06', '2025-06-24', '2025-08-12', '2025-10-22'][injectionNumber - 1] ?? '',
    payload: {
        treatment_type: 'anti_vegf_injection',
        injection_details: { medication: 'Eylea', dose: '2mg', laterality: 'od', injection_number: injectionNumber },
    },
}));

// analyzeIntervalPatterns over the series above: floor((image - prior tx) / week).
export const wtIntervalAnalysis: IntervalPatternAnalysis = {
    intervals: [
        { interval_weeks: 7, outcome: 'good_response', image_date: '2025-06-24T09:15:00Z', treatment_date: '2025-05-06', medication: 'Eylea' },
        { interval_weeks: 7, outcome: 'good_response', image_date: '2025-08-12T14:00:00Z', treatment_date: '2025-06-24', medication: 'Eylea' },
        { interval_weeks: 7, outcome: 'good_response', image_date: '2025-09-30T11:20:00Z', treatment_date: '2025-08-12', medication: 'Eylea' },
        { interval_weeks: 10, outcome: 'worsened', image_date: '2025-10-22T11:30:00Z', treatment_date: '2025-08-12', medication: 'Eylea' },
        { interval_weeks: 4, outcome: 'good_response', image_date: '2025-11-19T10:05:00Z', treatment_date: '2025-10-22', medication: 'Eylea' },
        { interval_weeks: 7, outcome: 'good_response', image_date: '2025-12-10T09:40:00Z', treatment_date: '2025-10-22', medication: 'Eylea' },
    ],
    pattern_summary: { total_cycles: 6, good_response_count: 5, poor_response_count: 1, average_interval: 7 },
    optimal_interval: 7,
    recommendation: 'Patient stable at 7 weeks but leaked at 10 weeks. Recommend 7-week intervals.',
    confidence: 'high',
};

// William Thompson is not an HCQ patient — the engine's no-progression output.
export const wtHcqProgression: HcqProgressionAnalysis = {
    gc_thickness_trend: [],
    rpe_changes_trend: [],
    progression_detected: false,
    progression_description: '',
    alert_level: 'low',
    recommendation: 'Continue routine HCQ monitoring per AAO guidelines',
};

export const wtImaging: BriefContent['imaging'] = {
    timeline_summary: wtImages.map((image) => ({
        image_id: image.id,
        capture_date: image.image_metadata.capture_date,
        modality: image.image_metadata.modality,
        laterality: image.image_metadata.laterality,
        treatment_context: image.treatment_context ?? {
            days_since_last_treatment: null,
            last_treatment: null,
            interval_from_prior_image: null,
            treatment_cycle_number: null,
        },
    })),
    interval_analysis: wtIntervalAnalysis,
    hcq_progression: wtHcqProgression,
};

/** The margaret-chen brief with William Thompson's imaging block swapped in. */
export const wtBriefContent: BriefContent = { ...briefContent, imaging: wtImaging };

export const wtPatient: PatientRecord = {
    id: 'william-thompson',
    openemr_patient_id: null,
    name: 'William Thompson',
    demographics: {
        dob: '1946-08-22',
        sex: 'M',
        mrn: 'MEC-2025-1187',
        appointment_date: '2025-12-10',
        appointment_time: '09:30',
        visit_type: 'established_patient',
    },
};

export const wtFactBundle: FactBundle = {
    ...factBundle,
    patient: wtPatient,
    images: wtImages,
    treatments: wtTreatments,
};

/** Deterministic overview payload for WT — imaging comes straight from the engines, no brief. */
export const wtOverview: OverviewPayload = {
    patient: wtPatient,
    facts_by_type: {},
    medication_risk_flags: [],
    contradictions: [],
    documents: [],
    images: wtImages,
    imaging: wtImaging,
    latest_brief: null,
    generated_at: '2025-12-10T08:00:00Z',
};

// Margaret Chen-style serial GC-IPL measurements (two OCTs, 82µm -> 70µm) for GC trend tests.
export const mcGcImages: ImageRecord[] = [
    {
        id: 'img-mc-gc-001',
        image_metadata: { capture_date: '2021-12-15T10:00:00Z', modality: 'oct', laterality: 'od' },
        ai_analysis: { measurements: [{ measurement_type: 'ganglion_cell_thickness', value: 82, unit: 'microns' }] },
    },
    {
        id: 'img-mc-gc-002',
        image_metadata: { capture_date: '2024-12-26T10:15:00Z', modality: 'oct', laterality: 'od' },
        ai_analysis: { measurements: [{ measurement_type: 'ganglion_cell_thickness', value: 70, unit: 'microns' }] },
    },
];
