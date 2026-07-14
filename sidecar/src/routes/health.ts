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

/** Probes injected by server.ts when the backing dependency is wired (S1.7: postgres;
 *  Week 2 E.6/G14: document storage, retriever index, reranker). Absent probe = the
 *  dependency is not wired on this deployment → `not_configured` (degraded, visible,
 *  never binary-down). */
export interface HealthProbes {
    checkPostgres?: () => Promise<void>;
    /** OpenEMR standard-API write client (document storage): token mint proves the
     *  password-grant client + scopes are live. */
    checkDocumentStorage?: () => Promise<void>;
    /** Hybrid retriever: resolves only when the guideline index holds chunks. */
    checkRetrieverIndex?: () => Promise<void>;
    /** Reranker: resolves when the live (Cohere) reranker is keyed; absent probe =
     *  PassthroughReranker fallback (degraded is accurate — fusion order still serves). */
    checkReranker?: () => Promise<void>;
}

function buildChecks(config: Config, probes?: HealthProbes): DepCheck[] {
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
            // Flips to required when the observability service deploys (S2.6);
            // until then an absent LANGFUSE_HOST must not fail readiness.
            requiredInProduction: false,
            configured: config.LANGFUSE_HOST !== undefined,
            check: () => fetchOk(`${config.LANGFUSE_HOST}/api/public/health`),
        },
        // Real when server.ts wires the pool (S1.7): SELECT 1 through the injected probe.
        {
            name: 'postgres',
            requiredInProduction: false,
            configured: probes?.checkPostgres !== undefined,
            check: probes?.checkPostgres ?? (async () => {}),
        },
        // redis check lands with the queue (S1.9) if BullMQ is adopted.
        {
            name: 'redis',
            requiredInProduction: false,
            configured: false,
            check: async () => {},
        },
        // Week 2 (E.6, G14): the multimodal-agent dependencies. Each degrades to
        // not_configured when its subsystem isn't wired — /ready stays honest, not binary.
        {
            name: 'document_storage',
            requiredInProduction: false,
            configured: probes?.checkDocumentStorage !== undefined,
            check: probes?.checkDocumentStorage ?? (async () => {}),
        },
        {
            name: 'retriever_index',
            requiredInProduction: false,
            configured: probes?.checkRetrieverIndex !== undefined,
            check: probes?.checkRetrieverIndex ?? (async () => {}),
        },
        {
            name: 'reranker',
            requiredInProduction: false,
            configured: probes?.checkReranker !== undefined,
            check: probes?.checkReranker ?? (async () => {}),
        },
    ];
}

export function registerHealthRoutes(app: FastifyInstance, config: Config, probes?: HealthProbes): void {
    app.get('/health', async () => ({ status: 'ok' }));

    app.get('/ready', async (request, reply) => {
        const checks = buildChecks(config, probes);
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
