// LLM fact extraction (S1.7, reworked after the live 64K-thinking spiral): map-reduce.
// One bounded call PER DOCUMENT (output is structurally limited by one document's
// content), then one contradiction pass over compact fact summaries — never the full
// corpus in a single mega-call. Offsets are best-effort by contract: the citation gate
// verifies excerpt_text verbatim and corrects ranges, so the model never needs to count
// characters (the counting demand is what sent the reasoning budget into a death spiral).
// Each call gets ONE validation retry (errors fed back) and ONE fresh retry for
// transient failures or truncation; truncation never retries with feedback because the
// failure is structural, not correctable.
import { z } from 'zod';
import {
    FACT_TYPES,
    PatientFactSchema,
    RuntimeContradictionSchema,
    type PatientFact,
    type RuntimeContradiction,
} from '../schemas/index.js';
import { isTransientAnthropicError, type AnthropicClient, type AnthropicMessage } from './anthropic.js';

// pino-compatible structural logger (FastifyBaseLogger satisfies it).
export interface PrepLogger {
    info(obj: Record<string, unknown>, msg?: string): void;
    warn(obj: Record<string, unknown>, msg?: string): void;
    error(obj: Record<string, unknown>, msg?: string): void;
}

export interface ExtractionDocument {
    id: string;
    document_type: string;
    document_date: string;
    text: string;
}

export interface ExtractionInput {
    patientId: string;
    patientName: string | null;
    documents: ExtractionDocument[];
}

export interface ExtractionResult {
    facts: PatientFact[];
    contradictions: RuntimeContradiction[];
}

/** Spend-guardrail + tracing hook: invoked for EVERY Anthropic call, retries included. */
export type OnUsage = (usage: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    attempt: number;
    label: string;
    startedAt: Date;
    endedAt: Date;
}) => Promise<void> | void;

/** Per-document progress hook — the pipeline stamps it onto the prep_run row. */
export type OnDocProgress = (progress: { done: number; total: number; docId: string }) => Promise<void> | void;

export class ExtractionError extends Error {
    constructor(
        public readonly label: string,
        public readonly attempts: number,
        public readonly issues: string[],
    ) {
        super(`extraction failed after ${attempts} attempt(s) [${label}]: ${issues.join('; ')}`);
        this.name = 'ExtractionError';
    }
}

const DocResponseSchema = z.object({
    facts: z.array(PatientFactSchema),
});

const ContradictionResponseSchema = z.object({
    contradictions: z.array(RuntimeContradictionSchema).default([]),
});

// Shared contract fragments (verification rules per ARCHITECTURE.md §4).
const CITATION_CONTRACT = `Each citation object:
{"id": "<unique id>", "fact_id": "<owning fact id>", "source_label": "<human label>",
 "source_type": "intake_transcript"|"provider_note"|"pharmacy_record"|"imaging_report"|"lab_report"|"prior_visit_note"|"referral_letter"|"patient_self_report"|"clinical_observation"|"external_ehr_import"|"scribe_transcript",
 "excerpt_text": "<VERBATIM excerpt — character-for-character exact, including punctuation and casing>",
 "excerpt_location": {"type": "character_range", "start_char": <int>, "end_char": <int>},
 "attribution": {"speaker_role": "patient"|"family_member"|"physician"|"nurse"|"technician"|"pharmacist"|"external_provider"|"system", "speaker_name"?, "confidence"?},
 "source_document_id": "<document id>", "document_date": "<document date>"}

start_char/end_char: a rough estimate is fine — verification matches excerpt_text verbatim \
against the document and corrects the range. Do NOT spend effort counting characters; the \
excerpt text itself must be exact, the offsets need not be. Omit context_before and \
context_after entirely.`;

// The per-document deep-reader prompt: facts ONLY, from ONE document.
export const EXTRACTION_SYSTEM_PROMPT = `You are the preparation deep-reader for a clinical co-pilot. You are given ONE source \
document from a patient's record. Extract the typed clinical facts this document supports.

Hard rules — these are non-negotiable:
1. Only assert what THIS document supports. Never infer from outside medical knowledge, never guess, never fill gaps. \
Missing information is absence, not an estimate.
2. Every fact must carry at least one citation whose excerpt_text quotes this document VERBATIM \
(character-for-character, including punctuation and casing).
3. Be economical: extract the clinically meaningful facts, do not restate the same fact multiple ways, and reply with \
MINIFIED single-line JSON (no pretty-printing, no prose, no markdown fences).

Output contract — a single JSON object and nothing else:
{"facts": [...]}

Each fact object:
{"id": "<unique id>", "patient_id": "<the patient id given>", "fact_type": <one of ${JSON.stringify([...FACT_TYPES])}>,
 "content": <shape depends on fact_type>, "is_current": true|false, "source_document_id": "<this document's id>",
 "sources": [<citation>...], "verification": {"status": "unverified"}, "laterality": "OD"|"OS"|"OU"|null}

Content shapes by fact_type:
- medication: {"name", "generic_name"?, "dose"?, "frequency"?, "route"?, "start_date"?, "end_date"?, "prescriber"?, "indication"?, "risk_flags"?: []}
- allergy: {"substance", "reaction"?, "severity"?, "verified"?, "source"?}
- condition: {"name", "icd10"?, "status"?: "active"|"controlled"|"resolved", "since"?, "severity"?}
- clinical_finding: {"finding", "body_part"?, "laterality"?, "severity"?, "source"?}
- imaging_finding: {"finding_type", "severity"?, "confidence"?, "measurements"?, "laterality"?, "source_image_id"?}
- procedure_history: {"procedure", "cpt"?, "laterality"?, "date"?, "performed_by"?, "notes"?}
- vital_sign: {"name": "IOP"|"VA"|"CRT"|"BP"|"HR", "value", "units"?, "laterality"?, "captured_at"?}
- social_history: {"category", "value", "notes"?}
- family_history: {"relative", "condition", "age_at_diagnosis"?, "outcome"?}
- patient_goal: {"goal", "specific_concerns"?: [], "verbatim_quotes"?: [], "emotional_state"?}
- chief_complaint: {"statement", "onset"?, "onset_context"?, "laterality"?, "progression"?, "pertinent_negatives"?: []}

${CITATION_CONTRACT}`;

