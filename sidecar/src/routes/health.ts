// /health (process alive) and /ready (dependencies actually reachable) — kept
// separate per the project brief's engineering requirements. /ready performs
// real checks against OpenEMR, the model provider, and Langfuse; a configured
// dependency that fails makes readiness 503, and in production the three
// required dependencies must be configured at all.
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';

type DepStatus = 'ok' | 'failed' | 'not_configured';

interface DepCheck {
    name: string;
    requiredInProduction: boolean;
    check: () => Promise<void>;
    configured: boolean;
}

const CHECK_TIMEOUT_MS = 5000;

async function fetchOk(url: string, init?: RequestInit): Promise<void> {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
    }
}

function buildChecks(config: Config): DepCheck[] {
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
            check: () =>
                fetchOk('https://api.anthropic.com/v1/models', {
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
        // postgres / redis checks land with the fact store (S1.6) and queue (S1.7).
        {
            name: 'postgres',
            requiredInProduction: false,
            configured: false,
            check: async () => {},
        },
        {
            name: 'redis',
            requiredInProduction: false,
            configured: false,
            check: async () => {},
        },
    ];
}

export function registerHealthRoutes(app: FastifyInstance, config: Config): void {
    app.get('/health', async () => ({ status: 'ok' }));

    app.get('/ready', async (request, reply) => {
        const checks = buildChecks(config);
        const results: Record<string, { status: DepStatus; error?: string }> = {};

        await Promise.all(
            checks.map(async (dep) => {
                if (!dep.configured) {
                    results[dep.name] = { status: 'not_configured' };
                    return;
                }
                try {
                    await dep.check();
                    results[dep.name] = { status: 'ok' };
                } catch (error) {
                    request.log.warn({ dep: dep.name, error: String(error) }, 'readiness check failed');
                    results[dep.name] = { status: 'failed', error: String(error) };
                }
            }),
        );

        const anyConfiguredFailed = Object.values(results).some((r) => r.status === 'failed');
        const missingRequired =
            config.NODE_ENV === 'production' &&
            checks.some((dep) => dep.requiredInProduction && !dep.configured);

        const ready = !anyConfiguredFailed && !missingRequired;
        return reply.status(ready ? 200 : 503).send({ ready, dependencies: results });
    });
}
