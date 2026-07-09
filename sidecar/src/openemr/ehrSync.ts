// EHR sync (E2): pull a linked patient's live OpenEMR record over FHIR R4 and project it
// into the fact store as facts tagged with EHR provenance — each backed by a citable
// "EHR snapshot" source document so EHR data passes the SAME citation gate as fax/pharmacy
// facts. The store stays a derived view (ARCHITECTURE §2): a re-sync wipes the prior
// snapshot and rewrites it, never accreting duplicates.
import type { FactInput, SourceDocumentInput } from '../store/index.js';
import type { FhirBundle, FhirClient, PatientResourceType } from './fhir.js';

/** The clinical resources we project into facts (Patient is read for linkage, not a fact). */
const SYNCED_RESOURCES: PatientResourceType[] = ['AllergyIntolerance', 'Condition', 'MedicationRequest', 'Observation'];

export interface EhrSyncResult {
    synced: boolean;
    reason?: string;
    factCount: number;
    resourceCounts: Record<string, number>;
    snapshotDocumentId: string;
    syncedAt: string;
}

/** The store surface EHR sync needs (FactStore satisfies it; tests fake it). */
export interface EhrSyncStore {
    getPatient(patientId: string): Promise<{ id: string; openemr_patient_id: string | null } | null>;
    wipeEhrSnapshot(patientId: string, snapshotDocumentId: string): Promise<void>;
    insertSourceDocuments(patientId: string, documents: SourceDocumentInput[]): Promise<number>;
    insertFacts(patientId: string, facts: FactInput[]): Promise<number>;
}

export const ehrSnapshotDocumentId = (patientId: string): string => `ehr-snapshot-${patientId}`;

// ---- Pure FHIR → fact mapping (unit-tested without a store or a live EHR) ----

