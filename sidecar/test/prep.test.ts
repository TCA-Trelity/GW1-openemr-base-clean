// Prep pipeline tests (S1.7): mocked-LLM fixtures built FROM the Margaret Chen seed
// corpus (so citations resolve against real document text) + an in-memory FactStore
// double — no Postgres, no live Anthropic. Each test names the failure mode it guards.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { AnthropicClient, type FetchLike } from '../src/prep/anthropic.js';
import { BriefContentSchema } from '../src/prep/brief.js';
import { BudgetExceededError, type LlmCallRecord, type UsageSummary } from '../src/prep/budget.js';
import { ExtractionError, FactExtractor, type PrepLogger } from '../src/prep/extraction.js';
import { runPrep, type PrepDeps } from '../src/prep/pipeline.js';
import {
    FhirDocumentSource,
    StoreDocumentSource,
    type FhirReader,
    type SourceDocumentQuerier,
} from '../src/prep/sources.js';
import type { PrepRouteDeps, PrepRouteSpendGuard, PrepRouteStore } from '../src/routes/prep.js';
import { ContradictionSchema, projectContradiction } from '../src/schemas/index.js';
import { buildDeps, buildServer, type AppDeps } from '../src/server.js';
import { FactStore, type BriefInput, type FactBundle, type PrepRunStatus, type StoredBrief, type StoredPrepRun } from '../src/store/index.js';

// The corpus is trusted fixture data; test/corpus-conformance.test.ts locks its schema.
const corpus = JSON.parse(
    readFileSync(new URL('../seed/margaret-chen.json', import.meta.url), 'utf8'),
) as Record<string, any>;

const PATIENT_ID = 'margaret-chen';
// The corpus visit date: HCQ (started 2019-01-15) is ~5.9 years in -> the AAO high branch.
const NOW = new Date('2024-12-26T12:00:00Z');

const silentLogger: PrepLogger = { info: () => {}, warn: () => {}, error: () => {} };

function corpusFacts(): any[] {
    return structuredClone([
        ...corpus['medications'],
        ...corpus['allergies'],
        ...corpus['conditions'],
        ...corpus['family_history'],
        ...corpus['patient_goals'],
        corpus['chief_complaint'],
    ]);
}

// The mocked LLM reports the corpus's rich contradictions in the runtime shape the
// extractor demands, via the landed lossy projection.
function corpusContradictions() {
    return (corpus['contradictions'] as unknown[]).map((raw, index) =>
        projectContradiction(ContradictionSchema.parse(raw), { id: `rc-${index + 1}`, patientId: PATIENT_ID }),
    );
}

