// Wave 0.2 (REQ S1/R1, G7 contract test): the OpenEMR documents surface — upload with
// caller-side sha3-512 dedupe (OpenEMR stores the hash but does not enforce uniqueness)
// and category listing. All fetch calls mocked: this pins OUR contract with the standard
// API (route shape, multipart field name, bearer + correlation headers, envelope
// parsing); the live round-trip against a running OpenEMR is the Wave 0.2 deploy step.
import { describe, expect, it, vi } from 'vitest';
import { sha3_512Hex, StandardApiClient, StandardApiError } from '../src/openemr/standardApi.js';

const PDF_BYTES = new TextEncoder().encode('%PDF-1.4 fake renal panel');
const PDF_HASH = sha3_512Hex(PDF_BYTES);

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function client(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>): StandardApiClient {
    return new StandardApiClient({
        baseUrl: 'https://emr.example.test/',
        tokenProvider: { getAccessToken: async () => 'user-token-abc' },
        fetchImpl,
        correlationId: 'corr-w2-test',
    });
}

describe('listPatientDocuments', () => {
    it('GETs the category path and maps rows (id, filename, hash, mimetype, docdate)', async () => {
        const fetchImpl = vi.fn(async (url: string) => {
            expect(url).toBe('https://emr.example.test/apis/default/api/patient/42/document?path=Lab%20Report');
            return jsonResponse(200, {
                validationErrors: [],
                internalErrors: [],
                data: [
                    { id: 7, filename: 'renal-panel.pdf', hash: PDF_HASH, mimetype: 'application/pdf', docdate: '2024-12-20' },
                    { filename: 'row-with-no-id.pdf' }, // malformed row → dropped, not crashed
                ],
            });
        });
        const rows = await client(fetchImpl).listPatientDocuments(42, 'Lab Report');
        expect(rows).toEqual([
            { id: '7', filename: 'renal-panel.pdf', hash: PDF_HASH, mimetype: 'application/pdf', docdate: '2024-12-20' },
        ]);
        const init = fetchImpl.mock.calls[0]?.[1];
        expect((init?.headers as Record<string, string>)['authorization']).toBe('Bearer user-token-abc');
        expect((init?.headers as Record<string, string>)['x-correlation-id']).toBe('corr-w2-test');
    });
});

describe('uploadPatientDocumentDeduped', () => {
    it('short-circuits on a byte-identical existing document — no POST is made', async () => {
        const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
            expect(init?.method ?? 'GET').toBe('GET'); // the only call allowed is the listing
            expect(url).toContain('/patient/42/document?path=');
            return jsonResponse(200, { data: [{ id: 7, filename: 'renal-panel.pdf', hash: PDF_HASH }] });
        });
        const result = await client(fetchImpl).uploadPatientDocumentDeduped(42, 'Lab Report', 'renal-panel.pdf', PDF_BYTES, 'application/pdf');
        expect(result).toEqual({ documentId: '7', hash: PDF_HASH, deduped: true });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('POSTs multipart with field name `document` when no duplicate exists', async () => {
        const calls: { url: string; init?: RequestInit }[] = [];
        const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
            calls.push({ url, init });
            if ((init?.method ?? 'GET') === 'GET') {
                return jsonResponse(200, { data: [] });
            }
            return jsonResponse(201, { validationErrors: [], internalErrors: [], data: { id: 91 } });
        });
        const result = await client(fetchImpl).uploadPatientDocumentDeduped(42, 'Lab Report', 'renal-panel.pdf', PDF_BYTES, 'application/pdf');
        expect(result).toEqual({ documentId: '91', hash: PDF_HASH, deduped: false });

        const post = calls[1];
        expect(post?.url).toBe('https://emr.example.test/apis/default/api/patient/42/document?path=Lab%20Report');
        expect(post?.init?.method).toBe('POST');
        const body = post?.init?.body;
        expect(body).toBeInstanceOf(FormData);
        const part = (body as FormData).get('document');
        expect(part).toBeInstanceOf(File);
        expect((part as File).name).toBe('renal-panel.pdf');
        expect((part as File).type).toBe('application/pdf');
        expect(new Uint8Array(await (part as File).arrayBuffer())).toEqual(PDF_BYTES);
        // No manual content-type: fetch must own the multipart boundary.
        expect((post?.init?.headers as Record<string, string>)['content-type']).toBeUndefined();
        expect((post?.init?.headers as Record<string, string>)['authorization']).toBe('Bearer user-token-abc');
    });

    it('surfaces auth failures (401 → kind auth: fix scopes/registration, the 0.2 live checklist)', async () => {
        const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
            (init?.method ?? 'GET') === 'GET'
                ? jsonResponse(200, { data: [] })
                : jsonResponse(401, { error: 'insufficient scope' }),
        );
        await expect(
            client(fetchImpl).uploadPatientDocumentDeduped(42, 'Lab Report', 'x.pdf', PDF_BYTES, 'application/pdf'),
        ).rejects.toSatisfy((error: unknown) => error instanceof StandardApiError && error.kind === 'auth');
    });
});

