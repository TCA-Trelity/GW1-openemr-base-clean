// Ingestion service (Waves A.3/A.6, REQ S1/R1 — W2_ARCHITECTURE.md §3). One entry point,
// `attachAndExtract`, drives the whole flow with every stage stamped on the ingestion
// record (correlation-ID reconstructable, G4):
//   received → dedupe → stored_ehr* → extracting → grounding → patient_check → persisting → complete
// (*when OpenEMR is configured; the sidecar-side flow is identical without it.)
//
// Integrity rules enforced here:
//   - byte-identical re-upload returns the SAME ingestion outcome (sha3-512 dedupe, no
//     duplicate OpenEMR rows, no duplicate facts — wipe-and-rewrite by deterministic ids)
//   - a document whose printed patient identity mismatches the chart patient is BLOCKED
//     before any fact persists (never silently merged — corpus intake-documentation rule)
//   - facts persist with per-field grounded citations; unverified quotes resolve to no
//     stored text, so the Week 1 citation gate blocks them from claims by construction
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { EhrVitalPayload, StandardApiClient } from '../openemr/standardApi.js';
import { sha3_512Hex } from '../openemr/standardApi.js';
import type { CitationRef } from '../schemas/citations.js';
import type { DocType, ExtractionResult } from '../schemas/extraction.js';
import { IngestionRecordSchema, IngestionStageSchema, IngestionStatusSchema } from '../schemas/ingestion.js';
import type { FactInput, SourceDocumentInput } from '../store/factStore.js';
import { ExtractionValidationError, type ExtractOutcome, type VlmExtractor } from './extractor.js';
import { groundExtraction } from './grounding.js';
import { extractPdfWords, type PdfWords } from './pdf.js';

// Contract-first (H.11, REQ G1): the record's shape lives in src/schemas/ingestion.ts;
// these runtime types are inferred so every importer keeps its current import path.
export type IngestionStatus = z.infer<typeof IngestionStatusSchema>;
export type IngestionStage = z.infer<typeof IngestionStageSchema>;
export type IngestionRecord = z.infer<typeof IngestionRecordSchema>;

/** In-memory record store. PG persistence is a follow-up ticket (survives restarts);
 *  the interface is the contract so the swap is invisible to routes/tests. */
export interface IngestionRecordStore {
    save(record: IngestionRecord): void;
    get(id: string): IngestionRecord | undefined;
    findByHash(patientId: string, hash: string): IngestionRecord | undefined;
    listForPatient(patientId: string): IngestionRecord[];
}

export class MemoryIngestionRecordStore implements IngestionRecordStore {
    private readonly records = new Map<string, IngestionRecord>();

    save(record: IngestionRecord): void {
        // Contract boundary (H.11, REQ G1): the store only ever holds schema-valid
        // records — drift fails HERE at save time, not later in a consumer. This parse
        // is the contract the future PG swap honors (cheap at demo volume: ~8 small
        // parses per ingestion).
        this.records.set(record.id, IngestionRecordSchema.parse(record));
    }
    get(id: string): IngestionRecord | undefined {
        return this.records.get(id);
    }
    findByHash(patientId: string, hash: string): IngestionRecord | undefined {
        return [...this.records.values()].find(
            (record) => record.patient_id === patientId && record.sha3_512 === hash && record.status === 'complete',
        );
    }
    listForPatient(patientId: string): IngestionRecord[] {
        return [...this.records.values()]
            .filter((record) => record.patient_id === patientId)
            .sort((a, b) => a.created_at.localeCompare(b.created_at));
    }
}

/** The FactStore slice ingestion needs (wipe-and-rewrite by deterministic ids). */
export interface IngestionFactSink {
    insertSourceDocuments(patientId: string, documents: SourceDocumentInput[]): Promise<number>;
    insertFacts(patientId: string, facts: FactInput[]): Promise<number>;
    wipeEhrSnapshot(patientId: string, snapshotDocumentId: string): Promise<void>;
}

export interface ExpectedPatient {
    name: string;
    dob?: string;
}

