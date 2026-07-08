// FHIR R4 read-only client for OpenEMR: GET /apis/default/fhir/<Resource> with bearer auth
// (API_README.md:36-38,96-107) and per-patient search via ?patient=<uuid>
// (Documentation/api/FHIR_API.md:116,982-1037). Every request carries the caller's x-correlation-id.
import type { FetchLike } from './auth.js';

export interface TokenProvider {
    getAccessToken(): Promise<string>;
}

// The eight resource types the sidecar reads (matches SYSTEM_SCOPES in ./auth.ts).
export const PATIENT_RESOURCE_TYPES = [
    'AllergyIntolerance',
    'Condition',
    'DiagnosticReport',
    'DocumentReference',
    'Encounter',
    'MedicationRequest',
    'Observation',
    'Patient',
] as const;
export type PatientResourceType = (typeof PATIENT_RESOURCE_TYPES)[number];

export interface FhirBundleEntry {
    fullUrl?: string;
    resource?: Record<string, unknown>;
}

export interface FhirBundle {
    resourceType: 'Bundle';
    total?: number;
    entry?: FhirBundleEntry[];
    [key: string]: unknown;
}

// Typed FHIR failure: status plus OperationOutcome diagnostics when present —
// never the raw response body, which may contain internals.
export class FhirRequestError extends Error {
    constructor(
        path: string,
        public readonly status: number,
        public readonly operationOutcome?: string,
    ) {
        super(`FHIR request ${path} failed with status ${status}${operationOutcome ? ` (${operationOutcome})` : ''}`);
        this.name = 'FhirRequestError';
    }
}

export interface FhirClientOptions {
    baseUrl: string;
    tokenProvider: TokenProvider;
    fetchImpl?: FetchLike;
}

export class FhirClient {
    private readonly fhirBase: string;
    private readonly tokenProvider: TokenProvider;
    private readonly fetchImpl: FetchLike;

    constructor(options: FhirClientOptions) {
        this.fhirBase = `${options.baseUrl.replace(/\/+$/, '')}/apis/default/fhir`;
        this.tokenProvider = options.tokenProvider;
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    }

    async getPatient(patientId: string, correlationId: string): Promise<Record<string, unknown>> {
        return this.request(`/Patient/${encodeURIComponent(patientId)}`, correlationId);
    }

    // Patient name search maps to fname/mname/lname/title (src/Services/FHIR/FhirPatientService.php:130).
    async searchPatients(name: string, correlationId: string): Promise<FhirBundle> {
        const path = `/Patient?${new URLSearchParams({ name }).toString()}`;
        return asBundle(await this.request(path, correlationId), path);
    }

    // Uniform per-patient search. Non-Patient types use the 'patient' reference param
    // (e.g. src/Services/FHIR/FhirConditionService.php:71); Patient itself uses '_id'
    // (src/Services/FHIR/FhirPatientService.php:128) so all eight return a Bundle.
    async searchByPatient(
        resourceType: PatientResourceType,
        patientId: string,
        correlationId: string,
    ): Promise<FhirBundle> {
        const param = resourceType === 'Patient' ? '_id' : 'patient';
        const path = `/${resourceType}?${new URLSearchParams({ [param]: patientId }).toString()}`;
        return asBundle(await this.request(path, correlationId), path);
    }

    private async request(path: string, correlationId: string): Promise<Record<string, unknown>> {
        const token = await this.tokenProvider.getAccessToken();
        const response = await this.fetchImpl(`${this.fhirBase}${path}`, {
            method: 'GET',
            headers: {
                authorization: `Bearer ${token}`,
                accept: 'application/fhir+json',
                'x-correlation-id': correlationId,
            },
        });
        const body = await parseJsonBody(response);
        if (!response.ok) {
            throw new FhirRequestError(path, response.status, operationOutcomeText(body));
        }
        if (body === undefined) {
            throw new FhirRequestError(path, response.status, 'response was not a JSON object');
        }
        return body;
    }
}

function asBundle(body: Record<string, unknown>, path: string): FhirBundle {
    if (body['resourceType'] !== 'Bundle') {
        throw new FhirRequestError(path, 200, 'expected a Bundle resource');
    }
    return body as FhirBundle;
}

async function parseJsonBody(response: Response): Promise<Record<string, unknown> | undefined> {
    try {
        const parsed: unknown = await response.json();
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
        return undefined;
    } catch {
        return undefined;
    }
}

// Extract human-readable diagnostics from an OperationOutcome, if the error body is one.
function operationOutcomeText(body: Record<string, unknown> | undefined): string | undefined {
    if (body?.['resourceType'] !== 'OperationOutcome' || !Array.isArray(body['issue'])) {
        return undefined;
    }
    const texts = body['issue']
        .map((issue: unknown) => {
            if (typeof issue !== 'object' || issue === null) {
                return undefined;
            }
            const record = issue as Record<string, unknown>;
            const diagnostics = record['diagnostics'];
            return typeof diagnostics === 'string' ? diagnostics : undefined;
        })
        .filter((text): text is string => text !== undefined);
    return texts.length > 0 ? texts.join('; ') : undefined;
}
