// Chat tests (S2.3, reworked R4/R5): Citations-API document blocks, streamed citation
// verification, SSE wire contract, persistence, pre-stream guards. No live Anthropic.
import { describe, expect, it, vi } from 'vitest';
import {
    buildChatSystemPrompt,
    citableDocuments,
    verifyCitation,
    ChatService,
    type ChatImageLoader,
    type ChatMessageInput,
    type StoredChatMessage,
} from '../src/chat/chat.js';
import { loadConfig } from '../src/config.js';
import { AnthropicClient, type FetchLike } from '../src/prep/anthropic.js';
import { BudgetExceededError, type LlmCallRecord } from '../src/prep/budget.js';
import type { PrepLogger } from '../src/prep/extraction.js';
import { imagingToolSummary, registerChatRoutes, type ChatRouteDeps } from '../src/routes/chat.js';
import { buildServer } from '../src/server.js';
import type { RegisteredTool } from '../src/chat/tools/index.js';
import type { FactBundle, StoredBrief } from '../src/store/index.js';
import Fastify from 'fastify';

const silentLogger: PrepLogger = { info: () => {}, warn: () => {}, error: () => {} };

const DOC_TEXT = 'Current medications: Plaquenil 200 mg daily since January 2019. Allergies: penicillin (rash).';

function tinyBundle(): FactBundle {
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
            {
                id: 'doc-mc-009',
                document_type: 'imaging_report',
                document_date: '2024-12-01',
                content: { format: 'structured' }, // no text_content -> not citable
                metadata: {},
                extras: {},
            },
        ],
    };
}

const REPLY = 'On Plaquenil 200 mg daily since 2019. Penicillin allergy (rash).';
const CITED = 'Plaquenil 200 mg daily';

function sse(events: Record<string, unknown>[]): string {
    return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

// A streamed reply with one exact-range citation and one wrong-range (recoverable) one.
function chatResponse(text: string): Response {
    const mid = Math.ceil(text.length / 2);
    const start = DOC_TEXT.indexOf(CITED);
    return new Response(
        sse([
            { type: 'message_start', message: { model: 'claude-haiku-4-5', usage: { input_tokens: 900, output_tokens: 1 } } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, mid) } },
            {
                type: 'content_block_delta',
                index: 0,
                delta: {
                    type: 'citations_delta',
                    citation: {
                        type: 'char_location',
                        cited_text: CITED,
                        document_index: 0,
                        document_title: 'pharmacy_record (2024-11-01)',
                        start_char_index: start,
                        end_char_index: start + CITED.length,
                    },
                },
            },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(mid) } },
            {
                type: 'content_block_delta',
                index: 0,
                delta: {
                    type: 'citations_delta',
                    citation: {
                        type: 'char_location',
                        cited_text: 'penicillin (rash)',
                        document_index: 0,
                        document_title: 'pharmacy_record (2024-11-01)',
                        start_char_index: 3, // wrong range on purpose -> verbatim-search recovery
                        end_char_index: 9,
                    },
                },
            },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 120 } },
            { type: 'message_stop' },
        ]),
        { status: 200 },
    );
}

class FakeChatStore {
    messages: (ChatMessageInput & { id: string })[] = [];
    /** M9: the latest completed brief the opening move composes from (null = no seed). */
    brief: StoredBrief | null = null;
    constructor(private readonly bundle: FactBundle | null = tinyBundle()) {}

    async getFactBundle(patientId: string): Promise<FactBundle | null> {
        return this.bundle !== null && this.bundle.patient.id === patientId ? this.bundle : null;
    }

    async getBrief(): Promise<StoredBrief | null> {
        return this.brief;
    }

    async saveChatMessage(input: ChatMessageInput): Promise<string> {
        const id = `msg-${this.messages.length + 1}`;
        this.messages.push({ ...input, id });
        return id;
    }

    async getChatMessages(patientId: string, conversationId: string): Promise<StoredChatMessage[]> {
        return this.messages
            .filter((m) => m.patient_id === patientId && m.conversation_id === conversationId)
            .map((m) => ({ ...m, created_at: '2026-07-08T12:00:00.000Z' }));
    }
}

class FakeSpendGuard {
    recorded: LlmCallRecord[] = [];
    budgetError: BudgetExceededError | undefined;
    async assertBudget(): Promise<void> {
        if (this.budgetError) {
            throw this.budgetError;
        }
    }
    async recordCall(call: LlmCallRecord): Promise<void> {
        this.recorded.push(call);
    }
    async usageSummary(): Promise<never> {
        throw new Error('unused');
    }
}