export interface AttachAndExtractInput {
    patientId: string;
    docType: DocType;
    filename: string;
    mimeType: string;
    bytes: Uint8Array;
    correlationId?: string;
    /** Chart identity for the printed-patient mismatch check. */
    expectedPatient?: ExpectedPatient;
}

export interface IngestionServiceDeps {
    extractor: VlmExtractor;
    records: IngestionRecordStore;
    factSink?: IngestionFactSink;
    /** OpenEMR side (optional — absent in store-only demo mode). */
    ehr?: { client: StandardApiClient; openemrPatientId: string | ((patientId: string) => Promise<string | null>) };
    vitalsWriter?: (patientId: string, payload: EhrVitalPayload, correlationId: string) => Promise<boolean>;
    logger?: { info: (obj: unknown, msg: string) => void; warn: (obj: unknown, msg: string) => void };
    now?: () => string;
    pdfWordsOf?: (bytes: Uint8Array, mimeType: string) => Promise<PdfWords>;
}

/** Deterministic ingestion id from content bytes — routes can answer 202 with the id
 *  before the pipeline finishes, and byte-identical uploads share one id by design. */
export function ingestionIdOf(bytes: Uint8Array): string {
    return `ing-${sha3_512Hex(bytes).slice(0, 12)}`;
}

const EHR_CATEGORY: Record<DocType, string> = {
    lab_pdf: 'Lab Report',
    intake_form: 'Patient Information',
};

export class IngestionService {
    constructor(private readonly deps: IngestionServiceDeps) {}

