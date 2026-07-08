// DocumentSource implementations (S1.7): StoreDocumentSource reads the seeded fact store
// (the Tier-1 demo path); FhirDocumentSource reads OpenEMR via src/openemr/fhir.ts —
// wired and unit-tested against mocks, not exercised live yet (goes live with S1.9).
import { DocumentContentSchema, ImageRecordSchema, TreatmentRecordSchema, } from '../schemas/index.js';
export class StoreDocumentSource {
    store;
    db;
    constructor(store, db) {
        this.store = store;
        this.db = db;
    }
    async load(patientId, _correlationId) {
        const bundle = await this.store.getFactBundle(patientId);
        if (bundle === null) {
            throw new Error(`patient ${patientId} is not registered in the fact store`);
        }
        const result = await this.db.query(`SELECT id, document_type, document_date::text AS document_date, content
             FROM source_documents WHERE patient_id = $1 ORDER BY document_date, id`, [patientId]);
        const documents = result.rows.map((row) => {
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
// Imaging analytics stay store-backed (authored ai_analysis metadata has no FHIR home —
// DECISIONS.md "imaging metadata authored at seed time"), so images/treatments are empty here.
export class FhirDocumentSource {
    fhir;
    constructor(fhir) {
        this.fhir = fhir;
    }
    async load(patientId, correlationId) {
        const [patient, docBundle] = await Promise.all([
            this.fhir.getPatient(patientId, correlationId),
            this.fhir.searchByPatient('DocumentReference', patientId, correlationId),
        ]);
        const documents = (docBundle.entry ?? [])
            .map((entry) => documentReferenceToDocument(entry.resource))
            .filter((doc) => doc !== undefined && doc.text !== '');
        return {
            patient: { id: patientId, name: humanNameOf(patient) },
            documents,
            images: [],
            treatments: [],
        };
    }
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function asString(value) {
    return typeof value === 'string' ? value : undefined;
}
// FHIR Patient.name[0] -> "Given Family"; null when the resource carries no usable name.
function humanNameOf(patient) {
    const names = patient['name'];
    const first = Array.isArray(names) ? names[0] : undefined;
    if (!isRecord(first)) {
        return null;
    }
    const given = Array.isArray(first['given'])
        ? first['given'].filter((part) => typeof part === 'string')
        : [];
    const family = asString(first['family']);
    const full = [...given, family].filter(Boolean).join(' ');
    return full === '' ? null : full;
}
// DocumentReference -> ExtractionDocument: text comes from the first attachment with
// inline base64 data (OpenEMR inlines document content); non-text documents are skipped.
function documentReferenceToDocument(resource) {
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
//# sourceMappingURL=sources.js.map