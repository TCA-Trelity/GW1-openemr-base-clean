// SMART resource-server verification (AZ1). Our sidecar verifies an OpenEMR-issued access token
// as a SEPARATE resource server. From the OpenEMR source (research pass, cited inline):
//   - Access tokens are RS256 JWTs; claims are aud/jti/iat/nbf/exp/sub/scopes/iss ONLY
//     (AccessTokenEntity.php:61-78). aud = our client_id; iss = <base>/oauth2/<site>.
//   - The bound patient is NOT in the JWT. It lives in the token's server-side context and is
//     authoritatively re-exposed by /introspect (TokenIntrospectionRestController.php:410-423).
//   - The public key is published at /oauth2/<site>/jwk as a bare {kty,n,e,use} — no kid, no alg
//     (OAuth2PublicJsonWebKeyController.php:33-40), so we assume RS256 and take keys[0].
// Verification is therefore two-stage: (1) local RS256 signature + aud/iss/exp using the JWKS,
// which proves the token is genuine and unexpired without a round-trip, then (2) introspection
// for the authoritative {active, patient, sub, scope}. The introspection endpoint authenticates
// the caller by client_id in the form body (TokenIntrospectionRestController.php:89-103) — no
// separate bearer — so we need only our own client_id to resolve the binding.
import type { FetchLike } from '../openemr/auth.js';
import { algOf, decodeJwt, rsaPublicKeyFromJwk, verifyRs256 } from './jwt.js';
import { AuthError, splitScope, type Principal, type Role } from './principal.js';
import type { KeyObject } from 'node:crypto';

/** Maps an OpenEMR patient UUID (from introspection) to the sidecar's own patient id. */
export type ResolvePatient = (openemrPatientUuid: string) => Promise<string | null>;

/**
 * Derives a clinical role from the introspection payload. OpenEMR has no single physician/
 * nurse/resident enum (research facet D: users.authorized + physician_type + gacl group), so
 * the default treats an EHR-launched clinician as a physician; the fine-grained split is
 * exercised via dev-login and can be refined here from the introspected user attributes.
 */
export type ResolveRole = (introspection: Record<string, unknown>) => Role;

export interface SmartTokenVerifierOptions {
    /** OAuth issuer base, e.g. https://ehr/oauth2/default — must equal the token's iss claim. */
    oauthBaseUrl: string;
    /** Our registered client_id — the token's aud claim must equal this. */
    clientId: string;
    jwksUrl?: string;
    introspectUrl?: string;
    resolvePatient: ResolvePatient;
    resolveRole?: ResolveRole;
    fetchImpl?: FetchLike;
    now?: () => number;
    /** How long a fetched JWKS is trusted before re-fetch (default 10 min). */
    jwksCacheMs?: number;
}

interface CachedKey {
    key: KeyObject;
    fetchedAtMs: number;
}

export class SmartTokenVerifier {
    private readonly oauthBaseUrl: string;
    private readonly clientId: string;
    private readonly jwksUrl: string;
    private readonly introspectUrl: string;
    private readonly resolvePatient: ResolvePatient;
    private readonly resolveRole: ResolveRole;
    private readonly fetchImpl: FetchLike;
    private readonly now: () => number;
    private readonly jwksCacheMs: number;
    private cachedKey: CachedKey | undefined;

    constructor(options: SmartTokenVerifierOptions) {
        const base = options.oauthBaseUrl.replace(/\/+$/, '');
        this.oauthBaseUrl = base;
        this.clientId = options.clientId;
        this.jwksUrl = options.jwksUrl ?? `${base}/jwk`;
        this.introspectUrl = options.introspectUrl ?? `${base}/introspect`;
        this.resolvePatient = options.resolvePatient;
        this.resolveRole = options.resolveRole ?? (() => 'physician');
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
        this.now = options.now ?? Date.now;
        this.jwksCacheMs = options.jwksCacheMs ?? 600_000;
    }

