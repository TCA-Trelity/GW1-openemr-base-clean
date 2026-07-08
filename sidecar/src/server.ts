// Sidecar entrypoint. Every request gets a correlation ID (honoring an incoming
// x-correlation-id) that appears on every log line, response header, and — as
// later tickets land — every tool call and LLM interaction, so a full trace
// reconstructs from logs alone (project brief engineering requirement).
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig, type Config } from './config.js';
import { registerHealthRoutes } from './routes/health.js';

export function buildServer(config: Config): FastifyInstance {
    const app = Fastify({
        logger: {
            level: config.NODE_ENV === 'test' ? 'silent' : 'info',
        },
        genReqId: (req) => (req.headers['x-correlation-id'] as string | undefined) ?? randomUUID(),
    });

    app.addHook('onSend', async (request, reply) => {
        reply.header('x-correlation-id', request.id);
    });

    registerHealthRoutes(app, config);
    return app;
}

// Boot only when executed directly (tests import buildServer instead).
if (process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('server.ts')) {
    const config = loadConfig();
    const app = buildServer(config);
    app.listen({ port: config.PORT, host: '0.0.0.0' }).catch((error) => {
        app.log.error(error, 'failed to start');
        process.exit(1);
    });
}
