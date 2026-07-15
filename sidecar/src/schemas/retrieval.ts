// Retrieval contracts (H.11, REQ G1, S2/R3): the retriever's query/response shapes and
// the PHI-boundary query-construction shapes. This module is the SINGLE home of the
// evidence-snippet contract — src/graph/contracts.ts imports EvidenceSnippetSchema from
// here (no second hand-kept mirror) — and the runtime types in src/retrieval/ are
// inferred (z.infer). Runtime parses sit at real boundaries only: search() options at
// entry and the graph's parseEvidencePayload; results stay construction-typed on the
// hot path (double-parsing it buys nothing).
import { z } from 'zod';

// Worker-output contract for the evidence retriever: what the critic composes from.
// `.strict()` so a drifted retriever payload (extra/missing fields) is a contract
// failure, not a silent pass-through.
export const EvidenceSnippetSchema = z
    .object({
        chunk_id: z.string().min(1),
        doc_id: z.string().min(1),
        section_title: z.string(),
        /** Verbatim chunk body — the quotable, gate-verifiable evidence text. */
        quote: z.string().min(1),
        /** Context-prefixed text (doc title › section) — what was indexed. */
        text: z.string().min(1),
        score: z.number(),
        guideline_source: z.string().min(1),
        version: z.string().min(1),
        disease_tags: z.array(z.string()).readonly(),
        rerank_applied: z.boolean(),
    })
    .strict();

export const RetrievalResultSchema = z
    .object({
        snippets: z.array(EvidenceSnippetSchema),
        /** The PHI-scrubbed query that was actually searched (log-safe by construction). */
        searched_query: z.string(),
        rerank_applied: z.boolean(),
        /** True when nothing cleared the confidence floor — callers must say so, not improvise. */
        empty: z.boolean(),
    })
    .strict();

export const QueryContextSchema = z
    .object({
        /** Clinical concepts to emphasize (drug names, findings) — never identifiers. */
        concepts: z.array(z.string()).readonly().optional(),
        diseaseTags: z.array(z.string()).readonly().optional(),
        laterality: z.enum(['OD', 'OS', 'OU']).optional(),
    })
    .strict();

export const PatientIdentifiersSchema = z
    .object({
        /** Full name(s) as known to the chart; split into parts and stripped case-insensitively. */
        names: z.array(z.string()).readonly().optional(),
        /** ISO or as-written DOB strings. */
        dobs: z.array(z.string()).readonly().optional(),
        mrns: z.array(z.string()).readonly().optional(),
        phones: z.array(z.string()).readonly().optional(),
        addresses: z.array(z.string()).readonly().optional(),
    })
    .strict();

// Options for HybridRetriever.search() — parsed at entry (multiple caller classes:
// routes, graph, scripts, evals).
export const SearchOptionsSchema = z
    .object({
        topK: z.number().int().min(1).optional(),
        context: QueryContextSchema.optional(),
        identifiers: PatientIdentifiersSchema.optional(),
        correlationId: z.string().min(1).optional(),
    })
    .strict();

export const BuiltQuerySchema = z
    .object({
        /** The PHI-scrubbed, concept-augmented text that may leave the boundary. */
        query: z.string(),
        /** Metadata filters applied index-side (E5 contextual retrieval). */
        filters: z
            .object({
                diseaseTags: z.array(z.string()).readonly().optional(),
            })
            .strict(),
    })
    .strict();