function chatService(store: FakeChatStore, spendGuard?: FakeSpendGuard, ...responses: Response[]) {
    const fetchMock = vi.fn<FetchLike>();
    for (const response of responses) {
        fetchMock.mockResolvedValueOnce(response);
    }
    const client = new AnthropicClient({ apiKey: 'test-key', model: 'claude-haiku-4-5', fetchImpl: fetchMock });
    return { service: new ChatService(client, store, spendGuard), fetchMock };
}

// A ChatService wired with an injected (deterministic) tool set for tool-loop tests.
// imageLoader (IC4) is optional — pass one to exercise the describe_scan media path.
function chatServiceWithTools(
    store: FakeChatStore,
    spendGuard: FakeSpendGuard | undefined,
    tools: RegisteredTool[],
    responses: Response[],
    imageLoader?: ChatImageLoader,
) {
    const fetchMock = vi.fn<FetchLike>();
    for (const response of responses) {
        fetchMock.mockResolvedValueOnce(response);
    }
    const client = new AnthropicClient({ apiKey: 'test-key', model: 'claude-haiku-4-5', fetchImpl: fetchMock });
    return { service: new ChatService(client, store, spendGuard, tools, imageLoader), fetchMock };
}

// A stand-in tool with a fixed result — decouples loop tests from real tool logic.
function fakeTool(name: string, output: Record<string, unknown>, provenance: { source_document_id: string; excerpt: string }[] = []): RegisteredTool {
    return {
        name,
        description: `fake ${name}`,
        inputJsonSchema: { type: 'object', properties: {}, additionalProperties: true },
        invoke: () => ({ ok: !('error' in output), output, provenance }),
    };
}

// A streamed assistant turn that asks for one tool: optional leading text, then a tool_use
// block whose input arrives as an input_json_delta, ending with stop_reason 'tool_use'.
function toolUseResponse(toolName: string, input: Record<string, unknown>, text = ''): Response {
    const events: Record<string, unknown>[] = [
        { type: 'message_start', message: { model: 'claude-haiku-4-5', usage: { input_tokens: 500, output_tokens: 1 } } },
    ];
    if (text.length > 0) {
        events.push(
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
            { type: 'content_block_stop', index: 0 },
        );
    }
    events.push(
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: `toolu-${toolName}`, name: toolName } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } },
        { type: 'message_stop' },
    );
    return new Response(sse(events), { status: 200 });
}

function chatApp(deps?: ChatRouteDeps) {
    const app = Fastify({ logger: false });
    registerChatRoutes(app, deps);
    return app;
}

describe('buildChatSystemPrompt + citableDocuments', () => {
    // Guards: the brevity + grounding contract drifting out of the prompt, and documents
    // without text sneaking into the citable list (misaligning document_index mapping).
    it('states brevity and only-from-documents rules; citable list skips textless docs', () => {
        const prompt = buildChatSystemPrompt(tinyBundle());
        expect(prompt).toContain('BE BRIEF');
        expect(prompt).toContain('at most 3 short bullets');
        expect(prompt).toContain('ONLY from the attached source documents');
        const docs = citableDocuments(tinyBundle());
        expect(docs).toHaveLength(1);
        expect(docs[0]!.id).toBe('doc-mc-004');
    });

    // Guards: the thought-partner contract (docs/prompt-guide.md, M2) drifting out of the
    // prompt — the same pin-the-load-bearing-phrases discipline injection-resistance uses
    // for the extraction fence. Each phrase carries one leg of the contract: the ban, the
    // attributed reframe, where the decision sits, and the relay carve-out.
    // Guards (IC0): the capability-wrong failure seen live — the model answering a trends
    // question from document prose, claiming the longitudinal data doesn't exist (it is one
    // tool call away), and asking permission to act. The prompt must forbid all three.
    it('states the imaging tool-use contract: consult before absence claims, never ask permission', () => {
        const prompt = buildChatSystemPrompt(tinyBundle());
        expect(prompt).toContain('lives ONLY in the stored image');
        expect(prompt).toContain('Consult the imaging tools BEFORE stating any imaging data');
        expect(prompt).toContain('an absence claim without a tool check is a wrong answer');
        expect(prompt).toContain('without asking');
    });

    // Guards (IC4): the visual-observation quarantine — a describe_scan read must arrive
    // prefixed as NOT-the-record, uncited, morphology-only, and defer to the authored
    // analysis on conflict. Pin each leg.
    it('states the visual-observation quarantine for describe_scan', () => {
        const prompt = buildChatSystemPrompt(tinyBundle());
        expect(prompt).toContain('"AI visual observation (not from the record):"');
        expect(prompt).toContain('never cite it');
        expect(prompt).toContain('no diagnosis, no severity grading, no treatment implication');
        expect(prompt).toContain('defer to the record');
    });

    it('states the non-prescriptiveness contract: ban, attributed reframe, carve-out', () => {
        const prompt = buildChatSystemPrompt(tinyBundle());
        expect(prompt).toContain('thought partner, not a prescriber');
        expect(prompt).toContain('Never advise starting, stopping, or changing treatment, dosing');
        expect(prompt).toContain('attribute the source in the same sentence');
        expect(prompt).toContain('the decision stays with the physician');
        expect(prompt).toContain('WITH its attribution');
        expect(prompt).toContain('originating your own clinical direction is not');
    });
});

