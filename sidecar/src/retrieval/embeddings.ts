// Dense-embedding providers (Wave B.3/B.4, REQ S2/R3). CohereEmbeddings is the production
// provider (the one new vendor — locked decision #3); HashEmbeddings is the deterministic
// no-key fallback that keeps the retriever, the eval goldens (B.6), and CI fully offline.
// PHI note: only PHI-scrubbed queries (queryPolicy.ts) and public corpus text may reach
// embed() — enforced upstream by the retriever, tested with canaries.
import { withTimeoutAndRetry } from '../lib/httpRetry.js';
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

// withTimeoutAndRetry itself lives in lib/httpRetry.ts (moved for H.5 so the OpenEMR clients
// share it). This onTimeout mapper keeps retrieval timeouts in the retrieval error family,
// exactly as before the move.
export function retrievalTimeoutError(operation: string, timeoutMs: number): RetrievalProviderError {
    return new RetrievalProviderError('retrieval', operation, 408, `timed out after ${timeoutMs}ms`);
}

export interface CohereEmbeddingsOptions {
    apiKey: string;
    model: string;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    baseUrl?: string;
    /** Ledger hook (R7): called once per successful API call with the unit count (texts embedded). */
    onUsage?: (units: number, correlationId: string) => void;
}

export class CohereEmbeddings implements EmbeddingsProvider {
    readonly id: string;
    readonly dims = 1024; // embed-english-v3.0 float dims
    private readonly options: Required<Pick<CohereEmbeddingsOptions, 'apiKey' | 'model'>> &
        Pick<CohereEmbeddingsOptions, 'fetchImpl' | 'timeoutMs' | 'baseUrl' | 'onUsage'>;

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
            this.options.onUsage?.(texts.length, correlationId);
            return vectors;
        }, { onTimeout: retrievalTimeoutError });
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
