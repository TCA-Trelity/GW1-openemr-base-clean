// Standard ('api:oemr') REST client for the writes the FHIR facade does not offer to backend
// clients. Routes verbatim from apis/routes/_rest_routes_standard.inc.php: GET|POST /api/patient
// (:84), POST /api/patient/:puuid/medical_problem (:233), POST /api/patient/:puuid/allergy (:278),
// GET|POST /api/patient/:pid/medication (:298-311 — numeric pid, not uuid). Responses use the
// {validationErrors, internalErrors, data} envelope (src/RestControllers/RestControllerHelper.php:204-300)
// except the medication list routes, which return the raw service result and 404 on an empty list
// (RestControllerHelper::responseHandler, :156-169).
import type { FetchLike } from './auth.js';
import type { TokenProvider } from './fhir.js';

/** How a failure should be acted on: auth = fix scopes/role/enablement, validation = fix payload. */
export type StandardApiErrorKind = 'auth' | 'validation' | 'other';

// Typed standard-API failure. Scope/ACL denials surface as 401 (HttpRestRouteHandler.php:99-113);
// payload rejections as 400 with a validationErrors map (RestControllerHelper.php:261-264).
export class StandardApiError extends Error {
    public readonly kind: StandardApiErrorKind;

    constructor(
        path: string,
        public readonly status: number,
        detail?: string,
    ) {
        const kind: StandardApiErrorKind = status === 401 || status === 403 ? 'auth' : status === 400 ? 'validation' : 'other';
        super(`standard API ${path} failed with status ${status}${detail ? ` (${detail})` : ''}`);
        this.name = 'StandardApiError';
        this.kind = kind;
    }
}

export interface EhrPatientPayload {
    // Required by PatientValidator::DATABASE_INSERT_CONTEXT (src/Validators/PatientValidator.php:56-59):
    // fname 1-255, lname 2-255, sex 4-30 chars ('Male'/'Female', not 'M'/'F'), DOB Y-m-d.
    fname: string;
    lname: string;
    DOB: string;
    sex: string;
    mname?: string;
    street?: string;
    city?: string;
    state?: string;
    postal_code?: string;
    phone_contact?: string;
    /** External MRN; lands in patient_data.pubpid (PatientService::databaseInsert defaults it to pid otherwise). */
    pubpid?: string;
}

export interface EhrProblemPayload {
    // ConditionValidator::DATABASE_INSERT_CONTEXT (src/Validators/ConditionValidator.php:32-35):
    // title 2-255 required, begdate Y-m-d required, diagnosis optional 'ICD10:<code>'.
    title: string;
    begdate: string;
    diagnosis?: string;
}

export interface EhrAllergyPayload {
    // AllergyIntoleranceValidator (src/Validators/AllergyIntoleranceValidator.php:32-36): title
    // required; reaction has no whitelisted field on this route (AllergyIntoleranceRestController
    // WHITELISTED_FIELDS :38-44), so it rides in comments.
    title: string;
    comments?: string;
}

export interface EhrMedicationPayload {
    // ListService::validate (src/Services/ListService.php:38-43): title required; begdate is a
    // DATETIME here ('Y-m-d H:i:s'), unlike the problem/allergy routes. Explicit nulls because
    // ListService::insert reads every key unconditionally (ListService.php:198-207).
    title: string;
    begdate: string | null;
    enddate: null;
    diagnosis: null;
}

export interface EhrPatientRecord {
    uuid: string;
    pid: string;
    fname: string;
    lname: string;
    dob: string;
}

export interface CreatedRecord {
    uuid: string;
    pid: string;
}

export interface StandardApiClientOptions {
    baseUrl: string;
    tokenProvider: TokenProvider;
    fetchImpl?: FetchLike;
    /** Stamped on every request as x-correlation-id; defaults to one id per client instance. */
    correlationId?: string;
}

export class StandardApiClient {
    private readonly apiBase: string;
    private readonly tokenProvider: TokenProvider;
    private readonly fetchImpl: FetchLike;
    private readonly correlationId: string;

    constructor(options: StandardApiClientOptions) {
        this.apiBase = `${options.baseUrl.replace(/\/+$/, '')}/apis/default/api`;
        this.tokenProvider = options.tokenProvider;
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
        this.correlationId = options.correlationId ?? crypto.randomUUID();
    }

    // GET /api/patient with fname/lname/DOB, all in PatientRestController::SUPPORTED_SEARCH_FIELDS
    // (src/RestControllers/PatientRestController.php:137-155). Server matching may be fuzzy, so
    // callers re-filter for exact identity.
    async searchPatients(params: { fname: string; lname: string; DOB: string }): Promise<EhrPatientRecord[]> {
        const query = new URLSearchParams(params).toString();
        const body = await this.request('GET', `/patient?${query}`);
        const rows = envelopeData(body, `/patient?${query}`);
        if (!Array.isArray(rows)) {
            throw new StandardApiError(`/patient?${query}`, 200, 'expected data to be an array');
        }
        return rows.flatMap((row) => {
            const record = asRecord(row);
            const uuid = record?.['uuid'];
            if (record === undefined || typeof uuid !== 'string' || uuid === '') {
                return []; // rows without a uuid cannot be linked back — skip rather than crash
            }
            return [{
                uuid,
                pid: String(record['pid'] ?? ''),
                fname: typeof record['fname'] === 'string' ? record['fname'] : '',
                lname: typeof record['lname'] === 'string' ? record['lname'] : '',
                dob: typeof record['DOB'] === 'string' ? record['DOB'] : '',
            }];
        });
    }

