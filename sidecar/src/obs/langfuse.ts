// Langfuse tracing for the prep pipeline (S2.6): one trace per run keyed by the
// correlation ID, a span per stage, a generation per Anthropic attempt, and outcome
// scores. Every emit is wrapped — observability failure must NEVER fail a prep run.
import type { PrepLogger } from '../prep/extraction.js';

/** The Langfuse SDK surface we consume (the real Langfuse client satisfies it; tests fake it). */
export interface LangfuseLike {
    trace(body: {
        id?: string;
        name?: string;
        metadata?: Record<string, unknown>;
        tags?: string[];
    }): LangfuseTraceLike;
    flushAsync(): Promise<unknown>;
}

/** The body accepted by every span-creating call (trace-level and nested). */
export interface LangfuseSpanBody {
    name: string;
    startTime?: Date;
    endTime?: Date;
    metadata?: Record<string, unknown>;
    level?: 'DEBUG' | 'DEFAULT' | 'WARNING' | 'ERROR';
    statusMessage?: string;
}

/**
 * A child-capable span client (H.7): `.span()` nests a child span, `.end()` closes it.
 * The real langfuse SDK's span client structurally satisfies this — note its
 * `end(body?)` omits `endTime` from the body (the SDK stamps the end time itself),
 * so the seam takes no arguments; callers use `.end?.()`.
 */
export interface LangfuseSpanLike {
    span(body: LangfuseSpanBody): LangfuseSpanLike;
    end?(): unknown;
}

export interface LangfuseTraceLike {
    span(body: LangfuseSpanBody): LangfuseSpanLike;
    generation(body: {
        name: string;
        model?: string;
        startTime?: Date;
        endTime?: Date;
        usage?: { input?: number; output?: number };
        metadata?: Record<string, unknown>;
    }): unknown;
    score(body: { name: string; value: number }): unknown;
    update(body: { output?: unknown; metadata?: Record<string, unknown> }): unknown;
}

export interface PrepTraceContext {
    correlationId: string;
    patientId: string;
    prepRunId: string;
}

export interface StageRecord {
    name: string;
    startedAt: Date;
    durationMs: number;
}

export interface GenerationRecord {
    /** Which call this was: a document id or 'contradictions'. */
    label: string;
    attempt: number;
    model: string;
    inputTokens: number;
    outputTokens: number;
    startedAt: Date;
    endedAt: Date;
}

export interface PrepOutcome {
    status: 'complete' | 'failed';
    error?: string;
    gateMetrics?: { claims: number; verified: number; blocked: number; citationsChecked: number; citationsFailed: number };
}

/** The pipeline's tracing surface (LangfuseTracer satisfies it; tests fake it). */
export interface PrepTracer {
    startTrace(ctx: PrepTraceContext): PrepTraceHandle;
}

export interface PrepTraceHandle {
    stage(record: StageRecord): void;
    generation(record: GenerationRecord): void;
    /** Final write + flush. Must be awaited last — after this the handle is dead. */
    end(outcome: PrepOutcome): Promise<void>;
}

export class LangfuseTracer implements PrepTracer {
    constructor(
        private readonly client: LangfuseLike,
        private readonly logger: PrepLogger,
    ) {}

    startTrace(ctx: PrepTraceContext): PrepTraceHandle {
        const { client, logger } = this;
        let trace: LangfuseTraceLike | undefined;
        try {
            trace = client.trace({
                id: ctx.correlationId, // the joining key across logs, prep_runs, llm_calls, and traces
                name: 'prep',
                metadata: { patientId: ctx.patientId, prepRunId: ctx.prepRunId },
                tags: ['prep'],
            });
        } catch (error) {
            logger.warn({ correlationId: ctx.correlationId, err: String(error) }, 'langfuse trace open failed');
        }
        const guarded = (what: string, fn: () => void): void => {
            try {
                fn();
            } catch (error) {
                logger.warn({ correlationId: ctx.correlationId, what, err: String(error) }, 'langfuse emit failed');
            }
        };
        return {
            stage: (record) =>
                guarded('span', () =>
                    trace?.span({
                        name: record.name,
                        startTime: record.startedAt,
                        endTime: new Date(record.startedAt.getTime() + record.durationMs),
                        metadata: { durationMs: record.durationMs },
                    }),
                ),
            generation: (record) =>
                guarded('generation', () =>
                    trace?.generation({
                        name: `${record.label}:attempt_${record.attempt}`,
                        model: record.model,
                        startTime: record.startedAt,
                        endTime: record.endedAt,
                        usage: { input: record.inputTokens, output: record.outputTokens },
                        metadata: { label: record.label, attempt: record.attempt },
                    }),
                ),
            end: async (outcome) => {
                guarded('outcome', () => {
                    trace?.update({
                        output:
                            outcome.status === 'complete'
                                ? { status: outcome.status, gateMetrics: outcome.gateMetrics }
                                : { status: outcome.status, error: outcome.error },
                    });
                    trace?.score({ name: 'run_success', value: outcome.status === 'complete' ? 1 : 0 });
                    if (outcome.gateMetrics !== undefined) {
                        trace?.score({ name: 'citations_failed', value: outcome.gateMetrics.citationsFailed });
                        trace?.score({ name: 'facts_blocked', value: outcome.gateMetrics.blocked });
                    }
                });
                try {
                    await client.flushAsync();
                } catch (error) {
                    logger.warn({ correlationId: ctx.correlationId, err: String(error) }, 'langfuse flush failed');
                }
            },
        };
    }
}
