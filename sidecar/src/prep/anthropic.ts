// Minimal Anthropic Messages API client over injected fetch — no SDK dependency (S1.7).
// Requests STREAM (required above ~16K output tokens; extraction needs far more than the
// old 16K cap) and accumulate text deltas; hung calls die on an idle timeout instead of
// wedging the prep run forever. Sampling params are deliberately omitted: claude-sonnet-5
// rejects non-default temperature/top_p/top_k with a 400; determinism comes from the
// prompt + Zod validation.
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface AnthropicMessage {
    role: 'user' | 'assistant';
    content: string;
}

export interface AnthropicUsage {
    input_tokens: number;
    output_tokens: number;
}

export interface AnthropicCompletion {
    /** Concatenated text deltas (thinking deltas are skipped). */
    text: string;
    usage: AnthropicUsage;
    stop_reason: string | null;
    model: string;
}

/** Periodic in-flight progress snapshot — the caller's observability heartbeat. */
export interface StreamProgress {
    textChars: number;
    elapsedMs: number;
}
export type OnProgress = (progress: StreamProgress) => void;

// Typed API failure: status plus the API error type/message only — never the raw body.
export class AnthropicApiError extends Error {
    constructor(
        public readonly status: number,
        public readonly apiErrorType?: string,
        apiErrorMessage?: string,
    ) {
        const detail = [apiErrorType, apiErrorMessage].filter(Boolean).join(': ');
        super(`Anthropic request failed with status ${status}${detail ? ` (${detail})` : ''}`);
        this.name = 'AnthropicApiError';
    }
}

// Retryable failures: our own timeouts, rate limits, overload, and 5xx — one fresh
// attempt is cheap next to a dead prep run. 4xx contract errors are never retried.
const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);
export function isTransientAnthropicError(error: unknown): boolean {
    return (
        error instanceof AnthropicApiError &&
        (TRANSIENT_STATUSES.has(error.status) ||
            error.apiErrorType === 'timeout' ||
            error.apiErrorType === 'overloaded_error' ||
            error.apiErrorType === 'stream_error')
    );
}

export interface AnthropicClientOptions {
    apiKey: string;
    model: string;
    baseUrl?: string;
    maxTokens?: number;
    fetchImpl?: FetchLike;
    /** Abort when no stream bytes arrive for this long — the hung-call detector. */
    idleTimeoutMs?: number;
    /** Absolute ceiling on one call, however slowly it drips. */
    totalTimeoutMs?: number;
    /** Cadence of onProgress heartbeats while streaming. */
    heartbeatMs?: number;
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
// Streaming output budget: sonnet-5 allows up to 128K; extraction re-quotes source text
// per citation so its output scales with input. Unused budget costs nothing.
const DEFAULT_MAX_TOKENS = 64000;
const DEFAULT_IDLE_TIMEOUT_MS = 90_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 900_000;
const DEFAULT_HEARTBEAT_MS = 15_000;

export class AnthropicClient {
    private readonly apiKey: string;
    private readonly model: string;
    private readonly url: string;
    private readonly maxTokens: number;
    private readonly fetchImpl: FetchLike;
    private readonly idleTimeoutMs: number;
    private readonly totalTimeoutMs: number;
    private readonly heartbeatMs: number;

    constructor(options: AnthropicClientOptions) {
        this.apiKey = options.apiKey;
        this.model = options.model;
        this.url = `${(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}/v1/messages`;
        this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
        this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
        this.totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
        this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    }

    async complete(
        system: string,
        messages: AnthropicMessage[],
        correlationId: string,
        onProgress?: OnProgress,
    ): Promise<AnthropicCompletion> {
        if (this.apiKey === '') {
            throw new AnthropicApiError(0, 'not_configured', 'ANTHROPIC_API_KEY is not configured');
        }
        const startedAt = Date.now();
        const controller = new AbortController();
        let abortReason = '';
        const abort = (reason: string): void => {
            abortReason = reason;
            controller.abort();
        };
        // Race every await against the abort signal: injected test fetches (and some fetch
        // impls) do not tie their streams to the signal, so the timeout must not rely on it.
        const abortedPromise = new Promise<never>((_, reject) => {
            controller.signal.addEventListener('abort', () =>
                reject(new AnthropicApiError(0, 'timeout', abortReason)),
            );
        });
        const totalTimer = setTimeout(
            () => abort(`call exceeded ${this.totalTimeoutMs}ms total`),
            this.totalTimeoutMs,
        );
        let idleTimer = setTimeout(() => abort(`no stream progress for ${this.idleTimeoutMs}ms`), this.idleTimeoutMs);
        const resetIdle = (): void => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => abort(`no stream progress for ${this.idleTimeoutMs}ms`), this.idleTimeoutMs);
        };

