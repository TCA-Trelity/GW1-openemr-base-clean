// H.10 (REQ G2, G14): per-dependency circuit breaker. Failure modes guarded: a dead
// dependency being hammered forever (breaker must trip after N CONSECUTIVE failures and
// short-circuit without invoking the call), intermittent failures tripping a healthy
// dependency (a success must reset the counter), a tripped circuit never recovering
// (cooldown → exactly ONE half-open probe; success re-closes, failure re-opens fresh),
// errors being wrapped en route (callers' instanceof handling must keep working), and the
// breaker counting per ATTEMPT instead of per logical call (it composes OUTSIDE H.5's
// withTimeoutAndRetry — a timed-out-and-retried call that still failed is ONE failure).
import { describe, expect, it, vi } from 'vitest';
import { CircuitBreaker, CircuitOpenError, type BreakerState } from '../src/lib/circuitBreaker.js';
import { AnthropicClient, AnthropicApiError } from '../src/prep/anthropic.js';
import { StandardApiClient, StandardApiError } from '../src/openemr/standardApi.js';

const BASE_URL = 'https://ehr.example.test';
const tokenProvider = { getAccessToken: async () => 'tok' };

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** An attempt that always rejects with the same upstream error message. */
function failing(message = 'upstream 503') {
    return vi.fn(() => Promise.reject(new Error(message)));
}

describe('CircuitBreaker (H.10)', () => {
    it('trips open after N consecutive failures and short-circuits without invoking the call', async () => {
        const transitions: string[] = [];
        // Defaults under test: 5 consecutive failures, 30 s cooldown.
        const breaker = new CircuitBreaker({
            name: 'openemr',
            now: () => 0,
            onTransition: (from: BreakerState, to: BreakerState) => transitions.push(`${from}->${to}`),
        });
        const fn = failing();
        for (let i = 0; i < 5; i += 1) {
            await expect(breaker.exec(fn)).rejects.toThrow('upstream 503');
        }
        expect(breaker.state).toBe('open');
        expect(transitions).toEqual(['closed->open']);
        // 6th call: CircuitOpenError immediately — the spy's call count stops at the threshold.
        const open = await breaker.exec(fn).catch((error: unknown) => error);
        expect(open).toBeInstanceOf(CircuitOpenError);
        expect((open as CircuitOpenError).retryAtMs).toBe(30_000); // pins the default cooldown
        expect(fn).toHaveBeenCalledTimes(5);
    });

    it('a success in closed state resets the consecutive counter — intermittent failures never trip it', async () => {
        const breaker = new CircuitBreaker({ name: 'anthropic', now: () => 0 });
        const fail = failing();
        for (let i = 0; i < 4; i += 1) {
            await expect(breaker.exec(fail)).rejects.toThrow('upstream 503');
        }
        await expect(breaker.exec(async () => 'ok')).resolves.toBe('ok');
        // 4 + 4 failures around one success: never 5 CONSECUTIVE — the circuit stays closed.
        for (let i = 0; i < 4; i += 1) {
            await expect(breaker.exec(fail)).rejects.toThrow('upstream 503');
        }
        expect(breaker.state).toBe('closed');
        expect(fail).toHaveBeenCalledTimes(8);
    });

    it('half-opens after the cooldown: probe success closes, probe failure re-opens with a fresh cooldown', async () => {
        let nowMs = 0;
        const breaker = new CircuitBreaker({ name: 'cohere', failureThreshold: 2, cooldownMs: 30_000, now: () => nowMs });
        const fail = failing();
        await expect(breaker.exec(fail)).rejects.toThrow('upstream 503');
        await expect(breaker.exec(fail)).rejects.toThrow('upstream 503');
        expect(breaker.state).toBe('open');
        // One tick before the cooldown ends: still short-circuiting, nothing invoked.
        nowMs = 29_999;
        await expect(breaker.exec(fail)).rejects.toBeInstanceOf(CircuitOpenError);
        expect(fail).toHaveBeenCalledTimes(2);
        // Cooldown elapsed: the state reads half_open and ONE probe passes through.
        nowMs = 30_000;
        expect(breaker.state).toBe('half_open');
        await expect(breaker.exec(fail)).rejects.toThrow('upstream 503');
        expect(fail).toHaveBeenCalledTimes(3);
        // Probe failed → re-open with a FRESH cooldown (from 30_000, not the original trip).
        expect(breaker.state).toBe('open');
        nowMs = 59_999;
        await expect(breaker.exec(fail)).rejects.toBeInstanceOf(CircuitOpenError);
        expect(fail).toHaveBeenCalledTimes(3);
        // Second cooldown elapses; a successful probe closes the circuit and traffic flows.
        nowMs = 60_000;
        await expect(breaker.exec(async () => 'recovered')).resolves.toBe('recovered');
        expect(breaker.state).toBe('closed');
        await expect(breaker.exec(async () => 'serving')).resolves.toBe('serving');
    });

    it('rethrows the underlying error unchanged and throws CircuitOpenError with the dependency name when open', async () => {
        const breaker = new CircuitBreaker({ name: 'openemr', failureThreshold: 1, now: () => 0 });
        const boom = new TypeError('typed upstream failure');
        const caught = await breaker.exec(() => Promise.reject(boom)).catch((error: unknown) => error);
        expect(caught).toBe(boom); // the exact same instance — never wrapped
        const open = await breaker.exec(async () => 'x').catch((error: unknown) => error);
        expect(open).toBeInstanceOf(CircuitOpenError);
        expect((open as CircuitOpenError).dependency).toBe('openemr');
        expect((open as CircuitOpenError).name).toBe('CircuitOpenError');
        expect((open as CircuitOpenError).message).toContain('openemr circuit open');
    });

    it('concurrent calls while the half-open probe is in flight short-circuit instead of stampeding', async () => {
        let nowMs = 0;
        const breaker = new CircuitBreaker({ name: 'cohere', failureThreshold: 1, cooldownMs: 1_000, now: () => nowMs });
        await expect(breaker.exec(failing())).rejects.toThrow('upstream 503');
        nowMs = 1_000;
        let release!: () => void;
        const probe = breaker.exec(() => new Promise<string>((resolve) => {
            release = () => resolve('probe ok');
        }));
        // The probe is out but unsettled: a second caller must NOT reach the dependency.
        const second = vi.fn(async () => 'must not run');
        await expect(breaker.exec(second)).rejects.toBeInstanceOf(CircuitOpenError);
        expect(second).not.toHaveBeenCalled();
        release();
        await expect(probe).resolves.toBe('probe ok');
        expect(breaker.state).toBe('closed');
    });
});

