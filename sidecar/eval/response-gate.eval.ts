// Eval: response-gate (the chat-path choke point, gate/responseGate.ts). Structural
// invariants at the SERVER BOUNDARY, driven through the real route + ChatService with the
// scripted-SSE seam the other chat evals use: (1) an invented span never leaves the server
// on the wire — not as a citation event, not in done.citations — only its count does;
// (2) a fully-verified turn passes through undiminished (the gate must not eat valid
// provenance); (3) the seed/opening move passes the same advisory prose screen as every
// reply. Together with multi-turn-conversation.cross-patient-mid-thread these are the
// committed proof behind "every chat response is checked before it reaches the user."
import Fastify from 'fastify';
import { describe, it } from 'vitest';
import { ChatService, citableDocuments, type ChatMessageInput, type StoredChatMessage } from '../src/chat/chat.js';
import { composeOpeningMove } from '../src/chat/openingMove.js';
import { screenOutboundText } from '../src/gate/responseGate.js';
import { AnthropicClient, type FetchLike } from '../src/prep/anthropic.js';
import type { PrepLogger } from '../src/prep/extraction.js';
import { registerChatRoutes, type ChatRouteStore } from '../src/routes/chat.js';
import type { FactBundle, StoredBrief } from '../src/store/index.js';
import { recordEval } from './collector.js';
import { margaretChen, seededFactBundle } from './corpus.js';
import { llmCitedResponse } from './sse.js';

const silentLogger: PrepLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** Minimal ChatRouteStore over the seeded corpus (no brief → no seed event). */
class EvalRouteStore implements ChatRouteStore {
    readonly rows: (StoredChatMessage & { patient_id: string })[] = [];
    constructor(private readonly bundle: FactBundle) {}
    getFactBundle(patientId: string): Promise<FactBundle | null> {
        return Promise.resolve(this.bundle.patient.id === patientId ? this.bundle : null);
    }
    getBrief(): Promise<StoredBrief | null> {
        return Promise.resolve(null);
    }
    saveChatMessage(input: ChatMessageInput): Promise<string> {
        const id = `msg-${this.rows.length + 1}`;
        this.rows.push({ ...input, id, created_at: `2026-07-11T00:00:0${this.rows.length}Z` });
        return Promise.resolve(id);
    }
    getChatMessages(patientId: string, conversationId: string, limit = 20): Promise<StoredChatMessage[]> {
        return Promise.resolve(
            this.rows
                .filter((row) => row.patient_id === patientId && row.conversation_id === conversationId)
                .slice(-limit),
        );
    }
}

function scriptedService(store: EvalRouteStore, responses: Response[]): ChatService {
    const queue = [...responses];
    const fetchImpl: FetchLike = () => {
        const next = queue.shift();
        if (next === undefined) {
            throw new Error('scripted client exhausted');
        }
        return Promise.resolve(next);
    };
    return new ChatService(new AnthropicClient({ apiKey: 'eval-key', model: 'claude-haiku-4-5', fetchImpl }), store);
}

function sseEventsOf(body: string): Record<string, unknown>[] {
    return body
        .split('\n\n')
        .filter((chunk) => chunk.startsWith('data: '))
        .map((chunk) => JSON.parse(chunk.slice(6)) as Record<string, unknown>);
}

const INVENTED_SPAN = 'The patient has made a complete recovery with no residual disease';

