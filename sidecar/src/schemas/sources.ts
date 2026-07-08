// SourceDocument schema — verbatim port of the Margaret Chen corpus document shape
// (second-opinion margaret-chen/sourceData.jsx:7-178 et al., loaders/loadPatientSources.jsx
// convertToSourceDocuments). intentional_issues is demo/eval-only and rejected here;
// use SeedSourceDocumentSchema for seed/eval fixtures.
import { z } from 'zod';

// The 11 document types actually used by the prototype corpus + processors. The manifest's
// 'external_import' / 'imaging' are spelled 'external_records' / 'imaging_internal' in source.
export const DOCUMENT_TYPES = [
    'referral_letter',
    'pharmacy_record',
    'lab_report',
    'clinical_note',
    'external_records',
    'tech_workup',
    'imaging_internal',
    'imaging', // corpus spelling for OCT/fundus report docs
    'prior_visit_note',
    'patient_portal_message',
    'patient_upload',
    'intake_transcript',
    'scribe_transcript',
] as const;
export const DocumentTypeSchema = z.enum(DOCUMENT_TYPES);
export type DocumentType = z.infer<typeof DocumentTypeSchema>;

// 'image' is used by the corpus patient-upload doc (manifest lists only text|structured).
// passthrough keeps per-format extras (image_content, patient_description, ...).
export const DocumentContentSchema = z
    .object({
        format: z.enum(['text', 'structured', 'image']),
        text_content: z.string().optional(),
        ocr_quality: z.number().min(0).max(1).optional(),
        ocr_artifacts: z.array(z.string()).optional(),
        structured_content: z.record(z.unknown()).optional(),
    })
    .passthrough();
export type DocumentContent = z.infer<typeof DocumentContentSchema>;

export const DocumentMetadataSchema = z
    .object({
        source_system: z.string().optional(),
        imported_at: z.string().optional(),
        imported_by: z.string().optional(),
        original_filename: z.string().optional(),
        pages: z.number().int().optional(),
    })
    .passthrough();
export type DocumentMetadata = z.infer<typeof DocumentMetadataSchema>;

// Persisted EHR-side shape. passthrough admits per-type corpus extras (query_date,
// capture_time, ai_analysis, ...), but intentional_issues is actively rejected so demo
// fixtures cannot leak into the fact store — strip via SeedSourceDocumentSchema first.
export const SourceDocumentSchema = z
    .object({
        id: z.string().optional(),
        patient_id: z.string().optional(),
        document_type: DocumentTypeSchema,
        document_subtype: z.string().optional(),
        document_date: z.string(), // ISO date string
        received_date: z.string().optional(),
        received_method: z.string().optional(),
        content: DocumentContentSchema,
        extracted_data: z.record(z.unknown()).nullable().optional(),
        metadata: DocumentMetadataSchema.optional(),
        intentional_issues: z.never().optional(),
    })
    .passthrough();
export type SourceDocument = z.infer<typeof SourceDocumentSchema>;

export const IntentionalIssueSchema = z
    .object({
        issue: z.string(),
        actual: z.string().optional(),
        clinical_impact: z.string().optional(),
    })
    .passthrough();
export type IntentionalIssue = z.infer<typeof IntentionalIssueSchema>;

// Demo/eval-only wrapper: the corpus documents WITH their planted-issue annotations.
// Never persist this shape to the EHR-facing store (manifest §2 / §6).
export const SeedSourceDocumentSchema = SourceDocumentSchema.extend({
    intentional_issues: z.record(IntentionalIssueSchema).optional(),
});
export type SeedSourceDocument = z.infer<typeof SeedSourceDocumentSchema>;
