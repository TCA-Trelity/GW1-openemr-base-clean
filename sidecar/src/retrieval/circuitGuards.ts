// H.10 (REQ G2): the Cohere providers behind the shared 'cohere' circuit breaker.
// Both decorators catch ONLY CircuitOpenError and degrade honestly — an open circuit must
// never fail a search: embed returns [] so the retriever's existing dense-leg guard
// (retriever.ts `if (queryVector !== undefined)`) skips to keyword+fusion, and rerank
// returns the PassthroughReranker-shaped fused order with rerank_applied=false so the
// degradation stays visible, never silent. Every OTHER error propagates unchanged: real
// failures are exactly what feeds the breaker's consecutive counter.
import { CircuitOpenError, type CircuitBreaker } from '../lib/circuitBreaker.js';
import type { EmbeddingsProvider, EmbedInputType } from './embeddings.js';
import type { Reranker, RerankCandidate, RerankOutcome } from './rerank.js';

/** Pino-compatible warn shape so this module never imports a logging library. */
export interface DegradeLogger {
    warn(obj: Record<string, unknown>, msg: string): void;
}

export class CircuitGuardedEmbeddings implements EmbeddingsProvider {
    readonly id: string;
    readonly dims: number;

    constructor(
        private readonly inner: EmbeddingsProvider,
        private readonly breaker: CircuitBreaker,
        private readonly logger?: DegradeLogger,
    ) {
        this.id = inner.id;
        this.dims = inner.dims;
    }

    async embed(texts: readonly string[], inputType: EmbedInputType, correlationId: string): Promise<number[][]> {
        if (texts.length === 0) {
            // No API call happens inside (embeddings.ts short-circuits) — the breaker's
            // view of Cohere must not change, in either direction.
            return this.inner.embed(texts, inputType, correlationId);
        }
        try {
            return await this.breaker.exec(() => this.inner.embed(texts, inputType, correlationId));
        } catch (error) {
            if (error instanceof CircuitOpenError) {
                this.logger?.warn(
                    { dependency: 'cohere', operation: 'embed', correlation_id: correlationId },
                    'circuit_open_degraded',
                );
                return []; // dense leg skips — keyword+fusion still serves (degraded, visible)
            }
            throw error;
        }
    }
}

export class CircuitGuardedReranker implements Reranker {
    readonly id: string;

    constructor(
        private readonly inner: Reranker,
        private readonly breaker: CircuitBreaker,
        private readonly logger?: DegradeLogger,
    ) {
        this.id = inner.id;
    }

    async rerank(
        query: string,
        candidates: readonly RerankCandidate[],
        topK: number,
        correlationId: string,
    ): Promise<RerankOutcome> {
        if (candidates.length === 0) {
            // No API call happens inside (rerank.ts short-circuits) — must not feed the breaker.
            return this.inner.rerank(query, candidates, topK, correlationId);
        }
        try {
            return await this.breaker.exec(() => this.inner.rerank(query, candidates, topK, correlationId));
        } catch (error) {
            if (error instanceof CircuitOpenError) {
                this.logger?.warn(
                    { dependency: 'cohere', operation: 'rerank', correlation_id: correlationId },
                    'circuit_open_degraded',
                );
                // Mirror PassthroughReranker's degraded-order shape (rerank.ts) — the fused
                // order serves and rerank_applied=false says so.
                return {
                    order: candidates.slice(0, topK).map((candidate, index) => ({ id: candidate.id, score: 1 - index * 0.01 })),
                    rerankApplied: false,
                };
            }
            throw error;
        }
    }
}
