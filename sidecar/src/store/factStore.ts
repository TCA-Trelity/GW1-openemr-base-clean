// FactStore (S1.6): the sidecar's Postgres-backed derived view of the EHR — insert-only
// plus wipePatient/wipeAll rebuild levers (ARCHITECTURE.md §2: never a second source of
// truth). Parameterized SQL exclusively; Zod validates jsonb payloads where the landed
// schemas and the seed corpus agree (full-shape parses that the corpus predates stay at
// the write boundary of the prep pipeline — see per-method comments).
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
    DocumentContentSchema,
    DocumentMetadataSchema,
    FactLateralitySchema,
    FactTypeSchema,
    FactVerificationSchema,
    ImageMetadataSchema,
    ContradictionSchema,
    RuntimeContradictionSchema,
    RuntimeContradictionSeveritySchema,
    TreatmentRecordSchema,
    type FactLaterality,
    type FactType,
    type FactVerification,
    type ImageMetadata,
    type RuntimeContradictionSeverity,
} from '../schemas/index.js';

// ---- Input shapes (permissive: both the seed corpus and the prep pipeline fit) ----

export interface PatientInput {
    id: string;
    name: string;
    openemr_patient_id?: string | null;
    demographics?: Record<string, unknown>;
}

export interface SourceDocumentInput {
    [extra: string]: unknown;
    id?: string;
    document_id?: string; // corpus spelling; either id or document_id must be present
    patient_id?: string | null;
    document_type: string;
    document_date: string;
    content: unknown;
    metadata?: unknown;
    intentional_issues?: unknown; // demo/eval-only; actively stripped, never persisted
}

export interface FactInput {
    id: string;
    patient_id?: string | null;
    fact_type: string;
    content: unknown;
    is_current?: boolean;
    laterality?: string | null;
    verification?: unknown;
    source_document_id: string;
    sources?: unknown;
    created_date?: string | null;
    updated_date?: string | null;
}

export interface ContradictionInput {
    [extra: string]: unknown;
    id?: string;
    contradiction_id?: string; // rich-corpus spelling; either spelling must be present
    patient_id?: string | null;
    status?: string;
    severity: string;
}

export interface ImageRecordInput {
    [extra: string]: unknown;
    id: string;
    patient_id?: string | null;
    image_metadata: unknown;
    ai_analysis?: unknown;
    treatment_context?: unknown;
    storage_key?: string | null;
}

export interface TreatmentInput {
    [extra: string]: unknown;
    id: string;
    patient_id?: string | null;
    treatment_type: string;
    treatment_date: string;
}

export type BriefStatus = 'draft' | 'complete' | 'failed';
const BriefStatusSchema = z.enum(['draft', 'complete', 'failed']);

export interface BriefInput {
    patient_id: string;
    correlation_id: string;
    content: unknown;
    status?: BriefStatus;
}

// ---- Read shapes (what getFactBundle/getBrief hand to prep and chat) ----

export interface StoredPatient {
    id: string;
    openemr_patient_id: string | null;
    name: string;
    demographics: Record<string, unknown>;
}

export interface StoredFact {
    id: string;
    patient_id: string;
    fact_type: FactType;
    content: unknown;
    is_current: boolean;
    laterality: FactLaterality | null;
    verification: FactVerification;
    source_document_id: string;
    sources: unknown[];
    created_date: string | null;
    updated_date: string | null;
}

export interface StoredContradiction {
    id: string;
    patient_id: string;
    status: string;
    severity: RuntimeContradictionSeverity;
    payload: Record<string, unknown>;
}

// Reassembled to the ImageRecord shape the imaging engines read (image_metadata is the
// primary field path); extras (study_id, image_file, ...) are spread back in untouched.
export interface StoredImageRecord {
    [key: string]: unknown;
    id: string;
    patient_id: string;
    image_metadata: ImageMetadata;
}

export interface StoredTreatment {
    id: string;
    patient_id: string;
    treatment_date: string;
    payload: Record<string, unknown>;
}

export interface FactBundle {
    patient: StoredPatient;
    facts: StoredFact[];
    contradictions: StoredContradiction[];
    images: StoredImageRecord[];
    treatments: StoredTreatment[];
}

export interface StoredBrief {
    id: string;
    patient_id: string;
    prepared_at: string; // ISO datetime
    correlation_id: string;
    content: unknown;
    status: BriefStatus;
}

export type PrepRunStatus = 'complete' | 'failed';
const PrepRunStatusSchema = z.enum(['complete', 'failed']);

// ---- Validation helpers ----

// Contradiction payloads may be the rich seed shape or the runtime detector shape.
const ContradictionPayloadSchema = z.union([ContradictionSchema, RuntimeContradictionSchema]);
const ContradictionStatusSchema = z.enum(['active', 'resolved']);
const JsonObjectSchema = z.record(z.unknown());
const JsonArraySchema = z.array(z.unknown());
const NullableFactLateralitySchema = FactLateralitySchema.nullable();

