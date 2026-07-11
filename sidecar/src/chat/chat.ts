// Chat over the stored record (S2.3, reworked R4/R5): source documents are passed as
// Citations-API document blocks, so every claim carries a native citation with the exact
// quoted span — no token contract for the model to fumble. Each cited span is re-verified
// verbatim against the stored document server-side (gate philosophy: unverifiable
// citations are reported, never rendered as provenance). Brevity is a hard prompt
// contract: physicians read replies in seconds.
import type { AnthropicClient, AnthropicContentBlock, AnthropicMessage, AnthropicTool } from '../prep/anthropic.js';
import type { PrepLogger } from '../prep/extraction.js';
import type { PrepSpendGuard } from '../prep/pipeline.js';
import type { FactBundle } from '../store/index.js';
import { lintPrescriptiveness } from './prescriptivenessLint.js';
import { ALL_CHAT_TOOLS, type RegisteredTool } from './tools/index.js';

export interface ChatMessageInput {
    patient_id: string;
    conversation_id: string;
    role: 'user' | 'assistant';
    content: string;
    correlation_id: string;
}

export interface StoredChatMessage {
    id: string;
    patient_id: string;
    conversation_id: string;
    role: 'user' | 'assistant';
    content: string;
    correlation_id: string;
    created_at: string; // ISO datetime
}

/** The store surface chat needs (FactStore satisfies it; tests fake it). */
export interface ChatStore {
    saveChatMessage(input: ChatMessageInput): Promise<string>;
    getChatMessages(patientId: string, conversationId: string, limit?: number): Promise<StoredChatMessage[]>;
}

/** A citation mapped to OUR document ids and re-verified against stored text. */
export interface ChatCitation {
    document_id: string;
    document_title: string;
    cited_text: string;
    start_char: number;
    end_char: number;
    verified: boolean;
}

export interface ChatTurnInput {
    bundle: FactBundle;
    conversationId: string;
    message: string;
    correlationId: string;
}

export interface ChatTurnResult {
    conversation_id: string;
    reply: string;
    citations: ChatCitation[];
    unverified_count: number;
    /** Names of the tools the model invoked this turn, in call order (may repeat). */
    tools_used: string[];
    /** Thought-partner contract (M3): sentences the prescriptiveness lint flagged. */
    prescriptive_flag_count: number;
}

export interface ChatTurnHooks {
    onTextDelta?: (text: string) => void;
    /** Fired per citation as it streams, already mapped + verified. */
    onCitation?: (citation: ChatCitation) => void;
    /** Fired when the model invokes a tool (before it runs) — the panel shows tool activity. */
    onToolUse?: (event: { name: string; input: Record<string, unknown> }) => void;
    /** Fired when a tool returns; `ok` is false for a structured-error result. */
    onToolResult?: (event: { name: string; ok: boolean }) => void;
}

// Cap on tool-execution rounds before a final, tool-free call is forced (guards against a
// model that loops asking for tools forever).
const MAX_TOOL_ROUNDS = 4;

/** Documents the model may cite, in the exact order sent (document_index maps back). */
export function citableDocuments(bundle: FactBundle): { id: string; title: string; text: string }[] {
    return bundle.documents.flatMap((doc) => {
        const text = doc.content['text_content'];
        if (typeof text !== 'string' || text.length === 0) {
            return [];
        }
        return [{ id: doc.id, title: `${doc.document_type} (${doc.document_date})`, text }];
    });
}

// Brevity is the contract (R4): physicians have seconds, not minutes. Voice + judgment
// rules implement docs/prompt-guide.md (M2) — the guide wins on drift; load-bearing
// phrases are pinned by test/chat.test.ts.
export function buildChatSystemPrompt(bundle: FactBundle): string {
    return `You are the chat surface of a clinical co-pilot, answering a physician's questions about ONE patient \
(${bundle.patient.name}, id ${bundle.patient.id}) immediately before the visit.

Hard rules — non-negotiable:
1. Answer ONLY from the attached source documents. If they do not contain the answer, say "Not in the record." — \
never estimate, never use outside medical knowledge to fill gaps.
2. BE BRIEF. Default to at most 3 short bullets or 2 sentences (under ~50 words total). Expand only when the \
physician explicitly asks for more detail. No preamble, no restating the question, no closing offers.
3. Ground every clinical claim in the documents so it carries a citation. When documents disagree, surface the \
conflict in one line — do not pick a winner.
4. You have read-only tools that fetch more from THIS patient's record — full documents, OCT measurement trends, \
scan comparisons, medication-risk checks, keyword search, and open questions. They ARE the record, so rule 1 \
still holds. Call a tool when the attached documents are insufficient rather than guessing; never invent data a \
tool could supply. A tool may return an error (e.g. unknown id) — recover and try another approach.
5. You are a thought partner, not a prescriber. Never advise starting, stopping, or changing treatment, dosing, \
or a diagnosis — even when asked directly. For a recommendation-shaped ask, reframe instead: what the record \
shows (cited), what the deterministic engines or named guidelines say (attribute the source in the same \
sentence, e.g. "per AAO screening guidelines"), and the questions worth weighing — the decision stays with the \
physician. Quoting a plan already documented in the record, or relaying an engine/guideline output WITH its \
attribution, is correct; originating your own clinical direction is not.`;
}

