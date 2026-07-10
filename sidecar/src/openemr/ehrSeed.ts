// Corpus → OpenEMR mapping + idempotent per-patient seeding (E1). Pure functions build the
// exact payloads the standard-API validators accept (citations in ./standardApi.ts); the
// orchestrator searches before creating so re-runs converge instead of duplicating.
import { z } from 'zod';
import {
    StandardApiClient,
    StandardApiError,
    type EhrAllergyPayload,
    type EhrAppointmentPayload,
    type EhrEncounterPayload,
    type EhrInsurancePayload,
    type EhrMedicationPayload,
    type EhrPatientPayload,
    type EhrProblemPayload,
    type EhrSoapNotePayload,
    type EhrVitalPayload,
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

// P4 record depth: authored per-patient EHR extras (strict — this is hand-written data, so a
// typo should fail the corpus-conformance test, not silently drop a field on the live chart).
const CorpusVitalsSchema = z
    .object({
        bps: z.number().optional(),
        bpd: z.number().optional(),
        pulse: z.number().optional(),
        respiration: z.number().optional(),
        temperature: z.number().optional(),
        oxygen_saturation: z.number().optional(),
        weight_lb: z.number().optional(),
        height_in: z.number().optional(),
        note: z.string().min(1).max(255).optional(),
    })
    .strict();

const CorpusEncounterSchema = z
    .object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        reason: z.string().min(2).max(255),
        class_code: z.string().min(2).default('AMB'),
        vitals: CorpusVitalsSchema.optional(),
        soap: z
            .object({
                subjective: z.string().min(1).optional(),
                objective: z.string().min(1).optional(),
                assessment: z.string().min(1).optional(),
                plan: z.string().min(1).optional(),
            })
            .strict()
            .optional(),
    })
    .strict();

const CorpusAppointmentSchema = z
    .object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        start_time: z.string().regex(/^\d{2}:\d{2}$/),
        duration_minutes: z.number().int().positive().default(30),
        title: z.string().min(2).max(150),
        note: z.string().min(1),
        status: z.string().min(1).default('-'),
    })
    .strict();

