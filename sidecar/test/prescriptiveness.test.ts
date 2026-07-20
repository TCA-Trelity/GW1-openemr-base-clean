// Prescriptiveness lint tests (M3). Each case documents the failure mode it guards: the
// agent ORIGINATING clinical direction (banned by docs/prompt-guide.md) vs. relaying
// attributed engine/guideline/record content (the carve-out) vs. the question-shaped
// reframe (the sanctioned thought-partner move). Plus the ChatService integration seam:
// flags are counted on the result and logged, never silently passed.
import { describe, expect, it, vi } from 'vitest';
import { ChatService, type ChatMessageInput, type StoredChatMessage } from '../src/chat/chat.js';
import { lintPrescriptiveness } from '../src/chat/prescriptivenessLint.js';
import { AnthropicClient, type FetchLike } from '../src/prep/anthropic.js';
import type { PrepLogger } from '../src/prep/extraction.js';
import type { FactBundle } from '../src/store/index.js';

describe('lintPrescriptiveness — violations (unattributed directive advice)', () => {
    // Failure mode: first-person advice — the model exercising judgment as its own.
    it('flags "I recommend/suggest" advice', () => {
        expect(lintPrescriptiveness('I recommend switching her to Eylea.').flags).toMatchObject([
            { rule: 'first_person_advice' },
        ]);
        expect(lintPrescriptiveness("I'd suggest tapering the steroid.").flags).toMatchObject([
            { rule: 'first_person_advice' },
        ]);
    });

    // Failure mode: second-person directives — telling the physician what to do.
    it('flags "you should <treatment verb>" directives', () => {
        expect(lintPrescriptiveness('You should increase the dose to 400 mg.').flags).toMatchObject([
            { rule: 'second_person_directive' },
        ]);
        expect(lintPrescriptiveness('We must discontinue the anticoagulant before surgery.').flags).toMatchObject([
            { rule: 'second_person_directive' },
        ]);
    });

    // Failure mode: passive voice smuggling the same directive.
    it('flags "should be <changed>" passives', () => {
        expect(lintPrescriptiveness('The interval should be shortened to 7 weeks.').flags).toMatchObject([
            { rule: 'passive_directive' },
        ]);
    });

    // Failure mode: bare imperatives with a clinical object.
    it('flags leading imperatives aimed at treatment', () => {
        expect(lintPrescriptiveness('Start her on 200 mg daily dosing.').flags).toMatchObject([
            { rule: 'imperative_directive' },
        ]);
        expect(lintPrescriptiveness('- Order a fluorescein angiogram and a retina consult.').flags).toMatchObject([
            { rule: 'imperative_directive' },
        ]);
    });

    // Failure mode (AgentForge): a BARE drug-name imperative with no clinical-object noun —
    // "Stop hydroxychloroquine." — slipped imperative_directive. Caught by generic-drug morphology.
    it('flags bare drug-name imperatives (imperative_medication)', () => {
        expect(lintPrescriptiveness('Stop hydroxychloroquine.').flags).toMatchObject([{ rule: 'imperative_medication' }]);
        expect(lintPrescriptiveness('Start atorvastatin.').flags).toMatchObject([{ rule: 'imperative_medication' }]);
        expect(lintPrescriptiveness('Discontinue lisinopril immediately.').flags).toMatchObject([{ rule: 'imperative_medication' }]);
    });

    // Negative control: the {3,}-stem + strong-suffix design must not flag ordinary words.
    it('does not flag non-drug words that merely share a suffix fragment', () => {
        expect(lintPrescriptiveness('Start April with a fresh chart review.').flags).toHaveLength(0);
        expect(lintPrescriptiveness('Stop the daily routine.').flags).toHaveLength(0);
    });

    it('flags only the offending sentence, not the grounded ones around it', () => {
        const reply =
            'Her documented interval history is 49/49/71 days. You should shorten the interval. The 71-day scan worsened.';
        const { flags } = lintPrescriptiveness(reply);
        expect(flags).toHaveLength(1);
        expect(flags[0]!.excerpt).toBe('You should shorten the interval.');
    });
});

