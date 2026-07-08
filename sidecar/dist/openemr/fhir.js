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
];
// Typed FHIR failure: status plus OperationOutcome diagnostics when present —
// never the raw response body, which may contain internals.
export class FhirRequestError extends Error {
    status;
    operationOutcome;
    constructor(path, status, operationOutcome) {
        super(`FHIR request ${path} failed with status ${status}${operationOutcome ? ` (${operationOutcome})` : ''}`);
        this.status = status;
        this.operationOutcome = operationOutcome;
        this.name = 'FhirRequestError';
    }
}
export class FhirClient {
    fhirBase;
    tokenProvider;
    fetchImpl;
    constructor(options) {
        this.fhirBase = `${options.baseUrl.replace(/\/+$/, '')}/apis/default/fhir`;
        this.tokenProvider = options.tokenProvider;
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    }
    async getPatient(patientId, correlationId) {
        return this.request(`/Patient/${encodeURIComponent(patientId)}`, correlationId);
    }
    // Patient name search maps to fname/mname/lname/title (src/Services/FHIR/FhirPatientService.php:130).
    async searchPatients(name, correlationId) {
        const path = `/Patient?${new URLSearchParams({ name }).toString()}`;
        return asBundle(await this.request(path, correlationId), path);
    }
    // Uniform per-patient search. Non-Patient types use the 'patient' reference param
    // (e.g. src/Services/FHIR/FhirConditionService.php:71); Patient itself uses '_id'
    // (src/Services/FHIR/FhirPatientService.php:128) so all eight return a Bundle.
    async searchByPatient(resourceType, patientId, correlationId) {
        const param = resourceType === 'Patient' ? '_id' : 'patient';
        const path = `/${resourceType}?${new URLSearchParams({ [param]: patientId }).toString()}`;
        return asBundle(await this.request(path, correlationId), path);
    }
    async request(path, correlationId) {
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
function asBundle(body, path) {
    if (body['resourceType'] !== 'Bundle') {
        throw new FhirRequestError(path, 200, 'expected a Bundle resource');
    }
    return body;
}
async function parseJsonBody(response) {
    try {
        const parsed = await response.json();
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            return parsed;
        }
        return undefined;
    }
    catch {
        return undefined;
    }
}
// Extract human-readable diagnostics from an OperationOutcome, if the error body is one.
function operationOutcomeText(body) {
    if (body?.['resourceType'] !== 'OperationOutcome' || !Array.isArray(body['issue'])) {
        return undefined;
    }
    const texts = body['issue']
        .map((issue) => {
        if (typeof issue !== 'object' || issue === null) {
            return undefined;
        }
        const record = issue;
        const diagnostics = record['diagnostics'];
        return typeof diagnostics === 'string' ? diagnostics : undefined;
    })
        .filter((text) => text !== undefined);
    return texts.length > 0 ? texts.join('; ') : undefined;
}
//# sourceMappingURL=fhir.js.map