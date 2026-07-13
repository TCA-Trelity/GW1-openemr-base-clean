// EHR seeding tests (E1) — no live EHR: payload building runs over the real corpus files,
// the orchestration runs against a routed fetch fake, and the uuid linkback runs against a
// faked pg pool. Each test names the failure mode it guards (project convention); OpenEMR
// contract citations live in src/openemr/standardApi.ts and src/openemr/ehrSeed.ts.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import {
    OpenEmrAuthError,
    OpenEmrPasswordAuthClient,
    registerSystemClient,
    generateClientKey,
    STANDARD_API_SEED_SCOPES,
    SYSTEM_SCOPES,
    type FetchLike,
} from '../src/openemr/auth.js';
import {
    buildAllergyPayloads,
    buildMedicationPayloads,
    buildPatientPayload,
    buildProblemPayloads,
    EhrSeedCorpusSchema,
    normalizeDate,
    parsePersonName,
    parseUsAddress,
    seedPatientIntoEhr,
    type EhrSeedCorpus,
} from '../src/openemr/ehrSeed.js';
import { StandardApiClient, StandardApiError } from '../src/openemr/standardApi.js';
import { FactStore } from '../src/store/index.js';

const SEED_DIR = fileURLToPath(new URL('../seed/', import.meta.url));
const BASE_URL = 'https://ehr.example.test';

function loadCorpus(file: string): EhrSeedCorpus {
    return EhrSeedCorpusSchema.parse(JSON.parse(readFileSync(path.join(SEED_DIR, file), 'utf8')));
}

const CORPUS_FILES = readdirSync(SEED_DIR).filter((name) => name.endsWith('.json')).sort();

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function envelope(data: unknown): Record<string, unknown> {
    return { validationErrors: [], internalErrors: [], data, links: [] };
}

interface LoggedCall {
    method: string;
    path: string;
    body: unknown;
}

// Routed fetch fake keyed on "METHOD /pathname"; logs every call for order/absence assertions.
function apiFake(routes: Record<string, (call: LoggedCall) => Response>): { fetch: FetchLike; calls: LoggedCall[] } {
    const calls: LoggedCall[] = [];
    const fetch: FetchLike = (url, init) => {
        const parsed = new URL(url);
        const call: LoggedCall = {
            method: init?.method ?? 'GET',
            path: parsed.pathname,
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        };
        calls.push(call);
        const handler = routes[`${call.method} ${call.path}`];
        if (handler === undefined) {
            return Promise.resolve(jsonResponse(404, { error: 'An error occurred', message: 'Route not found' }));
        }
        return Promise.resolve(handler(call));
    };
    return { fetch, calls };
}

const staticToken = { getAccessToken: () => Promise.resolve('token-1') };

function standardApi(fetch: FetchLike): StandardApiClient {
    return new StandardApiClient({ baseUrl: BASE_URL, tokenProvider: staticToken, fetchImpl: fetch, correlationId: 'corr-1' });
}

// ---- Field mapping ----

describe('corpus field mapping', () => {
    // Guards: a mangled name split breaks both the created chart and every later
    // idempotency search (fname/lname are the search keys).
    it('splits "First M. Last" names into fname/mname/lname', () => {
        expect(parsePersonName('Margaret L. Chen')).toEqual({ fname: 'Margaret', mname: 'L.', lname: 'Chen' });
        expect(parsePersonName('Cher')).toEqual({ fname: 'Cher', lname: '' });
        expect(parsePersonName('Ana Maria de la Cruz')).toEqual({ fname: 'Ana', mname: 'Maria de la', lname: 'Cruz' });
    });

    it('parses single-line US addresses and keeps unparseable ones as street', () => {
        expect(parseUsAddress('915 Delaney Park Drive, Orlando, FL 32806')).toEqual({
            street: '915 Delaney Park Drive',
            city: 'Orlando',
            state: 'FL',
            postal_code: '32806',
        });
        expect(parseUsAddress('somewhere without structure')).toEqual({ street: 'somewhere without structure' });
    });

    // Guards: PatientValidator rejects sex values shorter than 4 chars (PatientValidator.php:58),
    // so sending the corpus 'M'/'F' codes verbatim would 400 every create.
    it('expands corpus M/F codes to the Male/Female values the validator accepts', () => {
        const corpus = loadCorpus('margaret-chen.json');
        expect(buildPatientPayload(corpus.patient).sex).toBe('Female');
        expect(buildPatientPayload(loadCorpus('james-whitfield.json').patient).sex).toBe('Male');
    });

    // Guards: ConditionValidator requires begdate as Y-m-d; corpus onsets are often partial
    // ("2018", "2018-03") and would otherwise fail validation.
    it('normalizes partial corpus dates to the first day', () => {
        expect(normalizeDate('2018-03')).toBe('2018-03-01');
        expect(normalizeDate('2016')).toBe('2016-01-01');
        expect(normalizeDate('2024-12-05')).toBe('2024-12-05');
        expect(normalizeDate('soon')).toBeUndefined();
        expect(normalizeDate(undefined)).toBeUndefined();
    });
});