    /** The spec's attach_and_extract(patient_id, file, doc_type) — service form. */
    async attachAndExtract(input: AttachAndExtractInput): Promise<IngestionRecord> {
        const now = this.deps.now ?? (() => new Date().toISOString());
        const correlationId = input.correlationId ?? randomUUID();
        const hash = sha3_512Hex(input.bytes);

        // Idempotency: a byte-identical completed ingestion for this patient IS the outcome.
        const existing = this.deps.records.findByHash(input.patientId, hash);
        if (existing !== undefined) {
            return existing;
        }

        const record: IngestionRecord = {
            id: ingestionIdOf(input.bytes),
            patient_id: input.patientId,
            doc_type: input.docType,
            filename: input.filename,
            mime_type: input.mimeType,
            sha3_512: hash,
            correlation_id: correlationId,
            status: 'received',
            stages: [{ stage: 'received', at: now() }],
            openemr_document_id: null,
            source_document_id: `doc-upload-${hash.slice(0, 12)}`,
            grounding: null,
            facts_persisted: 0,
            vitals_written: false,
            error: null,
            created_at: now(),
        };
        const stage = (name: string, detail?: string): void => {
            record.stages.push({ stage: name, at: now(), ...(detail === undefined ? {} : { detail }) });
            this.deps.records.save(record);
            this.deps.logger?.info(
                { correlation_id: correlationId, ingestion_id: record.id, patient_id: input.patientId, stage: name, detail },
                `ingestion_${name}`,
            );
        };
        this.deps.records.save(record);

        // 1. Store the original in OpenEMR (system of record for the file) when configured.
        if (this.deps.ehr !== undefined) {
            try {
                const pid =
                    typeof this.deps.ehr.openemrPatientId === 'string'
                        ? this.deps.ehr.openemrPatientId
                        : await this.deps.ehr.openemrPatientId(input.patientId);
                if (pid !== null) {
                    // H.8 (G4): the ingestion's correlation id rides every hop of the EHR
                    // write — without it the client stamps its per-instance boot id and the
                    // upload leg falls out of the request's trace.
                    const uploaded = await this.deps.ehr.client.uploadPatientDocumentDeduped(
                        pid,
                        EHR_CATEGORY[input.docType],
                        input.filename,
                        input.bytes,
                        input.mimeType,
                        correlationId,
                    );
                    record.openemr_document_id = uploaded.documentId;
                    stage('stored_ehr', uploaded.deduped ? 'deduped: byte-identical document already filed' : `document ${uploaded.documentId ?? '?'}`);
                } else {
                    stage('stored_ehr_skipped', 'no OpenEMR patient mapping');
                }
            } catch (error) {
                record.status = 'failed_storage';
                record.error = error instanceof Error ? error.message : 'EHR storage failed';
                stage('failed_storage', record.error);
                return record;
            }
        } else {
            stage('stored_ehr_skipped', 'OpenEMR not configured');
        }

        // 2. Extract (VLM proposal → strict schema; one feedback retry inside).
        let outcome: ExtractOutcome;
        try {
            stage('extracting');
            outcome = await this.deps.extractor.extract({
                bytes: input.bytes,
                mimeType: input.mimeType,
                docType: input.docType,
                correlationId,
            });
            if (outcome.retried) {
                stage('extraction_retried', 'first output failed validation; feedback retry succeeded');
            }
        } catch (error) {
            if (error instanceof ExtractionValidationError) {
                record.status = 'failed_validation';
                record.error = error.issues.join('; ');
                stage('failed_validation', record.error);
            } else {
                record.status = 'failed_extraction';
                record.error = error instanceof Error ? error.message : 'extraction failed';
                stage('failed_extraction', record.error);
            }
            return record;
        }

        // 3. Ground geometry deterministically against the document's own text layer.
        stage('grounding');
        const pdfWordsOf = this.deps.pdfWordsOf ?? defaultPdfWords;
        const pdf = await pdfWordsOf(input.bytes, input.mimeType);
        const grounded = groundExtraction(outcome.extraction, pdf);
        record.grounding = grounded.summary;
        stage(
            'grounded',
            `${grounded.summary.word_box} word_box / ${grounded.summary.page} page / ${grounded.summary.unverified} unverified`,
        );
        // G5 `extraction_field_outcome`: one structured event per field. Positional labels
        // only — no extracted values ever enter the log stream (PHI-free by construction).
        for (const field of grounded.fields) {
            this.deps.logger?.info(
                {
                    correlation_id: correlationId,
                    ingestion_id: record.id,
                    doc_type: input.docType,
                    field: field.field,
                    outcome: field.outcome,
                },
                'extraction_field_outcome',
            );
        }

        // 4. Printed-patient identity check — mismatch blocks before any fact persists.
        const mismatch = patientMismatch(grounded.extraction, input.expectedPatient);
        if (mismatch !== null) {
            record.status = 'blocked_patient_mismatch';
            record.error = mismatch;
            stage('blocked_patient_mismatch', mismatch);
            return record;
        }

        // 5. Persist: source document (text layer as gate-verifiable content) + facts.
        if (this.deps.factSink !== undefined) {
            try {
                stage('persisting');
                // Re-process is wipe-and-rewrite: deterministic ids, never accretion.
                await this.deps.factSink.wipeEhrSnapshot(input.patientId, record.source_document_id!);
                await this.deps.factSink.insertSourceDocuments(input.patientId, [
                    sourceDocumentOf(record, pdf, input),
                ]);
                const facts = factsOf(record.source_document_id!, input.patientId, grounded.extraction, input.filename);
                record.facts_persisted = await this.deps.factSink.insertFacts(input.patientId, facts);
                stage('persisted', `${record.facts_persisted} facts`);
            } catch (error) {
                record.status = 'failed_storage';
                record.error = error instanceof Error ? error.message : 'fact persistence failed';
                stage('failed_storage', record.error);
                return record;
            }
        } else {
            stage('persist_skipped', 'fact store not configured');
        }

        // 6. Vitals round-trip (intake only, when a writer is wired).
        if (grounded.extraction.doc_type === 'intake_form' && this.deps.vitalsWriter !== undefined) {
            const payload = mapIntakeVitals(grounded.extraction);
            if (payload !== null) {
                try {
                    record.vitals_written = await this.deps.vitalsWriter(input.patientId, payload, correlationId);
                    stage('vitals_written', record.vitals_written ? 'native OpenEMR vitals row' : 'writer declined');
                } catch (error) {
                    // Vitals are additive — a write failure degrades, it does not fail ingestion.
                    stage('vitals_failed', error instanceof Error ? error.message : 'vitals write failed');
                    this.deps.logger?.warn({ correlation_id: correlationId }, 'ingestion_vitals_failed');
                }
            }
        }

        record.status = 'complete';
        stage('complete');
        return record;
    }
}

