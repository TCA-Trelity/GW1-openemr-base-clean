// A.3 route contract (REQ S1/R1, G16 seed): multipart upload → 202 + status URL; bad
// doc_type/mime rejected with structured errors; status + list routes serve the record;
// evidence search route applies the retrieval stack (scrub + floor) over HTTP.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { VlmExtractor } from '../src/ingest/extractor.js';
import { IngestionService, MemoryIngestionRecordStore } from '../src/ingest/service.js';
import type { AnthropicCompletion } from '../src/prep/anthropic.js';
import { HashEmbeddings } from '../src/retrieval/embeddings.js';
import { PassthroughReranker } from '../src/retrieval/rerank.js';
import { HybridRetriever, loadCorpusChunks } from '../src/retrieval/retriever.js';
import { buildServer } from '../src/server.js';

const FIXTURES = fileURLToPath(new URL('../eval/fixtures/documents/', import.meta.url));
const CORPUS = fileURLToPath(new URL('../corpus/', import.meta.url));
const pdfBytes = readFileSync(`${FIXTURES}renal-panel-clean.pdf`);

const VALID_LAB_JSON = JSON.stringify({
    doc_type: 'lab_pdf',
    document_patient: null,
    performing_lab: null,
    collection_date: '2024-12-20',
    collection_date_citation: null,
    results: [{ test_name: 'eGFR', value: '42', value_numeric: 42, unit: null, reference_range: null, abnormal_flag: 'low', citation: { page: 1, bbox: null, quote: 'eGFR (CKD-EPI) 42', grounding: 'page' } }],
});

function stubVlm() {
    return {
        complete: vi.fn(async (): Promise<AnthropicCompletion> => ({
            text: VALID_LAB_JSON,
            citations: [],
            tool_uses: [],
            usage: { input_tokens: 500, output_tokens: 100 },
            stop_reason: 'end_turn',
            model: 'stub',
        })),
    };
}

function multipart(fields: Record<string, string>, file: { name: string; filename: string; contentType: string; data: Buffer }) {
    const boundary = '----w2boundary42';
    const parts: Buffer[] = [];
    for (const [name, value] of Object.entries(fields)) {
        parts.push(Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    }
    parts.push(
        Buffer.from(
            `--${boundary}\r\ncontent-disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\ncontent-type: ${file.contentType}\r\n\r\n`,
        ),
        file.data,
        Buffer.from(`\r\n--${boundary}--\r\n`),
    );
    return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function makeApp() {
    const records = new MemoryIngestionRecordStore();
    const service = new IngestionService({ extractor: new VlmExtractor(stubVlm()), records });
    const retriever = await HybridRetriever.build(loadCorpusChunks(CORPUS), {
        embeddings: new HashEmbeddings(),
        reranker: new PassthroughReranker(),
    });
    const config = loadConfig({ NODE_ENV: 'test' });
    const app = buildServer(config, {
        checkPostgres: async () => undefined,
        runMigrations: async () => [],
        prep: {} as never, // prep/overview/chat routes 503 without a store — not under test here
        overview: {} as never,
        chat: {} as never,
        ingest: { service, records },
        evidence: { retriever },
    });
    return app;
}

describe('POST /api/patients/:patientId/documents', () => {
    it('accepts a lab PDF and returns 202 with a pollable status URL', async () => {
        const app = await makeApp();
        const { payload, headers } = multipart({ doc_type: 'lab_pdf' }, { name: 'file', filename: 'renal.pdf', contentType: 'application/pdf', data: pdfBytes });
        const response = await app.inject({ method: 'POST', url: '/api/patients/margaret-chen/documents', payload, headers });
        expect(response.statusCode).toBe(202);
        const body = response.json() as { ingestion_id: string | null; status_url: string | null; correlation_id: string };
        expect(body.correlation_id).toBeTruthy();
        expect(body.ingestion_id).toMatch(/^ing-/);
        const status = await app.inject({ method: 'GET', url: body.status_url! });
        expect(status.statusCode).toBe(200);
        expect((status.json() as { patient_id: string }).patient_id).toBe('margaret-chen');
        await app.close();
    });

    it('rejects unknown doc_type and unsupported mime with structured 4xx', async () => {
        const app = await makeApp();
        const bad = multipart({ doc_type: 'referral_fax' }, { name: 'file', filename: 'x.pdf', contentType: 'application/pdf', data: pdfBytes });
        expect((await app.inject({ method: 'POST', url: '/api/patients/p/documents', ...bad })).statusCode).toBe(400);
        const badMime = multipart({ doc_type: 'lab_pdf' }, { name: 'file', filename: 'x.gif', contentType: 'image/gif', data: Buffer.from('GIF89a') });
        expect((await app.inject({ method: 'POST', url: '/api/patients/p/documents', ...badMime })).statusCode).toBe(415);
        await app.close();
    });
});

describe('POST /api/evidence/search', () => {
    it('serves grounded snippets for an in-corpus query and empty for out-of-domain', async () => {
        const app = await makeApp();
        const hit = await app.inject({
            method: 'POST',
            url: '/api/evidence/search',
            payload: { q: 'hydroxychloroquine screening interval renal impairment' },
        });
        expect(hit.statusCode).toBe(200);
        const hitBody = hit.json() as { empty: boolean; snippets: { doc_id: string }[] };
        expect(hitBody.empty).toBe(false);
        expect(['hcq-screening', 'renal-function-ocular-drug-safety']).toContain(hitBody.snippets[0]?.doc_id);

        const miss = await app.inject({ method: 'POST', url: '/api/evidence/search', payload: { q: 'knee replacement rehabilitation protocol' } });
        expect((miss.json() as { empty: boolean }).empty).toBe(true);
        await app.close();
    });
});
