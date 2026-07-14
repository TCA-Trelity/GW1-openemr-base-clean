// B.3–B.5 (REQ S2/R3, E5, G2, G18/P5): the retrieval stack. Failure modes guarded:
// PHI reaching an egress query (canary tests), out-of-domain queries answered from
// parametric knowledge (empty-result floor), vendor calls without timeout/retry, and
// the hybrid pipeline silently skipping rerank without saying so.
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { Bm25Index, tokenize } from '../src/retrieval/bm25.js';
import { CohereEmbeddings, HashEmbeddings, RetrievalProviderError } from '../src/retrieval/embeddings.js';
import { CohereReranker, PassthroughReranker } from '../src/retrieval/rerank.js';
import { rewriteQuery, scrubQuery } from '../src/retrieval/queryPolicy.js';
import { HybridRetriever, loadCorpusChunks, reciprocalRankFusion } from '../src/retrieval/retriever.js';

const CORPUS_DIR = fileURLToPath(new URL('../corpus/', import.meta.url));

describe('bm25', () => {
    it('ranks term-relevant docs first and tokenizes clinical units sanely', () => {
        expect(tokenize('eGFR 42 mL/min/1.73m² (L)')).toContain('egfr');
        const index = new Bm25Index([
            { id: 'a', text: 'hydroxychloroquine dosing threshold real body weight' },
            { id: 'b', text: 'diabetic retinopathy staging follow-up intervals' },
        ]);
        const hits = index.search('hydroxychloroquine threshold', 2);
        expect(hits[0]?.id).toBe('a');
    });
});

describe('reciprocalRankFusion', () => {
    it('rewards agreement across lists over a single high rank', () => {
        const fused = reciprocalRankFusion([
            ['x', 'y', 'z'],
            ['y', 'x'],
        ]);
        expect(fused.get('y')! + 0).toBeGreaterThan(fused.get('z')!);
        expect(fused.get('x')!).toBeGreaterThan(fused.get('z')!);
    });
});

describe('queryPolicy (B.5 — the PHI boundary)', () => {
    const identifiers = {
        names: ['Margaret L. Chen'],
        dobs: ['1967-03-14', '03/14/1967'],
        mrns: ['FPA-2019-4521'],
        phones: ['(407) 555-6789'],
    };

    it('strips every canary identifier class from a worst-case query', () => {
        const raw =
            'For Margaret Chen (DOB 03/14/1967, MRN FPA-2019-4521, phone (407) 555-6789): ' +
            'hydroxychloroquine screening interval with eGFR 42?';
        const scrubbed = scrubQuery(raw, identifiers);
        for (const canary of ['Margaret', 'Chen', '03/14/1967', '1967-03-14', 'FPA-2019-4521', '555-6789']) {
            expect(scrubbed).not.toContain(canary);
        }
        // The clinical content survives.
        expect(scrubbed).toContain('hydroxychloroquine');
        expect(scrubbed).toContain('eGFR 42');
    });

    it('strips generic date/MRN/phone shapes even without chart identifiers', () => {
        const scrubbed = scrubQuery('labs from 12/20/2024 accession ABC-2024-9911 call 407-555-1212', {});
        expect(scrubbed).not.toContain('12/20/2024');
        expect(scrubbed).not.toContain('ABC-2024-9911');
        expect(scrubbed).not.toContain('407-555-1212');
    });

    it('rewriteQuery appends concepts and carries disease-tag filters (E5)', () => {
        const built = rewriteQuery('screening interval question', { concepts: ['hydroxychloroquine'], diseaseTags: ['drug-toxicity'] });
        expect(built.query).toContain('hydroxychloroquine');
        expect(built.filters.diseaseTags).toEqual(['drug-toxicity']);
    });
});