describe('verifyCitation', () => {
    const docs = citableDocuments(tinyBundle());

    // Guards: the gate philosophy for chat — exact ranges verify, drifted ranges recover
    // by verbatim search, and spans absent from our copy are NEVER verified.
    it('verifies exact ranges, recovers wrong ranges, rejects absent spans', () => {
        const start = DOC_TEXT.indexOf(CITED);
        const exact = verifyCitation(
            { cited_text: CITED, document_index: 0, start_char_index: start, end_char_index: start + CITED.length },
            docs,
        );
        expect(exact).toMatchObject({ document_id: 'doc-mc-004', verified: true, start_char: start });

        const drifted = verifyCitation(
            { cited_text: 'penicillin (rash)', document_index: 0, start_char_index: 1, end_char_index: 4 },
            docs,
        );
        expect(drifted?.verified).toBe(true);
        expect(drifted?.start_char).toBe(DOC_TEXT.indexOf('penicillin (rash)'));

        const invented = verifyCitation(
            { cited_text: 'patient has no allergies whatsoever', document_index: 0, start_char_index: 0, end_char_index: 10 },
            docs,
        );
        expect(invented?.verified).toBe(false);

        expect(verifyCitation({ cited_text: CITED, document_index: 9 }, docs)).toBeNull();
    });
});

describe('ChatService.turn', () => {
    // Guards: the full turn contract — document blocks sent with citations enabled,
    // deltas + verified citations streamed, turns persisted, spend ledgered.
    it('sends document blocks, streams citations, persists, and ledgers spend', async () => {
        const store = new FakeChatStore();
        const spendGuard = new FakeSpendGuard();
        const { service, fetchMock } = chatService(store, spendGuard, chatResponse(REPLY));
        const deltas: string[] = [];
        const streamed: unknown[] = [];
        const result = await service.turn(
            { bundle: tinyBundle(), conversationId: 'conv-1', message: 'What meds is she on?', correlationId: 'corr-c1' },
            silentLogger,
            { onTextDelta: (text) => deltas.push(text), onCitation: (citation) => streamed.push(citation) },
        );
        expect(deltas.join('')).toBe(REPLY);
        expect(result.citations).toHaveLength(2);
        expect(result.citations.every((c) => c.verified)).toBe(true);
        expect(result.unverified_count).toBe(0);
        expect(streamed).toHaveLength(2);
        expect(store.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
        expect(spendGuard.recorded).toEqual([
            { model: 'claude-haiku-4-5', inputTokens: 900, outputTokens: 120, correlationId: 'corr-c1', purpose: 'chat_turn' },
        ]);
        // Wire shape: latest user message carries document blocks with citations enabled.
        const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as {
            messages: { role: string; content: unknown }[];
        };
        const content = body.messages.at(-1)!.content as Record<string, unknown>[];
        expect(content[0]).toMatchObject({ type: 'document', citations: { enabled: true } });
        expect((content.at(-1) as { text: string }).text).toBe('What meds is she on?');
    });

    // Guards: history amnesia — the second turn must replay the first turn to the model.
    it('feeds prior conversation turns back as plain text', async () => {
        const store = new FakeChatStore();
        const { service, fetchMock } = chatService(store, undefined, chatResponse(REPLY), chatResponse('Short.'));
        const bundle = tinyBundle();
        await service.turn({ bundle, conversationId: 'c', message: 'first?', correlationId: 'x1' }, silentLogger);
        await service.turn({ bundle, conversationId: 'c', message: 'second?', correlationId: 'x2' }, silentLogger);
        const secondBody = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body)) as {
            messages: { role: string; content: unknown }[];
        };
        expect(secondBody.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
        expect(secondBody.messages[0]!.content).toBe('first?'); // history is plain text
        expect(secondBody.messages[1]!.content).toBe(REPLY);
    });

    // Guards (IC3): ephemeral UI context reaches the model on the latest turn only and
    // never leaks into the persisted transcript.
    it('appends uiContext to the model call but never persists it', async () => {
        const store = new FakeChatStore();
        const { service, fetchMock } = chatService(store, undefined, chatResponse(REPLY));
        await service.turn(
            {
                bundle: tinyBundle(),
                conversationId: 'c',
                message: 'What about this scan?',
                correlationId: 'x',
                uiContext: '[UI context] Viewing scan img-mc-001.',
            },
            silentLogger,
        );
        const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as {
            messages: { content: unknown }[];
        };
        const content = body.messages.at(-1)!.content as { type: string; text?: string }[];
        expect(content.at(-1)!.text).toBe('What about this scan?\n\n[UI context] Viewing scan img-mc-001.');
        // Persisted transcript keeps the physician's words verbatim.
        expect(store.messages[0]!.content).toBe('What about this scan?');
    });

    // Guards: a failed LLM call leaving a half-persisted turn in the conversation.
    it('persists nothing when the LLM call fails', async () => {
        const store = new FakeChatStore();
        const { service } = chatService(store, undefined, new Response(JSON.stringify({ error: { type: 'api_error' } }), { status: 500 }));
        await expect(
            service.turn({ bundle: tinyBundle(), conversationId: 'c', message: 'hi', correlationId: 'x' }, silentLogger),
        ).rejects.toThrow();
        expect(store.messages).toHaveLength(0);
    });
});

