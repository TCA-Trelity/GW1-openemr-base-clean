// Prep pipeline tests (S1.7): mocked-LLM fixtures built FROM the Margaret Chen seed
// corpus (so citations resolve against real document text) + an in-memory FactStore
// double — no Postgres, no live Anthropic. Each test names the failure mode it guards.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { AnthropicClient, type FetchLike } from '../src/prep/anthropic.js';
import { BriefContentSchema } from '../src/prep/brief.js';
import { ExtractionError, FactExtractor, type PrepLogger } from '../src/prep/extraction.js';
import { runPrep, type PrepDeps } from '../src/prep/pipeline.js';
import {
    FhirDocumentSource,
    StoreDocumentSource,
    type FhirReader,
    type SourceDocumentQuerier,
} from '../src/prep/sources.js';
import type { PrepRouteDeps, PrepRouteStore } from '../src/routes/prep.js';
import { ContradictionSchema, projectContradiction } from '../src/schemas/index.js';
import { buildDeps, buildServer, type AppDeps } from '../src/server.js';
import { FactStore, type BriefInput, type FactBundle, type PrepRunStatus, type StoredBrief } from '../src/store/index.js';

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

function llmResponse(payload: unknown): Response {
    return new Response(
        JSON.stringify({
            id: 'msg_test',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-5',
            content: [
                { type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) },
            ],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1200, output_tokens: 800 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
    );
}

function extractorWith(...responses: Response[]) {
    const fetchMock = vi.fn<FetchLike>();
    for (const response of responses) {
        fetchMock.mockResolvedValueOnce(response);
    }
    const client = new AnthropicClient({ apiKey: 'test-key', model: 'claude-sonnet-5', fetchImpl: fetchMock });
    return { extractor: new FactExtractor(client), fetchMock };
}

// ---- In-memory FactStore double (the minimal PrepRouteStore surface; no Postgres) ----

interface FakeRun {
    id: string;
    patientId: string;
    correlationId: string;
    status: 'running' | PrepRunStatus;
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
}

function corpusBundle(): FactBundle {
    return {
        patient: { id: PATIENT_ID, openemr_patient_id: null, name: corpus['patient'].name, demographics: {} },
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
    };
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
    const { extractor, fetchMock } = extractorWith(llmResponse(payload));
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

describe('FactExtractor', () => {
    // Guards: the extractor mangling or dropping schema-valid facts on the happy path.
    it('returns typed facts and contradictions from a schema-valid response', async () => {
        const { extractor, fetchMock } = extractorWith(
            llmResponse({ facts: corpusFacts(), contradictions: corpusContradictions() }),
        );
        const result = await extractor.extract(
            { patientId: PATIENT_ID, patientName: 'Margaret L. Chen', documents: [] },
            'corr-1',
            silentLogger,
        );
        expect(result.facts).toHaveLength(12);
        expect(result.contradictions).toHaveLength(4);
        expect(result.facts.every((fact) => fact.patient_id === PATIENT_ID)).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // Guards: silent drift off the Messages API contract (endpoint, auth headers, model,
    // and the sonnet-5 rule that non-default sampling params 400 — no temperature sent).
    it('sends the Messages API contract the live service expects', async () => {
        const { extractor, fetchMock } = extractorWith(llmResponse({ facts: [], contradictions: [] }));
        await extractor.extract(
            {
                patientId: PATIENT_ID,
                patientName: 'Margaret L. Chen',
                documents: [{ id: 'doc-x', document_type: 'referral_letter', document_date: '2024-12-15', text: 'UNIQUE-DOC-TEXT' }],
            },
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
        expect(body['model']).toBe('claude-sonnet-5');
        expect('temperature' in body).toBe(false);
        expect(body['system']).toContain('VERBATIM');
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
            llmResponse({ facts: invalid, contradictions: [] }),
            llmResponse({ facts: corpusFacts(), contradictions: [] }),
        );
        const result = await extractor.extract(
            { patientId: PATIENT_ID, patientName: null, documents: [] },
            'corr-retry',
            silentLogger,
        );
        expect(result.facts).toHaveLength(12);
        expect(fetchMock).toHaveBeenCalledTimes(2);
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
            extractor.extract({ patientId: PATIENT_ID, patientName: null, documents: [] }, 'corr-fail', silentLogger),
        ).rejects.toThrow(ExtractionError);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    // Guards: common model formatting drift — fenced JSON must still parse.
    it('accepts a markdown-fenced JSON response', async () => {
        const fenced = '```json\n' + JSON.stringify({ facts: [], contradictions: [] }) + '\n```';
        const { extractor } = extractorWith(llmResponse(fenced));
        const result = await extractor.extract(
            { patientId: PATIENT_ID, patientName: null, documents: [] },
            'corr-fence',
            silentLogger,
        );
        expect(result.facts).toHaveLength(0);
    });

    // Guards: cross-patient leakage — extracted items claiming another patient must fail.
    it('rejects extraction whose facts claim a different patient', async () => {
        const stray = corpusFacts().map((fact) => ({ ...fact, patient_id: 'someone-else' }));
        const { extractor } = extractorWith(
            llmResponse({ facts: stray, contradictions: [] }),
            llmResponse({ facts: stray, contradictions: [] }),
        );
        await expect(
            extractor.extract({ patientId: PATIENT_ID, patientName: null, documents: [] }, 'corr-stray', silentLogger),
        ).rejects.toThrow(/patient_id/);
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
    const { extractor } = extractorWith(llmResponse(payload));
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
        prep === undefined ? undefined : { checkPostgres: checkPostgres ?? (async () => {}), prep };
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
