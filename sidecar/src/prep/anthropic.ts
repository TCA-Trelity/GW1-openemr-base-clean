// Minimal Anthropic Messages API client over injected fetch — no SDK dependency (S1.7).
// Requests STREAM (required above ~16K output tokens; extraction needs far more than the
// old 16K cap) and accumulate text deltas; hung calls die on an idle timeout instead of
// wedging the prep run forever. Sampling params are deliberately omitted: claude-sonnet-5
// rejects non-default temperature/top_p/top_k with a 400; determinism comes from the
// prompt + Zod validation.
import type { CircuitBreaker } from '../lib/circuitBreaker.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Loose content-block shape (document blocks for the Citations API, text blocks, ...). */
export type AnthropicContentBlock = Record<string, unknown>;

export interface AnthropicMessage {
    role: 'user' | 'assistant';
    content: string | AnthropicContentBlock[];
}

export interface AnthropicUsage {
    input_tokens: number;
    output_tokens: number;
}

/** A tool definition offered to the model — one entry of the Messages API `tools` array. */
export interface AnthropicTool {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
}

/** A finalized tool call the model requested, accumulated from the stream. */
export interface AnthropicToolUse {
    id: string;
    name: string;
    input: Record<string, unknown>;
}

export interface AnthropicCompletion {
    /** Concatenated text deltas (thinking deltas are skipped). */
    text: string;
    /** Citations API objects (char_location) in arrival order, when documents enable them. */
    citations: Record<string, unknown>[];
    /** Tool calls the model requested, in arrival order — empty unless `tools` was passed. */
    tool_uses: AnthropicToolUse[];
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

/** Per-call hooks: heartbeat cadence + raw text/citation deltas (chat relays them live). */
export interface CompleteHooks {
    onProgress?: OnProgress;
    onTextDelta?: (text: string) => void;
    onCitation?: (citation: Record<string, unknown>) => void;
}

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
    /** H.10: the shared 'anthropic' circuit breaker — ONE instance across every client of
     *  this dependency (prep, chat, router, composer). complete() runs through breaker.exec:
     *  one complete = one logical call = one breaker failure. */
    breaker?: CircuitBreaker;
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
// Per-call output budget: extraction is per-document, so 8K is generous headroom for
// one document's facts. Config LLM_MAX_OUTPUT_TOKENS overrides.
const DEFAULT_MAX_TOKENS = 8192;
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
    private readonly breaker: CircuitBreaker | undefined;

    constructor(options: AnthropicClientOptions) {
        this.apiKey = options.apiKey;
        this.model = options.model;
        this.url = `${(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}/v1/messages`;
        this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
        this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
        this.totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
        this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
        this.breaker = options.breaker;
    }

    async complete(
        system: string,
        messages: AnthropicMessage[],
        correlationId: string,
        hooks?: CompleteHooks,
        tools?: AnthropicTool[],
    ): Promise<AnthropicCompletion> {
        // Config absence is not a dependency failure — surface it without consulting
        // (or feeding) the circuit.
        if (this.apiKey === '') {
            throw new AnthropicApiError(0, 'not_configured', 'ANTHROPIC_API_KEY is not configured');
        }
        // H.10: the breaker wraps the whole attempt — one complete() = one logical call =
        // ONE breaker failure. When open, CircuitOpenError propagates to the caller's
        // existing fallback lane (router → fast_path, composer/chat → Week 1 loop or error
        // event, extractor → failed_extraction): a fast throw IS the degraded behavior.
        if (this.breaker === undefined) {
            return this.streamCompletion(system, messages, correlationId, hooks, tools);
        }
        return this.breaker.exec(() => this.streamCompletion(system, messages, correlationId, hooks, tools));
    }

