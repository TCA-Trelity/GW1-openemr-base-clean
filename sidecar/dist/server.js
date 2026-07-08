// Sidecar entrypoint. Every request gets a correlation ID (honoring an incoming
// x-correlation-id) that appears on every log line, response header, tool call and
// LLM interaction, so a full trace reconstructs from logs alone (project brief
// engineering requirement). Store-backed deps wire in only when DATABASE_URL is set.
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { loadConfig } from './config.js';
import { AnthropicClient } from './prep/anthropic.js';
import { FactExtractor } from './prep/extraction.js';
import { StoreDocumentSource } from './prep/sources.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerPrepRoutes } from './routes/prep.js';
import { createPool, FactStore } from './store/index.js';
import { migrate } from './store/migrate.js';
// Store-backed dependencies exist only when DATABASE_URL is configured; without it the
// scaffold still boots and the prep routes answer 503 store_not_configured.
export function buildDeps(config) {
    if (config.DATABASE_URL === undefined) {
        return undefined;
    }
    const pool = createPool(config);
    const store = new FactStore(pool);
    const extractor = new FactExtractor(new AnthropicClient({ apiKey: config.ANTHROPIC_API_KEY ?? '', model: config.ANTHROPIC_MODEL_PREP }));
    return {
        checkPostgres: async () => {
            await pool.query('SELECT 1');
        },
        runMigrations: () => migrate(pool),
        prep: {
            store,
            // Tier-1 demo path reads the seeded fact store; FhirDocumentSource swaps in
            // once the live FHIR client credentials land with S1.9.
            source: new StoreDocumentSource(store, pool),
            extractor,
        },
    };
}
export function buildServer(config, deps) {
    const app = Fastify({
        logger: {
            level: config.NODE_ENV === 'test' ? 'silent' : 'info',
        },
        genReqId: (req) => req.headers['x-correlation-id'] ?? randomUUID(),
    });
    app.addHook('onSend', async (request, reply) => {
        reply.header('x-correlation-id', request.id);
    });
    registerHealthRoutes(app, config, deps === undefined ? undefined : { checkPostgres: deps.checkPostgres });
    registerPrepRoutes(app, deps?.prep);
    return app;
}
// Boot only when executed directly (tests import buildServer instead).
if (process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('server.ts')) {
    const config = loadConfig();
    const deps = buildDeps(config);
    const app = buildServer(config, deps);
    // Migrations run at boot when the store is wired: idempotent + advisory-locked,
    // so concurrent replicas serialize and a no-op boot costs one SELECT.
    const boot = async () => {
        if (deps !== undefined) {
            const applied = await deps.runMigrations();
            app.log.info({ applied }, 'fact store migrations checked');
        }
        await app.listen({ port: config.PORT, host: '0.0.0.0' });
    };
    boot().catch((error) => {
        app.log.error(error, 'failed to start');
        process.exit(1);
    });
}
//# sourceMappingURL=server.js.map