// ---- Payload building over the real corpus ----

describe('buildPatientPayload (all five corpora)', () => {
    // Guards: every corpus patient must satisfy PatientValidator::DATABASE_INSERT_CONTEXT
    // (fname 1-255, lname 2-255, sex 4-30, DOB Y-m-d) or seeding 400s on arrival.
    it.each(CORPUS_FILES)('%s builds a payload the patient validator accepts', (file) => {
        const corpus = loadCorpus(file);
        const payload = buildPatientPayload(corpus.patient);
        expect(payload.fname.length).toBeGreaterThanOrEqual(1);
        expect(payload.lname.length).toBeGreaterThanOrEqual(2);
        expect(payload.sex.length).toBeGreaterThanOrEqual(4);
        expect(payload.sex.length).toBeLessThanOrEqual(30);
        expect(payload.DOB).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(payload.DOB).toBe(corpus.patient.dob);
        expect(payload.pubpid).toBe(corpus.patient.mrn);
    });

    it('maps the full margaret-chen demographics including address parts and phone', () => {
        expect(buildPatientPayload(loadCorpus('margaret-chen.json').patient)).toEqual({
            fname: 'Margaret',
            mname: 'L.',
            lname: 'Chen',
            DOB: '1967-03-14',
            sex: 'Female',
            street: '4521 Maple Street',
            city: 'Orlando',
            state: 'FL',
            postal_code: '32801',
            phone_contact: '(407) 555-6789',
            pubpid: 'FPA-2019-4521',
        });
    });

    // Guards: william-thompson has no address; emitting empty-string address fields would
    // store junk while omitting them is valid (all address fields are optional).
    it('omits address fields when the corpus has none (william-thompson)', () => {
        const payload = buildPatientPayload(loadCorpus('william-thompson.json').patient);
        expect(payload).not.toHaveProperty('street');
        expect(payload).not.toHaveProperty('city');
        expect(payload.phone_contact).toBe('(407) 555-2318');
    });
});

describe('buildProblemPayloads', () => {
    it('maps margaret-chen conditions with ICD-10 prefixes and normalized onsets', () => {
        const { payloads, skipped } = buildProblemPayloads(loadCorpus('margaret-chen.json'));
        expect(skipped).toEqual([]);
        expect(payloads).toEqual([
            { title: 'Rheumatoid arthritis (seropositive)', begdate: '2018-03-01', diagnosis: 'ICD10:M05.79' },
            { title: 'Essential hypertension', begdate: '2018-01-01', diagnosis: 'ICD10:I10' },
        ]);
    });

    // Guards: the corpus conditions arrays mix fact types — patricia carries two vital_sign
    // IOP readings and james a procedure_history; writing those to the problem list would
    // fabricate diagnoses in the EHR.
    it('skips non-condition fact types instead of fabricating problems', () => {
        const patricia = buildProblemPayloads(loadCorpus('patricia-okafor.json'));
        expect(patricia.payloads).toEqual([
            { title: 'Ocular hypertension', begdate: '2024-11-01', diagnosis: 'ICD10:H40.053' },
        ]);
        expect(patricia.skipped.map((s) => s.factId)).toEqual(['fact-po-vs-001', 'fact-po-vs-002']);

        const james = buildProblemPayloads(loadCorpus('james-whitfield.json'));
        expect(james.payloads).toEqual([]);
        expect(james.skipped.map((s) => s.factId)).toEqual(['fact-jw-proc-001']);
    });

    // Guards: begdate is required by ConditionValidator — inventing one would falsify the
    // record, so a condition without an onset is skipped with a reason.
    it('skips conditions with no parseable onset date', () => {
        const corpus = loadCorpus('margaret-chen.json');
        const mutated = {
            ...corpus,
            conditions: [{ id: 'fact-x', fact_type: 'condition', content: { name: 'Mystery condition' } }],
        };
        const { payloads, skipped } = buildProblemPayloads(EhrSeedCorpusSchema.parse(mutated));
        expect(payloads).toEqual([]);
        expect(skipped).toEqual([{ factId: 'fact-x', reason: 'condition has no parseable onset date (begdate is required)' }]);
    });
});

