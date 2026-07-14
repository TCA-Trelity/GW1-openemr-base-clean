// Wave C.2 (REQ S3/R4, locked decision #4): the fast-model tie-break is bounded and can
// NEVER take down a turn — unparseable output and client failures both degrade to
// fast_path, which is always safe (the Week 1 chat loop keeps its full tool belt).
import { describe, expect, it } from 'vitest';
import { LlmRouterModel } from '../src/graph/routerModel.js';
import type { AnthropicCompletion } from '../src/prep/anthropic.js';

function completion(text: string): AnthropicCompletion {
    return {
        text,
        citations: [],
        tool_uses: [],
        usage: { input_tokens: 20, output_tokens: 2 },
        stop_reason: 'end_turn',
        model: 'stub',
    };
}

describe('LlmRouterModel (C.2)', () => {
    it('parses EVIDENCE and FAST verdicts (case/whitespace tolerant)', async () => {
        const evidence = new LlmRouterModel({ complete: async () => completion('EVIDENCE') });
        expect(await evidence.decide('Thoughts on the kidneys here?', 'c1')).toBe('needs_evidence');
        const fast = new LlmRouterModel({ complete: async () => completion(' fast\n') });
        expect(await fast.decide('Anything new?', 'c2')).toBe('fast_path');
    });

    it('degrades unparseable output to fast_path with a warning', async () => {
        const warnings: string[] = [];
        const model = new LlmRouterModel(
            { complete: async () => completion('I would need more context to say') },
            { warn: (_obj, msg) => warnings.push(msg) },
        );
        expect(await model.decide('Hmm?', 'c3')).toBe('fast_path');
        expect(warnings.some((msg) => msg.includes('router_model_unparseable'))).toBe(true);
    });

    it('degrades a client failure to fast_path with a warning — never throws', async () => {
        const warnings: string[] = [];
        const model = new LlmRouterModel(
            {
                complete: async () => {
                    throw new Error('boom');
                },
            },
            { warn: (_obj, msg) => warnings.push(msg) },
        );
        expect(await model.decide('Hmm?', 'c4')).toBe('fast_path');
        expect(warnings.some((msg) => msg.includes('router_model_failed'))).toBe(true);
    });
});