// The contradiction detector: runs ONCE over compact summaries of every extracted fact.
export const CONTRADICTION_SYSTEM_PROMPT = `You are the contradiction detector for a clinical co-pilot. You are given compact \
summaries of typed facts extracted from a patient's source documents (fact type, content, source document, date, and the \
cited verbatim excerpt). Find the places where sources DISAGREE.

Hard rules:
1. Contradictions are surfaced, never resolved. Report both claims — do not pick a winner and do not average.
2. Only report disagreements the given facts actually support (dosage discrepancies, conflicting dates, conflicting \
laterality, patient-report vs record, temporal impossibilities). No outside knowledge.
3. Reply with MINIFIED single-line JSON (no prose, no markdown fences).

Output contract — a single JSON object and nothing else:
{"contradictions": [...]}

Each contradiction object:
{"id": "<unique id>", "patient_id": "<the patient id given>", "status": "active",
 "severity": "critical"|"high"|"medium"|"low", "type": "<e.g. temporal_discrepancy>", "description": "<what disagrees>",
 "suggested_question": "<question for the patient>"|null,
 "source_a": {"type": "<source kind>", "value": "<claim>", "document_id": "<doc id>", "excerpt": "<verbatim text>"}|null,
 "source_b": {...same shape...}|null}`;

function buildDocContent(input: ExtractionInput, doc: ExtractionDocument): string {
    return `Patient id: ${input.patientId}\nPatient name: ${input.patientName ?? 'unknown'}\n\n--- document id: ${doc.id} | type: ${doc.document_type} | date: ${doc.document_date} ---\nBEGIN TEXT\n${doc.text}\nEND TEXT`;
}

// Compact one-line-per-fact summary — the contradiction pass never re-reads full documents.
function buildContradictionContent(input: ExtractionInput, facts: PatientFact[]): string {
    const lines = facts.map((fact) => {
        const excerpt = fact.sources[0]?.excerpt_text ?? '';
        return `- id=${fact.id} type=${fact.fact_type} doc=${fact.source_document_id} content=${JSON.stringify(fact.content)} excerpt=${JSON.stringify(excerpt)}`;
    });
    return `Patient id: ${input.patientId}\nPatient name: ${input.patientName ?? 'unknown'}\n\nExtracted facts follow, one per line.\n\n${lines.join('\n')}`;
}

// Models occasionally fence JSON despite instructions; recover the object body.
function stripFences(text: string): string {
    const trimmed = text.trim();
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
    return fenced?.[1] ?? trimmed;
}

type Validation<T> = { ok: true; result: T } | { ok: false; issues: string[] };

// Models emit explicit nulls for unknown optional fields despite instructions (live
// failure: "severity": null on six facts failed the whole prep run — .optional()
// accepts absence, not null). Absent and null mean the same thing at this boundary,
// so drop null-valued keys before validation; the contracts stay strict and a null
// never reaches the store. Required-but-nulled fields still fail as 'Required'.
function stripNullsDeep(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(stripNullsDeep);
    }
    if (typeof value === 'object' && value !== null) {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .filter(([, entry]) => entry !== null)
                .map(([key, entry]) => [key, stripNullsDeep(entry)]),
        );
    }
    return value;
}