describe('buildAllergyPayloads', () => {
    // Guards: the allergy route whitelists no reaction field (AllergyIntoleranceRestController
    // WHITELISTED_FIELDS), so reaction/severity must ride in comments or be silently lost.
    it('maps substance to title and reaction/severity into comments', () => {
        expect(buildAllergyPayloads(loadCorpus('margaret-chen.json')).payloads).toEqual([
            { title: 'Sulfonamides', comments: 'Reaction: rash. Severity: moderate' },
        ]);
        expect(buildAllergyPayloads(loadCorpus('robert-alvarez.json')).payloads).toEqual([
            { title: 'Penicillin', comments: 'Reaction: hives. Severity: moderate' },
        ]);
    });

    it('builds no allergies for corpora without any', () => {
        expect(buildAllergyPayloads(loadCorpus('william-thompson.json')).payloads).toEqual([]);
    });
});

describe('buildMedicationPayloads', () => {
    // Guards: the medication list route stores begdate as DATETIME (ListService validator
    // 'Y-m-d H:i:s'); sending the bare corpus date would 400.
    it('maps name+dose+frequency into the title and start_date into a datetime begdate', () => {
        const { payloads, skipped } = buildMedicationPayloads(loadCorpus('margaret-chen.json'));
        expect(skipped).toEqual([]);
        expect(payloads).toHaveLength(5);
        expect(payloads[0]).toEqual({
            title: 'Hydroxychloroquine (Plaquenil) 200mg daily',
            begdate: '2019-01-15 00:00:00',
            enddate: null,
            diagnosis: null,
        });
        // Vitamin D3 has no start_date — explicit null keeps ListService::insert's
        // unconditional key reads happy without inventing a date.
        expect(payloads[4]).toEqual({ title: 'Vitamin D3 2000 IU daily', begdate: null, enddate: null, diagnosis: null });
    });

    it('builds every corpus medication as current (none are ended)', () => {
        const counts = Object.fromEntries(
            CORPUS_FILES.map((file) => [file, buildMedicationPayloads(loadCorpus(file)).payloads.length]),
        );
        expect(counts).toEqual({
            'james-whitfield.json': 1,
            'margaret-chen.json': 5,
            'patricia-okafor.json': 1,
            'robert-alvarez.json': 2,
            'william-thompson.json': 0,
        });
    });
});

// ---- Idempotent orchestration against a faked standard API ----

const MC_SEARCH_ROW = { uuid: 'uuid-mc', pid: 42, fname: 'Margaret', lname: 'Chen', DOB: '1967-03-14' };

// Stateful P4 depth routes: encounter/appointment/insurance lists grow as the seeder POSTs,
// mirroring the live server, so the create → re-list → vitals/note flow runs end-to-end.
function depthRoutes(uuid: string, pid: string): { routes: Record<string, (call: LoggedCall) => Response> } {
    const encounters: Record<string, unknown>[] = [];
    const appointments: Record<string, unknown>[] = [];
    const insurance: Record<string, unknown>[] = [];
    let nextEid = 100;
    const vitalOrSoap = (): Response => jsonResponse(201, envelope({}));
    const routes: Record<string, (call: LoggedCall) => Response> = {
        'GET /apis/default/api/facility': () => jsonResponse(200, envelope([{ id: 3, name: 'Montzka Eye Clinic' }])),
        [`GET /apis/default/api/patient/${uuid}/encounter`]: () => jsonResponse(200, envelope(encounters)),
        [`POST /apis/default/api/patient/${uuid}/encounter`]: (call) => {
            const body = call.body as Record<string, unknown>;
            encounters.push({ eid: nextEid, uuid: `enc-${String(nextEid)}`, date: `${String(body['date'])} 00:00:00`, reason: body['reason'] });
            nextEid += 1;
            return jsonResponse(201, envelope({}));
        },
        [`POST /apis/default/api/patient/${pid}/encounter/100/vital`]: vitalOrSoap,
        [`POST /apis/default/api/patient/${pid}/encounter/101/vital`]: vitalOrSoap,
        [`POST /apis/default/api/patient/${pid}/encounter/100/soap_note`]: vitalOrSoap,
        [`POST /apis/default/api/patient/${pid}/encounter/101/soap_note`]: vitalOrSoap,
        // Raw rows, no envelope — the live route's actual shape (legacy responseHandler).
        [`GET /apis/default/api/patient/${pid}/appointment`]: () =>
            appointments.length === 0 ? jsonResponse(404, undefined) : jsonResponse(200, appointments),
        [`POST /apis/default/api/patient/${pid}/appointment`]: (call) => {
            const body = call.body as Record<string, unknown>;
            appointments.push({ pc_eventDate: body['pc_eventDate'], pc_title: body['pc_title'] });
            return jsonResponse(201, envelope({}));
        },
        [`GET /apis/default/api/patient/${uuid}/insurance`]: () => jsonResponse(200, envelope(insurance)),
        [`POST /apis/default/api/patient/${uuid}/insurance`]: (call) => {
            insurance.push({ type: (call.body as Record<string, unknown>)['type'] });
            return jsonResponse(201, envelope({}));
        },
        'GET /apis/default/api/insurance_company': () => jsonResponse(200, envelope([{ id: '11', name: 'Blue Cross Blue Shield of Florida' }])),
        'POST /apis/default/api/insurance_company': () => jsonResponse(201, envelope({})),
    };
    return { routes };
}

