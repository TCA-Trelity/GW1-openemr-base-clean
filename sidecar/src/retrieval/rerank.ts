// Rerankers (Wave B.4, REQ S2/R3). CohereReranker is production (the reranker the spec
// names); PassthroughReranker preserves fused order when no key is configured — retrieval
// keeps working, results carry rerank_applied=false so the degradation is visible, never
// silent (REQ G2 posture).
import { withTimeoutAndRetry } from '../lib/httpRetry.js';
import type { FetchLike } from '../openemr/auth.js';
import { RetrievalProviderError, retrievalTimeoutError } from './embeddings.js';

export interface RerankCandidate {
    id: string;
    text: string;
}

export interface RerankOutcome {
    /** Candidate ids in final order (length ≤ topK). */
    order: { id: string; score: number }[];
    rerankApplied: boolean;
}

export interface Reranker {
    readonly id: string;
    rerank(query: string, candidates: readonly RerankCandidate[], topK: number, correlationId: string): Promise<RerankOutcome>;
}

export interface CohereRerankerOptions {
    apiKey: string;
    model: string;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    baseUrl?: string;
    /** Ledger hook (R7): called once per successful rerank with the candidate count. */
    onUsage?: (units: number, correlationId: string) => void;
}

/** H.2: outcome of the last COMPLETED real rerank call — the /ready probe's memory.
 *  `detail` carries provider/operation/status text only, never query or document content. */
export interface RerankObservation {
    ok: boolean;
    at: Date;
    detail?: string;
}

export class CohereReranker implements Reranker {
    readonly id: string;
    private observed: RerankObservation | undefined;

    constructor(private readonly options: CohereRerankerOptions) {
        this.id = `cohere:${options.model}`;
    }

    /** H.2 (/ready honesty): the readiness probe reads the last observed traffic outcome
     *  instead of making a per-poll live Cohere call (trial keys are rate-limited and
     *  every rerank call costs money). Undefined until traffic exercises the reranker. */
    get lastOutcome(): RerankObservation | undefined {
        return this.observed;
    }

    async rerank(
        query: string,
        candidates: readonly RerankCandidate[],
        topK: number,
        correlationId: string,
    ): Promise<RerankOutcome> {
        if (candidates.length === 0) {
            // No API call happens here — the probe's view of Cohere must not change.
            return { order: [], rerankApplied: true };
        }
        try {
            const outcome = await this.callApi(query, candidates, topK, correlationId);
            this.observed = { ok: true, at: new Date() };
            return outcome;
        } catch (error) {
            this.observed = {
                ok: false,
                at: new Date(),
                detail: error instanceof Error ? error.message : String(error),
            };
            throw error;
        }
    }

    private callApi(
        query: string,
        candidates: readonly RerankCandidate[],
        topK: number,
        correlationId: string,
    ): Promise<RerankOutcome> {
        const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
        const url = `${(this.options.baseUrl ?? 'https://api.cohere.com').replace(/\/+$/, '')}/v2/rerank`;
        return withTimeoutAndRetry('rerank', this.options.timeoutMs ?? 3000, async (signal) => {
            const response = await fetchImpl(url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${this.options.apiKey}`,
                    'x-correlation-id': correlationId,
                },
                body: JSON.stringify({
                    model: this.options.model,
                    query,
                    documents: candidates.map((candidate) => candidate.text),
                    top_n: Math.min(topK, candidates.length),
                }),
                signal,
            });
            if (!response.ok) {
                throw new RetrievalProviderError('cohere', 'rerank', response.status);
            }
            const body = (await response.json()) as { results?: { index?: number; relevance_score?: number }[] };
            if (!Array.isArray(body.results)) {
                throw new RetrievalProviderError('cohere', 'rerank', 200, 'malformed rerank payload');
            }
            const order = body.results.flatMap((result) => {
                const candidate = typeof result.index === 'number' ? candidates[result.index] : undefined;
                return candidate === undefined
                    ? []
                    : [{ id: candidate.id, score: typeof result.relevance_score === 'number' ? result.relevance_score : 0 }];
            });
            this.options.onUsage?.(candidates.length, correlationId);
            return { order, rerankApplied: true };
        }, { onTimeout: retrievalTimeoutError });
    }
}

/** No-key fallback: keeps the fused order and says so. */
export class PassthroughReranker implements Reranker {
    readonly id = 'passthrough';

    rerank(
        _query: string,
        candidates: readonly RerankCandidate[],
        topK: number,
        _correlationId: string,
    ): Promise<RerankOutcome> {
        return Promise.resolve({
            order: candidates.slice(0, topK).map((candidate, index) => ({ id: candidate.id, score: 1 - index * 0.01 })),
            rerankApplied: false,
        });
    }
}
