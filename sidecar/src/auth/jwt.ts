// Minimal JWT primitives on node:crypto — no dependency, matching src/openemr/auth.ts's
// hand-rolled signing. We support exactly two algorithms and nothing else: RS256 (OpenEMR
// access tokens — research: league/oauth2-server 8.5.5 default Rsa\Sha256) and HS256 (our own
// dev tokens). Refusing every other alg is the guard against alg-confusion (e.g. a token whose
// header says "none", or an RS key smuggled in as an HS secret): callers dispatch strictly on
// the parsed alg and reject anything unexpected.
import { createHmac, createPublicKey, timingSafeEqual, verify as cryptoVerify, type KeyObject } from 'node:crypto';

export interface JwtParts {
    readonly header: Record<string, unknown>;
    readonly payload: Record<string, unknown>;
    /** `${headerB64}.${payloadB64}` — the exact bytes the signature covers. */
    readonly signingInput: string;
    readonly signature: Buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse a compact JWS into its parts, or null if it is not a well-formed three-segment JWT. */
export function decodeJwt(token: string): JwtParts | null {
    const segments = token.split('.');
    if (segments.length !== 3) {
        return null;
    }
    const [headerB64, payloadB64, signatureB64] = segments;
    if (headerB64 === undefined || payloadB64 === undefined || signatureB64 === undefined) {
        return null;
    }
    try {
        const header: unknown = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
        const payload: unknown = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
        if (!isRecord(header) || !isRecord(payload)) {
            return null;
        }
        return { header, payload, signingInput: `${headerB64}.${payloadB64}`, signature: Buffer.from(signatureB64, 'base64url') };
    } catch {
        return null;
    }
}

/** The `alg` header value, or null when absent/non-string. */
export function algOf(parts: JwtParts): string | null {
    const alg = parts.header['alg'];
    return typeof alg === 'string' ? alg : null;
}

/** Build an RSA public KeyObject from a JWK's modulus/exponent (the OpenEMR /jwk shape). */
export function rsaPublicKeyFromJwk(jwk: { n: string; e: string }): KeyObject {
    return createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
}

/** RS256 signature verification against an RSA public key. */
export function verifyRs256(parts: JwtParts, publicKey: KeyObject): boolean {
    return cryptoVerify('sha256', Buffer.from(parts.signingInput), publicKey, parts.signature);
}

/** HS256 signature verification with a shared secret (constant-time compare). */
export function verifyHs256(parts: JwtParts, secret: string): boolean {
    const expected = createHmac('sha256', secret).update(parts.signingInput).digest();
    return expected.length === parts.signature.length && timingSafeEqual(expected, parts.signature);
}

/** Sign an HS256 JWT (used only to mint our own dev tokens). */
export function signHs256(header: Record<string, unknown>, payload: Record<string, unknown>, secret: string): string {
    const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest('base64url');
    return `${headerB64}.${payloadB64}.${signature}`;
}
