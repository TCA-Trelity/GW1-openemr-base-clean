// Corpus → OpenEMR mapping + idempotent per-patient seeding (E1). Pure functions build the
// exact payloads the standard-API validators accept (citations in ./standardApi.ts); the
// orchestrator searches before creating so re-runs converge instead of duplicating.
import { z } from 'zod';
import {
    StandardApiClient,
    type EhrAllergyPayload,
    type EhrMedicationPayload,
    type EhrPatientPayload,
    type EhrProblemPayload,
} from './standardApi.js';

// ---- Corpus shapes (only the slices this script consumes; extras pass through untouched) ----

const CorpusPatientSchema = z
    .object({
        patient_id: z.string().min(1),
        name: z.string().min(1),
        dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        sex: z.string().min(1),
        mrn: z.string().min(1).optional(),
        address: z.string().min(1).optional(),
        phone: z.string().min(1).optional(),
    })
    .passthrough();

const CorpusFactSchema = z
    .object({
        id: z.string().min(1),
        fact_type: z.string().min(1),
        is_current: z.boolean().optional(),
        content: z.record(z.unknown()),
    })
    .passthrough();

export const EhrSeedCorpusSchema = z
    .object({
        patient: CorpusPatientSchema,
        medications: z.array(CorpusFactSchema).default([]),
        allergies: z.array(CorpusFactSchema).default([]),
        conditions: z.array(CorpusFactSchema).default([]),
    })
    .passthrough();

export type EhrSeedCorpus = z.infer<typeof EhrSeedCorpusSchema>;
type CorpusFact = z.infer<typeof CorpusFactSchema>;

// ---- Field-level mapping helpers ----

export interface PersonName {
    fname: string;
    mname?: string;
    lname: string;
}

// Corpus names are "First [Middles…] Last" (e.g. "Margaret L. Chen"). No suffix handling —
// the corpus has none, and lname is what the idempotency search keys on.
export function parsePersonName(name: string): PersonName {
    const tokens = name.trim().split(/\s+/);
    const fname = tokens[0] ?? '';
    if (tokens.length < 2) {
        return { fname, lname: '' };
    }
    const lname = tokens[tokens.length - 1] ?? '';
    const middles = tokens.slice(1, -1).join(' ');
    return middles === '' ? { fname, lname } : { fname, mname: middles, lname };
}

export interface UsAddress {
    street: string;
    city?: string;
    state?: string;
    postal_code?: string;
}

