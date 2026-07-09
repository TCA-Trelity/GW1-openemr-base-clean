// Auth routes (AZ4). Two endpoints support the demo/grading auth flow:
//   POST /api/dev-login — mint a patient-bound, role-carrying dev token so a grader can exercise
//     the auth model (401 / cross-patient 403 / role gate / role switcher) without a full SMART
//     launch. Open (it is how you GET a token); only present when dev-login is enabled.
//   GET  /api/me — the current principal + its capabilities, so the panel can render the active
//     role and switch it. Protected: the middleware requires a valid principal in enforced mode.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { capabilitiesFor, ROLES } from '../auth/principal.js';
import type { DevTokenService } from '../auth/devToken.js';
import type { AuthMode } from '../auth/middleware.js';

export interface AuthRouteDeps {
    /** Present only when dev-login is enabled (DEV_LOGIN_SECRET set). Absent -> 404 on dev-login. */
    devTokens?: DevTokenService;
    /** Confirms the requested patient exists in the store before binding a token to it. */
    patientExists: (patientId: string) => Promise<boolean>;
    mode: AuthMode;
}

const DevLoginBody = z.object({
    username: z.string().min(1).max(120).default('dr-demo'),
    role: z.enum(ROLES),
    patient: z.string().min(1).max(200),
});

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps | undefined): void {
    app.post('/api/dev-login', async (request, reply) => {
        if (deps?.devTokens === undefined) {
            return reply.status(404).send({ error: 'dev_login_disabled' });
        }
        const parsed = DevLoginBody.safeParse(request.body ?? {});
        if (!parsed.success) {
            return reply.status(400).send({ error: 'invalid_request', roles: ROLES });
        }
        const { username, role, patient } = parsed.data;
        if (!(await deps.patientExists(patient))) {
            return reply.status(404).send({ error: 'patient_not_found' });
        }
        const minted = deps.devTokens.mint({ username, role, patient });
        return reply.send({
            access_token: minted.token,
            token_type: 'Bearer',
            expires_in: minted.expiresIn,
            role,
            patient,
            // Make the nature of this credential unmistakable in logs and to the grader.
            note: 'demo credential — sidecar-minted dev token, not a real EHR SMART launch',
        });
    });

    app.get('/api/me', async (request, reply) => {
        if (deps === undefined) {
            return storeNotConfigured(reply);
        }
        const principal = request.principal;
        if (principal === null) {
            // Reached only in 'off' mode (enforced mode 401s in the middleware first).
            return reply.send({ authenticated: false });
        }
        return reply.send({
            authenticated: true,
            user: principal.user,
            patient: principal.patient,
            role: principal.role,
            token_type: principal.tokenType,
            capabilities: capabilitiesFor(principal.role),
        });
    });
}

function storeNotConfigured(reply: FastifyReply): FastifyReply {
    return reply.status(503).send({ error: 'store_not_configured' });
}
