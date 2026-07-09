// Authorization tests (Wave AZ): the sidecar constructs the patient-scope control OpenEMR does
// not provide (AUDIT.md S1). Each test names the failure mode it guards. Four layers:
//   - DevTokenService: sidecar-minted demo tokens round-trip; every tampered/expired/wrong-claim
//     variant is rejected.
//   - CompositeVerifier: strict alg dispatch (the alg-confusion defense).
//   - SmartTokenVerifier: real RS256 verify against a mocked JWKS + introspection binding.
//   - registerAuth middleware: the PEP — 401 unauthenticated, 403 cross-patient, 403 role gate,
//     and the open-path exemptions — plus dev-login / me routes.
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { DevTokenService } from '../src/auth/devToken.js';
import { CompositeVerifier } from '../src/auth/verifier.js';
import { SmartTokenVerifier } from '../src/auth/smartVerifier.js';
import { AuthError } from '../src/auth/principal.js';
import { registerAuth, type AuthMode } from '../src/auth/middleware.js';
import { registerAuthRoutes } from '../src/routes/auth.js';
import type { FetchLike } from '../src/openemr/auth.js';

const SECRET = 'test-dev-secret-0123456789';
const FIXED_NOW = 1_700_000_000_000; // fixed epoch-ms so exp math is deterministic
const now = () => FIXED_NOW;

function devService(overrides: { ttlSeconds?: number; now?: () => number } = {}): DevTokenService {
    return new DevTokenService({ secret: SECRET, ttlSeconds: overrides.ttlSeconds ?? 3600, now: overrides.now ?? now });
}

// ---- DevTokenService ----

