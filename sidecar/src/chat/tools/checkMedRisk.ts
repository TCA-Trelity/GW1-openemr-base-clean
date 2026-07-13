// check_med_risk (TC1): run the deterministic medication-risk engine over the patient's
// medication facts, optionally narrowed to one named medication. Derived: every flag is
// produced by computeMedicationRiskFlags (carrying its own guideline `source`), never
// fabricated — so no source-text provenance. A name matching no medication -> { error }.
import { z } from 'zod';
import { calculateMedicationDurationYears, computeMedicationRiskFlags, type MedicationInput, type MedRiskClinicalContext } from '../../engines/index.js';
import { LabResultContentSchema, MedicationContentSchema } from '../../schemas/index.js';
import type { FactBundle } from '../../store/index.js';
import { defineTool } from './types.js';

const InputSchema = z.object({ medication_name: z.string().min(1).optional() });
type Input = z.infer<typeof InputSchema>;

const RiskFlagSchema = z.object({
    medication: z.string(),
    flag_type: z.enum(['retinal_toxicity', 'bleeding_risk', 'iop_risk', 'ifis_risk', 'diabetic_screening', 'custom_priority']),
    severity: z.enum(['high', 'medium', 'low']),
    message: z.string(),
    recommendation: z.string(),
    source: z.string(),
    details: z
        .object({ duration_years: z.number(), cumulative_dose_grams: z.number(), daily_dose_mg: z.number(), egfr: z.number().optional() })
        .optional(),
    relevance_boost: z.number().optional(),
});

const SuccessSchema = z.object({
    medication_filter: z.string().nullable(),
    medications_checked: z.number().int(),
    flags: z.array(RiskFlagSchema),
    derived: z.literal(true),
});
export const checkMedRiskOutputSchema = z.union([SuccessSchema, z.object({ error: z.string() })]);
type Output = z.infer<typeof checkMedRiskOutputSchema>;

// A medication fact's content -> the engine's MedicationInput (name + dose). Duration lives
// in start_date on facts, which computeMedicationRiskFlags does not read, so it is left off.
function medicationInputsOf(bundle: FactBundle, nameFilter: string | undefined): MedicationInput[] {
    const filterLower = nameFilter?.toLowerCase();
    return bundle.facts.flatMap((fact) => {
        if (fact.fact_type !== 'medication') {
            return [];
        }
        const parsed = MedicationContentSchema.safeParse(fact.content);
        if (!parsed.success) {
            return [];
        }
        if (filterLower !== undefined && !parsed.data.name.toLowerCase().includes(filterLower)) {
            return [];
        }
        // Week 2 (A.6): bridge start_date -> the duration string the engine reads, so the
        // cumulative-dose tiers actually fire from chart facts (they carry start_date).
        const med: MedicationInput = { content: { name: parsed.data.name, dose: parsed.data.dose } };
        if (parsed.data.start_date != null && parsed.data.start_date !== '') {
            const years = calculateMedicationDurationYears({ start_date: parsed.data.start_date }, new Date());
            if (years !== null && years > 0 && med.content !== undefined) {
                med.content.duration = `${years} years`;
            }
        }
        return [med];
    });
}

// Week 2 (A.6): most recent extracted eGFR feeds the engine's renal escalation — the
// uploaded renal panel re-tiers HCQ risk through this exact path (the hero arc, UC-4).
export function renalContextOf(bundle: FactBundle): MedRiskClinicalContext {
    let best: { egfr: number; collected_date: string | null } | undefined;
    for (const fact of bundle.facts) {
        if (fact.fact_type !== 'lab_result') {
            continue;
        }
        const parsed = LabResultContentSchema.safeParse(fact.content);
        if (!parsed.success || !/egfr/i.test(parsed.data.test_name)) {
            continue;
        }
        const value = parsed.data.value_numeric ?? Number.parseFloat(parsed.data.value);
        if (!Number.isFinite(value)) {
            continue;
        }
        const collected = parsed.data.collection_date;
        if (best === undefined || (collected ?? '') > (best.collected_date ?? '')) {
            best = { egfr: value, collected_date: collected };
        }
    }
    return best === undefined ? {} : { renal: best };
}

export const checkMedRisk = defineTool<Input, Output>({
    name: 'check_med_risk',
    description:
        "Run the medication-risk engine over THIS patient's medications and return the risk flags " +
        '(retinal toxicity, bleeding, IOP, IFIS, diabetic screening). Optionally narrow to one medication by name.',
    inputSchema: InputSchema,
    outputSchema: checkMedRiskOutputSchema,
    inputJsonSchema: {
        type: 'object',
        properties: {
            medication_name: { type: 'string', description: 'Optional: check only medications whose name contains this.' },
        },
        additionalProperties: false,
    },
    run(bundle, input) {
        const medications = medicationInputsOf(bundle, input.medication_name);
        if (input.medication_name !== undefined && medications.length === 0) {
            return { error: `no medication matching "${input.medication_name}" in this patient's record` };
        }
        return {
            medication_filter: input.medication_name ?? null,
            medications_checked: medications.length,
            flags: computeMedicationRiskFlags(medications, {}, renalContextOf(bundle)),
            derived: true,
        };
    },
});
