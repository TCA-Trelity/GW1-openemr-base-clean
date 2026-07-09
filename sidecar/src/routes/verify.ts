// Fact verification (S3.3): a capability-gated write that records a clinician's sign-off on a
// fact, making the AZ role model do something visible. A physician verifies with full authority;
// a resident can verify but the result is flagged needs-attending-sign-off (their verify
// capability); a nurse (read-only) is refused. Verification must be ATTRIBUTABLE, so this route
// requires an authenticated principal regardless of AUTH_MODE — and the auth middleware's
// patient-binding already blocks a token bound to patient A from verifying patient B's facts.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { capabilitiesFor } from '../auth/principal.js';
import type { FactVerification } from '../schemas/index.js';

export interface VerifyRouteStore {
    verifyFact(patientId: string, factId: string, verification: FactVerification): Promise<boolean>;
}

export interface VerifyRouteDeps {
    store: VerifyRouteStore;
    clock?: () => Date;
}

type VerifyParams = { Params: { patientId: string; factId: string } };

function storeNotConfigured(reply: FastifyReply): FastifyReply {
    return reply.status(503).send({ error: 'store_not_configured' });
}

export function registerVerifyRoutes(app: FastifyInstance, deps: VerifyRouteDeps | undefined): void {
    app.post<VerifyParams>('/api/facts/:patientId/:factId/verify', async (request, reply) => {
        if (deps === undefined) {
            return storeNotConfigured(reply);
        }
        const principal = request.principal;
        if (principal === null) {
            return reply.status(401).send({ error: 'verification_requires_auth' });
        }
        const authority = capabilitiesFor(principal.role).verify;
        if (authority === false) {
            return reply.status(403).send({ error: 'role_cannot_verify', role: principal.role });
        }
        const now = (deps.clock ?? (() => new Date()))();
        const verification: FactVerification = {
            status: 'verified',
            verified_by_user_id: principal.user,
            verified_at: now.toISOString(),
            verifier_role: principal.role,
        };
        const updated = await deps.store.verifyFact(request.params.patientId, request.params.factId, verification);
        if (!updated) {
            return reply.status(404).send({ error: 'fact_not_found' });
        }
        return reply.send({
            ok: true,
            verification,
            // A resident's sign-off is provisional until an attending confirms it.
            needs_attending_sign_off: authority === 'needs_attending_sign_off',
        });
    });
}
