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

/** A scripted tool call for llmToolUseResponse. */
export interface ScriptedToolUse {
    id: string;
    name: string;
    input: Record<string, unknown>;
}

/**
 * A model turn that requests tool calls (stop_reason tool_use), optionally preceded by a
 * text block — the shape the chat tool-use loop consumes. Input JSON streams split across
 * two input_json_delta fragments to exercise the client's accumulation path.
 */
export function llmToolUseResponse(toolUses: ScriptedToolUse[], text?: string): Response {
    const events: Record<string, unknown>[] = [
        { type: 'message_start', message: { model: 'claude-haiku-4-5', usage: { input_tokens: 1400, output_tokens: 3 } } },
    ];
    let index = 0;
    if (text !== undefined && text.length > 0) {
        events.push(
            { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
            { type: 'content_block_stop', index },
        );
        index += 1;
    }
    for (const call of toolUses) {
        const json = JSON.stringify(call.input);
        const mid = Math.ceil(json.length / 2);
        events.push(
            { type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name } },
            { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(0, mid) } },
            { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(mid) } },
            { type: 'content_block_stop', index },
        );
        index += 1;
    }
    events.push(
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 120 } },
        { type: 'message_stop' },
    );
    return new Response(sseEvents(events), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** One text segment of llmCitedResponse, optionally backed by a Citations API citation. */
export interface CitedSegment {
    text: string;
    citation?: {
        cited_text: string;
        document_index: number;
        start_char_index: number;
        end_char_index: number;
    };
}

/**
 * A model turn whose text streams with native Citations API citations_delta events —
 * the shape chat's citation verification consumes.
 */
export function llmCitedResponse(segments: CitedSegment[]): Response {
    const events: Record<string, unknown>[] = [
        { type: 'message_start', message: { model: 'claude-haiku-4-5', usage: { input_tokens: 1500, output_tokens: 3 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ];
    for (const segment of segments) {
        events.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: segment.text } });
        if (segment.citation !== undefined) {
            events.push({
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'citations_delta', citation: { type: 'char_location', ...segment.citation } },
            });
        }
    }
    events.push(
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 300 } },
        { type: 'message_stop' },
    );
    return new Response(sseEvents(events), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
