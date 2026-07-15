// H.5 (REQ G2): every outbound OpenEMR call carries a hard timeout + a method-aware bounded
// retry. Policy under test: idempotent reads (GETs, and both token mints) get the helper's
// ONE bounded retry on transient statuses {408,429,500,502,503,504} and on timeout; mutating
// calls (POST/PUT — vitals writes, document upload, client registration) get the timeout but
// NO automatic retry, because a retried write can double-file a document (the A.3 post-write
// verification re-lists by content hash but guards absence, not duplicates). Mirrors the
// mocked-fetch style of openemr.test.ts / openemr-documents.test.ts; hang tests use tiny REAL
// timeouts (the helper uses real setTimeout), like retrieval.test.ts uses real Responses.
import { describe, expect, it, vi } from 'vitest';
import { AuthError } from '../src/auth/principal.js';
import { SmartTokenVerifier } from '../src/auth/smartVerifier.js';
import { HttpTimeoutError, withTimeoutAndRetry } from '../src/lib/httpRetry.js';
import {
    OpenEmrAuthError,
    OpenEmrAuthClient,
    OpenEmrPasswordAuthClient,
    generateClientKey,
    registerSystemClient,
    type FetchLike,
} from '../src/openemr/auth.js';
import { FhirClient, FhirRequestError } from '../src/openemr/fhir.js';
import { StandardApiClient, StandardApiError } from '../src/openemr/standardApi.js';

const BASE_URL = 'https://ehr.example.test';
// Tiny real timeout for the hang tests: two attempts still finish in ~2×TINY ms, far under
// the suite's 5s ceiling, while a regression (no timeout) would hang the test to failure.
const TINY_TIMEOUT_MS = 40;

const tokenProvider = { getAccessToken: async () => 'tok' };

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function envelope(data: unknown): unknown {
    return { validationErrors: [], internalErrors: [], data };
}

/** A fetch that never settles on its own — the hung-EHR simulation for the hang-recovery tests. */
function hangingFetch() {
    return vi.fn((_url: string, _init?: RequestInit) => new Promise<Response>(() => { /* never settles */ }));
}

class FakeStatusError extends Error {
    constructor(public readonly status: number) {
        super(`fake upstream failure ${status}`);
        this.name = 'FakeStatusError';
    }
}

describe('lib/httpRetry — withTimeoutAndRetry (H.5)', () => {
    // Guards THE hang-recovery acceptance: an attempt that never settles AND ignores the abort
    // signal must still reject at the deadline — the helper races the attempt against the abort.
    it('rejects at the timeout even when the attempt ignores the abort signal', async () => {
        const startedAt = Date.now();
        await expect(
            withTimeoutAndRetry('hung op', TINY_TIMEOUT_MS, () => new Promise<never>(() => { /* hang */ }), { retries: 0 }),
        ).rejects.toBeInstanceOf(HttpTimeoutError);
        expect(Date.now() - startedAt).toBeLessThan(1_000); // rejected at ~40ms, not hung
    });

    // Guards: the default policy is ONE retry — a persistent transient failure means exactly
    // two attempts, never an unbounded loop.
    it('retries a transient status exactly once by default, then rethrows', async () => {
        const attempt = vi.fn(async (_signal: AbortSignal) => {
            throw new FakeStatusError(503);
        });
        await expect(withTimeoutAndRetry('op', 1_000, attempt)).rejects.toBeInstanceOf(FakeStatusError);
        expect(attempt).toHaveBeenCalledTimes(2);
    });

    // Guards: retries: 0 (the non-idempotent-write setting) must suppress the retry even for
    // a transient status — the whole point of the method-aware policy.
    it('retries: 0 makes a transient failure surface after a single attempt', async () => {
        const attempt = vi.fn(async (_signal: AbortSignal) => {
            throw new FakeStatusError(503);
        });
        await expect(withTimeoutAndRetry('op', 1_000, attempt, { retries: 0 })).rejects.toBeInstanceOf(FakeStatusError);
        expect(attempt).toHaveBeenCalledTimes(1);
    });

    // Guards: non-transient failures (4xx contract errors, plain bugs) must never burn a retry.
    it('does not retry a non-transient status', async () => {
        const attempt = vi.fn(async (_signal: AbortSignal) => {
            throw new FakeStatusError(401);
        });
        await expect(withTimeoutAndRetry('op', 1_000, attempt)).rejects.toBeInstanceOf(FakeStatusError);
        expect(attempt).toHaveBeenCalledTimes(1);
    });

    // Guards: onTimeout keeps timeouts inside each client's typed error family, so callers'
    // instanceof handling (ehrSeed skip-degradation, routes' 502 mapping) still works.
    it('maps the final timeout through onTimeout into the caller error family', async () => {
        const error = await withTimeoutAndRetry(
            'embed',
            TINY_TIMEOUT_MS,
            () => new Promise<never>(() => { /* hang */ }),
            { retries: 0, onTimeout: (operation, timeoutMs) => new Error(`${operation}/${timeoutMs}`) },
        ).catch((e: unknown) => e as Error);
        expect(error.message).toBe(`embed/${TINY_TIMEOUT_MS}`);
    });

    // Guards: a first-attempt timeout is itself transient — the retry happens, and a fast
    // second attempt succeeds (the recovery the retry exists for).
    it('recovers when the first attempt hangs and the retry succeeds', async () => {
        let round = 0;
        const result = await withTimeoutAndRetry('op', TINY_TIMEOUT_MS, (_signal) => {
            round += 1;
            return round === 1 ? new Promise<string>(() => { /* hang */ }) : Promise.resolve('ok');
        });
        expect(result).toBe('ok');
        expect(round).toBe(2);
    });
});

