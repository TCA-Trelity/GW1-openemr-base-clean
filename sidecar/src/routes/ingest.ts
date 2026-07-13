// Ingestion + evidence routes (Waves A.3/B.4, REQ S1/R1, S2/R3).
//   POST /api/patients/:patientId/documents  — multipart upload (file + doc_type) → 202
//   GET  /api/ingestions/:id                 — full staged record (correlation-traceable)
//   GET  /api/patients/:patientId/ingestions — patient's ingestion history
//   POST /api/evidence/search                — hybrid retrieval over the guideline corpus
// Write-path auth hardening (dev-login bearer + role) is ticket E.3; AUTH_MODE=off demo
// keeps these open like every other route until then.
import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DocTypeSchema } from '../schemas/extraction.js';
import { ingestionIdOf, type AttachAndExtractInput, type IngestionRecordStore, type IngestionService } from '../ingest/service.js';
import type { HybridRetriever } from '../retrieval/retriever.js';

export interface IngestRouteDeps {
    service: IngestionService;
    records: IngestionRecordStore;
    /** Chart identity lookup for the printed-patient mismatch check. */
    expectedPatientOf?: (patientId: string) => Promise<{ name: string; dob?: string } | undefined>;
    maxFileBytes?: number;
}

const ACCEPTED_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg']);

export function registerIngestRoutes(app: FastifyInstance, deps?: IngestRouteDeps): void {
    if (deps === undefined) {
        return; // ingestion not configured (no extractor) — routes absent, /ready says why
    }
    void app.register(multipart, {
        limits: { fileSize: deps.maxFileBytes ?? 10 * 1024 * 1024, files: 1 },
    });

    app.post<{ Params: { patientId: string } }>('/api/patients/:patientId/documents', async (request, reply) => {
        const file = await request.file();
        if (file === undefined) {
            return reply.status(400).send({ error: 'multipart file field is required' });
        }
        const docTypeRaw = (file.fields['doc_type'] as { value?: string } | undefined)?.value;
        const docType = DocTypeSchema.safeParse(docTypeRaw);
        if (!docType.success) {
            return reply.status(400).send({ error: `doc_type must be one of: lab_pdf, intake_form (got ${String(docTypeRaw)})` });
        }
        if (!ACCEPTED_MIME.has(file.mimetype)) {
            return reply.status(415).send({ error: `unsupported media type ${file.mimetype} (pdf/png/jpeg only)` });
        }
        let bytes: Buffer;
        try {
            bytes = await file.toBuffer();
        } catch {
            return reply.status(413).send({ error: 'file exceeds the size limit' });
        }

        const input: AttachAndExtractInput = {
            patientId: request.params.patientId,
            docType: docType.data,
            filename: file.filename,
            mimeType: file.mimetype,
            bytes,
            correlationId: request.id,
        };
        const expected = await deps.expectedPatientOf?.(request.params.patientId);
        if (expected !== undefined) {
            input.expectedPatient = expected;
        }
        // Extraction runs prep-time (in-process, Week 1 pattern): the ingestion id is
        // deterministic from the bytes, so the 202 carries it immediately and the status
        // route serves the staged record as the pipeline advances.
        const ingestionId = ingestionIdOf(bytes);
        deps.service.attachAndExtract(input).catch((error: unknown) => {
            request.log.warn({ err: error, correlation_id: request.id, ingestion_id: ingestionId }, 'ingestion_unhandled_failure');
        });
        return reply.status(202).send({
            ingestion_id: ingestionId,
            correlation_id: request.id,
            status_url: `/api/ingestions/${ingestionId}`,
        });
    });

    app.get<{ Params: { id: string } }>('/api/ingestions/:id', async (request, reply) => {
        const record = deps.records.get(request.params.id);
        if (record === undefined) {
            return reply.status(404).send({ error: 'unknown ingestion id' });
        }
        return reply.send(record);
    });

    app.get<{ Params: { patientId: string } }>('/api/patients/:patientId/ingestions', async (request, reply) => {
        return reply.send({ ingestions: deps.records.listForPatient(request.params.patientId) });
    });
}

const EvidenceSearchSchema = z.object({
    q: z.string().min(3).max(500),
    disease_tags: z.array(z.string().min(1)).max(6).optional(),
    top_k: z.number().int().min(1).max(8).optional(),
});

export interface EvidenceRouteDeps {
    retriever: HybridRetriever;
}

export function registerEvidenceRoutes(app: FastifyInstance, deps?: EvidenceRouteDeps): void {
    if (deps === undefined) {
        return;
    }
    app.post('/api/evidence/search', async (request, reply) => {
        const parsed = EvidenceSearchSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.status(400).send({ error: 'q (3-500 chars) required; optional disease_tags[], top_k<=8' });
        }
        const searchOptions: Parameters<HybridRetriever['search']>[1] = {
            correlationId: request.id,
            ...(parsed.data.top_k === undefined ? {} : { topK: parsed.data.top_k }),
            ...(parsed.data.disease_tags === undefined ? {} : { context: { diseaseTags: parsed.data.disease_tags } }),
        };
        const result = await deps.retriever.search(parsed.data.q, searchOptions);
        return reply.send(result);
    });
}
