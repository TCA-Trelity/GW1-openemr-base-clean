// ImageRecord / TreatmentRecord schemas — verbatim port of the seed shapes in
// second-opinion sampleImagingData.jsx, constrained to the exact field paths the pure
// engines read (imagingAnalysis.jsx:161-254, 315-346, 351-431, 436-523, 537-582).
import { z } from 'zod';

// Imaging laterality is lowercase in the prototype (unlike fact-level OD|OS|OU).
export const ImagingLateralitySchema = z.enum(['od', 'os']);
export type ImagingLaterality = z.infer<typeof ImagingLateralitySchema>;

export const ModalitySchema = z.enum(['oct', 'fundus_photo']);
export type Modality = z.infer<typeof ModalitySchema>;

// All measurement types known to formatMeasurementType (imagingAnalysis.jsx:556-568).
// The engines only consume central_retinal_thickness and ganglion_cell_thickness.
export const MEASUREMENT_TYPES = [
    'central_retinal_thickness',
    'central_subfield_thickness',
    'macular_volume',
    'ganglion_cell_thickness',
    'rnfl_thickness',
    'rpe_elevation',
    'srf_height',
    'irf_volume',
] as const;
export const MeasurementTypeSchema = z.enum(MEASUREMENT_TYPES);
export type MeasurementType = z.infer<typeof MeasurementTypeSchema>;

// All finding types known to formatFindingType (imagingAnalysis.jsx:537-554).
// analyzeHCQProgression keys on rpe_changes / retinal_thinning.
export const FINDING_TYPES = [
    'subretinal_fluid',
    'intraretinal_fluid',
    'pigment_epithelial_detachment',
    'drusen',
    'geographic_atrophy',
    'retinal_thinning',
    'rpe_changes',
    'epiretinal_membrane',
    'vitreomacular_traction',
    'macular_hole',
    'hemorrhage',
    'exudate',
    'normal',
] as const;
export const FindingTypeSchema = z.enum(FINDING_TYPES);
export type FindingType = z.infer<typeof FindingTypeSchema>;

// severityToNumber (imagingAnalysis.jsx:580-582) knows exactly these three.
export const FindingSeveritySchema = z.enum(['mild', 'moderate', 'severe']);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

export const ImagingMeasurementSchema = z.object({
    measurement_type: MeasurementTypeSchema,
    value: z.number(),
    unit: z.string().optional(),
    location: z.string().optional(),
    reference_range: z.object({ normal_min: z.number(), normal_max: z.number() }).optional(),
});
export type ImagingMeasurement = z.infer<typeof ImagingMeasurementSchema>;

export const ImagingFindingSchema = z.object({
    finding_id: z.string().optional(),
    finding_type: FindingTypeSchema,
    location: z.string().optional(),
    severity: FindingSeveritySchema.optional(), // 'normal' findings carry no severity
    confidence: z.number().min(0).max(1).optional(),
    description: z.string().optional(),
});
export type ImagingFinding = z.infer<typeof ImagingFindingSchema>;

// changes[].finding_type mixes finding and measurement names (computeComparison:198-205
// pushes 'central_retinal_thickness'), so it stays a string.
export const ComparisonChangeSchema = z.object({
    finding_type: z.string(),
    change_type: z.enum(['new', 'resolved', 'improved', 'worsened', 'stable']),
    description: z.string(),
    measurement_delta: z.number().optional(),
});
export type ComparisonChange = z.infer<typeof ComparisonChangeSchema>;

// analyzeIntervalPatterns reads exactly comparison_to_prior.treatment_response.assessment.
export const TreatmentResponseSchema = z.object({
    assessment: z.enum(['good_response', 'worsened', 'no_response', 'partial_response']),
    confidence: z.number().min(0).max(1).optional(),
    rationale: z.string().optional(),
});
export type TreatmentResponse = z.infer<typeof TreatmentResponseSchema>;

