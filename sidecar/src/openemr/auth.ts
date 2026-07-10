// OpenEMR OAuth2 clients: dynamic registration, client_credentials (SMART Backend Services,
// RS384 JWT assertion, FHIR reads) and password grant (user-role token, standard-API writes for
// EHR seeding). Contract: src/RestControllers/AuthorizationController.php:268-357 (registration),
// src/Services/JWTClientAuthenticationService.php:201-407 (assertion), Documentation/api/AUTHENTICATION.md:496-570,609-640.
import {
    createHash,
    createPrivateKey,
    createPublicKey,
    generateKeyPairSync,
    randomUUID,
    sign as cryptoSign,
    type KeyObject,
} from 'node:crypto';

// Minimal fetch shape so tests inject a mock and Railway scripts use globalThis.fetch.
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface RsaPublicJwk {
    kty: 'RSA';
    n: string;
    e: string;
    kid: string;
    use: 'sig';
    // Server verifies assertions with RS384 only (src/Services/JWTClientAuthenticationService.php:263,
    // src/Common/Auth/OpenIDConnect/JWT/RsaSha384Signer.php:42).
    alg: 'RS384';
}

export interface Jwks {
    keys: RsaPublicJwk[];
}

// v1 system read scopes are server-approved for exactly these resource names
// (src/Common/Auth/OpenIDConnect/Entities/ServerScopeListEntity.php:75-116); 'api:fhir'
// gates FHIR API use (src/Common/Auth/OpenIDConnect/Repositories/ScopeRepository.php:250).
export const SYSTEM_SCOPES: readonly string[] = [
    'api:fhir',
    'system/Patient.read',
    'system/Condition.read',
    'system/MedicationRequest.read',
    'system/AllergyIntolerance.read',
    'system/Encounter.read',
    'system/Observation.read',
    'system/DiagnosticReport.read',
    'system/DocumentReference.read',
    'system/Coverage.read',
];

// Standard-API ('api:oemr') scopes the EHR seeding script needs. There is no system-client
// path here: /api/ routes reject the 'system' role outright (src/RestControllers/Subscriber/
// AuthorizationListener.php:170-175, src/RestControllers/Authorization/
// BearerTokenAuthorizationStrategy.php:383-395) and the server's standard-API scope list
// contains no system/* entries at all (src/Common/Auth/OpenIDConnect/Entities/
// ServerScopeListEntity.php:206-260) — so writes ride a password-grant *user* token instead.
// Scope strings verbatim from ServerScopeListEntity::apiScopes(); 'write' covers POST/PUT and
// 'read' covers GET/search per ScopePermissionObject::createFromString ('read'→rs, 'write'→cud).
export const STANDARD_API_SEED_SCOPES: readonly string[] = [
    'api:oemr',
    'user/patient.read',
    'user/patient.write',
    'user/medical_problem.read',
    'user/medical_problem.write',
    'user/allergy.read',
    'user/allergy.write',
    'user/medication.read',
    'user/medication.write',
    // P4 record depth — a client registered before these existed must be RE-registered
    // (granted scopes are intersected with registration; see the register-oauth runbook).
    'user/encounter.read',
    'user/encounter.write',
    'user/vital.read',
    'user/vital.write',
    'user/soap_note.read',
    'user/soap_note.write',
    'user/appointment.read',
    'user/appointment.write',
    'user/insurance.read',
    'user/insurance.write',
    'user/insurance_company.read',
    'user/insurance_company.write',
    'user/facility.read',
];

// Typed OAuth failure: carries HTTP status and the OAuth error code/description only —
// never the raw response body, which may contain internals.
export class OpenEmrAuthError extends Error {
    constructor(
        operation: string,
        public readonly status: number,
        public readonly oauthError?: string,
        public readonly oauthErrorDescription?: string,
    ) {
        const detail = [oauthError, oauthErrorDescription].filter(Boolean).join(': ');
        super(`${operation} failed with status ${status}${detail ? ` (${detail})` : ''}`);
        this.name = 'OpenEmrAuthError';
    }
}