describe('ChatService tool-use loop', () => {
    // Guards: the loop contract — the model asks for a tool, the tool executes, its result is
    // fed back, and a second call produces the final answer; tools_used is populated and the
    // second call carries the assistant tool_use turn + the tool_result turn.
    it('executes a requested tool then produces a final answer', async () => {
        const store = new FakeChatStore();
        const spendGuard = new FakeSpendGuard();
        const tool = fakeTool('get_open_questions', { count: 1, open_questions: [{ contradiction_id: 'c1' }], derived: true });
        const { service, fetchMock } = chatServiceWithTools(
            store,
            spendGuard,
            [tool],
            [toolUseResponse('get_open_questions', {}), chatResponse('Ask about Plaquenil duration.')],
        );
        const toolEvents: { name: string; ok?: boolean }[] = [];
        const result = await service.turn(
            { bundle: tinyBundle(), conversationId: 'conv-t', message: 'What should I ask?', correlationId: 'corr-t' },
            silentLogger,
            {
                onToolUse: (event) => toolEvents.push({ name: event.name }),
                onToolResult: (event) => toolEvents.push({ name: event.name, ok: event.ok }),
            },
        );

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(result.tools_used).toEqual(['get_open_questions']);
        expect(result.reply).toBe('Ask about Plaquenil duration.');
        expect(store.messages.map((m) => m.content)).toEqual(['What should I ask?', 'Ask about Plaquenil duration.']);
        expect(spendGuard.recorded).toHaveLength(2); // one per LLM call
        expect(toolEvents).toContainEqual({ name: 'get_open_questions' });
        expect(toolEvents).toContainEqual({ name: 'get_open_questions', ok: true });

        // The second call replays the assistant tool_use turn and the tool_result turn.
        const secondBody = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body)) as {
            messages: { role: string; content: unknown }[];
        };
        expect(secondBody.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
        const assistantBlocks = secondBody.messages[1]!.content as Record<string, unknown>[];
        expect(assistantBlocks.some((block) => block['type'] === 'tool_use')).toBe(true);
        const toolResultBlocks = secondBody.messages[2]!.content as Record<string, unknown>[];
        expect(toolResultBlocks[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu-get_open_questions' });
    });

    // Guards (IC4): the media path — a tool output marked attach_image gets the loaded
    // pixels appended to its tool_result as an image content block, alongside the verbatim
    // JSON text block.
    it('attaches the scan pixels to a describe_scan tool_result via the injected loader', async () => {
        const store = new FakeChatStore();
        const output = {
            image_id: 'img-1',
            capture_date: '2024-01-01',
            modality: 'oct',
            laterality: 'od',
            authored_headline: 'Subretinal fluid, moderate',
            storage_key: 'oct-test-1.jpg',
            attach_image: true,
            derived: true,
        };
        const loads: string[] = [];
        const loader: ChatImageLoader = (storageKey) => {
            loads.push(storageKey);
            return Promise.resolve({ mediaType: 'image/jpeg', base64: 'QUJD' });
        };
        const { service, fetchMock } = chatServiceWithTools(
            store,
            undefined,
            [fakeTool('describe_scan', output)],
            [toolUseResponse('describe_scan', { image_id: 'img-1' }), chatResponse(REPLY)],
            loader,
        );
        await service.turn(
            { bundle: tinyBundle(), conversationId: 'c', message: 'What does the scan look like?', correlationId: 'x' },
            silentLogger,
        );

        expect(loads).toEqual(['oct-test-1.jpg']);
        const secondBody = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body)) as {
            messages: { content: unknown }[];
        };
        const blocks = (secondBody.messages.at(-1)!.content as Record<string, unknown>[])[0]!;
        const content = blocks['content'] as Record<string, unknown>[];
        expect(Array.isArray(content)).toBe(true);
        expect(content).toHaveLength(2);
        expect(content[0]).toEqual({ type: 'text', text: JSON.stringify(output) });
        expect(content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } });
    });

    it('degrades to an explicit image-unavailable note when the pixels cannot load', async () => {
        const store = new FakeChatStore();
        const output = { image_id: 'img-1', storage_key: 'gone.jpg', attach_image: true, derived: true };
        const { service, fetchMock } = chatServiceWithTools(
            store,
            undefined,
            [fakeTool('describe_scan', output)],
            [toolUseResponse('describe_scan', { image_id: 'img-1' }), chatResponse(REPLY)],
            () => Promise.resolve(null), // loader present but the pixels are gone
        );
        await service.turn(
            { bundle: tinyBundle(), conversationId: 'c', message: 'Look at the scan.', correlationId: 'x' },
            silentLogger,
        );
        const secondBody = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body)) as {
            messages: { content: unknown }[];
        };
        const blocks = (secondBody.messages.at(-1)!.content as Record<string, unknown>[])[0]!;
        const content = blocks['content'] as Record<string, unknown>[];
        expect(content).toHaveLength(2);
        expect(String((content[1] as { text: string }).text)).toContain('image_unavailable');
    });

    // Guards: a document-quoting tool's provenance is verified server-side and surfaced as a
    // citation (the gate philosophy carried through the tool path).
    it('attaches a verified citation from a document-quoting tool result', async () => {
        const store = new FakeChatStore();
        const excerpt = 'Plaquenil 200 mg daily';
        const tool = fakeTool('search_record', { query: 'Plaquenil', match_count: 1, matches: [], derived: false }, [
            { source_document_id: 'doc-mc-004', excerpt },
        ]);
        const { service } = chatServiceWithTools(
            store,
            undefined,
            [tool],
            [toolUseResponse('search_record', { query: 'Plaquenil' }), chatResponse('On Plaquenil since 2019.')],
        );
        const streamed: unknown[] = [];
        const result = await service.turn(
            { bundle: tinyBundle(), conversationId: 'c', message: 'search', correlationId: 'x' },
            silentLogger,
            { onCitation: (citation) => streamed.push(citation) },
        );
        const toolCitation = result.citations.find((c) => c.cited_text === excerpt);
        expect(toolCitation).toBeDefined();
        expect(toolCitation!.verified).toBe(true);
        expect(toolCitation!.document_id).toBe('doc-mc-004');
        expect(streamed).toContainEqual(toolCitation);
    });

    // Guards: the round cap — a model that keeps asking for tools is stopped after 4 tool
    // rounds and a final, tool-free call forces an answer.
    it('caps at 4 tool rounds then forces a tool-free final answer', async () => {
        const store = new FakeChatStore();
        const tool = fakeTool('search_record', { query: 'x', match_count: 0, matches: [], derived: false });
        const { service, fetchMock } = chatServiceWithTools(
            store,
            undefined,
            [tool],
            [
                toolUseResponse('search_record', { query: 'x' }),
                toolUseResponse('search_record', { query: 'x' }),
                toolUseResponse('search_record', { query: 'x' }),
                toolUseResponse('search_record', { query: 'x' }),
                chatResponse('Final answer after the cap.'),
            ],
        );
        const result = await service.turn(
            { bundle: tinyBundle(), conversationId: 'c', message: 'loop forever', correlationId: 'x' },
            silentLogger,
        );

        expect(fetchMock).toHaveBeenCalledTimes(5); // 4 tool rounds + 1 forced final
        expect(result.tools_used).toHaveLength(4);
        expect(result.reply).toBe('Final answer after the cap.');
        // The first call offers tools; the forced-final (5th) call does not.
        expect('tools' in (JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as Record<string, unknown>)).toBe(true);
        expect('tools' in (JSON.parse(String(fetchMock.mock.calls[4]![1]?.body)) as Record<string, unknown>)).toBe(false);
    });
});

