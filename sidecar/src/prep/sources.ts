// DocumentSource implementations (S1.7): StoreDocumentSource reads the seeded fact store
// (the Tier-1 demo path); FhirDocumentSource reads OpenEMR via src/openemr/fhir.ts —
// wired and unit-tested against mocks, not exercised live yet (goes live with S1.9).
import {
    DocumentContentSchema,
    ImageRecordSchema,
    TreatmentRecordSchema,
    type ImageRecord,
    type TreatmentRecord,
} from '../schemas/index.js';
import type { FactBundle } from '../store/index.js';
import type { FhirBundle, PatientResourceType } from '../openemr/fhir.js';
import type { ExtractionDocument } from './extraction.js';

export interface PrepSourceData {
    patient: { id: string; name: string | null };
    documents: ExtractionDocument[];
    images: ImageRecord[];
    treatments: TreatmentRecord[];
}

export interface DocumentSource {
    load(patientId: string, correlationId: string): Promise<PrepSourceData>;
}

// ---- Store-backed source (Tier-1 demo path; seed script has loaded the corpus) ----

/** The one FactStore read the pipeline's load stage needs. */
export interface FactBundleReader {
    getFactBundle(patientId: string): Promise<FactBundle | null>;
}

type SourceDocumentRow = { id: string; document_type: string; document_date: string; content: unknown };

// FactStore has no source-document reader (S1.6 shipped insert-only), so this source
// queries the table directly through the pool — adaptation confined to src/prep/.
export interface SourceDocumentQuerier {
    query(text: string, values: unknown[]): Promise<{ rows: SourceDocumentRow[] }>;
}

export class StoreDocumentSource implements DocumentSource {
    constructor(
        private readonly store: FactBundleReader,
        private readonly db: SourceDocumentQuerier,
    ) {}

    async load(patientId: string, _correlationId: string): Promise<PrepSourceData> {
        const bundle = await this.store.getFactBundle(patientId);
        if (bundle === null) {
            throw new Error(`patient ${patientId} is not registered in the fact store`);
        }
        const result = await this.db.query(
            `SELECT id, document_type, document_date::text AS document_date, content
             FROM source_documents WHERE patient_id = $1 ORDER BY document_date, id`,
            [patientId],
        );
        const documents = result.rows.map((row): ExtractionDocument => {
            const content = DocumentContentSchema.parse(row.content);
            return {
                id: row.id,
                document_type: row.document_type,
                document_date: row.document_date,
                text: content.text_content ?? '',
            };
        });
        return {
            patient: { id: bundle.patient.id, name: bundle.patient.name },
            documents,
            // Stored rows reassemble to the exact engine-input shapes via the landed schemas.
            images: bundle.images.map((image) => ImageRecordSchema.parse(image)),
            treatments: bundle.treatments.map((treatment) => TreatmentRecordSchema.parse(treatment.payload)),
        };
    }
}

// ---- FHIR-backed source (background preparer credential; ARCHITECTURE.md §2/§3) ----

/** The two FhirClient reads this source needs (FhirClient satisfies it structurally). */
export interface FhirReader {
    getPatient(patientId: string, correlationId: string): Promise<Record<string, unknown>>;
    searchByPatient(
        resourceType: PatientResourceType,
        patientId: string,
        correlationId: string,
    ): Promise<FhirBundle>;
}

// Imaging analytics stay store-backed (authored ai_analysis metadata has no FHIR home —
// DECISIONS.md "imaging metadata authored at seed time"), so images/treatments are empty here.
export class FhirDocumentSource implements DocumentSource {
    constructor(private readonly fhir: FhirReader) {}

    async load(patientId: string, correlationId: string): Promise<PrepSourceData> {
        const [patient, docBundle] = await Promise.all([
            this.fhir.getPatient(patientId, correlationId),
            this.fhir.searchByPatient('DocumentReference', patientId, correlationId),
        ]);
        const documents = (docBundle.entry ?? [])
            .map((entry) => documentReferenceToDocument(entry.resource))
            .filter((doc): doc is ExtractionDocument => doc !== undefined && doc.text !== '');
        return {
            patient: { id: patientId, name: humanNameOf(patient) },
            documents,
            images: [],
            treatments: [],
        };
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

// FHIR Patient.name[0] -> "Given Family"; null when the resource carries no usable name.
function humanNameOf(patient: Record<string, unknown>): string | null {
    const names = patient['name'];
    const first = Array.isArray(names) ? (names[0] as unknown) : undefined;
    if (!isRecord(first)) {
        return null;
    }
    const given = Array.isArray(first['given'])
        ? first['given'].filter((part): part is string => typeof part === 'string')
        : [];
    const family = asString(first['family']);
    const full = [...given, family].filter(Boolean).join(' ');
    return full === '' ? null : full;
}

// DocumentReference -> ExtractionDocument: text comes from the first attachment with
// inline base64 data (OpenEMR inlines document content); non-text documents are skipped.
function documentReferenceToDocument(resource: Record<string, unknown> | undefined): ExtractionDocument | undefined {
    if (!isRecord(resource) || resource['resourceType'] !== 'DocumentReference') {
        return undefined;
    }
    const id = asString(resource['id']);
    if (id === undefined) {
        return undefined;
    }
    const type = isRecord(resource['type']) ? resource['type'] : undefined;
    const contentList = Array.isArray(resource['content']) ? resource['content'] : [];
    let text = '';
    for (const item of contentList) {
        if (!isRecord(item) || !isRecord(item['attachment'])) {
            continue;
        }
        const data = asString(item['attachment']['data']);
        const contentType = asString(item['attachment']['contentType']) ?? 'text/plain';
        if (data !== undefined && contentType.startsWith('text/')) {
            text = Buffer.from(data, 'base64').toString('utf8');
            break;
        }
    }
    return {
        id,
        document_type: asString(type?.['text']) ?? 'clinical_note',
        document_date: asString(resource['date']) ?? '',
        text,
    };
}