export interface GeneratedClientKey {
    privateKeyPem: string;
    kid: string;
    jwks: Jwks;
}

// RSA keypair for asymmetric client auth. Server requires RSA >= 2048 bits, RS384
// (Documentation/api/AUTHENTICATION.md:203-206). kid is the RFC 7638 JWK thumbprint so it
// is recomputable from the private key alone — no separate kid needs storing.
export function generateClientKey(modulusLength: number = 2048): GeneratedClientKey {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength });
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const jwk = publicJwkFromPrivateKey(privateKey);
    return { privateKeyPem, kid: jwk.kid, jwks: { keys: [jwk] } };
}

// Accepts a real PEM or the '\n'-escaped single-line form used in env vars.
export function normalizePem(pem: string): string {
    return pem.replace(/\\n/g, '\n');
}

function publicJwkFromPrivateKey(privateKey: KeyObject): RsaPublicJwk {
    const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
    if (jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') {
        throw new Error('expected an RSA private key');
    }
    // RFC 7638 thumbprint: SHA-256 of the required members in lexicographic order.
    const kid = createHash('sha256')
        .update(JSON.stringify({ e: jwk.e, kty: 'RSA', n: jwk.n }))
        .digest('base64url');
    return { kty: 'RSA', n: jwk.n, e: jwk.e, kid, use: 'sig', alg: 'RS384' };
}

export interface RegisterSystemClientOptions {
    baseUrl: string;
    clientName: string;
    jwks: Jwks;
    scopes?: readonly string[];
    contacts?: readonly string[];
    redirectUris?: readonly string[];
    /** Defaults to ['client_credentials']; add 'password' when the client also seeds via the standard API. */
    grantTypes?: readonly string[];
    fetchImpl?: FetchLike;
}

export interface RegisteredClient {
    clientId: string;
    scope?: string;
    registrationAccessToken?: string;
    registrationClientUri?: string;
}