describe('DevTokenService', () => {
    // Failure mode: a minted token doesn't verify back, so dev-login can't authenticate anyone.
    it('mints and verifies a patient-bound, role-carrying token', () => {
        const svc = devService();
        const { token, expiresIn } = svc.mint({ username: 'dr-demo', role: 'physician', patient: 'margaret-chen' });
        expect(expiresIn).toBe(3600);
        const principal = svc.verify(token);
        expect(principal).toMatchObject({ user: 'dr-demo', patient: 'margaret-chen', role: 'physician', tokenType: 'dev' });
    });

    // Failure mode: a flipped signature byte still verifies — anyone could forge a token.
    it('rejects a tampered signature', () => {
        const svc = devService();
        const { token } = svc.mint({ username: 'dr-demo', role: 'nurse', patient: 'tren-okafor' });
        const parts = token.split('.');
        const forged = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -2)}AA`;
        expect(() => svc.verify(forged)).toThrow(AuthError);
    });

    // Failure mode: a token minted with a different secret is accepted.
    it('rejects a token signed with a different secret', () => {
        const other = new DevTokenService({ secret: 'a-totally-different-secret-xyz', now });
        const { token } = other.mint({ username: 'x', role: 'physician', patient: 'margaret-chen' });
        expect(() => devService().verify(token)).toThrow(/bad_signature/);
    });

    // Failure mode: expired tokens keep working past their lifetime.
    it('rejects an expired token', () => {
        const svc = devService({ ttlSeconds: 60 });
        const { token } = svc.mint({ username: 'dr-demo', role: 'physician', patient: 'margaret-chen' });
        const later = new DevTokenService({ secret: SECRET, now: () => FIXED_NOW + 61_000 });
        expect(() => later.verify(token)).toThrow(/token_expired/);
    });

    // Failure mode: a token with an unknown role or no patient binding is treated as valid.
    it('rejects malformed claims (unknown role / missing patient)', () => {
        const svc = devService();
        // Hand-mint an HS256 token with a bad role via the same secret path.
        const bad = new DevTokenService({ secret: SECRET, now });
        // role 'admin' is not a clinical role.
        const token = (bad as unknown as { mint: (c: unknown) => { token: string } }).mint({
            username: 'x',
            role: 'admin',
            patient: 'margaret-chen',
        }).token;
        expect(() => svc.verify(token)).toThrow(/bad_claims/);
    });
});

// ---- CompositeVerifier: strict alg dispatch ----

describe('CompositeVerifier alg dispatch', () => {
    // Failure mode: an alg-confusion token (e.g. "none", or RS routed to the HMAC path) verifies.
    it('routes HS256 to dev tokens and rejects unsupported algs', async () => {
        const dev = devService();
        const verifier = new CompositeVerifier(dev, undefined);
        const { token } = dev.mint({ username: 'dr-demo', role: 'resident', patient: 'margaret-chen' });
        await expect(verifier.verify(token)).resolves.toMatchObject({ role: 'resident', tokenType: 'dev' });

        // alg: none
        const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({ sub: 'x', patient: 'margaret-chen', role: 'physician' })).toString('base64url');
        await expect(verifier.verify(`${header}.${payload}.`)).rejects.toThrow(/unsupported_alg|malformed_token/);
    });

    // Failure mode: an RS256 token is accepted when no SMART verifier is configured.
    it('rejects RS256 when SMART is not configured', async () => {
        const verifier = new CompositeVerifier(devService(), undefined);
        const { jwk, privateKey } = makeRsa();
        void jwk;
        const token = signRs256({ iss: 'x', aud: 'y', exp: FIXED_NOW / 1000 + 60 }, privateKey);
        await expect(verifier.verify(token)).rejects.toThrow(/smart_not_configured/);
    });
});

// ---- SmartTokenVerifier ----

function makeRsa(): { privateKey: KeyObject; jwk: { n: string; e: string } } {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const exported = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
    return { privateKey, jwk: { n: exported.n, e: exported.e } };
}

function signRs256(payload: Record<string, unknown>, privateKey: KeyObject): string {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = cryptoSign('sha256', Buffer.from(`${header}.${body}`), privateKey).toString('base64url');
    return `${header}.${body}.${signature}`;
}

const OAUTH_BASE = 'https://ehr.example.com/oauth2/default';
const CLIENT_ID = 'client-abc';

function smartFetch(jwk: { n: string; e: string }, introspection: Record<string, unknown>): FetchLike {
    return async (url: string, init?: RequestInit) => {
        if (url.endsWith('/jwk')) {
            return { ok: true, status: 200, json: async () => ({ keys: [{ kty: 'RSA', use: 'sig', ...jwk }] }) } as Response;
        }
        if (url.endsWith('/introspect')) {
            expect(init?.method).toBe('POST');
            return { ok: true, status: 200, json: async () => introspection } as Response;
        }
        throw new Error(`unexpected fetch ${url}`);
    };
}

function smartVerifier(
    privateKeyJwk: { n: string; e: string },
    introspection: Record<string, unknown>,
    resolvePatient: (uuid: string) => Promise<string | null> = async () => 'margaret-chen',
): SmartTokenVerifier {
    return new SmartTokenVerifier({
        oauthBaseUrl: OAUTH_BASE,
        clientId: CLIENT_ID,
        resolvePatient,
        fetchImpl: smartFetch(privateKeyJwk, introspection),
        now,
    });
}

const validClaims = { iss: OAUTH_BASE, aud: CLIENT_ID, sub: 'user-1', exp: FIXED_NOW / 1000 + 300, iat: FIXED_NOW / 1000 };

describe('SmartTokenVerifier', () => {
    // Failure mode: a genuine OpenEMR token doesn't verify, or the bound patient isn't resolved.
    it('verifies a valid RS256 token and binds the patient from introspection', async () => {
        const { privateKey, jwk } = makeRsa();
        const verifier = smartVerifier(jwk, { active: true, patient: 'uuid-x', sub: 'user-1', scope: 'patient/Patient.read' });
        const principal = await verifier.verify(signRs256(validClaims, privateKey));
        expect(principal).toMatchObject({ user: 'user-1', patient: 'margaret-chen', role: 'physician', tokenType: 'smart' });
    });

    // Failure mode: a token signed by a different key is accepted (the JWKS check is the gate).
    it('rejects a signature from a foreign key', async () => {
        const { jwk } = makeRsa();
        const foreign = makeRsa();
        const verifier = smartVerifier(jwk, { active: true, patient: 'uuid-x' });
        await expect(verifier.verify(signRs256(validClaims, foreign.privateKey))).rejects.toThrow(/bad_signature/);
    });

    // Failure mode: a token minted for another client (aud) or issuer is honored.
    it('rejects wrong audience and wrong issuer', async () => {
        const { privateKey, jwk } = makeRsa();
        const verifier = smartVerifier(jwk, { active: true, patient: 'uuid-x' });
        await expect(verifier.verify(signRs256({ ...validClaims, aud: 'someone-else' }, privateKey))).rejects.toThrow(/wrong_audience/);
        await expect(verifier.verify(signRs256({ ...validClaims, iss: 'https://evil/oauth2/default' }, privateKey))).rejects.toThrow(
            /wrong_issuer/,
        );
    });

    // Failure mode: an expired token still authorizes.
    it('rejects an expired token', async () => {
        const { privateKey, jwk } = makeRsa();
        const verifier = smartVerifier(jwk, { active: true, patient: 'uuid-x' });
        await expect(verifier.verify(signRs256({ ...validClaims, exp: FIXED_NOW / 1000 - 1 }, privateKey))).rejects.toThrow(
            /token_expired/,
        );
    });

    // Failure mode: a revoked token (introspection active:false) is honored on the JWT alone.
    it('rejects when introspection reports the token inactive', async () => {
        const { privateKey, jwk } = makeRsa();
        const verifier = smartVerifier(jwk, { active: false });
        await expect(verifier.verify(signRs256(validClaims, privateKey))).rejects.toThrow(/token_inactive/);
    });

    // Failure mode: a token with no patient context reaches the interactive surface.
    it('rejects a token with no patient context (403)', async () => {
        const { privateKey, jwk } = makeRsa();
        const verifier = smartVerifier(jwk, { active: true, sub: 'user-1' });
        await expect(verifier.verify(signRs256(validClaims, privateKey))).rejects.toMatchObject({ status: 403, reason: 'no_patient_context' });
    });

    // Failure mode: a token bound to a patient the sidecar hasn't seeded silently maps to someone.
    it('rejects when the bound patient is not linked to a sidecar patient (403)', async () => {
        const { privateKey, jwk } = makeRsa();
        const verifier = smartVerifier(jwk, { active: true, patient: 'uuid-unknown' }, async () => null);
        await expect(verifier.verify(signRs256(validClaims, privateKey))).rejects.toMatchObject({ status: 403, reason: 'patient_not_linked' });
    });
});

// ---- Middleware PEP + auth routes ----

interface MiniAppOptions {
    mode: AuthMode;
    devTokens?: DevTokenService;
    knownPatients?: readonly string[];
}

function miniApp(options: MiniAppOptions): FastifyInstance {
    const app = Fastify({ logger: false });
    const verifier = new CompositeVerifier(options.devTokens, undefined);
    registerAuth(app, { verifier, mode: options.mode });
    const known = new Set(options.knownPatients ?? ['margaret-chen', 'tren-okafor']);
    registerAuthRoutes(app, {
        ...(options.devTokens !== undefined ? { devTokens: options.devTokens } : {}),
        patientExists: async (id) => known.has(id),
        mode: options.mode,
    });
    app.get('/api/overview/:patientId', async (request) => ({ ok: true, principalPatient: request.principal?.patient ?? null }));
    app.post('/api/prep/:patientId', async () => ({ started: true }));
    app.get('/api/patients', async () => ({ patients: [] }));
    app.get('/health', async () => ({ status: 'ok' }));
    app.get('/api/images/oct.png', async () => 'bytes');
    return app;
}

function bearer(token: string): Record<string, string> {
    return { authorization: `Bearer ${token}` };
}

describe('registerAuth middleware', () => {
    // Failure mode: 'off' mode rejects requests, breaking the live demo before the panel ships tokens.
    it("'off' mode never rejects, even with no token or a garbage token", async () => {
        const app = miniApp({ mode: 'off', devTokens: devService() });
        expect((await app.inject({ method: 'GET', url: '/api/overview/margaret-chen' })).statusCode).toBe(200);
        const garbage = await app.inject({ method: 'GET', url: '/api/overview/margaret-chen', headers: bearer('not-a-jwt') });
        expect(garbage.statusCode).toBe(200);
    });

    // Failure mode: an enforced route serves an unauthenticated caller.
    it("'enforced' mode returns 401 without a token", async () => {
        const app = miniApp({ mode: 'enforced', devTokens: devService() });
        const res = await app.inject({ method: 'GET', url: '/api/overview/margaret-chen' });
        expect(res.statusCode).toBe(401);
        expect(res.json()).toMatchObject({ reason: 'missing_token' });
    });

    // Failure mode: the whole point — a token for patient A reads patient B's chart.
    it('enforces the cross-patient 403 (token bound to A cannot read B)', async () => {
        const dev = devService();
        const app = miniApp({ mode: 'enforced', devTokens: dev });
        const { token } = dev.mint({ username: 'dr-demo', role: 'physician', patient: 'margaret-chen' });
        expect((await app.inject({ method: 'GET', url: '/api/overview/margaret-chen', headers: bearer(token) })).statusCode).toBe(200);
        const cross = await app.inject({ method: 'GET', url: '/api/overview/tren-okafor', headers: bearer(token) });
        expect(cross.statusCode).toBe(403);
        expect(cross.json()).toMatchObject({ reason: 'cross_patient' });
    });

    // Failure mode: a nurse (read-only) triggers a prep run.
    it('gates the prep trigger by role (nurse 403, physician 200)', async () => {
        const dev = devService();
        const app = miniApp({ mode: 'enforced', devTokens: dev });
        const nurse = dev.mint({ username: 'nurse-demo', role: 'nurse', patient: 'margaret-chen' }).token;
        const physician = dev.mint({ username: 'dr-demo', role: 'physician', patient: 'margaret-chen' }).token;
        const nurseRes = await app.inject({ method: 'POST', url: '/api/prep/margaret-chen', headers: bearer(nurse) });
        expect(nurseRes.statusCode).toBe(403);
        expect(nurseRes.json()).toMatchObject({ reason: 'role_cannot_trigger_prep' });
        expect((await app.inject({ method: 'POST', url: '/api/prep/margaret-chen', headers: bearer(physician) })).statusCode).toBe(200);
    });

    // Failure mode: health/image routes require auth and break liveness probes / <img> loads.
    it('leaves /health and /api/images open even when enforced', async () => {
        const app = miniApp({ mode: 'enforced', devTokens: devService() });
        expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
        expect((await app.inject({ method: 'GET', url: '/api/images/oct.png' })).statusCode).toBe(200);
    });

    // Failure mode: the day-schedule list (the bootstrap entry) is gated, deadlocking the panel
    // (it needs the list to know which patient to bind a token to). It is open by design.
    it('leaves the patient list open (bootstrap entry, not patient-scoped)', async () => {
        const app = miniApp({ mode: 'enforced', devTokens: devService() });
        expect((await app.inject({ method: 'GET', url: '/api/patients' })).statusCode).toBe(200);
    });
});

describe('auth routes (dev-login + me)', () => {
    // Failure mode: dev-login mints a token for a patient that doesn't exist, or with a bad role.
    it('mints a token via POST /api/dev-login and rejects unknown patients/roles', async () => {
        const dev = devService();
        const app = miniApp({ mode: 'enforced', devTokens: dev });
        const ok = await app.inject({ method: 'POST', url: '/api/dev-login', payload: { role: 'physician', patient: 'margaret-chen' } });
        expect(ok.statusCode).toBe(200);
        const body = ok.json();
        expect(body.token_type).toBe('Bearer');
        // The minted token actually authorizes its patient.
        const me = await app.inject({ method: 'GET', url: '/api/me', headers: bearer(body.access_token) });
        expect(me.json()).toMatchObject({ authenticated: true, role: 'physician', patient: 'margaret-chen', capabilities: { triggerPrep: true } });

        expect((await app.inject({ method: 'POST', url: '/api/dev-login', payload: { role: 'physician', patient: 'ghost' } })).statusCode).toBe(404);
        expect((await app.inject({ method: 'POST', url: '/api/dev-login', payload: { role: 'admin', patient: 'margaret-chen' } })).statusCode).toBe(400);
    });

    // Failure mode: dev-login is silently available when it was never enabled.
    it('returns 404 for dev-login when no dev secret is configured', async () => {
        const app = miniApp({ mode: 'off' });
        expect((await app.inject({ method: 'POST', url: '/api/dev-login', payload: { role: 'physician', patient: 'margaret-chen' } })).statusCode).toBe(404);
    });

    // Failure mode: a nurse principal reports physician capabilities to the panel.
    it('GET /api/me reflects role capabilities (nurse: no prep trigger)', async () => {
        const dev = devService();
        const app = miniApp({ mode: 'enforced', devTokens: dev });
        const nurse = dev.mint({ username: 'nurse-demo', role: 'nurse', patient: 'tren-okafor' }).token;
        const me = await app.inject({ method: 'GET', url: '/api/me', headers: bearer(nurse) });
        expect(me.json()).toMatchObject({ role: 'nurse', capabilities: { read: true, triggerPrep: false, verify: false } });
    });
});
