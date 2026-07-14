// Hybrid retriever (Wave B.4, REQ S2/R3 — W2_ARCHITECTURE.md §5): keyword (BM25) and
// dense (embeddings) searched in parallel → reciprocal-rank fusion → rerank → top-k
// evidence snippets with chunk-level source metadata. Every snippet's `quote` is the
// chunk body itself, so guideline citations verify through the same deterministic gate
// as record citations (quote-vs-stored-chunk).
//
// Backends are injectable: production = CohereEmbeddings + CohereReranker (+ pgvector at
// B.3-live); offline/CI = HashEmbeddings + PassthroughReranker over the in-memory index.
// A retrieval that finds nothing above the confidence floor returns empty WITH the floor
// stated — "no protocol on file" is an answer, never a silent parametric fallback (P2/G9).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Bm25Index, tokenize } from './bm25.js';
import { chunkCorpusDocument, type CorpusChunk } from './chunker.js';
import type { EmbeddingsProvider } from './embeddings.js';
import type { Reranker } from './rerank.js';
import { rewriteQuery, type PatientIdentifiers, type QueryContext } from './queryPolicy.js';

export interface EvidenceSnippet {
    chunk_id: string;
    doc_id: string;
    section_title: string;
    /** Verbatim chunk body — the quotable, gate-verifiable evidence text. */
    quote: string;
    /** Context-prefixed text (doc title › section) — what was indexed. */
    text: string;
    score: number;
    guideline_source: string;
    version: string;
    disease_tags: readonly string[];
    rerank_applied: boolean;
}

export interface RetrievalResult {
    snippets: EvidenceSnippet[];
    /** The PHI-scrubbed query that was actually searched (log-safe by construction). */
    searched_query: string;
    rerank_applied: boolean;
    /** True when nothing cleared the confidence floor — callers must say so, not improvise. */
    empty: boolean;
}

export interface SearchOptions {
    topK?: number;
    context?: QueryContext;
    identifiers?: PatientIdentifiers;
    correlationId?: string;
}

/** Structural logger (pino-compatible) so this module never imports a logging library. */
export interface RetrievalLogger {
    info(obj: Record<string, unknown>, msg: string): void;
}

/** Reciprocal-rank fusion (k=60): rank-based, so BM25 and cosine scores need no calibration. */
export function reciprocalRankFusion(lists: readonly (readonly string[])[], k = 60): Map<string, number> {
    const fused = new Map<string, number>();
    for (const list of lists) {
        list.forEach((id, rank) => {
            fused.set(id, (fused.get(id) ?? 0) + 1 / (k + rank + 1));
        });
    }
    return fused;
}

function cosine(a: readonly number[], b: readonly number[]): number {
    let dot = 0;
    for (let i = 0; i < a.length && i < b.length; i += 1) {
        dot += a[i]! * b[i]!;
    }
    return dot; // vectors are normalized at embed time
}

// Minimum BM25 score for the keyword list AND floor for "did we find anything at all":
// out-of-domain queries (no term overlap with any protocol) must yield an EMPTY result.
const KEYWORD_FLOOR = 0.1;
const CANDIDATE_POOL = 12;

// Query-frame words ("what should the…") are never evidence of domain overlap — they
// match every prose chunk and would let an out-of-domain ask clear the coverage floor.
// Excluded from the coverage ratio ONLY; BM25 keeps them (IDF already discounts them).
// Entries appear in post-tokenize form: tokenize() plural-stems, so "does"→"doe",
// "this"→"thi" — both raw and stemmed spellings are listed where they differ.
const COVERAGE_STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'how',
    'should', 'would', 'could', 'can', 'will', 'shall', 'may', 'might', 'must',
    'doe', 'does', 'did', 'are', 'was', 'were', 'been', 'being', 'have', 'has', 'had',
    'thi', 'this', 'that', 'these', 'those', 'they', 'their', 'them', 'there', 'here',
    'she', 'her', 'his', 'him', 'you', 'your', 'not', 'but', 'all', 'any', 'some', 'such',
    'than', 'then', 'into', 'onto', 'from', 'about', 'over', 'under', 'per', 'our', 'out',
]);

export class HybridRetriever {
    private readonly bm25: Bm25Index;
    private readonly byId: Map<string, CorpusChunk>;
    private dense: { provider: EmbeddingsProvider; vectors: Map<string, number[]> } | undefined;

    private constructor(
        private readonly chunks: readonly CorpusChunk[],
        private readonly reranker: Reranker,
        private readonly logger?: RetrievalLogger,
    ) {
        this.bm25 = new Bm25Index(chunks.map((chunk) => ({ id: chunk.chunk_id, text: chunk.text })));
        this.byId = new Map(chunks.map((chunk) => [chunk.chunk_id, chunk]));
    }

    /** Build over pre-chunked content; embeds the corpus once when a provider is given. */
    static async build(
        chunks: readonly CorpusChunk[],
        options: { embeddings?: EmbeddingsProvider; reranker: Reranker; correlationId?: string; logger?: RetrievalLogger },
    ): Promise<HybridRetriever> {
        const retriever = new HybridRetriever(chunks, options.reranker, options.logger);
        if (options.embeddings !== undefined) {
            const vectors = await options.embeddings.embed(
                chunks.map((chunk) => chunk.text),
                'search_document',
                options.correlationId ?? 'corpus-index',
            );
            retriever.dense = {
                provider: options.embeddings,
                vectors: new Map(chunks.map((chunk, index) => [chunk.chunk_id, vectors[index] ?? []])),
            };
        }
        return retriever;
    }

