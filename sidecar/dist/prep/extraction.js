// LLM fact extraction (S1.7): Sonnet-class deep read of the source documents into
// schema-validated PatientFacts + RuntimeContradictions, with ONE retry that feeds the
// validation errors back to the model. Second failure throws — the prep run records it.
import { z } from 'zod';
import { FACT_TYPES, PatientFactSchema, RuntimeContradictionSchema, } from '../schemas/index.js';
export class ExtractionError extends Error {
    attempts;
    issues;
    constructor(attempts, issues) {
        super(`extraction failed after ${attempts} attempt(s): ${issues.join('; ')}`);
        this.attempts = attempts;
        this.issues = issues;
        this.name = 'ExtractionError';
    }
}
const ExtractionResponseSchema = z.object({
    facts: z.array(PatientFactSchema),
    contradictions: z.array(RuntimeContradictionSchema).default([]),
});
// The deep-reader system prompt. The hard rules are the verification contract
// (ARCHITECTURE.md §4): assertion only with support, verbatim cited excerpts with
// character offsets, contradictions surfaced never resolved.
export const EXTRACTION_SYSTEM_PROMPT = `You are the preparation deep-reader for a clinical co-pilot. Before a physician \
walks into the room, you read the patient's full source record and extract typed clinical facts the physician can trust.

Hard rules — these are non-negotiable:
1. Only assert what the documents support. Never infer from outside medical knowledge, never guess, never fill gaps. \
Missing information is absence, not an estimate.
2. Every fact must carry at least one citation whose excerpt_text quotes the source document VERBATIM \
(character-for-character, including punctuation and casing), with excerpt_location.start_char/end_char giving the exact \
character offsets of that excerpt within the document text exactly as provided to you.
3. Contradictions between documents are surfaced, never resolved. When two sources disagree, report both claims as a \
contradiction with a suggested question for the patient — do not pick a winner and do not average.

Output contract — reply with a single JSON object and nothing else (no prose, no markdown fences):
{"facts": [...], "contradictions": [...]}

Each fact object:
{"id": "<unique id>", "patient_id": "<the patient id given>", "fact_type": <one of ${JSON.stringify([...FACT_TYPES])}>,
 "content": <shape depends on fact_type>, "is_current": true|false, "source_document_id": "<id of the primary document>",
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

Each citation object:
{"id": "<unique id>", "fact_id": "<owning fact id>", "source_label": "<human label>",
 "source_type": "intake_transcript"|"provider_note"|"pharmacy_record"|"imaging_report"|"lab_report"|"prior_visit_note"|"referral_letter"|"patient_self_report"|"clinical_observation"|"external_ehr_import"|"scribe_transcript",
 "excerpt_text": "<VERBATIM excerpt>", "excerpt_location": {"type": "character_range", "start_char": <int>, "end_char": <int>, "context_before": "<up to 60 chars before>", "context_after": "<up to 60 chars after>"},
 "attribution": {"speaker_role": "patient"|"family_member"|"physician"|"nurse"|"technician"|"pharmacist"|"external_provider"|"system", "speaker_name"?, "confidence"?},
 "source_document_id": "<document id>", "document_date": "<document date>"}

Each contradiction object:
{"id": "<unique id>", "patient_id": "<the patient id given>", "status": "active",
 "severity": "critical"|"high"|"medium"|"low", "type": "<e.g. temporal_discrepancy>", "description": "<what disagrees>",
 "suggested_question": "<question for the patient>"|null,
 "source_a": {"type": "<source kind>", "value": "<claim>", "document_id": "<doc id>", "excerpt": "<verbatim text>"}|null,
 "source_b": {...same shape...}|null}`;
function buildUserContent(input) {
    const header = `Patient id: ${input.patientId}\nPatient name: ${input.patientName ?? 'unknown'}\n\nSource documents follow. Character offsets in your citations must index into each document's text exactly as it appears between the BEGIN/END markers.`;
    const docs = input.documents.map((doc) => `--- document id: ${doc.id} | type: ${doc.document_type} | date: ${doc.document_date} ---\nBEGIN TEXT\n${doc.text}\nEND TEXT`);
    return [header, ...docs].join('\n\n');
}
// Models occasionally fence JSON despite instructions; recover the object body.
function stripFences(text) {
    const trimmed = text.trim();
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
    return fenced?.[1] ?? trimmed;
}
function validateResponse(text, patientId, stopReason) {
    if (stopReason !== null && stopReason !== 'end_turn') {
        return { ok: false, issues: [`response ended with stop_reason '${stopReason}' instead of end_turn`] };
    }
    let parsed;
    try {
        parsed = JSON.parse(stripFences(text));
    }
    catch (error) {
        return { ok: false, issues: [`response is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`] };
    }
    const checked = ExtractionResponseSchema.safeParse(parsed);
    if (!checked.success) {
        return {
            ok: false,
            issues: checked.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
        };
    }
    // Cross-patient guard: an extracted item may never claim a different patient.
    const strays = [
        ...checked.data.facts.filter((fact) => fact.patient_id !== patientId).map((fact) => `facts id=${fact.id}`),
        ...checked.data.contradictions
            .filter((item) => item.patient_id !== patientId)
            .map((item) => `contradictions id=${item.id}`),
    ];
    if (strays.length > 0) {
        return { ok: false, issues: strays.map((s) => `${s}: patient_id must be '${patientId}'`) };
    }
    return { ok: true, result: checked.data };
}
export class FactExtractor {
    client;
    constructor(client) {
        this.client = client;
    }
    async extract(input, correlationId, logger) {
        const messages = [{ role: 'user', content: buildUserContent(input) }];
        let lastIssues = [];
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            const completion = await this.client.complete(EXTRACTION_SYSTEM_PROMPT, messages, correlationId);
            // Token usage feeds the cost-tracking requirement — always logged with the correlation ID.
            logger.info({
                correlationId,
                attempt,
                model: completion.model,
                input_tokens: completion.usage.input_tokens,
                output_tokens: completion.usage.output_tokens,
            }, 'extraction llm call complete');
            const validation = validateResponse(completion.text, input.patientId, completion.stop_reason);
            if (validation.ok) {
                return validation.result;
            }
            lastIssues = validation.issues;
            logger.warn({ correlationId, attempt, issues: validation.issues }, 'extraction response failed validation');
            // Retry ONCE with the validation errors appended to the conversation.
            messages.push({ role: 'assistant', content: completion.text }, {
                role: 'user',
                content: `Your JSON response failed validation with these errors:\n${validation.issues
                    .map((issue) => `- ${issue}`)
                    .join('\n')}\nReply again with a single corrected JSON object only.`,
            });
        }
        throw new ExtractionError(2, lastIssues);
    }
}
//# sourceMappingURL=extraction.js.map