// Scaffold tests: health/readiness contract and correlation-ID propagation.
// Each test names the failure mode it guards (project convention).
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
