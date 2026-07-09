// get_full_document (TC1): fetch one source document's full text by id. Provenance is the
// document id itself; a leading, verbatim excerpt rides back so the citation gate can attach
// it. Unknown id (or a document with no readable text) degrades to a structured { error }.
import { z } from 'zod';
import { defineTool, type ToolProvenance } from './types.js';

const InputSchema = z.object({ document_id: z.string().min(1) });
type Input = z.infer<typeof InputSchema>;

const SuccessSchema = z.object({
    document_id: z.string(),
    document_type: z.string(),
    document_date: z.string().nullable(),
    text_content: z.string(),
    source_document_id: z.string(),
});
export const getFullDocumentOutputSchema = z.union([SuccessSchema, z.object({ error: z.string() })]);
type Output = z.infer<typeof getFullDocumentOutputSchema>;

// The citation excerpt is a leading slice, not the whole document — a representative,
// verifiable chip. The full text still rides in the tool output for the model to read.
const EXCERPT_CHARS = 240;

export const getFullDocument = defineTool<Input, Output>({
    name: 'get_full_document',
    description:
        "Fetch the full text of one source document in THIS patient's record by its document id. " +
        'Use when a referenced or cited document must be read in full.',
    inputSchema: InputSchema,
    outputSchema: getFullDocumentOutputSchema,
    inputJsonSchema: {
        type: 'object',
        properties: { document_id: { type: 'string', description: 'The source document id to fetch.' } },
        required: ['document_id'],
        additionalProperties: false,
    },
    run(bundle, input) {
        const doc = bundle.documents.find((candidate) => candidate.id === input.document_id);
        if (doc === undefined) {
            return { error: `no document with id "${input.document_id}" in this patient's record` };
        }
        const text = doc.content['text_content'];
        if (typeof text !== 'string' || text.length === 0) {
            return { error: `document "${input.document_id}" has no readable text content` };
        }
        return {
            document_id: doc.id,
            document_type: doc.document_type,
            document_date: doc.document_date,
            text_content: text,
            source_document_id: doc.id,
        };
    },
    provenance(output): ToolProvenance[] {
        if ('error' in output) {
            return [];
        }
        return [{ source_document_id: output.source_document_id, excerpt: output.text_content.slice(0, EXCERPT_CHARS) }];
    },
});

// (committed member of the chat tool registry — re-sync marker for the build context)
