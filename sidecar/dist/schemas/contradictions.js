// Contradiction schemas — verbatim port of the prototype's rich synthetic shape
// (second-opinion margaret-chen/index.jsx:120-300) plus the runtime entity it projects to
// (contradictionDetection.jsx:519-547 persistContradictions), with the projection helper.
import { z } from 'zod';
export const ContradictionSeveritySchema = z.enum(['critical', 'high', 'moderate', 'low']);
export const ClaimCertaintySchema = z.enum(['definitive', 'hedged', 'uncertain', 'patient_reported']);
export const ContradictionSourceDocumentSchema = z.object({
    filename: z.string().min(1),
    claim: z.string(),
    exact_text: z.string(),
    certainty: ClaimCertaintySchema,
});
export const GroundTruthSchema = z.object({
    accurate_value: z.string(),
    source: z.string(),
    rationale: z.string(),
});
export const DetectionStrategySchema = z.object({
    method: z.string(),
    keywords: z.array(z.string()),
    expected_automation: z.boolean(),
    detection_difficulty: z.enum(['easy', 'moderate', 'hard']),
});
export const ClinicalImpactSchema = z.object({
    affects_care: z.boolean(),
    urgency_level: ContradictionSeveritySchema,
    explanation: z.string(),
    recommended_action: z.string(),
});
export const PhysicianWorkflowSchema = z.object({
    surface_in_briefing: z.boolean(),
    auto_generate_question: z.string().nullable(),
    suggested_briefing_language: z.string().nullable(),
    note: z.string().optional(),
});
// The rich shape (b) — ground truth for seeding and evals.
export const ContradictionSchema = z.object({
    contradiction_id: z.string().min(1),
    type: z.string().min(1), // e.g. temporal_discrepancy, allergy_discrepancy
    category: z.string().min(1), // e.g. medication_duration, drug_allergy
    severity: ContradictionSeveritySchema,
    clinical_significance: z.string(),
    source_documents: z.array(ContradictionSourceDocumentSchema).min(1),
    ground_truth: GroundTruthSchema,
    detection_strategy: DetectionStrategySchema,
    clinical_impact: ClinicalImpactSchema,
    physician_workflow: PhysicianWorkflowSchema,
});
// ---- Runtime projection (a) — the lossy entity the prototype persisted ----
export const RuntimeContradictionSourceSchema = z.object({
    type: z.string(), // source_type-ish label ('intake_transcript', 'pharmacy_record', ...)
    value: z.string(),
    timestamp: z.string().nullable().optional(),
    document_id: z.string().nullable().optional(),
    excerpt: z.string().nullable().optional(),
});
// Severity superset: the rich shape uses 'moderate' while the runtime detector emits
// 'medium' (contradictionDetection.jsx:198) — accept both rather than reject real data.
export const RuntimeContradictionSeveritySchema = z.enum(['critical', 'high', 'medium', 'moderate', 'low']);
export const RuntimeContradictionSchema = z.object({
    id: z.string().min(1),
    patient_id: z.string().min(1),
    status: z.enum(['active', 'resolved']).default('active'),
    severity: RuntimeContradictionSeveritySchema,
    type: z.string().min(1),
    description: z.string(),
    suggested_question: z.string().nullable(),
    source_a: RuntimeContradictionSourceSchema.nullable(),
    source_b: RuntimeContradictionSourceSchema.nullable(),
    clinical_implication: z.string().optional(),
    detection_method: z.string().default('rule_based'),
    confidence: z.number().min(0).max(1).optional(),
});
// Derive the runtime entity (a) from the rich shape (b). Lossy: only the first two
// source documents survive, and ground_truth / detection_strategy are dropped.
export function projectContradiction(rich, opts) {
    const toRuntimeSource = (doc) => ({
        type: 'source_document',
        value: doc.claim,
        document_id: doc.filename,
        excerpt: doc.exact_text,
        timestamp: null,
    });
    const [a, b] = rich.source_documents;
    return RuntimeContradictionSchema.parse({
        id: opts.id,
        patient_id: opts.patientId,
        status: opts.status ?? 'active',
        severity: rich.severity,
        type: rich.type,
        description: rich.clinical_significance,
        suggested_question: rich.physician_workflow.auto_generate_question,
        source_a: a ? toRuntimeSource(a) : null,
        source_b: b ? toRuntimeSource(b) : null,
        clinical_implication: rich.clinical_impact.explanation,
        detection_method: rich.detection_strategy.method,
    });
}
//# sourceMappingURL=contradictions.js.map