describe('seedPatientIntoEhr', () => {
    // Guards: the found-by-search branch must short-circuit POST /api/patient — re-running the
    // seeder must never mint duplicate charts. The P4 depth (encounters + vitals + notes,
    // appointments, insurance) seeds through the same idempotent pass.
    it('reuses an existing patient found by name+DOB and only tops up missing list entries', async () => {
        const { fetch, calls } = apiFake({
            'GET /apis/default/api/patient': () => jsonResponse(200, envelope([MC_SEARCH_ROW])),
            'PUT /apis/default/api/patient/uuid-mc': () => jsonResponse(200, envelope({})),
            'GET /apis/default/api/patient/uuid-mc/medical_problem': () =>
                jsonResponse(200, envelope([{ title: 'Rheumatoid arthritis (seropositive)' }])),
            'POST /apis/default/api/patient/uuid-mc/medical_problem': () =>
                jsonResponse(201, envelope({ id: 9, uuid: 'uuid-prob' })),
            'GET /apis/default/api/patient/uuid-mc/allergy': () => jsonResponse(200, envelope([])),
            'POST /apis/default/api/patient/uuid-mc/allergy': () => jsonResponse(201, envelope({ id: 10, uuid: 'uuid-alg' })),
            // Empty medication list is a 404 on this route (RestControllerHelper::responseHandler).
            'GET /apis/default/api/patient/42/medication': () => jsonResponse(404, undefined),
            'POST /apis/default/api/patient/42/medication': () => jsonResponse(200, 77),
            ...depthRoutes('uuid-mc', '42').routes,
        });

        const outcome = await seedPatientIntoEhr(standardApi(fetch), loadCorpus('margaret-chen.json'));

        expect(outcome).toMatchObject({
            patientId: 'margaret-chen',
            action: 'found',
            uuid: 'uuid-mc',
            pid: '42',
            problems: { created: 1, existing: 1 },
            allergies: { created: 1, existing: 0 },
            medications: { created: 5, existing: 0 },
            encounters: { created: 2, existing: 0, skipped: [] },
            appointments: { created: 2, existing: 0 },
            insurance: { created: 1, existing: 0 },
        });
        expect(calls.filter((call) => call.method === 'POST' && call.path === '/apis/default/api/patient')).toEqual([]);
        // Vitals + SOAP landed on the encounters this run created, with authored numbers intact
        // (eid 101 = the second created encounter, margaret's 2024-12-26 exam).
        const vitalCall = calls.find((call) => call.path === '/apis/default/api/patient/42/encounter/101/vital');
        expect(vitalCall?.body).toMatchObject({ bps: 138, bpd: 84, weight: 150, height: 64 });
        expect(calls.filter((call) => call.path.endsWith('/soap_note'))).toHaveLength(2);
        // The appointment write converts minutes → seconds and carries the calendar essentials.
        const apptCall = calls.find((call) => call.method === 'POST' && call.path === '/apis/default/api/patient/42/appointment');
        expect(apptCall?.body).toMatchObject({ pc_catid: 5, pc_duration: 2700, pc_facility: 3, pc_apptstatus: '-' });
        // Insurance resolved the existing payer by name instead of creating a duplicate.
        expect(calls.filter((call) => call.method === 'POST' && call.path === '/apis/default/api/insurance_company')).toEqual([]);
        const insuranceCall = calls.find((call) => call.method === 'POST' && call.path === '/apis/default/api/patient/uuid-mc/insurance');
        expect(insuranceCall?.body).toMatchObject({ type: 'primary', provider: '11', subscriber_relationship: 'self', subscriber_DOB: '1967-03-14' });
    });

    it('creates the patient when the search has no exact name+DOB match', async () => {
        const wrongDob = { ...MC_SEARCH_ROW, DOB: '1967-03-15' }; // near miss must NOT count as found
        const { fetch, calls } = apiFake({
            'GET /apis/default/api/patient': () => jsonResponse(200, envelope([wrongDob])),
            'POST /apis/default/api/patient': () => jsonResponse(201, envelope({ pid: 7, uuid: 'uuid-new' })),
            'GET /apis/default/api/patient/uuid-new/medical_problem': () => jsonResponse(200, envelope([])),
            'POST /apis/default/api/patient/uuid-new/medical_problem': () => jsonResponse(201, envelope({ id: 1, uuid: 'u' })),
            'GET /apis/default/api/patient/uuid-new/allergy': () => jsonResponse(200, envelope([])),
            'POST /apis/default/api/patient/uuid-new/allergy': () => jsonResponse(201, envelope({ id: 2, uuid: 'u' })),
            'GET /apis/default/api/patient/7/medication': () => jsonResponse(404, undefined),
            'POST /apis/default/api/patient/7/medication': () => jsonResponse(200, 3),
            ...depthRoutes('uuid-new', '7').routes,
        });

        const outcome = await seedPatientIntoEhr(standardApi(fetch), loadCorpus('margaret-chen.json'));

        expect(outcome.action).toBe('created');
        expect(outcome.uuid).toBe('uuid-new');
        expect(outcome.pid).toBe('7');
        const createCall = calls.find((call) => call.method === 'POST' && call.path === '/apis/default/api/patient');
        // P4 depth demographics ride the same patient write.
        expect(createCall?.body).toMatchObject({
            fname: 'Margaret',
            lname: 'Chen',
            DOB: '1967-03-14',
            sex: 'Female',
            email: 'margaret.chen@example.com',
            status: 'married',
        });
    });

    // Guards: matching must be case-insensitive — OpenEMR may return titles/reasons with
    // different casing, and a false miss would duplicate chart entries on every run. Covers
    // the P4 depth too: everything already on the chart ⇒ ZERO POSTs on a re-run.
    it('deduplicates list entries case-insensitively', async () => {
        const { fetch, calls } = apiFake({
            'GET /apis/default/api/patient': () => jsonResponse(200, envelope([MC_SEARCH_ROW])),
            'PUT /apis/default/api/patient/uuid-mc': () => jsonResponse(200, envelope({})),
            'GET /apis/default/api/patient/uuid-mc/medical_problem': () =>
                jsonResponse(200, envelope([
                    { title: 'RHEUMATOID ARTHRITIS (SEROPOSITIVE)' },
                    { title: 'essential hypertension' },
                ])),
            'GET /apis/default/api/patient/uuid-mc/allergy': () => jsonResponse(200, envelope([{ title: 'SULFONAMIDES' }])),
            'GET /apis/default/api/patient/42/medication': () =>
                jsonResponse(200, [
                    { title: 'Hydroxychloroquine (Plaquenil) 200mg daily' },
                    { title: 'Methotrexate 15mg (six 2.5mg tablets) weekly' },
                    { title: 'Folic acid 1mg daily' },
                    { title: 'Lisinopril 10mg daily' },
                    { title: 'Vitamin D3 2000 IU daily' },
                ]),
            'GET /apis/default/api/facility': () => jsonResponse(200, envelope([{ id: 3, name: 'Clinic' }])),
            'GET /apis/default/api/patient/uuid-mc/encounter': () =>
                jsonResponse(200, envelope([
                    { eid: 1, date: '2024-03-19 00:00:00', reason: 'HCQ RETINOPATHY SCREENING — OCT IMAGING VISIT' },
                    { eid: 2, date: '2024-12-26 00:00:00', reason: 'New patient examination — floaters and flashes, right eye' },
                ])),
            'GET /apis/default/api/patient/42/appointment': () =>
                jsonResponse(200, [
                    { pc_eventDate: '2024-12-26', pc_title: 'NEW PATIENT EXAM — FLOATERS/FLASHES OD' },
                    { pc_eventDate: '2025-01-09', pc_title: 'Dilated follow-up + OCT review' },
                ]),
            'GET /apis/default/api/patient/uuid-mc/insurance': () => jsonResponse(200, envelope([{ type: 'PRIMARY' }])),
        });

        const outcome = await seedPatientIntoEhr(standardApi(fetch), loadCorpus('margaret-chen.json'));

        expect(outcome.problems).toMatchObject({ created: 0, existing: 2 });
        expect(outcome.allergies).toMatchObject({ created: 0, existing: 1 });
        expect(outcome.medications).toMatchObject({ created: 0, existing: 5 });
        expect(outcome.encounters).toMatchObject({ created: 0, existing: 2 });
        expect(outcome.appointments).toMatchObject({ created: 0, existing: 2 });
        expect(outcome.insurance).toMatchObject({ created: 0, existing: 1 });
        expect(calls.filter((call) => call.method === 'POST')).toEqual([]);
    });

    // Guards (live lesson): GET /api/insurance_company 500'd on a server bug and voided the
    // WHOLE patient — depth sections must degrade to a skipped outcome, never fail the chart.
    it('records a depth section as skipped when its EHR route errors, without failing the patient', async () => {
        const depth = depthRoutes('uuid-mc', '42').routes;
        delete depth['GET /apis/default/api/insurance_company'];
        const { fetch } = apiFake({
            'GET /apis/default/api/patient': () => jsonResponse(200, envelope([MC_SEARCH_ROW])),
            'PUT /apis/default/api/patient/uuid-mc': () => jsonResponse(200, envelope({})),
            'GET /apis/default/api/patient/uuid-mc/medical_problem': () => jsonResponse(200, envelope([])),
            'POST /apis/default/api/patient/uuid-mc/medical_problem': () => jsonResponse(201, envelope({ id: 1, uuid: 'u' })),
            'GET /apis/default/api/patient/uuid-mc/allergy': () => jsonResponse(200, envelope([])),
            'POST /apis/default/api/patient/uuid-mc/allergy': () => jsonResponse(201, envelope({ id: 2, uuid: 'u' })),
            'GET /apis/default/api/patient/42/medication': () => jsonResponse(404, undefined),
            'POST /apis/default/api/patient/42/medication': () => jsonResponse(200, 3),
            ...depth,
            'GET /apis/default/api/insurance_company': () =>
                jsonResponse(500, { error: 'An error occurred', message: 'getResponseForPayload() expects a string, array, numeric, or JsonSerializable object, ProcessingResult given.' }),
        });

        const outcome = await seedPatientIntoEhr(standardApi(fetch), loadCorpus('margaret-chen.json'));

        expect(outcome.encounters).toMatchObject({ created: 2, existing: 0 });
        expect(outcome.appointments).toMatchObject({ created: 2, existing: 0 });
        expect(outcome.insurance.created).toBe(0);
        expect(outcome.insurance.skipped[0]?.factId).toBe('ehr.insurance');
        expect(outcome.insurance.skipped[0]?.reason).toContain('status 500');
    });

    // Guards: william has no medications, so the seeder must not even GET the medication list
    // (whose empty-list 404 would otherwise need special-casing for nothing).
    it('skips list reads entirely when a corpus has nothing to write', async () => {
        const { fetch, calls } = apiFake({
            'GET /apis/default/api/patient': () => jsonResponse(200, envelope([])),
            'POST /apis/default/api/patient': () => jsonResponse(201, envelope({ pid: 9, uuid: 'uuid-wt' })),
            'GET /apis/default/api/patient/uuid-wt/medical_problem': () => jsonResponse(200, envelope([])),
            'POST /apis/default/api/patient/uuid-wt/medical_problem': () => jsonResponse(201, envelope({ id: 1, uuid: 'u' })),
            ...depthRoutes('uuid-wt', '9').routes,
        });

        const outcome = await seedPatientIntoEhr(standardApi(fetch), loadCorpus('william-thompson.json'));

        expect(outcome.problems).toMatchObject({ created: 2, existing: 0 });
        expect(outcome.allergies).toMatchObject({ created: 0, existing: 0 });
        expect(outcome.medications).toMatchObject({ created: 0, existing: 0 });
        expect(outcome.encounters).toMatchObject({ created: 2, existing: 0 });
        expect(calls.map((call) => call.path)).not.toContain('/apis/default/api/patient/9/medication');
        expect(calls.map((call) => call.path)).not.toContain('/apis/default/api/patient/uuid-wt/allergy');
    });
});

