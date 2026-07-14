// Dense-embedding providers (Wave B.3/B.4, REQ S2/R3). CohereEmbeddings is the production
// provider (the one new vendor — locked decision #3); HashEmbeddings is the deterministic
// no-key fallback that keeps the retriever, the eval goldens (B.6), and CI fully offline.
// PHI note: only PHI-scrubbed queries (queryPolicy.ts) and public corpus text may reach
// embed() — enforced upstream by the retriever, tested with canaries.
import type { FetchLike } from '../openemr/auth.js';

export type EmbedInputType = 'search_document' | 'search_query';

export interface EmbeddingsProvider {
    readonly id: string;
    readonly dims: number;
    embed(texts: readonly string[], inputType: EmbedInputType, correlationId: string): Promise<number[][]>;
}

export class RetrievalProviderError extends Error {
    constructor(
        provider: string,
        operation: string,
        public readonly status: number,
        detail?: string,
    ) {
        super(`${provider} ${operation} failed with status ${status}${detail ? ` (${detail})` : ''}`);
        this.name = 'RetrievalProviderError';
    }
}

const TRANSIENT = new Set([408, 429, 500, 502, 503, 504]);

/** One bounded retry on transient failures; hard timeout per attempt (REQ G2). */
export async function withTimeoutAndRetry<T>(
    operation: string,
    timeoutMs: number,
    attempt: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
    for (let round = 0; ; round += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await attempt(controller.signal);
        } catch (error) {
            const transient =
                (error instanceof RetrievalProviderError && TRANSIENT.has(error.status)) ||
                (error instanceof Error && error.name === 'AbortError');
            if (round === 0 && transient) {
                continue; // one fresh retry
            }
            if (error instanceof Error && error.name === 'AbortError') {
                throw new RetrievalProviderError('retrieval', operation, 408, `timed out after ${timeoutMs}ms`);
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }
}

export interface CohereEmbeddingsOptions {
    apiKey: string;
    model: string;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    baseUrl?: string;
}

export class CohereEmbeddings implements EmbeddingsProvider {
    readonly id: string;
    readonly dims = 1024; // embed-english-v3.0 float dims
    private readonly options: Required<Pick<CohereEmbeddingsOptions, 'apiKey' | 'model'>> &
        Pick<CohereEmbeddingsOptions, 'fetchImpl' | 'timeoutMs' | 'baseUrl'>;

    constructor(options: CohereEmbeddingsOptions) {
        this.options = options;
        this.id = `cohere:${options.model}`;
    }

    async embed(texts: readonly string[], inputType: EmbedInputType, correlationId: string): Promise<number[][]> {
        if (texts.length === 0) {
            return [];
        }
        const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
        const url = `${(this.options.baseUrl ?? 'https://api.cohere.com').replace(/\/+$/, '')}/v2/embed`;
        return withTimeoutAndRetry('embed', this.options.timeoutMs ?? 4000, async (signal) => {
            const response = await fetchImpl(url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${this.options.apiKey}`,
                    'x-correlation-id': correlationId,
                },
                body: JSON.stringify({
                    model: this.options.model,
                    input_type: inputType,
                    embedding_types: ['float'],
                    texts,
                }),
                signal,
            });
            if (!response.ok) {
                throw new RetrievalProviderError('cohere', 'embed', response.status);
            }
            const body = (await response.json()) as { embeddings?: { float?: number[][] } };
            const vectors = body.embeddings?.float;
            if (!Array.isArray(vectors) || vectors.length !== texts.length) {
                throw new RetrievalProviderError('cohere', 'embed', 200, 'malformed embeddings payload');
            }
            return vectors;
        });
    }
}

/**
 * Deterministic character-trigram hashing embeddings — the offline fallback and the eval
 * goldens' provider. NOT a semantic model: it captures lexical similarity only, which is
 * exactly what makes it deterministic. Production quality comes from Cohere; this exists
 * so retrieval logic, fusion, and the goldens run identically everywhere with no keys.
 */
export class HashEmbeddings implements EmbeddingsProvider {
    readonly id = 'hash-trigram-v1';
    readonly dims: number;

    constructor(dims = 256) {
        this.dims = dims;
    }

    embed(texts: readonly string[], _inputType: EmbedInputType, _correlationId: string): Promise<number[][]> {
        return Promise.resolve(texts.map((text) => this.embedOne(text)));
    }

    private embedOne(text: string): number[] {
        const vector = new Array<number>(this.dims).fill(0);
        const normalized = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
        for (let i = 0; i + 3 <= normalized.length; i += 1) {
            const gram = normalized.slice(i, i + 3);
            let hash = 2166136261;
            for (let j = 0; j < gram.length; j += 1) {
                hash ^= gram.charCodeAt(j);
                hash = Math.imul(hash, 16777619);
            }
            const slot = Math.abs(hash) % this.dims;
            vector[slot] = (vector[slot] ?? 0) + 1;
        }
        const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
        return vector.map((v) => v / norm);
    }
}
