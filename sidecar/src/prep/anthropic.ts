// Minimal Anthropic Messages API client over injected fetch — no SDK dependency (S1.7).
// Sampling params are deliberately omitted: claude-sonnet-5 rejects non-default
// temperature/top_p/top_k with a 400; determinism comes from the prompt + Zod validation.
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
    /** Concatenated text blocks (thinking blocks are skipped). */
    text: string;
    usage: AnthropicUsage;
    stop_reason: string | null;
    model: string;
}

// Typed API failure: status plus the API error type/message only — never the raw body.
export class AnthropicApiError extends Error {
    constructor(
        public readonly status: number,
        apiErrorType?: string,
        apiErrorMessage?: string,
    ) {
        const detail = [apiErrorType, apiErrorMessage].filter(Boolean).join(': ');
        super(`Anthropic request failed with status ${status}${detail ? ` (${detail})` : ''}`);
        this.name = 'AnthropicApiError';
    }
}

export interface AnthropicClientOptions {
    apiKey: string;
    model: string;
    baseUrl?: string;
    maxTokens?: number;
    fetchImpl?: FetchLike;
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
// Non-streaming ceiling: above ~16K output the HTTP request risks timing out.
const DEFAULT_MAX_TOKENS = 16000;

export class AnthropicClient {
    private readonly apiKey: string;
    private readonly model: string;
    private readonly url: string;
    private readonly maxTokens: number;
    private readonly fetchImpl: FetchLike;

    constructor(options: AnthropicClientOptions) {
        this.apiKey = options.apiKey;
        this.model = options.model;
        this.url = `${(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}/v1/messages`;
        this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    }

    async complete(
        system: string,
        messages: AnthropicMessage[],
        correlationId: string,
    ): Promise<AnthropicCompletion> {
        if (this.apiKey === '') {
            throw new AnthropicApiError(0, 'not_configured', 'ANTHROPIC_API_KEY is not configured');
        }
        const response = await this.fetchImpl(this.url, {
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
                system,
                messages,
            }),
        });
        const body = await parseJsonBody(response);
        if (!response.ok) {
            const error = isRecord(body?.['error']) ? body['error'] : undefined;
            throw new AnthropicApiError(
                response.status,
                asString(error?.['type']),
                asString(error?.['message']),
            );
        }
        if (body === undefined) {
            throw new AnthropicApiError(response.status, 'invalid_response', 'response was not a JSON object');
        }
        return {
            text: textBlocksOf(body['content']),
            usage: usageOf(body['usage']),
            stop_reason: asString(body['stop_reason']) ?? null,
            model: asString(body['model']) ?? this.model,
        };
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function textBlocksOf(content: unknown): string {
    if (!Array.isArray(content)) {
        return '';
    }
    return content
        .map((block: unknown) =>
            isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string'
                ? block['text']
                : '',
        )
        .join('');
}

function usageOf(usage: unknown): AnthropicUsage {
    const record = isRecord(usage) ? usage : {};
    return {
        input_tokens: typeof record['input_tokens'] === 'number' ? record['input_tokens'] : 0,
        output_tokens: typeof record['output_tokens'] === 'number' ? record['output_tokens'] : 0,
    };
}

async function parseJsonBody(response: Response): Promise<Record<string, unknown> | undefined> {
    try {
        const parsed: unknown = await response.json();
        return isRecord(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}
