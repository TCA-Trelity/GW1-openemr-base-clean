// Ingestion + evidence routes (Waves A.3/B.4, REQ S1/R1, S2/R3).
//   POST /api/patients/:patientId/documents  — multipart upload (file + doc_type) → 202
//   GET  /api/ingestions/:id                 — full staged record (correlation-traceable)
//   GET  /api/patients/:patientId/ingestions — patient's ingestion history
//   POST /api/evidence/search                — hybrid retrieval over the guideline corpus
// Write-path auth hardening (dev-login bearer + role) is ticket E.3; AUTH_MODE=off demo
// keeps these open like every other route until then.
import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { capabilitiesFor } from '../auth/principal.js';
import { DocTypeSchema } from '../schemas/extraction.js';
import { UploadFileMetaSchema } from '../schemas/ingestion.js';
import { ingestionIdOf, type AttachAndExtractInput, type IngestionRecordStore, type IngestionService } from '../ingest/service.js';
import type { CircuitBreaker } from '../lib/circuitBreaker.js';
import type { HybridRetriever } from '../retrieval/retriever.js';
import type { HealthProbe } from './health.js';

export interface IngestRouteDeps {
    service: IngestionService;
    records: IngestionRecordStore;
    /** Chart identity lookup for the printed-patient mismatch check. */
    expectedPatientOf?: (patientId: string) => Promise<{ name: string; dob?: string } | undefined>;
    maxFileBytes?: number;
    /** Preview cache for the panel's bbox overlay (E.2). Defaults to an in-memory cache. */
    files?: UploadFileStore;
    /** Enforce per-patient ownership on the id-keyed ingestion routes (true when AUTH_MODE=enforced).
     *  The global PEP only cross-patient-checks routes with a `:patientId` param; `/api/ingestions/:id`
     *  and `/:id/file` are keyed by a content-hash id, so the check is applied here instead. Off/demo
     *  mode leaves them open, exactly like the PEP (attach-only, never reject). */
    enforcePatientScope?: boolean;
}

/** Mirror the PEP's cross-patient block for the id-keyed ingestion routes (enforced mode only). */
function crossPatientViolation(deps: IngestRouteDeps, request: FastifyRequest, recordPatientId: string | undefined): boolean {
    if (deps.enforcePatientScope !== true) {
        return false; // off/demo mode: attach-only, never reject (matches the PEP)
    }
    const bound = request.principal?.patient ?? null;
    // In enforced mode the PEP has already guaranteed a bound principal; deny if ownership is unprovable.
    return bound === null || recordPatientId === undefined || bound !== recordPatientId;
}

/** Recently-uploaded originals, served back for the panel's citation overlay (E.2).
 *  This is a PREVIEW CACHE, not storage: the system of record for the file is OpenEMR
 *  Documents (A.3); evicted entries 404 with that pointer. Capped FIFO — the demo needs
 *  the last few uploads, never unbounded memory. */
export interface UploadFileStore {
    save(ingestionId: string, bytes: Buffer, mimeType: string): void;
    get(ingestionId: string): { bytes: Buffer; mimeType: string } | undefined;
}

export class MemoryUploadFileStore implements UploadFileStore {
    private readonly entries = new Map<string, { bytes: Buffer; mimeType: string }>();

    constructor(private readonly maxEntries = 24) {}

    save(ingestionId: string, bytes: Buffer, mimeType: string): void {
        this.entries.delete(ingestionId); // re-insert moves it to newest
        this.entries.set(ingestionId, { bytes, mimeType });
        while (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            this.entries.delete(oldest);
        }
    }

    get(ingestionId: string): { bytes: Buffer; mimeType: string } | undefined {
        return this.entries.get(ingestionId);
    }
}

