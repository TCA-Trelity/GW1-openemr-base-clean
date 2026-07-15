// Ingestion job-state contracts (H.11, REQ G1 — docs/w2/requirements.md). THE SCHEMA IS
// THE SOURCE OF TRUTH for the staged ingestion record: the runtime types in
// src/ingest/service.ts are inferred from here (z.infer), and the one runtime parse sits
// at the record-store boundary (parse, don't validate) — a drifted record fails at save
// time, never later in a consumer. All objects `.strict()` so invented keys fail closed.
import { z } from 'zod';
import { DocTypeSchema } from './extraction.js';

/** Every state one ingestion can land in (src/ingest/service.ts drives the flow). */
export const IngestionStatusSchema = z.enum([
    'received',
    'complete',
    'blocked_patient_mismatch',
    'failed_validation',
    'failed_extraction',
    'failed_storage',
]);

/** One stamped pipeline stage — the correlation-ID-reconstructable trail (G4). */
export const IngestionStageSchema = z
    .object({
        stage: z.string().min(1),
        at: z.string().min(1),
        detail: z.string().optional(),
    })
    .strict();

/** Per-document grounding tallies (A.5), embedded in the record and served to the panel. */
export const GroundingSummarySchema = z
    .object({
        total: z.number().int().min(0),
        word_box: z.number().int().min(0),
        page: z.number().int().min(0),
        unverified: z.number().int().min(0),
        /** Grounded (word_box+page) / total — the per-document extraction confidence (R7). */
        confidence: z.number().min(0).max(1),
    })
    .strict();

/** The staged ingestion record — what the store persists and the status routes serve. */
export const IngestionRecordSchema = z
    .object({
        id: z.string().min(1),
        patient_id: z.string().min(1),
        doc_type: DocTypeSchema,
        filename: z.string().min(1),
        mime_type: z.string().min(1),
        /** sha3-512 hex of the uploaded bytes — the dedupe key (matches OpenEMR's stored hash). */
        sha3_512: z.string().length(128),
        correlation_id: z.string().min(1),
        status: IngestionStatusSchema,
        stages: z.array(IngestionStageSchema),
        openemr_document_id: z.string().nullable(),
        source_document_id: z.string().nullable(),
        grounding: GroundingSummarySchema.nullable(),
        facts_persisted: z.number().int().min(0),
        vitals_written: z.boolean(),
        error: z.string().nullable(),
        created_at: z.string().min(1),
    })
    .strict();

/** The upload route's mime/filename gate (415 on failure). Size is deliberately NOT here:
 *  the multipart `limits` stream cap (surfaced as 413) is the enforcement point — a
 *  schema cannot pre-measure a stream. */
export const UploadFileMetaSchema = z.object({
    mimetype: z.enum(['application/pdf', 'image/png', 'image/jpeg']),
    filename: z.string().min(1),
}); // NOT .strict() — it parses a slice of @fastify/multipart's file object