// POST /oauth2/default/registration with Content-Type application/json
// (AuthorizationController.php:259-261). System scopes demand application_type 'private'
// (:325-330) plus an inline jwks or jwks_uri (:317-323); token_endpoint_auth_method must be
// one of the values at :274. redirect_uris is required even for backend clients (:355-357).
export async function registerSystemClient(options: RegisterSystemClientOptions): Promise<RegisteredClient> {
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const base = options.baseUrl.replace(/\/+$/, '');
    const body: Record<string, unknown> = {
        application_type: 'private',
        client_name: options.clientName,
        token_endpoint_auth_method: 'private_key_jwt',
        grant_types: options.grantTypes ?? ['client_credentials'],
        // Never followed under client_credentials, but registration rejects its absence.
        redirect_uris: options.redirectUris ?? [`${base}/sidecar-backend-service-unused-callback`],
        scope: (options.scopes ?? SYSTEM_SCOPES).join(' '),
        jwks: options.jwks,
    };
    if (options.contacts !== undefined) {
        body['contacts'] = options.contacts;
    }

    const response = await fetchImpl(`${base}/oauth2/default/registration`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    const payload = await parseJsonBody(response);
    if (!response.ok) {
        throw authErrorFrom('client registration', response.status, payload);
    }
    const clientId = payload?.['client_id'];
    if (typeof clientId !== 'string' || clientId === '') {
        throw new OpenEmrAuthError('client registration', response.status, undefined, 'response missing client_id');
    }
    const registered: RegisteredClient = { clientId };
    if (typeof payload?.['scope'] === 'string') {
        registered.scope = payload['scope'];
    }
    if (typeof payload?.['registration_access_token'] === 'string') {
        registered.registrationAccessToken = payload['registration_access_token'];
    }
    if (typeof payload?.['registration_client_uri'] === 'string') {
        registered.registrationClientUri = payload['registration_client_uri'];
    }
    return registered;
}

export interface OpenEmrAuthClientOptions {
    baseUrl: string;
    clientId: string;
    /** PKCS8 PEM private key; the '\n'-escaped single-line env-var form also accepted. */
    privateKeyPem: string;
    scopes?: readonly string[];
    fetchImpl?: FetchLike;
    /** Epoch-milliseconds clock, injectable for deterministic expiry tests. */
    now?: () => number;
}

// Docs cap assertion exp at iat + 5 minutes (Documentation/api/AUTHENTICATION.md:543); the server
// additionally rejects iat older than 5 minutes (JWTClientAuthenticationService.php:387-401).
const ASSERTION_LIFETIME_SECONDS = 300;
// Refresh slightly early so a token never expires mid-request (tokens live ~60s, AUTHENTICATION.md:570).
const TOKEN_EXPIRY_SKEW_MS = 5_000;

export class OpenEmrAuthClient {
    private readonly fetchImpl: FetchLike;
    private readonly now: () => number;
    private readonly tokenUrl: string;
    private readonly clientId: string;
    private readonly scopes: readonly string[];
    private readonly privateKey: KeyObject;
    private readonly kid: string;
    private cached: { token: string; expiresAtMs: number } | undefined;

    constructor(options: OpenEmrAuthClientOptions) {
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
        this.now = options.now ?? Date.now;
        this.tokenUrl = `${options.baseUrl.replace(/\/+$/, '')}/oauth2/default/token`;
        this.clientId = options.clientId;
        this.scopes = options.scopes ?? SYSTEM_SCOPES;
        this.privateKey = createPrivateKey(normalizePem(options.privateKeyPem));
        // Recompute the RFC 7638 kid; the assertion header kid must match the registered JWK
        // (src/Common/Auth/OpenIDConnect/JWT/JsonWebKeySet.php:86-90).
        this.kid = publicJwkFromPrivateKey(this.privateKey).kid;
    }

    // Returns a valid bearer token, reusing the cached one until near expiry.
    async getAccessToken(): Promise<string> {
        if (this.cached !== undefined && this.now() < this.cached.expiresAtMs) {
            return this.cached.token;
        }
        // Form parameters per Documentation/api/AUTHENTICATION.md:549-557; the server only accepts
        // JWT client assertions on this grant (CustomClientCredentialsGrant.php:159-175) and the
        // exact assertion-type URN is required (JWTClientAuthenticationService.php:57,128-135).
        const form = new URLSearchParams({
            grant_type: 'client_credentials',
            client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
            client_assertion: this.buildClientAssertion(),
            scope: this.scopes.join(' '),
        });
        const response = await this.fetchImpl(this.tokenUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: form.toString(),
        });
        const payload = await parseJsonBody(response);
        if (!response.ok) {
            throw authErrorFrom('token request', response.status, payload);
        }
        const token = payload?.['access_token'];
        if (typeof token !== 'string' || token === '') {
            throw new OpenEmrAuthError('token request', response.status, undefined, 'response missing access_token');
        }
        const expiresIn = typeof payload?.['expires_in'] === 'number' ? payload['expires_in'] : 60;
        this.cached = { token, expiresAtMs: this.now() + expiresIn * 1000 - TOKEN_EXPIRY_SKEW_MS };
        return token;
    }

    // RFC 7523 assertion: iss=sub=client_id, aud=token endpoint, unique jti, RS384 signature
    // (validated at JWTClientAuthenticationService.php:256-270,345-407).
    private buildClientAssertion(): string {
        const nowSeconds = Math.floor(this.now() / 1000);
        const header = { alg: 'RS384', typ: 'JWT', kid: this.kid };
        const claims = {
            iss: this.clientId,
            sub: this.clientId,
            aud: this.tokenUrl,
            jti: randomUUID(),
            iat: nowSeconds,
            exp: nowSeconds + ASSERTION_LIFETIME_SECONDS,
        };
        const signingInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
        const signature = cryptoSign('sha384', Buffer.from(signingInput), this.privateKey).toString('base64url');
        return `${signingInput}.${signature}`;
    }
}