describe('FhirClient timeout + retry (H.5 — idempotent reads)', () => {
    function fhirClient(fetchImpl: FetchLike, timeoutMs?: number) {
        return new FhirClient({ baseUrl: BASE_URL, tokenProvider, fetchImpl, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    }

    // Guards the plan's explicit hang-recovery acceptance: a hung EHR socket must reject at the
    // (shortened) timeout as a typed FhirRequestError — never hang the prep pipeline.
    it('a never-resolving fetch rejects at the timeout with FhirRequestError 408 (bounded: two attempts)', async () => {
        const fetch = hangingFetch();
        const startedAt = Date.now();
        const error = await fhirClient(fetch, TINY_TIMEOUT_MS)
            .getPatient('p-1', 'corr-1')
            .catch((e: unknown) => e as FhirRequestError);
        expect(error).toBeInstanceOf(FhirRequestError);
        expect(error.status).toBe(408);
        expect(error.message).toContain('timed out');
        expect(fetch).toHaveBeenCalledTimes(2); // timeout is transient → one bounded retry, then give up
        expect(Date.now() - startedAt).toBeLessThan(2_000);
    });

    // Guards: a blip (503) on an idempotent GET must be absorbed by the single bounded retry.
    it('a GET that 503s once then succeeds resolves (retried exactly once)', async () => {
        const fetch = vi.fn<FetchLike>()
            .mockResolvedValueOnce(jsonResponse(503, {}))
            .mockResolvedValueOnce(jsonResponse(200, { resourceType: 'Patient', id: 'p-1' }));
        const patient = await fhirClient(fetch).getPatient('p-1', 'corr-1');
        expect(patient['id']).toBe('p-1');
        expect(fetch).toHaveBeenCalledTimes(2);
    });
});

describe('StandardApiClient timeout + retry (H.5 — method-aware policy)', () => {
    function client(fetchImpl: FetchLike, overrides: { timeoutMs?: number; uploadTimeoutMs?: number } = {}) {
        return new StandardApiClient({
            baseUrl: BASE_URL,
            tokenProvider,
            fetchImpl,
            correlationId: 'corr-h5',
            ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }),
            ...(overrides.uploadTimeoutMs === undefined ? {} : { uploadTimeoutMs: overrides.uploadTimeoutMs }),
        });
    }

    // Guards hang recovery on the read path (list reads run inside seeding and ingestion).
    it('a never-resolving GET rejects at the timeout with StandardApiError 408', async () => {
        const fetch = hangingFetch();
        const error = await client(fetch, { timeoutMs: TINY_TIMEOUT_MS })
            .listMedicalProblemTitles('uuid-1')
            .catch((e: unknown) => e as StandardApiError);
        expect(error).toBeInstanceOf(StandardApiError);
        expect(error.status).toBe(408);
        expect(fetch).toHaveBeenCalledTimes(2); // GET → one bounded retry
    });

    // Guards: transient blips on idempotent GETs are retried once and succeed.
    it('a GET that 503s once then succeeds resolves (retried exactly once)', async () => {
        const fetch = vi.fn<FetchLike>()
            .mockResolvedValueOnce(jsonResponse(503, {}))
            .mockResolvedValueOnce(jsonResponse(200, envelope([{ title: 'Hypertension' }])));
        await expect(client(fetch).listMedicalProblemTitles('uuid-1')).resolves.toEqual(['Hypertension']);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    // Guards THE write-safety rule: a vitals POST is non-idempotent — a 503 must surface
    // immediately with fetch called exactly once (a retry could double-write the vital).
    it('a vitals write POST that 503s is NOT retried (fetch called exactly once)', async () => {
        const fetch = vi.fn<FetchLike>(async () => jsonResponse(503, {}));
        const error = await client(fetch)
            .addVital('3', '7', { bps: 120, bpd: 80 })
            .catch((e: unknown) => e as StandardApiError);
        expect(error).toBeInstanceOf(StandardApiError);
        expect(error.status).toBe(503);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    // Guards: PUT is mutating too — the method-aware branch must treat every non-GET as a write.
    it('a PUT that 503s is NOT retried (fetch called exactly once)', async () => {
        const fetch = vi.fn<FetchLike>(async () => jsonResponse(503, {}));
        await expect(
            client(fetch).updatePatient('uuid-1', { fname: 'A', lname: 'Bee', DOB: '1970-01-01', sex: 'Female' }),
        ).rejects.toBeInstanceOf(StandardApiError);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    // Guards the ticket's explicit acceptance (c): the document-upload POST is the canonical
    // double-file hazard — transient failure must NOT trigger an automatic second POST.
    it('a document-upload POST that 503s is NOT retried (exactly one POST)', async () => {
        const fetch = vi.fn<FetchLike>(async (_url: string, init?: RequestInit) =>
            (init?.method ?? 'GET') === 'GET'
                ? new Response('', { status: 404 }) // empty category listing
                : jsonResponse(503, {}),
        );
        const bytes = new TextEncoder().encode('%PDF-1.4 h5');
        const error = await client(fetch)
            .uploadPatientDocumentDeduped(42, 'Lab Report', 'h5.pdf', bytes, 'application/pdf')
            .catch((e: unknown) => e as StandardApiError);
        expect(error).toBeInstanceOf(StandardApiError);
        expect(error.status).toBe(503);
        const posts = fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
        expect(posts).toHaveLength(1);
    });

    // Guards hang recovery on the upload path: a hung multipart POST rejects at the (shortened)
    // upload timeout — and because writes never auto-retry, only ONE POST is ever attempted.
    it('a never-resolving document-upload POST rejects at the upload timeout without a second POST', async () => {
        const fetch = vi.fn((url: string, init?: RequestInit) =>
            (init?.method ?? 'GET') === 'GET'
                ? Promise.resolve(new Response('', { status: 404 }))
                : new Promise<Response>(() => { /* hung upload socket */ }),
        );
        const bytes = new TextEncoder().encode('%PDF-1.4 h5');
        const error = await client(fetch, { uploadTimeoutMs: TINY_TIMEOUT_MS })
            .uploadPatientDocumentDeduped(42, 'Lab Report', 'h5.pdf', bytes, 'application/pdf')
            .catch((e: unknown) => e as StandardApiError);
        expect(error).toBeInstanceOf(StandardApiError);
        expect(error.status).toBe(408);
        expect(error.message).toContain('timed out');
        const posts = fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
        expect(posts).toHaveLength(1);
    });
});

describe('OAuth clients timeout + retry (H.5 — token mints retry, registration does not)', () => {
    const KEY = generateClientKey(2048);

    function jwtClient(fetchImpl: FetchLike, timeoutMs?: number) {
        return new OpenEmrAuthClient({
            baseUrl: BASE_URL,
            clientId: 'cid-h5',
            privateKeyPem: KEY.privateKeyPem,
            fetchImpl,
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
    }

    // Guards: token mints are safe to retry (worst case: an extra token row) — a transient 503
    // must be absorbed, and the retry must carry a FRESH assertion (a consumed jti never replays).
    it('client-credentials mint retries a 503 once with a fresh client_assertion', async () => {
        const fetch = vi.fn<FetchLike>()
            .mockResolvedValueOnce(jsonResponse(503, {}))
            .mockResolvedValueOnce(jsonResponse(200, { access_token: 'tok-2', expires_in: 60 }));
        await expect(jwtClient(fetch).getAccessToken()).resolves.toBe('tok-2');
        expect(fetch).toHaveBeenCalledTimes(2);
        const assertionOf = (call: [string, RequestInit?]) => new URLSearchParams(String(call[1]?.body)).get('client_assertion');
        expect(assertionOf(fetch.mock.calls[0]!)).not.toBe(assertionOf(fetch.mock.calls[1]!)); // fresh jti per attempt
    });

    // Guards hang recovery on the mint: a hung token endpoint rejects as a typed OpenEmrAuthError
    // at the shortened timeout instead of stalling every downstream FHIR/standard-API call.
    it('a never-resolving token mint rejects at the timeout with OpenEmrAuthError 408', async () => {
        const fetch = hangingFetch();
        const error = await jwtClient(fetch, TINY_TIMEOUT_MS)
            .getAccessToken()
            .catch((e: unknown) => e as OpenEmrAuthError);
        expect(error).toBeInstanceOf(OpenEmrAuthError);
        expect(error.status).toBe(408);
        expect(fetch).toHaveBeenCalledTimes(2); // bounded: retry once, then surface
    });

    // Guards: the password mint follows the same retry-once policy.
    it('password mint retries a 503 once then succeeds', async () => {
        const fetch = vi.fn<FetchLike>()
            .mockResolvedValueOnce(jsonResponse(503, {}))
            .mockResolvedValueOnce(jsonResponse(200, { access_token: 'tok-pw', expires_in: 60 }));
        const clientObj = new OpenEmrPasswordAuthClient({
            baseUrl: BASE_URL,
            clientId: 'cid-h5',
            username: 'admin',
            password: 'pass',
            fetchImpl: fetch,
        });
        await expect(clientObj.getAccessToken()).resolves.toBe('tok-pw');
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    // Guards: registration is a WRITE — every POST mints a brand-new client_id, so a transient
    // failure must never auto-retry (a duplicate registration is an orphaned client to clean up).
    it('client registration does NOT retry a transient 503 (fetch called exactly once)', async () => {
        const fetch = vi.fn<FetchLike>(async () => jsonResponse(503, { error: 'temporarily_unavailable' }));
        const error = await registerSystemClient({
            baseUrl: BASE_URL,
            clientName: 'H5 Test',
            jwks: KEY.jwks,
            fetchImpl: fetch,
        }).catch((e: unknown) => e as OpenEmrAuthError);
        expect(error).toBeInstanceOf(OpenEmrAuthError);
        expect(error.status).toBe(503);
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});

describe('SmartTokenVerifier upstream timeout (H.5 — fail closed, never hang)', () => {
    // Guards: a hung JWKS endpoint must 401 the request (fail closed) at the shortened timeout —
    // before H.5 a hung EHR stalled every SMART-authed call indefinitely.
    it('a never-resolving JWKS fetch fails closed with AuthError 401 jwks_unavailable', async () => {
        const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
        const token = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ sub: 'user-1' })}.${Buffer.from('sig').toString('base64url')}`;
        const fetch = hangingFetch();
        const verifier = new SmartTokenVerifier({
            oauthBaseUrl: `${BASE_URL}/oauth2/default`,
            clientId: 'cid-h5',
            resolvePatient: async () => null,
            fetchImpl: fetch,
            timeoutMs: TINY_TIMEOUT_MS,
        });
        const startedAt = Date.now();
        const error = await verifier.verify(token).catch((e: unknown) => e as AuthError);
        expect(error).toBeInstanceOf(AuthError);
        expect(error.status).toBe(401);
        expect(error.reason).toBe('jwks_unavailable');
        expect(Date.now() - startedAt).toBeLessThan(2_000);
    });
});