// Corpus addresses are single-line US format: "915 Delaney Park Drive, Orlando, FL 32806".
// Anything that doesn't parse keeps the whole line as street — the fields are optional anyway.
export function parseUsAddress(address: string): UsAddress {
    const parts = address.split(',').map((part) => part.trim());
    if (parts.length < 3) {
        return { street: address.trim() };
    }
    const stateZip = /^([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/.exec(parts[parts.length - 1] ?? '');
    if (stateZip === null) {
        return { street: address.trim() };
    }
    return {
        street: parts.slice(0, -2).join(', '),
        city: parts[parts.length - 2] ?? '',
        state: stateZip[1] ?? '',
        postal_code: stateZip[2] ?? '',
    };
}

// PatientValidator requires sex to be 4-30 chars (PatientValidator.php:58), so the corpus
// M/F codes must expand to the list_options values the UI uses.
export function mapSex(sex: string): string {
    switch (sex.trim().toUpperCase()) {
        case 'M':
        case 'MALE':
            return 'Male';
        case 'F':
        case 'FEMALE':
            return 'Female';
        default:
            return 'Unknown';
    }
}

/** Corpus partial dates ("2018", "2018-03") → first day; full dates pass through; else undefined. */
export function normalizeDate(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        return trimmed;
    }
    if (/^\d{4}-\d{2}$/.test(trimmed)) {
        return `${trimmed}-01`;
    }
    if (/^\d{4}$/.test(trimmed)) {
        return `${trimmed}-01-01`;
    }
    return undefined;
}

function contentString(fact: CorpusFact, key: string): string | undefined {
    const value = fact.content[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

// ---- Payload builders ----

export function buildPatientPayload(patient: EhrSeedCorpus['patient']): EhrPatientPayload {
    const { fname, mname, lname } = parsePersonName(patient.name);
    const payload: EhrPatientPayload = {
        fname,
        lname,
        DOB: patient.dob,
        sex: mapSex(patient.sex),
    };
    if (mname !== undefined) {
        payload.mname = mname;
    }
    if (patient.address !== undefined) {
        const { street, city, state, postal_code } = parseUsAddress(patient.address);
        payload.street = street;
        if (city !== undefined) {
            payload.city = city;
        }
        if (state !== undefined) {
            payload.state = state;
        }
        if (postal_code !== undefined) {
            payload.postal_code = postal_code;
        }
    }
    if (patient.phone !== undefined) {
        payload.phone_contact = patient.phone;
    }
    if (patient.mrn !== undefined) {
        payload.pubpid = patient.mrn;
    }
    return payload;
}

export interface SkippedFact {
    factId: string;
    reason: string;
}

export interface BuiltPayloads<T> {
    payloads: T[];
    skipped: SkippedFact[];
}

// The corpus conditions array mixes fact types (condition / vital_sign / procedure_history);
// only true conditions belong on the problem list. begdate is required by ConditionValidator,
// so a condition without a parseable onset is skipped honestly rather than given a fake date.
export function buildProblemPayloads(corpus: EhrSeedCorpus): BuiltPayloads<EhrProblemPayload> {
    const payloads: EhrProblemPayload[] = [];
    const skipped: SkippedFact[] = [];
    for (const fact of corpus.conditions) {
        if (fact.fact_type !== 'condition') {
            skipped.push({ factId: fact.id, reason: `fact_type ${fact.fact_type} is not a problem-list condition` });
            continue;
        }
        const title = contentString(fact, 'name');
        if (title === undefined || title.length < 2) {
            skipped.push({ factId: fact.id, reason: 'condition has no usable name' });
            continue;
        }
        const begdate = normalizeDate(fact.content['since']);
        if (begdate === undefined) {
            skipped.push({ factId: fact.id, reason: 'condition has no parseable onset date (begdate is required)' });
            continue;
        }
        const icd10 = contentString(fact, 'icd10');
        const payload: EhrProblemPayload = { title: title.slice(0, 255), begdate };
        if (icd10 !== undefined) {
            payload.diagnosis = `ICD10:${icd10}`; // lists.diagnosis code-type prefix (BaseService::addCoding parses "TYPE:code")
        }
        payloads.push(payload);
    }
    return { payloads, skipped };
}

export function buildAllergyPayloads(corpus: EhrSeedCorpus): BuiltPayloads<EhrAllergyPayload> {
    const payloads: EhrAllergyPayload[] = [];
    const skipped: SkippedFact[] = [];
    for (const fact of corpus.allergies) {
        if (fact.fact_type !== 'allergy') {
            skipped.push({ factId: fact.id, reason: `fact_type ${fact.fact_type} is not an allergy` });
            continue;
        }
        const substance = contentString(fact, 'substance');
        if (substance === undefined || substance.length < 2) {
            skipped.push({ factId: fact.id, reason: 'allergy has no usable substance' });
            continue;
        }
        const reaction = contentString(fact, 'reaction');
        const severity = contentString(fact, 'severity');
        const commentParts = [
            reaction === undefined ? undefined : `Reaction: ${reaction}`,
            severity === undefined ? undefined : `Severity: ${severity}`,
        ].filter((part): part is string => part !== undefined);
        const payload: EhrAllergyPayload = { title: substance.slice(0, 255) };
        if (commentParts.length > 0) {
            payload.comments = commentParts.join('. ');
        }
        payloads.push(payload);
    }
    return { payloads, skipped };
}

// The medication list route has no dose/frequency columns (lists: title/begdate/enddate/diagnosis
// only), so dose and frequency are encoded into the human-readable title the same way the
// OpenEMR UI free-text medication entry works.
export function buildMedicationPayloads(corpus: EhrSeedCorpus): BuiltPayloads<EhrMedicationPayload> {
    const payloads: EhrMedicationPayload[] = [];
    const skipped: SkippedFact[] = [];
    for (const fact of corpus.medications) {
        if (fact.fact_type !== 'medication') {
            skipped.push({ factId: fact.id, reason: `fact_type ${fact.fact_type} is not a medication` });
            continue;
        }
        if (fact.is_current === false) {
            skipped.push({ factId: fact.id, reason: 'medication is not current' });
            continue;
        }
        const name = contentString(fact, 'name');
        if (name === undefined || name.length < 2) {
            skipped.push({ factId: fact.id, reason: 'medication has no usable name' });
            continue;
        }
        const title = [name, contentString(fact, 'dose'), contentString(fact, 'frequency')]
            .filter((part): part is string => part !== undefined)
            .join(' ');
        const startDate = normalizeDate(fact.content['start_date']);
        payloads.push({
            title: title.slice(0, 255),
            begdate: startDate === undefined ? null : `${startDate} 00:00:00`,
            enddate: null,
            diagnosis: null,
        });
    }
    return { payloads, skipped };
}

// ---- Idempotent per-patient orchestration ----

export interface SeedListOutcome {
    created: number;
    existing: number;
    skipped: SkippedFact[];
}

export interface SeedPatientOutcome {
    patientId: string;
    action: 'created' | 'found';
    uuid: string;
    pid: string;
    problems: SeedListOutcome;
    allergies: SeedListOutcome;
    medications: SeedListOutcome;
}

/**
 * Seeds one corpus patient into OpenEMR, idempotently:
 * search by fname+lname+DOB and reuse the match, else create; then create only the
 * problem/allergy/medication list entries whose titles are not already on the chart.
 */
export async function seedPatientIntoEhr(api: StandardApiClient, corpus: EhrSeedCorpus): Promise<SeedPatientOutcome> {
    const payload = buildPatientPayload(corpus.patient);
    const matches = await api.searchPatients({ fname: payload.fname, lname: payload.lname, DOB: payload.DOB });
    // Server-side search matching may be broader than exact, so re-check identity locally.
    const match = matches.find(
        (row) =>
            row.fname.toLowerCase() === payload.fname.toLowerCase() &&
            row.lname.toLowerCase() === payload.lname.toLowerCase() &&
            row.dob === payload.DOB,
    );
    const action: SeedPatientOutcome['action'] = match === undefined ? 'created' : 'found';
    const { uuid, pid } = match ?? (await api.createPatient(payload));

    const problems = await seedList(buildProblemPayloads(corpus), () => api.listMedicalProblemTitles(uuid), (item) => api.createMedicalProblem(uuid, item));
    const allergies = await seedList(buildAllergyPayloads(corpus), () => api.listAllergyTitles(uuid), (item) => api.createAllergy(uuid, item));
    const medications = await seedList(buildMedicationPayloads(corpus), () => api.listMedicationTitles(pid), (item) => api.createMedication(pid, item));

    return { patientId: corpus.patient.patient_id, action, uuid, pid, problems, allergies, medications };
}

async function seedList<T extends { title: string }>(
    built: BuiltPayloads<T>,
    listTitles: () => Promise<string[]>,
    create: (item: T) => Promise<void>,
): Promise<SeedListOutcome> {
    // Nothing to write means nothing to read: skip the list fetch entirely.
    if (built.payloads.length === 0) {
        return { created: 0, existing: 0, skipped: built.skipped };
    }
    const existingTitles = new Set((await listTitles()).map((title) => title.toLowerCase()));
    let created = 0;
    let existing = 0;
    for (const item of built.payloads) {
        if (existingTitles.has(item.title.toLowerCase())) {
            existing += 1;
            continue;
        }
        await create(item);
        existingTitles.add(item.title.toLowerCase());
        created += 1;
    }
    return { created, existing, skipped: built.skipped };
}
