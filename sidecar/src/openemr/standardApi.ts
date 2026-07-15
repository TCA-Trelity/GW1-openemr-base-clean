// Standard ('api:oemr') REST client for the writes the FHIR facade does not offer to backend
// clients. Routes verbatim from apis/routes/_rest_routes_standard.inc.php: GET|POST /api/patient
// (:84), POST /api/patient/:puuid/medical_problem (:233), POST /api/patient/:puuid/allergy (:278),
// GET|POST /api/patient/:pid/medication (:298-311 — numeric pid, not uuid). Responses use the
// {validationErrors, internalErrors, data} envelope (src/RestControllers/RestControllerHelper.php:204-300)
// except the medication list routes, which return the raw service result and 404 on an empty list
// (RestControllerHelper::responseHandler, :156-169).
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { withTimeoutAndRetry } from '../lib/httpRetry.js';
import { EhrVitalPayloadSchema } from '../schemas/ehrWrites.js';
import type { FetchLike } from './auth.js';
import type { TokenProvider } from './fhir.js';

// Hard per-attempt ceilings (REQ G2). JSON routes get 10s; the multipart document POST gets
// 30s because PDF payloads ride it (well inside the ingestion p95 ≤90s/doc SLO budget).
const STANDARD_API_TIMEOUT_MS = 10_000;
const DOCUMENT_UPLOAD_TIMEOUT_MS = 30_000;

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
    // P4 depth — additional patient_data columns the same route persists.
    email?: string;
    phone_cell?: string;
    phone_home?: string;
    language?: string;
    ethnicity?: string;
    race?: string;
    /** Marital status (patient_data.status). */
    status?: string;
    occupation?: string;
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

export interface EhrEncounterPayload {
    // EncounterValidator::DATABASE_INSERT_CONTEXT (src/Validators/EncounterValidator.php:26-33):
    // pc_catid and class_code (list_options _ActEncounterCode; 'AMB' = ambulatory) are required;
    // the rest lands on form_encounter via EncounterService::insertEncounter.
    pc_catid: number;
    class_code: string;
    date: string;
    reason?: string;
    facility_id?: number;
    billing_facility?: number;
}

// Every field optional (EncounterService::validateVital, :657+). Contract-first (H.11,
// REQ G1): the shape lives in src/schemas/ehrWrites.ts and is parsed in addVital()
// before any network call; the type is inferred so importers keep this module as its home.
export type EhrVitalPayload = z.infer<typeof EhrVitalPayloadSchema>;

export interface EhrSoapNotePayload {
    subjective?: string;
    objective?: string;
    assessment?: string;
    plan?: string;
}

export interface EhrAppointmentPayload {
    // AppointmentService::validate (src/Services/AppointmentService.php:94-102): ALL of these are
    // required; pc_duration is in SECONDS; pc_apptstatus '-' is the stock "scheduled" status.
    pc_catid: number;
    pc_title: string;
    pc_duration: number;
    pc_hometext: string;
    pc_apptstatus: string;
    pc_eventDate: string;
    pc_startTime: string;
    pc_facility: number;
    pc_billing_location: number;
}

export interface EhrInsurancePayload {
    // POST /api/patient/:puuid/insurance (InsuranceRestController::post, :261-283 — type defaults
    // 'primary'). Subscriber fields mirror the patient for relationship 'self'.
    type: 'primary' | 'secondary' | 'tertiary';
    /** insurance_companies.id, as a string — find-or-create via the insurance_company routes. */
    provider: string;
    plan_name?: string;
    policy_number: string;
    group_number?: string;
    subscriber_lname: string;
    subscriber_fname: string;
    subscriber_relationship: string;
    subscriber_DOB: string;
    subscriber_street?: string;
    subscriber_city?: string;
    subscriber_state?: string;
    subscriber_postal_code?: string;
    subscriber_sex?: string;
    /** Coverage effective date (Y-m-d). */
    date: string;
    accept_assignment?: 'TRUE' | 'FALSE';
}

export interface EhrFacilityRecord {
    id: number;
    name: string;
}

export interface EhrEncounterRecord {
    /** form_encounter.encounter — the numeric eid the vital/soap_note routes key on. */
    id: string;
    uuid: string;
    date: string;
    reason: string;
}

export interface EhrAppointmentRecord {
    eventDate: string;
    title: string;
}

