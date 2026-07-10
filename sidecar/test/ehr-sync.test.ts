// EHR sync tests (E2): the pure FHIR->fact mapper and the sync orchestration. No live EHR,
// no Postgres. Each test names the failure mode it guards.
import { describe, expect, it, vi } from 'vitest';
import { runCitationGate, type Claim } from '../src/gate/citationGate.js';
import {
    buildEhrSnapshot,
    ehrSnapshotDocumentId,
    EhrSyncService,
    type EhrSyncStore,
} from '../src/openemr/ehrSync.js';
import { DocumentContentSchema, DocumentMetadataSchema } from '../src/schemas/index.js';
import type { FhirBundle, FhirClient, PatientResourceType } from '../src/openemr/fhir.js';

function bundle(...resources: Record<string, unknown>[]): FhirBundle {
    return { resourceType: 'Bundle', entry: resources.map((resource) => ({ resource })) };
}

const ALLERGY = {
    resourceType: 'AllergyIntolerance',
    code: { text: 'Sulfonamides' },
    reaction: [{ manifestation: [{ text: 'Rash' }] }],
};
const CONDITION = {
    resourceType: 'Condition',
    code: { text: 'Rheumatoid arthritis', coding: [{ system: 'http://hl7.org/fhir/sid/icd-10-cm', code: 'M06.9' }] },
    clinicalStatus: { coding: [{ code: 'active' }] },
};
const MEDICATION = {
    resourceType: 'MedicationRequest',
    medicationCodeableConcept: { text: 'Hydroxychloroquine' },
    dosageInstruction: [{ text: '200 mg daily' }],
};
const IOP_OBS = {
    resourceType: 'Observation',
    code: { text: 'Intraocular pressure' },
    valueQuantity: { value: 24, unit: 'mmHg' },
};
const ENCOUNTER = {
    resourceType: 'Encounter',
    reasonCode: [{ text: 'New patient examination — floaters and flashes, right eye' }],
    period: { start: '2024-12-26T08:00:00Z' },
    class: { code: 'AMB', display: 'ambulatory' },
};

const BUNDLES: Partial<Record<PatientResourceType, FhirBundle>> = {
    AllergyIntolerance: bundle(ALLERGY),
    Condition: bundle(CONDITION),
    MedicationRequest: bundle(MEDICATION),
    Observation: bundle(IOP_OBS),
    Encounter: bundle(ENCOUNTER),
};

const NOW = '2026-07-08T14:00:00.000Z';

describe('buildEhrSnapshot', () => {
    // Guards: FHIR shapes mismapped — each resource type must land as the right fact type
    // with its key fields extracted.
    it('maps allergy/condition/medication/observation/encounter resources to typed facts', () => {
        const { facts, resourceCounts } = buildEhrSnapshot(BUNDLES, 'margaret-chen', NOW);
        expect(resourceCounts).toEqual({ AllergyIntolerance: 1, Condition: 1, MedicationRequest: 1, Observation: 1, Encounter: 1 });
        const byType = Object.fromEntries(facts.map((f) => [f.fact_type, f.content]));
        expect(byType['allergy']).toMatchObject({ substance: 'Sulfonamides', reaction: 'Rash' });
        expect(byType['condition']).toMatchObject({ name: 'Rheumatoid arthritis', icd10: 'M06.9', status: 'active' });
        expect(byType['medication']).toMatchObject({ name: 'Hydroxychloroquine', dose: '200 mg daily' });
        expect(byType['vital_sign']).toMatchObject({ name: 'IOP', value: 24, units: 'mmHg' });
        // P4 depth: the visit trail syncs as procedure_history with the reason + visit date.
        expect(byType['procedure_history']).toMatchObject({
            procedure: 'New patient examination — floaters and flashes, right eye',
            date: '2024-12-26',
        });
    });

    // Guards: THE integration invariant — EHR facts must pass the same citation gate as
    // every other fact. Each fact's excerpt must resolve by exact range in the snapshot doc.
    it('produces facts whose citations all resolve through the citation gate', () => {
        const { document, facts } = buildEhrSnapshot(BUNDLES, 'margaret-chen', NOW);
        const text = (document.content as { text_content: string }).text_content;
        const docId = ehrSnapshotDocumentId('margaret-chen');
        const claims: Claim[] = facts.map((fact) => ({ id: fact.id, citations: fact.sources as Claim['citations'] }));
        const gate = runCitationGate(claims, (id) => (id === docId ? text : undefined));
        expect(gate.metrics.claims).toBe(5);
        expect(gate.metrics.verified).toBe(5);
        expect(gate.metrics.citationsFailed).toBe(0);
        // Every fact carries the EHR provenance the panel's origin badges read.
        expect(facts.every((f) => (f.sources as { source_type: string }[])[0]!.source_type === 'external_ehr_import')).toBe(true);
        expect(facts.every((f) => f.source_document_id === docId)).toBe(true);
    });

    // Guards: unmappable resources fabricated into facts — a code-less resource is skipped.
    it('skips resources with no usable code and never fabricates', () => {
        const { facts } = buildEhrSnapshot(
            { AllergyIntolerance: bundle({ resourceType: 'AllergyIntolerance' }, ALLERGY) },
            'margaret-chen',
            NOW,
        );
        expect(facts).toHaveLength(1);
        expect((facts[0]!.content as { substance: string }).substance).toBe('Sulfonamides');
    });

    // Guards: an empty record — no resources yields a valid empty snapshot, not a throw.
    it('builds an empty snapshot when no resources are present', () => {
        const { facts, document } = buildEhrSnapshot({}, 'nobody', NOW);
        expect(facts).toHaveLength(0);
        expect((document.content as { text_content: string }).text_content).toContain('OpenEMR live record snapshot');
    });

    // Failure mode (live regression): the fact store validates document content with
    // DocumentContentSchema on insert, but these tests fake the store — a snapshot missing the
    // required 'format' passed the whole suite and 500'd the first real sync in production.
    // Run the store's exact insert-time validators against the built document here.
    it('builds a document that passes the fact store insert validators', () => {
        const { document } = buildEhrSnapshot(BUNDLES, 'margaret-chen', NOW);
        expect(() => DocumentContentSchema.parse(document.content)).not.toThrow();
        expect(() => DocumentMetadataSchema.parse(document.metadata ?? {})).not.toThrow();
        expect(DocumentContentSchema.parse(document.content).format).toBe('text');
    });
});

