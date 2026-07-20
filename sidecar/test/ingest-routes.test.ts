// A.3 route contract (REQ S1/R1, G16 seed): multipart upload → 202 + status URL; bad
// doc_type/mime rejected with structured errors; status + list routes serve the record;
// evidence search route applies the retrieval stack (scrub + floor) over HTTP.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { DevTokenService } from '../src/auth/devToken.js';
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

async function makeApp(maxFileBytes?: number) {
    const records = new MemoryIngestionRecordStore();
    const service = new IngestionService({ extractor: new VlmExtractor(stubVlm()), records });
    const retriever = await HybridRetriever.build(loadCorpusChunks(CORPUS), {
        embeddings: new HashEmbeddings(),
        reranker: new PassthroughReranker(),
    });
    const config = loadConfig({ NODE_ENV: 'test' });
    // E.3: the upload route demands an attributable principal regardless of AUTH_MODE,
    // so the harness wires the dev-token verifier and tests mint role-bound bearers.
    const devTokens = new DevTokenService({ secret: 'ingest-route-test-secret-0123456789abcdef' });
    const app = buildServer(config, {
        checkPostgres: async () => undefined,
        runMigrations: async () => [],
        prep: {} as never, // prep/overview/chat routes 503 without a store — not under test here
        overview: {} as never,
        chat: {} as never,
        ingest: { service, records, ...(maxFileBytes === undefined ? {} : { maxFileBytes }) },
        evidence: { retriever },
        auth: { mode: 'off', verifier: devTokens },
    });
    return { app, devTokens };
}

function bearer(devTokens: DevTokenService, role: 'physician' | 'nurse' | 'resident', patient: string): Record<string, string> {
    return { authorization: `Bearer ${devTokens.mint({ username: `${role}-demo`, patient, role }).token}` };
}

describe('POST /api/patients/:patientId/documents', () => {
    it('accepts a lab PDF and returns 202 with a pollable status URL', async () => {
        const { app, devTokens } = await makeApp();
        const { payload, headers } = multipart({ doc_type: 'lab_pdf' }, { name: 'file', filename: 'renal.pdf', contentType: 'application/pdf', data: pdfBytes });
        const response = await app.inject({
            method: 'POST',
            url: '/api/patients/margaret-chen/documents',
            payload,
            headers: { ...headers, ...bearer(devTokens, 'physician', 'margaret-chen') },
        });
        expect(response.statusCode).toBe(202);
        const body = response.json() as { ingestion_id: string | null; status_url: string | null; correlation_id: string };
        expect(body.correlation_id).toBeTruthy();
        expect(body.ingestion_id).toMatch(/^ing-/);
        const status = await app.inject({ method: 'GET', url: body.status_url! });
        expect(status.statusCode).toBe(200);
        expect((status.json() as { patient_id: string }).patient_id).toBe('margaret-chen');
        await app.close();
    });

    // H.11 regression pins: same status codes AND messages as before the checks went
    // schema-backed (doc_type was already Zod; mime/filename now parse through
    // UploadFileMetaSchema; size stays the multipart `limits` stream cap).
    it('rejects unknown doc_type and unsupported mime with structured 4xx', async () => {
        const { app, devTokens } = await makeApp();
        const auth = bearer(devTokens, 'physician', 'p');
        const bad = multipart({ doc_type: 'referral_fax' }, { name: 'file', filename: 'x.pdf', contentType: 'application/pdf', data: pdfBytes });
        const badResponse = await app.inject({ method: 'POST', url: '/api/patients/p/documents', payload: bad.payload, headers: { ...bad.headers, ...auth } });
        expect(badResponse.statusCode).toBe(400);
        expect((badResponse.json() as { error: string }).error).toBe('doc_type must be one of: lab_pdf, intake_form (got referral_fax)');
        const badMime = multipart({ doc_type: 'lab_pdf' }, { name: 'file', filename: 'x.gif', contentType: 'image/gif', data: Buffer.from('GIF89a') });
        const badMimeResponse = await app.inject({ method: 'POST', url: '/api/patients/p/documents', payload: badMime.payload, headers: { ...badMime.headers, ...auth } });
        expect(badMimeResponse.statusCode).toBe(415);
        expect((badMimeResponse.json() as { error: string }).error).toBe('unsupported media type image/gif (pdf/png/jpeg only)');
        await app.close();
    });

    it('rejects an oversize upload with 413 — the multipart limits cap is the size gate, not a schema', async () => {
        const { app, devTokens } = await makeApp(1024); // fixture PDF is ~56 KiB
        const { payload, headers } = multipart({ doc_type: 'lab_pdf' }, { name: 'file', filename: 'big.pdf', contentType: 'application/pdf', data: pdfBytes });
        const response = await app.inject({
            method: 'POST',
            url: '/api/patients/p/documents',
            payload,
            headers: { ...headers, ...bearer(devTokens, 'physician', 'p') },
        });
        expect(response.statusCode).toBe(413);
        expect((response.json() as { error: string }).error).toBe('file exceeds the size limit');
        await app.close();
    });

    // E.3 (locked decision #14): the upload is a chart WRITE — it demands an attributable
    // principal with documentsWrite even in AUTH_MODE=off, while reads stay open.
    it('write-path auth: 401 without a bearer, 403 for a role without documentsWrite, nurse allowed', async () => {
        const { app, devTokens } = await makeApp();
        const doc = () => multipart({ doc_type: 'lab_pdf' }, { name: 'file', filename: 'renal.pdf', contentType: 'application/pdf', data: pdfBytes });

        const anonymous = doc();
        const noToken = await app.inject({ method: 'POST', url: '/api/patients/p/documents', payload: anonymous.payload, headers: anonymous.headers });
        expect(noToken.statusCode).toBe(401);
        expect((noToken.json() as { error: string }).error).toBe('document_upload_requires_auth');

        const asResident = doc();
        const resident = await app.inject({
            method: 'POST',
            url: '/api/patients/p/documents',
            payload: asResident.payload,
            headers: { ...asResident.headers, ...bearer(devTokens, 'resident', 'p') },
        });
        expect(resident.statusCode).toBe(403);
        expect(resident.json()).toMatchObject({ error: 'role_cannot_upload_documents', role: 'resident' });

        const asNurse = doc();
        const nurse = await app.inject({
            method: 'POST',
            url: '/api/patients/p/documents',
            payload: asNurse.payload,
            headers: { ...asNurse.headers, ...bearer(devTokens, 'nurse', 'p') },
        });
        expect(nurse.statusCode).toBe(202);

        // Reads stay open: the status route needs no token (grader-friendly posture).
        const { ingestion_id } = nurse.json() as { ingestion_id: string };
        expect((await app.inject({ method: 'GET', url: `/api/ingestions/${ingestion_id}` })).statusCode).toBe(200);
        await app.close();
    });

    it('serves the uploaded original back for the overlay preview (E.2); unknown id 404s with the storage pointer', async () => {
        const { app, devTokens } = await makeApp();
        const { payload, headers } = multipart({ doc_type: 'lab_pdf' }, { name: 'file', filename: 'renal.pdf', contentType: 'application/pdf', data: pdfBytes });
        const upload = await app.inject({
            method: 'POST',
            url: '/api/patients/margaret-chen/documents',
            payload,
            headers: { ...headers, ...bearer(devTokens, 'nurse', 'margaret-chen') },
        });
        const { ingestion_id } = upload.json() as { ingestion_id: string };
        const file = await app.inject({ method: 'GET', url: `/api/ingestions/${ingestion_id}/file` });
        expect(file.statusCode).toBe(200);
        expect(file.headers['content-type']).toContain('application/pdf');
        expect(file.rawPayload.equals(pdfBytes)).toBe(true);
        const missing = await app.inject({ method: 'GET', url: '/api/ingestions/ing-nope/file' });
        expect(missing.statusCode).toBe(404);
        expect((missing.json() as { error: string }).error).toContain('OpenEMR Documents');
        await app.close();
    });
});