describe('response-gate', () => {
    it('never lets an unverified citation cross the wire: withheld from events and done', async () => {
        const bundle = seededFactBundle(margaretChen);
        const documents = citableDocuments(bundle);
        const firstDoc = documents[0];
        const citedSpan = firstDoc === undefined ? '' : firstDoc.text.slice(20, 90);

        const store = new EvalRouteStore(bundle);
        const service = scriptedService(store, [
            llmCitedResponse([
                {
                    text: 'Plaquenil history is documented. ',
                    citation: { cited_text: citedSpan, document_index: 0, start_char_index: 20, end_char_index: 90 },
                },
                {
                    text: 'No residual disease on file.',
                    citation: {
                        cited_text: INVENTED_SPAN,
                        document_index: 0,
                        start_char_index: 0,
                        end_char_index: INVENTED_SPAN.length,
                    },
                },
            ]),
        ]);
        const app = Fastify({ logger: false });
        registerChatRoutes(app, { store, service });

        const res = await app.inject({
            method: 'POST',
            url: `/api/chat/${bundle.patient.id}`,
            payload: { message: 'Any updates since the last visit?' },
        });
        const events = sseEventsOf(res.body);
        const citationEvents = events.filter((event) => event['type'] === 'citation');
        const releasedTexts = citationEvents.map(
            (event) => (event['citation'] as { cited_text: string }).cited_text,
        );
        const done = events[events.length - 1] ?? {};
        const doneCitations = (done['citations'] as { verified: boolean }[] | undefined) ?? [];

        const pass =
            citedSpan.length > 0 &&
            res.statusCode === 200 &&
            !res.body.includes(INVENTED_SPAN) &&
            releasedTexts.length === 1 &&
            releasedTexts[0] === citedSpan &&
            done['type'] === 'done' &&
            doneCitations.length === 1 &&
            doneCitations.every((citation) => citation.verified) &&
            done['unverified_count'] === 1;

        recordEval({
            id: 'response-gate.wire-invariant',
            description:
                'A turn carrying one verified and one invented citation reaches the SSE wire with only the verified one: the invented span appears in no event and no done payload, surfaced solely as unverified_count',
            metric: 'unverified citations on the wire (must be 0) / withheld count surfaced',
            value: `${releasedTexts.length} citation event(s) released; invented span on the wire=${res.body.includes(INVENTED_SPAN)}; done.citations=${doneCitations.length}; unverified_count=${String(done['unverified_count'])}`,
            threshold: '0 unverified citations in any SSE event or done.citations; unverified_count=1',
            pass,
        });
    });

    it('releases a fully-verified turn undiminished (no over-blocking)', async () => {
        const bundle = seededFactBundle(margaretChen);
        const documents = citableDocuments(bundle);
        const firstDoc = documents[0];
        const citedSpan = firstDoc === undefined ? '' : firstDoc.text.slice(20, 90);
        const reply = 'Plaquenil 200 mg daily is the documented regimen.';

        const store = new EvalRouteStore(bundle);
        const service = scriptedService(store, [
            llmCitedResponse([
                {
                    text: reply,
                    citation: { cited_text: citedSpan, document_index: 0, start_char_index: 20, end_char_index: 90 },
                },
            ]),
        ]);
        const deltas: string[] = [];
        const streamed: unknown[] = [];
        const result = await service.turn(
            { bundle, conversationId: 'conv-rg-2', message: 'What is her regimen?', correlationId: 'eval-rg-2' },
            silentLogger,
            { onTextDelta: (text) => deltas.push(text), onCitation: (citation) => streamed.push(citation) },
        );

        const pass =
            citedSpan.length > 0 &&
            deltas.join('') === reply &&
            result.reply === reply &&
            result.citations.length === 1 &&
            result.citations.every((citation) => citation.verified) &&
            streamed.length === 1 &&
            result.unverified_count === 0;

        recordEval({
            id: 'response-gate.clean-turn-released',
            description:
                'A fully-verified turn passes the gate undiminished: the reply streams byte-identical and the verified citation is released to both the hook and the result',
            metric: 'released/verified citations, streamed deltas equal reply',
            value: `${result.citations.length}/1 citations released; deltas==reply=${deltas.join('') === reply}; unverified_count=${result.unverified_count}`,
            threshold: '1/1 released, reply unaltered, 0 withheld',
            pass,
        });
    });

    it('screens the seed/opening move with the same advisory lint as every reply', () => {
        const preparedAt = '2026-07-11T08:00:00.000Z';
        // A brief whose urgency line smuggles an unattributed directive: the screen must
        // flag it (advisory: logged + counted, never altered).
        const directiveDigest = composeOpeningMove(
            {
                urgency: { level: 'high', reason: 'You should increase the dose to 400 mg' },
                key_discussion_points: ['GC-IPL thinning 82→70 µm across six OCTs'],
                questions_to_confirm: [],
            },
            preparedAt,
        );
        // The realistic brief shape (same content the route tests seed with): clean.
        const cleanDigest = composeOpeningMove(
            {
                urgency: { level: 'high', reason: 'HCQ retinal toxicity risk at threshold' },
                key_discussion_points: [
                    'Hydroxychloroquine: HIGH retinal toxicity risk',
                    'GC-IPL thinning 82→70 µm across six OCTs',
                ],
                questions_to_confirm: ['Any new visual symptoms since December?'],
            },
            preparedAt,
        );

        const warns: Record<string, unknown>[] = [];
        const logger = { warn: (obj: Record<string, unknown>) => warns.push(obj) };
        const directiveFlags =
            directiveDigest === null ? [] : screenOutboundText(directiveDigest, logger, { surface: 'opening_move' });
        const cleanFlags =
            cleanDigest === null ? [] : screenOutboundText(cleanDigest, logger, { surface: 'opening_move' });

        const pass =
            directiveDigest !== null &&
            cleanDigest !== null &&
            directiveFlags.length >= 1 &&
            directiveFlags[0]?.rule === 'second_person_directive' &&
            warns.length === 1 &&
            warns[0]?.['surface'] === 'opening_move' &&
            cleanFlags.length === 0;

        recordEval({
            id: 'response-gate.seed-screened',
            description:
                'The opening-move digest passes the same advisory prose screen as chat replies: a smuggled directive is flagged and logged with surface=opening_move; a realistic brief digest screens clean',
            metric: 'directive digest flagged / clean digest silent',
            value: `directive digest → ${directiveFlags.length} flag(s) (${directiveFlags[0]?.rule ?? 'none'}); clean digest → ${cleanFlags.length} flags; ${warns.length} warn log(s)`,
            threshold: 'directive flagged with a lint rule + logged once; clean digest 0 flags',
            pass,
        });
    });
});
