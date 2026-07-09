// EHR sync route (E2): POST triggers a live FHIR pull for a linked patient and rewrites
// the EHR snapshot in the fact store. Kept synchronous — a snapshot is a handful of small
// FHIR reads, not a multi-minute LLM job.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { OpenEmrAuthError } from '../openemr/auth.js';
import type { EhrSyncResult } from '../openemr/ehrSync.js';
import { FhirRequestError } from '../openemr/fhir.js';

/** The sync surface this route needs (EhrSyncService satisfies it; tests fake it). */
export interface EhrSyncLike {
    sync(patientId: string, correlationId: string): Promise<EhrSyncResult>;
}

export interface EhrRouteDeps {
    service: EhrSyncLike;
}

function storeNotConfigured(reply: FastifyReply): FastifyReply {
    return reply.status(503).send({ error: 'ehr_sync_not_configured' });
}

export function registerEhrRoutes(app: FastifyInstance, deps: EhrRouteDeps | undefined): void {
    app.post<{ Params: { patientId: string } }>('/api/ehr-sync/:patientId', async (request, reply) => {
        if (deps === undefined) {
            return storeNotConfigured(reply);
        }
        try {
            const result = await deps.service.sync(request.params.patientId, String(request.id));
            if (!result.synced) {
                // Unlinked / unknown patient is a clean 409, not a 500 — the caller can act on the reason.
                return reply.status(409).send(result);
            }
            return reply.send(result);
        } catch (error) {
            // An upstream OpenEMR failure is the EHR's status, not the caller's: Fastify's default
            // handler would echo these errors' `.status` back to the panel (an OAuth 400 rendered
            // as if the panel's POST were malformed). Map them to a 502 envelope that names the
            // failing dependency; the raw detail goes to the log only.
            if (error instanceof OpenEmrAuthError) {
                request.log.error({ err: String(error) }, 'ehr sync failed: OpenEMR rejected the sidecar credentials');
                return reply.status(502).send({ error: 'ehr_upstream_auth', upstream_status: error.status });
            }
            if (error instanceof FhirRequestError) {
                request.log.error({ err: String(error) }, 'ehr sync failed: FHIR request rejected');
                return reply.status(502).send({ error: 'ehr_upstream_fhir', upstream_status: error.status });
            }
            throw error;
        }
    });
}