/** jsonb params must be pre-stringified: node-postgres encodes JS arrays as Postgres arrays. */
function toJsonb(value: unknown): string {
    return JSON.stringify(value ?? null);
}

function assertPatientScope(patientId: string, item: { patient_id?: string | null }, itemId: string): void {
    if (item.patient_id != null && item.patient_id !== patientId) {
        throw new Error(`cross-patient write rejected: item ${itemId} belongs to ${item.patient_id}, not ${patientId}`);
    }
}

// ---- The store ----

export class FactStore {
    public constructor(private readonly pool: Pool) {}

    public async upsertPatient(patient: PatientInput): Promise<void> {
        await this.pool.query(
            `INSERT INTO patients (id, openemr_patient_id, name, demographics)
             VALUES ($1, $2, $3, $4::jsonb)
             ON CONFLICT (id) DO UPDATE SET
                 openemr_patient_id = EXCLUDED.openemr_patient_id,
                 name = EXCLUDED.name,
                 demographics = EXCLUDED.demographics,
                 updated_at = now()`,
            [patient.id, patient.openemr_patient_id ?? null, patient.name, toJsonb(patient.demographics ?? {})],
        );
    }

    /** Strips demo-only intentional_issues (sources.ts: never persisted to the EHR-facing store). */
    public async insertSourceDocuments(patientId: string, documents: SourceDocumentInput[]): Promise<number> {
        return this.withTransaction(async (client) => {
            for (const doc of documents) {
                const { id, document_id, patient_id: _scope, document_type, document_date, content, metadata, intentional_issues: _stripped, ...extras } = doc;
                const docId = id ?? document_id;
                if (docId === undefined) {
                    throw new Error('source document missing id/document_id');
                }
                assertPatientScope(patientId, doc, docId);
                DocumentContentSchema.parse(content); // validate only; store the raw jsonb
                DocumentMetadataSchema.parse(metadata ?? {});
                // document_type stays text: the corpus uses 'imaging', outside DocumentTypeSchema.
                await client.query(
                    `INSERT INTO source_documents (id, patient_id, document_type, document_date, content, metadata, extras)
                     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb)`,
                    [docId, patientId, z.string().min(1).parse(document_type), document_date, toJsonb(content), toJsonb(metadata ?? {}), toJsonb(extras)],
                );
            }
            return documents.length;
        });
    }

    /**
     * fact_type/laterality/verification are Zod-validated; content and sources are stored as
     * given (corpus citations lack deep_link_url and some contents carry explicit nulls, so
     * full PatientFactSchema/CitationRefSchema parses would reject the landed seed corpus).
     */
    public async insertFacts(patientId: string, facts: FactInput[]): Promise<number> {
        return this.withTransaction(async (client) => {
            for (const fact of facts) {
                assertPatientScope(patientId, fact, fact.id);
                if (fact.source_document_id === undefined || fact.source_document_id === '') {
                    throw new Error(`fact ${fact.id} has no source_document_id (provenance is required)`);
                }
                await client.query(
                    `INSERT INTO patient_facts
                         (id, patient_id, fact_type, content, is_current, laterality, verification,
                          source_document_id, sources, created_date, updated_date)
                     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8, $9::jsonb, $10, $11)`,
                    [
                        fact.id,
                        patientId,
                        FactTypeSchema.parse(fact.fact_type),
                        toJsonb(JsonObjectSchema.parse(fact.content)),
                        fact.is_current ?? true,
                        NullableFactLateralitySchema.parse(fact.laterality ?? null),
                        toJsonb(FactVerificationSchema.parse(fact.verification ?? {})),
                        fact.source_document_id,
                        toJsonb(JsonArraySchema.parse(fact.sources ?? [])),
                        fact.created_date ?? null,
                        fact.updated_date ?? null,
                    ],
                );
            }
            return facts.length;
        });
    }

    public async insertContradictions(patientId: string, contradictions: ContradictionInput[]): Promise<number> {
        return this.withTransaction(async (client) => {
            for (const item of contradictions) {
                const itemId = item.contradiction_id ?? item.id;
                if (itemId === undefined) {
                    throw new Error('contradiction missing contradiction_id/id');
                }
                assertPatientScope(patientId, item, itemId);
                ContradictionPayloadSchema.parse(item); // rich or runtime shape; store the raw jsonb
                await client.query(
                    `INSERT INTO contradictions (id, patient_id, status, severity, payload)
                     VALUES ($1, $2, $3, $4, $5::jsonb)`,
                    [
                        itemId,
                        patientId,
                        ContradictionStatusSchema.parse(item.status ?? 'active'),
                        RuntimeContradictionSeveritySchema.parse(item.severity),
                        toJsonb(item),
                    ],
                );
            }
            return contradictions.length;
        });
    }

