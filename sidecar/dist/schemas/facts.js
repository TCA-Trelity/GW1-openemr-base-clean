// PatientFact schema — verbatim port of the prototype's fact entity (PRD §6.2 / port
// manifest §2): fact types and content shapes observed in second-opinion factExtraction.jsx,
// providerNoteService.jsx:323-430, and consultContextService.jsx:265-312.
import { z } from 'zod';
import { CitationRefSchema } from './citations.js';
// Fact-level laterality is uppercase OD|OS|OU (see prototype timeline.jsx facts);
// imaging metadata uses lowercase od|os — that enum lives in imaging.ts.
export const FactLateralitySchema = z.enum(['OD', 'OS', 'OU']);
// The 11 fact types (manifest §2; mirrored by permissions.jsx verification tiers).
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
];
export const FactTypeSchema = z.enum(FACT_TYPES);
export const VerificationStatusSchema = z.enum(['unverified', 'verified', 'disputed', 'patient_reported']);
// Field names per manifest/PRD. The prototype stored verified_by / verification_note
// (verificationService.jsx:72-91) and also used transient statuses pending_review /
// ai_suggested; those collapse to 'unverified' in the sidecar.
export const FactVerificationSchema = z.object({
    status: VerificationStatusSchema.default('unverified'),
    verified_by_user_id: z.string().nullable().optional(),
    verified_at: z.string().nullable().optional(), // ISO datetime
    verifier_role: z.string().nullable().optional(),
});
// ---- Per-fact-type content shapes (manifest §6.10, checked against prototype writers) ----
export const MedicationContentSchema = z.object({
    name: z.string().min(1),
    generic_name: z.string().optional(),
    dose: z.string().optional(),
    frequency: z.string().optional(),
    route: z.string().optional(),
    start_date: z.string().nullable().optional(),
    end_date: z.string().nullable().optional(),
    prescriber: z.string().nullable().optional(),
    indication: z.string().optional(),
    risk_flags: z.array(z.string()).optional(),
});
export const AllergyContentSchema = z.object({
    substance: z.string().min(1),
    reaction: z.string().optional(),
    severity: z.string().optional(),
    verified: z.boolean().optional(),
    source: z.string().optional(),
});
export const ConditionContentSchema = z.object({
    name: z.string().min(1),
    icd10: z.string().optional(),
    status: z.enum(['active', 'controlled', 'resolved']).optional(),
    since: z.string().optional(),
    severity: z.string().optional(),
});
export const VitalSignContentSchema = z.object({
    name: z.enum(['IOP', 'VA', 'CRT', 'BP', 'HR']),
    value: z.union([z.number(), z.string()]), // VA is a string ("20/25"); IOP/CRT numeric
    units: z.string().optional(),
    laterality: FactLateralitySchema.nullable().optional(),
    captured_at: z.string().optional(),
});
export const ImagingFindingContentSchema = z.object({
    finding_type: z.string().min(1),
    severity: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
    measurements: z.record(z.unknown()).optional(),
    laterality: FactLateralitySchema.nullable().optional(),
    source_image_id: z.string().optional(),
});
export const ClinicalFindingContentSchema = z.object({
    finding: z.string().min(1),
    body_part: z.string().optional(),
    laterality: FactLateralitySchema.nullable().optional(),
    severity: z.string().optional(),
    source: z.string().optional(),
});
export const FamilyHistoryContentSchema = z.object({
    relative: z.string().min(1),
    condition: z.string().min(1),
    age_at_diagnosis: z.union([z.number(), z.string()]).nullable().optional(),
    outcome: z.string().optional(),
});
// category is an open set in the prototype (caregiver | occupation | tobacco | alcohol | ...).
export const SocialHistoryContentSchema = z.object({
    category: z.string().min(1),
    value: z.string(),
    notes: z.string().optional(),
});
// From providerNoteService.jsx:371-378 (extractFactsFromNote) — not in manifest §6.10.
export const ProcedureHistoryContentSchema = z.object({
    procedure: z.string().min(1),
    cpt: z.string().optional(),
    laterality: FactLateralitySchema.nullable().optional(),
    date: z.string().optional(),
    performed_by: z.string().optional(),
    notes: z.string().optional(),
});
// Corpus shape (sidecar/seed, consistent across both patients) — supersedes the
// factExtraction.jsx field names; reconciled 2026-07-08 (see DECISIONS.md).
export const PatientGoalContentSchema = z
    .object({
    goal: z.string().min(1),
    specific_concerns: z.array(z.string()).optional(),
    verbatim_quotes: z.array(z.string()).optional(),
    emotional_state: z.string().optional(),
})
    .passthrough();
// Corpus shape (sidecar/seed) — supersedes factExtraction.jsx names; see DECISIONS.md.
export const ChiefComplaintContentSchema = z
    .object({
    statement: z.string().min(1),
    onset: z.string().optional(),
    onset_context: z.string().optional(),
    laterality: z.string().optional(),
    progression: z.string().optional(),
    pertinent_negatives: z.array(z.string()).optional(),
})
    .passthrough();
// ---- The fact entity ----
const factBase = {
    id: z.string().min(1),
    patient_id: z.string().min(1),
    is_current: z.boolean().default(true),
    source_document_id: z.string().min(1), // required per manifest §2
    sources: z.array(CitationRefSchema).default([]),
    verification: FactVerificationSchema.default({}),
    laterality: FactLateralitySchema.nullable().default(null),
    created_date: z.string().optional(),
    updated_date: z.string().optional(),
};
export const PatientFactSchema = z.discriminatedUnion('fact_type', [
    z.object({ ...factBase, fact_type: z.literal('medication'), content: MedicationContentSchema }),
    z.object({ ...factBase, fact_type: z.literal('allergy'), content: AllergyContentSchema }),
    z.object({ ...factBase, fact_type: z.literal('condition'), content: ConditionContentSchema }),
    z.object({ ...factBase, fact_type: z.literal('clinical_finding'), content: ClinicalFindingContentSchema }),
    z.object({ ...factBase, fact_type: z.literal('imaging_finding'), content: ImagingFindingContentSchema }),
    z.object({ ...factBase, fact_type: z.literal('procedure_history'), content: ProcedureHistoryContentSchema }),
    z.object({ ...factBase, fact_type: z.literal('vital_sign'), content: VitalSignContentSchema }),
    z.object({ ...factBase, fact_type: z.literal('social_history'), content: SocialHistoryContentSchema }),
    z.object({ ...factBase, fact_type: z.literal('family_history'), content: FamilyHistoryContentSchema }),
    z.object({ ...factBase, fact_type: z.literal('patient_goal'), content: PatientGoalContentSchema }),
    z.object({ ...factBase, fact_type: z.literal('chief_complaint'), content: ChiefComplaintContentSchema }),
]);
//# sourceMappingURL=facts.js.map