async function defaultPdfWords(bytes: Uint8Array, mimeType: string): Promise<PdfWords> {
    if (mimeType === 'application/pdf') {
        return extractPdfWords(bytes);
    }
    return { pages: [], fullText: '' }; // images: no text layer → grounding lands on 'unverified'
}

/** Normalized name/DOB comparison; null = no mismatch (absent identity ≠ mismatch). */
export function patientMismatch(extraction: ExtractionResult, expected?: ExpectedPatient): string | null {
    if (expected === undefined) {
        return null;
    }
    const printed =
        extraction.doc_type === 'lab_pdf' ? extraction.document_patient : extraction.demographics;
    const printedName = printed?.name ?? null;
    if (printedName === null) {
        return null;
    }
    const normalize = (name: string): Set<string> =>
        new Set(
            name
                .toLowerCase()
                .replace(/[^a-z\s]/g, ' ')
                .split(/\s+/)
                .filter((part) => part.length >= 3),
        );
    const printedParts = normalize(printedName);
    const expectedParts = normalize(expected.name);
    const overlap = [...printedParts].filter((part) => expectedParts.has(part)).length;
    if (printedParts.size > 0 && overlap === 0) {
        return `document is printed for "${printedName}" — does not match the chart patient`;
    }
    return null;
}

function sourceDocumentOf(record: IngestionRecord, pdf: PdfWords, input: AttachAndExtractInput): SourceDocumentInput {
    return {
        id: record.source_document_id!,
        document_type: input.docType === 'lab_pdf' ? 'lab_report' : 'patient_upload',
        document_date: record.created_at.slice(0, 10),
        // The text layer is the gate's verification substrate: grounded quotes resolve
        // here; unverified quotes don't, so the gate blocks them from claims.
        content: { format: 'text', text_content: pdf.fullText, original_filename: input.filename },
        metadata: {
            ingestion_id: record.id,
            sha3_512: record.sha3_512,
            openemr_document_id: record.openemr_document_id,
            mime_type: input.mimeType,
            correlation_id: record.correlation_id,
            // U.1: the panel titles documents from metadata.original_filename — without it
            // an upload renders in Sources as its raw doc-upload-<hash> id. Only new and
            // re-run ingestions carry it (no backfill of already-persisted rows).
            original_filename: input.filename,
        },
    };
}