    /**
     * image_metadata is Zod-validated (it carries the lifted capture_date/modality/laterality
     * columns); ai_analysis/treatment_context are stored as given — the corpus uses explicit
     * nulls where AiAnalysisSchema/TreatmentContextSchema expect absent fields.
     */
    public async insertImageRecords(patientId: string, images: ImageRecordInput[]): Promise<number> {
        return this.withTransaction(async (client) => {
            for (const image of images) {
                const { id, patient_id: _scope, image_metadata, ai_analysis, treatment_context, storage_key, ...extras } = image;
                assertPatientScope(patientId, image, id);
                const metadata = ImageMetadataSchema.parse(image_metadata);
                await client.query(
                    `INSERT INTO image_records
                         (id, patient_id, capture_date, modality, laterality, storage_key,
                          image_metadata, ai_analysis, treatment_context, extras)
                     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb)`,
                    [
                        id,
                        patientId,
                        metadata.capture_date,
                        metadata.modality,
                        metadata.laterality,
                        storage_key ?? null,
                        toJsonb(image_metadata),
                        ai_analysis === undefined || ai_analysis === null ? null : toJsonb(ai_analysis),
                        treatment_context === undefined || treatment_context === null ? null : toJsonb(treatment_context),
                        toJsonb(extras),
                    ],
                );
            }
            return images.length;
        });
    }

    public async insertTreatments(patientId: string, treatments: TreatmentInput[]): Promise<number> {
        return this.withTransaction(async (client) => {
            for (const treatment of treatments) {
                assertPatientScope(patientId, treatment, treatment.id);
                TreatmentRecordSchema.parse(treatment); // validate only; store the raw jsonb
                await client.query(
                    `INSERT INTO treatments (id, patient_id, treatment_date, payload)
                     VALUES ($1, $2, $3, $4::jsonb)`,
                    [treatment.id, patientId, treatment.treatment_date, toJsonb(treatment)],
                );
            }
            return treatments.length;
        });
    }

    public async saveBrief(brief: BriefInput): Promise<StoredBrief> {
        const result = await this.pool.query<BriefRow>(
            `INSERT INTO briefs (patient_id, correlation_id, content, status)
             VALUES ($1, $2, $3::jsonb, $4)
             RETURNING id, patient_id, prepared_at, correlation_id, content, status`,
            [brief.patient_id, brief.correlation_id, toJsonb(brief.content), BriefStatusSchema.parse(brief.status ?? 'complete')],
        );
        const row = result.rows[0];
        if (row === undefined) {
            throw new Error('brief insert returned no row');
        }
        return toStoredBrief(row);
    }

    /** Latest complete brief for the patient, or null when none has been prepared yet. */
    public async getBrief(patientId: string): Promise<StoredBrief | null> {
        const result = await this.pool.query<BriefRow>(
            `SELECT id, patient_id, prepared_at, correlation_id, content, status
             FROM briefs
             WHERE patient_id = $1 AND status = 'complete'
             ORDER BY prepared_at DESC
             LIMIT 1`,
            [patientId],
        );
        const row = result.rows[0];
        return row === undefined ? null : toStoredBrief(row);
    }

