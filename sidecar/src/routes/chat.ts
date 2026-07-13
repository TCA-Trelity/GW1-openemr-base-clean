// Chat routes (S2.3, M9 opening move). POST streams the reply as SSE (delta events, then
// one done event carrying the gate-released, verified-only citation list); guards
// (patient exists, budget) answer as plain JSON BEFORE the stream opens so the panel can
// branch on status codes. A NEW conversation opens with the agent's prepared digest when
// a completed brief exists — screened through the response gate, persisted first (the
// model sees it as history; replay shows the transcript opening with it), and echoed to
// the panel as a `seed` event. GET replays a conversation for persistence across reloads.
// Every event body here is produced behind gate/responseGate.ts: citations because only
// released ones reach the hooks, prose because turn replies and the seed pass its screen.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ChatService, ChatStore } from '../chat/chat.js';
import { composeOpeningMove } from '../chat/openingMove.js';
import { screenOutboundText } from '../gate/responseGate.js';
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
type ChatPost = ChatParams & { Body: { message?: unknown; conversation_id?: unknown; viewing_image_id?: unknown } };
type ChatGet = ChatParams & { Querystring: { conversation_id?: string } };

const MAX_MESSAGE_CHARS = 2000;

function storeNotConfigured(reply: FastifyReply): FastifyReply {
    return reply.status(503).send({ error: 'store_not_configured' });
}

/**
 * IC2: project an imaging tool's result into a compact, render-ready summary the panel
 * can draw (trend sparkline, compare pair) — never the whole payload. Structural checks
 * only: anything unexpected degrades to `undefined` (no summary), never an error.
 */
export function imagingToolSummary(
    name: string,
    ok: boolean,
    output: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
    if (!ok || output === undefined) {
        return undefined;
    }
    if (name === 'get_measurement_trend' && Array.isArray(output['series']) && typeof output['metric'] === 'string') {
        const series = (output['series'] as unknown[]).flatMap((point) => {
            if (typeof point !== 'object' || point === null) {
                return [];
            }
            const { date, value, image_id, laterality } = point as Record<string, unknown>;
            if (typeof value !== 'number' || typeof image_id !== 'string') {
                return [];
            }
            return [
                {
                    date: typeof date === 'string' ? date : null,
                    value,
                    image_id,
                    laterality: typeof laterality === 'string' ? laterality : null,
                },
            ];
        });
        return series.length === 0 ? undefined : { kind: 'trend', metric: output['metric'], series };
    }
    if (name === 'compare_scans' && typeof output['current_image_id'] === 'string' && typeof output['prior_image_id'] === 'string') {
        const comparison = output['comparison'];
        const overall =
            typeof comparison === 'object' && comparison !== null
                ? (comparison as Record<string, unknown>)['overall_change']
                : undefined;
        return {
            kind: 'compare',
            current_image_id: output['current_image_id'],
            prior_image_id: output['prior_image_id'],
            ...(typeof overall === 'string' ? { overall_change: overall } : {}),
        };
    }
    return undefined;
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

        // IC3 viewing context: the panel names the scan open in the imaging workspace so
        // "this scan" resolves. Validated against the bundle — an unknown id is ignored
        // (logged), never an error: UI state must not be able to fail a chat turn. The
        // context rides the model call only; the persisted transcript keeps the
        // physician's words verbatim.
        let uiContext: string | undefined;
        const rawViewing = request.body?.viewing_image_id;
        if (typeof rawViewing === 'string' && rawViewing !== '') {
            const viewed = bundle.images.find((image) => image.id === rawViewing);
            if (viewed === undefined) {
                request.log.warn({ viewingImageId: rawViewing }, 'unknown viewing_image_id ignored');
            } else {
                const meta = viewed.image_metadata;
                uiContext =
                    `[UI context — not part of the physician's message] The physician currently has scan ` +
                    `${viewed.id} open in the imaging workspace (${meta.modality}, ${meta.laterality.toUpperCase()}, ` +
                    `captured ${meta.capture_date}). Read "this scan" / "what I'm looking at" as that scan.`;
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
                    // The opening move is outbound prose like any reply: it passes the
                    // gate's advisory screen before it is persisted or streamed.
                    screenOutboundText(openingMove, request.log, {
                        correlationId: String(request.id),
                        conversationId,
                        surface: 'opening_move',
                    });
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
                { bundle, conversationId, message, correlationId: String(request.id), ...(uiContext === undefined ? {} : { uiContext }) },
                request.log,
                {
                    onTextDelta: (text) => writeEvent({ type: 'delta', text }),
                    // Gate-released citations stream live so chips render as the text
                    // arrives — verified-only leaves the server (gate/responseGate.ts).
                    onCitation: (citation) => writeEvent({ type: 'citation', citation }),
                    // Tool activity streams so the panel can show what the model is doing (TC3).
                    onToolUse: (event) => writeEvent({ type: 'tool_use', name: event.name, input: event.input }),
                    // IC2: imaging results also carry a compact summary the panel renders inline.
                    onToolResult: (event) => {
                        const summary = imagingToolSummary(event.name, event.ok, event.output);
                        writeEvent({
                            type: 'tool_result',
                            name: event.name,
                            ok: event.ok,
                            ...(summary === undefined ? {} : { summary }),
                        });
                    },
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