// ---- Standard API error classification ----

describe('StandardApiClient errors', () => {
    // Guards: the operator-facing distinction between "fix your scopes/client" and "the payload
    // is wrong" — HttpRestRouteHandler turns ACL/scope denials into 401s while validators 400.
    it('classifies 401 as auth and 400 with validationErrors as validation', async () => {
        const authFetch: FetchLike = () =>
            Promise.resolve(jsonResponse(401, { error: 'An error occurred', message: 'Unauthorized', code: 0 }));
        const authError = await standardApi(authFetch)
            .createPatient({ fname: 'A', lname: 'Bc', DOB: '2000-01-01', sex: 'Male' })
            .catch((e: unknown) => e as StandardApiError);
        expect(authError).toBeInstanceOf(StandardApiError);
        expect(authError.kind).toBe('auth');
        expect(authError.message).toContain('Unauthorized');

        const validationFetch: FetchLike = () =>
            Promise.resolve(jsonResponse(400, { validationErrors: { sex: { 'Length::TOO_SHORT': 'too short' } }, data: [] }));
        const validationError = await standardApi(validationFetch)
            .createPatient({ fname: 'A', lname: 'Bc', DOB: '2000-01-01', sex: 'M' })
            .catch((e: unknown) => e as StandardApiError);
        expect(validationError.kind).toBe('validation');
        expect(validationError.message).toContain('TOO_SHORT');
    });

    it('sends bearer auth, correlation id, and JSON content type on writes', async () => {
        const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(201, envelope({ pid: 1, uuid: 'u-1' })));
        await standardApi(fetch).createPatient({ fname: 'A', lname: 'Bc', DOB: '2000-01-01', sex: 'Male' });
        const [url, init] = fetch.mock.calls[0]!;
        expect(url).toBe(`${BASE_URL}/apis/default/api/patient`);
        const headers = new Headers(init?.headers);
        expect(headers.get('authorization')).toBe('Bearer token-1');
        expect(headers.get('x-correlation-id')).toBe('corr-1');
        expect(headers.get('content-type')).toBe('application/json');
    });
});

