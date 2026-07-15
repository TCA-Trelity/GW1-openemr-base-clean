// Async graph tools (H.9, REQ S1/R1). The chat tool surface (src/chat/tools/) is
// deliberately synchronous, read-only, and never-throwing — ingestion is none of those,
// so it gets a distinct first-class contract here: named + schema'd like a chat tool so
// a graph node (or a future supervisor model) can invoke it by name, but async,
// write-capable, and LOUD on failure. These tools must never join ALL_CHAT_TOOLS
// (pinned by test): a failed ingestion has to fail the graph run, not degrade into a
// model-readable { error }.
import { z } from 'zod';
import type { IngestionRecord, IngestionService } from '../ingest/service.js';
import { GraphContractError, GraphUploadSchema } from './contracts.js';

/** Per-invocation context the invoking graph node threads through to the tool. */
export interface GraphToolContext {
    correlationId: string;
}

/**
 * Async, write-capable graph tool: named + schema'd like chat tools, but it THROWS on
 * failure (graph nodes need loud failures, not model-readable errors) and is never
 * registered on the sync read-only chat surface.
 */
export interface AsyncGraphTool<TInput, TOutput> {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>;
    /** JSON Schema mirror for advertising the tool to a model (future supervisor use). */
    readonly inputJsonSchema: Record<string, unknown>;
    run(rawInput: unknown, ctx: GraphToolContext): Promise<TOutput>;
}

// Tool-boundary contract: the graph-entry upload shape (contracts.ts) composed under the
// spec's snake_case parameter name — parse at the boundary, don't re-validate downstream.
export const AttachAndExtractInputSchema = z
    .object({ patient_id: z.string().min(1), upload: GraphUploadSchema })
    .strict();
export type AttachAndExtractToolInput = z.infer<typeof AttachAndExtractInputSchema>;

/** Wrap `IngestionService.attachAndExtract` as the spec-named `attach_and_extract` tool. */
export function attachAndExtractTool(
    service: IngestionService,
): AsyncGraphTool<AttachAndExtractToolInput, IngestionRecord> {
    return {
        name: 'attach_and_extract',
        description:
            "The spec's attach_and_extract(patient_id, file_path, doc_type): attach a document to this " +
            'patient and run prep-time extraction over it. File content arrives as {filename, mimeType, bytes} ' +
            'in place of file_path — uploads are multipart bytes by design (a server-side path read would be ' +
            'a security hole). Async and write-capable: never part of the synchronous read-only chat tool list.',
        inputSchema: AttachAndExtractInputSchema,
        inputJsonSchema: {
            type: 'object',
            properties: {
                patient_id: { type: 'string', minLength: 1, description: 'The sidecar patient id to attach the document to.' },
                upload: {
                    type: 'object',
                    properties: {
                        docType: { type: 'string', enum: ['lab_pdf', 'intake_form'], description: 'Document type registry key.' },
                        filename: { type: 'string', minLength: 1 },
                        mimeType: { type: 'string', minLength: 1 },
                        bytes: { description: 'Raw file content as non-empty binary bytes (Uint8Array) — the file_path replacement.' },
                    },
                    required: ['docType', 'filename', 'mimeType', 'bytes'],
                    additionalProperties: false,
                },
            },
            required: ['patient_id', 'upload'],
            additionalProperties: false,
        },
        async run(rawInput: unknown, ctx: GraphToolContext): Promise<IngestionRecord> {
            const parsed = AttachAndExtractInputSchema.safeParse(rawInput);
            if (!parsed.success) {
                throw new GraphContractError(
                    'graph_tool',
                    parsed.error.issues.map((issue) => {
                        const path = issue.path.join('.');
                        return `attach_and_extract${path === '' ? '' : `.${path}`}: ${issue.message}`;
                    }),
                );
            }
            // Failures stay loud by design: a failed_* IngestionRecord still RESOLVES as
            // data; only contract violations and service throws propagate as exceptions.
            return service.attachAndExtract({
                patientId: parsed.data.patient_id,
                ...parsed.data.upload,
                correlationId: ctx.correlationId,
            });
        },
    };
}