export function registerIngestRoutes(app: FastifyInstance, deps?: IngestRouteDeps): void {
    if (deps === undefined) {
        return; // ingestion not configured (no extractor) — routes absent, /ready says why
    }
    const files = deps.files ?? new MemoryUploadFileStore();
    void app.register(multipart, {
        // Size is enforced HERE, by the multipart stream cap (surfaced as 413 below) —
        // the correct layer for a size check: a schema cannot pre-measure a stream.
        // H.11 keeps mime/filename in UploadFileMetaSchema and size in `limits` by design.
        limits: { fileSize: deps.maxFileBytes ?? 10 * 1024 * 1024, files: 1 },
    });

    app.post<{ Params: { patientId: string } }>('/api/patients/:patientId/documents', async (request, reply) => {
        // E.3 (locked decision #14): writes into the chart must be ATTRIBUTABLE — this
        // route requires an authenticated principal with the documentsWrite capability
        // REGARDLESS of AUTH_MODE (the verify route's pattern). Reads/chat stay open for
        // graders; the panel dev-login supplies the bearer.
        const principal = request.principal;
        if (principal === null) {
            return reply.status(401).send({ error: 'document_upload_requires_auth' });
        }
        if (!capabilitiesFor(principal.role).documentsWrite) {
            return reply.status(403).send({ error: 'role_cannot_upload_documents', role: principal.role });
        }
        const file = await request.file();
        if (file === undefined) {
            return reply.status(400).send({ error: 'multipart file field is required' });
        }
        const docTypeRaw = (file.fields['doc_type'] as { value?: string } | undefined)?.value;
        const docType = DocTypeSchema.safeParse(docTypeRaw);
        if (!docType.success) {
            return reply.status(400).send({ error: `doc_type must be one of: lab_pdf, intake_form (got ${String(docTypeRaw)})` });
        }
        // Mime/filename contract (H.11): the schema's mime enum is the one source of
        // truth for what this route accepts — same 415 + message as the old Set check.
        const fileMeta = UploadFileMetaSchema.safeParse({ mimetype: file.mimetype, filename: file.filename });
        if (!fileMeta.success) {
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
            filename: fileMeta.data.filename,
            mimeType: fileMeta.data.mimetype,
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
        files.save(ingestionId, bytes, fileMeta.data.mimetype);
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
        if (crossPatientViolation(deps, request, record.patient_id)) {
            return reply.status(403).send({ error: 'forbidden', reason: 'cross_patient' });
        }
        return reply.send(record);
    });

    app.get<{ Params: { patientId: string } }>('/api/patients/:patientId/ingestions', async (request, reply) => {
        return reply.send({ ingestions: deps.records.listForPatient(request.params.patientId) });
    });

    // E.2: the original file back, for the panel's PDF preview + bbox overlay. Preview
    // cache only — after eviction/restart the durable copy lives in OpenEMR Documents.
    app.get<{ Params: { id: string } }>('/api/ingestions/:id/file', async (request, reply) => {
        const entry = files.get(request.params.id);
        if (entry === undefined) {
            return reply.status(404).send({
                error: 'file not in the preview cache (evicted or uploaded before last restart) — the stored original lives in OpenEMR Documents',
            });
        }
        // Owner check: the file cache holds no patient, so resolve the ingestion record to confirm the
        // caller owns this file before serving the bytes (enforced mode; deny if the record is gone).
        if (crossPatientViolation(deps, request, deps.records.get(request.params.id)?.patient_id)) {
            return reply.status(403).send({ error: 'forbidden', reason: 'cross_patient' });
        }
        return reply.header('content-type', entry.mimeType).header('cache-control', 'private, max-age=300').send(entry.bytes);
    });
}

const EvidenceSearchSchema = z.object({
    q: z.string().min(3).max(500),
    disease_tags: z.array(z.string().min(1)).max(6).optional(),
    top_k: z.number().int().min(1).max(8).optional(),
});

export interface EvidenceRouteDeps {
    retriever: HybridRetriever;
    /** H.2: /ready's reranker probe, built beside the CohereReranker in buildEvidenceDeps
     *  so buildServer can wire it next to the retriever_index probe. Reports the last
     *  observed traffic outcome (never a per-poll Cohere call); absent when the
     *  PassthroughReranker fallback is active. registerEvidenceRoutes ignores it. */
    checkReranker?: HealthProbe;
    /** H.10: the 'cohere' circuit breaker created beside the providers in buildEvidenceDeps,
     *  exposed so buildServer can reflect its state on /ready under the `reranker` dep name
     *  (open wins over the H.2 probe). Absent on keyless deployments (PassthroughReranker —
     *  no vendor to break on). registerEvidenceRoutes ignores it. */
    cohereBreaker?: CircuitBreaker;
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