    async verify(token: string): Promise<Principal> {
        const parts = decodeJwt(token);
        if (parts === null || algOf(parts) !== 'RS256') {
            throw new AuthError(401, 'malformed_token');
        }
        const publicKey = await this.publicKey();
        if (!verifyRs256(parts, publicKey)) {
            throw new AuthError(401, 'bad_signature');
        }
        this.assertClaims(parts.payload);

        // Stage 2: authoritative binding from introspection (the JWT cannot carry it).
        const introspection = await this.introspect(token);
        if (introspection['active'] !== true) {
            throw new AuthError(401, 'token_inactive');
        }
        const patientUuid = introspection['patient'];
        if (typeof patientUuid !== 'string' || patientUuid === '') {
            // An interactive token must be patient-bound; a system/no-context token is not
            // accepted on the interactive surface (it belongs to the background preparer path).
            throw new AuthError(403, 'no_patient_context');
        }
        const sidecarPatientId = await this.resolvePatient(patientUuid);
        if (sidecarPatientId === null) {
            throw new AuthError(403, 'patient_not_linked');
        }
        const user = introspection['sub'];
        return {
            user: typeof user === 'string' && user !== '' ? user : 'unknown',
            patient: sidecarPatientId,
            role: this.resolveRole(introspection),
            scopes: splitScope(introspection['scope']),
            tokenType: 'smart',
        };
    }

    private assertClaims(payload: Record<string, unknown>): void {
        const nowSeconds = Math.floor(this.now() / 1000);
        const exp = payload['exp'];
        if (typeof exp !== 'number' || nowSeconds >= exp) {
            throw new AuthError(401, 'token_expired');
        }
        const nbf = payload['nbf'];
        if (typeof nbf === 'number' && nowSeconds < nbf) {
            throw new AuthError(401, 'token_not_yet_valid');
        }
        if (payload['iss'] !== this.oauthBaseUrl) {
            throw new AuthError(401, 'wrong_issuer');
        }
        if (!audienceMatches(payload['aud'], this.clientId)) {
            throw new AuthError(401, 'wrong_audience');
        }
    }

    private async publicKey(): Promise<KeyObject> {
        if (this.cachedKey !== undefined && this.now() - this.cachedKey.fetchedAtMs < this.jwksCacheMs) {
            return this.cachedKey.key;
        }
        let response: Response;
        try {
            response = await this.fetchImpl(this.jwksUrl, { method: 'GET', headers: { accept: 'application/json' } });
        } catch {
            throw new AuthError(401, 'jwks_unavailable');
        }
        if (!response.ok) {
            throw new AuthError(401, 'jwks_unavailable');
        }
        const jwk = firstRsaJwk(await safeJson(response));
        if (jwk === null) {
            throw new AuthError(401, 'jwks_malformed');
        }
        const key = rsaPublicKeyFromJwk(jwk);
        this.cachedKey = { key, fetchedAtMs: this.now() };
        return key;
    }

    private async introspect(token: string): Promise<Record<string, unknown>> {
        const form = new URLSearchParams({ token, token_type_hint: 'access_token', client_id: this.clientId });
        let response: Response;
        try {
            response = await this.fetchImpl(this.introspectUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
                body: form.toString(),
            });
        } catch {
            throw new AuthError(401, 'introspection_unavailable');
        }
        if (!response.ok) {
            throw new AuthError(401, 'introspection_failed');
        }
        const body = await safeJson(response);
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
            throw new AuthError(401, 'introspection_malformed');
        }
        return body as Record<string, unknown>;
    }
}

// aud may be a single string or an array of strings (RFC 7519); accept either shape.
function audienceMatches(aud: unknown, clientId: string): boolean {
    if (typeof aud === 'string') {
        return aud === clientId;
    }
    return Array.isArray(aud) && aud.some((entry) => entry === clientId);
}

function firstRsaJwk(body: unknown): { n: string; e: string } | null {
    if (typeof body !== 'object' || body === null) {
        return null;
    }
    const keys = (body as Record<string, unknown>)['keys'];
    if (!Array.isArray(keys)) {
        return null;
    }
    for (const entry of keys) {
        if (typeof entry === 'object' && entry !== null) {
            const record = entry as Record<string, unknown>;
            if (record['kty'] === 'RSA' && typeof record['n'] === 'string' && typeof record['e'] === 'string') {
                return { n: record['n'], e: record['e'] };
            }
        }
    }
    return null;
}

async function safeJson(response: Response): Promise<unknown> {
    try {
        return (await response.json()) as unknown;
    } catch {
        return undefined;
    }
}
