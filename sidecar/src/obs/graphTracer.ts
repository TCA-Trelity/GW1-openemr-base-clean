// E.4 (REQ R7, G13, G15): the graph→Langfuse span adapter. An ADAPTER over the existing
// event stream, not new instrumentation — the graph's logger seam already emits
// everything the span hierarchy needs (worker_handoff, evidence_pinned,
// evidence_degraded, critic_flags; committed skeleton: docs/w2/trace-example.md).
// The trace id IS the correlation id — the joining key across logs, prep_runs,
// llm_calls, and traces. Guarded throughout: observability may NEVER fail a run
// (same rule as LangfuseTracer).
//
// H.7 (REQ G13, S3/R4): spans NEST — one `supervisor` span per trace, every worker
// (`intake_extractor`, `evidence_retriever`, `critic`, `answer`) a child of it, and
// sub-call events children of their worker span (`evidence_pinned`/`evidence_degraded`
// under `evidence_retriever`, `critic_flags` under `critic`, ingestion stage events
// under `intake_extractor`). A flat sibling layout is the G13 regression the shape
// tests in test/obs.test.ts guard against.
import type { GraphLogger } from '../graph/graph.js';
import type { LangfuseLike, LangfuseSpanLike, LangfuseTraceLike } from './langfuse.js';

interface WarnLogger {
    warn(obj: Record<string, unknown>, msg: string): void;
}

// Bounded FIFO of open traces by correlation id — long-lived processes must not
// accumulate handles (eviction idiom mirrors MemoryUploadFileStore).
const MAX_OPEN_TRACES = 64;

// The four graph events lazily OPEN a trace; everything else (ingestion stage events,
// unknown events) is look-up-only — a route-path ingestion without a graph run must
// never open a trace of its own.
const GRAPH_EVENTS = new Set(['worker_handoff', 'evidence_pinned', 'evidence_degraded', 'critic_flags']);

/** Per-correlation trace state: the trace, its single supervisor span, worker spans by node name. */
interface OpenTrace {
    trace: LangfuseTraceLike;
    supervisor?: LangfuseSpanLike;
    nodes: Map<string, LangfuseSpanLike>;
}

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
    const traces = new Map<string, OpenTrace>();

    const guarded = (correlationId: string, what: string, fn: () => void): void => {
        try {
            fn();
        } catch (error) {
            log.warn({ correlationId, what, err: String(error) }, 'langfuse graph emit failed');
        }
    };

    const traceFor = (correlationId: string): OpenTrace | undefined => {
        const existing = traces.get(correlationId);
        if (existing !== undefined) {
            return existing;
        }
        let opened: OpenTrace | undefined;
        guarded(correlationId, 'trace_open', () => {
            opened = { trace: client.trace({ id: correlationId, name: 'graph', tags: ['graph'] }), nodes: new Map() };
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
            return; // not a correlation-scoped event — log-only
        }
        const ingestionEvent = msg.startsWith('ingestion_') || msg === 'extraction_field_outcome';
        const open = ingestionEvent
            ? traces.get(correlationId) // look-up-only: no graph trace → log-only
            : GRAPH_EVENTS.has(msg)
              ? traceFor(correlationId)
              : undefined;
        if (open === undefined) {
            return;
        }
        guarded(correlationId, msg, () => {
            if (ingestionEvent) {
                // G13's "sub-calls ⊂ worker": extraction stage events ride under the
                // intake_extractor span. Metadata = ids and labels only — never `detail`
                // (stage detail can carry error text / printed patient identity).
                const parent = open.nodes.get('intake_extractor') ?? open.supervisor ?? open.trace;
                parent.span({
                    name: msg,
                    metadata:
                        msg === 'extraction_field_outcome'
                            ? {
                                  ingestion_id: str(obj['ingestion_id']) ?? '',
                                  field: str(obj['field']) ?? '',
                                  outcome: str(obj['outcome']) ?? '',
                              }
                            : { ingestion_id: str(obj['ingestion_id']) ?? '' },
                });
                return;
            }
            switch (msg) {
                case 'worker_handoff': {
                    const from = str(obj['from']) ?? '?';
                    const to = str(obj['to']) ?? '?';
                    const routing_reason = str(obj['routing_reason']) ?? '';
                    if (from === 'supervisor') {
                        // The supervisor span opens once per trace, stamped with its routing decision.
                        open.supervisor ??= open.trace.span({ name: 'supervisor', startTime: new Date(), metadata: { routing_reason } });
                    } else {
                        // A handoff FROM a worker closes that worker's span.
                        open.nodes.get(from)?.end?.();
                        // Defensive: even a stream missing the supervisor handoff nests
                        // workers under one supervisor span — never flat siblings (G13).
                        open.supervisor ??= open.trace.span({ name: 'supervisor', startTime: new Date() });
                    }
                    // All graph nodes are workers ⊂ supervisor (the tree in trace-example.md).
                    open.nodes.set(to, open.supervisor.span({ name: to, startTime: new Date(), metadata: { routing_reason } }));
                    return;
                }
                case 'evidence_pinned':
                    (open.nodes.get('evidence_retriever') ?? open.supervisor ?? open.trace).span({
                        name: 'evidence_pinned',
                        metadata: { ingestion_id: str(obj['ingestion_id']) ?? '', pinned: obj['pinned'] ?? 0 },
                    });
                    return;
                case 'evidence_degraded':
                    (open.nodes.get('evidence_retriever') ?? open.supervisor ?? open.trace).span({
                        name: 'evidence_degraded',
                        level: 'WARNING',
                        metadata: { budget_ms: obj['budget_ms'] ?? 0 },
                    });
                    return;
                case 'critic_flags':
                    (open.nodes.get('critic') ?? open.supervisor ?? open.trace).span({
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
