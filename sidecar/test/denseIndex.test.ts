// B.3-live: dense-index backends. The pg tests run against a fake pool that records SQL —
// they pin the contract (stale-only embedding, upsert shape, orphan cleanup, degraded
// search) without needing a live pgvector database; the live path is verified on the
// deploy via the boot log (`denseBackend: 'pgvector'`) and `npm run corpus:index`.
import { describe, expect, it } from 'vitest';
import { InMemoryDenseIndex, PgVectorDenseIndex, type PgQueryable } from '../src/retrieval/denseIndex.js';
import type { EmbeddingsProvider } from '../src/retrieval/embeddings.js';

const CHUNKS = [
    { chunk_id: 'hcq-1', doc_id: 'hcq-screening', text: 'hydroxychloroquine dosing threshold five mg per kg' },
    { chunk_id: 'hcq-2', doc_id: 'hcq-screening', text: 'annual screening interval for high risk patients' },
];

function stubEmbeddings(calls: string[][]): EmbeddingsProvider {
    return {
        id: 'stub:embed-v1',
        dims: 3,
        embed: async (texts) => {
            calls.push([...texts]);
            return texts.map((_, i) => [1, i * 0.5, 0]);
        },
    };
}

class FakePool implements PgQueryable {
    queries: { text: string; values?: unknown[] }[] = [];

    constructor(
        private readonly responses: {
            present?: boolean;
            existing?: { chunk_id: string; content_hash: string }[];
            searchRows?: Record<string, unknown>[];
            searchError?: Error;
        } = {},
    ) {}

    async query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
        this.queries.push({ text, ...(values === undefined ? {} : { values }) });
        if (text.includes('to_regclass')) {
            return { rows: [{ present: this.responses.present ?? true }] };
        }
        if (text.startsWith('SELECT chunk_id, content_hash')) {
            return { rows: this.responses.existing ?? [] };
        }
        if (text.includes('DELETE FROM corpus_embeddings WHERE NOT')) {
            return { rows: [] };
        }
        if (text.includes('ORDER BY embedding <=>')) {
            if (this.responses.searchError !== undefined) {
                throw this.responses.searchError;
            }
            return { rows: this.responses.searchRows ?? [] };
        }
        return { rows: [] };
    }
}

describe('InMemoryDenseIndex', () => {
    it('returns top-k by cosine, deterministic tie-break on id', async () => {
        const index = new InMemoryDenseIndex(
            new Map([
                ['a', [1, 0, 0]],
                ['b', [0.5, 0.5, 0]],
                ['c', [0, 1, 0]],
            ]),
        );
        const hits = await index.search([1, 0, 0], 2, 'corr');
        expect(hits.map((h) => h.id)).toEqual(['a', 'b']);
        expect(index.backend).toBe('memory');
    });
});

describe('PgVectorDenseIndex', () => {
    it('sync embeds ONLY stale chunks and upserts with ::vector literals', async () => {
        const calls: string[][] = [];
        const provider = stubEmbeddings(calls);
        // hcq-1 already stored with the CURRENT hash (computed the same way as the index);
        // hcq-2 is missing → exactly one chunk gets embedded.
        const { createHash } = await import('node:crypto');
        const currentHash = createHash('sha256').update(`${provider.id}:${CHUNKS[0]!.text}`).digest('hex').slice(0, 32);
        const pool = new FakePool({ existing: [{ chunk_id: 'hcq-1', content_hash: currentHash }] });

        const index = await PgVectorDenseIndex.sync(pool, CHUNKS, provider, 'corr-sync');
        expect(index.backend).toBe('pgvector');
        expect(calls).toEqual([[CHUNKS[1]!.text]]); // only the stale chunk hit the API
        const upserts = pool.queries.filter((q) => q.text.includes('INSERT INTO corpus_embeddings'));
        expect(upserts).toHaveLength(1);
        expect(upserts[0]?.values?.[0]).toBe('hcq-2');
        expect(String(upserts[0]?.values?.[4])).toMatch(/^\[[-0-9.,]+\]$/); // vector literal
        const deletes = pool.queries.filter((q) => q.text.includes('DELETE FROM corpus_embeddings WHERE NOT'));
        expect(deletes).toHaveLength(1);
        expect(deletes[0]?.values?.[0]).toEqual(['hcq-1', 'hcq-2']); // keep-list, orphans go
    });

    it('sync throws when the table is absent (extensionless Postgres) so callers fall back', async () => {
        const pool = new FakePool({ present: false });
        await expect(PgVectorDenseIndex.sync(pool, CHUNKS, stubEmbeddings([]), 'corr')).rejects.toThrow(/corpus_embeddings table absent/);
    });

    it('search maps rows to hits via the <=> operator', async () => {
        const pool = new FakePool({
            searchRows: [
                { chunk_id: 'hcq-1', score: '0.91' },
                { chunk_id: 'hcq-2', score: '0.44' },
            ],
            existing: [],
        });
        const index = await PgVectorDenseIndex.sync(pool, [], stubEmbeddings([]), 'corr');
        const hits = await index.search([1, 0, 0], 5, 'corr-q');
        expect(hits).toEqual([
            { id: 'hcq-1', score: 0.91 },
            { id: 'hcq-2', score: 0.44 },
        ]);
        const search = pool.queries.find((q) => q.text.includes('ORDER BY embedding <=>'));
        expect(search?.values?.[0]).toBe('[1,0,0]');
        expect(search?.values?.[1]).toBe(5);
    });

    it('search degrades to an empty dense leg on pg errors — logged, never thrown', async () => {
        const events: string[] = [];
        const pool = new FakePool({ existing: [], searchError: new Error('connection reset') });
        const index = await PgVectorDenseIndex.sync(pool, [], stubEmbeddings([]), 'corr', {
            info: (_obj, msg) => events.push(msg),
        });
        const hits = await index.search([1, 0, 0], 5, 'corr-q');
        expect(hits).toEqual([]);
        expect(events).toContain('retrieval_dense_degraded');
    });
});