// The document routes take the NUMERIC pid; OpenEMR silently files anything else to
// patient 0 (Document.class.php:93-103 reassigns a non-numeric id to 0, POST still 200s).
// These tests pin the client-side uuid → pid resolution that prevents that.
describe('uuid → numeric pid resolution', () => {
    const UUID = 'a2381b45-6c5b-4261-86a1-c950b0bf9058';

    it('resolves a uuid via GET /api/patient/:puuid and files under the numeric pid', async () => {
        const calls: string[] = [];
        const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
            calls.push(`${init?.method ?? 'GET'} ${url}`);
            if (url.endsWith(`/patient/${UUID}`)) {
                return jsonResponse(200, { data: { uuid: UUID, pid: 3, fname: 'Margaret', lname: 'Chen', DOB: '1952-03-14' } });
            }
            if ((init?.method ?? 'GET') === 'GET') {
                return jsonResponse(200, { data: [] });
            }
            return jsonResponse(201, { data: { id: 91 } });
        });
        const result = await client(fetchImpl).uploadPatientDocumentDeduped(UUID, 'Lab Report', 'renal.pdf', PDF_BYTES, 'application/pdf');
        expect(result).toEqual({ documentId: '91', hash: PDF_HASH, deduped: false });
        expect(calls).toEqual([
            `GET https://emr.example.test/apis/default/api/patient/${UUID}`,
            'GET https://emr.example.test/apis/default/api/patient/3/document?path=Lab%20Report',
            'POST https://emr.example.test/apis/default/api/patient/3/document?path=Lab%20Report',
        ]);
    });

    it('caches the resolution — repeat calls for the same uuid do not re-fetch the patient', async () => {
        const fetchImpl = vi.fn(async (url: string) =>
            url.endsWith(`/patient/${UUID}`)
                ? jsonResponse(200, { data: { uuid: UUID, pid: 3, fname: 'Margaret', lname: 'Chen', DOB: '1952-03-14' } })
                : jsonResponse(200, { data: [] }),
        );
        const api = client(fetchImpl);
        await api.listPatientDocuments(UUID, 'Lab Report');
        await api.listPatientDocuments(UUID, 'Lab Report');
        const patientLookups = fetchImpl.mock.calls.filter(([url]) => (url as string).endsWith(`/patient/${UUID}`));
        expect(patientLookups).toHaveLength(1);
    });

    it('refuses an id that is neither numeric nor a uuid instead of filing to patient 0', async () => {
        const fetchImpl = vi.fn();
        await expect(client(fetchImpl).listPatientDocuments('margaret-chen', 'Lab Report')).rejects.toThrow(/patient 0/);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('fails loud when the patient record carries no numeric pid', async () => {
        const fetchImpl = vi.fn(async () => jsonResponse(200, { data: { uuid: UUID } }));
        await expect(client(fetchImpl).listPatientDocuments(UUID, 'Lab Report')).rejects.toThrow(/no numeric pid/);
    });
});

describe('sha3_512Hex', () => {
    it('matches OpenEMR: 128 hex chars, deterministic, content-sensitive', () => {
        expect(PDF_HASH).toMatch(/^[0-9a-f]{128}$/);
        expect(sha3_512Hex(PDF_BYTES)).toBe(PDF_HASH);
        expect(sha3_512Hex(new TextEncoder().encode('different'))).not.toBe(PDF_HASH);
    });
});
