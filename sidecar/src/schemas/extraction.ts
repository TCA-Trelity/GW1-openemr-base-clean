// Document-extraction contracts (Week 2, REQ R2/G3 — docs/w2/requirements.md).
// THE SCHEMA IS THE SOURCE OF TRUTH, not what the VLM happens to return: the only path
// from model output to persistence is a successful parse of one of these schemas, and
// every object is `.strict()` so an invented key fails closed instead of slipping through.
// Spec-required fields (Week 2 assignment §2):
//   lab_pdf     — test name, value, unit, reference range, collection date, abnormal flag,
//                 source citation.
//   intake_form — demographics, chief concern, current medications, allergies, family
//                 history, source citation (+ patient goals: UC-7, and laterality:
//                 ophthalmology domain requirement).
import { z } from 'zod';

export const DOC_TYPES = ['lab_pdf', 'intake_form'] as const;
export const DocTypeSchema = z.enum(DOC_TYPES);
export type DocType = z.infer<typeof DocTypeSchema>;

// Everything in a retina chart has a side (USERS.md). NA = genuinely non-ocular content
// (a systemic med, a lab value) where laterality does not apply.
export const LateralitySchema = z.enum(['OD', 'OS', 'OU', 'NA']);
export type Laterality = z.infer<typeof LateralitySchema>;

// Per-field grounding citation, produced by extraction + the deterministic geometric
// grounding pass (W2_ARCHITECTURE.md §3 step 6). `grounding` records which rung of the
// ladder the field landed on:
//   word_box   — located in OCR word geometry → tight bbox overlay (citable)
//   page       — found on the page, no tight geometry → page-region highlight (citable)
//   unverified — NOT located in the document → visible but excluded from citable claims
// The VLM proposes `quote` (verbatim as read); the grounding pass — code, not a model —
// assigns `grounding` and the bbox. A fact whose citation is `unverified` can never be
// cited in an answer (gate rule, REQ R5/P2).
export const ExtractionGroundingSchema = z.enum(['word_box', 'page', 'unverified']);
export type ExtractionGrounding = z.infer<typeof ExtractionGroundingSchema>;

export const ExtractionCitationSchema = z
    .object({
        page: z.number().int().min(1),
        /** Normalized [0,1] page coordinates, top-left origin; null until word-box grounding hits. */
        bbox: z
            .object({
                x: z.number().min(0).max(1),
                y: z.number().min(0).max(1),
                w: z.number().min(0).max(1),
                h: z.number().min(0).max(1),
            })
            .strict()
            .nullable()
            .default(null),
        /** Verbatim text as read from the document — what the grounding pass must locate. */
        quote: z.string().min(1),
        grounding: ExtractionGroundingSchema,
    })
    .strict();
export type ExtractionCitation = z.infer<typeof ExtractionCitationSchema>;

// ---- lab_pdf ----

export const ABNORMAL_FLAGS = ['normal', 'low', 'high', 'critical_low', 'critical_high', 'abnormal'] as const;
export const AbnormalFlagSchema = z.enum(ABNORMAL_FLAGS);
export type AbnormalFlag = z.infer<typeof AbnormalFlagSchema>;

export const LabResultSchema = z
    .object({
        test_name: z.string().min(1),
        /** Kept as the document's literal string ("42", ">60", "1.58") — qualifiers survive. */
        value: z.string().min(1),
        /** Numeric projection when the value parses cleanly; null for qualified values. */
        value_numeric: z.number().nullable().default(null),
        unit: z.string().nullable().default(null),
        reference_range: z.string().nullable().default(null),
        abnormal_flag: AbnormalFlagSchema.nullable().default(null),
        citation: ExtractionCitationSchema,
    })
    .strict();
export type LabResult = z.infer<typeof LabResultSchema>;

export const LabPdfExtractionSchema = z
    .object({
        doc_type: z.literal('lab_pdf'),
        /** Patient identity AS PRINTED on the document — checked against the chart patient
         *  before persistence; a mismatch flags the ingestion, it never silently merges. */
        document_patient: z
            .object({
                name: z.string().nullable().default(null),
                dob: z.string().nullable().default(null), // ISO or as-printed
                citation: ExtractionCitationSchema.nullable().default(null),
            })
            .strict()
            .nullable()
            .default(null),
        performing_lab: z.string().nullable().default(null),
        collection_date: z.string().nullable().default(null), // ISO date
        collection_date_citation: ExtractionCitationSchema.nullable().default(null),
        results: z.array(LabResultSchema).min(1),
    })
    .strict();
export type LabPdfExtraction = z.infer<typeof LabPdfExtractionSchema>;

// ---- intake_form ----

export const IntakeMedicationSchema = z
    .object({
        name: z.string().min(1),
        dose: z.string().nullable().default(null),
        frequency: z.string().nullable().default(null),
        start_date: z.string().nullable().default(null), // ISO or as-written ("Jan 2019")
        citation: ExtractionCitationSchema,
    })
    .strict();
export type IntakeMedication = z.infer<typeof IntakeMedicationSchema>;

export const IntakeAllergySchema = z
    .object({
        substance: z.string().min(1),
        reaction: z.string().nullable().default(null),
        citation: ExtractionCitationSchema,
    })
    .strict();
export type IntakeAllergy = z.infer<typeof IntakeAllergySchema>;

export const IntakeFamilyHistorySchema = z
    .object({
        relative: z.string().min(1),
        condition: z.string().min(1),
        citation: ExtractionCitationSchema,
    })
    .strict();
export type IntakeFamilyHistory = z.infer<typeof IntakeFamilyHistorySchema>;

export const IntakeFormExtractionSchema = z
    .object({
        doc_type: z.literal('intake_form'),
        demographics: z
            .object({
                name: z.string().nullable().default(null),
                dob: z.string().nullable().default(null),
                sex: z.string().nullable().default(null),
                citation: ExtractionCitationSchema.nullable().default(null),
            })
            .strict(),
        chief_concern: z
            .object({
                text: z.string().nullable().default(null),
                laterality: LateralitySchema.nullable().default(null),
                citation: ExtractionCitationSchema.nullable().default(null),
            })
            .strict(),
        current_medications: z.array(IntakeMedicationSchema),
        allergies: z.array(IntakeAllergySchema),
        family_history: z.array(IntakeFamilyHistorySchema),
        /** UC-7 — "what she's hoping for" is clinical information, first-class by design. */
        patient_goals: z
            .object({
                text: z.string().nullable().default(null),
                citation: ExtractionCitationSchema.nullable().default(null),
            })
            .strict(),
        /** Feeds the native OpenEMR vitals round-trip (A.6); fixed fields per the vitals API. */
        vitals: z
            .object({
                height_in: z.number().positive().nullable().default(null),
                weight_lb: z.number().positive().nullable().default(null),
                bp_systolic: z.number().int().positive().nullable().default(null),
                bp_diastolic: z.number().int().positive().nullable().default(null),
                citation: ExtractionCitationSchema.nullable().default(null),
            })
            .strict()
            .nullable()
            .default(null),
        form_date: z.string().nullable().default(null),
    })
    .strict();
export type IntakeFormExtraction = z.infer<typeof IntakeFormExtractionSchema>;

// The single entry point extraction output must pass (discriminated on doc_type).
export const ExtractionResultSchema = z.discriminatedUnion('doc_type', [
    LabPdfExtractionSchema,
    IntakeFormExtractionSchema,
]);
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;
