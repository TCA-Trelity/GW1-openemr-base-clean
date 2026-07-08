// Chat over the stored record (S2.3, reworked R4/R5): source documents are passed as
// Citations-API document blocks, so every claim carries a native citation with the exact
// quoted span — no token contract for the model to fumble. Each cited span is re-verified
// verbatim against the stored document server-side (gate philosophy: unverifiable
// citations are reported, never rendered as provenance). Brevity is a hard prompt
// contract: physicians read replies in seconds.
import type { AnthropicClient, AnthropicContentBlock } from '../prep/anthropic.js';
import type { PrepLogger } from '../prep/extraction.js';
import type { PrepSpendGuard } from '../prep/pipeline.js';
import type { FactBundle } from '../store/index.js';

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
}

export interface ChatTurnHooks {
    onTextDelta?: (text: string) => void;
    /** Fired per citation as it streams, already mapped + verified. */
    onCitation?: (citation: ChatCitation) => void;
}

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

// Brevity is the contract (R4): physicians have seconds, not minutes.
export function buildChatSystemPrompt(bundle: FactBundle): string {
    return `You are the chat surface of a clinical co-pilot, answering a physician's questions about ONE patient \
(${bundle.patient.name}, id ${bundle.patient.id}) immediately before the visit.

Hard rules — non-negotiable:
1. Answer ONLY from the attached source documents. If they do not contain the answer, say "Not in the record." — \
never estimate, never use outside medical knowledge to fill gaps.
2. BE BRIEF. Default to at most 3 short bullets or 2 sentences (under ~50 words total). Expand only when the \
physician explicitly asks for more detail. No preamble, no restating the question, no closing offers.
3. Ground every clinical claim in the documents so it carries a citation. When documents disagree, surface the \
conflict in one line — do not pick a winner.`;
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

export class ChatService {
    constructor(
        private readonly client: AnthropicClient,
        private readonly store: ChatStore,
        private readonly spendGuard?: PrepSpendGuard,
    ) {}

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
        const messages = [
            ...history.map((turn) => ({ role: turn.role, content: turn.content })),
            { role: 'user' as const, content: latestContent },
        ];

        const citations: ChatCitation[] = [];
        const completion = await this.client.complete(buildChatSystemPrompt(bundle), messages, correlationId, {
            ...(hooks?.onTextDelta === undefined ? {} : { onTextDelta: hooks.onTextDelta }),
            onCitation: (raw) => {
                const mapped = verifyCitation(raw, documents);
                if (mapped !== null) {
                    citations.push(mapped);
                    hooks?.onCitation?.(mapped);
                }
            },
        });
        logger.info(
            {
                correlationId,
                conversationId,
                model: completion.model,
                input_tokens: completion.usage.input_tokens,
                output_tokens: completion.usage.output_tokens,
                citations: citations.length,
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
            content: completion.text,
            correlation_id: correlationId,
        });

        const unverified = citations.filter((citation) => !citation.verified).length;
        if (unverified > 0) {
            // The chat verification metric: unverifiable spans are surfaced, never provenance.
            logger.warn({ correlationId, conversationId, unverified }, 'chat citations failed verbatim verification');
        }
        return { conversation_id: conversationId, reply: completion.text, citations, unverified_count: unverified };
    }
}