    /** Everything chat/prep consume in one shape; null when the patient is not registered. */
    public async getFactBundle(patientId: string): Promise<FactBundle | null> {
        const patientResult = await this.pool.query<PatientRow>(
            'SELECT id, openemr_patient_id, name, demographics FROM patients WHERE id = $1',
            [patientId],
        );
        const patientRow = patientResult.rows[0];
        if (patientRow === undefined) {
            return null;
        }
        const [factRows, contradictionRows, imageRows, treatmentRows] = await Promise.all([
            this.pool.query<FactRow>(
                `SELECT id, patient_id, fact_type, content, is_current, laterality, verification,
                        source_document_id, sources, created_date, updated_date
                 FROM patient_facts WHERE patient_id = $1 ORDER BY fact_type, id`,
                [patientId],
            ),
            this.pool.query<ContradictionRow>(
                'SELECT id, patient_id, status, severity, payload FROM contradictions WHERE patient_id = $1 ORDER BY id',
                [patientId],
            ),
            this.pool.query<ImageRow>(
                `SELECT id, patient_id, storage_key, image_metadata, ai_analysis, treatment_context, extras
                 FROM image_records WHERE patient_id = $1 ORDER BY capture_date, id`,
                [patientId],
            ),
            this.pool.query<TreatmentRow>(
                `SELECT id, patient_id, treatment_date::text AS treatment_date, payload
                 FROM treatments WHERE patient_id = $1 ORDER BY treatment_date, id`,
                [patientId],
            ),
        ]);
        return {
            patient: {
                id: patientRow.id,
                openemr_patient_id: patientRow.openemr_patient_id,
                name: patientRow.name,
                demographics: JsonObjectSchema.parse(patientRow.demographics),
            },
            facts: factRows.rows.map((row) => ({
                id: row.id,
                patient_id: row.patient_id,
                fact_type: FactTypeSchema.parse(row.fact_type),
                content: row.content,
                is_current: row.is_current,
                laterality: NullableFactLateralitySchema.parse(row.laterality),
                verification: FactVerificationSchema.parse(row.verification),
                source_document_id: row.source_document_id,
                // Raw citation jsonb: CitationRefSchema is stricter than the corpus (deep_link_url);
                // the S1.8 citation gate owns per-citation resolution.
                sources: JsonArraySchema.parse(row.sources),
                created_date: row.created_date,
                updated_date: row.updated_date,
            })),
            contradictions: contradictionRows.rows.map((row) => ({
                id: row.id,
                patient_id: row.patient_id,
                status: ContradictionStatusSchema.parse(row.status),
                severity: RuntimeContradictionSeveritySchema.parse(row.severity),
                payload: JsonObjectSchema.parse(row.payload),
            })),
            images: imageRows.rows.map((row) => ({
                ...JsonObjectSchema.parse(row.extras),
                id: row.id,
                patient_id: row.patient_id,
                image_metadata: ImageMetadataSchema.parse(row.image_metadata),
                ...(row.ai_analysis === null ? {} : { ai_analysis: row.ai_analysis }),
                ...(row.treatment_context === null ? {} : { treatment_context: row.treatment_context }),
                ...(row.storage_key === null ? {} : { storage_key: row.storage_key }),
            })),
            treatments: treatmentRows.rows.map((row) => ({
                id: row.id,
                patient_id: row.patient_id,
                treatment_date: row.treatment_date,
                payload: JsonObjectSchema.parse(row.payload),
            })),
        };
    }

    public async startPrepRun(patientId: string, correlationId: string): Promise<string> {
        const result = await this.pool.query<{ id: string }>(
            'INSERT INTO prep_runs (patient_id, correlation_id) VALUES ($1, $2) RETURNING id',
            [patientId, correlationId],
        );
        const row = result.rows[0];
        if (row === undefined) {
            throw new Error('prep run insert returned no row');
        }
        return row.id;
    }

    public async finishPrepRun(runId: string, status: PrepRunStatus, error?: string): Promise<void> {
        const result = await this.pool.query(
            'UPDATE prep_runs SET status = $2, error = $3, finished_at = now() WHERE id = $1',
            [runId, PrepRunStatusSchema.parse(status), error ?? null],
        );
        if (result.rowCount !== 1) {
            throw new Error(`prep run ${runId} not found`);
        }
    }

    /** Rebuild lever: drops the patient's entire derived view (cascades); prep_runs survive as audit. */
    public async wipePatient(patientId: string): Promise<void> {
        await this.pool.query('DELETE FROM patients WHERE id = $1', [patientId]);
    }

    /** Rebuild lever: empties every derived table; prep_runs survive as the audit trail. */
    public async wipeAll(): Promise<void> {
        await this.pool.query(
            'TRUNCATE patient_facts, contradictions, image_records, treatments, briefs, source_documents, patients',
        );
    }

    private async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const result = await fn(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
    }
}

// ---- Row shapes as returned by pg (type aliases get the implicit index signature) ----

type PatientRow = { id: string; openemr_patient_id: string | null; name: string; demographics: unknown };
type FactRow = {
    id: string;
    patient_id: string;
    fact_type: string;
    content: unknown;
    is_current: boolean;
    laterality: string | null;
    verification: unknown;
    source_document_id: string;
    sources: unknown;
    created_date: string | null;
    updated_date: string | null;
};
type ContradictionRow = { id: string; patient_id: string; status: string; severity: string; payload: unknown };
type ImageRow = {
    id: string;
    patient_id: string;
    storage_key: string | null;
    image_metadata: unknown;
    ai_analysis: unknown;
    treatment_context: unknown;
    extras: unknown;
};
type TreatmentRow = { id: string; patient_id: string; treatment_date: string; payload: unknown };
type BriefRow = { id: string; patient_id: string; prepared_at: Date; correlation_id: string; content: unknown; status: string };

function toStoredBrief(row: BriefRow): StoredBrief {
    return {
        id: row.id,
        patient_id: row.patient_id,
        prepared_at: row.prepared_at.toISOString(),
        correlation_id: row.correlation_id,
        content: row.content,
        status: BriefStatusSchema.parse(row.status),
    };
}