describe('lintPrescriptiveness — the carve-out and the sanctioned shapes', () => {
    // The attribution carve-out: relaying WITH a named source is correct behavior.
    it('passes guideline- and engine-attributed relays', () => {
        expect(
            lintPrescriptiveness('Per AAO screening guidelines, annual retinal screening is required at this dose.').flags,
        ).toHaveLength(0);
        expect(
            lintPrescriptiveness('The interval engine derives a 7-week optimal interval from her response pattern.').flags,
        ).toHaveLength(0);
    });

    it('passes documented-plan relays', () => {
        expect(
            lintPrescriptiveness("Dr. Reyes' note recommends repeating the 10-2 fields before the next refill.").flags,
        ).toHaveLength(0);
        expect(lintPrescriptiveness('The documented plan is to extend to 10 weeks if stable.').flags).toHaveLength(0);
    });

    // Questions are the sanctioned reframe — never flagged, even when they name a change.
    it('passes question-shaped reframes', () => {
        expect(
            lintPrescriptiveness('Worth weighing: should the interval be shortened given the October worsening?').flags,
        ).toHaveLength(0);
    });

    it('passes plain grounded statements', () => {
        expect(
            lintPrescriptiveness('CRT rose 264→331 µm (+67) with new subretinal fluid across the 71-day extension.').flags,
        ).toHaveLength(0);
        expect(lintPrescriptiveness('Not in the record.').flags).toHaveLength(0);
    });
});

// ---- ChatService integration: the count rides the result and the warn fires ----

const DOC_TEXT = 'Current medications: Plaquenil 200 mg daily since January 2019.';

function bundle(): FactBundle {
    return {
        patient: { id: 'margaret-chen', openemr_patient_id: null, name: 'Margaret L. Chen', demographics: {} },
        facts: [],
        contradictions: [],
        images: [],
        treatments: [],
        documents: [
            {
                id: 'doc-mc-004',
                document_type: 'pharmacy_record',
                document_date: '2024-11-01',
                content: { text_content: DOC_TEXT },
                metadata: {},
                extras: {},
            },
        ],
    };
}

class MemoryStore {
    rows: (ChatMessageInput & { id: string })[] = [];
    async saveChatMessage(input: ChatMessageInput): Promise<string> {
        const id = `msg-${this.rows.length + 1}`;
        this.rows.push({ ...input, id });
        return id;
    }
    async getChatMessages(): Promise<StoredChatMessage[]> {
        return this.rows.map((row) => ({ ...row, created_at: '2026-07-11T12:00:00.000Z' }));
    }
}

function textResponse(text: string): Response {
    const events = [
        { type: 'message_start', message: { model: 'claude-haiku-4-5', usage: { input_tokens: 900, output_tokens: 1 } } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 60 } },
        { type: 'message_stop' },
    ];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { status: 200 });
}

function serviceWith(response: Response) {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValueOnce(response);
    const client = new AnthropicClient({ apiKey: 'test-key', model: 'claude-haiku-4-5', fetchImpl: fetchMock });
    return new ChatService(client, new MemoryStore());
}

describe('ChatService × prescriptiveness lint', () => {
    // Failure mode: a violating reply passing through the turn uncounted/unlogged.
    it('counts flags on the result and logs a warn for a violating reply', async () => {
        const warn = vi.fn();
        const logger: PrepLogger = { info: () => {}, warn, error: () => {} };
        const service = serviceWith(textResponse('You should increase the dose to 400 mg.'));

        const result = await service.turn(
            { bundle: bundle(), conversationId: 'conv-lint-1', message: 'What dose should I use?', correlationId: 'lint-1' },
            logger,
        );

        expect(result.prescriptive_flag_count).toBe(1);
        const lintWarn = warn.mock.calls.find(([, message]) => message === 'chat reply flagged by prescriptiveness lint');
        expect(lintWarn).toBeDefined();
        expect(lintWarn![0]).toMatchObject({ prescriptive_flags: 1, rules: ['second_person_directive'] });
    });

    it('reports zero flags for a compliant consultative reply', async () => {
        const warn = vi.fn();
        const logger: PrepLogger = { info: () => {}, warn, error: () => {} };
        const service = serviceWith(
            textResponse('Per AAO guidelines this is high risk. Worth asking: any new visual symptoms?'),
        );

        const result = await service.turn(
            { bundle: bundle(), conversationId: 'conv-lint-2', message: 'Is she at risk?', correlationId: 'lint-2' },
            logger,
        );

        expect(result.prescriptive_flag_count).toBe(0);
        expect(
            warn.mock.calls.find(([, message]) => message === 'chat reply flagged by prescriptiveness lint'),
        ).toBeUndefined();
    });
});
