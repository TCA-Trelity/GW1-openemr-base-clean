// Anthropic client tool-use parsing (TC1). The client speaks stream: true, so these fakes
// speak SSE. Covers: a tool_use block accumulated from content_block_start + input_json_delta
// + content_block_stop; the no-tools path staying byte-identical (no `tools` in the request
// body, text + citations unchanged); and the tools-passed request shape. No live Anthropic.
import { describe, expect, it, vi } from 'vitest';
import { AnthropicClient, type AnthropicTool, type FetchLike } from '../src/prep/anthropic.js';

function sse(events: Record<string, unknown>[]): string {
    return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

function response(events: Record<string, unknown>[]): Response {
    return new Response(sse(events), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function clientWith(...responses: Response[]): { client: AnthropicClient; fetchMock: ReturnType<typeof vi.fn<FetchLike>> } {
    const fetchMock = vi.fn<FetchLike>();
    for (const res of responses) {
        fetchMock.mockResolvedValueOnce(res);
    }
    return { client: new AnthropicClient({ apiKey: 'test-key', model: 'claude-haiku-4-5', fetchImpl: fetchMock }), fetchMock };
}

const SAMPLE_TOOLS: AnthropicTool[] = [
    {
        name: 'get_full_document',
        description: 'Fetch a document by id.',
        input_schema: { type: 'object', properties: { document_id: { type: 'string' } }, required: ['document_id'] },
    },
];

describe('AnthropicClient tool_use parsing', () => {
    // Guards: a tool_use block streamed as content_block_start (id+name) then input_json_delta
    // fragments then content_block_stop surfaces as one finalized, JSON-parsed tool call, with
    // stop_reason 'tool_use' and any leading text preserved.
    it('accumulates a tool_use block into a finalized tool call', async () => {
        const { client, fetchMock } = clientWith(
            response([
                { type: 'message_start', message: { model: 'claude-haiku-4-5', usage: { input_tokens: 500, output_tokens: 1 } } },
                { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
                { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me look that up.' } },
                { type: 'content_block_stop', index: 0 },
                { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_full_document' } },
                { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"document_id":' } },
                { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ' "doc-mc-004"}' } },
                { type: 'content_block_stop', index: 1 },
                { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } },
                { type: 'message_stop' },
            ]),
        );

        const completion = await client.complete('sys', [{ role: 'user', content: 'hi' }], 'corr-tool', undefined, SAMPLE_TOOLS);

        expect(completion.stop_reason).toBe('tool_use');
        expect(completion.text).toBe('Let me look that up.');
        expect(completion.tool_uses).toEqual([{ id: 'toolu_1', name: 'get_full_document', input: { document_id: 'doc-mc-004' } }]);
        // When tools are passed, the request body carries them.
        const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as Record<string, unknown>;
        expect(body['tools']).toEqual(SAMPLE_TOOLS);
    });

    // Guards: a no-argument tool (no input_json_delta arrives) finalizes with input {} rather
    // than throwing on JSON.parse('').
    it('finalizes a no-argument tool call to an empty input object', async () => {
        const { client } = clientWith(
            response([
                { type: 'message_start', message: { model: 'claude-haiku-4-5', usage: { input_tokens: 10, output_tokens: 1 } } },
                { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_2', name: 'get_open_questions' } },
                { type: 'content_block_stop', index: 0 },
                { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
                { type: 'message_stop' },
            ]),
        );

        const completion = await client.complete('sys', [{ role: 'user', content: 'q' }], 'corr-empty', undefined, []);
        expect(completion.tool_uses).toEqual([{ id: 'toolu_2', name: 'get_open_questions', input: {} }]);
    });

    // Guards: the no-tools path is untouched — text + citations still parse exactly, no
    // tool_uses, and crucially the request body has NO `tools` field (byte-identical to prep).
    it('leaves the text + citations path unchanged and omits `tools` when none are passed', async () => {
        const DOC = 'Plaquenil 200 mg daily since 2019.';
        const { client, fetchMock } = clientWith(
            response([
                { type: 'message_start', message: { model: 'claude-haiku-4-5', usage: { input_tokens: 900, output_tokens: 1 } } },
                { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'On Plaquenil.' } },
                {
                    type: 'content_block_delta',
                    index: 0,
                    delta: {
                        type: 'citations_delta',
                        citation: { type: 'char_location', cited_text: 'Plaquenil 200 mg', document_index: 0, start_char_index: 0, end_char_index: 16 },
                    },
                },
                { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } },
                { type: 'message_stop' },
            ]),
        );
        const deltas: string[] = [];
        const completion = await client.complete('sys', [{ role: 'user', content: DOC }], 'corr-plain', {
            onTextDelta: (text) => deltas.push(text),
        });

        expect(deltas.join('')).toBe('On Plaquenil.');
        expect(completion.text).toBe('On Plaquenil.');
        expect(completion.citations).toHaveLength(1);
        expect(completion.tool_uses).toEqual([]);
        expect(completion.stop_reason).toBe('end_turn');
        const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as Record<string, unknown>;
        expect('tools' in body).toBe(false);
    });
});