describe('breaker composition through the clients (H.10 × H.5)', () => {
    // Guards THE composition rule: the breaker sits OUTSIDE withTimeoutAndRetry, so a
    // transient failure the helper retried (2 fetch attempts) still counts as ONE breaker
    // failure — counting per attempt would trip at half the intended threshold.
    it('a timed-out-and-retried OpenEMR GET counts as ONE breaker failure, and an open circuit stops fetches entirely', async () => {
        const fetchImpl = vi.fn(async () => jsonResponse(500, {})); // 500 = transient → H.5 retries once
        const breaker = new CircuitBreaker({ name: 'openemr', failureThreshold: 2, now: () => 0 });
        const client = new StandardApiClient({ baseUrl: BASE_URL, tokenProvider, fetchImpl, breaker, timeoutMs: 200 });
        const search = { fname: 'Ada', lname: 'Lovelace', DOB: '1990-01-01' };

        await expect(client.searchPatients(search)).rejects.toBeInstanceOf(StandardApiError); // logical call 1
        expect(breaker.state).toBe('closed'); // one failure counted, not two
        await expect(client.searchPatients(search)).rejects.toBeInstanceOf(StandardApiError); // logical call 2 → trips
        expect(breaker.state).toBe('open');
        expect(fetchImpl).toHaveBeenCalledTimes(4); // 2 logical calls × (1 attempt + 1 retry)

        const open = await client.searchPatients(search).catch((error: unknown) => error);
        expect(open).toBeInstanceOf(CircuitOpenError);
        expect((open as CircuitOpenError).dependency).toBe('openemr');
        expect(fetchImpl).toHaveBeenCalledTimes(4); // open circuit: no fetch at all
    });

    // Guards the Anthropic threading: complete() is one logical call through the shared
    // breaker, and an open circuit throws CircuitOpenError fast — the degraded behavior
    // for every caller with a fallback lane (router → fast_path, composer → Week 1 loop).
    it('AnthropicClient.complete trips the shared breaker and short-circuits without calling out once open', async () => {
        const fetchImpl = vi.fn(async () =>
            jsonResponse(401, { error: { type: 'authentication_error', message: 'bad key' } }),
        );
        const breaker = new CircuitBreaker({ name: 'anthropic', failureThreshold: 1, now: () => 0 });
        const client = new AnthropicClient({ apiKey: 'k', model: 'claude-test', fetchImpl, breaker });

        await expect(client.complete('system', [{ role: 'user', content: 'hi' }], 'corr-1')).rejects.toBeInstanceOf(
            AnthropicApiError,
        );
        expect(breaker.state).toBe('open');
        const open = await client
            .complete('system', [{ role: 'user', content: 'hi' }], 'corr-2')
            .catch((error: unknown) => error);
        expect(open).toBeInstanceOf(CircuitOpenError);
        expect((open as CircuitOpenError).dependency).toBe('anthropic');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});
