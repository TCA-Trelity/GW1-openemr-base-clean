// AgentForge red-team finding (economic DoS): before this, a single caller could flood the chat
// endpoint and exhaust the shared $5/day LLM budget, denying the assistant to every clinician. The
// per-caller rate limiter bounds that. These tests pin the window logic and the 429 on the guarded
// LLM/write routes (chat/prep/document upload), and that unguarded routes are untouched.
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter, registerRateLimit } from '../src/lib/rateLimiter.js';

describe('FixedWindowRateLimiter', () => {
    it('allows up to max per window, then denies with a retry-after, and resets after the window', () => {
        let now = 1_000;
        const limiter = new FixedWindowRateLimiter({ max: 3, windowMs: 1_000, now: () => now });
        expect(limiter.check('k').allowed).toBe(true);
        expect(limiter.check('k').allowed).toBe(true);
        expect(limiter.check('k').allowed).toBe(true);
        const denied = limiter.check('k');
        expect(denied.allowed).toBe(false);
        expect(denied.retryAfterMs).toBeGreaterThan(0);
        // A different key has its own bucket — one caller's flood doesn't starve another.
        expect(limiter.check('other').allowed).toBe(true);
        // Advance past the window → the bucket resets.
        now += 1_001;
        expect(limiter.check('k').allowed).toBe(true);
    });
});

describe('registerRateLimit preHandler', () => {
    function appWith(max: number) {
        const app = Fastify({ logger: false });
        registerRateLimit(app, { max, windowMs: 60_000 });
        app.post('/api/chat/:patientId', async () => ({ ok: true }));
        app.post('/api/patients/:patientId/documents', async () => ({ ok: true }));
        app.get('/api/patients', async () => ({ patients: [] })); // unguarded (GET, not expensive)
        return app;
    }

    it('429s the guarded chat route once the per-caller limit is exceeded', async () => {
        const app = appWith(2);
        expect((await app.inject({ method: 'POST', url: '/api/chat/margaret-chen' })).statusCode).toBe(200);
        expect((await app.inject({ method: 'POST', url: '/api/chat/margaret-chen' })).statusCode).toBe(200);
        const limited = await app.inject({ method: 'POST', url: '/api/chat/margaret-chen' });
        expect(limited.statusCode).toBe(429);
        expect(limited.json()).toMatchObject({ error: 'rate_limited' });
        expect(limited.headers['retry-after']).toBeDefined();
        await app.close();
    });

    it('does not rate-limit cheap/unguarded routes (GET /api/patients)', async () => {
        const app = appWith(1);
        for (let i = 0; i < 5; i += 1) {
            expect((await app.inject({ method: 'GET', url: '/api/patients' })).statusCode).toBe(200);
        }
        await app.close();
    });
});
