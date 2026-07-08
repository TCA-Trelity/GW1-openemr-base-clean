// EHR sync route (E2): POST triggers a live FHIR pull for a linked patient and rewrites
// the EHR snapshot in the fact store. Kept synchronous — a snapshot is a handful of small
// FHIR reads, not a multi-minute LLM job.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { EhrSyncService } from '../openemr/ehrSync.js';

export interface EhrRouteDeps {
    service: EhrSyncService;
}

function storeNotConfigured(reply: FastifyReply): FastifyReply {
    return reply.status(503).send({ error: 'ehr_sync_not_configured' });
}

export function registerEhrRoutes(app: FastifyInstance, deps: EhrRouteDeps | undefined): void {
    app.post<{ Params: { patientId: string } }>('/api/ehr-sync/:patientId', async (request, reply) => {
        if (deps === undefined) {
            return storeNotConfigured(reply);
        }
        const result = await deps.service.sync(request.params.patientId, String(request.id));
        if (!result.synced) {
            // Unlinked / unknown patient is a clean 409, not a 500 — the caller can act on the reason.
            return reply.status(409).send(result);
        }
        return reply.send(result);
    });
}