// The client streams now (stream: true), so fakes speak SSE. The payload text is split
// across two text_delta events to exercise accumulation on every test.
function sseEvents(events: Record<string, unknown>[]): string {
    return events.map((event) => `event: ${String(event['type'])}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

function llmResponse(payload: unknown, stopReason = 'end_turn'): Response {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const mid = Math.ceil(text.length / 2);
    return new Response(
        sseEvents([
            { type: 'message_start', message: { model: 'claude-haiku-4-5', usage: { input_tokens: 1200, output_tokens: 3 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, mid) } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(mid) } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 800 } },
            { type: 'message_stop' },
        ]),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
}

function extractorWith(...responses: Response[]) {
    const fetchMock = vi.fn<FetchLike>();
    for (const response of responses) {
        fetchMock.mockResolvedValueOnce(response);
    }
    const client = new AnthropicClient({ apiKey: 'test-key', model: 'claude-haiku-4-5', fetchImpl: fetchMock });
    return { extractor: new FactExtractor(client), fetchMock };
}

// Corpus-aware LLM fake for per-document extraction: the FIRST document call returns the
// payload's facts (later document calls return none) and the contradiction pass returns
// the payload's contradictions. A string payload is returned verbatim on EVERY call
// (malformed-everywhere mode for failure tests).
function dispatchingExtractor(payload: unknown) {
    let factsSent = false;
    const fetchMock = vi.fn<FetchLike>((_url, init) => {
        if (typeof payload === 'string') {
            return Promise.resolve(llmResponse(payload));
        }
        const p = payload as { facts?: unknown[]; contradictions?: unknown[] };
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (String(body['system']).includes('contradiction detector')) {
            return Promise.resolve(llmResponse({ contradictions: p.contradictions ?? [] }));
        }
        const facts = factsSent ? [] : (p.facts ?? []);
        factsSent = true;
        return Promise.resolve(llmResponse({ facts }));
    });
    const client = new AnthropicClient({ apiKey: 'test-key', model: 'claude-haiku-4-5', fetchImpl: fetchMock });
    return { extractor: new FactExtractor(client), fetchMock };
}

// ---- In-memory FactStore double (the minimal PrepRouteStore surface; no Postgres) ----

interface FakeRun {
    id: string;
    patientId: string;
    correlationId: string;
    status: 'running' | PrepRunStatus;
    stage?: string;
    error?: string;
}

class FakeStore implements PrepRouteStore {
    briefs: StoredBrief[] = [];
    runs: FakeRun[] = [];
    private nextRun = 1;

    constructor(private readonly bundle: FactBundle | null) {}

    async startPrepRun(patientId: string, correlationId: string): Promise<string> {
        const id = `run-${this.nextRun}`;
        this.nextRun += 1;
        this.runs.push({ id, patientId, correlationId, status: 'running' });
        return id;
    }

    async finishPrepRun(runId: string, status: PrepRunStatus, error?: string): Promise<void> {
        const run = this.runs.find((candidate) => candidate.id === runId);
        if (run === undefined) {
            throw new Error(`prep run ${runId} not found`);
        }
        run.status = status;
        if (error !== undefined) {
            run.error = error;
        }
    }

    async saveBrief(brief: BriefInput): Promise<StoredBrief> {
        const stored: StoredBrief = {
            id: `brief-${this.briefs.length + 1}`,
            patient_id: brief.patient_id,
            prepared_at: new Date().toISOString(),
            correlation_id: brief.correlation_id,
            content: brief.content,
            status: brief.status ?? 'complete',
        };
        this.briefs.push(stored);
        return stored;
    }

    async getBrief(patientId: string): Promise<StoredBrief | null> {
        return (
            [...this.briefs].reverse().find(
                (brief) => brief.patient_id === patientId && brief.status === 'complete',
            ) ?? null
        );
    }

    async getFactBundle(patientId: string): Promise<FactBundle | null> {
        return this.bundle !== null && this.bundle.patient.id === patientId ? this.bundle : null;
    }

    async listPatients() {
        return this.bundle === null ? [] : [this.bundle.patient];
    }

    async setPrepRunStage(runId: string, stageName: string): Promise<void> {
        const run = this.runs.find((candidate) => candidate.id === runId);
        if (run === undefined) {
            throw new Error(`prep run ${runId} not found`);
        }
        run.stage = stageName;
    }

    async getPrepRuns(patientId: string): Promise<StoredPrepRun[]> {
        return [...this.runs]
            .reverse()
            .filter((run) => run.patientId === patientId)
            .map((run) => ({
                id: run.id,
                patient_id: run.patientId,
                correlation_id: run.correlationId,
                status: run.status,
                stage: run.stage ?? null,
                error: run.error ?? null,
                started_at: NOW.toISOString(),
                finished_at: run.status === 'running' ? null : NOW.toISOString(),
            }));
    }
}

function corpusBundle(): FactBundle {
    const { patient_id: _pid, name: _name, ...demographics } = corpus['patient'];
    return {
        patient: { id: PATIENT_ID, openemr_patient_id: null, name: corpus['patient'].name, demographics },
        facts: [],
        contradictions: [],
        images: structuredClone(corpus['images']),
        // The seed's treatments + events both live in the treatments table (medication_start
        // anchors the imaging series); StoredTreatment carries the record as its payload.
        treatments: [...corpus['treatments'], ...corpus['events']].map((treatment: any) => ({
            id: treatment.id,
            patient_id: PATIENT_ID,
            treatment_date: treatment.treatment_date,
            payload: structuredClone(treatment),
        })),
        documents: (corpus['source_documents'] as any[]).map((doc) => {
            const { document_id, document_type, document_date, content, metadata, ...extras } = doc;
            return { id: document_id, document_type, document_date, content, metadata: metadata ?? {}, extras };
        }),
    };
}

// The seeded-store view of the corpus: authored facts land as StoredFact rows, so the
// deterministic overview renders the full landing page with ZERO LLM involvement.
function seededBundle(): FactBundle {
    return { ...corpusBundle(), facts: corpusFacts() };
}

// Fake source_documents query: serves the corpus documents keyed the way the store does.
const corpusDb: SourceDocumentQuerier = {
    query: async (_text, values) => ({
        rows:
            values[0] === PATIENT_ID
                ? (corpus['source_documents'] as any[]).map((doc) => ({
                      id: doc.document_id,
                      document_type: doc.document_type,
                      document_date: doc.document_date,
                      content: doc.content,
                  }))
                : [],
    }),
};

function pipelineDeps(payload: unknown) {
    const store = new FakeStore(corpusBundle());
    const { extractor, fetchMock } = dispatchingExtractor(payload);
    const deps: PrepDeps = {
        store,
        source: new StoreDocumentSource(store, corpusDb),
        extractor,
        logger: silentLogger,
        clock: () => NOW,
    };
    return { deps, store, fetchMock };
}

// ---- Extraction ----

// A single synthetic document: per-document extraction makes one call per doc, so most
// extractor tests drive exactly one document (plus the contradiction pass when facts >= 2).
const ONE_DOC = [
    { id: 'doc-x', document_type: 'referral_letter', document_date: '2024-12-15', text: 'UNIQUE-DOC-TEXT' },
];

describe('FactExtractor', () => {
    // Guards: the extractor mangling or dropping schema-valid facts on the happy path —
    // one call per document, then the contradiction pass over the merged facts.
    it('returns typed facts from the doc pass and contradictions from the reduce pass', async () => {
        const { extractor, fetchMock } = extractorWith(
            llmResponse({ facts: corpusFacts() }),
            llmResponse({ contradictions: corpusContradictions() }),
        );
        const result = await extractor.extract(
            { patientId: PATIENT_ID, patientName: 'Margaret L. Chen', documents: ONE_DOC },
            'corr-1',
            silentLogger,
        );
        expect(result.facts).toHaveLength(12);
        expect(result.contradictions).toHaveLength(4);
        expect(result.facts.every((fact) => fact.patient_id === PATIENT_ID)).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(2); // 1 doc + 1 contradiction pass
    });

    // Guards: silent drift off the Messages API contract (endpoint, auth headers, model,
    // streaming at the bounded per-call ceiling, no sampling params, single-doc scope).
    it('sends the Messages API contract the live service expects', async () => {
        const { extractor, fetchMock } = extractorWith(llmResponse({ facts: [] }));
        await extractor.extract(
            { patientId: PATIENT_ID, patientName: 'Margaret L. Chen', documents: ONE_DOC },
            'corr-contract',
            silentLogger,
        );
        const [url, init] = fetchMock.mock.calls[0]!;
        expect(url).toBe('https://api.anthropic.com/v1/messages');
        const headers = init?.headers as Record<string, string>;
        expect(headers['x-api-key']).toBe('test-key');
        expect(headers['anthropic-version']).toBe('2023-06-01');
        expect(headers['x-correlation-id']).toBe('corr-contract');
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body['model']).toBe('claude-haiku-4-5');
        expect('temperature' in body).toBe(false);
        expect(body['stream']).toBe(true);
        expect(body['max_tokens']).toBe(8192); // per-document ceiling, not a corpus mega-call
        expect(body['system']).toContain('VERBATIM');
        expect(body['system']).toContain('rough estimate is fine'); // no character-counting demand
        const messages = body['messages'] as { role: string; content: string }[];
        expect(messages).toHaveLength(1);
        expect(messages[0]!.content).toContain('UNIQUE-DOC-TEXT');
        expect(messages[0]!.content).toContain('doc-x');
    });

    // Guards: the retry path failing to feed the validation errors back to the model.
    it('retries once with the validation errors appended, then succeeds', async () => {
        const invalid = corpusFacts();
        delete invalid[0].source_document_id; // provenance is required
        const { extractor, fetchMock } = extractorWith(
            llmResponse({ facts: invalid }),
            llmResponse({ facts: corpusFacts() }),
            llmResponse({ contradictions: [] }),
        );
        const result = await extractor.extract(
            { patientId: PATIENT_ID, patientName: null, documents: ONE_DOC },
            'corr-retry',
            silentLogger,
        );
        expect(result.facts).toHaveLength(12);
        expect(fetchMock).toHaveBeenCalledTimes(3); // failed doc attempt + retry + contradictions
        const secondBody = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body)) as Record<string, unknown>;
        const messages = secondBody['messages'] as { role: string; content: string }[];
        expect(messages).toHaveLength(3); // original user + failed assistant + error feedback
        expect(messages[1]!.role).toBe('assistant');
        expect(messages[2]!.content).toContain('failed validation');
        expect(messages[2]!.content).toContain('source_document_id');
    });

    // Guards: unbounded retry loops or silent acceptance after a second invalid response.
    it('throws ExtractionError after exactly two invalid attempts', async () => {
        const { extractor, fetchMock } = extractorWith(
            llmResponse('this is not JSON at all'),
            llmResponse('still not JSON'),
        );
        await expect(
            extractor.extract({ patientId: PATIENT_ID, patientName: null, documents: ONE_DOC }, 'corr-fail', silentLogger),
        ).rejects.toThrow(ExtractionError);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    // Guards: truncation being "fixed" by feedback retry — it cannot be; the retry must be
    // FRESH (truncated garbage never re-enters the conversation) and capped at one.
    it('retries truncation once fresh, never with feedback', async () => {
        const { extractor, fetchMock } = extractorWith(
            llmResponse({ facts: [] }, 'max_tokens'),
            llmResponse({ facts: [] }),
        );
        const result = await extractor.extract(
            { patientId: PATIENT_ID, patientName: null, documents: ONE_DOC },
            'corr-trunc',
            silentLogger,
        );
        expect(result.facts).toHaveLength(0);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const secondBody = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body)) as Record<string, unknown>;
        expect((secondBody['messages'] as unknown[])).toHaveLength(1); // fresh, no appended failure
    });

    // Guards: infinite truncation loops — two ceiling hits end the call with a clear error.
    it('fails with the truncation reason after two ceiling hits', async () => {
        const { extractor, fetchMock } = extractorWith(
            llmResponse({ facts: [] }, 'max_tokens'),
            llmResponse({ facts: [] }, 'max_tokens'),
        );
        await expect(
            extractor.extract({ patientId: PATIENT_ID, patientName: null, documents: ONE_DOC }, 'corr-trunc2', silentLogger),
        ).rejects.toThrow(/max_tokens/);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    // Guards: the 2026-07-08 live failure — Haiku omits null keys in minified JSON, so a
    // citation without context_before/context_after must parse (they default to null).
    it('accepts citations whose excerpt_location omits the context keys', async () => {
        const facts = corpusFacts().slice(0, 1);
        for (const source of facts[0].sources) {
            if (source.excerpt_location) {
                delete source.excerpt_location.context_before;
                delete source.excerpt_location.context_after;
            }
        }
        const { extractor } = extractorWith(llmResponse({ facts }));
        const result = await extractor.extract(
            { patientId: PATIENT_ID, patientName: null, documents: ONE_DOC },
            'corr-noctx',
            silentLogger,
        );
        expect(result.facts).toHaveLength(1);
        expect(result.facts[0]!.sources[0]!.excerpt_location?.context_before).toBeNull();
    });

    // Guards: common model formatting drift — fenced JSON must still parse.
    it('accepts a markdown-fenced JSON response', async () => {
        const fenced = '```json\n' + JSON.stringify({ facts: [] }) + '\n```';
        const { extractor } = extractorWith(llmResponse(fenced));
        const result = await extractor.extract(
            { patientId: PATIENT_ID, patientName: null, documents: ONE_DOC },
            'corr-fence',
            silentLogger,
        );
        expect(result.facts).toHaveLength(0);
    });

    // Guards: cross-patient leakage — extracted items claiming another patient must fail.
    it('rejects extraction whose facts claim a different patient', async () => {
        const stray = corpusFacts().map((fact) => ({ ...fact, patient_id: 'someone-else' }));
        const { extractor } = extractorWith(
            llmResponse({ facts: stray }),
            llmResponse({ facts: stray }),
        );
        await expect(
            extractor.extract({ patientId: PATIENT_ID, patientName: null, documents: ONE_DOC }, 'corr-stray', silentLogger),
        ).rejects.toThrow(/patient_id/);
    });

    // Guards: the reduce pass silently skipped — with >= 2 facts the contradiction call
    // must happen and receive compact fact summaries, not full documents.
    it('feeds compact fact summaries to the contradiction pass', async () => {
        const { extractor, fetchMock } = extractorWith(
            llmResponse({ facts: corpusFacts() }),
            llmResponse({ contradictions: [] }),
        );
        await extractor.extract(
            { patientId: PATIENT_ID, patientName: null, documents: ONE_DOC },
            'corr-reduce',
            silentLogger,
        );
        const reduceBody = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body)) as Record<string, unknown>;
        expect(String(reduceBody['system'])).toContain('contradiction detector');
        const content = (reduceBody['messages'] as { content: string }[])[0]!.content;
        expect(content).toContain('type=medication');
        expect(content).not.toContain('BEGIN TEXT'); // summaries, never full documents
    });
});

// ---- Transient-failure retry ----

function apiErrorResponse(status: number, type: string): Response {
    return new Response(JSON.stringify({ error: { type, message: 'synthetic' } }), { status });
}

describe('FactExtractor transient retry', () => {
    // Guards: a single Anthropic blip (overload/timeout/5xx) killing an entire prep run —
    // one fresh retry must absorb it, then succeed.
    it('retries once after a transient API failure, then succeeds', async () => {
        const { extractor, fetchMock } = extractorWith(
            apiErrorResponse(529, 'overloaded_error'),
            llmResponse({ facts: [] }),
        );
        const result = await extractor.extract(
            { patientId: PATIENT_ID, patientName: null, documents: ONE_DOC },
            'corr-transient',
            silentLogger,
        );
        expect(result.facts).toHaveLength(0);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    // Guards: unbounded retry against a persistently failing API (cost + wedged runs).
    it('gives up after the single transient retry', async () => {
        const { extractor, fetchMock } = extractorWith(
            apiErrorResponse(529, 'overloaded_error'),
            apiErrorResponse(503, 'api_error'),
        );
        await expect(
            extractor.extract({ patientId: PATIENT_ID, patientName: null, documents: ONE_DOC }, 'corr-2x', silentLogger),
        ).rejects.toThrow(/503/);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    // Guards: contract errors (4xx) being retried — they can never succeed and double cost.
    it('does not retry a non-transient 400', async () => {
        const { extractor, fetchMock } = extractorWith(apiErrorResponse(400, 'invalid_request_error'));
        await expect(
            extractor.extract({ patientId: PATIENT_ID, patientName: null, documents: ONE_DOC }, 'corr-400', silentLogger),
        ).rejects.toThrow(/400/);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

// ---- Anthropic streaming client ----

describe('AnthropicClient streaming', () => {
    // Guards: delta accumulation dropping chunks or thinking deltas leaking into the
    // extraction text (adaptive thinking is on by default and bills as output).
    it('accumulates text deltas, skips thinking deltas, and reports usage + stop_reason', async () => {
        const fetchMock = vi.fn<FetchLike>().mockResolvedValueOnce(
            new Response(
                sseEvents([
                    { type: 'message_start', message: { model: 'claude-haiku-4-5', usage: { input_tokens: 42, output_tokens: 1 } } },
                    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'INTERNAL' } },
                    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello ' } },
                    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } },
                    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
                    { type: 'message_stop' },
                ]),
                { status: 200 },
            ),
        );
        const client = new AnthropicClient({ apiKey: 'test-key', model: 'claude-haiku-4-5', fetchImpl: fetchMock });
        const completion = await client.complete('sys', [{ role: 'user', content: 'hi' }], 'corr-sse');
        expect(completion.text).toBe('hello world');
        expect(completion.text).not.toContain('INTERNAL');
        expect(completion.usage).toEqual({ input_tokens: 42, output_tokens: 7 });
        expect(completion.stop_reason).toBe('end_turn');
    });

    // Guards: the observed live failure mode — a hung Anthropic call wedging the prep run
    // (and its in-flight dedupe slot) forever. Idle silence must kill the call.
    it('aborts with a typed timeout error when the stream goes idle', async () => {
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(
                    new TextEncoder().encode(
                        sseEvents([{ type: 'message_start', message: { model: 'm', usage: { input_tokens: 1 } } }]),
                    ),
                );
                // never closes — simulates a wedged upstream
            },
        });
        const fetchMock = vi.fn<FetchLike>().mockResolvedValueOnce(new Response(body, { status: 200 }));
        const client = new AnthropicClient({
            apiKey: 'test-key',
            model: 'claude-haiku-4-5',
            fetchImpl: fetchMock,
            idleTimeoutMs: 25,
        });
        await expect(client.complete('sys', [{ role: 'user', content: 'hi' }], 'corr-idle')).rejects.toThrow(
            /no stream progress/,
        );
    });

    // Guards: mid-stream API errors (e.g. overloaded_error) dissolving into downstream
    // JSON-parse noise instead of a typed, retryable failure.
    it('throws a typed error on an SSE error event', async () => {
        const fetchMock = vi.fn<FetchLike>().mockResolvedValueOnce(
            new Response(
                sseEvents([
                    { type: 'message_start', message: { model: 'm', usage: { input_tokens: 1 } } },
                    { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
                ]),
                { status: 200 },
            ),
        );
        const client = new AnthropicClient({ apiKey: 'test-key', model: 'claude-haiku-4-5', fetchImpl: fetchMock });
        await expect(client.complete('sys', [{ role: 'user', content: 'hi' }], 'corr-err')).rejects.toThrow(
            /overloaded_error/,
        );
    });

    // Guards: silent-heartbeat regression — a long call must emit periodic progress so
    // Railway logs distinguish slow from hung.
    it('emits onProgress heartbeats while the stream is open', async () => {
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(
                    encoder.encode(
                        sseEvents([
                            { type: 'message_start', message: { model: 'm', usage: { input_tokens: 1 } } },
                            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'chunk-one' } },
                        ]),
                    ),
                );
                setTimeout(() => {
                    controller.enqueue(
                        encoder.encode(
                            sseEvents([
                                { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
                                { type: 'message_stop' },
                            ]),
                        ),
                    );
                    controller.close();
                }, 60);
            },
        });
        const fetchMock = vi.fn<FetchLike>().mockResolvedValueOnce(new Response(body, { status: 200 }));
        const client = new AnthropicClient({
            apiKey: 'test-key',
            model: 'claude-haiku-4-5',
            fetchImpl: fetchMock,
            heartbeatMs: 10,
        });
        const progress = vi.fn();
        const completion = await client.complete('sys', [{ role: 'user', content: 'hi' }], 'corr-beat', { onProgress: progress });
        expect(completion.text).toBe('chunk-one');
        expect(progress).toHaveBeenCalled();
        const last = progress.mock.calls.at(-1)![0] as { textChars: number; elapsedMs: number };
        expect(last.textChars).toBe('chunk-one'.length);
        expect(last.elapsedMs).toBeGreaterThan(0);
    });
});

// ---- Document sources ----

describe('StoreDocumentSource', () => {
    // Guards: a prep silently running against an unregistered patient with empty inputs.
    it('throws for a patient the fact store does not know', async () => {
        const source = new StoreDocumentSource(new FakeStore(corpusBundle()), corpusDb);
        await expect(source.load('nobody', 'corr-x')).rejects.toThrow(/not registered/);
    });

    // Guards: losing document text or imaging/treatment records between store and engines.
    it('loads corpus documents, images, and treatments in engine-ready shapes', async () => {
        const source = new StoreDocumentSource(new FakeStore(corpusBundle()), corpusDb);
        const data = await source.load(PATIENT_ID, 'corr-load');
        expect(data.patient.name).toBe('Margaret L. Chen');
        expect(data.documents).toHaveLength(12);
        expect(data.documents.every((doc) => doc.text.length > 0)).toBe(true);
        expect(data.images).toHaveLength(6);
        expect(data.images[0]!.image_metadata.modality).toBe('oct');
        expect(data.treatments).toHaveLength(1); // the medication_start anchor event
        expect(data.treatments[0]!.treatment_date).toBe('2021-12-01');
    });
});

describe('FhirDocumentSource', () => {
    // Guards: the FHIR path (wired for S1.9) mis-mapping DocumentReference attachments.
    it('maps Patient + DocumentReference resources to prep documents', async () => {
        const text = 'Referral letter: floaters and flashes, worse OD.';
        const fhir: FhirReader = {
            getPatient: vi.fn(async () => ({
                resourceType: 'Patient',
                name: [{ given: ['Margaret', 'L.'], family: 'Chen' }],
            })),
            searchByPatient: vi.fn(async () => ({
                resourceType: 'Bundle' as const,
                entry: [
                    {
                        resource: {
                            resourceType: 'DocumentReference',
                            id: 'docref-1',
                            date: '2024-12-15',
                            type: { text: 'referral_letter' },
                            content: [
                                {
                                    attachment: {
                                        contentType: 'text/plain',
                                        data: Buffer.from(text, 'utf8').toString('base64'),
                                    },
                                },
                            ],
                        },
                    },
                    // No inline text data -> must be skipped, not emitted as an empty doc.
                    { resource: { resourceType: 'DocumentReference', id: 'docref-2', content: [] } },
                ],
            })),
        };
        const source = new FhirDocumentSource(fhir);
        const data = await source.load('uuid-123', 'corr-fhir');
        expect(fhir.searchByPatient).toHaveBeenCalledWith('DocumentReference', 'uuid-123', 'corr-fhir');
        expect(data.patient.name).toBe('Margaret L. Chen');
        expect(data.documents).toHaveLength(1);
        expect(data.documents[0]).toEqual({
            id: 'docref-1',
            document_type: 'referral_letter',
            document_date: '2024-12-15',
            text,
        });
        expect(data.images).toHaveLength(0);
        expect(data.treatments).toHaveLength(0);
    });
});

// ---- Pipeline end-to-end ----

// ---- Pipeline tracing ----

class FakeTracer {
    stages: string[] = [];
    generations: { attempt: number; model: string; inputTokens: number; outputTokens: number }[] = [];
    outcome: { status: string; error?: string; gateMetrics?: unknown } | undefined;

    startTrace() {
        return {
            stage: (record: { name: string }) => {
                this.stages.push(record.name);
            },
            generation: (record: { attempt: number; model: string; inputTokens: number; outputTokens: number }) => {
                this.generations.push(record);
            },
            end: async (outcome: { status: string; error?: string; gateMetrics?: unknown }) => {
                this.outcome = outcome;
            },
        };
    }
}

describe('prep pipeline tracing', () => {
    // Guards: the trace missing stages/generations/outcome — the S2.6 dashboard reads
    // these; a silent wiring regression would empty it without failing anything.
    it('emits stage spans, a generation, and a complete outcome on success', async () => {
        const { deps, store } = pipelineDeps({ facts: corpusFacts(), contradictions: [] });
        const tracer = new FakeTracer();
        await runPrep({ ...deps, tracer }, PATIENT_ID, 'corr-trace');
        expect(store.briefs).toHaveLength(1);
        expect(tracer.stages).toEqual([
            'load_sources',
            'llm_extraction',
            'citation_gate',
            'medication_risk',
            'imaging_analytics',
            'brief_assembly',
            'save_brief',
        ]);
        // 12 per-document calls + 1 contradiction pass, each traced as a generation.
        expect(tracer.generations).toHaveLength(13);
        expect(tracer.generations[0]).toMatchObject({ attempt: 1, model: 'claude-haiku-4-5', inputTokens: 1200, outputTokens: 800 });
        expect(tracer.outcome?.status).toBe('complete');
        expect(tracer.outcome?.gateMetrics).toBeDefined();
    });

    // Guards: failed runs vanishing from the dashboard — the error must reach the trace.
    it('emits a failed outcome carrying the error when extraction dies', async () => {
        const store = new FakeStore(corpusBundle());
        const { extractor } = extractorWith(llmResponse('not json'), llmResponse('still not json'));
        const tracer = new FakeTracer();
        const deps: PrepDeps = {
            store,
            source: new StoreDocumentSource(store, corpusDb),
            extractor,
            tracer,
            logger: silentLogger,
            clock: () => NOW,
        };
        await expect(runPrep(deps, PATIENT_ID, 'corr-trace-fail')).rejects.toThrow(ExtractionError);
        expect(tracer.outcome?.status).toBe('failed');
        expect(tracer.outcome?.error).toContain('extraction failed');
    });
});

describe('prep pipeline end-to-end', () => {
    // Guards: the whole spine — brief saved, gate at 100%, HCQ high flag, GC-progression
    // alert, and non-empty deterministic discussion points, all from real corpus data.
    it('prepares a complete brief for the seed corpus', async () => {
        const { deps, store } = pipelineDeps({ facts: corpusFacts(), contradictions: corpusContradictions() });
        const result = await runPrep(deps, PATIENT_ID, 'corr-e2e');

        expect(store.runs[0]!.status).toBe('complete');
        expect(store.briefs).toHaveLength(1);
        expect(store.briefs[0]!.correlation_id).toBe('corr-e2e');

        // The saved content round-trips through the exported panel contract.
        const content = BriefContentSchema.parse(result.content);

        // Gate metrics 100%: every extracted fact verified, every citation resolved.
        expect(content.gate_metrics).toMatchObject({ claims: 12, verified: 12, blocked: 0, citationsFailed: 0 });

        // Med-risk arithmetic: HCQ since 2019-01-15 is ~5.9 years -> AAO high-risk branch.
        const hcqFlag = content.medication_risk_flags.find((flag) => flag.flag_type === 'retinal_toxicity');
        expect(hcqFlag?.severity).toBe('high');
        expect(hcqFlag?.details?.duration_years).toBe(5);

        // Imaging analytics: authored GC decline 82->70 microns + RPE escalation -> alert.
        expect(content.imaging.hcq_progression.progression_detected).toBe(true);
        expect(content.imaging.hcq_progression.alert_level).toBe('high');
        expect(content.imaging.hcq_progression.progression_description).toContain('Ganglion cell');
        expect(content.imaging.timeline_summary).toHaveLength(6);
        expect(content.imaging.timeline_summary[0]!.treatment_context.days_since_last_treatment).toBe(14);

        // Overview IA fields derived deterministically from verified facts.
        expect(content.key_discussion_points.length).toBeGreaterThan(0);
        // R4/R5: discussion points are terse structured items carrying citation refs.
        for (const point of content.key_discussion_points) {
            expect(point.text.length).toBeLessThanOrEqual(91);
            expect(['med_change', 'risk_flag', 'contradiction', 'imaging', 'interval']).toContain(point.kind);
        }
        const contradictionPoint = content.key_discussion_points.find((p) => p.kind === 'contradiction');
        expect(contradictionPoint?.contradiction_id).toBeTruthy();
        expect(content.questions_to_confirm.length).toBeGreaterThan(0);
        expect(content.why_they_are_here?.content.statement).toContain('Floaters');
        expect(content.what_they_are_hoping_for?.content.goal).toContain('floaters');
        expect(content.contradiction_alerts).toHaveLength(4);
        expect(content.urgency?.level).toBe('high'); // critical sulfa-allergy contradiction
        expect(content.facts_by_type.medication).toHaveLength(5);
        expect(content.prepared_at).toBe(NOW.toISOString());
    });

    // Guards: the rewrite-as-absence invariant — a fabricated citation blocks the fact
    // (dropped from facts_by_type, counted in gate metrics) without failing the prep.
    it('drops a gate-blocked fact while the prep run still completes', async () => {
        const facts = corpusFacts();
        const fabricated = structuredClone(facts[0]);
        fabricated.id = 'fact-fabricated';
        fabricated.content = { ...fabricated.content, name: 'Fabricatol' };
        fabricated.sources = [
            {
                ...facts[0].sources[0],
                id: 'cit-fabricated',
                fact_id: 'fact-fabricated',
                excerpt_text: 'this text appears nowhere in any source document',
            },
        ];
        facts.push(fabricated);

        const { deps, store } = pipelineDeps({ facts, contradictions: [] });
        const result = await runPrep(deps, PATIENT_ID, 'corr-gate');

        expect(store.runs[0]!.status).toBe('complete');
        expect(result.content.gate_metrics.citationsFailed).toBeGreaterThan(0);
        expect(result.content.gate_metrics.blocked).toBe(1);
        expect(result.content.gate_metrics.verified).toBe(12);
        const briefFactIds = Object.values(result.content.facts_by_type)
            .flat()
            .map((fact) => fact.id);
        expect(briefFactIds).not.toContain('fact-fabricated');
        expect(briefFactIds).toContain(facts[0].id);
    });

    // Guards: a failed extraction leaving the prep_run dangling as 'running' or a
    // partial brief being saved (the "never silently wrong" rule).
    it('records the failure on the prep run when extraction fails twice', async () => {
        const store = new FakeStore(corpusBundle());
        const { extractor } = extractorWith(llmResponse('not json'), llmResponse('still not json'));
        const deps: PrepDeps = {
            store,
            source: new StoreDocumentSource(store, corpusDb),
            extractor,
            logger: silentLogger,
            clock: () => NOW,
        };
        await expect(runPrep(deps, PATIENT_ID, 'corr-broken')).rejects.toThrow(ExtractionError);
        expect(store.runs[0]!.status).toBe('failed');
        expect(store.runs[0]!.error).toContain('not valid JSON');
        expect(store.briefs).toHaveLength(0);
    });
});

// ---- Routes ----

function routeDeps(payload: unknown = { facts: corpusFacts(), contradictions: corpusContradictions() }) {
    const store = new FakeStore(corpusBundle());
    const { extractor } = dispatchingExtractor(payload);
    const deps: PrepRouteDeps = {
        store,
        source: new StoreDocumentSource(store, corpusDb),
        extractor,
        clock: () => NOW,
    };
    return { deps, store };
}

function testServer(prep?: PrepRouteDeps, checkPostgres?: () => Promise<void>) {
    const appDeps: AppDeps | undefined =
        prep === undefined
            ? undefined
            : {
                  checkPostgres: checkPostgres ?? (async () => {}),
                  runMigrations: async () => [],
                  prep,
                  overview: { store: prep.store as unknown as FakeStore, clock: () => NOW },
              };
    return buildServer(loadConfig({ NODE_ENV: 'test' }), appDeps);
}

describe('prep routes', () => {
    // Guards: the scaffold breaking when Postgres is not configured — 503, not a crash.
    it('answers 503 store_not_configured on every prep route without deps', async () => {
        const app = testServer();
        for (const request of [
            { method: 'POST' as const, url: `/api/prep/${PATIENT_ID}` },
            { method: 'GET' as const, url: `/api/brief/${PATIENT_ID}` },
            { method: 'GET' as const, url: `/api/facts/${PATIENT_ID}` },
        ]) {
            const res = await app.inject(request);
            expect(res.statusCode).toBe(503);
            expect(res.json()).toEqual({ error: 'store_not_configured' });
        }
    });

    // Guards: the 202 contract (prep_run_id + correlation_id) and the fire-and-forget
    // pipeline actually persisting a brief after the response went out.
    it('POST /api/prep answers 202 and completes the run asynchronously', async () => {
        const { deps, store } = routeDeps();
        const app = testServer(deps);
        const res = await app.inject({
            method: 'POST',
            url: `/api/prep/${PATIENT_ID}`,
            headers: { 'x-correlation-id': 'corr-route' },
        });
        expect(res.statusCode).toBe(202);
        expect(res.json()).toEqual({ prep_run_id: 'run-1', correlation_id: 'corr-route' });
        await vi.waitFor(() => {
            expect(store.runs[0]!.status).toBe('complete');
        });
        expect(store.briefs).toHaveLength(1);
        expect(store.briefs[0]!.correlation_id).toBe('corr-route');
    });

    // Guards: an async prep failure escaping the error capture (unhandled rejection)
    // instead of landing on the prep_run row.
    it('POST /api/prep still answers 202 when the async pipeline fails, recording the error', async () => {
        const { deps, store } = routeDeps('not json'); // single bad response; retry exhausts the mock
        const app = testServer(deps);
        const res = await app.inject({ method: 'POST', url: `/api/prep/${PATIENT_ID}` });
        expect(res.statusCode).toBe(202);
        await vi.waitFor(() => {
            expect(store.runs[0]!.status).toBe('failed');
        });
        expect(store.briefs).toHaveLength(0);
    });

    // Guards: the panel's not-prepared state — 404 with the agreed body, never a 500.
    it('GET /api/brief answers 404 not_prepared before any prep ran', async () => {
        const { deps } = routeDeps();
        const app = testServer(deps);
        const res = await app.inject({ method: 'GET', url: `/api/brief/${PATIENT_ID}` });
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual({ status: 'not_prepared' });
    });

    // Guards: the brief read path returning the stored complete brief.
    it('GET /api/brief returns the latest complete brief', async () => {
        const { deps, store } = routeDeps();
        await store.saveBrief({ patient_id: PATIENT_ID, correlation_id: 'corr-b', content: { hello: 'brief' } });
        const app = testServer(deps);
        const res = await app.inject({ method: 'GET', url: `/api/brief/${PATIENT_ID}` });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ patient_id: PATIENT_ID, status: 'complete', content: { hello: 'brief' } });
    });

    // Guards: the fact-bundle read path and its unknown-patient 404.
    // Guards: the run-status observability contract — a completed run shows its final
    // stage; a failed run shows the stage it died in, plus the recorded error.
    it('GET /api/prep-runs reports stage and error for completed and failed runs', async () => {
        const { deps, store } = routeDeps();
        const app = testServer(deps);
        await app.inject({ method: 'POST', url: `/api/prep/${PATIENT_ID}` });
        await vi.waitFor(() => {
            expect(store.runs[0]!.status).toBe('complete');
        });
        const ok = await app.inject({ method: 'GET', url: `/api/prep-runs/${PATIENT_ID}` });
        expect(ok.statusCode).toBe(200);
        const completed = (ok.json() as { runs: StoredPrepRun[] }).runs[0]!;
        expect(completed.status).toBe('complete');
        expect(completed.stage).toBe('save_brief'); // the last stage entered

        // A failing extraction (invalid JSON on both attempts) must leave the run failed
        // AT llm_extraction with the ExtractionError message recorded.
        const failStore = new FakeStore(corpusBundle());
        const failExtractor = extractorWith(llmResponse('not json'), llmResponse('still not json')).extractor;
        const failApp = testServer({
            store: failStore,
            source: new StoreDocumentSource(failStore, corpusDb),
            extractor: failExtractor,
            clock: () => NOW,
        });
        await failApp.inject({ method: 'POST', url: `/api/prep/${PATIENT_ID}` });
        await vi.waitFor(() => {
            expect(failStore.runs[0]!.status).toBe('failed');
        });
        const failed = ((await failApp.inject({ method: 'GET', url: `/api/prep-runs/${PATIENT_ID}` })).json() as {
            runs: StoredPrepRun[];
        }).runs[0]!;
        expect(failed.status).toBe('failed');
        expect(failed.stage).toBe('llm_extraction');
        expect(failed.error).toContain('extraction failed');
    });

    // Guards: the scaffold contract for the new route — 503 without a store, empty list
    // (not 404) for an unknown patient.
    it('GET /api/prep-runs answers 503 without deps and [] for an unknown patient', async () => {
        const bare = await testServer().inject({ method: 'GET', url: `/api/prep-runs/${PATIENT_ID}` });
        expect(bare.statusCode).toBe(503);
        const { deps } = routeDeps();
        const res = await testServer(deps).inject({ method: 'GET', url: '/api/prep-runs/nobody' });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ runs: [] });
    });

    it('GET /api/facts returns the bundle for a known patient and 404 otherwise', async () => {
        const { deps } = routeDeps();
        const app = testServer(deps);
        const found = await app.inject({ method: 'GET', url: `/api/facts/${PATIENT_ID}` });
        expect(found.statusCode).toBe(200);
        expect(found.json().patient.id).toBe(PATIENT_ID);
        const missing = await app.inject({ method: 'GET', url: '/api/facts/nobody' });
        expect(missing.statusCode).toBe(404);
        expect(missing.json()).toEqual({ error: 'patient_not_found' });
    });
});

// ---- Spend guardrails (budget gate, reuse window, dedupe, concurrency, usage) ----

// In-memory SpendGuard double (the PrepRouteSpendGuard surface; no Postgres).
class FakeSpendGuard implements PrepRouteSpendGuard {
    recorded: LlmCallRecord[] = [];
    budgetError: BudgetExceededError | null = null;
    summary: UsageSummary = {
        window: '24h',
        calls: 2,
        input_tokens: 2400,
        output_tokens: 1600,
        est_cost_usd: 0.0312,
        budget_usd: 5,
        remaining_usd: 4.9688,
    };

    async assertBudget(): Promise<void> {
        if (this.budgetError !== null) {
            throw this.budgetError;
        }
    }

    async recordCall(call: LlmCallRecord): Promise<void> {
        this.recorded.push(call);
    }

    async usageSummary(): Promise<UsageSummary> {
        return this.summary;
    }
}

function guardedDeps(options: { spendGuard?: FakeSpendGuard; maxConcurrentPreps?: number } = {}) {
    const store = new FakeStore(corpusBundle());
    const spendGuard = options.spendGuard ?? new FakeSpendGuard();
    const { extractor, fetchMock } = dispatchingExtractor({
        facts: corpusFacts(),
        contradictions: corpusContradictions(),
    });
    const deps: PrepRouteDeps = {
        store,
        source: new StoreDocumentSource(store, corpusDb),
        extractor,
        spendGuard,
        clock: () => NOW,
        ...(options.maxConcurrentPreps !== undefined ? { maxConcurrentPreps: options.maxConcurrentPreps } : {}),
    };
    return { deps, store, spendGuard, fetchMock };
}

function pushBrief(store: FakeStore, ageMinutes: number): StoredBrief {
    const stored: StoredBrief = {
        id: 'brief-existing',
        patient_id: PATIENT_ID,
        prepared_at: new Date(NOW.getTime() - ageMinutes * 60_000).toISOString(),
        correlation_id: 'corr-prev',
        content: {},
        status: 'complete',
    };
    store.briefs.push(stored);
    return stored;
}

// Extractor whose single LLM call hangs until release() — keeps a prep in flight so the
// dedupe/concurrency guards can be observed, then completes it to free the slot.
function hangingExtractor() {
    let release!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => {
        release = resolve;
    });
    // First call (document 1) hangs on the gate; every later call answers empty so the
    // run completes once released.
    let first = true;
    const fetchMock = vi.fn<FetchLike>((_url, init) => {
        if (first) {
            first = false;
            return gate;
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Promise.resolve(
            String(body['system']).includes('contradiction detector')
                ? llmResponse({ contradictions: [] })
                : llmResponse({ facts: [] }),
        );
    });
    const client = new AnthropicClient({ apiKey: 'test-key', model: 'claude-haiku-4-5', fetchImpl: fetchMock });
    return { extractor: new FactExtractor(client), release };
}

describe('spend guardrails: prep pipeline', () => {
    // Guards: an LLM call escaping the ledger — BOTH attempts of a retried extraction
    // must land in recordCall with the run's correlation ID and the prep purpose.
    it('records usage once per Anthropic call, including the retry attempt', async () => {
        const store = new FakeStore(corpusBundle());
        const spendGuard = new FakeSpendGuard();
        const invalid = corpusFacts();
        delete invalid[0].source_document_id; // doc 1's first attempt fails validation -> retry
        // Dispatcher with one planted validation failure: doc call 1 invalid, doc call 2
        // valid (all facts), later docs empty, contradiction pass empty.
        let docCalls = 0;
        const fetchMock = vi.fn<FetchLike>((_url, init) => {
            const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            if (String(body['system']).includes('contradiction detector')) {
                return Promise.resolve(llmResponse({ contradictions: [] }));
            }
            docCalls += 1;
            if (docCalls === 1) {
                return Promise.resolve(llmResponse({ facts: invalid }));
            }
            return Promise.resolve(llmResponse({ facts: docCalls === 2 ? corpusFacts() : [] }));
        });
        const extractor = new FactExtractor(
            new AnthropicClient({ apiKey: 'test-key', model: 'claude-haiku-4-5', fetchImpl: fetchMock }),
        );
        const deps: PrepDeps = {
            store,
            source: new StoreDocumentSource(store, corpusDb),
            extractor,
            spendGuard,
            logger: silentLogger,
            clock: () => NOW,
        };
        await runPrep(deps, PATIENT_ID, 'corr-usage');
        // 12 documents + 1 validation retry + 1 contradiction pass — every call ledgered.
        expect(fetchMock).toHaveBeenCalledTimes(14);
        expect(spendGuard.recorded).toHaveLength(14);
        for (const call of spendGuard.recorded) {
            expect(call).toEqual({
                correlationId: 'corr-usage',
                purpose: 'prep_extraction',
                model: 'claude-haiku-4-5',
                inputTokens: 1200,
                outputTokens: 800,
            });
        }
    });

    // Guards: a blown budget still buying tokens — assertBudget must fail the run BEFORE
    // any LLM call, with the clear budget message recorded on the prep_run row.
    it('fails the run before any LLM call when the budget is exceeded', async () => {
        const store = new FakeStore(corpusBundle());
        const spendGuard = new FakeSpendGuard();
        spendGuard.budgetError = new BudgetExceededError(5.25, 5);
        const { extractor, fetchMock } = extractorWith(llmResponse({ facts: [], contradictions: [] }));
        const deps: PrepDeps = {
            store,
            source: new StoreDocumentSource(store, corpusDb),
            extractor,
            spendGuard,
            logger: silentLogger,
            clock: () => NOW,
        };
        await expect(runPrep(deps, PATIENT_ID, 'corr-budget')).rejects.toThrow(BudgetExceededError);
        expect(store.runs[0]!.status).toBe('failed');
        expect(store.runs[0]!.error).toContain('llm daily budget exceeded');
        expect(fetchMock).not.toHaveBeenCalled();
        expect(spendGuard.recorded).toHaveLength(0);
        expect(store.briefs).toHaveLength(0);
    });
});

describe('spend guardrails: prep route', () => {
    // Guards: re-prepping (and re-paying for) a patient whose brief is still fresh.
    it('reuses a brief newer than the reuse window without invoking the extractor', async () => {
        const { deps, store, fetchMock } = guardedDeps();
        const brief = pushBrief(store, 5); // 5 min old < the 10 min default window
        const app = testServer(deps);
        const res = await app.inject({ method: 'POST', url: `/api/prep/${PATIENT_ID}` });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ status: 'reused', brief_id: brief.id, prepared_at: brief.prepared_at });
        expect(store.runs).toHaveLength(0); // no prep_run row opened
        expect(fetchMock).not.toHaveBeenCalled();
    });

    // Guards: the window arithmetic inverting — a stale brief must NOT suppress the prep.
    it('runs a fresh prep when the latest brief is older than the reuse window', async () => {
        const { deps, store } = guardedDeps();
        pushBrief(store, 11); // 11 min old > the 10 min default window
        const app = testServer(deps);
        const res = await app.inject({ method: 'POST', url: `/api/prep/${PATIENT_ID}` });
        expect(res.statusCode).toBe(202);
        await vi.waitFor(() => {
            expect(store.runs[0]!.status).toBe('complete');
        });
    });

    // Guards: the explicit re-prep escape hatch — force=true must skip the reuse check.
    it('force=true bypasses the reuse window and starts a new run', async () => {
        const { deps, store } = guardedDeps();
        pushBrief(store, 1); // would be reused without force
        const app = testServer(deps);
        const res = await app.inject({ method: 'POST', url: `/api/prep/${PATIENT_ID}?force=true` });
        expect(res.statusCode).toBe(202);
        expect(res.json()).toMatchObject({ prep_run_id: 'run-1' });
        await vi.waitFor(() => {
            expect(store.runs[0]!.status).toBe('complete');
        });
    });

    // Guards: double-spending on the same patient — a second POST while the first prep
    // is still executing must return the running id, not open a second run.
    it('answers already_running while a prep for the same patient is in flight', async () => {
        const store = new FakeStore(corpusBundle());
        const { extractor, release } = hangingExtractor();
        const deps: PrepRouteDeps = {
            store,
            source: new StoreDocumentSource(store, corpusDb),
            extractor,
            spendGuard: new FakeSpendGuard(),
            clock: () => NOW,
        };
        const app = testServer(deps);
        const first = await app.inject({ method: 'POST', url: `/api/prep/${PATIENT_ID}` });
        expect(first.statusCode).toBe(202);
        const prepRunId = (first.json() as { prep_run_id: string }).prep_run_id;

        const second = await app.inject({ method: 'POST', url: `/api/prep/${PATIENT_ID}` });
        expect(second.statusCode).toBe(202);
        expect(second.json()).toEqual({ status: 'already_running', prep_run_id: prepRunId });
        expect(store.runs).toHaveLength(1); // no second prep_run row

        // Release the hanging LLM call so the in-flight slot frees for later tests.
        release(llmResponse({ facts: corpusFacts(), contradictions: corpusContradictions() }));
        await vi.waitFor(() => {
            expect(store.runs[0]!.status).toBe('complete');
        });
    });

    // Guards: unbounded parallel spend across patients — at the cap the route must 429.
    it('answers 429 too_many_preps at the concurrency cap', async () => {
        const store = new FakeStore(corpusBundle());
        const { extractor, release } = hangingExtractor();
        const deps: PrepRouteDeps = {
            store,
            source: new StoreDocumentSource(store, corpusDb),
            extractor,
            spendGuard: new FakeSpendGuard(),
            maxConcurrentPreps: 1,
            clock: () => NOW,
        };
        const app = testServer(deps);
        const first = await app.inject({ method: 'POST', url: `/api/prep/${PATIENT_ID}` });
        expect(first.statusCode).toBe(202);

        // A different patient trips the cap (the per-patient dedupe would not catch it).
        const capped = await app.inject({ method: 'POST', url: '/api/prep/other-patient' });
        expect(capped.statusCode).toBe(429);
        expect(capped.json()).toEqual({ error: 'too_many_preps' });
        expect(store.runs).toHaveLength(1);

        release(llmResponse({ facts: corpusFacts(), contradictions: corpusContradictions() }));
        await vi.waitFor(() => {
            expect(store.runs[0]!.status).toBe('complete');
        });
    });

    // Guards: the budget 429 contract — error code plus the spent/budget amounts, and no
    // prep_run row or LLM call behind it.
    it('answers 429 llm_budget_exceeded with the spent and budget amounts', async () => {
        const spendGuard = new FakeSpendGuard();
        spendGuard.budgetError = new BudgetExceededError(6.5, 5);
        const { deps, store, fetchMock } = guardedDeps({ spendGuard });
        const app = testServer(deps);
        const res = await app.inject({ method: 'POST', url: `/api/prep/${PATIENT_ID}` });
        expect(res.statusCode).toBe(429);
        expect(res.json()).toEqual({ error: 'llm_budget_exceeded', spent_usd: 6.5, budget_usd: 5 });
        expect(store.runs).toHaveLength(0);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    // Guards: the GET /api/usage contract the panel's spend readout consumes.
    it('GET /api/usage returns the spend summary', async () => {
        const { deps, spendGuard } = guardedDeps();
        const app = testServer(deps);
        const res = await app.inject({ method: 'GET', url: '/api/usage' });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual(spendGuard.summary);
    });

    // Guards: the scaffold breaking when Postgres is not configured — 503, not a crash.
    it('GET /api/usage answers 503 store_not_configured without deps', async () => {
        const app = testServer();
        const res = await app.inject({ method: 'GET', url: '/api/usage' });
        expect(res.statusCode).toBe(503);
        expect(res.json()).toEqual({ error: 'store_not_configured' });
    });
});

describe('overview routes (deterministic landing page)', () => {
    function overviewDeps() {
        const store = new FakeStore(seededBundle());
        const { extractor } = dispatchingExtractor({ facts: [], contradictions: [] });
        const deps: PrepRouteDeps = {
            store,
            source: new StoreDocumentSource(store, corpusDb),
            extractor,
            clock: () => NOW,
        };
        return { deps, store };
    }

    // Guards: the day-schedule sidebar contract — patients with their demographics
    // (appointment date/time live there) straight from the store.
    it('GET /api/patients lists patients with demographics', async () => {
        const { deps } = overviewDeps();
        const res = await testServer(deps).inject({ method: 'GET', url: '/api/patients' });
        expect(res.statusCode).toBe(200);
        const { patients } = res.json() as { patients: { id: string; demographics: Record<string, unknown> }[] };
        expect(patients[0]!.id).toBe(PATIENT_ID);
        expect(patients[0]!.demographics['appointment_time']).toBe('08:00');
    });

    // Guards: THE realignment invariant — the landing page renders complete clinical
    // content (meds + deterministic risk flags, imaging analytics, contradictions,
    // document metadata) from the seeded store with zero LLM calls.
    it('GET /api/overview serves the full landing page with no LLM in the path', async () => {
        const { deps } = overviewDeps();
        const res = await testServer(deps).inject({ method: 'GET', url: `/api/overview/${PATIENT_ID}` });
        expect(res.statusCode).toBe(200);
        const overview = res.json() as Record<string, any>;
        expect(overview.patient.name).toBe(corpus['patient'].name);
        expect(overview.facts_by_type.medication.length).toBeGreaterThan(0);
        expect(overview.facts_by_type.chief_complaint).toHaveLength(1);
        // The HCQ >= 5 years AAO branch must fire deterministically at the corpus NOW.
        const flagText = JSON.stringify(overview.medication_risk_flags);
        expect(overview.medication_risk_flags.length).toBeGreaterThan(0);
        expect(flagText.toLowerCase()).toContain('hydroxychloroquine');
        expect(overview.imaging.hcq_progression.alert_level).not.toBeNull();
        expect(overview.imaging.timeline_summary.length).toBe(corpus['images'].length);
        // R3: the Diagnosis & Care tab renders from this deterministic block on first load.
        expect(overview.care_plan.active_condition_fact_ids.length).toBeGreaterThan(0);
        expect(overview.care_plan.monitoring.length).toBeGreaterThan(0);
        expect(overview.care_plan.monitoring[0].text.length).toBeGreaterThan(0);
        expect(overview.documents).toHaveLength(12);
        // Metadata only — full text loads via /api/facts when the viewer opens.
        expect(overview.documents[0].content).toBeUndefined();
        expect(overview.latest_brief).toBeNull();
        expect(overview.generated_at).toBe(NOW.toISOString());
    });

    // Guards: the AI-insights card contract — once a brief exists it is referenced,
    // never inlined (the landing page stays deterministic either way).
    it('GET /api/overview references the latest brief when one exists', async () => {
        const { deps, store } = overviewDeps();
        await store.saveBrief({ patient_id: PATIENT_ID, correlation_id: 'corr-b', content: {} });
        const overview = (
            await testServer(deps).inject({ method: 'GET', url: `/api/overview/${PATIENT_ID}` })
        ).json() as Record<string, any>;
        expect(overview.latest_brief.id).toBe('brief-1');
    });

    // Guards: the scaffold contract — 404 for unknown patients, 503 without a store.
    it('answers 404 for an unknown patient and 503 without deps', async () => {
        const { deps } = overviewDeps();
        expect((await testServer(deps).inject({ method: 'GET', url: '/api/overview/nobody' })).statusCode).toBe(404);
        expect((await testServer().inject({ method: 'GET', url: '/api/overview/x' })).statusCode).toBe(503);
        expect((await testServer().inject({ method: 'GET', url: '/api/patients' })).statusCode).toBe(503);
    });
});

describe('/ready postgres probe', () => {
    // Guards: /ready reporting postgres ok without actually probing the pool.
    it('reports ok when the injected SELECT 1 probe succeeds', async () => {
        const { deps } = routeDeps();
        const app = testServer(deps, async () => {});
        const res = await app.inject({ method: 'GET', url: '/ready' });
        expect(res.statusCode).toBe(200);
        expect(res.json().dependencies.postgres.status).toBe('ok');
    });

    // Guards: a dead database passing readiness — a failing probe must flip /ready to 503.
    it('fails readiness when the postgres probe rejects', async () => {
        const { deps } = routeDeps();
        const app = testServer(deps, async () => {
            throw new Error('connection refused');
        });
        const res = await app.inject({ method: 'GET', url: '/ready' });
        expect(res.statusCode).toBe(503);
        expect(res.json().dependencies.postgres.status).toBe('failed');
    });

    // Guards: the scaffold regressing to a hardcoded not_configured postgres check.
    it('stays not_configured without deps', async () => {
        const app = testServer();
        const res = await app.inject({ method: 'GET', url: '/ready' });
        expect(res.json().dependencies.postgres.status).toBe('not_configured');
    });
});

describe('buildDeps', () => {
    // Guards: deps being built (and a Pool opened) when DATABASE_URL is absent.
    it('returns undefined without DATABASE_URL', () => {
        expect(buildDeps(loadConfig({ NODE_ENV: 'test' }))).toBeUndefined();
    });

    // Guards: the wiring — a configured DATABASE_URL must yield the store-backed deps.
    it('wires the store-backed deps when DATABASE_URL is configured', () => {
        const deps = buildDeps(
            loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://user:pass@localhost:5432/copilot' }),
        );
        expect(deps).toBeDefined();
        expect(deps!.prep.store).toBeInstanceOf(FactStore);
        expect(deps!.prep.source).toBeInstanceOf(StoreDocumentSource);
        expect(typeof deps!.checkPostgres).toBe('function');
    });
});
