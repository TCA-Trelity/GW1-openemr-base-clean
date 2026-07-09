// get_open_questions (TC1): the patient's active contradictions plus the questions they
// suggest a physician ask. Derived from the stored contradiction records (which carry their
// own source excerpts internally), so no additional citation provenance. Takes no input; an
// empty active list is a valid, non-error result (count 0).
import { z } from 'zod';
import type { StoredContradiction } from '../../store/index.js';
import { defineTool, isRecord } from './types.js';

const InputSchema = z.object({});
type Input = z.infer<typeof InputSchema>;

const OpenQuestionSchema = z.object({
    contradiction_id: z.string(),
    severity: z.string(),
    summary: z.string(),
    suggested_questions: z.array(z.string()),
});

const SuccessSchema = z.object({
    count: z.number().int(),
    open_questions: z.array(OpenQuestionSchema),
    derived: z.literal(true),
});
export const getOpenQuestionsOutputSchema = SuccessSchema;
type Output = z.infer<typeof getOpenQuestionsOutputSchema>;

// Suggested questions live under different keys depending on whether the stored payload is
// the rich seed shape or the runtime-projected shape — collect from every known path.
function suggestedQuestionsOf(payload: Record<string, unknown>): string[] {
    const found: string[] = [];
    const list = payload['suggested_questions'];
    if (Array.isArray(list)) {
        found.push(...list.filter((item): item is string => typeof item === 'string'));
    }
    const single = payload['suggested_question'];
    if (typeof single === 'string' && single.length > 0) {
        found.push(single);
    }
    const workflow = payload['physician_workflow'];
    if (isRecord(workflow) && typeof workflow['auto_generate_question'] === 'string') {
        found.push(workflow['auto_generate_question']);
    }
    return [...new Set(found)];
}

function summaryOf(contradiction: StoredContradiction): string {
    const payload = contradiction.payload;
    for (const key of ['description', 'clinical_significance', 'type']) {
        const value = payload[key];
        if (typeof value === 'string' && value.length > 0) {
            return value;
        }
    }
    return contradiction.id;
}

export const getOpenQuestions = defineTool<Input, Output>({
    name: 'get_open_questions',
    description:
        "List THIS patient's active contradictions (unresolved discrepancies in the record) and the questions " +
        'they suggest asking the patient. Use to surface what still needs clarifying before the visit.',
    inputSchema: InputSchema,
    outputSchema: getOpenQuestionsOutputSchema,
    inputJsonSchema: { type: 'object', properties: {}, additionalProperties: false },
    run(bundle) {
        const openQuestions = bundle.contradictions
            .filter((contradiction) => contradiction.status === 'active')
            .map((contradiction) => ({
                contradiction_id: contradiction.id,
                severity: contradiction.severity,
                summary: summaryOf(contradiction),
                suggested_questions: suggestedQuestionsOf(contradiction.payload),
            }));
        return { count: openQuestions.length, open_questions: openQuestions, derived: true };
    },
});

// (committed member of the chat tool registry — re-sync marker for the build context)
