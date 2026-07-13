// E.9 composer tests. Failure modes guarded: an empty-evidence answer costing an LLM
// call, citations drifting off the 12-field guideline_evidence shape the critic expects,
// malformed model output escaping as a thrown error (must degrade honest), and
// composition calls dodging the $5/day ledger.
import { describe, expect, it, vi } from 'vitest';
import { LlmAnswerComposer } from '../src/graph/composer.js';
import type { AnthropicCompletion } from '../src/prep/anthropic.js';
import type { EvidenceSnippet } from '../src/retrieval/retriever.js';

function completion(text: string): AnthropicCompletion {
    return { text, citations: [], tool_uses: [], usage: { input_tokens: 800, output_tokens: 200 }, stop_reason: 'end_turn', model: 'stub-chat' };
}

const SNIPPET: EvidenceSnippet = {
    chunk_id: 'hcq-screening#annual-screening',
    doc_id: 'hcq-screening',
    section_title: 'Annual screening',
    quote: 'Annual screening begins after five years of use for patients without major risk factors.',
    text: 'HCQ Screening › Annual screening: Annual screening begins after five years of use for patients without major risk factors.',
    score: 0.9,
    guideline_source: 'AAO 2016 hydroxychloroquine screening recommendations',
    version: '2026-07',
    disease_tags: ['hcq'],
    rerank_applied: false,
};

const VALID_JSON = JSON.stringify({
    text: 'Per the practice protocol, annual screening begins after five years of use.',
    claims: [
        {
            id: 'claim-1',
            citations: [
                {
                    id: 'cit-1',
                    fact_id: null,
                    source_label: SNIPPET.guideline_source,
                    source_type: 'guideline_evidence',
                    excerpt_text: 'Annual screening begins after five years of use',
                    excerpt_location: null,
                    attribution: null,
                    source_document_id: SNIPPET.chunk_id,
                    document_date: null,
                    deep_link_url: null,
                    page_or_section: SNIPPET.section_title,
                    field_or_chunk_id: SNIPPET.chunk_id,
                },
            ],
        },
    ],
});

const ASK = { kind: 'chat_turn' as const, patientId: 'pt-1', question: 'When should screening start?' };

describe('LlmAnswerComposer (E.9)', () => {
    it('answers the no-protocol text with ZERO LLM calls when evidence is empty', async () => {
        const complete = vi.fn();
        const composer = new LlmAnswerComposer({ complete });
        const draft = await composer.compose(ASK, [], null, 'c1');
        expect(draft.text).toBe('No practice protocol on file covers this question.');
        expect(draft.claims).toEqual([]);
        expect(complete).not.toHaveBeenCalled();
    });

    it('parses a valid completion into claims with 12-field guideline_evidence citations', async () => {
        const composer = new LlmAnswerComposer({ complete: async () => completion(VALID_JSON) });
        const draft = await composer.compose(ASK, [SNIPPET], null, 'c2');
        expect(draft.claims).toHaveLength(1);
        const citation = draft.claims[0]!.citations[0]!;
        expect(citation.source_type).toBe('guideline_evidence');
        expect(citation.source_document_id).toBe(SNIPPET.chunk_id);
        expect(citation.page_or_section).toBe(SNIPPET.section_title);
        expect(citation.field_or_chunk_id).toBe(SNIPPET.chunk_id);
    });

    it('repairs once on malformed JSON, then fails honest with zero claims', async () => {
        const complete = vi
            .fn()
            .mockResolvedValueOnce(completion('Sure! Here is my thinking about screening…'))
            .mockResolvedValueOnce(completion('still not { valid json'));
        const composer = new LlmAnswerComposer({ complete });
        const draft = await composer.compose(ASK, [SNIPPET], null, 'c3');
        expect(complete).toHaveBeenCalledTimes(2);
        expect(draft.claims).toEqual([]);
        expect(draft.text).toContain('could not compose a guideline-backed answer');
    });

    it('records every call to the spend ledger with purpose evidence_composition', async () => {
        const recordCall = vi.fn(async () => {});
        const composer = new LlmAnswerComposer(
            { complete: async () => completion(VALID_JSON) },
            { recordCall, assertBudget: async () => {} },
        );
        await composer.compose(ASK, [SNIPPET], null, 'c4');
        expect(recordCall).toHaveBeenCalledTimes(1);
        expect(recordCall).toHaveBeenCalledWith({
            correlationId: 'c4',
            purpose: 'evidence_composition',
            model: 'stub-chat',
            inputTokens: 800,
            outputTokens: 200,
        });
    });

    it('never throws — API errors and budget denials degrade to the honest-failure answer', async () => {
        const warnings: string[] = [];
        const logger = { warn: (_obj: Record<string, unknown>, msg: string) => warnings.push(msg) };
        const apiBroken = new LlmAnswerComposer(
            {
                complete: async () => {
                    throw new Error('boom');
                },
            },
            undefined,
            logger,
        );
        const draft = await apiBroken.compose(ASK, [SNIPPET], null, 'c5');
        expect(draft.claims).toEqual([]);
        expect(draft.text).toContain('could not compose');
        const overBudget = new LlmAnswerComposer(
            { complete: async () => completion(VALID_JSON) },
            {
                recordCall: async () => {},
                assertBudget: async () => {
                    throw new Error('daily budget reached');
                },
            },
            logger,
        );
        expect((await overBudget.compose(ASK, [SNIPPET], null, 'c6')).claims).toEqual([]);
        expect(warnings.filter((msg) => msg === 'composer_failed')).toHaveLength(2);
    });
});
