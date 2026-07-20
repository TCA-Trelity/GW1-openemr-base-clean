// Hand-rolled fixed-window rate limiter (no library — matching the in-house circuitBreaker.ts
// style). It caps the expensive LLM/write POST routes PER CALLER so one client cannot flood the
// assistant and exhaust the shared 24h LLM budget, denying every clinician (the AgentForge
// "economic denial of service" finding). The existing 2000-char cap and global $5/day budget stay;
// this adds the missing per-principal request bound.
//
// Keyed by the authenticated principal (user+patient) when one is present, else the client IP, so a
// bound clinician gets their own bucket and an anonymous flood is bounded by source. In-process and
// per-instance (like the circuit breaker); a multi-instance deployment would move this to Redis —
// documented, not implemented.
import type { FastifyInstance, FastifyRequest } from 'fastify';

export interface RateLimiterOptions {
    /** Requests allowed per window, per key. */
    max: number;
    /** Window length in milliseconds. */
    windowMs: number;
    /** Injectable clock (tests); defaults to Date.now. */
    now?: () => number;
}

export interface RateDecision {
    allowed: boolean;
    remaining: number;
    retryAfterMs: number;
}

export class FixedWindowRateLimiter {
    private readonly hits = new Map<string, { count: number; resetAt: number }>();
    private readonly now: () => number;

    constructor(private readonly options: RateLimiterOptions) {
        this.now = options.now ?? (() => Date.now());
    }

    check(key: string): RateDecision {
        const t = this.now();
        const entry = this.hits.get(key);
        if (entry === undefined || t >= entry.resetAt) {
            this.hits.set(key, { count: 1, resetAt: t + this.options.windowMs });
            return { allowed: true, remaining: this.options.max - 1, retryAfterMs: 0 };
        }
        if (entry.count >= this.options.max) {
            return { allowed: false, remaining: 0, retryAfterMs: entry.resetAt - t };
        }
        entry.count += 1;
        return { allowed: true, remaining: this.options.max - entry.count, retryAfterMs: 0 };
    }

    /** Drop expired windows so the map cannot grow unbounded over a long-lived process. */
    prune(): void {
        const t = this.now();
        for (const [key, entry] of this.hits) {
            if (t >= entry.resetAt) {
                this.hits.delete(key);
            }
        }
    }
}

function pathOf(request: FastifyRequest): string {
    const url = request.url;
    const q = url.indexOf('?');
    return q === -1 ? url : url.slice(0, q);
}

/** The expensive routes worth rate-limiting: the LLM/write POSTs. dev-login (token mint) is exempt. */
function isGuarded(request: FastifyRequest, path: string): boolean {
    if (request.method !== 'POST' || path === '/api/dev-login') {
        return false;
    }
    return path.startsWith('/api/chat/') || path.startsWith('/api/prep/') || /^\/api\/patients\/[^/]+\/documents$/.test(path);
}

/** Bucket key: the bound principal when present (per-clinician), else the source IP. */
export function rateLimitKey(request: FastifyRequest): string {
    // `?? null` also covers a bare app where the auth PEP never decorated `principal` (undefined).
    const principal = request.principal ?? null;
    return principal !== null ? `pr:${principal.user}:${principal.patient ?? '-'}` : `ip:${request.ip}`;
}

/**
 * Install the rate-limit preHandler. Register AFTER the auth PEP so `request.principal` is attached
 * when a token is present. Guarded routes over the limit answer 429 with a Retry-After.
 */
export function registerRateLimit(app: FastifyInstance, options: RateLimiterOptions): FixedWindowRateLimiter {
    const limiter = new FixedWindowRateLimiter(options);
    app.addHook('preHandler', async (request, reply) => {
        const path = pathOf(request);
        if (!isGuarded(request, path)) {
            return;
        }
        const decision = limiter.check(rateLimitKey(request));
        if (!decision.allowed) {
            return reply
                .header('retry-after', String(Math.ceil(decision.retryAfterMs / 1000)))
                .status(429)
                .send({ error: 'rate_limited', retry_after_ms: decision.retryAfterMs });
        }
    });
    return limiter;
}
