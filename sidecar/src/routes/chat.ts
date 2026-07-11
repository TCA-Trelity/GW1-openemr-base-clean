// Chat routes (S2.3, M9 opening move). POST streams the reply as SSE (delta events, then
// one done event carrying validated citation ids); guards (patient exists, budget) answer
// as plain JSON BEFORE the stream opens so the panel can branch on status codes. A NEW
// conversation opens with the agent's prepared digest when a completed brief exists —
// persisted first (the model sees it as history; replay shows the transcript opening with
// it) and echoed to the panel as a `seed` event. GET replays a conversation for
// persistence across reloads.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ChatService, ChatStore } from '../chat/chat.js';
import { composeOpeningMove } from '../chat/openingMove.js';
import { BudgetExceededError } from '../prep/budget.js';
import type { PrepSpendGuard } from '../prep/pipeline.js';
import type { FactBundle, StoredBrief } from '../store/index.js';

/** The store surface these routes need (FactStore satisfies it; tests fake it). */
export interface ChatRouteStore extends ChatStore {
    getFactBundle(patientId: string): Promise<FactBundle | null>;
    /** Latest COMPLETED brief — the M9 opening move composes from it (null = no seed). */
    getBrief(patientId: string): Promise<StoredBrief | null>;
}

export interface ChatRouteDeps {
    store: ChatRouteStore;
    service: ChatService;
    spendGuard?: PrepSpendGuard;
}

type ChatParams = { Params: { patientId: string } };
type ChatPost = ChatParams & { Body: { message?: unknown; conversation_id?: unknown } };
type ChatGet = ChatParams & { Querystring: { conversation_id?: string } };

const MAX_MESSAGE_CHARS = 2000;

function storeNotConfigured(reply: FastifyReply): FastifyReply {
    return reply.status(503).send({ error: 'store_not_configured' });
}

export function registerChatRoutes(app: FastifyInstance, deps: ChatRouteDeps | undefined): void {
    app.post<ChatPost>('/api/chat/:patientId', async (request, reply) => {
        if (deps === undefined) {
            return storeNotConfigured(reply);
        }
        const message = request.body?.message;
        if (typeof message !== 'string' || message.trim().length === 0 || message.length > MAX_MESSAGE_CHARS) {
            return reply.status(400).send({ error: 'invalid_message', max_chars: MAX_MESSAGE_CHARS });
        }
        const rawConversation = request.body?.conversation_id;
        const mintedFresh = !(typeof rawConversation === 'string' && rawConversation !== '');
        const conversationId = mintedFresh ? randomUUID() : (rawConversation as string);

        // Pre-stream guards answer as plain JSON: after the SSE opens, only events remain.
        const bundle = await deps.store.getFactBundle(request.params.patientId);
        if (bundle === null) {
            return reply.status(404).send({ error: 'patient_not_found' });
        }
        if (deps.spendGuard !== undefined) {
            try {
                await deps.spendGuard.assertBudget();
            } catch (error) {
                if (error instanceof BudgetExceededError) {
                    return reply
                        .status(429)
                        .send({ error: 'llm_budget_exceeded', spent_usd: error.spentUsd, budget_usd: error.budgetUsd });
                }
                throw error;
            }
        }

        // M9 opening move: a NEW conversation opens with the agent's prepared digest when a
        // completed brief exists. Persisted BEFORE the turn so the model reads it as history
        // and GET replay shows the transcript opening with it; skipped silently when no brief
        // has completed (absence over invention). Store failures here surface as plain 500s —
        // the stream has not opened yet.
        let openingMove: string | null = null;
        if (mintedFresh) {
            const brief = await deps.store.getBrief(request.params.patientId);
            if (brief !== null) {
                openingMove = composeOpeningMove(brief.content, brief.prepared_at);
                if (openingMove !== null) {
                    await deps.store.saveChatMessage({
                        patient_id: request.params.patientId,
                        conversation_id: conversationId,
                        role: 'assistant',
                        content: openingMove,
                        correlation_id: String(request.id),
                    });
                }
            }
        }

        reply.hijack();
        reply.raw.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
            'x-correlation-id': String(request.id),
        });
        const writeEvent = (event: Record<string, unknown>): void => {
            reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        };
        // The opening move streams first so the panel renders it above the first exchange.
        if (openingMove !== null) {
            writeEvent({ type: 'seed', conversation_id: conversationId, content: openingMove });
        }
        try {
            const result = await deps.service.turn(
                { bundle, conversationId, message, correlationId: String(request.id) },
                request.log,
                {
                    onTextDelta: (text) => writeEvent({ type: 'delta', text }),
                    // Verified citations stream live so chips render as the text arrives.
                    onCitation: (citation) => writeEvent({ type: 'citation', citation }),
                    // Tool activity streams so the panel can show what the model is doing (TC3).
                    onToolUse: (event) => writeEvent({ type: 'tool_use', name: event.name, input: event.input }),
                    onToolResult: (event) => writeEvent({ type: 'tool_result', name: event.name, ok: event.ok }),
                },
            );
            writeEvent({
                type: 'done',
                conversation_id: result.conversation_id,
                citations: result.citations,
                unverified_count: result.unverified_count,
                tools_used: result.tools_used,
                prescriptive_flag_count: result.prescriptive_flag_count,
            });
        } catch (error) {
            request.log.error({ correlationId: request.id, err: String(error) }, 'chat turn failed');
            writeEvent({ type: 'error', error: 'chat_failed' });
        }
        reply.raw.end();
        return reply;
    });

    app.get<ChatGet>('/api/chat/:patientId', async (request, reply) => {
        if (deps === undefined) {
            return storeNotConfigured(reply);
        }
        const conversationId = request.query.conversation_id;
        if (conversationId === undefined || conversationId === '') {
            return reply.status(400).send({ error: 'conversation_id_required' });
        }
        const messages = await deps.store.getChatMessages(request.params.patientId, conversationId, 100);
        return reply.send({ conversation_id: conversationId, messages });
    });
}