function parseAndCheck<T>(text: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Validation<T> {
    let parsed: unknown;
    try {
        parsed = stripNullsDeep(JSON.parse(stripFences(text)));
    } catch (error) {
        return { ok: false, issues: [`response is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`] };
    }
    const checked = schema.safeParse(parsed);
    if (!checked.success) {
        return {
            ok: false,
            issues: checked.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
        };
    }
    return { ok: true, result: checked.data };
}

// Cross-patient guard: an extracted item may never claim a different patient.
function strayPatients(items: { id: string; patient_id: string }[], patientId: string, kind: string): string[] {
    return items
        .filter((item) => item.patient_id !== patientId)
        .map((item) => `${kind} id=${item.id}: patient_id must be '${patientId}'`);
}

export class FactExtractor {
    constructor(private readonly client: AnthropicClient) {}

    async extract(
        input: ExtractionInput,
        correlationId: string,
        logger: PrepLogger,
        onUsage?: OnUsage,
        onDocProgress?: OnDocProgress,
    ): Promise<ExtractionResult> {
        const facts: PatientFact[] = [];
        const total = input.documents.length;
        let done = 0;
        for (const doc of input.documents) {
            const response = await this.jsonCall(
                EXTRACTION_SYSTEM_PROMPT,
                buildDocContent(input, doc),
                doc.id,
                (text) => {
                    const parsed = parseAndCheck(text, DocResponseSchema);
                    if (!parsed.ok) {
                        return parsed;
                    }
                    const strays = strayPatients(parsed.result.facts, input.patientId, 'facts');
                    return strays.length > 0 ? { ok: false, issues: strays } : parsed;
                },
                correlationId,
                logger,
                onUsage,
            );
            facts.push(...response.facts);
            done += 1;
            await onDocProgress?.({ done, total, docId: doc.id });
        }

        // Contradictions need at least two claims to disagree.
        if (facts.length < 2) {
            return { facts, contradictions: [] };
        }
        const contradictionResponse = await this.jsonCall(
            CONTRADICTION_SYSTEM_PROMPT,
            buildContradictionContent(input, facts),
            'contradictions',
            (text) => {
                const parsed = parseAndCheck(text, ContradictionResponseSchema);
                if (!parsed.ok) {
                    return parsed;
                }
                const strays = strayPatients(parsed.result.contradictions, input.patientId, 'contradictions');
                return strays.length > 0 ? { ok: false, issues: strays } : parsed;
            },
            correlationId,
            logger,
            onUsage,
        );
        return { facts, contradictions: contradictionResponse.contradictions };
    }

    // One schema-validated JSON call: 1 feedback retry for validation failures, 1 fresh
    // retry for transient failures OR truncation (feedback cannot fix a structural cap hit).
    private async jsonCall<T>(
        system: string,
        userContent: string,
        label: string,
        validate: (text: string) => Validation<T>,
        correlationId: string,
        logger: PrepLogger,
        onUsage?: OnUsage,
    ): Promise<T> {
        const messages: AnthropicMessage[] = [{ role: 'user', content: userContent }];
        let lastIssues: string[] = [];
        let freshRetries = 0;
        let attempt = 1;

        while (attempt <= 2) {
            const startedAt = new Date();
            let completion;
            try {
                // Streaming heartbeat: a long call logs progress every ~15s, so a silent
                // Railway log means hung (and the client's idle timeout will kill it), not slow.
                completion = await this.client.complete(system, messages, correlationId, {
                    onProgress: (progress) =>
                        logger.info(
                            { correlationId, label, attempt, text_chars: progress.textChars, elapsed_ms: progress.elapsedMs },
                            'extraction stream in progress',
                        ),
                });
            } catch (error) {
                if (isTransientAnthropicError(error) && freshRetries < 1) {
                    freshRetries += 1;
                    logger.warn({ correlationId, label, attempt, err: String(error) }, 'transient llm failure, retrying');
                    continue;
                }
                throw error;
            }
            // Token usage feeds the cost ledger + trace — always logged with the correlation ID.
            logger.info(
                {
                    correlationId,
                    label,
                    attempt,
                    model: completion.model,
                    input_tokens: completion.usage.input_tokens,
                    output_tokens: completion.usage.output_tokens,
                },
                'extraction llm call complete',
            );
            await onUsage?.({
                model: completion.model,
                inputTokens: completion.usage.input_tokens,
                outputTokens: completion.usage.output_tokens,
                attempt,
                label,
                startedAt,
                endedAt: new Date(),
            });
            // Truncation is structural — feeding a cut-off response back cannot fix it.
            // One FRESH retry, then give up on this call.
            if (completion.stop_reason === 'max_tokens') {
                lastIssues = ["response ended with stop_reason 'max_tokens' instead of end_turn"];
                logger.warn({ correlationId, label, attempt }, 'extraction response truncated at output ceiling');
                if (freshRetries < 1) {
                    freshRetries += 1;
                    continue;
                }
                break;
            }
            if (completion.stop_reason !== null && completion.stop_reason !== 'end_turn') {
                lastIssues = [`response ended with stop_reason '${completion.stop_reason}' instead of end_turn`];
                break;
            }
            const validation = validate(completion.text);
            if (validation.ok) {
                return validation.result;
            }
            lastIssues = validation.issues;
            logger.warn({ correlationId, label, attempt, issues: validation.issues }, 'extraction response failed validation');
            // Retry ONCE with the validation errors appended to the conversation.
            messages.push(
                { role: 'assistant', content: completion.text },
                {
                    role: 'user',
                    content: `Your JSON response failed validation with these errors:\n${lastIssues
                        .map((issue) => `- ${issue}`)
                        .join('\n')}\nReply again with a single corrected JSON object only.`,
                },
            );
            attempt += 1;
        }
        throw new ExtractionError(label, 2, lastIssues);
    }
}
