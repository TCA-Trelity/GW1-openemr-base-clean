// Brief assembly (S1.7): the Overview IA from the port manifest §4 as DATA, not markup.
// BriefContentSchema is the contract the React panel consumes; deterministic derivations
// only — no second LLM call at Tier 1 (key points come from verified facts + engine output).
import { z } from 'zod';
import { ChiefComplaintContentSchema, FACT_TYPES, PatientFactSchema, PatientGoalContentSchema, RuntimeContradictionSchema, TreatmentContextSchema, } from '../schemas/index.js';
// ---- Engine-output shapes as Zod (engines export TS types only; mirrored here so the
// ---- brief is fully Zod-described — compile-checked against the engine types below) ----
export const MedicationRiskFlagSchema = z.object({
    medication: z.string(),
    flag_type: z.enum(['retinal_toxicity', 'bleeding_risk', 'iop_risk', 'ifis_risk', 'diabetic_screening', 'custom_priority']),
    severity: z.enum(['high', 'medium', 'low']),
    message: z.string(),
    recommendation: z.string(),
    source: z.string(),
    details: z
        .object({ duration_years: z.number(), cumulative_dose_grams: z.number(), daily_dose_mg: z.number() })
        .optional(),
    relevance_boost: z.number().optional(),
});
export const IntervalPatternAnalysisSchema = z.object({
    intervals: z.array(z.object({
        interval_weeks: z.number(),
        outcome: z.enum(['good_response', 'worsened', 'no_response', 'partial_response']),
        image_date: z.string().optional(),
        treatment_date: z.string(),
        medication: z.string().optional(),
    })),
    pattern_summary: z.object({
        total_cycles: z.number().int(),
        good_response_count: z.number().int(),
        poor_response_count: z.number().int(),
        average_interval: z.number().nullable(),
    }),
    optimal_interval: z.number().nullable(),
    recommendation: z.string(),
    confidence: z.enum(['high', 'medium', 'low']),
});
export const HcqProgressionAnalysisSchema = z.object({
    gc_thickness_trend: z.array(z.object({ date: z.string().optional(), value: z.number(), image_id: z.string().optional() })),
    rpe_changes_trend: z.array(z.object({
        date: z.string().optional(),
        severity: z.enum(['mild', 'moderate', 'severe']).optional(),
        confidence: z.number().optional(),
        image_id: z.string().optional(),
    })),
    progression_detected: z.boolean(),
    progression_description: z.string(),
    alert_level: z.enum(['low', 'medium', 'high']),
    recommendation: z.string(),
});
// ---- The brief content shape (manifest §4 Overview IA) ----
export const ImagingTimelineEntrySchema = z.object({
    image_id: z.string(),
    capture_date: z.string(),
    modality: z.string(),
    laterality: z.string(),
    treatment_context: TreatmentContextSchema,
});
export const GateMetricsSchema = z.object({
    claims: z.number().int(),
    verified: z.number().int(),
    blocked: z.number().int(),
    citationsChecked: z.number().int(),
    citationsFailed: z.number().int(),
});
const factsByTypeShape = Object.fromEntries(FACT_TYPES.map((type) => [type, z.array(PatientFactSchema).default([])]));
export const BriefContentSchema = z.object({
    urgency: z.object({ level: z.enum(['high', 'moderate']), reason: z.string() }).nullable(),
    contradiction_alerts: z.array(RuntimeContradictionSchema),
    why_they_are_here: z.object({ fact_id: z.string(), content: ChiefComplaintContentSchema }).nullable(),
    what_they_are_hoping_for: z.object({ fact_id: z.string(), content: PatientGoalContentSchema }).nullable(),
    key_discussion_points: z.array(z.string()),
    questions_to_confirm: z.array(z.string()),
    medication_risk_flags: z.array(MedicationRiskFlagSchema),
    imaging: z.object({
        timeline_summary: z.array(ImagingTimelineEntrySchema),
        interval_analysis: IntervalPatternAnalysisSchema,
        hcq_progression: HcqProgressionAnalysisSchema,
    }),
    facts_by_type: z.object(factsByTypeShape),
    gate_metrics: GateMetricsSchema,
    prepared_at: z.string(),
    correlation_id: z.string(),
});
export function assembleBrief(input) {
    const active = input.contradictions.filter((item) => item.status === 'active');
    const factsByType = Object.fromEntries(FACT_TYPES.map((type) => [type, []]));
    for (const fact of input.verifiedFacts) {
        factsByType[fact.fact_type]?.push(fact);
    }
    const chiefComplaint = input.verifiedFacts.find((fact) => fact.fact_type === 'chief_complaint');
    const patientGoal = input.verifiedFacts.find((fact) => fact.fact_type === 'patient_goal');
    return BriefContentSchema.parse({
        urgency: deriveUrgency(active, input.medicationRiskFlags, input.imaging.hcq_progression),
        contradiction_alerts: active,
        why_they_are_here: chiefComplaint
            ? { fact_id: chiefComplaint.id, content: chiefComplaint.content }
            : null,
        what_they_are_hoping_for: patientGoal ? { fact_id: patientGoal.id, content: patientGoal.content } : null,
        key_discussion_points: deriveKeyDiscussionPoints(input, active),
        questions_to_confirm: dedupe(active
            .map((item) => item.suggested_question)
            .filter((question) => question !== null && question !== '')),
        medication_risk_flags: input.medicationRiskFlags,
        imaging: input.imaging,
        facts_by_type: factsByType,
        gate_metrics: input.gateMetrics,
        prepared_at: input.preparedAt,
        correlation_id: input.correlationId,
    });
}
// Deterministic urgency: critical contradictions and high imaging alerts outrank
// high contradictions/med flags; anything less is not banner-worthy.
function deriveUrgency(active, flags, hcq) {
    const critical = active.find((item) => item.severity === 'critical');
    if (critical !== undefined) {
        return { level: 'high', reason: `Critical contradiction in the record: ${critical.description}` };
    }
    if (hcq.progression_detected && hcq.alert_level === 'high') {
        return { level: 'high', reason: `Imaging alert: ${hcq.progression_description}` };
    }
    const high = active.find((item) => item.severity === 'high');
    if (high !== undefined) {
        return { level: 'moderate', reason: `Unresolved contradiction: ${high.description}` };
    }
    const highFlag = flags.find((flag) => flag.severity === 'high');
    if (highFlag !== undefined) {
        return { level: 'moderate', reason: highFlag.message };
    }
    return null;
}
// New/changed meds within this window make the discussion list even without a risk flag.
const RECENT_MED_CHANGE_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;
function deriveKeyDiscussionPoints(input, active) {
    const points = [];
    const preparedAtMs = new Date(input.preparedAt).getTime();
    for (const fact of input.verifiedFacts) {
        if (fact.fact_type !== 'medication') {
            continue;
        }
        const started = fact.content.start_date ? new Date(fact.content.start_date).getTime() : NaN;
        if (Number.isFinite(started) && preparedAtMs - started <= RECENT_MED_CHANGE_DAYS * DAY_MS) {
            points.push(`Recently started medication: ${fact.content.name}`);
        }
        if (fact.content.end_date != null && fact.content.end_date !== '') {
            points.push(`Recently stopped medication: ${fact.content.name} (ended ${fact.content.end_date})`);
        }
    }
    for (const flag of input.medicationRiskFlags) {
        if (flag.severity !== 'low') {
            points.push(flag.message);
        }
    }
    for (const item of active) {
        points.push(`Conflicting records (${item.type}): ${item.description}`);
    }
    if (input.imaging.hcq_progression.progression_detected) {
        points.push(`Imaging: ${input.imaging.hcq_progression.progression_description}`);
    }
    if (input.imaging.interval_analysis.recommendation !== '') {
        points.push(`Treatment intervals: ${input.imaging.interval_analysis.recommendation}`);
    }
    return dedupe(points);
}
function dedupe(values) {
    return [...new Set(values)];
}
//# sourceMappingURL=brief.js.map