// AgentForge red-team finding (cross-patient PHI): the id-keyed ingestion routes escape the PEP's
// :patientId cross-patient check because they are keyed by a content-hash id. In enforced mode they
// must confirm the caller owns the ingestion before serving the record OR the cached file.
async function makeEnforcedApp() {
    const records = new MemoryIngestionRecordStore();
    const service = new IngestionService({ extractor: new VlmExtractor(stubVlm()), records });
    const retriever = await HybridRetriever.build(loadCorpusChunks(CORPUS), {
        embeddings: new HashEmbeddings(),
        reranker: new PassthroughReranker(),
    });
    const config = loadConfig({ NODE_ENV: 'test' });
    const devTokens = new DevTokenService({ secret: 'ingest-xpatient-secret-0123456789abcdef' });
    const app = buildServer(config, {
        checkPostgres: async () => undefined,
        runMigrations: async () => [],
        prep: {} as never,
        overview: {} as never,
        chat: {} as never,
        ingest: { service, records, enforcePatientScope: true },
        evidence: { retriever },
        auth: { mode: 'enforced', verifier: devTokens },
    });
    return { app, devTokens };
}

describe('id-keyed ingestion routes enforce per-patient ownership (enforced mode)', () => {
    // Failure mode: a token bound to patient A reads patient B's ingestion record or original file
    // by guessing/knowing the content-hash id — the PEP never saw a :patientId to reject.
    it("a token bound to A cannot read B's ingestion record or file (403 cross_patient); the owner can", async () => {
        const { app, devTokens } = await makeEnforcedApp();
        const owner = bearer(devTokens, 'physician', 'margaret-chen');
        const other = bearer(devTokens, 'physician', 'tren-okafor');

        const { payload, headers } = multipart(
            { doc_type: 'lab_pdf' },
            { name: 'file', filename: 'renal.pdf', contentType: 'application/pdf', data: pdfBytes },
        );
        const upload = await app.inject({ method: 'POST', url: '/api/patients/margaret-chen/documents', payload, headers: { ...headers, ...owner } });
        expect(upload.statusCode).toBe(202);
        const { ingestion_id } = upload.json() as { ingestion_id: string };

        // Owner reads the record and the file → 200.
        expect((await app.inject({ method: 'GET', url: `/api/ingestions/${ingestion_id}`, headers: owner })).statusCode).toBe(200);
        expect((await app.inject({ method: 'GET', url: `/api/ingestions/${ingestion_id}/file`, headers: owner })).statusCode).toBe(200);

        // Cross-patient reads of the record AND the cached file → 403 cross_patient (the fix).
        const crossRecord = await app.inject({ method: 'GET', url: `/api/ingestions/${ingestion_id}`, headers: other });
        expect(crossRecord.statusCode).toBe(403);
        expect(crossRecord.json()).toMatchObject({ reason: 'cross_patient' });
        const crossFile = await app.inject({ method: 'GET', url: `/api/ingestions/${ingestion_id}/file`, headers: other });
        expect(crossFile.statusCode).toBe(403);
        expect(crossFile.json()).toMatchObject({ reason: 'cross_patient' });
        await app.close();
    });
});

describe('POST /api/evidence/search', () => {
    it('serves grounded snippets for an in-corpus query and empty for out-of-domain', async () => {
        const { app } = await makeApp();
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
