// Fact verification route tests (S3.3): the AZ role capabilities made tangible. Each test names
// the failure mode it guards — a role verifying beyond its authority, an unattributed
// verification, or a cross-patient write slipping through.
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { DevTokenService } from '../src/auth/devToken.js';
import { CompositeVerifier } from '../src/auth/verifier.js';
import { registerAuth, type AuthMode } from '../src/auth/middleware.js';
import { registerVerifyRoutes } from '../src/routes/verify.js';
import type { FactVerification } from '../src/schemas/index.js';

const SECRET = 'test-dev-secret-0123456789';
const now = (): number => 1_700_000_000_000;

interface Recorded {
    patientId: string;
    factId: string;
    verification: FactVerification;
}

function buildApp(mode: AuthMode): { app: FastifyInstance; dev: DevTokenService; recorded: Recorded[] } {
    const dev = new DevTokenService({ secret: SECRET, now });
    const recorded: Recorded[] = [];
    const app = Fastify({ logger: false });
    registerAuth(app, { verifier: new CompositeVerifier(dev, undefined), mode });
    registerVerifyRoutes(app, {
        store: {
            async verifyFact(patientId, factId, verification) {
                if (factId === 'ghost') {
                    return false; // no such fact
                }
                recorded.push({ patientId, factId, verification });
                return true;
            },
        },
        clock: () => new Date('2026-07-09T12:00:00.000Z'),
    });
    return { app, dev, recorded };
}

function bearer(token: string): Record<string, string> {
    return { authorization: `Bearer ${token}` };
}

describe('fact verification route (S3.3)', () => {
    // Failure mode: a physician's verify doesn't record full authority / is wrongly flagged pending.
    it('a physician verifies a fact — records verified + physician role, not pending', async () => {
        const { app, dev, recorded } = buildApp('enforced');
        const token = dev.mint({ username: 'dr-demo', role: 'physician', patient: 'margaret-chen' }).token;
        const res = await app.inject({ method: 'POST', url: '/api/facts/margaret-chen/fact-1/verify', headers: bearer(token) });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({
            ok: true,
            needs_attending_sign_off: false,
            verification: { status: 'verified', verifier_role: 'physician', verified_by_user_id: 'dr-demo' },
        });
        expect(recorded).toHaveLength(1);
        expect(recorded[0]?.patientId).toBe('margaret-chen');
        expect(recorded[0]?.factId).toBe('fact-1');
    });

    // Failure mode: a resident's sign-off is treated as final rather than provisional.
    it("a resident's verification is flagged needs-attending-sign-off", async () => {
        const { app, dev } = buildApp('enforced');
        const token = dev.mint({ username: 'res-demo', role: 'resident', patient: 'margaret-chen' }).token;
        const res = await app.inject({ method: 'POST', url: '/api/facts/margaret-chen/fact-1/verify', headers: bearer(token) });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ needs_attending_sign_off: true, verification: { verifier_role: 'resident' } });
    });

    // Failure mode: a read-only nurse verifies a fact.
    it('a nurse cannot verify (403), and nothing is written', async () => {
        const { app, dev, recorded } = buildApp('enforced');
        const token = dev.mint({ username: 'nurse-demo', role: 'nurse', patient: 'margaret-chen' }).token;
        const res = await app.inject({ method: 'POST', url: '/api/facts/margaret-chen/fact-1/verify', headers: bearer(token) });
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ error: 'role_cannot_verify', role: 'nurse' });
        expect(recorded).toHaveLength(0);
    });

    // Failure mode: an unattributed verification is accepted (must always name a clinician).
    it('requires an authenticated clinician even when AUTH_MODE=off', async () => {
        const { app, recorded } = buildApp('off');
        const res = await app.inject({ method: 'POST', url: '/api/facts/margaret-chen/fact-1/verify' });
        expect(res.statusCode).toBe(401);
        expect(res.json()).toMatchObject({ error: 'verification_requires_auth' });
        expect(recorded).toHaveLength(0);
    });

    // Failure mode: a token bound to one patient verifies another patient's fact.
    it('blocks cross-patient verification (403), and nothing is written', async () => {
        const { app, dev, recorded } = buildApp('enforced');
        const token = dev.mint({ username: 'dr-demo', role: 'physician', patient: 'margaret-chen' }).token;
        const res = await app.inject({ method: 'POST', url: '/api/facts/tren-okafor/fact-9/verify', headers: bearer(token) });
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ reason: 'cross_patient' });
        expect(recorded).toHaveLength(0);
    });

    // Failure mode: verifying a nonexistent fact silently "succeeds".
    it('404s an unknown fact', async () => {
        const { app, dev } = buildApp('enforced');
        const token = dev.mint({ username: 'dr-demo', role: 'physician', patient: 'margaret-chen' }).token;
        const res = await app.inject({ method: 'POST', url: '/api/facts/margaret-chen/ghost/verify', headers: bearer(token) });
        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({ error: 'fact_not_found' });
    });
});
