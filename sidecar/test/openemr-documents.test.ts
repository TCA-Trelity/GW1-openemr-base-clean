// Wave 0.2 (REQ S1/R1, G7 contract test): the OpenEMR documents surface — upload with
// caller-side sha3-512 dedupe (OpenEMR stores the hash but does not enforce uniqueness)
// and category listing. All fetch calls mocked to the REAL server shapes learned from
// the 2026-07-15 live incident (the earlier {data:…} envelope mocks pinned a wrong
// contract, which is why tests passed while live 404'd):
//   - GET listing returns a RAW rows array; an EMPTY category is a 404 (Response('', 404))
//   - POST returns literal `true` — no document id
//   - the category wire format is underscores ('Lab_Report'), never spaces
//   - a mis-resolved category still 200s while orphaning the document, so the client
//     verifies every write by re-listing and matching its sha3-512 hash
import { describe, expect, it, vi } from 'vitest';
import { sha3_512Hex, StandardApiClient, StandardApiError } from '../src/openemr/standardApi.js';

const PDF_BYTES = new TextEncoder().encode('%PDF-1.4 fake renal panel');
const PDF_HASH = sha3_512Hex(PDF_BYTES);
const MARGARET_UUID = 'a2381b45-6c5b-4261-86a1-c950b0bf9058';

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** OpenEMR's empty-category (and invalid-path) response: bare 404, empty body. */
function emptyCategory404(): Response {
    return new Response('', { status: 404 });
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
    it('GETs the underscore wire format and maps the raw rows array', async () => {
        const fetchImpl = vi.fn(async (url: string) => {
            expect(url).toBe('https://emr.example.test/apis/default/api/patient/42/document?path=Lab_Report');
            return jsonResponse(200, [
                { id: 7, filename: 'renal-panel.pdf', hash: PDF_HASH, mimetype: 'application/pdf', docdate: '2024-12-20' },
                { filename: 'row-with-no-id.pdf' }, // malformed row → dropped, not crashed
            ]);
        });
        const rows = await client(fetchImpl).listPatientDocuments(42, 'Lab Report');
        expect(rows).toEqual([
            { id: '7', filename: 'renal-panel.pdf', hash: PDF_HASH, mimetype: 'application/pdf', docdate: '2024-12-20' },
        ]);
        const init = fetchImpl.mock.calls[0]?.[1];
        expect((init?.headers as Record<string, string>)['authorization']).toBe('Bearer user-token-abc');
        expect((init?.headers as Record<string, string>)['x-correlation-id']).toBe('corr-w2-test');
    });

    it('treats 404 as an empty category (OpenEMR 404s empty listings by design)', async () => {
        const fetchImpl = vi.fn(async () => emptyCategory404());
        await expect(client(fetchImpl).listPatientDocuments(42, 'Lab Report')).resolves.toEqual([]);
    });

    it('normalizes multi-word categories (Patient Information → Patient_Information)', async () => {
        const fetchImpl = vi.fn(async (url: string) => {
            expect(url).toContain('/patient/42/document?path=Patient_Information');
            return emptyCategory404();
        });
        await client(fetchImpl).listPatientDocuments(42, 'Patient Information');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('still throws on auth failures — only 404 is tolerated', async () => {
        const fetchImpl = vi.fn(async () => jsonResponse(401, { error: 'insufficient scope' }));
        await expect(client(fetchImpl).listPatientDocuments(42, 'Lab Report')).rejects.toSatisfy(
            (error: unknown) => error instanceof StandardApiError && error.kind === 'auth',
        );
    });
});

describe('uploadPatientDocumentDeduped', () => {
    it('short-circuits on a byte-identical existing document — no POST is made', async () => {
        const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
            expect(init?.method ?? 'GET').toBe('GET'); // the only call allowed is the listing
            expect(url).toContain('/patient/42/document?path=Lab_Report');
            return jsonResponse(200, [{ id: 7, filename: 'renal-panel.pdf', hash: PDF_HASH }]);
        });
        const result = await client(fetchImpl).uploadPatientDocumentDeduped(42, 'Lab Report', 'renal-panel.pdf', PDF_BYTES, 'application/pdf');
        expect(result).toEqual({ documentId: '7', hash: PDF_HASH, deduped: true });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('POSTs multipart with field name `document`, then verifies the write and returns the listed id', async () => {
        const calls: { url: string; init?: RequestInit }[] = [];
        const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
            calls.push({ url, init });
            if ((init?.method ?? 'GET') === 'GET') {
                // First listing: empty category (404). Verification listing: our row.
                return calls.filter((c) => (c.init?.method ?? 'GET') === 'GET').length === 1
                    ? emptyCategory404()
                    : jsonResponse(200, [{ id: 91, filename: 'renal-panel.pdf', hash: PDF_HASH, mimetype: 'application/pdf' }]);
            }
            return jsonResponse(200, true); // the real POST body: literal true, no id
        });
        const result = await client(fetchImpl).uploadPatientDocumentDeduped(42, 'Lab Report', 'renal-panel.pdf', PDF_BYTES, 'application/pdf');
        expect(result).toEqual({ documentId: '91', hash: PDF_HASH, deduped: false });

        expect(calls.map((c) => `${c.init?.method ?? 'GET'} ${c.url}`)).toEqual([
            'GET https://emr.example.test/apis/default/api/patient/42/document?path=Lab_Report',
            'POST https://emr.example.test/apis/default/api/patient/42/document?path=Lab_Report',
            'GET https://emr.example.test/apis/default/api/patient/42/document?path=Lab_Report',
        ]);
        const post = calls[1];
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

    it('throws instead of reporting a half-ingested upload when the write is not filed', async () => {
        // POST "succeeds" (OpenEMR 200s even when the category mis-resolved and the
        // document was orphaned) but the verification listing never shows our hash.
        const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
            (init?.method ?? 'GET') === 'GET' ? emptyCategory404() : jsonResponse(200, true),
        );
        await expect(
            client(fetchImpl).uploadPatientDocumentDeduped(42, 'Lab Report', 'renal-panel.pdf', PDF_BYTES, 'application/pdf'),
        ).rejects.toThrow(/half-ingested/);
    });

    it('surfaces auth failures (401 → kind auth: fix scopes/registration, the 0.2 live checklist)', async () => {
        const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
            (init?.method ?? 'GET') === 'GET' ? emptyCategory404() : jsonResponse(401, { error: 'insufficient scope' }),
        );
        await expect(
            client(fetchImpl).uploadPatientDocumentDeduped(42, 'Lab Report', 'x.pdf', PDF_BYTES, 'application/pdf'),
        ).rejects.toSatisfy((error: unknown) => error instanceof StandardApiError && error.kind === 'auth');
    });
});

