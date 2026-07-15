// OpenEMR client tests with injected fetch mocks (no live EHR in dev). Each test names the
// failure mode it guards (project convention). Contract citations live in src/openemr/*.ts.
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    generateClientKey,
    OpenEmrAuthClient,
    OpenEmrAuthError,
    registerSystemClient,
    SYSTEM_SCOPES,
    type FetchLike,
} from '../src/openemr/auth.js';
import { FhirClient, FhirRequestError, PATIENT_RESOURCE_TYPES } from '../src/openemr/fhir.js';

const BASE_URL = 'https://ehr.example.test';

// One shared keypair: RSA generation is the slow part and key contents don't vary per test.
const KEY = generateClientKey(2048);

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function fetchMockReturning(...responses: Response[]) {
    const mock = vi.fn<FetchLike>();
    for (const response of responses) {
        mock.mockResolvedValueOnce(response);
    }
    return mock;
}

function decodeJwt(jwt: string) {
    const [headerPart, claimsPart, signaturePart] = jwt.split('.');
    if (headerPart === undefined || claimsPart === undefined || signaturePart === undefined) {
        throw new Error('malformed JWT');
    }
    return {
        header: JSON.parse(Buffer.from(headerPart, 'base64url').toString()) as Record<string, unknown>,
        claims: JSON.parse(Buffer.from(claimsPart, 'base64url').toString()) as Record<string, unknown>,
        signingInput: `${headerPart}.${claimsPart}`,
        signature: Buffer.from(signaturePart, 'base64url'),
    };
}

describe('generateClientKey', () => {
    // Guards: OpenEMR matches the assertion's JWK by kid and only verifies RS384
    // (JsonWebKeySet.php:86-90, RsaSha384Signer.php:42) — a malformed JWKS means every
    // token request fails invalid_client after a registration that appeared to succeed.
    it('produces a single RSA signing JWK advertising RS384 with a kid', () => {
        expect(KEY.jwks.keys).toHaveLength(1);
        const jwk = KEY.jwks.keys[0]!;
        expect(jwk).toMatchObject({ kty: 'RSA', use: 'sig', alg: 'RS384' });
        expect(jwk.n).toBeTruthy();
        expect(jwk.e).toBe('AQAB');
        expect(jwk.kid).toBe(KEY.kid);
        expect(KEY.privateKeyPem).toContain('BEGIN PRIVATE KEY');
    });
});

describe('registerSystemClient', () => {
    // Guards: the registration endpoint rejects system scopes without inline jwks/jwks_uri,
    // rejects missing redirect_uris, and requires application/json + application_type 'private'
    // (AuthorizationController.php:259-261,312-330,355-357) — any drift bricks onboarding.
    it('sends the registration shape a system client requires', async () => {
        const fetch = fetchMockReturning(jsonResponse(200, { client_id: 'cid-1', scope: SYSTEM_SCOPES.join(' ') }));
        await registerSystemClient({
            baseUrl: `${BASE_URL}/`,
            clientName: 'Test Sidecar',
            jwks: KEY.jwks,
            fetchImpl: fetch,
        });

        expect(fetch).toHaveBeenCalledOnce();
        const [url, init] = fetch.mock.calls[0]!;
        expect(url).toBe(`${BASE_URL}/oauth2/default/registration`);
        expect(init?.method).toBe('POST');
        expect(new Headers(init?.headers).get('content-type')).toBe('application/json');

        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body['application_type']).toBe('private');
        expect(body['token_endpoint_auth_method']).toBe('private_key_jwt');
        expect(body['grant_types']).toEqual(['client_credentials']);
        expect(Array.isArray(body['redirect_uris'])).toBe(true);
        expect((body['redirect_uris'] as string[]).length).toBeGreaterThan(0);
        expect(body['jwks']).toEqual(KEY.jwks);
        expect(body['scope']).toBe(SYSTEM_SCOPES.join(' '));
    });

    // Guards: the scope string must name exactly the server-approved v1 system scopes
    // (ServerScopeListEntity.php:111-116) — a typo'd resource fails the whole registration
    // with invalid_scope (AuthorizationController.php:331).
    it('requests api:fhir plus system read scope for all eight resource types', () => {
        expect(SYSTEM_SCOPES).toContain('api:fhir');
        for (const resource of PATIENT_RESOURCE_TYPES) {
            expect(SYSTEM_SCOPES).toContain(`system/${resource}.read`);
        }
    });

    // Guards: swallowing registration failures (or leaking raw response bodies into thrown
    // messages) — callers need status + OAuth error code, nothing more.
    it('throws a typed error carrying status and OAuth error code, not the raw body', async () => {
        const fetch = fetchMockReturning(
            jsonResponse(400, {
                error: 'invalid_client_metadata',
                error_description: 'jwks is invalid',
                internal_stack: 'SECRET-INTERNALS',
            }),
        );
        const attempt = registerSystemClient({
            baseUrl: BASE_URL,
            clientName: 'Test Sidecar',
            jwks: KEY.jwks,
            fetchImpl: fetch,
        });
        await expect(attempt).rejects.toThrow(OpenEmrAuthError);
        const error = await attempt.catch((e: unknown) => e as OpenEmrAuthError);
        expect(error.status).toBe(400);
        expect(error.oauthError).toBe('invalid_client_metadata');
        expect(error.message).toContain('400');
        expect(error.message).not.toContain('SECRET-INTERNALS');
    });
});

