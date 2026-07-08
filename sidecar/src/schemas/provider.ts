// ProviderProfile schema — verbatim port of the prototype's DEFAULT_PROFILE personalization
// branches (second-opinion ProviderContext.jsx:32-60): risk_sensitivity thresholds and
// relevance_configuration fact-type weights, with the exact numeric defaults.
import { z } from 'zod';

export const AlertThresholdSchema = z.enum(['standard', 'cautious', 'aggressive']);
export type AlertThreshold = z.infer<typeof AlertThresholdSchema>;

// Read by isAlertSuppressed (ProviderContext.jsx:248-252); reason per manifest §2.
export const SuppressedAlertSchema = z.object({
    alert_type: z.string().min(1),
    reason: z.string().optional(),
});
export type SuppressedAlert = z.infer<typeof SuppressedAlertSchema>;

// Exact defaults from ProviderContext.jsx:51-59. The pure engines take these as input
// (e.g. hcq_high_risk_years gates medicationRiskFlags severity).
export const RiskThresholdsSchema = z.object({
    hcq_high_risk_years: z.number().default(5),
    treatment_interval_warning_weeks: z.number().default(10),
    stale_verification_days: z.number().default(180),
    iop_warning_threshold: z.number().default(21),
    iop_critical_threshold: z.number().default(30),
    crt_change_warning_microns: z.number().default(50),
    va_change_warning_lines: z.number().default(2),
});
export type RiskThresholds = z.infer<typeof RiskThresholdsSchema>;

export const RiskSensitivitySchema = z.object({
    alert_threshold: AlertThresholdSchema.default('standard'),
    suppressed_alerts: z.array(SuppressedAlertSchema).default([]),
    custom_alert_rules: z.array(z.unknown()).default([]),
    thresholds: RiskThresholdsSchema.default({}),
});
export type RiskSensitivity = z.infer<typeof RiskSensitivitySchema>;

// Exact defaults from ProviderContext.jsx:35-44. getFactTypeWeight falls back to 0.5
// for fact types not listed (patient_goal, chief_complaint, clinical_finding).
export const FactTypeWeightsSchema = z.object({
    medication: z.number().default(0.8),
    allergy: z.number().default(1.0),
    condition: z.number().default(0.8),
    procedure_history: z.number().default(0.7),
    family_history: z.number().default(0.5),
    social_history: z.number().default(0.4),
    imaging_finding: z.number().default(0.7),
    vital_sign: z.number().default(0.5),
});
export type FactTypeWeights = z.infer<typeof FactTypeWeightsSchema>;

// Entry shapes read by getRelevanceBoost (ProviderContext.jsx:215-241).
export const HighPriorityMedicationSchema = z.object({
    pattern: z.string().min(1), // regex, matched case-insensitively against medication name
    relevance_boost: z.number(),
});
export type HighPriorityMedication = z.infer<typeof HighPriorityMedicationSchema>;

export const PrimaryConditionSchema = z.object({
    condition: z.string().min(1), // snake_cased condition name substring
    relevance_boost: z.number(),
});
export type PrimaryCondition = z.infer<typeof PrimaryConditionSchema>;

export const RelevanceConfigurationSchema = z.object({
    high_priority_medications: z.array(HighPriorityMedicationSchema).default([]),
    primary_conditions: z.array(PrimaryConditionSchema).default([]),
    fact_type_weights: FactTypeWeightsSchema.default({}),
    relevance_keywords: z.array(z.string()).default([]),
});
export type RelevanceConfiguration = z.infer<typeof RelevanceConfigurationSchema>;

export const ProviderProfileSchema = z.object({
    id: z.string().default('default'),
    risk_sensitivity: RiskSensitivitySchema.default({}),
    relevance_configuration: RelevanceConfigurationSchema.default({}),
});
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;

// Fully-defaulted profile — equals the prototype's DEFAULT_PROFILE for these branches.
export const DEFAULT_PROVIDER_PROFILE: ProviderProfile = ProviderProfileSchema.parse({});