export interface OpenEmrPasswordAuthClientOptions {
    baseUrl: string;
    clientId: string;
    /** OpenEMR user credentials (e.g. the admin account) — the token acts AS this user. */
    username: string;
    password: string;
    scopes?: readonly string[];
    fetchImpl?: FetchLike;
    /** Epoch-milliseconds clock, injectable for deterministic expiry tests. */
    now?: () => number;
}

// OAuth2 password grant for a *user-role* token — the only headless path to the standard
// ('api:oemr') API, which is closed to system clients (see STANDARD_API_SEED_SCOPES note).
// Server side: the grant is enabled only when the 'oauth_password_grant' global is on
// (src/RestControllers/AuthorizationController.php:736-748) and requires username/password/
// user_role form fields (src/Common/Auth/OpenIDConnect/Grant/CustomPasswordGrant.php:51-110);
// granted scopes are intersected with the client's *registered* scopes
// (src/Common/Auth/OpenIDConnect/Repositories/ScopeRepository.php:137-188), so the client must
// have been registered with STANDARD_API_SEED_SCOPES for writes to work.
export class OpenEmrPasswordAuthClient {
    private readonly fetchImpl: FetchLike;
    private readonly now: () => number;
    private readonly tokenUrl: string;
    private readonly clientId: string;
    private readonly username: string;
    private readonly password: string;
    private readonly scopes: readonly string[];
    private cached: { token: string; expiresAtMs: number } | undefined;

    constructor(options: OpenEmrPasswordAuthClientOptions) {
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
        this.now = options.now ?? Date.now;
        this.tokenUrl = `${options.baseUrl.replace(/\/+$/, '')}/oauth2/default/token`;
        this.clientId = options.clientId;
        this.username = options.username;
        this.password = options.password;
        this.scopes = options.scopes ?? STANDARD_API_SEED_SCOPES;
    }

    // Returns a valid user-role bearer token, reusing the cached one until near expiry.
    async getAccessToken(): Promise<string> {
        if (this.cached !== undefined && this.now() < this.cached.expiresAtMs) {
            return this.cached.token;
        }
        // Form parameters per Documentation/api/AUTHENTICATION.md:609-640: no client secret —
        // ClientRepository::validateClient() accepts password-grant clients by id alone
        // (src/Common/Auth/OpenIDConnect/Repositories/ClientRepository.php:218-221).
        const form = new URLSearchParams({
            grant_type: 'password',
            client_id: this.clientId,
            user_role: 'users',
            username: this.username,
            password: this.password,
            scope: this.scopes.join(' '),
        });
        const response = await this.fetchImpl(this.tokenUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: form.toString(),
        });
        const payload = await parseJsonBody(response);
        if (!response.ok) {
            throw authErrorFrom('password token request', response.status, payload);
        }
        const token = payload?.['access_token'];
        if (typeof token !== 'string' || token === '') {
            throw new OpenEmrAuthError('password token request', response.status, undefined, 'response missing access_token');
        }
        const expiresIn = typeof payload?.['expires_in'] === 'number' ? payload['expires_in'] : 60;
        this.cached = { token, expiresAtMs: this.now() + expiresIn * 1000 - TOKEN_EXPIRY_SKEW_MS };
        return token;
    }
}

function base64UrlJson(value: unknown): string {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}

// Best-effort JSON parse; non-JSON bodies yield undefined so they never leak into errors.
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

function authErrorFrom(
    operation: string,
    status: number,
    payload: Record<string, unknown> | undefined,
): OpenEmrAuthError {
    const error = typeof payload?.['error'] === 'string' ? payload['error'] : undefined;
    const description = typeof payload?.['error_description'] === 'string' ? payload['error_description'] : undefined;
    return new OpenEmrAuthError(operation, status, error, description);
}
