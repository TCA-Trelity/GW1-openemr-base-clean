// PHI-free query construction (Wave B.5, REQ S2/R3 PHI boundary, G18, pitfall P5).
// The corpus is public text; the ONLY patient-adjacent data that could reach Cohere is
// the query. This module makes "queries are PHI-free" a property of code, not of prompt
// hope: identifiers are stripped deterministically BEFORE any egress, and the CI canary
// eval (no_phi_in_logs family) asserts a planted identifier can never survive scrubbing.
//
// Two layers:
//   1. scrubQuery — strips the launch patient's known identifiers (name parts, DOB, MRN,
//      phone, address tokens) plus generic patterns (dates, MRN-shaped tokens, phones).
//   2. rewriteQuery — composes the retrieval query from clinical CONCEPTS (drug, dose
//      band, disease tags, laterality, interval math), which is both the privacy control
//      and the E5 contextual-retrieval improvement: concept queries retrieve better than
//      prose questions.
import type { z } from 'zod';
import { BuiltQuerySchema, PatientIdentifiersSchema, QueryContextSchema } from '../schemas/retrieval.js';

// Contract-first (H.11, REQ G1): these shapes live in src/schemas/retrieval.ts; the
// runtime types are inferred so every importer keeps this module as its home. They are
// parsed at the retriever's search() boundary (as part of SearchOptionsSchema) — never
// re-validated downstream.
export type PatientIdentifiers = z.infer<typeof PatientIdentifiersSchema>;

const GENERIC_PATTERNS: RegExp[] = [
    /\b\d{4}-\d{2}-\d{2}\b/g, // ISO dates
    /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, // US dates
    /\b(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/g, // phone numbers
    /\b[A-Z]{2,4}-\d{4}-\d{3,6}\b/g, // MRN-shaped tokens (e.g. FPA-2019-4521)
    /\b\d{3}-\d{2}-\d{4}\b/g, // SSN-shaped
];

const REDACTION = ' ';

export function scrubQuery(raw: string, identifiers: PatientIdentifiers = {}): string {
    let scrubbed = raw;
    const literals: string[] = [
        ...(identifiers.dobs ?? []),
        ...(identifiers.mrns ?? []),
        ...(identifiers.phones ?? []),
        ...(identifiers.addresses ?? []),
    ];
    // Name parts ≥3 chars strip individually ("Margaret", "Chen"); short particles stay
    // (stripping "L" would eat laterality tokens like "L eye" — initials carry no identity alone).
    for (const name of identifiers.names ?? []) {
        for (const part of name.split(/\s+/)) {
            if (part.length >= 3) {
                literals.push(part);
            }
        }
    }
    for (const literal of literals) {
        if (literal.trim() === '') {
            continue;
        }
        const escaped = literal.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        scrubbed = scrubbed.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), REDACTION);
    }
    for (const pattern of GENERIC_PATTERNS) {
        scrubbed = scrubbed.replace(pattern, REDACTION);
    }
    return scrubbed.replace(/\s+/g, ' ').trim();
}

export type QueryContext = z.infer<typeof QueryContextSchema>;

export type BuiltQuery = z.infer<typeof BuiltQuerySchema>;

export function rewriteQuery(raw: string, context: QueryContext = {}, identifiers: PatientIdentifiers = {}): BuiltQuery {
    const scrubbed = scrubQuery(raw, identifiers);
    const conceptSuffix = [...(context.concepts ?? []), ...(context.diseaseTags ?? [])]
        .filter((concept) => concept.trim() !== '')
        .join(' ');
    const query = conceptSuffix === '' ? scrubbed : `${scrubbed} ${conceptSuffix}`.trim();
    const filters: BuiltQuery['filters'] = {};
    if (context.diseaseTags !== undefined && context.diseaseTags.length > 0) {
        filters.diseaseTags = context.diseaseTags;
    }
    return { query, filters };
}
