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
];
export const SourceTypeSchema = z.enum(SOURCE_TYPES);
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
];
export const SpeakerRoleSchema = z.enum(SPEAKER_ROLES);
export const AttributionSchema = z.object({
    speaker_role: SpeakerRoleSchema,
    speaker_name: z.string().nullable().optional(),
    speaker_relationship: z.string().nullable().optional(),
    confidence: z.number().min(0).max(1).optional(),
});
// Character-range excerpt location (findExcerptLocation output, citationHelpers.jsx:170-176).
export const ExcerptLocationSchema = z.object({
    type: z.literal('character_range'),
    start_char: z.number().int().min(0),
    end_char: z.number().int().min(0),
    context_before: z.string().nullable(),
    context_after: z.string().nullable(),
});
export const CitationRefSchema = z.object({
    id: z.string().min(1),
    fact_id: z.string().nullable().optional(),
    source_label: z.string(),
    source_type: SourceTypeSchema,
    excerpt_text: z.string().nullable(),
    excerpt_location: ExcerptLocationSchema.nullable(),
    attribution: AttributionSchema.nullable(),
    source_document_id: z.string().nullable(),
    document_date: z.string().nullable(), // ISO date string; crosses JSON boundaries
    deep_link_url: z.string().nullable().optional(), // absent in seed corpus; panel derives links at render
});
//# sourceMappingURL=citations.js.map