describe('OpenEmrAuthClient', () => {
    const CLIENT_ID = 'test-client-id';
    let now: number;

    function authClient(fetch: FetchLike) {
        now = 1_750_000_000_000;
        return new OpenEmrAuthClient({
            baseUrl: BASE_URL,
            clientId: CLIENT_ID,
            privateKeyPem: KEY.privateKeyPem,
            fetchImpl: fetch,
            now: () => now,
        });
    }

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    // Guards: the server only accepts this exact grant/assertion-type pair
    // (CustomClientCredentialsGrant.php:159-175, JWTClientAuthenticationService.php:57) —
    // wrong form fields yield an opaque invalid_request at deploy time.
    it('posts grant_type=client_credentials with the JWT bearer assertion type and scopes', async () => {
        const fetch = fetchMockReturning(jsonResponse(200, { access_token: 'tok-1', expires_in: 60 }));
        await authClient(fetch).getAccessToken();

        const [url, init] = fetch.mock.calls[0]!;
        expect(url).toBe(`${BASE_URL}/oauth2/default/token`);
        expect(new Headers(init?.headers).get('content-type')).toBe('application/x-www-form-urlencoded');
        const form = new URLSearchParams(String(init?.body));
        expect(form.get('grant_type')).toBe('client_credentials');
        expect(form.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
        expect(form.get('scope')).toBe(SYSTEM_SCOPES.join(' '));
        expect(form.get('client_assertion')).toBeTruthy();
    });

    // Guards: assertion validation is strict — iss/sub must equal client_id, aud must be the
    // token endpoint, jti required, RS384 only, kid must match the registered JWK
    // (JWTClientAuthenticationService.php:256-270,345-407) — each drift is a 400 invalid_client.
    it('signs an RS384 assertion with iss/sub=client_id, aud=token endpoint, jti, and valid signature', async () => {
        const fetch = fetchMockReturning(jsonResponse(200, { access_token: 'tok-1', expires_in: 60 }));
        await authClient(fetch).getAccessToken();

        const form = new URLSearchParams(String(fetch.mock.calls[0]![1]?.body));
        const { header, claims, signingInput, signature } = decodeJwt(form.get('client_assertion')!);

        expect(header['alg']).toBe('RS384');
        expect(header['typ']).toBe('JWT');
        expect(header['kid']).toBe(KEY.kid);
        expect(claims['iss']).toBe(CLIENT_ID);
        expect(claims['sub']).toBe(CLIENT_ID);
        expect(claims['aud']).toBe(`${BASE_URL}/oauth2/default/token`);
        expect(claims['jti']).toBeTruthy();
        expect(claims['iat']).toBe(Math.floor(now / 1000));
        // Docs cap exp at iat + 5 minutes (AUTHENTICATION.md:543).
        expect((claims['exp'] as number) - (claims['iat'] as number)).toBeLessThanOrEqual(300);

        const publicKey = createPublicKey(KEY.privateKeyPem);
        expect(cryptoVerify('sha384', Buffer.from(signingInput), publicKey, signature)).toBe(true);
    });

    // Guards: refetching on every call would hammer the token endpoint and burn jti entries;
    // the cache must serve until expiry (tokens live ~60s, AUTHENTICATION.md:570).
    it('caches the token: a second call within the lifetime does not fetch', async () => {
        const fetch = fetchMockReturning(jsonResponse(200, { access_token: 'tok-1', expires_in: 60 }));
        const client = authClient(fetch);
        expect(await client.getAccessToken()).toBe('tok-1');
        expect(await client.getAccessToken()).toBe('tok-1');
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    // Guards: serving a stale cached token after expiry — every FHIR call would 401.
    it('refreshes the token once the cached one expires', async () => {
        const fetch = fetchMockReturning(
            jsonResponse(200, { access_token: 'tok-1', expires_in: 60 }),
            jsonResponse(200, { access_token: 'tok-2', expires_in: 60 }),
        );
        const client = authClient(fetch);
        expect(await client.getAccessToken()).toBe('tok-1');
        now += 61_000; // past expires_in
        expect(await client.getAccessToken()).toBe('tok-2');
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    // Guards: masking auth failures (e.g. client not yet enabled by an admin —
    // JWTClientAuthenticationService.php:230-233 rejects disabled clients) as empty tokens.
    it('propagates token endpoint errors with status and OAuth code', async () => {
        const fetch = fetchMockReturning(jsonResponse(401, { error: 'invalid_client' }));
        const attempt = authClient(fetch).getAccessToken();
        await expect(attempt).rejects.toThrow(OpenEmrAuthError);
        const error = await attempt.catch((e: unknown) => e as OpenEmrAuthError);
        expect(error.status).toBe(401);
        expect(error.oauthError).toBe('invalid_client');
    });
});

describe('FhirClient', () => {
    const tokenProvider = { getAccessToken: vi.fn(async () => 'bearer-tok') };

    function fhirClient(fetch: FetchLike) {
        return new FhirClient({ baseUrl: `${BASE_URL}/`, tokenProvider, fetchImpl: fetch });
    }

    // Guards: wrong base path — FHIR lives under /apis/default/fhir (API_README.md:96-99),
    // not /oauth2 or /apis/default/api; and read-by-id must hit /Patient/<uuid>.
    it('getPatient requests /apis/default/fhir/Patient/<id> with bearer and FHIR accept headers', async () => {
        const fetch = fetchMockReturning(jsonResponse(200, { resourceType: 'Patient', id: 'p-1' }));
        const patient = await fhirClient(fetch).getPatient('p-1', 'corr-1');
        expect(patient['id']).toBe('p-1');

        const [url, init] = fetch.mock.calls[0]!;
        expect(url).toBe(`${BASE_URL}/apis/default/fhir/Patient/p-1`);
        const headers = new Headers(init?.headers);
        expect(headers.get('authorization')).toBe('Bearer bearer-tok');
        expect(headers.get('accept')).toBe('application/fhir+json');
    });

    // Guards: broken trace reconstruction — every outbound EHR call must carry the caller's
    // correlation id (project brief engineering requirement, see src/server.ts).
    it('sends the caller-provided x-correlation-id on every request', async () => {
        const fetch = fetchMockReturning(jsonResponse(200, { resourceType: 'Bundle', entry: [] }));
        await fhirClient(fetch).searchPatients('smith', 'corr-42');
        const headers = new Headers(fetch.mock.calls[0]![1]?.headers);
        expect(headers.get('x-correlation-id')).toBe('corr-42');
    });

    // Guards: unescaped user input in the query string — names with spaces/&/= must be encoded
    // or the search silently returns wrong results.
    it('searchPatients builds /Patient?name=<encoded>', async () => {
        const fetch = fetchMockReturning(jsonResponse(200, { resourceType: 'Bundle', entry: [] }));
        await fhirClient(fetch).searchPatients('Anna & Bob=?', 'corr-1');
        const [url] = fetch.mock.calls[0]!;
        expect(url).toBe(`${BASE_URL}/apis/default/fhir/Patient?name=Anna+%26+Bob%3D%3F`);
    });

    // Guards: per-type URL drift — non-Patient types search via ?patient=<uuid>
    // (Documentation/api/FHIR_API.md:982-1037) while Patient uses ?_id=<uuid>
    // (FhirPatientService.php:128); mixing them up returns empty bundles, not errors.
    it.each(PATIENT_RESOURCE_TYPES)('searchByPatient builds the right URL for %s', async (resourceType) => {
        const fetch = fetchMockReturning(jsonResponse(200, { resourceType: 'Bundle', entry: [] }));
        await fhirClient(fetch).searchByPatient(resourceType, 'uuid-9', 'corr-1');
        const [url] = fetch.mock.calls[0]!;
        const param = resourceType === 'Patient' ? '_id' : 'patient';
        expect(url).toBe(`${BASE_URL}/apis/default/fhir/${resourceType}?${param}=uuid-9`);
    });

    // Guards: treating an expired/unauthorized token as an empty result set.
    it('throws FhirRequestError with status on 401', async () => {
        const fetch = fetchMockReturning(jsonResponse(401, {}));
        const attempt = fhirClient(fetch).getPatient('p-1', 'corr-1');
        await expect(attempt).rejects.toThrow(FhirRequestError);
        const error = await attempt.catch((e: unknown) => e as FhirRequestError);
        expect(error.status).toBe(401);
    });

    // Guards: losing the server's diagnostic on 500 — surface OperationOutcome text only,
    // never the rest of the response body. 500 is transient, so the client retries once
    // (H.5 policy) before surfacing the second failure.
    it('extracts OperationOutcome diagnostics on 500 without leaking the raw body', async () => {
        const outcome500 = () =>
            jsonResponse(500, {
                resourceType: 'OperationOutcome',
                secret_debug: 'SECRET-INTERNALS',
                issue: [{ severity: 'error', diagnostics: 'search processing failed' }],
            });
        const fetch = fetchMockReturning(outcome500(), outcome500());
        const attempt = fhirClient(fetch).searchByPatient('Condition', 'uuid-9', 'corr-1');
        const error = await attempt.catch((e: unknown) => e as FhirRequestError);
        expect(error).toBeInstanceOf(FhirRequestError);
        expect(error.status).toBe(500);
        expect(error.operationOutcome).toBe('search processing failed');
        expect(error.message).toContain('search processing failed');
        expect(error.message).not.toContain('SECRET-INTERNALS');
        expect(fetch).toHaveBeenCalledTimes(2); // one bounded retry on the transient 500, no more
    });
});
