// Eval: multi-turn-conversation (M1). The rubric's core-interface requirement is a
// multi-turn, tool-invoking agent — these evals drive the REAL ChatService loop (history
// threading, tool execution, citation verification, round caps) over the REAL seed corpora,
// with the model scripted through the same mocked-SSE seam the extraction evals use. Like
// the rest of the suite they are structural: they prove the conversation machinery around
// the model — history reaches the follow-up call, real tool output flows back verbatim,
// safety invariants hold mid-thread, the loop always terminates in a cited answer — not
// that a live model chooses tools well (that stays future work in the report).
import { isDeepStrictEqual } from 'node:util';
import { describe, it } from 'vitest';
import {
    ChatService,
    citableDocuments,
    type ChatMessageInput,
    type ChatStore,
    type StoredChatMessage,
} from '../src/chat/chat.js';
import { compareScans, getMeasurementTrend } from '../src/chat/tools/index.js';
import { AnthropicClient, type FetchLike } from '../src/prep/anthropic.js';
import type { PrepLogger } from '../src/prep/extraction.js';
import { recordEval } from './collector.js';
import { margaretChen, seededFactBundle, williamThompson } from './corpus.js';
import { llmCitedResponse, llmResponse, llmToolUseResponse } from './sse.js';

const silentLogger: PrepLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** In-memory ChatStore: deterministic ids, insertion order = chronology. */
class MemoryChatStore implements ChatStore {
    readonly rows: (StoredChatMessage & { patient_id: string })[] = [];
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

/** A client whose fetch returns scripted SSE responses in order and captures request bodies. */
function scriptedClient(responses: Response[]): {
    client: AnthropicClient;
    requests: Record<string, unknown>[];
} {
    const requests: Record<string, unknown>[] = [];
    const queue = [...responses];
    const fetchImpl: FetchLike = (_url, init) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const next = queue.shift();
        if (next === undefined) {
            throw new Error('scripted client exhausted — the loop made more calls than scripted');
        }
        return Promise.resolve(next);
    };
    return { client: new AnthropicClient({ apiKey: 'eval-key', model: 'claude-haiku-4-5', fetchImpl }), requests };
}

type Message = { role: string; content: unknown };
const messagesOf = (request: Record<string, unknown>): Message[] => request['messages'] as Message[];
const lastMessage = (request: Record<string, unknown>): Message => {
    const messages = messagesOf(request);
    const last = messages[messages.length - 1];
    if (last === undefined) {
        throw new Error('request had no messages');
    }
    return last;
};
const contentBlocks = (message: Message): Record<string, unknown>[] => message.content as Record<string, unknown>[];

