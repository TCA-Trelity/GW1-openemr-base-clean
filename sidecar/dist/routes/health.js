const CHECK_TIMEOUT_MS = 5000;
async function fetchOk(url, init) {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
    }
}
function buildChecks(config, probes) {
    return [
        {
            name: 'openemr',
            requiredInProduction: true,
            configured: config.OPENEMR_BASE_URL !== undefined,
            // FHIR capability statement — unauthenticated, proves the EHR answers.
            check: () => fetchOk(`${config.OPENEMR_BASE_URL}/apis/default/fhir/metadata`),
        },
        {
            name: 'anthropic',
            requiredInProduction: true,
            configured: config.ANTHROPIC_API_KEY !== undefined,
            // Model list — cheapest authenticated call; proves the key is live.
            check: () => fetchOk('https://api.anthropic.com/v1/models', {
                headers: {
                    'x-api-key': config.ANTHROPIC_API_KEY ?? '',
                    'anthropic-version': '2023-06-01',
                },
            }),
        },
        {
            name: 'langfuse',
            requiredInProduction: true,
            configured: config.LANGFUSE_HOST !== undefined,
            check: () => fetchOk(`${config.LANGFUSE_HOST}/api/public/health`),
        },
        // Real when server.ts wires the pool (S1.7): SELECT 1 through the injected probe.
        {
            name: 'postgres',
            requiredInProduction: false,
            configured: probes?.checkPostgres !== undefined,
            check: probes?.checkPostgres ?? (async () => { }),
        },
        // redis check lands with the queue (S1.9) if BullMQ is adopted.
        {
            name: 'redis',
            requiredInProduction: false,
            configured: false,
            check: async () => { },
        },
    ];
}
export function registerHealthRoutes(app, config, probes) {
    app.get('/health', async () => ({ status: 'ok' }));
    app.get('/ready', async (request, reply) => {
        const checks = buildChecks(config, probes);
        const results = {};
        await Promise.all(checks.map(async (dep) => {
            if (!dep.configured) {
                results[dep.name] = { status: 'not_configured' };
                return;
            }
            try {
                await dep.check();
                results[dep.name] = { status: 'ok' };
            }
            catch (error) {
                request.log.warn({ dep: dep.name, error: String(error) }, 'readiness check failed');
                results[dep.name] = { status: 'failed', error: String(error) };
            }
        }));
        const anyConfiguredFailed = Object.values(results).some((r) => r.status === 'failed');
        const missingRequired = config.NODE_ENV === 'production' &&
            checks.some((dep) => dep.requiredInProduction && !dep.configured);
        const ready = !anyConfiguredFailed && !missingRequired;
        return reply.status(ready ? 200 : 503).send({ ready, dependencies: results });
    });
}
//# sourceMappingURL=health.js.map