// ---- Password-grant token client ----

describe('OpenEmrPasswordAuthClient', () => {
    function passwordClient(fetch: FetchLike, now: () => number) {
        return new OpenEmrPasswordAuthClient({
            baseUrl: BASE_URL,
            clientId: 'client-1',
            username: 'admin',
            password: 'pass',
            fetchImpl: fetch,
            now,
        });
    }

    // Guards: CustomPasswordGrant requires username/password/user_role form fields and the
    // standard API requires api:oemr in the token scopes — dropping any of them locks the
    // seeder out with opaque server errors.
    it('posts the password-grant form with user_role=users and the standard-API seed scopes', async () => {
        const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { access_token: 'tok-1', expires_in: 3600 }));
        const token = await passwordClient(fetch, () => 1_750_000_000_000).getAccessToken();

        expect(token).toBe('tok-1');
        const [url, init] = fetch.mock.calls[0]!;
        expect(url).toBe(`${BASE_URL}/oauth2/default/token`);
        const form = new URLSearchParams(String(init?.body));
        expect(form.get('grant_type')).toBe('password');
        expect(form.get('client_id')).toBe('client-1');
        expect(form.get('user_role')).toBe('users');
        expect(form.get('username')).toBe('admin');
        expect(form.get('password')).toBe('pass');
        expect(form.get('scope')).toBe(STANDARD_API_SEED_SCOPES.join(' '));
    });

    it('caches the token until near expiry, then refreshes', async () => {
        let now = 1_750_000_000_000;
        const fetch = vi
            .fn<FetchLike>()
            .mockResolvedValueOnce(jsonResponse(200, { access_token: 'tok-1', expires_in: 60 }))
            .mockResolvedValueOnce(jsonResponse(200, { access_token: 'tok-2', expires_in: 60 }));
        const client = passwordClient(fetch, () => now);

        expect(await client.getAccessToken()).toBe('tok-1');
        expect(await client.getAccessToken()).toBe('tok-1'); // cached — no second request yet
        expect(fetch).toHaveBeenCalledTimes(1);

        now += 60_000; // past expiry (minus skew)
        expect(await client.getAccessToken()).toBe('tok-2');
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    // Guards: the CLI's failure hints key on the OAuth error code — e.g. unsupported_grant_type
    // means the admin never enabled the password grant global.
    it('throws a typed error carrying the OAuth error code, not the raw body', async () => {
        const fetch = vi.fn<FetchLike>().mockResolvedValue(
            jsonResponse(400, { error: 'unsupported_grant_type', error_description: 'grant off', secret_field: 'HIDden' }),
        );
        const error = await passwordClient(fetch, () => 0)
            .getAccessToken()
            .catch((e: unknown) => e as OpenEmrAuthError);
        expect(error).toBeInstanceOf(OpenEmrAuthError);
        expect(error.oauthError).toBe('unsupported_grant_type');
        expect(error.message).not.toContain('HIDden');
    });
});

