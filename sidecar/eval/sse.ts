// Mocked Anthropic SSE plumbing for evals that drive FactExtractor without a live LLM —
// the same fake-stream pattern test/prep.test.ts uses (the client speaks stream: true,
// so fakes must speak SSE). Kept dependency-free (no vi.fn) so evals stay plain closures.

export function sseEvents(events: Record<string, unknown>[]): string {
    return events.map((event) => `event: ${String(event['type'])}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

export function llmResponse(payload: unknown, stopReason = 'end_turn'): Response {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const mid = Math.ceil(text.length / 2);
    return new Response(
        sseEvents([
            { type: 'message_start', message: { model: 'claude-haiku-4-5', usage: { input_tokens: 1200, output_tokens: 3 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, mid) } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(mid) } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 800 } },
            { type: 'message_stop' },
        ]),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
}
