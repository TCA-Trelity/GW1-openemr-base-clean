// Deterministic geometric grounding (Wave A.5, REQ R5/P2 — W2_ARCHITECTURE.md §3 step 6).
// The VLM proposes quotes; THIS code disposes. Every extraction citation is re-located in
// the document's own word geometry:
//   word_box   — the quote's token sequence found contiguously → bbox = union of word boxes
//   page       — tokens present on a page (text-layer contains-match) but not contiguously
//                locatable → page-region citation, still click-to-source
//   unverified — not found anywhere → the field renders visible-but-uncitable; the gate
//                blocks it from claims because its quote resolves to no stored text
// No model output is trusted for geometry: the model's own page hint is only a starting
// point (checked first, then every other page), and its bbox suggestions are ignored.
import type { z } from 'zod';
import type { ExtractionCitation, ExtractionResult } from '../schemas/extraction.js';
import { GroundingSummarySchema } from '../schemas/ingestion.js';
import type { PdfPageWords, PdfWords } from './pdf.js';

/** Per-document grounding tallies. Contract-first (H.11, REQ G1): the shape lives in
 *  src/schemas/ingestion.ts (embedded in the ingestion record); the type is inferred so
 *  importers keep this module as its home. */
export type GroundingSummary = z.infer<typeof GroundingSummarySchema>;

/** Per-field grounding outcome (G5 `extraction_field_outcome`). Labels are positional
 *  (`results[2]`, `allergies[0]`) — never extracted strings, so the event is PHI-free
 *  by construction and safe for the log stream. */
export interface GroundedFieldOutcome {
    field: string;
    outcome: 'word_box' | 'page' | 'unverified';
}

export interface GroundedExtraction {
    extraction: ExtractionResult;
    summary: GroundingSummary;
    fields: readonly GroundedFieldOutcome[];
}

const normalizeToken = (token: string): string => token.toLowerCase().replace(/[^a-z0-9%./]/g, '');

function tokensOf(text: string): string[] {
    return text
        .split(/\s+/)
        .map(normalizeToken)
        .filter((token) => token.length > 0);
}

interface Located {
    grounding: 'word_box' | 'page';
    page: number;
    bbox: { x: number; y: number; w: number; h: number } | null;
}

function locateOnPage(quoteTokens: readonly string[], page: PdfPageWords): Located | null {
    const pageTokens = page.words.map((word) => normalizeToken(word.text));
    // Contiguous token-sequence match → tight bbox from the matched words.
    outer: for (let start = 0; start + quoteTokens.length <= pageTokens.length; start += 1) {
        for (let offset = 0; offset < quoteTokens.length; offset += 1) {
            if (pageTokens[start + offset] !== quoteTokens[offset]) {
                continue outer;
            }
        }
        const matched = page.words.slice(start, start + quoteTokens.length);
        const x1 = Math.min(...matched.map((word) => word.x));
        const y1 = Math.min(...matched.map((word) => word.y));
        const x2 = Math.max(...matched.map((word) => word.x + word.w));
        const y2 = Math.max(...matched.map((word) => word.y + word.h));
        return { grounding: 'word_box', page: page.page, bbox: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } };
    }
    // Non-contiguous fallback: every token present on the page (order-insensitive) —
    // wrapped table cells and hyphenation break contiguity without breaking presence.
    const pageTokenSet = new Set(pageTokens);
    if (quoteTokens.length > 0 && quoteTokens.every((token) => pageTokenSet.has(token))) {
        return { grounding: 'page', page: page.page, bbox: null };
    }
    return null;
}

export function groundCitation(citation: ExtractionCitation, pdf: PdfWords): ExtractionCitation {
    const quoteTokens = tokensOf(citation.quote);
    if (quoteTokens.length === 0) {
        return { ...citation, bbox: null, grounding: 'unverified' };
    }
    // Model's page hint first, then the rest — the hint accelerates, never decides.
    const hinted = pdf.pages.find((page) => page.page === citation.page);
    const ordered = hinted === undefined ? pdf.pages : [hinted, ...pdf.pages.filter((page) => page !== hinted)];
    for (const page of ordered) {
        const located = locateOnPage(quoteTokens, page);
        if (located !== null) {
            return { ...citation, page: located.page, bbox: located.bbox, grounding: located.grounding };
        }
    }
    return { ...citation, bbox: null, grounding: 'unverified' };
}

/** Ground every citation in an extraction result; returns the rewritten result + summary. */
export function groundExtraction(extraction: ExtractionResult, pdf: PdfWords): GroundedExtraction {
    const counts = { word_box: 0, page: 0, unverified: 0 };
    const fields: GroundedFieldOutcome[] = [];
    const ground = (field: string, citation: ExtractionCitation): ExtractionCitation => {
        const grounded = groundCitation(citation, pdf);
        counts[grounded.grounding] += 1;
        fields.push({ field, outcome: grounded.grounding });
        return grounded;
    };
    const groundNullable = (field: string, citation: ExtractionCitation | null): ExtractionCitation | null =>
        citation === null ? null : ground(field, citation);

    let rewritten: ExtractionResult;
    if (extraction.doc_type === 'lab_pdf') {
        rewritten = {
            ...extraction,
            document_patient:
                extraction.document_patient === null
                    ? null
                    : { ...extraction.document_patient, citation: groundNullable('document_patient', extraction.document_patient.citation) },
            collection_date_citation: groundNullable('collection_date', extraction.collection_date_citation),
            results: extraction.results.map((result, index) => ({ ...result, citation: ground(`results[${index}]`, result.citation) })),
        };
    } else {
        rewritten = {
            ...extraction,
            demographics: { ...extraction.demographics, citation: groundNullable('demographics', extraction.demographics.citation) },
            chief_concern: { ...extraction.chief_concern, citation: groundNullable('chief_concern', extraction.chief_concern.citation) },
            current_medications: extraction.current_medications.map((med, index) => ({ ...med, citation: ground(`current_medications[${index}]`, med.citation) })),
            allergies: extraction.allergies.map((allergy, index) => ({ ...allergy, citation: ground(`allergies[${index}]`, allergy.citation) })),
            family_history: extraction.family_history.map((entry, index) => ({ ...entry, citation: ground(`family_history[${index}]`, entry.citation) })),
            patient_goals: { ...extraction.patient_goals, citation: groundNullable('patient_goals', extraction.patient_goals.citation) },
            vitals:
                extraction.vitals === null
                    ? null
                    : { ...extraction.vitals, citation: groundNullable('vitals', extraction.vitals.citation) },
        };
    }
    const total = counts.word_box + counts.page + counts.unverified;
    return {
        extraction: rewritten,
        summary: {
            total,
            ...counts,
            confidence: total === 0 ? 0 : (counts.word_box + counts.page) / total,
        },
        fields,
    };
}
