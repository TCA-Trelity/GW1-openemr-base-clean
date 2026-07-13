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
    'guideline_evidence',
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

export type ExcerptLocation =
    | {
          type: 'character_range';
          start_char: number;
          end_char: number;
          context_before: string | null;
          context_after: string | null;
      }
    | { type: 'page_bbox'; page: number; x: number; y: number; w: number; h: number }
    | { type: 'page'; page: number };

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
    page_or_section?: string | null;
    field_or_chunk_id?: string | null;
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
    'lab_result',
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
    created_date?: string | null;
    updated_date?: string | null;
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
        | { fact_type: 'lab_result'; content: LabResultContent }
    );

// Week 2 (A.6): extracted lab value — mirrors schemas/facts.ts LabResultContentSchema.
export interface LabResultContent {
    test_name: string;
    value: string;
    value_numeric: number | null;
    unit: string | null;
    reference_range: string | null;
    abnormal_flag: 'normal' | 'low' | 'high' | 'critical_low' | 'critical_high' | 'abnormal' | null;
    collection_date: string | null;
    performing_lab: string | null;
}

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

/** Structured discussion point (prep/brief.ts DiscussionPointSchema, R4): terse one-line
 * text (<=90 chars) plus refs the panel renders as chips/links. */
export type DiscussionPointKind = 'med_change' | 'risk_flag' | 'contradiction' | 'imaging' | 'interval';

export interface DiscussionPoint {
    text: string;
    kind: DiscussionPointKind;
    fact_ids: string[];
    contradiction_id: string | null;
}

/** Q3 game plan — the visit's who-does-what, composed from the gated brief (read-only proposal). */
export interface GamePlanItem {
    owner: 'physician' | 'nurse' | 'front_desk' | 'patient';
    action: string;
    timing: string | null;
    kind: 'order' | 'check_in' | 'form' | 'call_back' | 'prescription' | 'monitoring' | 'education';
}
export interface GamePlan {
    summary_line: string;
    items: GamePlanItem[];
}

export interface BriefContent {
    urgency: { level: 'high' | 'moderate'; reason: string } | null;
    contradiction_alerts: RuntimeContradiction[];
    why_they_are_here: { fact_id: string; content: ChiefComplaintContent } | null;
    what_they_are_hoping_for: { fact_id: string; content: PatientGoalContent } | null;
    /** Older stored briefs carry plain strings — tolerate both shapes when rendering. */
    key_discussion_points: (string | DiscussionPoint)[];
    questions_to_confirm: string[];
    medication_risk_flags: MedicationRiskFlag[];
    imaging: {
        timeline_summary: ImagingTimelineEntry[];
        interval_analysis: IntervalPatternAnalysis;
        hcq_progression: HcqProgressionAnalysis;
    };
    facts_by_type: Record<FactType, PatientFact[]>;
    gate_metrics: GateMetrics;
    /** Q3: absent on briefs stored before the game plan shipped; null when composition failed. */
    game_plan?: GamePlan | null;
    prepared_at: string;
    correlation_id: string;
}

// ---- Imaging records (schemas/imaging.ts, wire shape from store getFactBundle) ----

export interface ImagingMeasurement {
    measurement_type: string;
    value: number;
    unit?: string;
    location?: string;
    reference_range?: { normal_min: number; normal_max: number };
}

export interface ImagingScanFinding {
    finding_id?: string;
    finding_type: string;
    location?: string;
    severity?: 'mild' | 'moderate' | 'severe';
    confidence?: number;
    description?: string;
}

export type OverallChange = 'improved' | 'worsened' | 'stable' | 'mixed';
export type TreatmentResponseAssessment = IntervalPatternAnalysis['intervals'][number]['outcome'];

export interface ComparisonToPrior {
    prior_image_id?: string;
    prior_image_date?: string;
    interval_days?: number | null;
    overall_change?: OverallChange;
    treatment_response?: { assessment: TreatmentResponseAssessment; confidence?: number; rationale?: string } | null;
}

export interface ImagingAiAnalysis {
    findings?: ImagingScanFinding[];
    measurements?: ImagingMeasurement[];
    comparison_to_prior?: ComparisonToPrior | null;
    summary?: {
        headline?: string;
        key_findings?: string[];
        alerts?: { level: 'low' | 'medium' | 'high'; message: string }[];
        clinical_impression?: string;
    };
}

export type ImageTreatmentContext = ImagingTimelineEntry['treatment_context'];

export interface ImageRecord {
    id: string;
    patient_id?: string;
    study_id?: string;
    image_metadata: {
        capture_date: string;
        capture_device?: string;
        modality: string;
        laterality: string;
        scan_type?: string;
        scan_quality?: number;
    };
    /** Sidecar ImageStore key — absent/null until the pixels are sourced. The ScanImage seam keys on it. */
    storage_key?: string | null;
    /** Kermany dataset class (e.g. 'CNV', 'NORMAL') when the record's extras carry one. */
    dataset_class?: string;
    treatment_context?: ImageTreatmentContext | null;
    ai_analysis?: ImagingAiAnalysis | null;
}

