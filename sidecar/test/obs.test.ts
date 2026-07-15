// Langfuse tracer tests (S2.6): the emitter maps pipeline events onto the SDK surface
// and NEVER lets an observability failure propagate into a prep run.
import { describe, expect, it, vi } from 'vitest';
import {
    LangfuseTracer,
    type LangfuseLike,
    type LangfuseSpanBody,
    type LangfuseSpanLike,
    type LangfuseTraceLike,
} from '../src/obs/langfuse.js';
import type { PrepLogger } from '../src/prep/extraction.js';

const silentLogger: PrepLogger = { info: () => {}, warn: () => {}, error: () => {} };

function fakeLangfuse() {
    const calls: { method: string; body: unknown }[] = [];
    const spanLike: LangfuseSpanLike = { span: () => spanLike };
    const trace: LangfuseTraceLike = {
        span: (body) => {
            calls.push({ method: 'span', body });
            return spanLike;
        },
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
            label: 'doc-mc-001',
            attempt: 1,
            model: 'claude-haiku-4-5',
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
        expect(generation['name']).toBe('doc-mc-001:attempt_1');
        expect(generation['model']).toBe('claude-haiku-4-5');
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
        handle.generation({ label: 'doc-x', attempt: 1, model: 'm', inputTokens: 1, outputTokens: 1, startedAt: new Date(), endedAt: new Date() });
        await expect(handle.end({ status: 'complete' })).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalled(); // failures are logged, not raised
    });
});

// E.4: the graph→Langfuse span adapter. Failure modes guarded: a tracer error eating
// the log line (inner must ALWAYS receive the event), PHI-shaped metadata sneaking into
// spans, per-correlation trace handles duplicating, and — H.7's reason to exist — the
// FLAT sibling span layout: workers must nest as children of ONE supervisor span, and
// sub-calls as children of their worker span (G13; skeleton: docs/w2/trace-example.md).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runClinicalGraph, type AnswerComposer, type ClinicalGraphDeps } from '../src/graph/graph.js';
import { MemoryPinnedEvidenceStore } from '../src/graph/pins.js';
import { VlmExtractor } from '../src/ingest/extractor.js';
import { IngestionService, MemoryIngestionRecordStore } from '../src/ingest/service.js';
import { tracingGraphLogger } from '../src/obs/graphTracer.js';
import type { AnthropicCompletion } from '../src/prep/anthropic.js';
import { HashEmbeddings } from '../src/retrieval/embeddings.js';
import { PassthroughReranker } from '../src/retrieval/rerank.js';
import { HybridRetriever, loadCorpusChunks } from '../src/retrieval/retriever.js';

