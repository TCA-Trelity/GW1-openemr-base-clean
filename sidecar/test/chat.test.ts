// Chat tests (S2.3): streaming SSE contract, citation-token validation against the
// bundle, persistence, and the pre-stream guards. No Postgres, no live Anthropic.
import { describe, expect, it, vi } from 'vitest';
import { buildChatSystemPrompt, parseCitations, ChatService, type ChatMessageInput, type StoredChatMessage } from '../src/chat/chat.js';
import { loadConfig } from '../src/config.js';
import { AnthropicClient, type FetchLike } from '../src/prep/anthropic.js';
import { BudgetExceededError, type LlmCallRecord } from '../src/prep/budget.js';
import type { PrepLogger } from '../src/prep/extraction.js';
import { registerChatRoutes, type ChatRouteDeps } from '../src/routes/chat.js';
import { buildServer } from '../src/server.js';
import type { FactBundle } from '../src/store/index.js';
import Fastify from 'fastify';

const silentLogger: PrepLogger = { info: () => {}, warn: () => {}, error: () => {} };

function tinyBundle(): FactBundle {
    return {
        patient: { id: 'margaret-chen', openemr_patient_id: null, name: 'Margaret L. Chen', demographics: {} },
        facts: [
            {
                id: 'med-hcq-001',
                patient_id: 'margaret-chen',
                fact_type: 'medication',
                content: { name: 'Hydroxychloroquine', dose: '200mg', start_date: '2019-01-15' },
                is_current: true,
                laterality: null,
                verification: { status: 'unverified' },
                source_document_id: 'doc-mc-004',
                sources: [{ excerpt_text: 'Plaquenil 200 mg daily' }],
                created_date: null,
                updated_date: null,
            },
            {
                id: 'allergy-001',
                patient_id: 'margaret-chen',
                fact_type: 'allergy',
                content: { substance: 'Penicillin' },
                is_current: true,
                laterality: null,
                verification: { status: 'unverified' },
                source_document_id: 'doc-mc-001',
                sources: [{ excerpt_text: 'Allergic to penicillin' }],
                created_date: null,
                updated_date: null,
            },
        ],
        contradictions: [],
        images: [],
        treatments: [],
        documents: [],
    };
}

const REPLY = 'On HCQ 200mg daily since 2019 [[fact:med-hcq-001]]. Penicillin allergy [[fact:allergy-001]] [[fact:invented-9]].';

function sse(events: Record<string, unknown>[]): string {
    return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

function chatResponse(text: string): Response {
    const mid = Math.ceil(text.length / 2);
    return new Response(
        sse([
            { type: 'message_start', message: { model: 'claude-haiku-4-5', usage: { input_tokens: 900, output_tokens: 1 } } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, mid) } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(mid) } },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 120 } },
            { type: 'message_stop' },
        ]),
        { status: 200 },
    );
}

class FakeChatStore {
    messages: (ChatMessageInput & { id: string })[] = [];
    constructor(private readonly bundle: FactBundle | null = tinyBundle()) {}

    async getFactBundle(patientId: string): Promise<FactBundle | null> {
        return this.bundle !== null && this.bundle.patient.id === patientId ? this.bundle : null;
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

function chatApp(deps?: ChatRouteDeps) {
    const app = Fastify({ logger: false });
    registerChatRoutes(app, deps);
    return app;
}

describe('buildChatSystemPrompt', () => {
    // Guards: the model's world drifting — facts must be id-addressable and the citation
    // contract + only-from-record rule must be verbatim present.
    it('serializes facts with ids and states the citation contract', () => {
        const prompt = buildChatSystemPrompt(tinyBundle());
        expect(prompt).toContain('[med-hcq-001]');
        expect(prompt).toContain('Plaquenil 200 mg daily');
        expect(prompt).toContain('[[fact:<id>]]');
        expect(prompt).toContain('ONLY from the patient record');
    });
});

describe('parseCitations', () => {
    // Guards: an invented citation rendering as provenance — it must be split out.
    it('separates known fact ids from invented ones', () => {
        const { valid, invalid } = parseCitations(REPLY, tinyBundle());
        expect(valid.sort()).toEqual(['allergy-001', 'med-hcq-001']);
        expect(invalid).toEqual(['invented-9']);
    });
});

describe('ChatService.turn', () => {
    // Guards: the streaming + persistence + spend contract in one pass — deltas relayed,
    // both turns persisted only after success, the call ledgered as chat_turn.
    it('streams deltas, persists the turn, ledgers spend, and validates citations', async () => {
        const store = new FakeChatStore();
        const spendGuard = new FakeSpendGuard();
        const { service } = chatService(store, spendGuard, chatResponse(REPLY));
        const deltas: string[] = [];
        const result = await service.turn(
            { bundle: tinyBundle(), conversationId: 'conv-1', message: 'What meds is she on?', correlationId: 'corr-c1' },
            silentLogger,
            (text) => deltas.push(text),
        );
        expect(deltas.join('')).toBe(REPLY);
        expect(result.cited_fact_ids.sort()).toEqual(['allergy-001', 'med-hcq-001']);
        expect(result.invalid_citation_ids).toEqual(['invented-9']);
        expect(store.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
        expect(spendGuard.recorded).toEqual([
            { model: 'claude-haiku-4-5', inputTokens: 900, outputTokens: 120, correlationId: 'corr-c1', purpose: 'chat_turn' },
        ]);
    });

    // Guards: history amnesia — the second turn must replay the first turn to the model.
    it('feeds prior conversation turns back to the model', async () => {
        const store = new FakeChatStore();
        const { service, fetchMock } = chatService(store, undefined, chatResponse(REPLY), chatResponse('Follow-up [[fact:med-hcq-001]].'));
        const bundle = tinyBundle();
        await service.turn({ bundle, conversationId: 'c', message: 'first?', correlationId: 'x1' }, silentLogger);
        await service.turn({ bundle, conversationId: 'c', message: 'second?', correlationId: 'x2' }, silentLogger);
        const secondBody = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body)) as { messages: { role: string; content: string }[] };
        expect(secondBody.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
        expect(secondBody.messages[1]!.content).toBe(REPLY);
        expect(secondBody.messages[2]!.content).toBe('second?');
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

describe('chat routes', () => {
    function routeDeps(overrides: Partial<{ spendGuard: FakeSpendGuard; responses: Response[] }> = {}) {
        const store = new FakeChatStore();
        const spendGuard = overrides.spendGuard ?? new FakeSpendGuard();
        const { service } = chatService(store, spendGuard, ...(overrides.responses ?? [chatResponse(REPLY)]));
        const deps: ChatRouteDeps = { store, service, spendGuard };
        return { deps, store };
    }

    // Guards: the SSE wire contract the panel parses — delta events then a done event
    // with the validated citation ids, correlation ID on the response.
    it('POST streams delta events and a done event with validated citations', async () => {
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
        const done = events.at(-1)!;
        expect(done['type']).toBe('done');
        expect((done['cited_fact_ids'] as string[]).sort()).toEqual(['allergy-001', 'med-hcq-001']);
        expect(done['invalid_citation_ids']).toEqual(['invented-9']);
        expect(typeof done['conversation_id']).toBe('string');
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