export interface InjectionDetails {
    medication: string;
    dose?: string;
    laterality?: string;
    injection_number?: number;
    interval_from_prior?: number | null;
}

/** Wire shape of GET /api/facts treatments: the full TreatmentRecord rides in `payload`. */
export interface TreatmentWireRecord {
    id: string;
    patient_id?: string;
    treatment_date: string;
    payload: {
        treatment_type?: string;
        injection_details?: InjectionDetails | null;
    };
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

/** Per-document leftovers the store keeps verbatim (filename, received_*, extracted_data...). */
export interface DocumentExtras {
    filename?: string;
    received_method?: string;
    received_date?: string;
    [key: string]: unknown;
}

export interface SourceDocumentRecord {
    id?: string;
    document_id?: string;
    /** Legacy top-level spelling — the store now carries these in `extras`. */
    filename?: string;
    document_type: string;
    document_date: string | null;
    /** Legacy top-level spelling — the store now carries these in `extras`. */
    received_method?: string;
    content: {
        format: string;
        text_content?: string;
        structured_content?: Record<string, unknown>;
        ocr_quality?: number;
    };
    metadata?: { original_filename?: string; source_system?: string };
    extras?: DocumentExtras;
}

// ---- Patients + deterministic overview (routes/overview.ts) ----

/** Seed demographics shape (store keeps arbitrary jsonb; these keys back the schedule/header). */
export interface PatientDemographics {
    dob?: string;
    sex?: string;
    mrn?: string;
    address?: string;
    phone?: string;
    appointment_date?: string;
    appointment_time?: string;
    visit_type?: string;
    [key: string]: unknown;
}

export interface PatientRecord {
    id: string;
    openemr_patient_id: string | null;
    name: string;
    demographics: PatientDemographics;
}

/** Stored contradiction row: payload is the raw jsonb — rich seed shape OR runtime shape. */
export interface StoredContradictionRow {
    id: string;
    patient_id: string;
    status: string;
    severity: ContradictionSeverity;
    payload: Record<string, unknown>;
}

/** Metadata-only document entry — full text still comes from GET /api/facts. */
export interface OverviewDocumentMeta {
    id: string;
    document_type: string;
    document_date: string | null;
    metadata: Record<string, unknown>;
    extras: DocumentExtras;
}

export interface LatestBriefPointer {
    id: string;
    prepared_at: string;
    correlation_id: string;
}

// ---- Deterministic care plan (routes/overview.ts buildOverview, R3) ----

export interface CarePlanProtocol {
    last_treatment_date: string;
    medication: string | null;
    treatment_count: number;
}

export interface CarePlanMonitoringItem {
    text: string;
    severity: 'high' | 'medium' | 'low';
    source: string;
}

export interface CarePlanFollowUp {
    recommendation: string | null;
    optimal_interval_weeks: number | null;
    confidence: 'high' | 'medium' | 'low';
}

/** Diagnosis & Care payload — pure engine output, populated on first load, no LLM anywhere. */
export interface CarePlan {
    active_condition_fact_ids: string[];
    protocol: CarePlanProtocol | null;
    monitoring: CarePlanMonitoringItem[];
    follow_up: CarePlanFollowUp;
}

/** GET /api/overview/:patientId — deterministic landing payload, no LLM in the load path. */
export interface OverviewPayload {
    patient: PatientRecord;
    facts_by_type: Partial<Record<FactType, PatientFact[]>>;
    medication_risk_flags: MedicationRiskFlag[];
    care_plan: CarePlan;
    contradictions: StoredContradictionRow[];
    documents: OverviewDocumentMeta[];
    images: ImageRecord[];
    imaging: BriefContent['imaging'];
    latest_brief: LatestBriefPointer | null;
    generated_at: string;
}

/** GET /api/prep-runs/:patientId entry — stage carries live progress like `llm_extraction:7/12`. */
export interface PrepRunRecord {
    id: string;
    patient_id: string;
    correlation_id: string;
    status: string;
    stage: string | null;
    error: string | null;
    started_at: string;
    finished_at: string | null;
}

// ---- Chat citations (chat/chat.ts ChatCitation, R5) ----

/** A native Citations-API citation mapped to OUR document ids and server-verified verbatim. */
export interface ChatCitation {
    document_id: string;
    document_title: string;
    cited_text: string;
    start_char: number;
    end_char: number;
    verified: boolean;
}

export interface FactBundle {
    patient: PatientRecord;
    facts: unknown[];
    contradictions: unknown[];
    images: ImageRecord[];
    treatments: TreatmentWireRecord[];
    /** Not yet emitted by GET /api/facts (see S2.1 report) — the Sources tab renders these when present. */
    documents?: SourceDocumentRecord[];
}
