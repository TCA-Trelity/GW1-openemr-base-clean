// B.6 (REQ S4/R6, D4): retrieval_grounded goldens — canonical clinical asks must surface
// the RIGHT protocol document with a verbatim, gate-verifiable quote; out-of-corpus asks
// must come back EMPTY (refusal floor). Deterministic offline backends (BM25 + hash-dense
// + passthrough rerank) over the real committed corpus: CI needs no keys, and a chunking/
// fusion/floor regression fails these cases identically everywhere.
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { recordEval, recordMetric, type EvalDifficulty } from './collector.js';
import { HashEmbeddings } from '../src/retrieval/embeddings.js';
import { PassthroughReranker } from '../src/retrieval/rerank.js';
import { HybridRetriever, loadCorpusChunks } from '../src/retrieval/retriever.js';

const CORPUS_DIR = fileURLToPath(new URL('../corpus/', import.meta.url));

// Difficulty is authored PER GOLDEN (CT2): most asks have one clear home document
// (straightforward); 'hcq-renal' and 'dr-systemic' straddle two overlapping corpus docs
// (hcq-screening also covers renal risk; retinopathy progression is core to BOTH DR docs)
// — the retriever has to win a genuine tie-break, so those two are ambiguous.
const GOLDENS: { id: string; query: string; expectDoc: string; difficulty: EvalDifficulty; tags?: string[] }[] = [
    { id: 'hcq-dosing', query: 'hydroxychloroquine daily dose threshold real body weight', expectDoc: 'hcq-screening', difficulty: 'straightforward' },
    { id: 'hcq-renal', query: 'reduced eGFR renal impairment hydroxychloroquine screening interval', expectDoc: 'renal-function-ocular-drug-safety', difficulty: 'ambiguous' },
    { id: 'hcq-asian-pattern', query: 'pericentral toxicity pattern Asian ancestry visual field 24-2', expectDoc: 'hcq-screening', difficulty: 'straightforward' },
    { id: 'tande-extend', query: 'treat and extend injection interval extension increment maximum', expectDoc: 'anti-vegf-treat-and-extend', difficulty: 'straightforward' },
    { id: 'tande-shorten', query: 'shorten injection interval fluid recurrence CRT increase', expectDoc: 'anti-vegf-treat-and-extend', difficulty: 'straightforward' },
    { id: 'dr-staging', query: 'nonproliferative diabetic retinopathy severity 4-2-1 rule follow-up', expectDoc: 'diabetic-retinopathy-management', difficulty: 'straightforward' },
    { id: 'dr-systemic', query: 'HbA1c target blood pressure control retinopathy progression', expectDoc: 'systemic-risk-factors-dr', difficulty: 'ambiguous' },
    { id: 'amd-areds', query: 'AREDS2 supplement formula intermediate AMD risk reduction', expectDoc: 'amd-management', difficulty: 'straightforward' },
    { id: 'rvo-neovascular', query: 'central retinal vein occlusion neovascular glaucoma surveillance gonioscopy', expectDoc: 'rvo-management', difficulty: 'straightforward' },
    { id: 'intake-standards', query: 'intake documentation required laterality patient goals verification', expectDoc: 'intake-documentation-standards', difficulty: 'straightforward' },
];

const OUT_OF_CORPUS: { id: string; query: string }[] = [
    { id: 'refusal-ortho', query: 'knee replacement rehabilitation weight bearing schedule' },
    { id: 'refusal-cardio', query: 'anticoagulation bridging before cardiac ablation' },
];

