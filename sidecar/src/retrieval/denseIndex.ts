// Dense-index backends for the hybrid retriever (S2/R3 — the RETRIEVER_DENSE_BACKEND
// config key finally branches here). Two implementations behind one interface:
//
//   PgVectorDenseIndex — embeddings persisted in Postgres (corpus_embeddings, migration
//     005) and searched with the pgvector <=> cosine-distance operator. sync() embeds
//     only chunks whose content hash changed, so an unchanged corpus costs zero Cohere
//     calls at boot and the index survives restarts.
//   InMemoryDenseIndex — the process-local map + JS cosine used since B.3; the fallback
//     when pgvector or a database is unavailable, and the whole story for keyless/CI runs.
//
// Failure posture (G2): a pg error at query time degrades that ONE search (dense leg
// contributes nothing; BM25 + fusion still serve) — logged, never thrown.
import { createHash } from 'node:crypto';
import type { EmbeddingsProvider } from './embeddings.js';
import type { RetrievalLogger } from './retriever.js';

export interface DenseHit {
    id: string;
    score: number;
}

export interface DenseIndex {
    /** Which implementation is live — surfaces in the boot log and corpus:index output. */
    readonly backend: 'pgvector' | 'memory';
    search(queryVector: readonly number[], k: number, correlationId: string): Promise<DenseHit[]>;
}

/** Minimal structural pg surface so tests can fake the pool (mirrors store/index.ts usage). */
export interface PgQueryable {
    query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

function cosine(a: readonly number[], b: readonly number[]): number {
    let dot = 0;
    for (let i = 0; i < a.length && i < b.length; i += 1) {
        dot += a[i]! * b[i]!;
    }
    return dot; // vectors are normalized at embed time
}

export class InMemoryDenseIndex implements DenseIndex {
    readonly backend = 'memory';

    constructor(private readonly vectors: Map<string, number[]>) {}

    async search(queryVector: readonly number[], k: number): Promise<DenseHit[]> {
        return [...this.vectors.entries()]
            .map(([id, vector]) => ({ id, score: cosine(queryVector, vector) }))
            .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
            .slice(0, k);
    }
}

export interface SyncableChunk {
    chunk_id: string;
    doc_id: string;
    text: string;
}

function contentHashOf(model: string, text: string): string {
    return createHash('sha256').update(`${model}:${text}`).digest('hex').slice(0, 32);
}

function vectorLiteral(vector: readonly number[]): string {
    return `[${vector.join(',')}]`;
}

export class PgVectorDenseIndex implements DenseIndex {
    readonly backend = 'pgvector';

    private constructor(
        private readonly db: PgQueryable,
        private readonly logger?: RetrievalLogger,
    ) {}

    /** Sync the persisted index to the current corpus, embedding ONLY stale/missing chunks,
     *  then return a query-ready index. Throws when the table is absent (extensionless
     *  Postgres — migration 005's guard skipped creation); callers fall back to memory. */
    static async sync(
        db: PgQueryable,
        chunks: readonly SyncableChunk[],
        embeddings: EmbeddingsProvider,
        correlationId: string,
        logger?: RetrievalLogger,
    ): Promise<PgVectorDenseIndex> {
        const present = await db.query(`SELECT to_regclass('corpus_embeddings') IS NOT NULL AS present`);
        if (present.rows[0]?.['present'] !== true) {
            throw new Error('corpus_embeddings table absent — pgvector unavailable on this database (migration 005 guard)');
        }

        const existing = await db.query('SELECT chunk_id, content_hash FROM corpus_embeddings');
        const existingHashes = new Map(existing.rows.map((row) => [String(row['chunk_id']), String(row['content_hash'])]));

        const stale = chunks.filter((chunk) => existingHashes.get(chunk.chunk_id) !== contentHashOf(embeddings.id, chunk.text));
        if (stale.length > 0) {
            const vectors = await embeddings.embed(
                stale.map((chunk) => chunk.text),
                'search_document',
                correlationId,
            );
            for (let i = 0; i < stale.length; i += 1) {
                const chunk = stale[i]!;
                const vector = vectors[i];
                if (vector === undefined || vector.length === 0) {
                    continue;
                }
                await db.query(
                    `INSERT INTO corpus_embeddings (chunk_id, doc_id, model, content_hash, embedding, updated_at)
                     VALUES ($1, $2, $3, $4, $5::vector, now())
                     ON CONFLICT (chunk_id) DO UPDATE
                         SET doc_id = EXCLUDED.doc_id, model = EXCLUDED.model,
                             content_hash = EXCLUDED.content_hash, embedding = EXCLUDED.embedding,
                             updated_at = now()`,
                    [chunk.chunk_id, chunk.doc_id, embeddings.id, contentHashOf(embeddings.id, chunk.text), vectorLiteral(vector)],
                );
            }
        }

        const keep = chunks.map((chunk) => chunk.chunk_id);
        const deleted = await db.query('DELETE FROM corpus_embeddings WHERE NOT (chunk_id = ANY($1)) RETURNING chunk_id', [keep]);

        logger?.info(
            {
                correlation_id: correlationId,
                backend: 'pgvector',
                total: chunks.length,
                embedded: stale.length,
                reused: chunks.length - stale.length,
                deleted: deleted.rows.length,
                model: embeddings.id,
            },
            'corpus_index_synced',
        );
        return new PgVectorDenseIndex(db, logger);
    }

    async search(queryVector: readonly number[], k: number, correlationId: string): Promise<DenseHit[]> {
        try {
            const result = await this.db.query(
                `SELECT chunk_id, 1 - (embedding <=> $1::vector) AS score
                 FROM corpus_embeddings
                 ORDER BY embedding <=> $1::vector
                 LIMIT $2`,
                [vectorLiteral(queryVector), k],
            );
            return result.rows.map((row) => ({ id: String(row['chunk_id']), score: Number(row['score']) }));
        } catch (error) {
            this.logger?.info(
                { correlation_id: correlationId, backend: 'pgvector', error: error instanceof Error ? error.message : String(error) },
                'retrieval_dense_degraded',
            );
            return []; // dense leg contributes nothing this search; BM25 + fusion still serve
        }
    }
}
