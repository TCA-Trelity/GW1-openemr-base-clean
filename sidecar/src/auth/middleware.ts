// Auth enforcement (AZ2): one global preHandler is the single Policy Enforcement Point for the
// whole API surface — every patient route inherits it, so there is no way to add a route that
// silently forgets authorization. It does three things, in order:
//   1. Attach a verified Principal to the request (from the Bearer token), if one is present.
//   2. 401 when a protected route is called without a valid principal (enforced mode).
//   3. 403 when the principal's bound patient != the requested :patientId (the STRUCTURAL
//      cross-patient block ARCHITECTURE.md §3 promises), or when the role lacks the capability
//      the route needs (nurse cannot trigger a prep).
//
// AUTH_MODE gates rejection: 'off' attaches a principal when a token is present but never
// rejects (preserves the live demo before the panel ships tokens); 'enforced' is the real PEP.
// Enforcement never applies to /health, /ready, dev-login (mints the token), or the image route
// (loaded by <img>, which cannot carry an Authorization header).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AuthError, capabilitiesFor, type Principal } from './principal.js';
import type { PrincipalVerifier } from './verifier.js';

export type AuthMode = 'off' | 'enforced';

export interface AuthDeps {
    verifier: PrincipalVerifier;
    mode: AuthMode;
}

declare module 'fastify' {
    interface FastifyRequest {
        principal: Principal | null;
    }
}

const OPEN_PATHS = new Set<string>(['/health', '/ready', '/api/dev-login']);
// <img>-loaded and unauthenticated by nature; a bearer cannot ride an <img> src.
const OPEN_PREFIXES = ['/api/images/'];

function pathOf(request: FastifyRequest): string {
    const url = request.url;
    const q = url.indexOf('?');
    return q === -1 ? url : url.slice(0, q);
}

function isOpen(path: string): boolean {
    if (!path.startsWith('/api/')) {
        return true; // panel SPA + static assets are open; only /api/* is guarded
    }
    return OPEN_PATHS.has(path) || OPEN_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function bearerFrom(authorization: string | undefined): string | null {
    if (authorization === undefined) {
        return null;
    }
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    const token = match?.[1];
    return token === undefined ? null : token.trim();
}

/** The :patientId this route is scoped to, if any (all patient routes name it 'patientId'). */
function requestedPatientId(request: FastifyRequest): string | null {
    const params = request.params;
    if (typeof params === 'object' && params !== null && 'patientId' in params) {
        const value = (params as Record<string, unknown>)['patientId'];
        return typeof value === 'string' ? value : null;
    }
    return null;
}

/** Triggering a preparation run is a provider action (POST /api/prep/:patientId). */
function requiresPrepTrigger(request: FastifyRequest, path: string): boolean {
    return request.method === 'POST' && path.startsWith('/api/prep/');
}

export function registerAuth(app: FastifyInstance, deps: AuthDeps | undefined): void {
    // Decorate unconditionally so `request.principal` is always a defined property (null when
    // unauthenticated), even in bare scaffolds where no verifier is wired.
    app.decorateRequest('principal', null);
    if (deps === undefined) {
        return;
    }

    app.addHook('preHandler', async (request, reply) => {
        const path = pathOf(request);
        if (isOpen(path)) {
            return;
        }

        const token = bearerFrom(request.headers.authorization);
        if (token !== null) {
            try {
                request.principal = await deps.verifier.verify(token);
            } catch (error) {
                if (!(error instanceof AuthError)) {
                    throw error; // unexpected failure — surface as 500, do not mask as 401
                }
                if (deps.mode === 'enforced') {
                    return reply.status(error.status).send({ error: 'unauthorized', reason: error.reason });
                }
                // 'off' mode: an invalid token is simply ignored (no principal attached).
            }
        }

        if (deps.mode !== 'enforced') {
            return; // attach-only; never reject
        }
        if (request.principal === null) {
            return reply.status(401).send({ error: 'unauthorized', reason: 'missing_token' });
        }
        const requested = requestedPatientId(request);
        if (requested !== null && request.principal.patient !== requested) {
            return reply.status(403).send({ error: 'forbidden', reason: 'cross_patient' });
        }
        if (requiresPrepTrigger(request, path) && !capabilitiesFor(request.principal.role).triggerPrep) {
            return reply.status(403).send({ error: 'forbidden', reason: 'role_cannot_trigger_prep' });
        }
    });
}
