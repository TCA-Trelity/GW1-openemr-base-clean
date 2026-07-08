import { executePrep } from '../prep/pipeline.js';
function storeNotConfigured(reply) {
    return reply.status(503).send({ error: 'store_not_configured' });
}
export function registerPrepRoutes(app, deps) {
    app.post('/api/prep/:patientId', async (request, reply) => {
        if (deps === undefined) {
            return storeNotConfigured(reply);
        }
        const { patientId } = request.params;
        const correlationId = request.id;
        const prepRunId = await deps.store.startPrepRun(patientId, correlationId);
        const prepDeps = {
            store: deps.store,
            source: deps.source,
            extractor: deps.extractor,
            logger: request.log,
            ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
            ...(deps.providerProfile !== undefined ? { providerProfile: deps.providerProfile } : {}),
        };
        // Fire-and-forget (Tier-1 in-process async): executePrep records failures on the
        // prep_run row before rethrowing, so this catch only needs to log.
        void executePrep(prepDeps, { prepRunId, patientId, correlationId }).catch((error) => {
            request.log.error({ correlationId, prepRunId, err: String(error) }, 'async prep run failed');
        });
        return reply.status(202).send({ prep_run_id: prepRunId, correlation_id: correlationId });
    });
    app.get('/api/brief/:patientId', async (request, reply) => {
        if (deps === undefined) {
            return storeNotConfigured(reply);
        }
        const brief = await deps.store.getBrief(request.params.patientId);
        if (brief === null) {
            return reply.status(404).send({ status: 'not_prepared' });
        }
        return reply.send(brief);
    });
    app.get('/api/facts/:patientId', async (request, reply) => {
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
//# sourceMappingURL=prep.js.map