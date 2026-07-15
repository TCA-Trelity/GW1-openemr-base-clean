// LLM fact extraction (S1.7, reworked after the live 64K-thinking spiral): map-reduce.
// One bounded call PER DOCUMENT (output is structurally limited by one document's
// content), then one contradiction pass over compact fact summaries — never the full
// corpus in a single mega-call. Offsets are best-effort by contract: the citation gate
// verifies excerpt_text verbatim and corrects ranges, so the model never needs to count
// characters (the counting demand is what sent the reasoning budget into a death spiral).
// Each call gets ONE validation retry (errors fed back) and ONE fresh retry for
// transient failures or truncation; truncation never retries with feedback because the
// failure is structural, not correctable.
//
// H.4c (live finding, 2026-07-15 — the prep sibling of the composer's H.4b): the
// deployed extraction model INTERMITTENTLY paraphrases/reformats its excerpt quotes
// (one run blocked all five medication facts on citation_failed; the rerun 26 minutes
// later verified 147/147), so the deliberately-verbatim citation gate rewrote the
// brief's med facts as absence — safe but lossy. Validation now runs the gate's own
// excerpt verification (checkCitation: exact range -> indexOf -> whitespace-run-flexible
// search) over every fact citation whose document is in scope, so a paraphrase earns the
// SAME single feedback retry that already fixes empty excerpts, instead of dying
// downstream. Same retry budget, same post-retry ExtractionError, src/gate untouched.
import { z } from 'zod';
import { checkCitation, type DocumentTextResolver } from '../gate/citationGate.js';
import {
    FACT_TYPES,
    PatientFactSchema,
    RuntimeContradictionSchema,
    type CitationRef,
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

// `issues` are MODEL-facing: the feedback retry may quote document excerpts back at the
// model (that is the repair mechanism — model-side only). `loggedIssues`, when present,
// is the PHI-redacted parallel (ids/paths/counts, never document text) that goes to the
// structured log and into the thrown ExtractionError; absent means `issues` is already
// safe to log (every pre-H.4c issue kind).
export type Validation<T> = { ok: true; result: T } | { ok: false; issues: string[]; loggedIssues?: string[] };

// Models emit explicit nulls for unknown optional fields despite instructions (live
// failure: "severity": null on six facts failed the whole prep run — .optional()
// accepts absence, not null). Absent and null mean the same thing at this boundary,
// so drop null-valued keys before validation; the contracts stay strict and a null
// never reaches the store. Required-but-nulled fields still fail as 'Required'.
export function stripNullsDeep(value: unknown): unknown {
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

// Provenance guard: every extracted fact must carry a RESOLVABLE citation — a non-empty
// verbatim excerpt plus its character range. Absent/null excerpts are not tolerated the
// way descriptive optionals are (stripNullsDeep): letting them through only moves the
// failure to the citation gate, which then has to block the fact (live regression: 5
// blocked claims per prep once null-stripping relaxed the retry pressure). Failing HERE
// feeds the issue back through the retry, which reliably makes the model quote the source.
//
// H.4c extends the same guard to verbatim-ness: a non-empty excerpt is verified against
// its cited document with the gate's OWN checkCitation (reused, never re-implemented, so
// this pre-check can never drift from what the pipeline gate later enforces — the H.4b
// parity-by-construction move). A paraphrased-but-non-empty excerpt used to sail through
// here and die at the gate as a silently blocked fact. Citations whose document id does
// not resolve are left alone: there is no text to verify against, and missing_document
// stays the pipeline gate's verdict exactly as today.
//
// Returns parallel arrays: `issues` for the model feedback (verbatim failures quote the
// offending excerpt — that is the repair mechanism), `loggedIssues` the PHI-redacted
// twins for logs and thrown errors (ids/paths only, never document text).
function weakCitations(
    facts: { id: string; sources: CitationRef[] }[],
    resolve: DocumentTextResolver,
): { issues: string[]; loggedIssues: string[] } {
    const issues: string[] = [];
    const loggedIssues: string[] = [];
    const push = (issue: string, logged: string = issue): void => {
        issues.push(issue);
        loggedIssues.push(logged);
    };
    facts.forEach((fact, factIndex) => {
        if (fact.sources.length === 0) {
            push(`facts.${factIndex} (id=${fact.id}): at least one source citation is required`);
            return;
        }
        fact.sources.forEach((source, sourceIndex) => {
            if (typeof source.excerpt_text !== 'string' || source.excerpt_text.length === 0) {
                push(`facts.${factIndex}.sources.${sourceIndex}.excerpt_text: the exact verbatim quote from the document is required`);
            } else if (checkCitation(source, resolve).result === 'excerpt_mismatch') {
                push(
                    `facts.${factIndex}.sources.${sourceIndex}.excerpt_text: ${JSON.stringify(source.excerpt_text)} is not a verbatim substring of document ${JSON.stringify(source.source_document_id)} — copy the quote character-for-character from that document`,
                    `facts.${factIndex}.sources.${sourceIndex}.excerpt_text: excerpt is not a verbatim substring of document ${JSON.stringify(source.source_document_id)}`,
                );
            }
            if (source.excerpt_location === null || source.excerpt_location === undefined) {
                push(`facts.${factIndex}.sources.${sourceIndex}.excerpt_location: start_char/end_char of the quote is required`);
            }
        });
    });
    return { issues, loggedIssues };
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
        // The same document-id -> text resolution the pipeline's citation gate builds
        // (pipeline.ts citation_gate stage) — the pre-check verifies against the exact
        // set of texts the gate will, wherever the cited id is in scope.
        const textById = new Map(input.documents.map((doc) => [doc.id, doc.text]));
        const resolve: DocumentTextResolver = (id) => textById.get(id);
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
                    const weak = weakCitations(parsed.result.facts, resolve);
                    const issues = [...strays, ...weak.issues];
                    if (issues.length === 0) {
                        return parsed;
                    }
                    return { ok: false, issues, loggedIssues: [...strays, ...weak.loggedIssues] };
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

    private async jsonCall<T>(
        system: string,
        userContent: string,
        label: string,
        validate: (text: string) => Validation<T>,
        correlationId: string,
        logger: PrepLogger,
        onUsage?: OnUsage,
    ): Promise<T> {
        return schemaValidatedJsonCall(this.client, system, userContent, label, validate, correlationId, logger, onUsage);
    }
}

// One schema-validated JSON call: 1 feedback retry for validation failures, 1 fresh
// retry for transient failures OR truncation (feedback cannot fix a structural cap hit).
// Module-level so other single-call composers (prep/gamePlan.ts) reuse the exact retry
// discipline instead of growing their own.
export async function schemaValidatedJsonCall<T>(
    client: AnthropicClient,
    system: string,
    userContent: string,
    label: string,
    validate: (text: string) => Validation<T>,
    correlationId: string,
    logger: PrepLogger,
    onUsage?: OnUsage,
): Promise<T> {
    {
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
                completion = await client.complete(system, messages, correlationId, {
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
            // PHI split (H.4c): the log and the thrown ExtractionError carry the redacted
            // issues (ids/paths, never document text); only the model feedback below gets
            // the full issues, which may quote excerpts to demand verbatim correction.
            lastIssues = validation.loggedIssues ?? validation.issues;
            logger.warn({ correlationId, label, attempt, issues: lastIssues }, 'extraction response failed validation');
            // Retry ONCE with the validation errors appended to the conversation.
            messages.push(
                { role: 'assistant', content: completion.text },
                {
                    role: 'user',
                    content: `Your JSON response failed validation with these errors:\n${validation.issues
                        .map((issue) => `- ${issue}`)
                        .join('\n')}\nReply again with a single corrected JSON object only.`,
                },
            );
            attempt += 1;
        }
        throw new ExtractionError(label, 2, lastIssues);
    }
}