    private async streamCompletion(
        system: string,
        messages: AnthropicMessage[],
        correlationId: string,
        hooks?: CompleteHooks,
        tools?: AnthropicTool[],
    ): Promise<AnthropicCompletion> {
        const onProgress = hooks?.onProgress;
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

        const state: StreamState = {
            text: '',
            citations: [],
            toolUses: [],
            toolBuffers: new Map(),
            inputTokens: 0,
            outputTokens: 0,
            stopReason: null,
            model: this.model,
        };
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
                        // Additive: only serialize `tools` when the caller passes them, so the
                        // no-tools body (all prep extraction calls) stays byte-identical.
                        ...(tools === undefined ? {} : { tools }),
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
                    emit(handleSseLine(line, state), hooks);
                }
            }
            emit(handleSseLine(buffer, state), hooks);
            return {
                text: state.text,
                citations: state.citations,
                tool_uses: state.toolUses,
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

/** In-flight tool_use block: its id/name plus the partial JSON string being accumulated. */
interface ToolUseBuffer {
    id: string;
    name: string;
    json: string;
}

interface StreamState {
    text: string;
    citations: Record<string, unknown>[];
    /** Finalized tool calls (one per content_block_stop of a tool_use block). */
    toolUses: AnthropicToolUse[];
    /** Open tool_use blocks keyed by content-block index while their input streams in. */
    toolBuffers: Map<number, ToolUseBuffer>;
    inputTokens: number;
    outputTokens: number;
    stopReason: string | null;
    model: string;
}

type SseEmission = { text?: string; citation?: Record<string, unknown> } | undefined;

function emit(emission: SseEmission, hooks: CompleteHooks | undefined): void {
    if (emission?.text !== undefined) {
        hooks?.onTextDelta?.(emission.text);
    }
    if (emission?.citation !== undefined) {
        hooks?.onCitation?.(emission.citation);
    }
}

// One SSE line. Only `data:` lines matter — the payload's own `type` field routes it.
// Returns the text/citation delta carried by this line, if any.
function handleSseLine(line: string, state: StreamState): SseEmission {
    if (!line.startsWith('data:')) {
        return undefined;
    }
    let event: unknown;
    try {
        event = JSON.parse(line.slice(5).trim());
    } catch {
        return; // tolerate keep-alive noise; real malformation surfaces as validation failure downstream
    }
    if (!isRecord(event)) {
        return undefined;
    }
    switch (event['type']) {
        case 'message_start': {
            const message = isRecord(event['message']) ? event['message'] : undefined;
            state.model = asString(message?.['model']) ?? state.model;
            const usage = isRecord(message?.['usage']) ? message['usage'] : undefined;
            state.inputTokens = asNumber(usage?.['input_tokens']) ?? state.inputTokens;
            return undefined;
        }
        case 'content_block_start': {
            // Only tool_use blocks need capture; text-block starts stay no-ops (byte-identical
            // to the prior default handling). Record id + name; input arrives via input_json_delta.
            const block = isRecord(event['content_block']) ? event['content_block'] : undefined;
            if (block?.['type'] !== 'tool_use') {
                return undefined;
            }
            const index = asNumber(event['index']);
            const id = asString(block['id']);
            const name = asString(block['name']);
            if (index !== undefined && id !== undefined && name !== undefined) {
                state.toolBuffers.set(index, { id, name, json: '' });
            }
            return undefined;
        }
        case 'content_block_delta': {
            const delta = isRecord(event['delta']) ? event['delta'] : undefined;
            if (delta?.['type'] === 'text_delta' && typeof delta['text'] === 'string') {
                state.text += delta['text'];
                return { text: delta['text'] };
            }
            // Citations API: each citations_delta carries ONE citation supporting the
            // text block currently streaming.
            if (delta?.['type'] === 'citations_delta' && isRecord(delta['citation'])) {
                state.citations.push(delta['citation']);
                return { citation: delta['citation'] };
            }
            // Tool input streams as partial JSON fragments appended to the open block.
            if (delta?.['type'] === 'input_json_delta' && typeof delta['partial_json'] === 'string') {
                const index = asNumber(event['index']);
                const buffer = index === undefined ? undefined : state.toolBuffers.get(index);
                if (buffer !== undefined) {
                    buffer.json += delta['partial_json'];
                }
            }
            return undefined;
        }
        case 'content_block_stop': {
            // Finalize a tool_use block: parse its accumulated input JSON (empty -> {}).
            const index = asNumber(event['index']);
            const buffer = index === undefined ? undefined : state.toolBuffers.get(index);
            if (index !== undefined && buffer !== undefined) {
                state.toolBuffers.delete(index);
                state.toolUses.push({ id: buffer.id, name: buffer.name, input: parseToolInput(buffer.json) });
            }
            return undefined;
        }
        case 'message_delta': {
            const delta = isRecord(event['delta']) ? event['delta'] : undefined;
            state.stopReason = asString(delta?.['stop_reason']) ?? state.stopReason;
            const usage = isRecord(event['usage']) ? event['usage'] : undefined;
            state.outputTokens = asNumber(usage?.['output_tokens']) ?? state.outputTokens;
            return undefined;
        }
        case 'error': {
            const error = isRecord(event['error']) ? event['error'] : undefined;
            throw new AnthropicApiError(0, asString(error?.['type']) ?? 'stream_error', asString(error?.['message']));
        }
        default:
            return undefined; // ping, message_stop
    }
}

// Finalize a tool_use block's streamed input. Empty (no input_json_delta arrived, i.e. a
// no-argument tool) parses to {}; malformed JSON degrades to {} so the tool sees empty input
// and returns its own structured error rather than the whole stream throwing.
function parseToolInput(json: string): Record<string, unknown> {
    const trimmed = json.trim();
    if (trimmed === '') {
        return {};
    }
    try {
        const parsed: unknown = JSON.parse(trimmed);
        return isRecord(parsed) ? parsed : {};
    } catch {
        return {};
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
