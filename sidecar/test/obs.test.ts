// Langfuse tracer tests (S2.6): the emitter maps pipeline events onto the SDK surface
// and NEVER lets an observability failure propagate into a prep run.
import { describe, expect, it, vi } from 'vitest';
import { LangfuseTracer, type LangfuseLike, type LangfuseTraceLike } from '../src/obs/langfuse.js';
import type { PrepLogger } from '../src/prep/extraction.js';

const silentLogger: PrepLogger = { info: () => {}, warn: () => {}, error: () => {} };

function fakeLangfuse() {
    const calls: { method: string; body: unknown }[] = [];
    const trace: LangfuseTraceLike = {
        span: (body) => calls.push({ method: 'span', body }),
        generation: (body) => calls.push({ method: 'generation', body }),
        score: (body) => calls.push({ method: 'score', body }),
        update: (body) => calls.push({ method: 'update', body }),
    };
    const flushAsync = vi.fn(async () => undefined);
    const client: LangfuseLike = {
        trace: (body) => {
            calls.push({ method: 'trace', body });
            return trace;
        },
        flushAsync,
    };
    return { client, calls, flushAsync };
}

const CTX = { correlationId: 'corr-t', patientId: 'margaret-chen', prepRunId: 'run-9' };

describe('LangfuseTracer', () => {
    // Guards: the trace contract — correlation ID as trace id (the cross-store joining
    // key), spans carrying real times, generations carrying token usage, outcome scores.
    it('maps stages, generations, and a successful outcome onto the SDK', async () => {
        const { client, calls, flushAsync } = fakeLangfuse();
        const handle = new LangfuseTracer(client, silentLogger).startTrace(CTX);
        const startedAt = new Date('2026-07-08T12:00:00Z');
        handle.stage({ name: 'llm_extraction', startedAt, durationMs: 1500 });
        handle.generation({
            attempt: 1,
            model: 'claude-sonnet-5',
            inputTokens: 14000,
            outputTokens: 22000,
            startedAt,
            endedAt: new Date(startedAt.getTime() + 1400),
        });
        await handle.end({
            status: 'complete',
            gateMetrics: { claims: 10, verified: 9, blocked: 1, citationsChecked: 12, citationsFailed: 0 },
        });

        expect(calls[0]).toEqual({
            method: 'trace',
            body: { id: 'corr-t', name: 'prep', metadata: { patientId: 'margaret-chen', prepRunId: 'run-9' }, tags: ['prep'] },
        });
        const span = calls.find((c) => c.method === 'span')!.body as Record<string, unknown>;
        expect(span['name']).toBe('llm_extraction');
        expect(span['endTime']).toEqual(new Date(startedAt.getTime() + 1500));
        const generation = calls.find((c) => c.method === 'generation')!.body as Record<string, unknown>;
        expect(generation['model']).toBe('claude-sonnet-5');
        expect(generation['usage']).toEqual({ input: 14000, output: 22000 });
        const scores = calls.filter((c) => c.method === 'score').map((c) => c.body);
        expect(scores).toContainEqual({ name: 'run_success', value: 1 });
        expect(scores).toContainEqual({ name: 'citations_failed', value: 0 });
        expect(scores).toContainEqual({ name: 'facts_blocked', value: 1 });
        expect(flushAsync).toHaveBeenCalledTimes(1);
    });

    // Guards: a failed run's trace carrying the error and a zero success score.
    it('records a failed outcome with the error message', async () => {
        const { client, calls } = fakeLangfuse();
        const handle = new LangfuseTracer(client, silentLogger).startTrace(CTX);
        await handle.end({ status: 'failed', error: 'boom at llm_extraction' });
        const update = calls.find((c) => c.method === 'update')!.body as Record<string, unknown>;
        expect(update['output']).toEqual({ status: 'failed', error: 'boom at llm_extraction' });
        const scores = calls.filter((c) => c.method === 'score').map((c) => c.body);
        expect(scores).toContainEqual({ name: 'run_success', value: 0 });
    });

    // Guards: THE invariant — observability failure must never fail the prep run.
    // Every SDK surface throws; the handle must swallow all of it.
    it('never throws when the SDK throws at every call site', async () => {
        const explosive: LangfuseLike = {
            trace: () => {
                throw new Error('trace down');
            },
            flushAsync: async () => {
                throw new Error('flush down');
            },
        };
        const warn = vi.fn();
        const handle = new LangfuseTracer(explosive, { ...silentLogger, warn }).startTrace(CTX);
        handle.stage({ name: 's', startedAt: new Date(), durationMs: 1 });
        handle.generation({ attempt: 1, model: 'm', inputTokens: 1, outputTokens: 1, startedAt: new Date(), endedAt: new Date() });
        await expect(handle.end({ status: 'complete' })).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalled(); // failures are logged, not raised
    });
});
