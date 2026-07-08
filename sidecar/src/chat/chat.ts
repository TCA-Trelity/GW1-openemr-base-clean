// Chat over the stored fact bundle (S2.3): Haiku answers ONLY from stored facts, and
// every clinical claim must carry an inline [[fact:<id>]] token that the panel parses
// back into citation chips. Token validation against the bundle happens server-side —
// an invented id is reported, never rendered as provenance.
import type { AnthropicClient } from '../prep/anthropic.js';
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

export interface ChatTurnInput {
    bundle: FactBundle;
    conversationId: string;
    message: string;
    correlationId: string;
}

export interface ChatTurnResult {
    conversation_id: string;
    reply: string;
    cited_fact_ids: string[];
    invalid_citation_ids: string[];
}

const CITATION_TOKEN = /\[\[fact:([A-Za-z0-9._-]+)\]\]/g;

/** Compact, id-addressable serialization of the record — the model's ONLY world. */
export function buildChatSystemPrompt(bundle: FactBundle): string {
    const factLines = bundle.facts.map((fact) => {
        const source = fact.sources[0] as { excerpt_text?: string | null } | undefined;
        const excerpt = typeof source?.excerpt_text === 'string' ? source.excerpt_text : '';
        return `- [${fact.id}] (${fact.fact_type}${fact.is_current ? '' : ', historical'}) ${JSON.stringify(fact.content)} — doc ${fact.source_document_id}${excerpt ? ` excerpt ${JSON.stringify(excerpt)}` : ''}`;
    });
    const contradictionLines = bundle.contradictions.map(
        (item) => `- [${item.id}] severity=${item.severity} ${JSON.stringify(item.payload)}`,
    );
    const imagingLines = bundle.images.map((image) => {
        const meta = image.image_metadata;
        return `- [${image.id}] ${meta.modality} ${meta.laterality} captured ${meta.capture_date}${image['ai_analysis'] ? ` analysis ${JSON.stringify(image['ai_analysis'])}` : ''}`;
    });
    const treatmentLines = bundle.treatments.map(
        (treatment) => `- [${treatment.id}] ${treatment.treatment_date} ${JSON.stringify(treatment.payload)}`,
    );

    return `You are the chat surface of a clinical co-pilot, answering a physician's questions about ONE patient \
(${bundle.patient.name}, id ${bundle.patient.id}) immediately before the visit.

Hard rules — non-negotiable:
1. Answer ONLY from the patient record below. If the record does not contain the answer, say so plainly \
("not in the record") — never estimate, never use outside medical knowledge to fill gaps.
2. CITATIONS: after every clinical claim, append the token [[fact:<id>]] using the exact bracketed id of the \
supporting fact from the record (e.g. [[fact:med-001]]). Multiple supporting facts → multiple tokens. Never invent \
an id, never cite an id not present below. Statements without a supporting fact must be framed as absence, not fact.
3. When facts CONTRADICT each other, surface the contradiction — do not pick a winner.
4. Be concise and clinical: short paragraphs or tight bullets, no preamble, no restating the question.

PATIENT RECORD
Facts:
${factLines.join('\n') || '(none)'}

Known contradictions (already surfaced to the physician):
${contradictionLines.join('\n') || '(none)'}

Imaging records:
${imagingLines.join('\n') || '(none)'}

Treatments/events:
${treatmentLines.join('\n') || '(none)'}`;
}

/** Splits cited ids into known-vs-invented against the bundle's fact ids. */
export function parseCitations(reply: string, bundle: FactBundle): { valid: string[]; invalid: string[] } {
    const known = new Set(bundle.facts.map((fact) => fact.id));
    const valid = new Set<string>();
    const invalid = new Set<string>();
    for (const match of reply.matchAll(CITATION_TOKEN)) {
        (known.has(match[1]!) ? valid : invalid).add(match[1]!);
    }
    return { valid: [...valid], invalid: [...invalid] };
}

export class ChatService {
    constructor(
        private readonly client: AnthropicClient,
        private readonly store: ChatStore,
        private readonly spendGuard?: PrepSpendGuard,
    ) {}

    async turn(input: ChatTurnInput, logger: PrepLogger, onTextDelta?: (text: string) => void): Promise<ChatTurnResult> {
        const { bundle, conversationId, message, correlationId } = input;
        const patientId = bundle.patient.id;
        const history = await this.store.getChatMessages(patientId, conversationId, 20);
        const messages = [
            ...history.map((turn) => ({ role: turn.role, content: turn.content })),
            { role: 'user' as const, content: message },
        ];

        const completion = await this.client.complete(
            buildChatSystemPrompt(bundle),
            messages,
            correlationId,
            onTextDelta === undefined ? undefined : { onTextDelta },
        );
        logger.info(
            {
                correlationId,
                conversationId,
                model: completion.model,
                input_tokens: completion.usage.input_tokens,
                output_tokens: completion.usage.output_tokens,
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

        const { valid, invalid } = parseCitations(completion.text, bundle);
        if (invalid.length > 0) {
            // The verification metric for chat: invented citations are surfaced, never rendered.
            logger.warn({ correlationId, conversationId, invalid }, 'chat reply cited unknown fact ids');
        }
        return { conversation_id: conversationId, reply: completion.text, cited_fact_ids: valid, invalid_citation_ids: invalid };
    }
}
