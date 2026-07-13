// E.4 (REQ R7, G13, G15): the graph→Langfuse span adapter. An ADAPTER over the existing
// event stream, not new instrumentation — the graph's logger seam already emits
// everything the span hierarchy needs (worker_handoff, evidence_pinned,
// evidence_degraded, critic_flags; committed skeleton: docs/w2/trace-example.md).
// The trace id IS the correlation id — the joining key across logs, prep_runs,
// llm_calls, and traces. Guarded throughout: observability may NEVER fail a run
// (same rule as LangfuseTracer).
import type { GraphLogger } from '../graph/graph.js';
import type { LangfuseLike, LangfuseTraceLike } from './langfuse.js';

interface WarnLogger {
    warn(obj: Record<string, unknown>, msg: string): void;
}

// Bounded FIFO of open traces by correlation id — long-lived processes must not
// accumulate handles (eviction idiom mirrors MemoryUploadFileStore).
const MAX_OPEN_TRACES = 64;

function str(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

/**
 * Decorates a GraphLogger: every event still reaches `inner` unchanged (tracing must
 * never eat the log line); graph events additionally become Langfuse spans on a
 * correlation-scoped trace. Metadata carries ids and counts ONLY — never question
 * text, snippet text, or patient values (G18/P5; routing_reason is a rule label).
 */
export function tracingGraphLogger(inner: GraphLogger | undefined, client: LangfuseLike, log: WarnLogger): GraphLogger {
    const traces = new Map<string, LangfuseTraceLike>();

    const guarded = (correlationId: string, what: string, fn: () => void): void => {
        try {
            fn();
        } catch (error) {
            log.warn({ correlationId, what, err: String(error) }, 'langfuse graph emit failed');
        }
    };

    const traceFor = (correlationId: string): LangfuseTraceLike | undefined => {
        const existing = traces.get(correlationId);
        if (existing !== undefined) {
            return existing;
        }
        let opened: LangfuseTraceLike | undefined;
        guarded(correlationId, 'trace_open', () => {
            opened = client.trace({ id: correlationId, name: 'graph', tags: ['graph'] });
        });
        if (opened !== undefined) {
            traces.set(correlationId, opened);
            while (traces.size > MAX_OPEN_TRACES) {
                const oldest = traces.keys().next().value;
                if (oldest === undefined) {
                    break;
                }
                traces.delete(oldest);
            }
        }
        return opened;
    };

    const emit = (obj: Record<string, unknown>, msg: string): void => {
        const correlationId = str(obj['correlation_id']);
        if (correlationId === undefined) {
            return; // not a graph event — log-only
        }
        const trace = traceFor(correlationId);
        if (trace === undefined) {
            return;
        }
        guarded(correlationId, msg, () => {
            switch (msg) {
                case 'worker_handoff':
                    trace.span({
                        name: `${str(obj['from']) ?? '?'}→${str(obj['to']) ?? '?'}`,
                        startTime: new Date(),
                        metadata: { routing_reason: str(obj['routing_reason']) ?? '' },
                    });
                    return;
                case 'evidence_pinned':
                    trace.span({
                        name: 'evidence_pinned',
                        metadata: { ingestion_id: str(obj['ingestion_id']) ?? '', pinned: obj['pinned'] ?? 0 },
                    });
                    return;
                case 'evidence_degraded':
                    trace.span({
                        name: 'evidence_degraded',
                        level: 'WARNING',
                        metadata: { budget_ms: obj['budget_ms'] ?? 0 },
                    });
                    return;
                case 'critic_flags':
                    trace.span({
                        name: 'critic_flags',
                        level: 'WARNING',
                        metadata: { blocked: obj['blocked'] ?? 0, prescriptive_flags: obj['prescriptive_flags'] ?? 0 },
                    });
                    return;
                default:
                    return; // unknown graph event — log-only until a span mapping is decided
            }
        });
    };

    return {
        info: (obj, msg) => {
            inner?.info(obj, msg);
            emit(obj, msg);
        },
        warn: (obj, msg) => {
            inner?.warn(obj, msg);
            emit(obj, msg);
        },
    };
}