export const ComparisonToPriorSchema = z.object({
    prior_image_id: z.string().optional(),
    prior_image_date: z.string().optional(),
    interval_days: z.number().nullable().optional(),
    overall_change: z.enum(['improved', 'worsened', 'stable', 'mixed']).optional(),
    changes: z.array(ComparisonChangeSchema).default([]),
    treatment_response: TreatmentResponseSchema.nullable().optional(),
});
export type ComparisonToPrior = z.infer<typeof ComparisonToPriorSchema>;

export const AnalysisSummarySchema = z.object({
    headline: z.string(),
    key_findings: z.array(z.string()).default([]),
    alerts: z.array(z.object({ level: z.enum(['low', 'medium', 'high']), message: z.string() })).default([]),
    clinical_impression: z.string().optional(),
});
export type AnalysisSummary = z.infer<typeof AnalysisSummarySchema>;

export const AiAnalysisSchema = z.object({
    analysis_version: z.string().optional(),
    analyzed_at: z.string().optional(),
    findings: z.array(ImagingFindingSchema).default([]),
    measurements: z.array(ImagingMeasurementSchema).default([]),
    comparison_to_prior: ComparisonToPriorSchema.nullable().optional(),
    summary: AnalysisSummarySchema.optional(),
});
export type AiAnalysis = z.infer<typeof AiAnalysisSchema>;

// computeTreatmentContext output (imagingAnalysis.jsx:315-346), also present in seed data.
export const TreatmentContextSchema = z.object({
    days_since_last_treatment: z.number().nullable(),
    last_treatment: z
        .object({ medication: z.string(), date: z.string(), dose: z.string().optional() })
        .nullable(),
    interval_from_prior_image: z.number().nullable(),
    treatment_cycle_number: z.number().int().nullable(),
});
export type TreatmentContext = z.infer<typeof TreatmentContextSchema>;

export const ImageMetadataSchema = z.object({
    capture_date: z.string(), // ISO datetime; primary path read by every engine
    capture_device: z.string().optional(),
    modality: ModalitySchema,
    laterality: ImagingLateralitySchema,
    scan_type: z.string().optional(),
    scan_quality: z.number().optional(),
});
export type ImageMetadata = z.infer<typeof ImageMetadataSchema>;

export const ImageRecordSchema = z.object({
    id: z.string().min(1),
    patient_id: z.string().optional(),
    study_id: z.string().optional(),
    image_metadata: ImageMetadataSchema,
    capture_date: z.string().optional(), // legacy top-level fallback the engines still read
    image_url: z.string().optional(),
    thumbnail_url: z.string().optional(),
    storage_key: z.string().optional(), // sidecar ImageStore key (no prototype equivalent)
    source_document_id: z.string().nullable().optional(),
    treatment_context: TreatmentContextSchema.optional(),
    ai_analysis: AiAnalysisSchema.optional(),
});
export type ImageRecord = z.infer<typeof ImageRecordSchema>;

// Seed values: anti_vegf_injection | medication_start — kept open for other event kinds.
export const InjectionDetailsSchema = z.object({
    medication: z.string(),
    dose: z.string().optional(),
    laterality: ImagingLateralitySchema.optional(),
    injection_number: z.number().int().optional(), // engines default missing to cycle 1
    interval_from_prior: z.number().nullable().optional(),
});
export type InjectionDetails = z.infer<typeof InjectionDetailsSchema>;

export const TreatmentRecordSchema = z.object({
    id: z.string().min(1),
    patient_id: z.string().optional(),
    treatment_type: z.string().min(1),
    treatment_date: z.string(), // ISO date; primary path read by every engine
    injection_details: InjectionDetailsSchema.nullable(), // null for medication_start events
    pre_treatment_assessment: z
        .object({
            indication: z.string().optional(),
            oct_findings: z.string().optional(),
            visual_acuity: z.string().optional(),
        })
        .nullable()
        .optional(),
    outcome: z
        .object({
            assessed_at: z.string().optional(),
            response: z.string().optional(), // seed uses 'good' | 'worsened'
            oct_change: z.string().optional(),
            notes: z.string().optional(),
        })
        .nullable()
        .optional(),
    performed_by: z.string().optional(),
});
export type TreatmentRecord = z.infer<typeof TreatmentRecordSchema>;