interface MappedResource {
    factType: 'allergy' | 'condition' | 'medication' | 'clinical_finding' | 'vital_sign';
    content: Record<string, unknown>;
    laterality: string | null;
    /** The one-line human rendering that becomes both the snapshot text and the citation excerpt. */
    line: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** CodeableConcept.text, else the first coding's display/code. */
function conceptText(concept: unknown): string | undefined {
    if (!isRecord(concept)) {
        return undefined;
    }
    const text = asString(concept['text']);
    if (text !== undefined) {
        return text;
    }
    const coding = Array.isArray(concept['coding']) ? concept['coding'] : [];
    for (const entry of coding) {
        const display = isRecord(entry) ? asString(entry['display']) ?? asString(entry['code']) : undefined;
        if (display !== undefined) {
            return display;
        }
    }
    return undefined;
}

/** The first ICD-10 code in a CodeableConcept, if any. */
function icd10Of(concept: unknown): string | undefined {
    if (!isRecord(concept) || !Array.isArray(concept['coding'])) {
        return undefined;
    }
    for (const entry of concept['coding']) {
        if (isRecord(entry) && typeof entry['system'] === 'string' && entry['system'].includes('icd-10')) {
            const code = asString(entry['code']);
            if (code !== undefined) {
                return code;
            }
        }
    }
    return undefined;
}

function mapAllergy(resource: Record<string, unknown>): MappedResource | null {
    const substance = conceptText(resource['code']);
    if (substance === undefined) {
        return null;
    }
    const reactions = Array.isArray(resource['reaction']) ? resource['reaction'] : [];
    const manifestations = reactions
        .flatMap((r) => (isRecord(r) && Array.isArray(r['manifestation']) ? r['manifestation'] : []))
        .map((m) => conceptText(m))
        .filter((t): t is string => t !== undefined);
    const reaction = manifestations.length > 0 ? manifestations.join(', ') : undefined;
    const content: Record<string, unknown> = { substance };
    if (reaction !== undefined) {
        content['reaction'] = reaction;
    }
    return {
        factType: 'allergy',
        content,
        laterality: null,
        line: `Allergy: ${substance}${reaction !== undefined ? ` — reaction: ${reaction}` : ''}`,
    };
}

function mapCondition(resource: Record<string, unknown>): MappedResource | null {
    const name = conceptText(resource['code']);
    if (name === undefined) {
        return null;
    }
    const icd10 = icd10Of(resource['code']);
    const clinicalStatus = conceptText(resource['clinicalStatus'])?.toLowerCase();
    const status = clinicalStatus === 'active' || clinicalStatus === 'resolved' ? clinicalStatus : undefined;
    const content: Record<string, unknown> = { name };
    if (icd10 !== undefined) {
        content['icd10'] = icd10;
    }
    if (status !== undefined) {
        content['status'] = status;
    }
    return {
        factType: 'condition',
        content,
        laterality: null,
        line: `Condition: ${name}${icd10 !== undefined ? ` (ICD-10 ${icd10})` : ''}${status !== undefined ? ` — ${status}` : ''}`,
    };
}

function mapMedication(resource: Record<string, unknown>): MappedResource | null {
    const name = conceptText(resource['medicationCodeableConcept']);
    if (name === undefined) {
        return null;
    }
    const dosage = Array.isArray(resource['dosageInstruction']) ? resource['dosageInstruction'] : [];
    const doseText = dosage.map((d) => (isRecord(d) ? asString(d['text']) : undefined)).find((t) => t !== undefined);
    const content: Record<string, unknown> = { name };
    if (doseText !== undefined) {
        content['dose'] = doseText;
    }
    return {
        factType: 'medication',
        content,
        laterality: null,
        line: `Medication: ${name}${doseText !== undefined ? ` — ${doseText}` : ''}`,
    };
}

// IOP observations become vital_sign facts (the imaging surfaces read those); everything
// else becomes a clinical_finding so nothing structured is invented.
function mapObservation(resource: Record<string, unknown>): MappedResource | null {
    const name = conceptText(resource['code']);
    if (name === undefined) {
        return null;
    }
    const quantity = isRecord(resource['valueQuantity']) ? resource['valueQuantity'] : undefined;
    const value = quantity !== undefined && typeof quantity['value'] === 'number' ? quantity['value'] : undefined;
    const units = quantity !== undefined ? asString(quantity['unit']) : undefined;
    const valueText = asString(resource['valueString']);
    const rendered = value !== undefined ? `${value}${units !== undefined ? ` ${units}` : ''}` : valueText;
    if (/\biop\b|intraocular pressure/i.test(name) && value !== undefined) {
        const content: Record<string, unknown> = { name: 'IOP', value };
        if (units !== undefined) {
            content['units'] = units;
        }
        return { factType: 'vital_sign', content, laterality: null, line: `IOP: ${value}${units !== undefined ? ` ${units}` : ''}` };
    }
    const content: Record<string, unknown> = { finding: name };
    if (rendered !== undefined) {
        content['source'] = rendered;
    }
    return {
        factType: 'clinical_finding',
        content,
        laterality: null,
        line: `Observation: ${name}${rendered !== undefined ? ` — ${rendered}` : ''}`,
    };
}

const MAPPERS: Record<PatientResourceType, ((r: Record<string, unknown>) => MappedResource | null) | undefined> = {
    AllergyIntolerance: mapAllergy,
    Condition: mapCondition,
    MedicationRequest: mapMedication,
    Observation: mapObservation,
    Patient: undefined,
    DiagnosticReport: undefined,
    DocumentReference: undefined,
    Encounter: undefined,
};

function bundleResources(bundle: FhirBundle): Record<string, unknown>[] {
    return (bundle.entry ?? [])
        .map((entry) => entry.resource)
        .filter((resource): resource is Record<string, unknown> => isRecord(resource));
}

export interface SnapshotBuild {
    document: SourceDocumentInput;
    facts: FactInput[];
    resourceCounts: Record<string, number>;
}

/**
 * Assemble the snapshot document + facts from the per-resource-type bundles. The document's
 * text_content is one line per fact; each fact's citation excerpt is exactly that line with
 * true character offsets, so the citation gate resolves every EHR fact by range.
 */
export function buildEhrSnapshot(
    bundles: Partial<Record<PatientResourceType, FhirBundle>>,
    patientId: string,
    syncedAt: string,
): SnapshotBuild {
    const documentId = ehrSnapshotDocumentId(patientId);
    const date = syncedAt.slice(0, 10);
    const resourceCounts: Record<string, number> = {};
    const mapped: MappedResource[] = [];
    for (const resourceType of SYNCED_RESOURCES) {
        const mapper = MAPPERS[resourceType];
        const bundle = bundles[resourceType];
        if (mapper === undefined || bundle === undefined) {
            continue;
        }
        const results = bundleResources(bundle)
            .map((resource) => mapper(resource))
            .filter((m): m is MappedResource => m !== null);
        resourceCounts[resourceType] = results.length;
        mapped.push(...results);
    }

    // Build the document text and each fact's exact excerpt offsets in one pass.
    const header = `OpenEMR live record snapshot — synced ${syncedAt}`;
    const lines = [header, ...mapped.map((m) => m.line)];
    const text = lines.join('\n');
    const facts: FactInput[] = [];
    let cursor = header.length + 1; // char offset where the first fact line begins
    mapped.forEach((m, index) => {
        const start = cursor;
        const end = start + m.line.length;
        cursor = end + 1; // +1 for the joining newline
        const factId = `ehr-${patientId}-${index + 1}`;
        facts.push({
            id: factId,
            patient_id: patientId,
            fact_type: m.factType,
            content: m.content,
            is_current: true,
            laterality: m.laterality,
            verification: { status: 'unverified' },
            source_document_id: documentId,
            sources: [
                {
                    id: `${factId}-c1`,
                    fact_id: factId,
                    source_label: 'OpenEMR EHR',
                    source_type: 'external_ehr_import',
                    excerpt_text: m.line,
                    excerpt_location: { type: 'character_range', start_char: start, end_char: end, context_before: null, context_after: null },
                    attribution: { speaker_role: 'system' },
                    source_document_id: documentId,
                    document_date: date,
                },
            ],
            created_date: date,
            updated_date: date,
        });
    });

    const document: SourceDocumentInput = {
        id: documentId,
        patient_id: patientId,
        document_type: 'ehr_import',
        document_date: date,
        // format is required by DocumentContentSchema — the store rejects the insert without it.
        content: { format: 'text', text_content: text },
        metadata: { source_system: 'openemr_fhir', imported_at: syncedAt },
    };
    return { document, facts, resourceCounts };
}

export class EhrSyncService {
    constructor(
        private readonly fhir: FhirClient,
        private readonly store: EhrSyncStore,
        private readonly clock: () => Date = () => new Date(),
    ) {}