const CorpusInsuranceSchema = z
    .object({
        company: z.string().min(2).max(255),
        plan_name: z.string().min(1).optional(),
        policy_number: z.string().min(1),
        group_number: z.string().min(1).optional(),
        effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .strict();

// Only columns the POST/PUT /api/patient route actually persists (patient_data);
// no emergency-contact seeding — the standard API exposes no clean column pair for it.
const CorpusEhrDemographicsSchema = z
    .object({
        email: z.string().min(3).optional(),
        phone_cell: z.string().min(7).optional(),
        phone_home: z.string().min(7).optional(),
        language: z.string().min(2).optional(),
        ethnicity: z.string().min(2).optional(),
        race: z.string().min(2).optional(),
        status: z.string().min(2).optional(),
        occupation: z.string().min(2).optional(),
    })
    .strict();

const CorpusEhrExtrasSchema = z
    .object({
        demographics: CorpusEhrDemographicsSchema.optional(),
        insurance: CorpusInsuranceSchema.optional(),
        encounters: z.array(CorpusEncounterSchema).default([]),
        appointments: z.array(CorpusAppointmentSchema).default([]),
    })
    .strict();

export const EhrSeedCorpusSchema = z
    .object({
        patient: CorpusPatientSchema,
        medications: z.array(CorpusFactSchema).default([]),
        allergies: z.array(CorpusFactSchema).default([]),
        conditions: z.array(CorpusFactSchema).default([]),
        ehr: CorpusEhrExtrasSchema.optional(),
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

export function buildPatientPayload(patient: EhrSeedCorpus['patient'], demographics?: z.infer<typeof CorpusEhrDemographicsSchema>): EhrPatientPayload {
    const { fname, mname, lname } = parsePersonName(patient.name);
    const payload: EhrPatientPayload = {
        fname,
        lname,
        DOB: patient.dob,
        sex: mapSex(patient.sex),
    };
    // P4 depth: authored demographics ride the same patient write (all optional columns).
    // Field-by-field (not a spread): exactOptionalPropertyTypes forbids `key: undefined`.
    if (demographics !== undefined) {
        if (demographics.email !== undefined) {
            payload.email = demographics.email;
        }
        if (demographics.phone_cell !== undefined) {
            payload.phone_cell = demographics.phone_cell;
        }
        if (demographics.phone_home !== undefined) {
            payload.phone_home = demographics.phone_home;
        }
        if (demographics.language !== undefined) {
            payload.language = demographics.language;
        }
        if (demographics.ethnicity !== undefined) {
            payload.ethnicity = demographics.ethnicity;
        }
        if (demographics.race !== undefined) {
            payload.race = demographics.race;
        }
        if (demographics.status !== undefined) {
            payload.status = demographics.status;
        }
        if (demographics.occupation !== undefined) {
            payload.occupation = demographics.occupation;
        }
    }
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

// ---- P4 depth builders (encounters / vitals / notes / appointments / insurance) ----

type CorpusEncounter = z.infer<typeof CorpusEncounterSchema>;
type CorpusAppointment = z.infer<typeof CorpusAppointmentSchema>;

/** Stock category ids from sql/database.sql (openemr_postcalendar_categories): 5 = Office Visit. */
export const OFFICE_VISIT_CATEGORY_ID = 5;

export function buildEncounterPayload(encounter: CorpusEncounter, facilityId: number): EhrEncounterPayload {
    return {
        pc_catid: OFFICE_VISIT_CATEGORY_ID,
        class_code: encounter.class_code,
        date: encounter.date,
        reason: encounter.reason.slice(0, 255),
        facility_id: facilityId,
        billing_facility: facilityId,
    };
}

export function buildVitalPayload(vitals: NonNullable<CorpusEncounter['vitals']>): EhrVitalPayload {
    // Corpus names carry the unit (weight_lb / height_in); the API columns are unit-implicit US.
    // Field-by-field (not a spread): exactOptionalPropertyTypes forbids `key: undefined`.
    const payload: EhrVitalPayload = {};
    if (vitals.bps !== undefined) {
        payload.bps = vitals.bps;
    }
    if (vitals.bpd !== undefined) {
        payload.bpd = vitals.bpd;
    }
    if (vitals.pulse !== undefined) {
        payload.pulse = vitals.pulse;
    }
    if (vitals.respiration !== undefined) {
        payload.respiration = vitals.respiration;
    }
    if (vitals.temperature !== undefined) {
        payload.temperature = vitals.temperature;
    }
    if (vitals.oxygen_saturation !== undefined) {
        payload.oxygen_saturation = vitals.oxygen_saturation;
    }
    if (vitals.weight_lb !== undefined) {
        payload.weight = vitals.weight_lb;
    }
    if (vitals.height_in !== undefined) {
        payload.height = vitals.height_in;
    }
    if (vitals.note !== undefined) {
        payload.note = vitals.note;
    }
    return payload;
}

export function buildAppointmentPayload(appointment: CorpusAppointment, facilityId: number): EhrAppointmentPayload {
    return {
        pc_catid: OFFICE_VISIT_CATEGORY_ID,
        pc_title: appointment.title.slice(0, 150),
        pc_duration: appointment.duration_minutes * 60, // validator wants seconds
        pc_hometext: appointment.note,
        pc_apptstatus: appointment.status,
        pc_eventDate: appointment.date,
        pc_startTime: appointment.start_time,
        pc_facility: facilityId,
        pc_billing_location: facilityId,
    };
}

export function buildInsurancePayload(
    corpus: EhrSeedCorpus,
    insurance: NonNullable<NonNullable<EhrSeedCorpus['ehr']>['insurance']>,
    companyId: string,
): EhrInsurancePayload {
    const { fname, lname } = parsePersonName(corpus.patient.name);
    const address = corpus.patient.address === undefined ? undefined : parseUsAddress(corpus.patient.address);
    const payload: EhrInsurancePayload = {
        type: 'primary',
        provider: companyId,
        policy_number: insurance.policy_number,
        subscriber_lname: lname,
        subscriber_fname: fname,
        subscriber_relationship: 'self',
        subscriber_DOB: corpus.patient.dob,
        subscriber_sex: mapSex(corpus.patient.sex),
        date: insurance.effective_date,
        accept_assignment: 'TRUE',
    };
    if (insurance.plan_name !== undefined) {
        payload.plan_name = insurance.plan_name;
    }
    if (insurance.group_number !== undefined) {
        payload.group_number = insurance.group_number;
    }
    if (address !== undefined) {
        payload.subscriber_street = address.street;
        if (address.city !== undefined) {
            payload.subscriber_city = address.city;
        }
        if (address.state !== undefined) {
            payload.subscriber_state = address.state;
        }
        if (address.postal_code !== undefined) {
            payload.subscriber_postal_code = address.postal_code;
        }
    }
    return payload;
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
    /** P4 depth — zeros when the corpus carries no `ehr` block. */
    encounters: SeedListOutcome;
    appointments: SeedListOutcome;
    insurance: SeedListOutcome;
}

/**
 * Seeds one corpus patient into OpenEMR, idempotently:
 * search by fname+lname+DOB and reuse the match, else create; then create only the
 * problem/allergy/medication list entries whose titles are not already on the chart.
 */
export async function seedPatientIntoEhr(api: StandardApiClient, corpus: EhrSeedCorpus): Promise<SeedPatientOutcome> {
    const payload = buildPatientPayload(corpus.patient, corpus.ehr?.demographics);
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

    // Depth sections degrade gracefully: the core chart (identity + problem/allergy/medication
    // lists) stays fail-hard above, but one broken EHR route in the depth writes (live lesson:
    // GET /api/insurance_company 500'd on a server bug) must not void the rest of the patient.
    const encounters = await sectionSafe('ehr.encounters', () => seedEncounters(api, corpus, uuid, pid));
    const appointments = await sectionSafe('ehr.appointments', () => seedAppointments(api, corpus, pid));
    const insurance = await sectionSafe('ehr.insurance', () => seedInsurance(api, corpus, uuid));

    return { patientId: corpus.patient.patient_id, action, uuid, pid, problems, allergies, medications, encounters, appointments, insurance };
}

async function sectionSafe(label: string, run: () => Promise<SeedListOutcome>): Promise<SeedListOutcome> {
    try {
        return await run();
    } catch (error) {
        if (error instanceof StandardApiError) {
            return { created: 0, existing: 0, skipped: [{ factId: label, reason: `EHR route failed: ${error.message}` }] };
        }
        throw error;
    }
}

const NO_OUTCOME: SeedListOutcome = { created: 0, existing: 0, skipped: [] };

/** First facility on file — fresh installs have exactly one; encounters/appointments need its id. */
async function resolveFacilityId(api: StandardApiClient): Promise<number | null> {
    const facilities = await api.listFacilities();
    return facilities[0]?.id ?? null;
}

// Encounters key on (date, reason) for idempotency; vitals + SOAP notes are only written onto
// encounters THIS run created (existing encounters are presumed complete — re-runs converge).
async function seedEncounters(api: StandardApiClient, corpus: EhrSeedCorpus, uuid: string, pid: string): Promise<SeedListOutcome> {
    const authored = corpus.ehr?.encounters ?? [];
    if (authored.length === 0) {
        return NO_OUTCOME;
    }
    const facilityId = await resolveFacilityId(api);
    if (facilityId === null) {
        return { ...NO_OUTCOME, skipped: [{ factId: 'ehr.encounters', reason: 'no facility on file to attach encounters to' }] };
    }
    const existingRows = await api.listEncounters(uuid);
    const existingKeys = new Set(existingRows.map((row) => `${row.date.slice(0, 10)}|${row.reason.toLowerCase()}`));
    let created = 0;
    let existing = 0;
    const skipped: SkippedFact[] = [];
    for (const encounter of authored) {
        const key = `${encounter.date}|${encounter.reason.toLowerCase()}`;
        if (existingKeys.has(key)) {
            existing += 1;
            continue;
        }
        await api.createEncounter(uuid, buildEncounterPayload(encounter, facilityId));
        // Re-list to learn the numeric eid (create-response row shape varies by version).
        const after = await api.listEncounters(uuid);
        const row = after.find((candidate) => `${candidate.date.slice(0, 10)}|${candidate.reason.toLowerCase()}` === key);
        if (row === undefined) {
            skipped.push({ factId: `ehr.encounter ${encounter.date}`, reason: 'created but not found on re-list; vitals/note skipped' });
            continue;
        }
        if (encounter.vitals !== undefined) {
            await api.addVital(pid, row.id, buildVitalPayload(encounter.vitals));
        }
        if (encounter.soap !== undefined) {
            const note: EhrSoapNotePayload = {};
            if (encounter.soap.subjective !== undefined) {
                note.subjective = encounter.soap.subjective;
            }
            if (encounter.soap.objective !== undefined) {
                note.objective = encounter.soap.objective;
            }
            if (encounter.soap.assessment !== undefined) {
                note.assessment = encounter.soap.assessment;
            }
            if (encounter.soap.plan !== undefined) {
                note.plan = encounter.soap.plan;
            }
            await api.addSoapNote(pid, row.id, note);
        }
        existingKeys.add(key);
        created += 1;
    }
    return { created, existing, skipped };
}

async function seedAppointments(api: StandardApiClient, corpus: EhrSeedCorpus, pid: string): Promise<SeedListOutcome> {
    const authored = corpus.ehr?.appointments ?? [];
    if (authored.length === 0) {
        return NO_OUTCOME;
    }
    const facilityId = await resolveFacilityId(api);
    if (facilityId === null) {
        return { ...NO_OUTCOME, skipped: [{ factId: 'ehr.appointments', reason: 'no facility on file to attach appointments to' }] };
    }
    const existingRows = await api.listAppointments(pid);
    const existingKeys = new Set(existingRows.map((row) => `${row.eventDate.slice(0, 10)}|${row.title.toLowerCase()}`));
    let created = 0;
    let existing = 0;
    for (const appointment of authored) {
        const key = `${appointment.date}|${appointment.title.toLowerCase()}`;
        if (existingKeys.has(key)) {
            existing += 1;
            continue;
        }
        await api.createAppointment(pid, buildAppointmentPayload(appointment, facilityId));
        existingKeys.add(key);
        created += 1;
    }
    return { created, existing, skipped: [] };
}

// One primary policy per patient: find-or-create the payer by name, then write the coverage
// only when the chart has no 'primary' row yet.
async function seedInsurance(api: StandardApiClient, corpus: EhrSeedCorpus, uuid: string): Promise<SeedListOutcome> {
    const authored = corpus.ehr?.insurance;
    if (authored === undefined) {
        return NO_OUTCOME;
    }
    const typesOnFile = await api.listInsuranceTypes(uuid);
    if (typesOnFile.some((type) => type.toLowerCase() === 'primary')) {
        return { created: 0, existing: 1, skipped: [] };
    }
    let companies = await api.listInsuranceCompanies();
    let company = companies.find((row) => row.name.toLowerCase() === authored.company.toLowerCase());
    if (company === undefined) {
        await api.createInsuranceCompany(authored.company);
        companies = await api.listInsuranceCompanies();
        company = companies.find((row) => row.name.toLowerCase() === authored.company.toLowerCase());
    }
    if (company === undefined) {
        return { ...NO_OUTCOME, skipped: [{ factId: 'ehr.insurance', reason: `payer "${authored.company}" not found after create` }] };
    }
    await api.createInsurance(uuid, buildInsurancePayload(corpus, authored, company.id));
    return { created: 1, existing: 0, skipped: [] };
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