/** Map a grounded extraction into fact-store rows with per-field citations. */
export function factsOf(
    sourceDocumentId: string,
    patientId: string,
    extraction: ExtractionResult,
    sourceLabel: string,
): FactInput[] {
    let counter = 0;
    const cite = (
        quote: string,
        page: number,
        bbox: { x: number; y: number; w: number; h: number } | null,
        grounding: string,
        fieldPath: string,
        sourceType: string,
    ): CitationRef[] => {
        counter += 1;
        return [
            {
                id: `${sourceDocumentId}-cit-${counter}`,
                fact_id: null,
                source_label: sourceLabel,
                source_type: sourceType as CitationRef['source_type'],
                excerpt_text: quote,
                excerpt_location:
                    grounding === 'word_box' && bbox !== null
                        ? { type: 'page_bbox', page, ...bbox }
                        : grounding === 'page'
                          ? { type: 'page', page }
                          : null,
                attribution: null,
                source_document_id: sourceDocumentId,
                document_date: null,
                page_or_section: `page ${page}`,
                field_or_chunk_id: fieldPath,
            },
        ];
    };

    const facts: FactInput[] = [];
    if (extraction.doc_type === 'lab_pdf') {
        extraction.results.forEach((result, index) => {
            facts.push({
                id: `${sourceDocumentId}-lab-${index}`,
                fact_type: 'lab_result',
                content: {
                    test_name: result.test_name,
                    value: result.value,
                    value_numeric: result.value_numeric,
                    unit: result.unit,
                    reference_range: result.reference_range,
                    abnormal_flag: result.abnormal_flag,
                    collection_date: extraction.collection_date,
                    performing_lab: extraction.performing_lab,
                },
                source_document_id: sourceDocumentId,
                sources: cite(
                    result.citation.quote,
                    result.citation.page,
                    result.citation.bbox,
                    result.citation.grounding,
                    `results[${index}]`,
                    'lab_report',
                ),
                verification: { status: 'unverified' },
            });
        });
        return facts;
    }

    extraction.current_medications.forEach((med, index) => {
        facts.push({
            id: `${sourceDocumentId}-med-${index}`,
            fact_type: 'medication',
            content: { name: med.name, dose: med.dose ?? undefined, frequency: med.frequency ?? undefined, start_date: med.start_date },
            source_document_id: sourceDocumentId,
            sources: cite(med.citation.quote, med.citation.page, med.citation.bbox, med.citation.grounding, `current_medications[${index}]`, 'intake_transcript'),
            verification: { status: 'patient_reported' },
        });
    });
    extraction.allergies.forEach((allergy, index) => {
        facts.push({
            id: `${sourceDocumentId}-alg-${index}`,
            fact_type: 'allergy',
            content: { substance: allergy.substance, reaction: allergy.reaction ?? undefined },
            source_document_id: sourceDocumentId,
            sources: cite(allergy.citation.quote, allergy.citation.page, allergy.citation.bbox, allergy.citation.grounding, `allergies[${index}]`, 'intake_transcript'),
            verification: { status: 'patient_reported' },
        });
    });
    extraction.family_history.forEach((entry, index) => {
        facts.push({
            id: `${sourceDocumentId}-fam-${index}`,
            fact_type: 'family_history',
            content: { relative: entry.relative, condition: entry.condition },
            source_document_id: sourceDocumentId,
            sources: cite(entry.citation.quote, entry.citation.page, entry.citation.bbox, entry.citation.grounding, `family_history[${index}]`, 'intake_transcript'),
            verification: { status: 'patient_reported' },
        });
    });
    if (extraction.patient_goals.text !== null && extraction.patient_goals.citation !== null) {
        const c = extraction.patient_goals.citation;
        facts.push({
            id: `${sourceDocumentId}-goal-0`,
            fact_type: 'patient_goal',
            content: { goal: extraction.patient_goals.text },
            source_document_id: sourceDocumentId,
            sources: cite(c.quote, c.page, c.bbox, c.grounding, 'patient_goals', 'intake_transcript'),
            verification: { status: 'patient_reported' },
        });
    }
    if (extraction.chief_concern.text !== null && extraction.chief_concern.citation !== null) {
        const c = extraction.chief_concern.citation;
        facts.push({
            id: `${sourceDocumentId}-cc-0`,
            fact_type: 'chief_complaint',
            content: { statement: extraction.chief_concern.text },
            laterality: extraction.chief_concern.laterality === 'NA' ? null : extraction.chief_concern.laterality,
            source_document_id: sourceDocumentId,
            sources: cite(c.quote, c.page, c.bbox, c.grounding, 'chief_concern', 'intake_transcript'),
            verification: { status: 'patient_reported' },
        });
    }
    return facts;
}

/** Intake vitals → the fixed-field native OpenEMR payload (A.6 round-trip). */
export function mapIntakeVitals(extraction: ExtractionResult): EhrVitalPayload | null {
    if (extraction.doc_type !== 'intake_form' || extraction.vitals === null) {
        return null;
    }
    const vitals = extraction.vitals;
    const payload: EhrVitalPayload = {};
    if (vitals.height_in !== null) {
        payload.height = vitals.height_in;
    }
    if (vitals.weight_lb !== null) {
        payload.weight = vitals.weight_lb;
    }
    if (vitals.bp_systolic !== null) {
        payload.bps = vitals.bp_systolic;
    }
    if (vitals.bp_diastolic !== null) {
        payload.bpd = vitals.bp_diastolic;
    }
    return Object.keys(payload).length === 0 ? null : payload;
}