// ---- Registration with write scopes ----

describe('registerSystemClient with seed scopes', () => {
    const KEY = generateClientKey(2048);

    // Guards: granted scopes are intersected with the *registered* scopes
    // (ScopeRepository::finalizeScopes) — registering without the password grant type or the
    // api:oemr/user scopes silently produces a client that can read FHIR but never seed.
    it('registers both grant types and the combined read+write scope string when asked', async () => {
        const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { client_id: 'cid-9' }));
        await registerSystemClient({
            baseUrl: BASE_URL,
            clientName: 'Seeder',
            jwks: KEY.jwks,
            scopes: [...SYSTEM_SCOPES, ...STANDARD_API_SEED_SCOPES],
            grantTypes: ['client_credentials', 'password'],
            fetchImpl: fetch,
        });
        const body = JSON.parse(String(fetch.mock.calls[0]![1]?.body)) as Record<string, unknown>;
        expect(body['grant_types']).toEqual(['client_credentials', 'password']);
        expect(body['scope']).toBe([...SYSTEM_SCOPES, ...STANDARD_API_SEED_SCOPES].join(' '));
    });

    // Guards: every scope string must exist verbatim in ServerScopeListEntity::apiScopes() or
    // registration fails whole with invalid_scope; api:oemr gates the /api/ routes themselves.
    it('asks for api:oemr plus read+write pairs for exactly the seeded resources', () => {
        expect(STANDARD_API_SEED_SCOPES).toContain('api:oemr');
        const resources = [
            'patient', 'medical_problem', 'allergy', 'medication',
            // P4 record depth
            'encounter', 'vital', 'soap_note', 'appointment', 'insurance', 'insurance_company',
            // Week 2 document ingestion (Wave 0.2): the source-PDF write path
            'document',
        ];
        for (const resource of resources) {
            expect(STANDARD_API_SEED_SCOPES).toContain(`user/${resource}.read`);
            expect(STANDARD_API_SEED_SCOPES).toContain(`user/${resource}.write`);
        }
        expect(STANDARD_API_SEED_SCOPES).toContain('user/facility.read'); // facility id resolution
        expect(STANDARD_API_SEED_SCOPES).toHaveLength(24);
    });
});