// ---- Sync orchestration ----

class FakeSyncStore implements EhrSyncStore {
    wiped: string[] = [];
    documents: unknown[] = [];
    facts: unknown[] = [];
    constructor(private readonly patient: { id: string; openemr_patient_id: string | null } | null) {}

    async getPatient(patientId: string) {
        return this.patient !== null && this.patient.id === patientId ? this.patient : null;
    }
    async wipeEhrSnapshot(_patientId: string, snapshotDocumentId: string) {
        this.wiped.push(snapshotDocumentId);
    }
    async insertSourceDocuments(_patientId: string, documents: unknown[]) {
        this.documents.push(...documents);
        return documents.length;
    }
    async insertFacts(_patientId: string, facts: unknown[]) {
        this.facts.push(...facts);
        return facts.length;
    }
}

function fakeFhir(bundles: Partial<Record<PatientResourceType, FhirBundle>>) {
    const searchByPatient = vi.fn(async (resourceType: PatientResourceType) => bundles[resourceType] ?? bundle());
    return { fhir: { searchByPatient } as unknown as FhirClient, searchByPatient };
}

describe('EhrSyncService.sync', () => {
    // Guards: the refresh contract — wipe the prior snapshot THEN write the new doc + facts,
    // reading FHIR for the linked uuid.
    it('wipes then rewrites the snapshot for a linked patient', async () => {
        const store = new FakeSyncStore({ id: 'margaret-chen', openemr_patient_id: 'uuid-123' });
        const { fhir, searchByPatient } = fakeFhir(BUNDLES);
        const result = await new EhrSyncService(fhir, store, () => new Date(NOW)).sync('margaret-chen', 'corr-e');
        expect(result.synced).toBe(true);
        expect(result.factCount).toBe(5);
        expect(store.wiped).toEqual([ehrSnapshotDocumentId('margaret-chen')]);
        expect(store.documents).toHaveLength(1);
        expect(store.facts).toHaveLength(5);
        // FHIR was queried by the linked OpenEMR uuid, not the sidecar id.
        expect(searchByPatient).toHaveBeenCalledWith('Condition', 'uuid-123', 'corr-e');
    });

    // Guards: syncing an unlinked patient hitting the EHR anyway — must no-op cleanly.
    it('no-ops with a reason when the patient is not linked to OpenEMR', async () => {
        const store = new FakeSyncStore({ id: 'margaret-chen', openemr_patient_id: null });
        const { fhir, searchByPatient } = fakeFhir(BUNDLES);
        const result = await new EhrSyncService(fhir, store, () => new Date(NOW)).sync('margaret-chen', 'corr-e');
        expect(result.synced).toBe(false);
        expect(result.reason).toBe('not_linked_to_openemr');
        expect(searchByPatient).not.toHaveBeenCalled();
        expect(store.documents).toHaveLength(0);
    });

    // Guards: an unknown patient — 409-worthy reason, no EHR calls.
    it('no-ops with patient_not_found for an unknown patient', async () => {
        const store = new FakeSyncStore(null);
        const { fhir } = fakeFhir(BUNDLES);
        const result = await new EhrSyncService(fhir, store, () => new Date(NOW)).sync('nobody', 'corr-e');
        expect(result.synced).toBe(false);
        expect(result.reason).toBe('patient_not_found');
    });
});