        const state = { text: '', inputTokens: 0, outputTokens: 0, stopReason: null as string | null, model: this.model };
        const heartbeat =
            onProgress === undefined
                ? undefined
                : setInterval(
                      () => onProgress({ textChars: state.text.length, elapsedMs: Date.now() - startedAt }),
                      this.heartbeatMs,
                  );

        try {
            const response = await Promise.race([
                this.fetchImpl(this.url, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'x-api-key': this.apiKey,
                        'anthropic-version': '2023-06-01',
                        'x-correlation-id': correlationId,
                    },
                    body: JSON.stringify({
                        model: this.model,
                        max_tokens: this.maxTokens,
                        stream: true,
                        system,
                        messages,
                    }),
                    signal: controller.signal,
                }),
                abortedPromise,
            ]);
            resetIdle();
            if (!response.ok) {
                // Error responses are plain JSON, not SSE.
                const body = await Promise.race([parseJsonBody(response), abortedPromise]);
                const error = isRecord(body?.['error']) ? body['error'] : undefined;
                throw new AnthropicApiError(
                    response.status,
                    asString(error?.['type']),
                    asString(error?.['message']),
                );
            }
            if (response.body === null) {
                throw new AnthropicApiError(response.status, 'invalid_response', 'response had no body stream');
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            for (;;) {
                const chunk = await Promise.race([reader.read(), abortedPromise]);
                if (chunk.done) {
                    break;
                }
                resetIdle();
                buffer += decoder.decode(chunk.value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const line of lines) {
                    handleSseLine(line, state);
                }
            }
            handleSseLine(buffer, state);
            return {
                text: state.text,
                usage: { input_tokens: state.inputTokens, output_tokens: state.outputTokens },
                stop_reason: state.stopReason,
                model: state.model,
            };
        } catch (error) {
            // Abort surfaced through fetch/read instead of our race: normalize to timeout.
            if (controller.signal.aborted && !(error instanceof AnthropicApiError)) {
                throw new AnthropicApiError(0, 'timeout', abortReason);
            }
            throw error;
        } finally {
            clearTimeout(totalTimer);
            clearTimeout(idleTimer);
            if (heartbeat !== undefined) {
                clearInterval(heartbeat);
            }
        }
    }
}

interface StreamState {
    text: string;
    inputTokens: number;
    outputTokens: number;
    stopReason: string | null;
    model: string;
}

// One SSE line. Only `data:` lines matter — the payload's own `type` field routes it.
function handleSseLine(line: string, state: StreamState): void {
    if (!line.startsWith('data:')) {
        return;
    }
    let event: unknown;
    try {
        event = JSON.parse(line.slice(5).trim());
    } catch {
        return; // tolerate keep-alive noise; real malformation surfaces as validation failure downstream
    }
    if (!isRecord(event)) {
        return;
    }
    switch (event['type']) {
        case 'message_start': {
            const message = isRecord(event['message']) ? event['message'] : undefined;
            state.model = asString(message?.['model']) ?? state.model;
            const usage = isRecord(message?.['usage']) ? message['usage'] : undefined;
            state.inputTokens = asNumber(usage?.['input_tokens']) ?? state.inputTokens;
            return;
        }
        case 'content_block_delta': {
            const delta = isRecord(event['delta']) ? event['delta'] : undefined;
            if (delta?.['type'] === 'text_delta' && typeof delta['text'] === 'string') {
                state.text += delta['text'];
            }
            return;
        }
        case 'message_delta': {
            const delta = isRecord(event['delta']) ? event['delta'] : undefined;
            state.stopReason = asString(delta?.['stop_reason']) ?? state.stopReason;
            const usage = isRecord(event['usage']) ? event['usage'] : undefined;
            state.outputTokens = asNumber(usage?.['output_tokens']) ?? state.outputTokens;
            return;
        }
        case 'error': {
            const error = isRecord(event['error']) ? event['error'] : undefined;
            throw new AnthropicApiError(0, asString(error?.['type']) ?? 'stream_error', asString(error?.['message']));
        }
        default:
            return; // ping, content_block_start/stop, message_stop
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
    return typeof value === 'number' ? value : undefined;
}

async function parseJsonBody(response: Response): Promise<Record<string, unknown> | undefined> {
    try {
        const parsed: unknown = await response.json();
        return isRecord(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}
