// Brief assembly (S1.7): the Overview IA from the port manifest §4 as DATA, not markup.
// BriefContentSchema is the contract the React panel consumes; deterministic derivations
// only — no second LLM call at Tier 1 (key points come from verified facts + engine output).
import { z } from 'zod';
import {
    ChiefComplaintContentSchema,
    FACT_TYPES,
    PatientFactSchema,
    PatientGoalContentSchema,
    RuntimeContradictionSchema,
    TreatmentContextSchema,
    type PatientFact,
    type RuntimeContradiction,
} from '../schemas/index.js';
import type {
    HcqProgressionAnalysis,
    IntervalPatternAnalysis,
    MedicationRiskFlag,
} from '../engines/index.js';
import type { GateResult } from '../gate/citationGate.js';

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
    intervals: z.array(
        z.object({
            interval_weeks: z.number(),
            outcome: z.enum(['good_response', 'worsened', 'no_response', 'partial_response']),
            image_date: z.string().optional(),
            treatment_date: z.string(),
            medication: z.string().optional(),
        }),
    ),
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
    gc_thickness_trend: z.array(
        z.object({ date: z.string().optional(), value: z.number(), image_id: z.string().optional() }),
    ),
    rpe_changes_trend: z.array(
        z.object({
            date: z.string().optional(),
            severity: z.enum(['mild', 'moderate', 'severe']).optional(),
            confidence: z.number().optional(),
            image_id: z.string().optional(),
        }),
    ),
    progression_detected: z.boolean(),
    progression_description: z.string(),
    alert_level: z.enum(['low', 'medium', 'high']),
    recommendation: z.string(),
});

// Compile-time proof the engine outputs satisfy the mirrored schemas.
type Satisfies<T extends U, U> = T;
type _FlagFits = Satisfies<MedicationRiskFlag, z.infer<typeof MedicationRiskFlagSchema>>;
type _IntervalFits = Satisfies<IntervalPatternAnalysis, z.infer<typeof IntervalPatternAnalysisSchema>>;
type _HcqFits = Satisfies<HcqProgressionAnalysis, z.infer<typeof HcqProgressionAnalysisSchema>>;

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
type _GateMetricsFit = Satisfies<GateResult['metrics'], z.infer<typeof GateMetricsSchema>>;

const factsByTypeShape = Object.fromEntries(
    FACT_TYPES.map((type) => [type, z.array(PatientFactSchema).default([])]),
) as Record<(typeof FACT_TYPES)[number], z.ZodDefault<z.ZodArray<typeof PatientFactSchema>>>;

// Discussion points are structured items (R4/R5): terse one-line text a physician reads
// in seconds, plus refs the panel renders as citation chips (fact ids resolve against
// facts_by_type; contradiction ids link to the alert card carrying the full detail).
// Q3 game plan: the visit's who-does-what, composed by ONE bounded Haiku call over the
// already-gated brief content (prep/gamePlan.ts). A read-only PROPOSAL — never a gate:
// composition failure stores null and the brief completes without it.
export const GamePlanItemSchema = z.object({
    owner: z.enum(['physician', 'nurse', 'front_desk', 'patient']),
    action: z.string().min(3).max(160),
    timing: z.string().max(60).nullable().default(null),
    kind: z.enum(['order', 'check_in', 'form', 'call_back', 'prescription', 'monitoring', 'education']),
});
export const GamePlanSchema = z.object({
    summary_line: z.string().min(3).max(200),
    items: z.array(GamePlanItemSchema).min(2).max(8),
});
export type GamePlan = z.infer<typeof GamePlanSchema>;

export const DiscussionPointSchema = z.object({
    text: z.string(),
    kind: z.enum(['med_change', 'risk_flag', 'contradiction', 'imaging', 'interval']),
    fact_ids: z.array(z.string()).default([]),
    contradiction_id: z.string().nullable().default(null),
});
export type DiscussionPoint = z.infer<typeof DiscussionPointSchema>;

export const BriefContentSchema = z.object({
    urgency: z.object({ level: z.enum(['high', 'moderate']), reason: z.string() }).nullable(),
    contradiction_alerts: z.array(RuntimeContradictionSchema),
    why_they_are_here: z.object({ fact_id: z.string(), content: ChiefComplaintContentSchema }).nullable(),
    what_they_are_hoping_for: z.object({ fact_id: z.string(), content: PatientGoalContentSchema }).nullable(),
    key_discussion_points: z.array(DiscussionPointSchema),
    questions_to_confirm: z.array(z.string()),
    medication_risk_flags: z.array(MedicationRiskFlagSchema),
    imaging: z.object({
        timeline_summary: z.array(ImagingTimelineEntrySchema),
        interval_analysis: IntervalPatternAnalysisSchema,
        hcq_progression: HcqProgressionAnalysisSchema,
    }),
    facts_by_type: z.object(factsByTypeShape),
    gate_metrics: GateMetricsSchema,
    /** Q3: attached by the pipeline after assembly; null when composition failed or is off. */
    game_plan: GamePlanSchema.nullable().default(null),
    prepared_at: z.string(),
    correlation_id: z.string(),
});
export type BriefContent = z.infer<typeof BriefContentSchema>;

// ---- Assembly ----