describe('retrieval-grounded goldens (B.6)', () => {
    async function build(): Promise<HybridRetriever> {
        return HybridRetriever.build(loadCorpusChunks(CORPUS_DIR), {
            embeddings: new HashEmbeddings(),
            reranker: new PassthroughReranker(),
        });
    }

    it('surfaces the right protocol with a verbatim quote for every canonical ask', async () => {
        const retriever = await build();
        // One record PER golden (D.2): the category gate then weighs retrieval by its
        // real case count, and the report names exactly which ask regressed. 'soft'
        // enforce hands the verdict to the tiered baseline math (one miss out of ten
        // is an 8.3% category drop — still a gate failure, but reported as such).
        let hits = 0;
        for (const golden of GOLDENS) {
            const result = await retriever.search(golden.query, { topK: 3 });
            const docs = result.snippets.map((snippet) => snippet.doc_id);
            const hit = docs.slice(0, 3).includes(golden.expectDoc) && result.snippets[0]!.quote.length > 40;
            if (hit) {
                hits += 1;
            }
            // CT3 metrics side-channel: 1-based rank of the expected doc's first snippet
            // in the ACTUAL returned list (the same top-3 window the verdict judges) —
            // the report derives hit rate + average rank from these, never from `pass`.
            const rankIndex = docs.indexOf(golden.expectDoc);
            recordMetric({
                kind: 'retrieval_rank',
                evalId: `retrieval-grounded.golden-${golden.id}`,
                expectedDoc: golden.expectDoc,
                returnedDocs: docs,
                rank: rankIndex === -1 ? null : rankIndex + 1,
            });
            recordEval({
                id: `retrieval-grounded.golden-${golden.id}`,
                description: `Canonical ask "${golden.query}" retrieves ${golden.expectDoc} in the top-3 with a quotable chunk`,
                metric: 'top-3 document hit',
                value: hit ? `hit (got ${docs.join(',')})` : `MISS (got ${docs.join(',') || 'EMPTY'})`,
                threshold: 'expected doc in top-3, top quote > 40 chars',
                pass: hit,
                difficulty: golden.difficulty,
                category: 'retrieval_grounded',
                enforce: 'soft',
            });
        }
        expect(hits).toBe(10);
    });

    it('returns EMPTY for out-of-corpus asks — the refusal floor holds', async () => {
        const retriever = await build();
        let refusals = 0;
        for (const negative of OUT_OF_CORPUS) {
            const result = await retriever.search(negative.query);
            if (result.empty && result.snippets.length === 0) {
                refusals += 1;
            }
        }
        recordEval({
            id: 'retrieval-grounded.out-of-corpus-refusal',
            description: 'Out-of-domain questions yield an empty result (answer says "no protocol on file"), never a forced match',
            metric: 'empty-result rate on out-of-corpus asks',
            value: `${refusals}/${OUT_OF_CORPUS.length}`,
            threshold: `${OUT_OF_CORPUS.length}/${OUT_OF_CORPUS.length}`,
            pass: refusals === OUT_OF_CORPUS.length,
            // Refusal floor over out-of-corpus asks — one uniform tier for the pair.
            difficulty: 'edge-case',
            category: 'retrieval_grounded',
        });
        expect(refusals).toBe(OUT_OF_CORPUS.length);
    });

    it('PHI canaries never reach the searched query (no_phi family, retrieval leg)', async () => {
        const retriever = await build();
        const result = await retriever.search(
            'hydroxychloroquine screening interval for Margaret Chen DOB 03/14/1967 MRN FPA-2019-4521',
            { identifiers: { names: ['Margaret L. Chen'], dobs: ['03/14/1967'], mrns: ['FPA-2019-4521'] } },
        );
        const leaked = ['Margaret', 'Chen', '03/14/1967', 'FPA-2019-4521'].filter((canary) => result.searched_query.includes(canary));
        recordEval({
            id: 'retrieval-grounded.query-phi-scrub',
            description: 'Planted name/DOB/MRN canaries are scrubbed before the query leaves the retrieval boundary',
            metric: 'leaked canaries in searched_query',
            value: leaked.length === 0 ? '0 leaked' : `LEAKED: ${leaked.join(', ')}`,
            threshold: '0 leaked',
            pass: leaked.length === 0,
            difficulty: 'edge-case',
            category: 'no_phi_in_logs',
        });
        expect(leaked).toEqual([]);
    });
});
