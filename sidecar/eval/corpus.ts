// Shared corpus access for the eval suite (S2.5). The seed corpora are AUTHORED GROUND
// TRUTH (execution plan S1.4): Margaret Chen carries 12 source docs, 12 facts, 4
// contradictions with ground truth, and an HCQ imaging trend; William Thompson carries
// 7 OCTs and 4 injections with a 49→71-day interval over-extension. Everything is
// re-parsed through the landed runtime schemas at load, so an eval can never run against
// records the runtime would reject (test/corpus-conformance.test.ts locks that same
// contract as a unit test; here it is a precondition, not the subject).
import { readFileSync } from 'node:fs';
import type { DocumentTextResolver } from '../src/gate/citationGate.js';
import {
    ImageRecordSchema,
    PatientFactSchema,
    TreatmentRecordSchema,
    type ImageRecord,
    type PatientFact,
    type TreatmentRecord,
} from '../src/schemas/index.js';
import type { FactBundle, StoredFact } from '../src/store/index.js';

// ---- Narrow raw shapes for the corpus fields evals read directly (JSON boundary) ----

export interface RawContradictionSource {
    source_document_id?: string;
    filename: string;
    claim: string;
    exact_text: string;
    certainty: string;
}

export interface RawContradiction {
    contradiction_id: string;
    type: string;
    severity: string;
    source_documents: RawContradictionSource[];
}

export interface RawSourceDocument {
    document_id: string;
    filename?: string;
    document_type: string;
    document_date: string;
    content: { text_content?: string };
}

export interface RawCorpus {
    patient: { patient_id: string; name: string } & Record<string, unknown>;
    medications?: unknown[];
    allergies?: unknown[];
    conditions?: unknown[];
    family_history?: unknown[];
    patient_goals?: unknown[];
    chief_complaint?: unknown;
    source_documents: RawSourceDocument[];
    contradictions?: RawContradiction[];
    images: unknown[];
    treatments?: unknown[];
    events?: unknown[];
}

export interface LoadedCorpus {
    /** Patient id, doubles as the corpus id (`margaret-chen`, `william-thompson`). */
    id: string;
    name: string;
    raw: RawCorpus;
    /** Every authored fact, strict-parsed through PatientFactSchema. */
    facts: PatientFact[];
    /** Every authored image record, strict-parsed through ImageRecordSchema. */
    images: ImageRecord[];
    /** Treatments + events in engine shape (the same merge the seeding script performs). */
    treatments: TreatmentRecord[];
    /** Resolves a source document's full text by document id (the gate's resolver). */
    resolveDocumentText: DocumentTextResolver;
    documentTextByFilename: Map<string, string>;
}

function loadCorpus(fileName: string): LoadedCorpus {
    const raw = JSON.parse(
        readFileSync(new URL(`../seed/${fileName}`, import.meta.url), 'utf8'),
    ) as RawCorpus;

    const facts = [
        ...(raw.medications ?? []),
        ...(raw.allergies ?? []),
        ...(raw.conditions ?? []),
        ...(raw.family_history ?? []),
        ...(raw.patient_goals ?? []),
        raw.chief_complaint,
    ]
        .filter((fact) => fact !== undefined && fact !== null)
        .map((fact) => PatientFactSchema.parse(fact));

    const documentTextById = new Map<string, string>(
        raw.source_documents.map((doc) => [doc.document_id, doc.content.text_content ?? '']),
    );
    const documentTextByFilename = new Map<string, string>(
        raw.source_documents
            .filter((doc) => doc.filename !== undefined)
            .map((doc) => [doc.filename as string, doc.content.text_content ?? '']),
    );

    return {
        id: raw.patient.patient_id,
        name: raw.patient.name,
        raw,
        facts,
        images: raw.images.map((image) => ImageRecordSchema.parse(image)),
        treatments: [...(raw.treatments ?? []), ...(raw.events ?? [])].map((treatment) =>
            TreatmentRecordSchema.parse(treatment),
        ),
        resolveDocumentText: (id) => documentTextById.get(id),
        documentTextByFilename,
    };
}

export const margaretChen = loadCorpus('margaret-chen.json');
export const williamThompson = loadCorpus('william-thompson.json');
// Week 2 (D.2): the three previously-idle seed corpora join the eval surface — every
// authored fact in EVERY corpus now rides the citation-validity gate.
export const jamesWhitfield = loadCorpus('james-whitfield.json');
export const patriciaOkafor = loadCorpus('patricia-okafor.json');
export const robertAlvarez = loadCorpus('robert-alvarez.json');
export const CORPORA: readonly LoadedCorpus[] = [
    margaretChen,
    williamThompson,
    jamesWhitfield,
    patriciaOkafor,
    robertAlvarez,
];

// ---- Store-shaped views (what the deployed sidecar serves after seeding) ----

function toStoredFact(fact: PatientFact): StoredFact {
    return {
        id: fact.id,
        patient_id: fact.patient_id,
        fact_type: fact.fact_type,
        content: fact.content,
        is_current: fact.is_current,
        laterality: fact.laterality,
        verification: fact.verification,
        source_document_id: fact.source_document_id,
        sources: fact.sources,
        created_date: fact.created_date ?? null,
        updated_date: fact.updated_date ?? null,
    };
}

/**
 * The seeded-store view of a corpus: authored facts as StoredFact rows under the corpus
 * patient — the bundle shape chat and overview consume. Images and treatments ride along
 * store-shaped (the multi-turn chat evals drive the real imaging tools over them);
 * contradictions stay empty. Chat-citation evals verify spans against these documents' text.
 */
export function seededFactBundle(corpus: LoadedCorpus): FactBundle {
    const { patient_id, name, ...demographics } = corpus.raw.patient;
    return {
        patient: { id: patient_id, openemr_patient_id: null, name, demographics },
        facts: corpus.facts.map(toStoredFact),
        contradictions: [],
        images: corpus.images.map((image) => ({
            ...image,
            id: image.id,
            patient_id: image.patient_id ?? patient_id,
            image_metadata: image.image_metadata,
        })),
        treatments: corpus.treatments.map((treatment) => ({
            id: treatment.id,
            patient_id: treatment.patient_id ?? patient_id,
            treatment_date: treatment.treatment_date,
            payload: treatment as unknown as Record<string, unknown>,
        })),
        documents: corpus.raw.source_documents.map((doc) => ({
            id: doc.document_id,
            document_type: doc.document_type,
            document_date: doc.document_date,
            content: doc.content as unknown as Record<string, unknown>,
            metadata: {},
            extras: {},
        })),
    };
}
