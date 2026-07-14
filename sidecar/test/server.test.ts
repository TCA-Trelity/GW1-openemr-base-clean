// Scaffold tests: health/readiness contract, correlation-ID propagation, and the
// scan-image static route. Each test names the failure mode it guards.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

function testServer() {
    return buildServer(loadConfig({ NODE_ENV: 'test' }));
}

describe('health endpoints', () => {
    // Guards: liveness probe must never depend on downstream services.
    it('GET /health returns ok with no dependencies configured', async () => {
        const app = testServer();
        const res = await app.inject({ method: 'GET', url: '/health' });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ status: 'ok' });
    });

    // Guards: /ready silently returning 200 while unconfigured in production
    // (the brief requires readiness to validate meaningful dependencies).
    it('GET /ready reports not_configured deps without failing readiness outside production', async () => {
        const app = testServer();
        const res = await app.inject({ method: 'GET', url: '/ready' });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.ready).toBe(true);
        expect(body.dependencies.openemr.status).toBe('not_configured');
        expect(body.dependencies.anthropic.status).toBe('not_configured');
    });

    // Guards: production boot with missing required dependencies must be not-ready.
    it('GET /ready is 503 in production when required deps are unconfigured', async () => {
        const app = buildServer(loadConfig({ NODE_ENV: 'production' }));
        const res = await app.inject({ method: 'GET', url: '/ready' });
        expect(res.statusCode).toBe(503);
        expect(res.json().ready).toBe(false);
    });

    // Week 2 (E.6, G14): the multimodal deps degrade honestly — absent = not_configured
    // (never binary-down), wired-but-broken = failed + 503.
    it('GET /ready reports the W2 deps (document storage, retriever index, reranker) as degraded when unwired', async () => {
        const app = testServer();
        const body = (await app.inject({ method: 'GET', url: '/ready' })).json();
        expect(body.ready).toBe(true);
        expect(body.dependencies.document_storage.status).toBe('not_configured');
        expect(body.dependencies.retriever_index.status).toBe('not_configured');
        expect(body.dependencies.reranker.status).toBe('not_configured');
    });

    it('a wired-but-empty retriever index FAILS readiness; healthy probes report ok', async () => {
        const { default: Fastify } = await import('fastify');
        const { registerHealthRoutes } = await import('../src/routes/health.js');
        const config = loadConfig({ NODE_ENV: 'test' });

        const broken = Fastify();
        registerHealthRoutes(broken, config, {
            checkPostgres: async () => {},
            checkDocumentStorage: async () => {},
            checkRetrieverIndex: async () => {
                throw new Error('guideline index holds zero chunks');
            },
        });
        const brokenRes = await broken.inject({ method: 'GET', url: '/ready' });
        expect(brokenRes.statusCode).toBe(503);
        const brokenBody = brokenRes.json();
        expect(brokenBody.dependencies.retriever_index.status).toBe('failed');
        expect(brokenBody.dependencies.retriever_index.error).toContain('zero chunks');
        expect(brokenBody.dependencies.document_storage.status).toBe('ok');

        const healthy = Fastify();
        registerHealthRoutes(healthy, config, {
            checkPostgres: async () => {},
            checkDocumentStorage: async () => {},
            checkRetrieverIndex: async () => {},
            checkReranker: async () => {},
        });
        const healthyBody = (await healthy.inject({ method: 'GET', url: '/ready' })).json();
        expect(healthyBody.ready).toBe(true);
        expect(healthyBody.dependencies.reranker.status).toBe('ok');
    });
});

describe('scan images route', () => {
    // 1x1 transparent PNG.
    const PNG = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        'base64',
    );

    function imageServer() {
        const dir = mkdtempSync(path.join(tmpdir(), 'scan-images-'));
        writeFileSync(path.join(dir, 'oct-test.png'), PNG);
        return buildServer(loadConfig({ NODE_ENV: 'test', SCAN_IMAGES_DIR: dir }));
    }

    // Guards: the ScanImage seam contract — a stored storage_key must resolve to bytes.
    it('serves an image by storage key with an image content type', async () => {
        const res = await imageServer().inject({ method: 'GET', url: '/api/images/oct-test.png' });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('image/png');
        expect(res.rawPayload.length).toBe(PNG.length);
    });

    // Guards: path traversal out of the images directory and silent 200s on misses.
    it('rejects traversal and answers 404 for unknown keys', async () => {
        const app = imageServer();
        expect((await app.inject({ method: 'GET', url: '/api/images/../server.ts' })).statusCode).toBeGreaterThanOrEqual(400);
        expect((await app.inject({ method: 'GET', url: '/api/images/nope.png' })).statusCode).toBe(404);
    });
});

describe('correlation IDs', () => {
    // Guards: broken trace reconstruction — every response must carry the ID.
    it('echoes an incoming x-correlation-id', async () => {
        const app = testServer();
        const res = await app.inject({
            method: 'GET',
            url: '/health',
            headers: { 'x-correlation-id': 'test-corr-123' },
        });
        expect(res.headers['x-correlation-id']).toBe('test-corr-123');
    });

    // Guards: requests without an inbound ID must still get a generated one.
    it('generates a correlation id when none provided', async () => {
        const app = testServer();
        const res = await app.inject({ method: 'GET', url: '/health' });
        expect(res.headers['x-correlation-id']).toBeTruthy();
    });
});
