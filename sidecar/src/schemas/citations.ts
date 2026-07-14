// CitationRef schema — verbatim port of the citation shape built by the second-opinion
// prototype's citationHelpers.jsx:91-152 (buildCitationsFromSources / buildCitation) and
// findExcerptLocation:158-177 (character_range locations); roles from getAttributionDisplayText.
//
// v2 (Week 2, REQ R5 — see docs/w2/migration-notes.md #1): adds the 'guideline_evidence'
// source type (practice-protocol corpus chunks; the grounding split keeps patient-record
// and guideline provenance distinct by schema), page/page_bbox excerpt locations for
// document-extraction citations, the spec's `page_or_section` + `field_or_chunk_id`
// fields, and `toSpecCitation` — the exporter for the assignment's minimum machine-
// readable shape {source_type, source_id, page_or_section, field_or_chunk_id,
// quote_or_value}. All additions are optional/defaulted: every stored Week 1 citation
// still parses unchanged.
import { z } from 'zod';

// The 11 Week 1 source types from citationHelpers.jsx:8-20 (typeLabels), plus
// 'guideline_evidence' (v2): a retrieved practice-protocol chunk — never patient data.
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
export const CharacterRangeLocationSchema = z.object({
    type: z.literal('character_range'),
    start_char: z.number().int().min(0),
    end_char: z.number().int().min(0),
    // Omittable by extraction (Haiku drops null keys in minified JSON); the panel derives
    // context from the stored document text + range, so absence costs nothing.
    context_before: z.string().nullable().default(null),
    context_after: z.string().nullable().default(null),
});
export type CharacterRangeLocation = z.infer<typeof CharacterRangeLocationSchema>;

// v2 — geometric grounding outcomes for document extraction (REQ R5). Coordinates are
// normalized [0,1] with origin at the page's top-left, so the overlay renders at any
// zoom without knowing the source DPI. `page_bbox` is the word-box grounding hit;
// bare `page` is the deterministic fallback when the value was found on the page but
// tight word geometry was not (page-region highlight, still click-to-source).
export const PageBboxLocationSchema = z.object({
    type: z.literal('page_bbox'),
    page: z.number().int().min(1),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().min(0).max(1),
    h: z.number().min(0).max(1),
});
export type PageBboxLocation = z.infer<typeof PageBboxLocationSchema>;

export const PageLocationSchema = z.object({
    type: z.literal('page'),
    page: z.number().int().min(1),
});
export type PageLocation = z.infer<typeof PageLocationSchema>;

// v2: the location is a discriminated union. Week 1 producers (prep extraction, ehrSync)
// keep emitting character_range unchanged; readers narrow on `type` (the citation gate's
// verbatim-search path already covers non-range locations, since a quote is verified
// against stored text regardless of where the overlay points).
export const ExcerptLocationSchema = z.discriminatedUnion('type', [
    CharacterRangeLocationSchema,
    PageBboxLocationSchema,
    PageLocationSchema,
]);
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
    // v2 (REQ R5) — spec minimum-shape fields. `page_or_section` is a human-readable
    // locator ("page 2", "§ Monitoring intervals"); `field_or_chunk_id` is the machine
    // locator (extraction field path like `results[3].value`, or a corpus chunk id like
    // `hcq-screening#risk-factors`). Both defaulted so Week 1 citations parse unchanged.
    page_or_section: z.string().nullable().default(null),
    field_or_chunk_id: z.string().nullable().default(null),
});
export type CitationRef = z.infer<typeof CitationRefSchema>;

// The assignment's minimum machine-readable citation shape (REQ R5, verbatim field
// names). Internally the richer CitationRef is the single stored shape — this exporter
// projects it for the wire/eval layer instead of duplicating fields in storage (G1: one
// source of truth). Mapping documented in docs/w2/migration-notes.md #1:
//   source_id      ≡ source_document_id (or the citation id when no document binding)
//   quote_or_value ≡ excerpt_text
//   page_or_section falls back to a rendering of the excerpt_location when unset.
export interface SpecCitation {
    source_type: SourceType;
    source_id: string;
    page_or_section: string | null;
    field_or_chunk_id: string | null;
    quote_or_value: string | null;
}

export function toSpecCitation(ref: CitationRef): SpecCitation {
    let pageOrSection = ref.page_or_section;
    if (pageOrSection === null && ref.excerpt_location !== null) {
        const loc = ref.excerpt_location;
        pageOrSection =
            loc.type === 'character_range'
                ? `chars ${loc.start_char}–${loc.end_char}`
                : `page ${loc.page}`;
    }
    return {
        source_type: ref.source_type,
        source_id: ref.source_document_id ?? ref.id,
        page_or_section: pageOrSection,
        field_or_chunk_id: ref.field_or_chunk_id,
        quote_or_value: ref.excerpt_text,
    };
}
