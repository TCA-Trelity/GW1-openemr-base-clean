// Supervisor↔worker contracts (Wave C.1, REQ S3/R4, G1/G7). The graph's entry payload
// and every worker's output payload are Zod-validated at the boundary — a malformed ask
// or a rogue worker result fails LOUDLY with a typed error naming the interface, never
// propagates half-shaped state to the next node (parse, don't validate).
import { z } from 'zod';
import { EvidenceSnippetSchema } from '../schemas/retrieval.js';

/** Raised when a graph boundary payload fails its contract. Names the interface. */
export class GraphContractError extends Error {
    constructor(
        public readonly boundary: 'graph_entry' | 'evidence_retriever' | 'graph_tool',
        public readonly issues: string[],
    ) {
        super(`graph contract violation at ${boundary}: ${issues.join('; ')}`);
        this.name = 'GraphContractError';
    }
}

// Shared upload shape: the entry contract composes it below, and the attach_and_extract
// graph tool (tools.ts, H.9) reuses it as its input boundary — one schema, two seams.
export const GraphUploadSchema = z
    .object({
        docType: z.enum(['lab_pdf', 'intake_form']),
        filename: z.string().min(1),
        mimeType: z.string().min(1),
        bytes: z.instanceof(Uint8Array).refine((bytes) => bytes.byteLength > 0, 'upload bytes must be non-empty'),
    })
    .strict();

// Entry contract: a chat turn carries a question; an upload carries a document. The
// discriminated union makes the illegal states (upload without bytes, chat turn without
// a question) unrepresentable at the boundary instead of guarded per-node.
export const GraphAskSchema = z.discriminatedUnion('kind', [
    z
        .object({
            kind: z.literal('chat_turn'),
            patientId: z.string().min(1),
            question: z.string().min(1).max(2000),
            concepts: z.array(z.string().min(1)).max(8).optional(),
        })
        .strict(),
    z
        .object({
            kind: z.literal('document_upload'),
            patientId: z.string().min(1),
            upload: GraphUploadSchema,
            concepts: z.array(z.string().min(1)).max(8).optional(),
        })
        .strict(),
]);
export type ParsedGraphAsk = z.infer<typeof GraphAskSchema>;

// Worker-output contract for the evidence retriever (what the critic composes from):
// EvidenceSnippetSchema, imported above from its single home in src/schemas/retrieval.ts
// (H.11) — the graph boundary and the retriever's own types infer from the SAME
// contract, so a second hand-kept mirror can never drift.

export function parseGraphAsk(input: unknown): ParsedGraphAsk {
    const parsed = GraphAskSchema.safeParse(input);
    if (!parsed.success) {
        throw new GraphContractError(
            'graph_entry',
            parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
        );
    }
    return parsed.data;
}

export function parseEvidencePayload(input: unknown): z.infer<typeof EvidenceSnippetSchema>[] {
    const parsed = z.array(EvidenceSnippetSchema).safeParse(input);
    if (!parsed.success) {
        throw new GraphContractError(
            'evidence_retriever',
            parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
        );
    }
    return parsed.data;
}