    // POST /api/patient returns {pid, uuid} on 201 (PatientService::insert, src/Services/PatientService.php:229-234).
    async createPatient(payload: EhrPatientPayload): Promise<CreatedRecord> {
        const body = await this.request('POST', '/patient', payload);
        const data = asRecord(envelopeData(body, '/patient'));
        const uuid = data?.['uuid'];
        const pid = data?.['pid'];
        if (data === undefined || typeof uuid !== 'string' || uuid === '' || pid === undefined || pid === null) {
            throw new StandardApiError('/patient', 201, 'create response missing pid/uuid');
        }
        return { uuid, pid: String(pid) };
    }

    async listMedicalProblemTitles(puuid: string): Promise<string[]> {
        return this.listEnvelopeTitles(`/patient/${encodeURIComponent(puuid)}/medical_problem`);
    }

    async createMedicalProblem(puuid: string, payload: EhrProblemPayload): Promise<void> {
        await this.request('POST', `/patient/${encodeURIComponent(puuid)}/medical_problem`, payload);
    }

    async listAllergyTitles(puuid: string): Promise<string[]> {
        return this.listEnvelopeTitles(`/patient/${encodeURIComponent(puuid)}/allergy`);
    }

    async createAllergy(puuid: string, payload: EhrAllergyPayload): Promise<void> {
        await this.request('POST', `/patient/${encodeURIComponent(puuid)}/allergy`, payload);
    }

    // Medication list routes key on numeric pid and return the raw lists rows — an empty list is
    // a 404, not an empty array (RestControllerHelper::responseHandler, :156-169).
    async listMedicationTitles(pid: string): Promise<string[]> {
        const path = `/patient/${encodeURIComponent(pid)}/medication`;
        let body: unknown;
        try {
            body = await this.request('GET', path);
        } catch (error) {
            if (error instanceof StandardApiError && error.status === 404) {
                return [];
            }
            throw error;
        }
        return Array.isArray(body) ? titlesOf(body) : [];
    }

    async createMedication(pid: string, payload: EhrMedicationPayload): Promise<void> {
        await this.request('POST', `/patient/${encodeURIComponent(pid)}/medication`, payload);
    }

    private async listEnvelopeTitles(path: string): Promise<string[]> {
        const body = await this.request('GET', path);
        const rows = envelopeData(body, path);
        return Array.isArray(rows) ? titlesOf(rows) : [];
    }

    private async request(method: 'GET' | 'POST', path: string, payload?: unknown): Promise<unknown> {
        const token = await this.tokenProvider.getAccessToken();
        const init: RequestInit = {
            method,
            headers: {
                authorization: `Bearer ${token}`,
                accept: 'application/json',
                'x-correlation-id': this.correlationId,
                ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
            },
        };
        if (payload !== undefined) {
            init.body = JSON.stringify(payload);
        }
        const response = await this.fetchImpl(`${this.apiBase}${path}`, init);
        const body = await parseJson(response);
        if (!response.ok) {
            throw new StandardApiError(path, response.status, failureDetail(body));
        }
        return body;
    }
}

// The envelope's data member ({validationErrors, internalErrors, data} — RestControllerHelper.php:254-259).
function envelopeData(body: unknown, path: string): unknown {
    const record = asRecord(body);
    if (record === undefined || !('data' in record)) {
        throw new StandardApiError(path, 200, 'response missing the data envelope');
    }
    return record['data'];
}

function titlesOf(rows: unknown[]): string[] {
    return rows.flatMap((row) => {
        const title = asRecord(row)?.['title'];
        return typeof title === 'string' && title !== '' ? [title] : [];
    });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

async function parseJson(response: Response): Promise<unknown> {
    try {
        return (await response.json()) as unknown;
    } catch {
        return undefined;
    }
}

// Compact human-readable failure detail: validation messages when present (our own synthetic
// payloads — safe to echo), else the kernel's error/message fields. Never the whole body.
function failureDetail(body: unknown): string | undefined {
    const record = asRecord(body);
    if (record === undefined) {
        return undefined;
    }
    const validationErrors = record['validationErrors'];
    if (typeof validationErrors === 'object' && validationErrors !== null && Object.keys(validationErrors).length > 0) {
        return `validation: ${JSON.stringify(validationErrors).slice(0, 500)}`;
    }
    const parts = [record['error'], record['message'], record['error_description']]
        .filter((part): part is string => typeof part === 'string' && part !== '');
    return parts.length > 0 ? parts.join(': ') : undefined;
}
