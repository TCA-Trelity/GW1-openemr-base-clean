// CitationRef schema — verbatim port of the citation shape built by the second-opinion
// prototype's citationHelpers.jsx:91-152 (buildCitationsFromSources / buildCitation) and
// findExcerptLocation:158-177 (character_range locations); roles from getAttributionDisplayText.
import { z } from 'zod';

// The 11 source types, from citationHelpers.jsx:8-20 (typeLabels).
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
export const SourceTypeSchema = z.enum(SOURCE_TYPES);
export type SourceType = z.infer<typeof SourceTypeSchema>;

// Speaker roles from citationHelpers.jsx:198-207 (roleLabels).
export const SPEAKER_ROLES = [
    'patient',
    'family_member',
    'physician',
    'nurse',
    'technician',
    'pharmacist',
    'external_provider',
    'system',
] as const;
export const SpeakerRoleSchema = z.enum(SPEAKER_ROLES);
export type SpeakerRole = z.infer<typeof SpeakerRoleSchema>;

export const AttributionSchema = z.object({
    speaker_role: SpeakerRoleSchema,
    speaker_name: z.string().nullable().optional(),
    speaker_relationship: z.string().nullable().optional(),
    confidence: z.number().min(0).max(1).optional(),
});
export type Attribution = z.infer<typeof AttributionSchema>;

// Character-range excerpt location (findExcerptLocation output, citationHelpers.jsx:170-176).
export const ExcerptLocationSchema = z.object({
    type: z.literal('character_range'),
    start_char: z.number().int().min(0),
    end_char: z.number().int().min(0),
    // Omittable by extraction (Haiku drops null keys in minified JSON); the panel derives
    // context from the stored document text + range, so absence costs nothing.
    context_before: z.string().nullable().default(null),
    context_after: z.string().nullable().default(null),
});
export type ExcerptLocation = z.infer<typeof ExcerptLocationSchema>;

export const CitationRefSchema = z.object({
    id: z.string().min(1),
    fact_id: z.string().nullable().optional(),
    source_label: z.string(),
    source_type: SourceTypeSchema,
    // null ≡ absent for every nullable field at the extraction boundary (the parser strips
    // model-emitted nulls before validation), so nullable fields must also accept omission.
    excerpt_text: z.string().nullable().default(null),
    excerpt_location: ExcerptLocationSchema.nullable().default(null),
    attribution: AttributionSchema.nullable().default(null),
    source_document_id: z.string().nullable().default(null),
    document_date: z.string().nullable().default(null), // ISO date string; crosses JSON boundaries
    deep_link_url: z.string().nullable().optional(), // absent in seed corpus; panel derives links at render
});
export type CitationRef = z.infer<typeof CitationRefSchema>;