describe('chat routes', () => {
    function routeDeps(overrides: Partial<{ spendGuard: FakeSpendGuard; responses: Response[] }> = {}) {
        const store = new FakeChatStore();
        const spendGuard = overrides.spendGuard ?? new FakeSpendGuard();
        const { service, fetchMock } = chatService(store, spendGuard, ...(overrides.responses ?? [chatResponse(REPLY)]));
        const deps: ChatRouteDeps = { store, service, spendGuard };
        return { deps, store, fetchMock };
    }

    function sseEvents(body: string): Record<string, unknown>[] {
        return body
            .split('\n\n')
            .filter((chunk) => chunk.startsWith('data: '))
            .map((chunk) => JSON.parse(chunk.slice(6)) as Record<string, unknown>);
    }

    function storedBrief(): StoredBrief {
        return {
            id: 'brief-1',
            patient_id: 'margaret-chen',
            prepared_at: '2026-07-11T08:00:00.000Z',
            correlation_id: 'prep-1',
            status: 'complete',
            content: {
                urgency: { level: 'high', reason: 'HCQ retinal toxicity risk at threshold' },
                key_discussion_points: [
                    { kind: 'risk_flag', text: 'Hydroxychloroquine: HIGH retinal toxicity risk', fact_ids: [], contradiction_id: null },
                    'GC-IPL thinning 82→70 µm across six OCTs',
                ],
                questions_to_confirm: ['Any new visual symptoms since December?'],
            },
        };
    }

    // Guards: the SSE wire contract the panel parses — delta + citation events, then a
    // done event carrying the verified citation list.
    it('POST streams delta and citation events and a done event', async () => {
        const { deps } = routeDeps();
        const res = await chatApp(deps).inject({
            method: 'POST',
            url: '/api/chat/margaret-chen',
            headers: { 'x-correlation-id': 'corr-sse' },
            payload: { message: 'What meds is she on?' },
        });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/event-stream');
        const events = res.body
            .split('\n\n')
            .filter((chunk) => chunk.startsWith('data: '))
            .map((chunk) => JSON.parse(chunk.slice(6)) as Record<string, unknown>);
        const text = events.filter((e) => e['type'] === 'delta').map((e) => e['text']).join('');
        expect(text).toBe(REPLY);
        expect(events.filter((e) => e['type'] === 'citation')).toHaveLength(2);
        const done = events.at(-1)!;
        expect(done['type']).toBe('done');
        expect(done['citations']).toHaveLength(2);
        expect(done['unverified_count']).toBe(0);
        expect(typeof done['conversation_id']).toBe('string');
    });

    // Guards (M9): a NEW conversation opens with the persisted opening move — the seed
    // event leads the wire, the seed row leads the transcript, and the model reads it as
    // history behind the synthetic user-first introducer the Messages API requires.
    it('POST seeds a fresh conversation with the opening move when a brief exists', async () => {
        const { deps, store, fetchMock } = routeDeps();
        store.brief = storedBrief();
        const res = await chatApp(deps).inject({
            method: 'POST',
            url: '/api/chat/margaret-chen',
            payload: { message: 'What matters today?' },
        });
        expect(res.statusCode).toBe(200);
        const events = sseEvents(res.body);
        const seed = events[0]!;
        expect(seed['type']).toBe('seed');
        const seedText = String(seed['content']);
        expect(seedText).toContain('I read the record during check-in (brief prepared 2026-07-11)');
        expect(seedText).toContain('Urgency: high — HCQ retinal toxicity risk at threshold.');
        expect(seedText).toContain('Worth discussing: 1) Hydroxychloroquine: HIGH retinal toxicity risk 2) GC-IPL thinning');
        expect(seedText).toContain('1 question queued to ask the patient.');
        // Persisted FIRST: the stored transcript opens with the opening move.
        expect(store.messages.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant']);
        expect(store.messages[0]!.content).toBe(seedText);
        // Model view: synthetic user introducer, then the seed as assistant history, then
        // the latest user turn carrying the document blocks.
        const request = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)) as {
            messages: { role: string; content: unknown }[];
        };
        expect(request.messages).toHaveLength(3);
        expect(request.messages[0]).toEqual({ role: 'user', content: 'I have opened the chart — give me your prepared opening.' });
        expect(request.messages[1]).toEqual({ role: 'assistant', content: seedText });
        expect(request.messages[2]!.role).toBe('user');
    });

    it('POST does not seed a continued conversation or a patient without a brief', async () => {
        // No completed brief -> no seed, plain two-row transcript.
        const noBrief = routeDeps();
        const resA = await chatApp(noBrief.deps).inject({
            method: 'POST',
            url: '/api/chat/margaret-chen',
            payload: { message: 'What meds is she on?' },
        });
        expect(sseEvents(resA.body).some((event) => event['type'] === 'seed')).toBe(false);
        expect(noBrief.store.messages.map((m) => m.role)).toEqual(['user', 'assistant']);

        // Client-supplied conversation id -> continued conversation, never re-seeded.
        const continued = routeDeps();
        continued.store.brief = storedBrief();
        const resB = await chatApp(continued.deps).inject({
            method: 'POST',
            url: '/api/chat/margaret-chen',
            payload: { message: 'And the allergy?', conversation_id: 'conv-known' },
        });
        expect(sseEvents(resB.body).some((event) => event['type'] === 'seed')).toBe(false);
        expect(continued.store.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    });

    // Guards (IC3): the viewing-scan context — a valid id rides the model call as UI
    // context, an unknown id is ignored (UI state must never fail a turn), and the
    // persisted transcript stays verbatim either way.
    it('POST folds a valid viewing_image_id into the model call and ignores unknown ids', async () => {
        const bundleWithScan = (): FactBundle => {
            const bundle = tinyBundle();
            bundle.images = [
                {
                    id: 'img-mc-001',
                    patient_id: 'margaret-chen',
                    image_metadata: { capture_date: '2024-12-26T10:35:00Z', modality: 'oct', laterality: 'od' },
                    ai_analysis: { findings: [], measurements: [] },
                },
            ];
            return bundle;
        };
        const makeDeps = () => {
            const store = new FakeChatStore(bundleWithScan());
            const spendGuard = new FakeSpendGuard();
            const { service, fetchMock } = chatService(store, spendGuard, chatResponse(REPLY));
            const deps: ChatRouteDeps = { store, service, spendGuard };
            return { deps, store, fetchMock };
        };

        // Valid id: the context line reaches the model; the transcript keeps the raw message.
        const valid = makeDeps();
        const resA = await chatApp(valid.deps).inject({
            method: 'POST',
            url: '/api/chat/margaret-chen',
            payload: { message: 'What am I looking at?', viewing_image_id: 'img-mc-001' },
        });
        expect(resA.statusCode).toBe(200);
        const bodyA = JSON.parse(String(valid.fetchMock.mock.calls[0]![1]?.body)) as {
            messages: { content: unknown }[];
        };
        const textA = (bodyA.messages.at(-1)!.content as { text?: string }[]).at(-1)!.text!;
        expect(textA.startsWith('What am I looking at?')).toBe(true);
        expect(textA).toContain('img-mc-001');
        expect(textA).toContain('oct, OD');
        expect(valid.store.messages[0]!.content).toBe('What am I looking at?');

        // Unknown id: ignored — the turn proceeds with no context appended.
        const unknown = makeDeps();
        const resB = await chatApp(unknown.deps).inject({
            method: 'POST',
            url: '/api/chat/margaret-chen',
            payload: { message: 'What am I looking at?', viewing_image_id: 'img-nope' },
        });
        expect(resB.statusCode).toBe(200);
        const bodyB = JSON.parse(String(unknown.fetchMock.mock.calls[0]![1]?.body)) as {
            messages: { content: unknown }[];
        };
        expect((bodyB.messages.at(-1)!.content as { text?: string }[]).at(-1)!.text).toBe('What am I looking at?');
    });

    // Guards: the tool-activity wire contract — tool_use + tool_result events stream and the
    // done event carries tools_used, so the panel (TC3) can render tool activity.
    it('POST streams tool_use and tool_result events and tools_used in done', async () => {
        const store = new FakeChatStore();
        const spendGuard = new FakeSpendGuard();
        const tool = fakeTool('get_open_questions', { count: 0, open_questions: [], derived: true });
        const { service } = chatServiceWithTools(
            store,
            spendGuard,
            [tool],
            [toolUseResponse('get_open_questions', {}), chatResponse(REPLY)],
        );
        const deps: ChatRouteDeps = { store, service, spendGuard };
        const res = await chatApp(deps).inject({
            method: 'POST',
            url: '/api/chat/margaret-chen',
            payload: { message: 'What should I ask?' },
        });
        expect(res.statusCode).toBe(200);
        const events = res.body
            .split('\n\n')
            .filter((chunk) => chunk.startsWith('data: '))
            .map((chunk) => JSON.parse(chunk.slice(6)) as Record<string, unknown>);
        expect(events.some((e) => e['type'] === 'tool_use' && e['name'] === 'get_open_questions')).toBe(true);
        expect(events.some((e) => e['type'] === 'tool_result' && e['name'] === 'get_open_questions' && e['ok'] === true)).toBe(true);
        const done = events.at(-1)!;
        expect(done['type']).toBe('done');
        expect(done['tools_used']).toEqual(['get_open_questions']);
    });

    // Guards (IC2): imaging tool results stream with a compact render-ready summary — the
    // panel draws the sparkline/compare pair from it — while non-imaging tools stay bare.
    it('POST projects a trend summary onto imaging tool_result events only', async () => {
        const trendOutput = {
            metric: 'ganglion_cell_thickness',
            laterality: 'od',
            series: [
                { date: '2024-01-01', laterality: 'od', value: 80, unit: 'microns', image_id: 'img-1' },
                { date: '2024-06-01', laterality: 'od', value: 65, unit: 'microns', image_id: 'img-2' },
            ],
            derived: true,
        };
        const store = new FakeChatStore();
        const spendGuard = new FakeSpendGuard();
        const { service } = chatServiceWithTools(
            store,
            spendGuard,
            [fakeTool('get_measurement_trend', trendOutput)],
            [toolUseResponse('get_measurement_trend', { metric: 'GC-IPL' }), chatResponse(REPLY)],
        );
        const deps: ChatRouteDeps = { store, service, spendGuard };
        const res = await chatApp(deps).inject({
            method: 'POST',
            url: '/api/chat/margaret-chen',
            payload: { message: 'How is her GC-IPL trending?' },
        });
        const toolResult = sseEvents(res.body).find((event) => event['type'] === 'tool_result')!;
        expect(toolResult['summary']).toEqual({
            kind: 'trend',
            metric: 'ganglion_cell_thickness',
            series: [
                { date: '2024-01-01', value: 80, image_id: 'img-1', laterality: 'od' },
                { date: '2024-06-01', value: 65, image_id: 'img-2', laterality: 'od' },
            ],
        });

        // The projector itself: compare -> compact pair; errors and non-imaging -> undefined.
        expect(
            imagingToolSummary('compare_scans', true, {
                current_image_id: 'img-2',
                prior_image_id: 'img-1',
                comparison: { overall_change: 'improved', changes: [] },
                derived: true,
            }),
        ).toEqual({ kind: 'compare', current_image_id: 'img-2', prior_image_id: 'img-1', overall_change: 'improved' });
        expect(imagingToolSummary('get_measurement_trend', false, { error: 'no data' })).toBeUndefined();
        expect(imagingToolSummary('get_open_questions', true, { count: 0 })).toBeUndefined();
        expect(imagingToolSummary('get_measurement_trend', true, { metric: 'cst', series: 'garbage' })).toBeUndefined();
    });

    // Guards: guard responses arriving mid-stream — they must be plain JSON status codes.
    it('answers 404 unknown patient, 400 bad message, and 429 over budget as JSON', async () => {
        const { deps } = routeDeps();
        const app = chatApp(deps);
        expect((await app.inject({ method: 'POST', url: '/api/chat/nobody', payload: { message: 'hi' } })).statusCode).toBe(404);
        expect((await app.inject({ method: 'POST', url: '/api/chat/margaret-chen', payload: { message: '' } })).statusCode).toBe(400);
        expect(
            (await app.inject({ method: 'POST', url: '/api/chat/margaret-chen', payload: { message: 'x'.repeat(2001) } })).statusCode,
        ).toBe(400);
        const broke = routeDeps();
        (broke.deps.spendGuard as FakeSpendGuard).budgetError = new BudgetExceededError(6, 5);
        const res = await chatApp(broke.deps).inject({ method: 'POST', url: '/api/chat/margaret-chen', payload: { message: 'hi' } });
        expect(res.statusCode).toBe(429);
        expect(res.json()).toMatchObject({ error: 'llm_budget_exceeded' });
    });

    // Guards: conversation persistence across reloads — GET replays what POST stored.
    it('GET replays a stored conversation oldest-first', async () => {
        const { deps, store } = routeDeps();
        await store.saveChatMessage({ patient_id: 'margaret-chen', conversation_id: 'c9', role: 'user', content: 'q', correlation_id: 'x' });
        await store.saveChatMessage({ patient_id: 'margaret-chen', conversation_id: 'c9', role: 'assistant', content: 'a', correlation_id: 'x' });
        const res = await chatApp(deps).inject({ method: 'GET', url: '/api/chat/margaret-chen?conversation_id=c9' });
        expect(res.statusCode).toBe(200);
        const body = res.json() as { messages: { role: string; content: string }[] };
        expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
        const missing = await chatApp(deps).inject({ method: 'GET', url: '/api/chat/margaret-chen' });
        expect(missing.statusCode).toBe(400);
    });

    // Guards: the scaffold contract without a configured store.
    it('answers 503 without deps', async () => {
        const app = buildServer(loadConfig({ NODE_ENV: 'test' }));
        expect((await app.inject({ method: 'POST', url: '/api/chat/x', payload: { message: 'hi' } })).statusCode).toBe(503);
        expect((await app.inject({ method: 'GET', url: '/api/chat/x?conversation_id=c' })).statusCode).toBe(503);
    });
});
