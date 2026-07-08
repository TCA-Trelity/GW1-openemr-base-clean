// Contract types mirroring the sidecar's Zod schemas (src/schemas/*, src/prep/brief.ts).
// Hand-maintained: the sidecar owns the schemas — keep field names in lockstep.

// ---- Citations (schemas/citations.ts) ----

export const SOURCE_TYPES = [
    'intake_transcript',
    'provider_note',
    'pharmacy_record',
    'imaging_report',
    'lab_report',
    'prior_visit_note',
    'referral_letter',
    'patient_self_report',
    'clinical_observation',
    'external_ehr_import',
    'scribe_transcript',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export type SpeakerRole =
    | 'patient'
    | 'family_member'
    | 'physician'
    | 'nurse'
    | 'technician'
    | 'pharmacist'
    | 'external_provider'
    | 'system';

export interface Attribution {
    speaker_role: SpeakerRole;
    speaker_name?: string | null;
    speaker_relationship?: string | null;
    confidence?: number;
}

export interface ExcerptLocation {
    type: 'character_range';
    start_char: number;
    end_char: number;
    context_before: string | null;
    context_after: string | null;
}

export interface CitationRef {
    id: string;
    fact_id?: string | null;
    source_label: string;
    source_type: SourceType;
    excerpt_text: string | null;
    excerpt_location: ExcerptLocation | null;
    attribution: Attribution | null;
    source_document_id: string | null;
    document_date: string | null;
    deep_link_url?: string | null;
}

// ---- Facts (schemas/facts.ts) ----

export const FACT_TYPES = [
    'medication',
    'allergy',
    'condition',
    'clinical_finding',
    'imaging_finding',
    'procedure_history',
    'vital_sign',
    'social_history',
    'family_history',
    'patient_goal',
    'chief_complaint',
] as const;
export type FactType = (typeof FACT_TYPES)[number];

export type FactLaterality = 'OD' | 'OS' | 'OU';
export type VerificationStatus = 'unverified' | 'verified' | 'disputed' | 'patient_reported';

export interface FactVerification {
    status: VerificationStatus;
    verified_by_user_id?: string | null;
    verified_at?: string | null;
    verifier_role?: string | null;
}

export interface MedicationContent {
    name: string;
    generic_name?: string;
    dose?: string;
    frequency?: string;
    route?: string;
    start_date?: string | null;
    end_date?: string | null;
    prescriber?: string | null;
    indication?: string;
    risk_flags?: string[];
}

export interface AllergyContent {
    substance: string;
    reaction?: string;
    severity?: string;
    verified?: boolean;
    source?: string;
}

export interface ConditionContent {
    name: string;
    icd10?: string;
    status?: 'active' | 'controlled' | 'resolved';
    since?: string;
    severity?: string;
}

export interface ClinicalFindingContent {
    finding: string;
    body_part?: string;
    laterality?: FactLaterality | null;
    severity?: string;
    source?: string;
}

export interface ImagingFindingContent {
    finding_type: string;
    severity?: string;
    confidence?: number;
    measurements?: Record<string, unknown>;
    laterality?: FactLaterality | null;
    source_image_id?: string;
}

export interface ProcedureHistoryContent {
    procedure: string;
    cpt?: string;
    laterality?: FactLaterality | null;
    date?: string;
    performed_by?: string;
    notes?: string;
}

export interface VitalSignContent {
    name: 'IOP' | 'VA' | 'CRT' | 'BP' | 'HR';
    value: number | string;
    units?: string;
    laterality?: FactLaterality | null;
    captured_at?: string;
}

export interface SocialHistoryContent {
    category: string;
    value: string;
    notes?: string;
}

export interface FamilyHistoryContent {
    relative: string;
    condition: string;
    age_at_diagnosis?: number | string | null;
    outcome?: string;
}

export interface PatientGoalContent {
    goal: string;
    specific_concerns?: string[];
    verbatim_quotes?: string[];
    emotional_state?: string;
}

export interface ChiefComplaintContent {
    statement: string;
    onset?: string;
    onset_context?: string;
    laterality?: string;
    progression?: string;
    pertinent_negatives?: string[];
}

interface FactBase {
    id: string;
    patient_id: string;
    is_current: boolean;
    source_document_id: string;
    sources: CitationRef[];
    verification: FactVerification;
    laterality: FactLaterality | null;
    created_date?: string;
    updated_date?: string;
}

export type PatientFact = FactBase &
    (
        | { fact_type: 'medication'; content: MedicationContent }
        | { fact_type: 'allergy'; content: AllergyContent }
        | { fact_type: 'condition'; content: ConditionContent }
        | { fact_type: 'clinical_finding'; content: ClinicalFindingContent }
        | { fact_type: 'imaging_finding'; content: ImagingFindingContent }
        | { fact_type: 'procedure_history'; content: ProcedureHistoryContent }
        | { fact_type: 'vital_sign'; content: VitalSignContent }
        | { fact_type: 'social_history'; content: SocialHistoryContent }
        | { fact_type: 'family_history'; content: FamilyHistoryContent }
        | { fact_type: 'patient_goal'; content: PatientGoalContent }
        | { fact_type: 'chief_complaint'; content: ChiefComplaintContent }
    );

// ---- Contradictions (schemas/contradictions.ts, runtime projection) ----

export interface RuntimeContradictionSource {
    type: string;
    value: string;
    timestamp?: string | null;
    document_id?: string | null;
    excerpt?: string | null;
}

export type ContradictionSeverity = 'critical' | 'high' | 'medium' | 'moderate' | 'low';

export interface RuntimeContradiction {
    id: string;
    patient_id: string;
    status: 'active' | 'resolved';
    severity: ContradictionSeverity;
    type: string;
    description: string;
    suggested_question: string | null;
    source_a: RuntimeContradictionSource | null;
    source_b: RuntimeContradictionSource | null;
    clinical_implication?: string;
    detection_method?: string;
    confidence?: number;
}

// ---- Brief content (prep/brief.ts BriefContentSchema) ----

export interface MedicationRiskFlag {
    medication: string;
    flag_type: 'retinal_toxicity' | 'bleeding_risk' | 'iop_risk' | 'ifis_risk' | 'diabetic_screening' | 'custom_priority';
    severity: 'high' | 'medium' | 'low';
    message: string;
    recommendation: string;
    source: string;
    details?: { duration_years: number; cumulative_dose_grams: number; daily_dose_mg: number };
    relevance_boost?: number;
}

export interface IntervalPatternAnalysis {
    intervals: {
        interval_weeks: number;
        outcome: 'good_response' | 'worsened' | 'no_response' | 'partial_response';
        image_date?: string;
        treatment_date: string;
        medication?: string;
    }[];
    pattern_summary: {
        total_cycles: number;
        good_response_count: number;
        poor_response_count: number;
        average_interval: number | null;
    };
    optimal_interval: number | null;
    recommendation: string;
    confidence: 'high' | 'medium' | 'low';
}

export interface HcqProgressionAnalysis {
    gc_thickness_trend: { date?: string; value: number; image_id?: string }[];
    rpe_changes_trend: { date?: string; severity?: 'mild' | 'moderate' | 'severe'; confidence?: number; image_id?: string }[];
    progression_detected: boolean;
    progression_description: string;
    alert_level: 'low' | 'medium' | 'high';
    recommendation: string;
}

export interface ImagingTimelineEntry {
    image_id: string;
    capture_date: string;
    modality: string;
    laterality: string;
    treatment_context: {
        days_since_last_treatment: number | null;
        last_treatment: { medication: string; date: string; dose?: string } | null;
        interval_from_prior_image: number | null;
        treatment_cycle_number: number | null;
    };
}

export interface GateMetrics {
    claims: number;
    verified: number;
    blocked: number;
    citationsChecked: number;
    citationsFailed: number;
}

export interface BriefContent {
    urgency: { level: 'high' | 'moderate'; reason: string } | null;
    contradiction_alerts: RuntimeContradiction[];
    why_they_are_here: { fact_id: string; content: ChiefComplaintContent } | null;
    what_they_are_hoping_for: { fact_id: string; content: PatientGoalContent } | null;
    key_discussion_points: string[];
    questions_to_confirm: string[];
    medication_risk_flags: MedicationRiskFlag[];
    imaging: {
        timeline_summary: ImagingTimelineEntry[];
        interval_analysis: IntervalPatternAnalysis;
        hcq_progression: HcqProgressionAnalysis;
    };
    facts_by_type: Record<FactType, PatientFact[]>;
    gate_metrics: GateMetrics;
    prepared_at: string;
    correlation_id: string;
}

// ---- API responses (routes/prep.ts) ----

export interface StoredBrief {
    id: string;
    patient_id: string;
    prepared_at: string;
    correlation_id: string;
    content: BriefContent;
    status: string;
}

export interface SourceDocumentRecord {
    id?: string;
    document_id?: string;
    filename?: string;
    document_type: string;
    document_date: string;
    received_method?: string;
    content: {
        format: string;
        text_content?: string;
        structured_content?: Record<string, unknown>;
    };
    metadata?: { original_filename?: string; source_system?: string };
}

export interface FactBundle {
    patient: { id: string; openemr_patient_id: string | null; name: string; demographics: Record<string, unknown> };
    facts: unknown[];
    contradictions: unknown[];
    images: unknown[];
    treatments: unknown[];
    /** Not yet emitted by GET /api/facts (see S2.1 report) — the Sources tab renders these when present. */
    documents?: SourceDocumentRecord[];
}