// ---- uuid linkback into the fact store ----

describe('FactStore.setOpenemrPatientId', () => {
    // Guards: the linkback is the whole point of E1 — the panel and E2 sync resolve
    // patients.openemr_patient_id to reach the real chart. Wrong SQL/params silently strand
    // the sidecar on corpus-only data.
    it('updates exactly the linked column for the given patient', async () => {
        const query = vi.fn().mockResolvedValue({ rowCount: 1 });
        const store = new FactStore({ query } as unknown as Pool);

        await store.setOpenemrPatientId('margaret-chen', 'uuid-mc-1');

        expect(query).toHaveBeenCalledOnce();
        const [sql, params] = query.mock.calls[0] as [string, unknown[]];
        expect(sql).toContain('UPDATE patients SET openemr_patient_id = $2');
        expect(sql).toContain('WHERE id = $1');
        expect(sql).not.toContain('name'); // never clobbers what seed.ts loaded
        expect(params).toEqual(['margaret-chen', 'uuid-mc-1']);
    });

    it('throws when the patient is not in the fact store yet', async () => {
        const query = vi.fn().mockResolvedValue({ rowCount: 0 });
        const store = new FactStore({ query } as unknown as Pool);
        await expect(store.setOpenemrPatientId('ghost', 'uuid-x')).rejects.toThrow(
            'patient ghost is not in the fact store (run the seed script first)',
        );
    });
});