    get size(): number {
        return this.chunks.length;
    }

    async search(rawQuery: string, options: SearchOptions = {}): Promise<RetrievalResult> {
        const topK = options.topK ?? 5;
        const correlationId = options.correlationId ?? 'evidence-search';
        const { query, filters } = rewriteQuery(rawQuery, options.context ?? {}, options.identifiers ?? {});

        // Keyword leg (with floor) — always available.
        const keywordHits = this.bm25.search(query, CANDIDATE_POOL).filter((hit) => hit.score >= KEYWORD_FLOOR);
        const lists: string[][] = [keywordHits.map((hit) => hit.id)];

        // Dense leg — only when a provider was configured at build time.
        if (this.dense !== undefined) {
            const [queryVector] = await this.dense.provider.embed([query], 'search_query', correlationId);
            if (queryVector !== undefined) {
                const scored = [...this.dense.vectors.entries()]
                    .map(([id, vector]) => ({ id, score: cosine(queryVector, vector) }))
                    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
                    .slice(0, CANDIDATE_POOL);
                lists.push(scored.map((hit) => hit.id));
            }
        }

        // Fuse → apply metadata filters (E5) → keyword-floor guard for out-of-domain queries.
        const fused = [...reciprocalRankFusion(lists).entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        const keywordIds = new Set(keywordHits.map((hit) => hit.id));
        const candidates = fused
            .map(([id]) => this.byId.get(id))
            .filter((chunk): chunk is CorpusChunk => chunk !== undefined)
            .filter((chunk) =>
                filters.diseaseTags === undefined ||
                filters.diseaseTags.length === 0 ||
                filters.diseaseTags.some((tag) => chunk.meta.disease_tags.includes(tag)),
            )
            // Dense-only matches with zero keyword support are how lexically-unrelated
            // queries sneak in — require at least one keyword-supported candidate overall.
            .slice(0, CANDIDATE_POOL);

        // Confidence floor: at least one (filtered) candidate must be keyword-supported AND
        // cover >=50% of the query's content terms — generic-word overlap ("protocol",
        // "weight") cannot smuggle an out-of-domain question into the corpus (P2).
        const queryTerms = [...new Set(tokenize(query).filter((term) => term.length >= 3 && !COVERAGE_STOPWORDS.has(term)))];
        const coverage = (chunk: CorpusChunk): number => {
            if (queryTerms.length === 0) {
                return 0;
            }
            const chunkTerms = new Set(tokenize(chunk.text));
            return queryTerms.filter((term) => chunkTerms.has(term)).length / queryTerms.length;
        };
        const supported = candidates.filter((chunk) => keywordIds.has(chunk.chunk_id));
        if (supported.length === 0 || Math.max(...supported.map(coverage)) < 0.5) {
            const result: RetrievalResult = { snippets: [], searched_query: query, rerank_applied: false, empty: true };
            this.logSearch(result, correlationId);
            return result;
        }

        const outcome = await this.reranker.rerank(
            query,
            candidates.map((chunk) => ({ id: chunk.chunk_id, text: chunk.text })),
            topK,
            correlationId,
        );

        const snippets = outcome.order.flatMap(({ id, score }) => {
            const chunk = this.byId.get(id);
            return chunk === undefined
                ? []
                : [
                      {
                          chunk_id: chunk.chunk_id,
                          doc_id: chunk.doc_id,
                          section_title: chunk.section_title,
                          quote: chunk.body,
                          text: chunk.text,
                          score,
                          guideline_source: chunk.meta.guideline_source,
                          version: chunk.meta.version,
                          disease_tags: chunk.meta.disease_tags,
                          rerank_applied: outcome.rerankApplied,
                      },
                  ];
        });
        const result: RetrievalResult = { snippets, searched_query: query, rerank_applied: outcome.rerankApplied, empty: snippets.length === 0 };
        this.logSearch(result, correlationId);
        return result;
    }

    // G5 `retrieval_hit`/`retrieval_miss`: one structured event per search, from every
    // caller (evidence route and graph worker alike). The searched query is the
    // PHI-scrubbed rewrite (log-safe by construction); hits are chunk ids, never text.
    private logSearch(result: RetrievalResult, correlationId: string): void {
        this.logger?.info(
            {
                correlation_id: correlationId,
                query_hash: createHash('sha256').update(result.searched_query).digest('hex').slice(0, 16),
                searched_query: result.searched_query,
                hits: result.snippets.length,
                chunk_ids: result.snippets.map((snippet) => snippet.chunk_id),
                rerank_applied: result.rerank_applied,
            },
            result.empty ? 'retrieval_miss' : 'retrieval_hit',
        );
    }
}

/** Chunk every corpus document under `corpusDir` (excluding README.md). */
export function loadCorpusChunks(corpusDir: string): CorpusChunk[] {
    return readdirSync(corpusDir)
        .filter((file) => file.endsWith('.md') && file !== 'README.md')
        .sort()
        .flatMap((file) => chunkCorpusDocument(readFileSync(join(corpusDir, file), 'utf8'), file));
}
