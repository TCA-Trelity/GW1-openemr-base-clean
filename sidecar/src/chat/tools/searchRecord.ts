// search_record (TC1): case-insensitive keyword match across the patient's facts (content)
// and source documents (text_content). Document matches return a verbatim, contiguous snippet
// plus its source_document_id, so the citation gate can attach them as provenance; fact
// matches carry their source_document_id but no citation excerpt (the snippet is drawn from
// the fact's JSON, not verbatim document prose). A blank query -> { error }.
import { z } from 'zod';
import type { FactBundle } from '../../store/index.js';
import { defineTool, type ToolProvenance } from './types.js';

const InputSchema = z.object({ query: z.string().min(1) });
type Input = z.infer<typeof InputSchema>;

const MatchSchema = z.object({
    kind: z.enum(['fact', 'document']),
    source_document_id: z.string(),
    fact_id: z.string().optional(),
    snippet: z.string(),
});

const SuccessSchema = z.object({
    query: z.string(),
    match_count: z.number().int(),
    matches: z.array(MatchSchema),
    derived: z.literal(false),
});
export const searchRecordOutputSchema = z.union([SuccessSchema, z.object({ error: z.string() })]);
type Output = z.infer<typeof searchRecordOutputSchema>;

const MAX_MATCHES = 12;
const SNIPPET_BEFORE = 40;
const SNIPPET_AFTER = 90;

// A contiguous verbatim slice of `text` around the first case-insensitive hit of `query`.
function snippetAround(text: string, query: string): string {
    const at = text.toLowerCase().indexOf(query.toLowerCase());
    if (at < 0) {
        return '';
    }
    const start = Math.max(0, at - SNIPPET_BEFORE);
    const end = Math.min(text.length, at + query.length + SNIPPET_AFTER);
    return text.slice(start, end);
}

export const searchRecord = defineTool<Input, Output>({
    name: 'search_record',
    description:
        "Keyword-search THIS patient's facts and source documents (case-insensitive) and return matching snippets " +
        'with their source document ids. Use to locate where something is mentioned across the record.',
    inputSchema: InputSchema,
    outputSchema: searchRecordOutputSchema,
    inputJsonSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Keyword or phrase to search for.' } },
        required: ['query'],
        additionalProperties: false,
    },
    run(bundle, input) {
        const query = input.query.trim();
        if (query === '') {
            return { error: 'search query is empty' };
        }
        const needle = query.toLowerCase();
        const collected: { kind: 'fact' | 'document'; source_document_id: string; fact_id?: string; snippet: string }[] = [];

        for (const fact of bundle.facts) {
            if (collected.length >= MAX_MATCHES) {
                break;
            }
            const serialized = JSON.stringify(fact.content);
            if (serialized.toLowerCase().includes(needle)) {
                collected.push({
                    kind: 'fact',
                    source_document_id: fact.source_document_id,
                    fact_id: fact.id,
                    snippet: snippetAround(serialized, query),
                });
            }
        }

        for (const doc of bundle.documents) {
            if (collected.length >= MAX_MATCHES) {
                break;
            }
            const text = doc.content['text_content'];
            if (typeof text === 'string' && text.toLowerCase().includes(needle)) {
                collected.push({ kind: 'document', source_document_id: doc.id, snippet: snippetAround(text, query) });
            }
        }

        return { query, match_count: collected.length, matches: collected, derived: false };
    },
    provenance(output): ToolProvenance[] {
        if ('error' in output) {
            return [];
        }
        // Only document matches carry a verbatim excerpt the citation gate can verify.
        return output.matches
            .filter((match) => match.kind === 'document' && match.snippet.length > 0)
            .map((match) => ({ source_document_id: match.source_document_id, excerpt: match.snippet }));
    },
});