export interface BriefAssemblyInput {
    verifiedFacts: PatientFact[];
    contradictions: RuntimeContradiction[];
    medicationRiskFlags: MedicationRiskFlag[];
    imaging: {
        timeline_summary: z.infer<typeof ImagingTimelineEntrySchema>[];
        interval_analysis: IntervalPatternAnalysis;
        hcq_progression: HcqProgressionAnalysis;
    };
    gateMetrics: GateResult['metrics'];
    preparedAt: string;
    correlationId: string;
}

export function assembleBrief(input: BriefAssemblyInput): BriefContent {
    const active = input.contradictions.filter((item) => item.status === 'active');
    const factsByType = Object.fromEntries(FACT_TYPES.map((type) => [type, [] as PatientFact[]]));
    for (const fact of input.verifiedFacts) {
        factsByType[fact.fact_type]?.push(fact);
    }
    const chiefComplaint = input.verifiedFacts.find(
        (fact): fact is Extract<PatientFact, { fact_type: 'chief_complaint' }> => fact.fact_type === 'chief_complaint',
    );
    const patientGoal = input.verifiedFacts.find(
        (fact): fact is Extract<PatientFact, { fact_type: 'patient_goal' }> => fact.fact_type === 'patient_goal',
    );

    return BriefContentSchema.parse({
        urgency: deriveUrgency(active, input.medicationRiskFlags, input.imaging.hcq_progression),
        contradiction_alerts: active,
        why_they_are_here: chiefComplaint
            ? { fact_id: chiefComplaint.id, content: chiefComplaint.content }
            : null,
        what_they_are_hoping_for: patientGoal ? { fact_id: patientGoal.id, content: patientGoal.content } : null,
        key_discussion_points: deriveKeyDiscussionPoints(input, active),
        questions_to_confirm: dedupe(
            active
                .map((item) => item.suggested_question)
                .filter((question): question is string => question !== null && question !== ''),
        ),
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
function deriveUrgency(
    active: RuntimeContradiction[],
    flags: MedicationRiskFlag[],
    hcq: HcqProgressionAnalysis,
): { level: 'high' | 'moderate'; reason: string } | null {
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

function deriveKeyDiscussionPoints(input: BriefAssemblyInput, active: RuntimeContradiction[]): DiscussionPoint[] {
    const points: DiscussionPoint[] = [];
    const preparedAtMs = new Date(input.preparedAt).getTime();
    const medFacts = input.verifiedFacts.filter(
        (fact): fact is Extract<PatientFact, { fact_type: 'medication' }> => fact.fact_type === 'medication',
    );
    for (const fact of medFacts) {
        const started = fact.content.start_date ? new Date(fact.content.start_date).getTime() : NaN;
        if (Number.isFinite(started) && preparedAtMs - started <= RECENT_MED_CHANGE_DAYS * DAY_MS) {
            points.push({ text: `Started: ${fact.content.name}`, kind: 'med_change', fact_ids: [fact.id], contradiction_id: null });
        }
        if (fact.content.end_date != null && fact.content.end_date !== '') {
            points.push({
                text: `Stopped: ${fact.content.name} (${fact.content.end_date})`,
                kind: 'med_change',
                fact_ids: [fact.id],
                contradiction_id: null,
            });
        }
    }
    for (const flag of input.medicationRiskFlags) {
        if (flag.severity === 'low') {
            continue;
        }
        // Terse rebuild instead of the engine's full message — the flag card carries detail.
        const medFact = medFacts.find((fact) =>
            fact.content.name.toLowerCase().includes(flag.medication.toLowerCase().split(' ')[0] ?? ''),
        );
        points.push({
            text: `${flag.medication}: ${flag.severity.toUpperCase()} ${flagTypeLabel(flag.flag_type)}`,
            kind: 'risk_flag',
            fact_ids: medFact === undefined ? [] : [medFact.id],
            contradiction_id: null,
        });
    }
    for (const item of active) {
        // The clause before the first colon is the authored one-line summary; the alert
        // card (linked by contradiction_id) holds the full description + both sources.
        points.push({
            text: terse(item.description.split(':')[0] ?? item.description),
            kind: 'contradiction',
            fact_ids: [],
            contradiction_id: item.id,
        });
    }
    if (input.imaging.hcq_progression.progression_detected) {
        points.push({
            text: terse(input.imaging.hcq_progression.progression_description),
            kind: 'imaging',
            fact_ids: [],
            contradiction_id: null,
        });
    }
    if (input.imaging.interval_analysis.recommendation !== '') {
        points.push({
            text: terse(input.imaging.interval_analysis.recommendation),
            kind: 'interval',
            fact_ids: [],
            contradiction_id: null,
        });
    }
    const seen = new Set<string>();
    return points.filter((point) => (seen.has(point.text) ? false : (seen.add(point.text), true)));
}

function flagTypeLabel(flagType: MedicationRiskFlag['flag_type']): string {
    return flagType.replace(/_/g, ' ') + ' risk';
}

// Physicians read this in seconds: first sentence only, hard-capped.
const TERSE_MAX_CHARS = 90;
function terse(value: string): string {
    const firstSentence = value.split(/\.\s/)[0] ?? value;
    const trimmed = firstSentence.trim().replace(/\.$/, '');
    return trimmed.length <= TERSE_MAX_CHARS ? trimmed : `${trimmed.slice(0, TERSE_MAX_CHARS - 1).trimEnd()}…`;
}

function dedupe(values: string[]): string[] {
    return [...new Set(values)];
}