describe('tracingGraphLogger (E.4)', () => {
    /** What the fake records per span: its name, its parent ('trace' or the parent span's name), the raw body, and whether it was ended. */
    interface SpanRecord {
        name: string;
        parent: string;
        body: Record<string, unknown>;
        ended: boolean;
    }

    // H.7: child-capable fake — every span() returns a LangfuseSpanLike whose own
    // span() records this span's name as the child's parent. The parent chain is the
    // tree the shape tests assert.
    function fakeLangfuse() {
        const traceCalls: Record<string, unknown>[] = [];
        const spans: SpanRecord[] = [];
        const makeSpan =
            (parent: string) =>
            (body: LangfuseSpanBody): LangfuseSpanLike => {
                const record: SpanRecord = { name: body.name, parent, body: { ...body }, ended: false };
                spans.push(record);
                return {
                    span: makeSpan(body.name),
                    end: () => {
                        record.ended = true;
                    },
                };
            };
        const client: LangfuseLike = {
            trace: (body) => {
                traceCalls.push({ ...body });
                return {
                    span: makeSpan('trace'),
                    generation: () => undefined,
                    score: () => undefined,
                    update: () => undefined,
                };
            },
            flushAsync: async () => undefined,
        };
        return { client, traceCalls, spans };
    }

    const parentOf = (spans: SpanRecord[], name: string): string | undefined =>
        spans.find((span) => span.name === name)?.parent;

    function recordingInner() {
        const lines: string[] = [];
        return {
            lines,
            logger: {
                info: (_obj: Record<string, unknown>, msg: string) => lines.push(`info:${msg}`),
                warn: (_obj: Record<string, unknown>, msg: string) => lines.push(`warn:${msg}`),
            },
        };
    }

    // The five verbatim Run-1 log lines committed in docs/w2/trace-example.md
    // (`w2-demo-7f3a`) — the span skeleton the adapter must render as a tree.
    const RUN1: { obj: Record<string, unknown>; msg: string }[] = [
        {
            msg: 'worker_handoff',
            obj: { correlation_id: 'w2-demo-7f3a', patient_id: 'margaret-chen', from: 'supervisor', to: 'intake_extractor', routing_reason: 'document upload event (rule)' },
        },
        {
            msg: 'worker_handoff',
            obj: { correlation_id: 'w2-demo-7f3a', patient_id: 'margaret-chen', from: 'intake_extractor', to: 'evidence_retriever', routing_reason: 'extraction complete; pin protocol evidence for extracted findings' },
        },
        {
            msg: 'evidence_pinned',
            obj: { correlation_id: 'w2-demo-7f3a', patient_id: 'margaret-chen', ingestion_id: 'ing-fbc0385ca41a', pinned: 4 },
        },
        {
            msg: 'worker_handoff',
            obj: { correlation_id: 'w2-demo-7f3a', patient_id: 'margaret-chen', from: 'evidence_retriever', to: 'critic', routing_reason: '4 chunk(s), rerank_applied=false' },
        },
        {
            msg: 'worker_handoff',
            obj: { correlation_id: 'w2-demo-7f3a', patient_id: 'margaret-chen', from: 'critic', to: 'answer', routing_reason: '1 verified / 0 blocked claim(s); 0 lint flag(s)' },
        },
    ];

    it('opens ONE trace per correlation id and maps worker_handoff events to spans', () => {
        const { client, traceCalls, spans } = fakeLangfuse();
        const { logger: inner } = recordingInner();
        const traced = tracingGraphLogger(inner, client, { warn: () => undefined });
        traced.info({ correlation_id: 'corr-1', from: 'supervisor', to: 'evidence_retriever', routing_reason: 'asks for guideline/protocol (rule)' }, 'worker_handoff');
        traced.info({ correlation_id: 'corr-1', from: 'evidence_retriever', to: 'critic', routing_reason: '4 chunk(s)' }, 'worker_handoff');
        expect(traceCalls).toHaveLength(1);
        expect(traceCalls[0]).toMatchObject({ id: 'corr-1', name: 'graph' });
        // H.7: node-named spans (one per worker + one supervisor), not from→to pairs.
        expect(spans.map((span) => span.name)).toEqual(['supervisor', 'evidence_retriever', 'critic']);
        expect(spans.map((span) => span.parent)).toEqual(['trace', 'supervisor', 'supervisor']);
    });

    // H.7: THE shape this ticket exists for. Before H.7 the adapter emitted every
    // handoff as a flat trace-level sibling; G13 requires the tree.
    it('nests worker spans inside the supervisor span — the flat sibling layout is the G13 regression this guards', () => {
        const { client, traceCalls, spans } = fakeLangfuse();
        const traced = tracingGraphLogger(undefined, client, { warn: () => undefined });
        for (const line of RUN1) {
            traced.info(line.obj, line.msg);
        }
        expect(traceCalls).toHaveLength(1); // one trace, id = the correlation id
        expect(traceCalls[0]).toMatchObject({ id: 'w2-demo-7f3a', name: 'graph' });
        expect(parentOf(spans, 'supervisor')).toBe('trace');
        for (const worker of ['intake_extractor', 'evidence_retriever', 'critic', 'answer']) {
            // A flat layout (parent 'trace') must fail here.
            expect(parentOf(spans, worker), `${worker} must be a child of the supervisor span`).toBe('supervisor');
        }
        expect(parentOf(spans, 'evidence_pinned')).toBe('evidence_retriever');
        // A handoff FROM a worker closes that worker's span; supervisor and the terminal
        // answer span have no closing event and stay open.
        expect(spans.filter((span) => span.ended).map((span) => span.name)).toEqual(['intake_extractor', 'evidence_retriever', 'critic']);
    });

    it('attaches evidence_pinned and evidence_degraded as children of the evidence_retriever span, critic_flags under critic', () => {
        const { client, spans } = fakeLangfuse();
        const traced = tracingGraphLogger(undefined, client, { warn: () => undefined });
        traced.info({ correlation_id: 'corr-sub', from: 'supervisor', to: 'evidence_retriever', routing_reason: 'asks for guideline/protocol (rule)' }, 'worker_handoff');
        traced.warn({ correlation_id: 'corr-sub', budget_ms: 5000 }, 'evidence_degraded');
        traced.info({ correlation_id: 'corr-sub', patient_id: 'pt-1', ingestion_id: 'ing-abc', pinned: 4 }, 'evidence_pinned');
        traced.info({ correlation_id: 'corr-sub', from: 'evidence_retriever', to: 'critic', routing_reason: '4 chunk(s)' }, 'worker_handoff');
        traced.warn({ correlation_id: 'corr-sub', blocked: 2, prescriptive_flags: 1 }, 'critic_flags');
        // G13's "sub-calls ⊂ worker": retrieval events under evidence_retriever, gate
        // flags under critic — never flat on the trace.
        expect(parentOf(spans, 'evidence_degraded')).toBe('evidence_retriever');
        expect(parentOf(spans, 'evidence_pinned')).toBe('evidence_retriever');
        expect(parentOf(spans, 'critic_flags')).toBe('critic');
        expect(spans.find((span) => span.name === 'evidence_degraded')!.body).toMatchObject({ level: 'WARNING', metadata: { budget_ms: 5000 } });
        expect(spans.find((span) => span.name === 'critic_flags')!.body).toMatchObject({ level: 'WARNING', metadata: { blocked: 2, prescriptive_flags: 1 } });
    });

    // H.7 step-3 fence: ingestion stage events nest under intake_extractor when the
    // graph opened a trace for that correlation id, but a route-path ingestion (no
    // graph run) stays log-only — the adapter must never open a trace for it.
    it('nests ingestion stage events under intake_extractor and stays log-only without a graph trace', () => {
        const { client, traceCalls, spans } = fakeLangfuse();
        const { lines, logger: inner } = recordingInner();
        const traced = tracingGraphLogger(inner, client, { warn: () => undefined });
        // Route-path ingestion: no graph events for this correlation id → no trace.
        traced.info({ correlation_id: 'corr-route-only', ingestion_id: 'ing-r', patient_id: 'pt-1', stage: 'extracting' }, 'ingestion_extracting');
        expect(traceCalls).toHaveLength(0);
        expect(spans).toHaveLength(0);
        expect(lines).toContain('info:ingestion_extracting'); // log-only still means logged
        // Graph-run ingestion: the supervisor handed off to intake_extractor first.
        traced.info({ correlation_id: 'corr-g', from: 'supervisor', to: 'intake_extractor', routing_reason: 'document upload event (rule)' }, 'worker_handoff');
        traced.info({ correlation_id: 'corr-g', ingestion_id: 'ing-g', patient_id: 'pt-1', stage: 'grounded', detail: '9 word_box / 0 page / 0 unverified' }, 'ingestion_grounded');
        traced.info({ correlation_id: 'corr-g', ingestion_id: 'ing-g', doc_type: 'lab_pdf', field: 'results[0]', outcome: 'word_box' }, 'extraction_field_outcome');
        expect(parentOf(spans, 'ingestion_grounded')).toBe('intake_extractor');
        expect(parentOf(spans, 'extraction_field_outcome')).toBe('intake_extractor');
        // Stage `detail` can carry error text / printed identity — it must never enter
        // span metadata (ids and labels only).
        expect(Object.keys(spans.find((span) => span.name === 'ingestion_grounded')!.body['metadata'] as Record<string, unknown>)).toEqual(['ingestion_id']);
        expect(spans.find((span) => span.name === 'extraction_field_outcome')!.body['metadata']).toEqual({ ingestion_id: 'ing-g', field: 'results[0]', outcome: 'word_box' });
    });

    it('ALWAYS forwards events to the inner logger, even when the SDK throws everywhere', () => {
        const broken = {
            trace: () => {
                throw new Error('langfuse down');
            },
            flushAsync: async () => undefined,
        };
        const warnings: string[] = [];
        const { lines, logger: inner } = recordingInner();
        const traced = tracingGraphLogger(inner, broken, { warn: (_obj, msg) => warnings.push(msg) });
        traced.info({ correlation_id: 'corr-2', from: 'supervisor', to: 'critic', routing_reason: 'x' }, 'worker_handoff');
        traced.warn({ correlation_id: 'corr-2', blocked: 1, prescriptive_flags: 0 }, 'critic_flags');
        expect(lines).toEqual(['info:worker_handoff', 'warn:critic_flags']);

        // H.7's nested paths blow up too: the trace opens but every span() throws…
        const spanBomb: LangfuseLike = {
            trace: () => ({
                span: () => {
                    throw new Error('span down');
                },
                generation: () => undefined,
                score: () => undefined,
                update: () => undefined,
            }),
            flushAsync: async () => undefined,
        };
        const bombed = recordingInner();
        const tracedBomb = tracingGraphLogger(bombed.logger, spanBomb, { warn: (_obj, msg) => warnings.push(msg) });
        for (const line of RUN1) {
            tracedBomb.info(line.obj, line.msg);
        }
        expect(bombed.lines).toHaveLength(RUN1.length);

        // …and a worker span whose end() throws must not take the next handoff down.
        const endBomb: LangfuseLike = {
            trace: () => {
                const span: LangfuseSpanLike = {
                    span: () => span,
                    end: () => {
                        throw new Error('end down');
                    },
                };
                return { span: () => span, generation: () => undefined, score: () => undefined, update: () => undefined };
            },
            flushAsync: async () => undefined,
        };
        const ended = recordingInner();
        const tracedEnd = tracingGraphLogger(ended.logger, endBomb, { warn: (_obj, msg) => warnings.push(msg) });
        tracedEnd.info({ correlation_id: 'corr-4', from: 'supervisor', to: 'intake_extractor', routing_reason: 'r' }, 'worker_handoff');
        tracedEnd.info({ correlation_id: 'corr-4', from: 'intake_extractor', to: 'evidence_retriever', routing_reason: 'r' }, 'worker_handoff');
        expect(ended.lines).toEqual(['info:worker_handoff', 'info:worker_handoff']);
        expect(warnings.every((msg) => msg === 'langfuse graph emit failed')).toBe(true);
    });

    it('maps degraded/critic events to WARNING spans carrying ids and counts only', () => {
        const { client, spans } = fakeLangfuse();
        const traced = tracingGraphLogger(undefined, client, { warn: () => undefined });
        traced.warn({ correlation_id: 'corr-3', budget_ms: 5000 }, 'evidence_degraded');
        traced.warn({ correlation_id: 'corr-3', blocked: 2, prescriptive_flags: 1 }, 'critic_flags');
        traced.info({ correlation_id: 'corr-3', patient_id: 'pt-1', ingestion_id: 'ing-abc', pinned: 4 }, 'evidence_pinned');
        expect(spans[0]!.body).toMatchObject({ name: 'evidence_degraded', level: 'WARNING', metadata: { budget_ms: 5000 } });
        expect(spans[1]!.body).toMatchObject({ name: 'critic_flags', level: 'WARNING', metadata: { blocked: 2, prescriptive_flags: 1 } });
        expect(spans[2]!.body).toMatchObject({ name: 'evidence_pinned', metadata: { ingestion_id: 'ing-abc', pinned: 4 } });
        const metadataKeys = spans.flatMap((span) => Object.keys(span.body['metadata'] as Record<string, unknown>));
        expect(metadataKeys.every((key) => ['budget_ms', 'blocked', 'prescriptive_flags', 'ingestion_id', 'pinned', 'routing_reason'].includes(key))).toBe(true);
    });

    // ——— H.7 integration leg: the REAL graph (LangGraph wiring, real retriever over the
    // committed corpus, stubbed VLM) must produce the nested tree, and tracing must
    // never eat a log line. Assembly copied (trimmed) from test/graph.test.ts makeDeps.
    const CORPUS = fileURLToPath(new URL('../corpus/', import.meta.url));
    const FIXTURES = fileURLToPath(new URL('../eval/fixtures/documents/', import.meta.url));

    const LAB_JSON = JSON.stringify({
        doc_type: 'lab_pdf',
        document_patient: null,
        performing_lab: null,
        collection_date: '2024-12-20',
        collection_date_citation: null,
        results: [{ test_name: 'eGFR', value: '42', value_numeric: 42, unit: null, reference_range: null, abnormal_flag: 'low', citation: { page: 1, bbox: null, quote: 'eGFR (CKD-EPI) 42', grounding: 'page' } }],
    });

    async function makeGraphDeps(): Promise<{ deps: ClinicalGraphDeps; logs: string[] }> {
        const logs: string[] = [];
        const retriever = await HybridRetriever.build(loadCorpusChunks(CORPUS), {
            embeddings: new HashEmbeddings(),
            reranker: new PassthroughReranker(),
        });
        const vlm = {
            complete: vi.fn(async (): Promise<AnthropicCompletion> => ({
                text: LAB_JSON, citations: [], tool_uses: [], usage: { input_tokens: 100, output_tokens: 50 }, stop_reason: 'end_turn', model: 'stub',
            })),
        };
        const ingestion = new IngestionService({ extractor: new VlmExtractor(vlm), records: new MemoryIngestionRecordStore() });
        // Claims-free composer: claim verification is the citation gate's concern
        // (graph.test.ts); this file pins the span tree only.
        const composer: AnswerComposer = {
            compose: async () => ({ text: 'No practice protocol on file covers this question.', claims: [] }),
        };
        const deps: ClinicalGraphDeps = {
            retriever,
            ingestion,
            composer,
            pins: new MemoryPinnedEvidenceStore(), // so the upload run emits evidence_pinned (C.6)
            logger: {
                info: (obj, msg) => logs.push(`${msg}:${JSON.stringify(obj)}`),
                warn: (obj, msg) => logs.push(`${msg}:${JSON.stringify(obj)}`),
            },
        };
        return { deps, logs };
    }

    it('a real graph run produces the nested tree and still delivers every line to the inner logger', async () => {
        const { deps, logs } = await makeGraphDeps();
        const { client, traceCalls, spans } = fakeLangfuse();
        const traced: ClinicalGraphDeps = { ...deps, logger: tracingGraphLogger(deps.logger, client, { warn: () => undefined }) };
        const renalPdf = new Uint8Array(readFileSync(`${FIXTURES}renal-panel-clean.pdf`));
        const outcome = await runClinicalGraph(
            traced,
            {
                kind: 'document_upload',
                patientId: 'margaret-chen',
                upload: { docType: 'lab_pdf', filename: 'renal.pdf', mimeType: 'application/pdf', bytes: renalPdf },
                concepts: ['hydroxychloroquine screening', 'reduced eGFR renal impairment'],
            },
            'corr-h7-tree',
        );
        expect(outcome.route).toBe('needs_extraction');
        expect(outcome.ingestion?.status).toBe('complete');
        // The tree G13 requires: workers ⊂ supervisor ⊂ trace; retrieval sub-call ⊂ its worker.
        expect(traceCalls).toHaveLength(1);
        expect(traceCalls[0]).toMatchObject({ id: 'corr-h7-tree', name: 'graph' });
        expect(parentOf(spans, 'supervisor')).toBe('trace');
        for (const worker of ['intake_extractor', 'evidence_retriever', 'critic', 'answer']) {
            expect(parentOf(spans, worker), `${worker} must be a child of the supervisor span`).toBe('supervisor');
        }
        expect(parentOf(spans, 'evidence_pinned')).toBe('evidence_retriever');
        // Tracing never eats a log line: every handoff the graph made reached the inner logger.
        expect(outcome.handoffs).toHaveLength(4);
        expect(logs.filter((line) => line.startsWith('worker_handoff:'))).toHaveLength(4);
        expect(logs.some((line) => line.startsWith('evidence_pinned:'))).toBe(true);
        // PHI fence (G18/P5): span payloads carry ids/counts/rule labels — never the
        // question text or extracted values (the stubbed lab extraction contains 'eGFR').
        expect(JSON.stringify(spans.map((span) => span.body))).not.toContain('eGFR');
    });
});
