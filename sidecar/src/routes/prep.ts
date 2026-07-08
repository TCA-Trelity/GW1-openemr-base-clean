// Prep/brief/facts routes (S1.7). POST /api/prep runs the pipeline async in-process
// (fire-and-forget, errors captured on the prep_run row); reads return the latest
// complete brief or the fact bundle. Without a configured store the routes answer 503.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { executePrep, type PrepDeps, type PrepStore } from '../prep/pipeline.js';
import type { DocumentSource } from '../prep/sources.js';
import type { FactExtractor } from '../prep/extraction.js';
import type { ProviderProfile } from '../schemas/index.js';
import type { FactBundle, StoredBrief } from '../store/index.js';

/** The FactStore surface these routes need (FactStore satisfies it; tests fake it). */
export interface PrepRouteStore extends PrepStore {
    getBrief(patientId: string): Promise<StoredBrief | null>;
    getFactBundle(patientId: string): Promise<FactBundle | null>;
}

export interface PrepRouteDeps {
    store: PrepRouteStore;
    source: DocumentSource;
    extractor: FactExtractor;
    clock?: () => Date;
    providerProfile?: ProviderProfile;
}

type PatientParams = { Params: { patientId: string } };

function storeNotConfigured(reply: FastifyReply): FastifyReply {
    return reply.status(503).send({ error: 'store_not_configured' });
}

export function registerPrepRoutes(app: FastifyInstance, deps: PrepRouteDeps | undefined): void {
    app.post<PatientParams>('/api/prep/:patientId', async (request, reply) => {
        if (deps === undefined) {
            return storeNotConfigured(reply);
        }
        const { patientId } = request.params;
        const correlationId = request.id;
        const prepRunId = await deps.store.startPrepRun(patientId, correlationId);
        const prepDeps: PrepDeps = {
            store: deps.store,
            source: deps.source,
            extractor: deps.extractor,
            logger: request.log,
            ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
            ...(deps.providerProfile !== undefined ? { providerProfile: deps.providerProfile } : {}),
        };
        // Fire-and-forget (Tier-1 in-process async): executePrep records failures on the
        // prep_run row before rethrowing, so this catch only needs to log.
        void executePrep(prepDeps, { prepRunId, patientId, correlationId }).catch((error: unknown) => {
            request.log.error({ correlationId, prepRunId, err: String(error) }, 'async prep run failed');
        });
        return reply.status(202).send({ prep_run_id: prepRunId, correlation_id: correlationId });
    });

    app.get<PatientParams>('/api/brief/:patientId', async (request, reply) => {
        if (deps === undefined) {
            return storeNotConfigured(reply);
        }
        const brief = await deps.store.getBrief(request.params.patientId);
        if (brief === null) {
            return reply.status(404).send({ status: 'not_prepared' });
        }
        return reply.send(brief);
    });

    app.get<PatientParams>('/api/facts/:patientId', async (request, reply) => {
        if (deps === undefined) {
            return storeNotConfigured(reply);
        }
        const bundle = await deps.store.getFactBundle(request.params.patientId);
        if (bundle === null) {
            return reply.status(404).send({ error: 'patient_not_found' });
        }
        return reply.send(bundle);
    });
}