const NULLISH_WS = /\s+/g;

/** Verbatim re-verification (gate philosophy): the cited span must exist in OUR copy. */
export function verifyCitation(
    raw: Record<string, unknown>,
    documents: { id: string; title: string; text: string }[],
): ChatCitation | null {
    const citedText = raw['cited_text'];
    const index = raw['document_index'];
    if (typeof citedText !== 'string' || citedText.length === 0 || typeof index !== 'number') {
        return null;
    }
    const doc = documents[index];
    if (doc === undefined) {
        return null;
    }
    const start = typeof raw['start_char_index'] === 'number' ? raw['start_char_index'] : -1;
    const end = typeof raw['end_char_index'] === 'number' ? raw['end_char_index'] : -1;
    // Exact range first, then verbatim search (whitespace-normalized) as recovery.
    let verified = start >= 0 && end > start && doc.text.slice(start, end) === citedText;
    let resolvedStart = start;
    let resolvedEnd = end;
    if (!verified) {
        const at = doc.text.indexOf(citedText);
        if (at >= 0) {
            verified = true;
            resolvedStart = at;
            resolvedEnd = at + citedText.length;
        } else {
            verified =
                doc.text.replace(NULLISH_WS, ' ').includes(citedText.replace(NULLISH_WS, ' ').trim());
        }
    }
    return {
        document_id: doc.id,
        document_title: doc.title,
        cited_text: citedText,
        start_char: resolvedStart,
        end_char: resolvedEnd,
        verified,
    };
}

/**
 * Verify a tool's document-quoting excerpt against OUR stored copy (same gate philosophy as
 * verifyCitation, keyed by source_document_id instead of a document_index). A document-quoting
 * tool result becomes a citation only when its excerpt exists verbatim in the named document.
 */
export function verifyDocumentExcerpt(
    sourceDocumentId: string,
    excerpt: string,
    documents: { id: string; title: string; text: string }[],
): ChatCitation | null {
    if (excerpt.length === 0) {
        return null;
    }
    const doc = documents.find((candidate) => candidate.id === sourceDocumentId);
    if (doc === undefined) {
        return null;
    }
    const at = doc.text.indexOf(excerpt);
    if (at >= 0) {
        return {
            document_id: doc.id,
            document_title: doc.title,
            cited_text: excerpt,
            start_char: at,
            end_char: at + excerpt.length,
            verified: true,
        };
    }
    const verified = doc.text.replace(NULLISH_WS, ' ').includes(excerpt.replace(NULLISH_WS, ' ').trim());
    return { document_id: doc.id, document_title: doc.title, cited_text: excerpt, start_char: -1, end_char: -1, verified };
}

export class ChatService {
    private readonly toolByName: Map<string, RegisteredTool>;
    private readonly toolDefs: AnthropicTool[];

