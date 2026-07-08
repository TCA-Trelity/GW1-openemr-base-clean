// Chat routes (S2.3). POST streams the reply as SSE (delta events, then one done event
// carrying validated citation ids); guards (patient exists, budget) answer as plain JSON
// BEFORE the stream opens so the panel can branch on status codes. GET replays a
// conversation for persistence across reloads.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ChatService, ChatStore } from '../chat/chat.js';
import { BudgetExceededError } from '../prep/budget.js';
import type { PrepSpendGuard } from '../prep/pipeline.js';
import type { FactBundle } from '../store/index.js';

/** The store surface these routes need (FactStore satisfies it; tests fake it). */
export interface ChatRouteStore extends ChatStore {
    getFactBundle(patientId: string): Promise<FactBundle | null>;
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
        const conversationId = typeof rawConversation === 'string' && rawConversation !== '' ? rawConversation : randomUUID();

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
        try {
            const result = await deps.service.turn(
                { bundle, conversationId, message, correlationId: String(request.id) },
                request.log,
                (text) => writeEvent({ type: 'delta', text }),
            );
            writeEvent({
                type: 'done',
                conversation_id: result.conversation_id,
                cited_fact_ids: result.cited_fact_ids,
                invalid_citation_ids: result.invalid_citation_ids,
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