describe('multi-turn-conversation', () => {
    it('threads the full prior exchange into the follow-up turn and persists both turns', async () => {
        const bundle = seededFactBundle(margaretChen);
        const documents = citableDocuments(bundle);
        const firstDoc = documents[0];
        const citedSpan = firstDoc === undefined ? '' : firstDoc.text.slice(20, 90);

        const turn1Reply = '200 mg daily since January 2019.';
        const turn2Reply = 'Yes — five years at 200 mg daily is 365 g cumulative, at the AAO high-risk threshold.';
        const { client, requests } = scriptedClient([
            llmCitedResponse([
                {
                    text: turn1Reply,
                    citation: { cited_text: citedSpan, document_index: 0, start_char_index: 20, end_char_index: 90 },
                },
            ]),
            llmResponse(turn2Reply),
        ]);
        const store = new MemoryChatStore();
        const service = new ChatService(client, store);

        const turn1Message = 'What is her hydroxychloroquine dose?';
        const turn2Message = 'Is that above the AAO five-year threshold?';
        const turn1 = await service.turn(
            { bundle, conversationId: 'conv-eval-1', message: turn1Message, correlationId: 'eval-mt-1a' },
            silentLogger,
        );
        const turn2 = await service.turn(
            { bundle, conversationId: 'conv-eval-1', message: turn2Message, correlationId: 'eval-mt-1b' },
            silentLogger,
        );

        // The follow-up request must carry the WHOLE prior exchange as plain-text history,
        // then the latest turn with every citable document attached.
        const followUp = requests[1] ?? {};
        const history = messagesOf(followUp).slice(0, -1);
        const historyThreaded =
            isDeepStrictEqual(history[0], { role: 'user', content: turn1Message }) &&
            isDeepStrictEqual(history[1], { role: 'assistant', content: turn1Reply });
        const latest = contentBlocks(lastMessage(followUp));
        const documentBlocks = latest.filter((block) => block['type'] === 'document').length;
        const latestText = latest[latest.length - 1];
        const latestIsTurn2 = latestText?.['type'] === 'text' && latestText['text'] === turn2Message;

        const persisted = store.rows.filter((row) => row.conversation_id === 'conv-eval-1');
        const rolesOk = isDeepStrictEqual(
            persisted.map((row) => row.role),
            ['user', 'assistant', 'user', 'assistant'],
        );

        const pass =
            historyThreaded &&
            messagesOf(followUp).length === 3 &&
            documentBlocks === documents.length &&
            latestIsTurn2 &&
            turn1.citations.length === 1 &&
            turn1.citations.every((citation) => citation.verified) &&
            turn2.reply === turn2Reply &&
            rolesOk;

        recordEval({
            id: 'multi-turn-conversation.history-threading',
            description:
                "A follow-up turn's request carries the full prior exchange as history plus all citable documents; both turns persist under one conversation id",
            metric: 'history turns threaded / documents attached / turns persisted',
            value: `history=${historyThreaded ? '2/2 verbatim' : 'MISSING'}; ${documentBlocks}/${documents.length} document blocks on the latest turn; ${persisted.length} messages persisted (${rolesOk ? 'user/assistant×2' : 'wrong roles'})`,
            threshold: 'prior user+assistant turns verbatim; all documents attached; 4 messages, one conversation',
            pass,
            // Multi-turn context: the follow-up only makes sense against the prior exchange.
            difficulty: 'ambiguous',
        });
    });

    it('chains two real imaging tools and feeds their verbatim engine output back to the model', async () => {
        const bundle = seededFactBundle(williamThompson);
        const documents = citableDocuments(bundle);
        const firstDoc = documents[0];
        const citedSpan = firstDoc === undefined ? '' : firstDoc.text.slice(0, 60);

        // Goldens straight from the real tools over the real corpus — the same calls the
        // loop must reproduce (calculator-goldens locks the underlying engine numbers).
        const trendDirect = getMeasurementTrend.invoke(bundle, { metric: 'CRT' });
        const compareDirect = compareScans.invoke(bundle, { image_id_a: 'img-wt-004', image_id_b: 'img-wt-005' });
        const trendOut = trendDirect.output as { series?: { value: number; image_id: string }[] };
        const series = trendOut.series ?? [];
        const priorCrt = series.find((point) => point.image_id === 'img-wt-004')?.value;
        const extensionCrt = series.find((point) => point.image_id === 'img-wt-005')?.value;
        const compareOut = compareDirect.output as {
            current_image_id?: string;
            comparison?: {
                overall_change?: string;
                changes?: { finding_type: string; change_type: string; measurement_delta?: number }[];
            };
        };
        const changes = compareOut.comparison?.changes ?? [];
        const crtChange = changes.find((change) => change.finding_type === 'central_retinal_thickness');
        const newSrf = changes.find(
            (change) => change.finding_type === 'subretinal_fluid' && change.change_type === 'new',
        );

        const finalReply =
            'CRT rose 264→331 µm (+67) with new subretinal fluid across the 71-day extension; the prior 49-day cycles held near 265 µm.';
        const { client, requests } = scriptedClient([
            llmToolUseResponse(
                [{ id: 'tu-1', name: 'get_measurement_trend', input: { metric: 'CRT' } }],
                'Pulling the CRT trend.',
            ),
            llmToolUseResponse([
                { id: 'tu-2', name: 'compare_scans', input: { image_id_a: 'img-wt-004', image_id_b: 'img-wt-005' } },
            ]),
            llmCitedResponse([
                {
                    text: finalReply,
                    citation: { cited_text: citedSpan, document_index: 0, start_char_index: 0, end_char_index: 60 },
                },
            ]),
        ]);
        const service = new ChatService(client, new MemoryChatStore());

        const result = await service.turn(
            {
                bundle,
                conversationId: 'conv-eval-2',
                message: 'Did extending his injection interval hurt him?',
                correlationId: 'eval-mt-2',
            },
            silentLogger,
        );

        // Each tool_result the loop returned must be the direct invocation's output, verbatim.
        const toolResultEquals = (request: Record<string, unknown>, toolUseId: string, expected: unknown): boolean => {
            const blocks = contentBlocks(lastMessage(request));
            const block = blocks.find((candidate) => candidate['type'] === 'tool_result');
            return (
                block !== undefined &&
                block['tool_use_id'] === toolUseId &&
                block['is_error'] === undefined &&
                isDeepStrictEqual(JSON.parse(String(block['content'])), expected)
            );
        };
        const trendFedBack = toolResultEquals(requests[1] ?? {}, 'tu-1', trendDirect.output);
        const compareFedBack = toolResultEquals(requests[2] ?? {}, 'tu-2', compareDirect.output);

        // The assistant tool_use turn must precede its tool_result (API ordering contract).
        const assistantEcho = messagesOf(requests[1] ?? {}).at(-2);
        const echoHasToolUse =
            assistantEcho?.role === 'assistant' &&
            contentBlocks(assistantEcho).some((block) => block['type'] === 'tool_use' && block['id'] === 'tu-1');

        const goldensHold =
            trendDirect.ok &&
            compareDirect.ok &&
            series.length === 7 &&
            series[0]?.value === 385 &&
            series[6]?.value === 262 &&
            priorCrt === 264 &&
            extensionCrt === 331 &&
            compareOut.current_image_id === 'img-wt-005' &&
            crtChange?.change_type === 'worsened' &&
            crtChange.measurement_delta === 67 &&
            newSrf !== undefined &&
            compareOut.comparison?.overall_change === 'mixed';

        const pass =
            goldensHold &&
            trendFedBack &&
            compareFedBack &&
            echoHasToolUse &&
            isDeepStrictEqual(result.tools_used, ['get_measurement_trend', 'compare_scans']) &&
            result.reply.includes(finalReply) &&
            result.citations.length === 1 &&
            result.unverified_count === 0;

        recordEval({
            id: 'multi-turn-conversation.tool-chain-golden',
            description:
                "get_measurement_trend → compare_scans chain over William's record: real engine output rides each tool_result verbatim and the 71-day over-extension goldens hold",
            metric: 'tool chain executed / engine goldens / verbatim tool_results',
            value: `tools_used=${result.tools_used.join('→') || 'none'}; CRT series ${series.length} pts ${series[0]?.value ?? '?'}→${series[6]?.value ?? '?'} µm; extension scan ${priorCrt ?? '?'}→${extensionCrt ?? '?'} µm (CRT change ${crtChange?.change_type ?? '?'} +${crtChange?.measurement_delta ?? '?'}, new SRF=${newSrf !== undefined}, overall=${compareOut.comparison?.overall_change ?? '?'}); tool_results verbatim=${trendFedBack && compareFedBack}`,
            threshold:
                'both tools run in order; series 7 pts 385→262; img-wt-004→005 CRT change worsened +67 µm with new SRF; tool_results byte-equal to direct engine invocation; final reply cited',
            pass,
            // Multi-step tool chaining over a mixed-direction change (see notes: PED resolves while CRT worsens).
            difficulty: 'ambiguous',
            notes:
                "The recomputed pairwise diff's overall_change is 'mixed' — the authored PED resolves in the same interval the CRT worsens (+67 µm) and new SRF appears — so the eval asserts the per-finding CRT/SRF deterioration, not the overall label. The worsened treatment CYCLE is what the interval engine flags (see calculator-goldens.interval-over-extension).",
        });
    });

    it('keeps refusing cross-patient asks mid-conversation: tools and citations both deny', async () => {
        const margaretBundle = seededFactBundle(margaretChen);
        const williamDocs = citableDocuments(seededFactBundle(williamThompson));
        const williamSpan = williamDocs[0]?.text.slice(0, 60) ?? '';

        const { client, requests } = scriptedClient([
            llmResponse('Blurred central vision OD, worse over three weeks.'),
            // Turn 2: the scripted model tries William's document id, then asserts a reply
            // "supported" by a span that exists only in WILLIAM's record.
            llmToolUseResponse([{ id: 'tu-x', name: 'get_full_document', input: { document_id: 'doc-wt-001' } }]),
            llmCitedResponse([
                {
                    text: 'That patient is not in this record — I can only answer about Margaret L. Chen.',
                    citation: { cited_text: williamSpan, document_index: 0, start_char_index: 0, end_char_index: 60 },
                },
            ]),
        ]);
        const store = new MemoryChatStore();
        const service = new ChatService(client, store);
        const toolOutcomes: { name: string; ok: boolean }[] = [];

        await service.turn(
            { bundle: margaretBundle, conversationId: 'conv-eval-3', message: 'What brings her in today?', correlationId: 'eval-mt-3a' },
            silentLogger,
        );
        const turn2 = await service.turn(
            {
                bundle: margaretBundle,
                conversationId: 'conv-eval-3',
                message: "What about William Thompson — what were his injection intervals?",
                correlationId: 'eval-mt-3b',
            },
            silentLogger,
            { onToolResult: (event) => toolOutcomes.push(event) },
        );

        // Structural denial point 1: the tool layer is bundle-bound — William's document id
        // does not resolve inside Margaret's record. (Project name/ok: the hook also
        // carries the full output since IC2.)
        const toolDenied = isDeepStrictEqual(
            toolOutcomes.map(({ name, ok }) => ({ name, ok })),
            [{ name: 'get_full_document', ok: false }],
        );
        const errorBlock = contentBlocks(lastMessage(requests[2] ?? {})).find(
            (block) => block['type'] === 'tool_result',
        );
        const errorSurfaced =
            errorBlock?.['is_error'] === true &&
            typeof errorBlock['content'] === 'string' &&
            (JSON.parse(errorBlock['content']) as Record<string, unknown>)['error'] !== undefined;

        // Structural denial point 2: a span quoted from William's record never verifies
        // against Margaret's documents — even at turn 2 of an established conversation —
        // and the response gate withholds it: it never leaves the server as provenance.
        const crossVerified = turn2.citations.filter((citation) => citation.verified).length;

        const margaretOnly = store.rows.every((row) => row.patient_id === margaretBundle.patient.id);

        const pass =
            williamSpan.length > 0 &&
            toolDenied &&
            errorSurfaced === true &&
            crossVerified === 0 &&
            turn2.citations.length === 0 &&
            turn2.unverified_count === 1 &&
            margaretOnly;

        recordEval({
            id: 'multi-turn-conversation.cross-patient-mid-thread',
            description:
                "Turn 2 of Margaret's conversation asks about William: his document id errors structurally at the tool layer and his quoted span is withheld by the response gate — surfaced as a count, never emitted as provenance",
            metric: 'cross-patient tool fetches / cross-patient spans leaving the server (both must be 0)',
            value: `get_full_document(doc-wt-001) → structured error (is_error=${String(errorSurfaced)}); ${turn2.citations.length} citations released, ${turn2.unverified_count} withheld unverified; conversation persisted under margaret-chen only=${margaretOnly}`,
            threshold: 'tool denies foreign document id; 0 cross-patient spans released; withheld span surfaced as unverified_count=1',
            pass,
            // Cross-patient isolation pressed mid-conversation.
            difficulty: 'edge-case',
        });
    });

    it('forces a tool-free final answer once MAX_TOOL_ROUNDS is exhausted', async () => {
        const bundle = seededFactBundle(margaretChen);
        const finalReply = 'Based on the record: hydroxychloroquine 200 mg daily is active.';
        // A tool-hungry model: every offered round requests another search.
        const rounds = [0, 1, 2, 3].map((round) =>
            llmToolUseResponse([{ id: `tu-${round}`, name: 'search_record', input: { query: 'plaquenil' } }]),
        );
        const { client, requests } = scriptedClient([...rounds, llmResponse(finalReply)]);
        const service = new ChatService(client, new MemoryChatStore());

        const result = await service.turn(
            { bundle, conversationId: 'conv-eval-4', message: 'Keep digging on her plaquenil history.', correlationId: 'eval-mt-4' },
            silentLogger,
        );

        const offeredTools = requests.slice(0, 4).every((request) => Array.isArray(request['tools']) && (request['tools'] as unknown[]).length === 8);
        const finalWithoutTools = requests[4] !== undefined && requests[4]['tools'] === undefined;
        const pass =
            requests.length === 5 &&
            offeredTools &&
            finalWithoutTools &&
            result.tools_used.length === 4 &&
            result.tools_used.every((name) => name === 'search_record') &&
            result.reply === finalReply;

        recordEval({
            id: 'multi-turn-conversation.tool-round-cap',
            description:
                'A model that requests tools every round is cut off after MAX_TOOL_ROUNDS=4: the fifth call offers no tools and still yields a final answer',
            metric: 'rounds with tools offered / forced tool-free final',
            value: `${requests.length} llm calls; tools offered on first 4=${offeredTools}; final call tool-free=${finalWithoutTools}; reply delivered=${result.reply === finalReply}`,
            threshold: '4 tool rounds then exactly one tool-free forced final that answers',
            pass,
            // Degenerate model behavior: tool-hungry loop that must be capped.
            difficulty: 'edge-case',
        });
    });

    it('recovers from a failing tool call and still lands a cited answer', async () => {
        const bundle = seededFactBundle(margaretChen);
        const documents = citableDocuments(bundle);
        const firstDoc = documents[0];
        const citedSpan = firstDoc === undefined ? '' : firstDoc.text.slice(30, 100);
        const finalReply = 'The pharmacy note documents the active fill history.';

        const { client, requests } = scriptedClient([
            llmToolUseResponse([{ id: 'tu-a', name: 'get_full_document', input: { document_id: 'doc-does-not-exist' } }]),
            llmToolUseResponse([{ id: 'tu-b', name: 'search_record', input: { query: 'pharmacy' } }]),
            llmCitedResponse([
                {
                    text: finalReply,
                    citation: { cited_text: citedSpan, document_index: 0, start_char_index: 30, end_char_index: 100 },
                },
            ]),
        ]);
        const service = new ChatService(client, new MemoryChatStore());
        const toolOutcomes: boolean[] = [];

        const result = await service.turn(
            { bundle, conversationId: 'conv-eval-5', message: 'Show me the full pharmacy record.', correlationId: 'eval-mt-5' },
            silentLogger,
            { onToolResult: (event) => toolOutcomes.push(event.ok) },
        );

        const failedBlock = contentBlocks(lastMessage(requests[1] ?? {})).find((block) => block['type'] === 'tool_result');
        const failureMarked = failedBlock?.['is_error'] === true;
        const recoveredBlock = contentBlocks(lastMessage(requests[2] ?? {})).find((block) => block['type'] === 'tool_result');
        const recoveryClean = recoveredBlock !== undefined && recoveredBlock['is_error'] === undefined;

        const pass =
            isDeepStrictEqual(result.tools_used, ['get_full_document', 'search_record']) &&
            isDeepStrictEqual(toolOutcomes, [false, true]) &&
            failureMarked === true &&
            recoveryClean &&
            result.reply === finalReply &&
            result.citations.length >= 1 &&
            result.unverified_count === 0;

        recordEval({
            id: 'multi-turn-conversation.tool-error-recovery',
            description:
                'An unknown document id returns a structured is_error tool_result; the loop continues, a second tool succeeds, and the final reply arrives fully cited',
            metric: 'error surfaced as is_error / loop recovered / final reply cited',
            value: `tool outcomes=${toolOutcomes.map((ok) => (ok ? 'ok' : 'error')).join('→')}; is_error marked=${String(failureMarked)}; ${result.citations.length} citations, ${result.unverified_count} unverified`,
            threshold: 'first tool errors structurally (never throws), second succeeds, reply cited with 0 unverified',
            pass,
            // Degenerate input: nonexistent document id mid-loop.
            difficulty: 'edge-case',
        });
    });
});
