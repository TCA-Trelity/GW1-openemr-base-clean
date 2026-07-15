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

// H.4b: the live model NEAR-quotes (re-punctuates, normalizes units, pluralizes) so the
// verbatim gate blocked every claim and correct answers shipped uncited. The composer now
// pre-checks parsed excerpts with the gate's own verification and retries ONCE with the
// extraction.ts-style validation feedback; a second miss falls through for the critic to
// block, exactly as today. These tests pin call counts — the SpendGuard contract.
const PARAPHRASED_EXCERPT = 'Yearly screening begins after 5 years of use';
const PARAPHRASED_JSON = VALID_JSON.replace('Annual screening begins after five years of use', PARAPHRASED_EXCERPT);

describe('LlmAnswerComposer verbatim excerpt pre-check (H.4b)', () => {
    it('retries once with verbatim-quote feedback when the model paraphrases instead of quoting', async () => {
        const complete = vi
            .fn()
            .mockResolvedValueOnce(completion(PARAPHRASED_JSON))
            .mockResolvedValueOnce(completion(VALID_JSON));
        const recordCall = vi.fn(async () => {});
        const composer = new LlmAnswerComposer({ complete }, { recordCall, assertBudget: async () => {} });
        const draft = await composer.compose(ASK, [SNIPPET], null, 'h4b-1');
        expect(complete).toHaveBeenCalledTimes(2);
        expect(recordCall).toHaveBeenCalledTimes(2); // both calls hit the $5/day ledger
        expect(draft.claims).toHaveLength(1);
        expect(draft.claims[0]!.citations[0]!.excerpt_text).toBe('Annual screening begins after five years of use');
        // The retry threads the failed attempt back and names the offending excerpt.
        const retryMessages = complete.mock.calls[1]![1] as { role: string; content: string }[];
        expect(retryMessages).toHaveLength(3);
        expect(retryMessages[1]).toEqual({ role: 'assistant', content: PARAPHRASED_JSON });
        expect(retryMessages[2]!.role).toBe('user');
        expect(retryMessages[2]!.content).toContain('failed citation verification');
        expect(retryMessages[2]!.content).toContain(PARAPHRASED_EXCERPT);
        expect(retryMessages[2]!.content).toContain('CHARACTER-FOR-CHARACTER');
    });

    it('falls through to the critic after the single retry when the model paraphrases twice', async () => {
        const complete = vi.fn().mockResolvedValue(completion(PARAPHRASED_JSON));
        const composer = new LlmAnswerComposer({ complete });
        const draft = await composer.compose(ASK, [SNIPPET], null, 'h4b-2');
        expect(complete).toHaveBeenCalledTimes(2); // never a third call (SpendGuard)
        // Unchanged terminal behavior: the paraphrased draft ships to the critic, which
        // blocks the claim — the composer never filters and never fails the whole turn.
        expect(draft.claims).toHaveLength(1);
        expect(draft.claims[0]!.citations[0]!.excerpt_text).toBe(PARAPHRASED_EXCERPT);
        expect(draft.text).not.toContain('could not compose');
    });

    it('spends no retry when the model quotes verbatim on the first call', async () => {
        const complete = vi.fn().mockResolvedValue(completion(VALID_JSON));
        const composer = new LlmAnswerComposer({ complete });
        const draft = await composer.compose(ASK, [SNIPPET], null, 'h4b-3');
        expect(complete).toHaveBeenCalledTimes(1); // no retry cost on the happy path
        expect(draft.claims).toHaveLength(1);
    });

    it('does not retry over whitespace runs the gate already tolerates', async () => {
        // The corpus carries OCR-style double spaces; the gate's whitespace-flexible
        // search accepts a single-spaced quote of them. The pre-check must apply the
        // SAME normalization (it reuses the gate), or it would burn retries on drafts
        // the critic was always going to verify.
        const doubleSpaced: EvidenceSnippet = {
            ...SNIPPET,
            chunk_id: 'renal#egfr-thresholds',
            quote: 'eGFR >= 60,  no other risk factor: follow the standard screening cadence.',
        };
        const singleSpacedQuote = JSON.stringify({
            text: 'Per the protocol, standard cadence applies at eGFR >= 60 without other risk factors.',
            claims: [
                {
                    id: 'claim-ws',
                    citations: [
                        {
                            id: 'cit-ws',
                            fact_id: null,
                            source_label: doubleSpaced.guideline_source,
                            source_type: 'guideline_evidence',
                            excerpt_text: 'eGFR >= 60, no other risk factor: follow the standard screening cadence.',
                            excerpt_location: null,
                            attribution: null,
                            source_document_id: doubleSpaced.chunk_id,
                            document_date: null,
                            deep_link_url: null,
                            page_or_section: doubleSpaced.section_title,
                            field_or_chunk_id: doubleSpaced.chunk_id,
                        },
                    ],
                },
            ],
        });
        const complete = vi.fn().mockResolvedValue(completion(singleSpacedQuote));
        const composer = new LlmAnswerComposer({ complete });
        const draft = await composer.compose(ASK, [doubleSpaced], null, 'h4b-4');
        expect(complete).toHaveBeenCalledTimes(1);
        expect(draft.claims).toHaveLength(1);
    });

    it('caps at two calls: a JSON repair that still paraphrases goes to the critic, never a third call', async () => {
        const complete = vi
            .fn()
            .mockResolvedValueOnce(completion('Sure! Screening thoughts follow…'))
            .mockResolvedValueOnce(completion(PARAPHRASED_JSON));
        const composer = new LlmAnswerComposer({ complete });
        const draft = await composer.compose(ASK, [SNIPPET], null, 'h4b-5');
        expect(complete).toHaveBeenCalledTimes(2);
        expect(draft.claims[0]!.citations[0]!.excerpt_text).toBe(PARAPHRASED_EXCERPT);
    });

    it('logs a PHI-safe composer_excerpt_retry event — counts and claim ids, never excerpt text', async () => {
        const events: { obj: Record<string, unknown>; msg: string }[] = [];
        const logger = { warn: (obj: Record<string, unknown>, msg: string) => events.push({ obj, msg }) };
        const complete = vi
            .fn()
            .mockResolvedValueOnce(completion(PARAPHRASED_JSON))
            .mockResolvedValueOnce(completion(VALID_JSON));
        const composer = new LlmAnswerComposer({ complete }, undefined, logger);
        await composer.compose(ASK, [SNIPPET], null, 'h4b-6');
        const retryEvents = events.filter((event) => event.msg === 'composer_excerpt_retry');
        expect(retryEvents).toHaveLength(1);
        expect(retryEvents[0]!.obj).toEqual({
            correlation_id: 'h4b-6',
            failed_claims: 1,
            citation_issues: 1,
            claim_ids: ['claim-1'],
        });
        const serialized = JSON.stringify(retryEvents[0]!.obj);
        expect(serialized).not.toContain(PARAPHRASED_EXCERPT);
        expect(serialized).not.toContain('Annual screening');
    });
});