    constructor(
        private readonly client: AnthropicClient,
        private readonly store: ChatStore,
        private readonly spendGuard?: PrepSpendGuard,
        private readonly tools: readonly RegisteredTool[] = ALL_CHAT_TOOLS,
    ) {
        this.toolByName = new Map(this.tools.map((tool) => [tool.name, tool]));
        this.toolDefs = this.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputJsonSchema,
        }));
    }

    async turn(input: ChatTurnInput, logger: PrepLogger, hooks?: ChatTurnHooks): Promise<ChatTurnResult> {
        const { bundle, conversationId, message, correlationId } = input;
        const patientId = bundle.patient.id;
        const documents = citableDocuments(bundle);
        const history = await this.store.getChatMessages(patientId, conversationId, 20);

        // Documents ride ONLY the latest user turn (history stays plain text) — the model
        // always has the full record in context without compounding it per turn.
        const latestContent: AnthropicContentBlock[] = [
            ...documents.map((doc) => ({
                type: 'document',
                source: { type: 'text', media_type: 'text/plain', data: doc.text },
                title: doc.title,
                citations: { enabled: true },
            })),
            { type: 'text', text: message },
        ];
        const messages: AnthropicMessage[] = [
            ...history.map((turn) => ({ role: turn.role, content: turn.content })),
            { role: 'user' as const, content: latestContent },
        ];

        const citations: ChatCitation[] = [];
        const toolsUsed: string[] = [];
        // Native Citations-API citations stream across every round (document blocks stay in context).
        const completeHooks = {
            ...(hooks?.onTextDelta === undefined ? {} : { onTextDelta: hooks.onTextDelta }),
            onCitation: (raw: Record<string, unknown>) => {
                const mapped = verifyCitation(raw, documents);
                if (mapped !== null) {
                    citations.push(mapped);
                    hooks?.onCitation?.(mapped);
                }
            },
        };

        let reply = '';
        // Tool-use loop: offer tools for up to MAX_TOOL_ROUNDS rounds; the final round runs
        // WITHOUT tools to force an answer. The instant common case (no tool needed) breaks
        // after round 0 with a single call — identical shape to the pre-loop one-shot.
        for (let round = 0; ; round++) {
            const offerTools = round < MAX_TOOL_ROUNDS;
            const completion = await this.client.complete(
                buildChatSystemPrompt(bundle),
                messages,
                correlationId,
                completeHooks,
                offerTools ? this.toolDefs : undefined,
            );
            reply += completion.text;
            logger.info(
                {
                    correlationId,
                    conversationId,
                    round,
                    model: completion.model,
                    input_tokens: completion.usage.input_tokens,
                    output_tokens: completion.usage.output_tokens,
                    stop_reason: completion.stop_reason,
                    tool_uses: completion.tool_uses.length,
                },
                'chat llm call complete',
            );
            await this.spendGuard?.recordCall({
                model: completion.model,
                inputTokens: completion.usage.input_tokens,
                outputTokens: completion.usage.output_tokens,
                correlationId,
                purpose: 'chat_turn',
            });

            // Forced-final round, or the model produced a final answer: stop looping.
            if (!offerTools || completion.stop_reason !== 'tool_use' || completion.tool_uses.length === 0) {
                break;
            }

            // Append the assistant's turn (its text + tool_use blocks) verbatim — the API
            // requires the tool_use blocks to precede their tool_result blocks.
            const assistantBlocks: AnthropicContentBlock[] = [];
            if (completion.text.length > 0) {
                assistantBlocks.push({ type: 'text', text: completion.text });
            }
            for (const call of completion.tool_uses) {
                assistantBlocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
            }
            messages.push({ role: 'assistant', content: assistantBlocks });

            // Execute each requested tool and answer with tool_result blocks.
            const resultBlocks: AnthropicContentBlock[] = [];
            for (const call of completion.tool_uses) {
                hooks?.onToolUse?.({ name: call.name, input: call.input });
                const tool = this.toolByName.get(call.name);
                if (tool === undefined) {
                    resultBlocks.push({
                        type: 'tool_result',
                        tool_use_id: call.id,
                        is_error: true,
                        content: JSON.stringify({ error: `unknown tool "${call.name}"` }),
                    });
                    hooks?.onToolResult?.({ name: call.name, ok: false });
                    continue;
                }
                const invocation = tool.invoke(bundle, call.input);
                toolsUsed.push(call.name);
                // Attach any verifiable document-quoting provenance as citations.
                for (const provenance of invocation.provenance) {
                    const mapped = verifyDocumentExcerpt(provenance.source_document_id, provenance.excerpt, documents);
                    if (mapped !== null) {
                        citations.push(mapped);
                        hooks?.onCitation?.(mapped);
                    }
                }
                resultBlocks.push({
                    type: 'tool_result',
                    tool_use_id: call.id,
                    content: JSON.stringify(invocation.output),
                    ...(invocation.ok ? {} : { is_error: true }),
                });
                hooks?.onToolResult?.({ name: call.name, ok: invocation.ok });
            }
            messages.push({ role: 'user', content: resultBlocks });
        }

        // Persist AFTER a successful completion so a failed call leaves no half-turn.
        await this.store.saveChatMessage({
            patient_id: patientId,
            conversation_id: conversationId,
            role: 'user',
            content: message,
            correlation_id: correlationId,
        });
        await this.store.saveChatMessage({
            patient_id: patientId,
            conversation_id: conversationId,
            role: 'assistant',
            content: reply,
            correlation_id: correlationId,
        });

        const unverified = citations.filter((citation) => !citation.verified).length;
        if (unverified > 0) {
            // The chat verification metric: unverifiable spans are surfaced, never provenance.
            logger.warn({ correlationId, conversationId, unverified }, 'chat citations failed verbatim verification');
        }
        // Judgment metric (M3), same surfaced-never-silent philosophy as the citation gate:
        // directive advice without attribution is counted and logged, per docs/prompt-guide.md.
        const lint = lintPrescriptiveness(reply);
        if (lint.flags.length > 0) {
            logger.warn(
                {
                    correlationId,
                    conversationId,
                    prescriptive_flags: lint.flags.length,
                    rules: lint.flags.map((flag) => flag.rule),
                    excerpts: lint.flags.map((flag) => flag.excerpt),
                },
                'chat reply flagged by prescriptiveness lint',
            );
        }
        return {
            conversation_id: conversationId,
            reply,
            citations,
            unverified_count: unverified,
            tools_used: toolsUsed,
            prescriptive_flag_count: lint.flags.length,
        };
    }
}