export interface EhrInsuranceCompanyRecord {
    id: string;
    name: string;
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
    /** Per-attempt ceiling for the JSON routes; tests shorten it (same shape as rerank's options.timeoutMs). */
    timeoutMs?: number;
    /** Per-attempt ceiling for the multipart document POST (larger: PDF payloads). */
    uploadTimeoutMs?: number;
}

export class StandardApiClient {
    private readonly apiBase: string;
    private readonly tokenProvider: TokenProvider;
    private readonly fetchImpl: FetchLike;
    private readonly correlationId: string;
    private readonly timeoutMs: number;
    private readonly uploadTimeoutMs: number;

    constructor(options: StandardApiClientOptions) {
        this.apiBase = `${options.baseUrl.replace(/\/+$/, '')}/apis/default/api`;
        this.tokenProvider = options.tokenProvider;
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
        this.correlationId = options.correlationId ?? crypto.randomUUID();
        this.timeoutMs = options.timeoutMs ?? STANDARD_API_TIMEOUT_MS;
        this.uploadTimeoutMs = options.uploadTimeoutMs ?? DOCUMENT_UPLOAD_TIMEOUT_MS;
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

    // PUT /api/patient/:puuid (PatientRestController::put) — idempotent demographics converge
    // for patients that already exist (the found branch), so depth added to the corpus after a
    // chart was created still lands on it.
    async updatePatient(puuid: string, payload: EhrPatientPayload): Promise<void> {
        await this.request('PUT', `/patient/${encodeURIComponent(puuid)}`, payload);
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

    // ---- P4 record depth: encounters, vitals, notes, appointments, insurance ----

    async listFacilities(): Promise<EhrFacilityRecord[]> {
        const rows = await this.listEnvelopeRows('/facility');
        return rows.flatMap((row) => {
            const id = Number(row['id']);
            return Number.isFinite(id) && id > 0 ? [{ id, name: typeof row['name'] === 'string' ? row['name'] : '' }] : [];
        });
    }

    async listEncounters(puuid: string): Promise<EhrEncounterRecord[]> {
        const rows = await this.listEnvelopeRows(`/patient/${encodeURIComponent(puuid)}/encounter`);
        return rows.flatMap((row) => {
            // The numeric encounter id column is 'eid' on the list read; tolerate variants.
            const id = row['eid'] ?? row['encounter'] ?? row['id'];
            if (id === undefined || id === null || id === '') {
                return [];
            }
            return [{
                id: String(id),
                uuid: typeof row['uuid'] === 'string' ? row['uuid'] : '',
                date: typeof row['date'] === 'string' ? row['date'] : '',
                reason: typeof row['reason'] === 'string' ? row['reason'] : '',
            }];
        });
    }

    async createEncounter(puuid: string, payload: EhrEncounterPayload): Promise<void> {
        // The 201 envelope's row shape varies by version, so callers re-list and match by
        // date+reason to learn the numeric eid — one extra GET buys shape independence.
        await this.request('POST', `/patient/${encodeURIComponent(puuid)}/encounter`, payload);
    }

    async addVital(pid: string, eid: string, payload: EhrVitalPayload): Promise<void> {
        const path = `/patient/${encodeURIComponent(pid)}/encounter/${encodeURIComponent(eid)}/vital`;
        // Contract boundary (H.11, REQ G1): parse BEFORE any network call — a malformed
        // vitals payload (negative bps, invented key) fails closed here with kind
        // 'validation' and never reaches OpenEMR.
        const parsed = EhrVitalPayloadSchema.safeParse(payload);
        if (!parsed.success) {
            throw new StandardApiError(
                path,
                400,
                `vitals payload failed contract: ${parsed.error.issues
                    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
                    .join('; ')}`,
            );
        }
        await this.request('POST', path, parsed.data);
    }

    async addSoapNote(pid: string, eid: string, payload: EhrSoapNotePayload): Promise<void> {
        await this.request('POST', `/patient/${encodeURIComponent(pid)}/encounter/${encodeURIComponent(eid)}/soap_note`, payload);
    }

    async listAppointments(pid: string): Promise<EhrAppointmentRecord[]> {
        // Live lesson: this route answers like the medication list — RAW rows through the legacy
        // responseHandler (no {data} envelope; AppointmentRestController::getAllForPatient) and a
        // 404 when the calendar is empty. Tolerate an envelope too in case the route modernizes.
        const path = `/patient/${encodeURIComponent(pid)}/appointment`;
        let body: unknown;
        try {
            body = await this.request('GET', path);
        } catch (error) {
            if (error instanceof StandardApiError && error.status === 404) {
                return [];
            }
            throw error;
        }
        const envelope = asRecord(body);
        const rows = Array.isArray(body) ? body : envelope !== undefined && Array.isArray(envelope['data']) ? envelope['data'] : [];
        return rows.flatMap((row) => {
            const record = asRecord(row);
            if (record === undefined) {
                return [];
            }
            return [{
                eventDate: typeof record['pc_eventDate'] === 'string' ? record['pc_eventDate'] : '',
                title: typeof record['pc_title'] === 'string' ? record['pc_title'] : '',
            }];
        });
    }

    async createAppointment(pid: string, payload: EhrAppointmentPayload): Promise<void> {
        await this.request('POST', `/patient/${encodeURIComponent(pid)}/appointment`, payload);
    }

    async listInsuranceCompanies(): Promise<EhrInsuranceCompanyRecord[]> {
        let rows: Record<string, unknown>[];
        try {
            rows = await this.listEnvelopeRows('/insurance_company');
        } catch (error) {
            if (error instanceof StandardApiError && error.status === 404) {
                return []; // fresh install has none
            }
            throw error;
        }
        return rows.flatMap((row) => {
            const id = row['id'];
            if (id === undefined || id === null || id === '') {
                return [];
            }
            return [{ id: String(id), name: typeof row['name'] === 'string' ? row['name'] : '' }];
        });
    }

    async createInsuranceCompany(name: string): Promise<void> {
        // Like encounters, the create response row shape varies — callers re-list by name.
        await this.request('POST', '/insurance_company', { name });
    }

    /** Coverage types already on file ('primary' | ...), for idempotent insurance seeding. */
    async listInsuranceTypes(puuid: string): Promise<string[]> {
        let rows: Record<string, unknown>[];
        try {
            rows = await this.listEnvelopeRows(`/patient/${encodeURIComponent(puuid)}/insurance`);
        } catch (error) {
            if (error instanceof StandardApiError && error.status === 404) {
                return [];
            }
            throw error;
        }
        return rows.flatMap((row) => (typeof row['type'] === 'string' && row['type'] !== '' ? [row['type']] : []));
    }

    async createInsurance(puuid: string, payload: EhrInsurancePayload): Promise<void> {
        await this.request('POST', `/patient/${encodeURIComponent(puuid)}/insurance`, payload);
    }

    /** Envelope list read → array of records (non-record rows dropped). */
    private async listEnvelopeRows(path: string): Promise<Record<string, unknown>[]> {
        const body = await this.request('GET', path);
        const rows = envelopeData(body, path);
        if (!Array.isArray(rows)) {
            return [];
        }
        return rows.flatMap((row) => {
            const record = asRecord(row);
            return record === undefined ? [] : [record];
        });
    }

    private async listEnvelopeTitles(path: string): Promise<string[]> {
        const body = await this.request('GET', path);
        const rows = envelopeData(body, path);
        return Array.isArray(rows) ? titlesOf(rows) : [];
    }

    private async request(method: 'GET' | 'POST' | 'PUT', path: string, payload?: unknown): Promise<unknown> {
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
        // Method-aware retry policy (REQ G2): a retried write can double-file a document; the A.3 post-write verification re-lists by content hash but guards absence, not duplicates — so only idempotent GETs get the helper's one bounded retry.
        const retries = method === 'GET' ? 1 : 0;
        return withTimeoutAndRetry(`standard API ${method} ${path}`, this.timeoutMs, async (signal) => {
            const response = await this.fetchImpl(`${this.apiBase}${path}`, { ...init, signal });
            const body = await parseJson(response);
            if (!response.ok) {
                throw new StandardApiError(path, response.status, failureDetail(body));
            }
            return body;
        }, {
            retries,
            // Timeouts stay in the standard-API error family so callers' instanceof handling
            // (e.g. ehrSeed's degrade-to-skipped depth sections) keeps working.
            onTimeout: (operation, timeoutMs) => new StandardApiError(path, 408, `${operation} timed out after ${timeoutMs}ms`),
        });
    }

    // ---- Week 2 documents (Wave 0.2, REQ S1/R1) ----
    // Route verbatim from apis/routes/_rest_routes_standard.inc.php:496-510: POST|GET
    // /api/patient/:pid/document?path=<Category> (multipart field name `document`,
    // DocumentRestController::postWithPath → DocumentService::insertAtPath) and
    // GET .../document listing {filename, hash, id, mimetype, docdate} rows
    // (DocumentService::getAllAtPath — the hash is sha3-512 of the file bytes,
    // Document.class.php:1114). Three server behaviors shape this client (all found the
    // hard way — live 404s on the 2026-07-15 evaluator run):
    //
    // 1. :pid is the NUMERIC patient id, and the route fails OPEN on anything else:
    //    Document::calculateStoragePath (library/classes/Document.class.php:93-103)
    //    silently reassigns a non-numeric id to 0, so a uuid-keyed POST returns 200 while
    //    filing the row with foreign_id = 0 — no patient's chart. Both methods therefore
    //    resolve uuid → pid via GET /api/patient/:puuid and refuse anything that is
    //    neither a uuid nor a positive integer.
    // 2. The category is matched with asymmetric normalization (DocumentService.php:52-94):
    //    SQL strips spaces + lowercases the stored name while PHP strips only UNDERSCORES
    //    from the input — so 'Lab Report' can never match and the wire format is
    //    'Lab_Report'. An unmatched path is NOT rejected: validation passes vacuously, the
    //    category id resolves null, and createDocument still persists the row
    //    (Document.class.php:1122-1128 skips the category link for a non-numeric id) →
    //    200 with a silently orphaned document. wireCategoryPath() plus the post-write
    //    verification in uploadPatientDocumentDeduped are the two guards.
    // 3. Responses are RAW (responseHandler → getResponseForPayload — no {data} envelope):
    //    GET returns the rows array, POST returns literal true, and an EMPTY category is
    //    a 404 (responseHandler treats [] as falsy, RestControllerHelper.php:156-169) —
    //    so the listing tolerates 404 as "no documents yet", the same contract as
    //    listMedicationTitles above.

    /** uuid → numeric pid cache; a chart's pid never changes, so one lookup per client. */
    private readonly pidByUuid = new Map<string, string>();

    private async resolveNumericPid(pidOrUuid: number | string): Promise<string> {
        const raw = String(pidOrUuid).trim();
        if (/^[1-9]\d*$/.test(raw)) {
            return raw;
        }
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
            throw new StandardApiError(
                `/patient/${raw}/document`,
                400,
                'patient id is neither a numeric pid nor a uuid — refusing, OpenEMR would silently file the document to patient 0',
            );
        }
        const cached = this.pidByUuid.get(raw);
        if (cached !== undefined) {
            return cached;
        }
        const path = `/patient/${encodeURIComponent(raw)}`;
        const body = await this.request('GET', path);
        const pid = asRecord(envelopeData(body, path))?.['pid'];
        const numeric = typeof pid === 'number' || typeof pid === 'string' ? String(pid) : '';
        if (!/^[1-9]\d*$/.test(numeric)) {
            throw new StandardApiError(path, 200, 'patient record carries no numeric pid to file documents under');
        }
        this.pidByUuid.set(raw, numeric);
        return numeric;
    }

    /**
     * Category name → the route's wire format: spaces become underscores ('Lab Report' →
     * 'Lab_Report'), which the server maps back against space-stripped category names.
     * Callers keep the human-readable seeded names (EHR_CATEGORY in ingest/service.ts).
     */
    private wireCategoryPath(categoryPath: string): string {
        return categoryPath.trim().replace(/ /g, '_');
    }

    /**
     * List the patient's documents filed under a category (e.g. 'Lab Report'). A 404 is
     * "no documents in this category yet" — OpenEMR 404s empty listings by design — so
     * first-use categories return [] instead of failing the caller.
     */
    async listPatientDocuments(pidOrUuid: number | string, categoryPath: string): Promise<EhrDocumentRow[]> {
        const pid = await this.resolveNumericPid(pidOrUuid);
        const path = `/patient/${pid}/document?path=${encodeURIComponent(this.wireCategoryPath(categoryPath))}`;
        let body: unknown;
        try {
            body = await this.request('GET', path);
        } catch (error) {
            if (error instanceof StandardApiError && error.status === 404) {
                return [];
            }
            throw error;
        }
        if (!Array.isArray(body)) {
            return [];
        }
        return body.flatMap((row) => {
            const record = asRecord(row);
            const id = record?.['id'];
            const hash = record?.['hash'];
            if (record === undefined || (typeof id !== 'number' && typeof id !== 'string')) {
                return [];
            }
            return [
                {
                    id: String(id),
                    filename: typeof record['filename'] === 'string' ? record['filename'] : null,
                    hash: typeof hash === 'string' ? hash : null,
                    mimetype: typeof record['mimetype'] === 'string' ? record['mimetype'] : null,
                    docdate: typeof record['docdate'] === 'string' ? record['docdate'] : null,
                },
            ];
        });
    }

    /**
     * Upload a document into the patient's chart with caller-side sha3-512 dedupe:
     * OpenEMR stores the hash but does NOT enforce uniqueness (Document::createDocument
     * does no pre-insert lookup), so a byte-identical re-upload would create a second
     * documents row — the integrity requirement ("no duplicate or untraceable records")
     * is the caller's job. Byte-identical content → the existing document id, no POST.
     *
     * The POST body is literal `true` (no document id), and a mis-resolved category
     * still "succeeds" while orphaning the document (behavior 2 above) — so after every
     * write this method re-lists the category and requires our hash to appear, returning
     * the listed row's real id. Absence throws instead of reporting a half-ingested
     * upload (W2_ARCHITECTURE §12: uploads land failed-visible, never half-ingested).
     */
    async uploadPatientDocumentDeduped(
        pidOrUuid: number | string,
        categoryPath: string,
        filename: string,
        bytes: Uint8Array,
        mimeType: string,
    ): Promise<EhrDocumentUploadResult> {
        const pid = await this.resolveNumericPid(pidOrUuid);
        const hash = sha3_512Hex(bytes);
        const existing = await this.listPatientDocuments(pid, categoryPath);
        const match = existing.find((row) => row.hash === hash);
        if (match !== undefined) {
            return { documentId: match.id, hash, deduped: true };
        }

        const path = `/patient/${pid}/document?path=${encodeURIComponent(this.wireCategoryPath(categoryPath))}`;
        const token = await this.tokenProvider.getAccessToken();
        const form = new FormData();
        // Copy into a fresh ArrayBuffer so a Uint8Array view over a larger/shared buffer
        // (or a SharedArrayBuffer) can never leak sibling bytes into the Blob.
        const payload = new Uint8Array(bytes);
        form.append('document', new Blob([payload.buffer as ArrayBuffer], { type: mimeType }), filename);
        // No manual content-type: fetch sets the multipart boundary itself.
        // Non-idempotent write — timeout only, retries: 0: a retried write can double-file a document; the A.3 post-write verification below re-lists by content hash but guards absence, not duplicates.
        await withTimeoutAndRetry(`standard API POST ${path} (document upload)`, this.uploadTimeoutMs, async (signal) => {
            const response = await this.fetchImpl(`${this.apiBase}${path}`, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${token}`,
                    accept: 'application/json',
                    'x-correlation-id': this.correlationId,
                },
                body: form,
                signal,
            });
            const body = await parseJson(response);
            if (!response.ok) {
                throw new StandardApiError(path, response.status, failureDetail(body));
            }
        }, {
            retries: 0,
            onTimeout: (operation, timeoutMs) => new StandardApiError(path, 408, `${operation} timed out after ${timeoutMs}ms`),
        });

        // Post-write verification: the write is only real if the document is now listed
        // under the category with our hash (REQ G1 "no untraceable records") — this is
        // what catches the silent category-orphan mode, and it is also the only way to
        // learn the new document's id (the POST body is literal `true`).
        const filed = (await this.listPatientDocuments(pid, categoryPath)).find((row) => row.hash === hash);
        if (filed === undefined) {
            throw new StandardApiError(
                path,
                502,
                'write reported success but the document is not filed under the category — refusing to report a half-ingested upload',
            );
        }
        return { documentId: filed.id, hash, deduped: false };
    }
}

export interface EhrDocumentRow {
    id: string;
    filename: string | null;
    /** sha3-512 hex of the stored bytes (Document.class.php:1114) — the dedupe key. */
    hash: string | null;
    mimetype: string | null;
    docdate: string | null;
}

export interface EhrDocumentUploadResult {
    /** OpenEMR documents.id — from the dedupe match, or the post-write verification listing. */
    documentId: string;
    /** sha3-512 hex of the uploaded bytes (matches OpenEMR's stored hash). */
    hash: string;
    /** true → byte-identical document already existed; no new row was created. */
    deduped: boolean;
}

/** sha3-512 hex digest — the same algorithm OpenEMR stores in documents.hash. */
export function sha3_512Hex(bytes: Uint8Array): string {
    return createHash('sha3-512').update(bytes).digest('hex');
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