    async sync(patientId: string, correlationId: string): Promise<EhrSyncResult> {
        const syncedAt = this.clock().toISOString();
        const snapshotDocumentId = ehrSnapshotDocumentId(patientId);
        const patient = await this.store.getPatient(patientId);
        if (patient === null) {
            return { synced: false, reason: 'patient_not_found', factCount: 0, resourceCounts: {}, snapshotDocumentId, syncedAt };
        }
        if (patient.openemr_patient_id === null) {
            // Not linked to an OpenEMR record yet (run seed-ehr first) — a clean no-op, not an error.
            return { synced: false, reason: 'not_linked_to_openemr', factCount: 0, resourceCounts: {}, snapshotDocumentId, syncedAt };
        }

        const bundles: Partial<Record<PatientResourceType, FhirBundle>> = {};
        for (const resourceType of SYNCED_RESOURCES) {
            bundles[resourceType] = await this.fhir.searchByPatient(resourceType, patient.openemr_patient_id, correlationId);
        }

        const { document, facts, resourceCounts } = buildEhrSnapshot(bundles, patientId, syncedAt);
        // Refresh semantics: drop the prior snapshot (facts + doc) before rewriting.
        await this.store.wipeEhrSnapshot(patientId, snapshotDocumentId);
        await this.store.insertSourceDocuments(patientId, [document]);
        await this.store.insertFacts(patientId, facts);
        return { synced: true, factCount: facts.length, resourceCounts, snapshotDocumentId, syncedAt };
    }
}