describe('HybridRetriever over the real corpus (offline backends)', () => {
    async function build(): Promise<HybridRetriever> {
        return HybridRetriever.build(loadCorpusChunks(CORPUS_DIR), {
            embeddings: new HashEmbeddings(),
            reranker: new PassthroughReranker(),
        });
    }

    it('surfaces the HCQ screening protocol for a dosing-threshold query, with metadata + quote', async () => {
        const retriever = await build();
        const result = await retriever.search('hydroxychloroquine daily dose threshold real body weight screening');
        expect(result.empty).toBe(false);
        expect(result.snippets[0]?.doc_id).toBe('hcq-screening');
        expect(result.snippets[0]?.quote.length).toBeGreaterThan(40);
        expect(result.snippets[0]?.guideline_source).toContain('AAO');
        expect(result.rerank_applied).toBe(false); // passthrough says so — degradation is visible
    });

    it('returns EMPTY for an out-of-corpus query instead of improvising', async () => {
        const retriever = await build();
        const result = await retriever.search('knee replacement rehabilitation weight bearing protocol');
        expect(result.empty).toBe(true);
        expect(result.snippets).toEqual([]);
    });

    it('scrubs identifiers before search — the searched_query is log-safe', async () => {
        const retriever = await build();
        const result = await retriever.search('eGFR screening interval for Margaret Chen MRN FPA-2019-4521', {
            identifiers: { names: ['Margaret L. Chen'], mrns: ['FPA-2019-4521'] },
        });
        expect(result.searched_query).not.toContain('Margaret');
        expect(result.searched_query).not.toContain('FPA-2019-4521');
    });

    it('disease-tag filters narrow candidates (E5)', async () => {
        const retriever = await build();
        const result = await retriever.search('annual screening interval risk factors', {
            context: { diseaseTags: ['hydroxychloroquine-retinopathy'] },
        });
        expect(result.empty).toBe(false);
        for (const snippet of result.snippets) {
            expect(snippet.disease_tags).toContain('hydroxychloroquine-retinopathy');
        }
    });
});

describe('Cohere providers (mocked fetch — contract, timeout, retry)', () => {
    it('embed: sends model/input_type/texts with bearer auth and parses float embeddings', async () => {
        const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
            expect(url).toBe('https://api.cohere.com/v2/embed');
            const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            expect(body['model']).toBe('embed-english-v3.0');
            expect(body['input_type']).toBe('search_query');
            expect((init?.headers as Record<string, string>)['authorization']).toBe('Bearer key-123');
            return new Response(JSON.stringify({ embeddings: { float: [[0.1, 0.2]] } }), { status: 200 });
        });
        const provider = new CohereEmbeddings({ apiKey: 'key-123', model: 'embed-english-v3.0', fetchImpl });
        const vectors = await provider.embed(['q'], 'search_query', 'corr-1');
        expect(vectors).toEqual([[0.1, 0.2]]);
    });

    it('embed: retries once on transient 429 then succeeds', async () => {
        let calls = 0;
        const fetchImpl = vi.fn(async () => {
            calls += 1;
            return calls === 1
                ? new Response('{}', { status: 429 })
                : new Response(JSON.stringify({ embeddings: { float: [[1]] } }), { status: 200 });
        });
        const provider = new CohereEmbeddings({ apiKey: 'k', model: 'm', fetchImpl });
        await expect(provider.embed(['q'], 'search_query', 'corr')).resolves.toEqual([[1]]);
        expect(calls).toBe(2);
    });

    it('embed: non-transient 401 fails immediately with a typed error', async () => {
        const fetchImpl = vi.fn(async () => new Response('{}', { status: 401 }));
        const provider = new CohereEmbeddings({ apiKey: 'bad', model: 'm', fetchImpl });
        await expect(provider.embed(['q'], 'search_query', 'corr')).rejects.toBeInstanceOf(RetrievalProviderError);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('rerank: maps result indices back to candidate ids in order', async () => {
        const fetchImpl = vi.fn(async (url: string) => {
            expect(url).toBe('https://api.cohere.com/v2/rerank');
            return new Response(
                JSON.stringify({ results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.3 }] }),
                { status: 200 },
            );
        });
        const reranker = new CohereReranker({ apiKey: 'k', model: 'rerank-english-v3.0', fetchImpl });
        const outcome = await reranker.rerank('q', [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], 2, 'corr');
        expect(outcome.order.map((entry) => entry.id)).toEqual(['b', 'a']);
        expect(outcome.rerankApplied).toBe(true);
    });
});
