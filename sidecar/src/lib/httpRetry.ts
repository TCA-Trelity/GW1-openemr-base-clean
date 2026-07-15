// Shared outbound-HTTP resilience (REQ G2): a hard per-attempt timeout plus at most ONE
// bounded retry on transient failures. Moved here from retrieval/embeddings.ts (H.5) so the
// OpenEMR clients can use it without importing from the retrieval folder; the retrieval
// providers (embeddings, rerank) now import from here too. Deliberately dependency-free —
// transient detection duck-types on a numeric `status` property so every client's own error
// family (RetrievalProviderError, StandardApiError, FhirRequestError, OpenEmrAuthError)
// participates without this module knowing any of them.

/** HTTP statuses treated as transient — worth exactly one fresh attempt, never more. */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Default timeout error when the caller maps none. Carries status 408 so an outer retry
 * layer (if any) still recognizes it as transient.
 */
export class HttpTimeoutError extends Error {
    public readonly status = 408;

    constructor(
        public readonly operation: string,
        public readonly timeoutMs: number,
    ) {
        super(`${operation} timed out after ${timeoutMs}ms`);
        this.name = 'HttpTimeoutError';
    }
}

export interface TimeoutRetryOptions {
    /**
     * 1 (default): one bounded retry on transient failures. 0: never retry automatically —
     * required for non-idempotent writes, where a retried request can double-apply.
     */
    retries?: 0 | 1;
    /**
     * Map the final timeout into the caller's typed error family (e.g. StandardApiError with
     * status 408) so downstream `instanceof` handling keeps working. Default: HttpTimeoutError.
     */
    onTimeout?: (operation: string, timeoutMs: number) => Error;
}

/**
 * Hard timeout per attempt + at most one bounded retry on transient failures (REQ G2).
 * Each attempt gets a fresh AbortController; the attempt is also raced against the abort,
 * so even an attempt that ignores the signal (a truly hung socket / naive stub) rejects at
 * the deadline instead of hanging forever.
 */
export async function withTimeoutAndRetry<T>(
    operation: string,
    timeoutMs: number,
    attempt: (signal: AbortSignal) => Promise<T>,
    options?: TimeoutRetryOptions,
): Promise<T> {
    const retries = options?.retries ?? 1;
    for (let round = 0; ; round += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await raceAgainstAbort(attempt(controller.signal), controller.signal, operation);
        } catch (error) {
            const transient = hasTransientStatus(error) || isAbortError(error);
            if (round < retries && transient) {
                continue; // one fresh attempt (new controller, new timer)
            }
            if (isAbortError(error)) {
                throw options?.onTimeout !== undefined
                    ? options.onTimeout(operation, timeoutMs)
                    : new HttpTimeoutError(operation, timeoutMs);
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }
}

// Settle with the work's outcome, or reject with an AbortError the moment the signal fires —
// whichever comes first. Wiring the work's rejection into the (possibly already settled)
// promise also marks it handled, so a late failure never surfaces as an unhandled rejection.
function raceAgainstAbort<T>(work: Promise<T>, signal: AbortSignal, operation: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(abortError(operation)), { once: true });
        work.then(resolve, reject);
    });
}

function abortError(operation: string): Error {
    const error = new Error(`${operation} aborted by timeout`);
    error.name = 'AbortError';
    return error;
}

/** An Error carrying a numeric `status` in the transient set — every client error family qualifies. */
function hasTransientStatus(error: unknown): boolean {
    if (!(error instanceof Error) || !('status' in error)) {
        return false;
    }
    const status = (error as Error & { status: unknown }).status;
    return typeof status === 'number' && TRANSIENT_STATUSES.has(status);
}

/** Node's fetch rejects an aborted request with a DOMException named AbortError (instanceof Error). */
function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
}