// The document routes take the NUMERIC pid; OpenEMR silently files anything else to
// patient 0 (Document.class.php:93-103 reassigns a non-numeric id to 0, POST still 200s).
// These tests pin the client-side uuid → pid resolution that prevents that. Note the
// patient lookup route (GET /api/patient/:puuid) IS enveloped ({data: …}) — only the
// document routes are raw.
describe('uuid → numeric pid resolution', () => {
    const patientEnvelope = jsonResponse.bind(null, 200, {
        validationErrors: [],
        internalErrors: [],
        data: { uuid: MARGARET_UUID, pid: 3, fname: 'Margaret', lname: 'Chen', DOB: '1952-03-14' },
    });

    it('resolves a uuid via GET /api/patient/:puuid and uses the numeric pid in document paths', async () => {
        const calls: string[] = [];
        const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
            calls.push(`${init?.method ?? 'GET'} ${url}`);
            if (url.endsWith(`/patient/${MARGARET_UUID}`)) {
                return patientEnvelope();
            }
            if ((init?.method ?? 'GET') === 'GET') {
                return calls.filter((c) => c.includes('/document')).length <= 1
                    ? emptyCategory404()
                    : jsonResponse(200, [{ id: 91, filename: 'renal.pdf', hash: PDF_HASH }]);
            }
            return jsonResponse(200, true);
        });
        const result = await client(fetchImpl).uploadPatientDocumentDeduped(MARGARET_UUID, 'Lab Report', 'renal.pdf', PDF_BYTES, 'application/pdf');
        expect(result).toEqual({ documentId: '91', hash: PDF_HASH, deduped: false });
        expect(calls).toEqual([
            `GET https://emr.example.test/apis/default/api/patient/${MARGARET_UUID}`,
            'GET https://emr.example.test/apis/default/api/patient/3/document?path=Lab_Report',
            'POST https://emr.example.test/apis/default/api/patient/3/document?path=Lab_Report',
            'GET https://emr.example.test/apis/default/api/patient/3/document?path=Lab_Report',
        ]);
    });

    it('caches the resolution — repeat calls for the same uuid do not re-fetch the patient', async () => {
        const fetchImpl = vi.fn(async (url: string) =>
            url.endsWith(`/patient/${MARGARET_UUID}`) ? patientEnvelope() : emptyCategory404(),
        );
        const api = client(fetchImpl);
        await api.listPatientDocuments(MARGARET_UUID, 'Lab Report');
        await api.listPatientDocuments(MARGARET_UUID, 'Lab Report');
        const patientLookups = fetchImpl.mock.calls.filter(([url]) => (url as string).endsWith(`/patient/${MARGARET_UUID}`));
        expect(patientLookups).toHaveLength(1);
    });

    it('refuses an id that is neither numeric nor a uuid instead of filing to patient 0', async () => {
        const fetchImpl = vi.fn();
        await expect(client(fetchImpl).listPatientDocuments('margaret-chen', 'Lab Report')).rejects.toThrow(/patient 0/);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('fails loud when the patient record carries no numeric pid', async () => {
        const fetchImpl = vi.fn(async () => jsonResponse(200, { data: { uuid: MARGARET_UUID } }));
        await expect(client(fetchImpl).listPatientDocuments(MARGARET_UUID, 'Lab Report')).rejects.toThrow(/no numeric pid/);
    });
});

describe('sha3_512Hex', () => {
    it('matches OpenEMR: 128 hex chars, deterministic, content-sensitive', () => {
        expect(PDF_HASH).toMatch(/^[0-9a-f]{128}$/);
        expect(sha3_512Hex(PDF_BYTES)).toBe(PDF_HASH);
        expect(sha3_512Hex(new TextEncoder().encode('different'))).not.toBe(PDF_HASH);
    });
});
