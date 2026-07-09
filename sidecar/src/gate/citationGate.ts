// Deterministic citation gate (ARCHITECTURE.md §4): sits between generation and
// display; every claim must carry citations that resolve to real stored source
// text, or the claim is blocked (callers rewrite blocked claims as absence).
// Code, not a model — an unsourced claim cannot render, by construction.
import type { CitationRef } from '../schemas/index.js';

export type CitationCheck =
    | { result: 'ok_range' }
    | { result: 'ok_search'; correctedRange: { start_char: number; end_char: number } }
    | { result: 'missing_document' }
    | { result: 'excerpt_mismatch' };

export interface Claim {
    /** Opaque identifier the caller uses to match verdicts back to content. */
    id: string;
    citations: CitationRef[];
}

export interface ClaimVerdict {
    id: string;
    status: 'verified' | 'blocked';
    /** Populated when blocked: which rule fired. */
    reason?: 'unsourced' | 'citation_failed';
    citations: { citation: CitationRef; check: CitationCheck }[];
}

export interface GateResult {
    verdicts: ClaimVerdict[];
    metrics: {
        claims: number;
        verified: number;
        blocked: number;
        citationsChecked: number;
        citationsFailed: number;
    };
}

/** Resolves a source document's full text by id; return undefined if unknown. */
export type DocumentTextResolver = (sourceDocumentId: string) => string | undefined;

export function checkCitation(citation: CitationRef, resolve: DocumentTextResolver): CitationCheck {
    if (citation.source_document_id === null) {
        return { result: 'missing_document' };
    }
    const text = resolve(citation.source_document_id);
    if (text === undefined) {
        return { result: 'missing_document' };
    }
    const excerpt = citation.excerpt_text;
    if (typeof excerpt !== 'string' || excerpt.length === 0) {
        // A citation without quotable text is not verifiable provenance.
        return { result: 'excerpt_mismatch' };
    }
    const location = citation.excerpt_location;
    if (location !== null && text.slice(location.start_char, location.end_char) === excerpt) {
        return { result: 'ok_range' };
    }
    // Range drift (e.g. document re-import) is tolerable only if the excerpt
    // still exists verbatim — provenance holds, offsets get corrected.
    const at = text.indexOf(excerpt);
    if (at >= 0) {
        return { result: 'ok_search', correctedRange: { start_char: at, end_char: at + excerpt.length } };
    }
    // Whitespace-flexible fallback (live finding: the corpus carries 138 OCR-style
    // double-space runs; models collapse them when quoting, so 5-6 citations per
    // prep died on invisible spacing). Every non-whitespace character must still
    // occur, in order — only whitespace RUNS are treated as equivalent, so this
    // admits no paraphrase. The corrected range comes from the actual match.
    const flexible = whitespaceFlexibleFind(text, excerpt);
    if (flexible !== null) {
        return { result: 'ok_search', correctedRange: flexible };
    }
    return { result: 'excerpt_mismatch' };
}

/** Locate `excerpt` in `text` treating any whitespace run as equivalent; null if absent. */
function whitespaceFlexibleFind(text: string, excerpt: string): { start_char: number; end_char: number } | null {
    const tokens = excerpt.split(/\s+/).filter((token) => token.length > 0);
    if (tokens.length === 0) {
        return null;
    }
    const pattern = tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    const match = new RegExp(pattern).exec(text);
    if (match === null) {
        return null;
    }
    return { start_char: match.index, end_char: match.index + match[0].length };
}

/**
 * Strict policy: a claim is verified only if it has at least one citation AND
 * every attached citation resolves. One dead citation blocks the whole claim —
 * partial provenance is not provenance.
 */
export function runCitationGate(claims: Claim[], resolve: DocumentTextResolver): GateResult {
    let citationsChecked = 0;
    let citationsFailed = 0;

    const verdicts: ClaimVerdict[] = claims.map((claim) => {
        if (claim.citations.length === 0) {
            return { id: claim.id, status: 'blocked', reason: 'unsourced', citations: [] };
        }
        const checks = claim.citations.map((citation) => {
            citationsChecked += 1;
            const check = checkCitation(citation, resolve);
            if (check.result === 'missing_document' || check.result === 'excerpt_mismatch') {
                citationsFailed += 1;
            }
            return { citation, check };
        });
        const allOk = checks.every((c) => c.check.result === 'ok_range' || c.check.result === 'ok_search');
        if (allOk) {
            return { id: claim.id, status: 'verified', citations: checks };
        }
        return { id: claim.id, status: 'blocked', reason: 'citation_failed', citations: checks };
    });

    const verified = verdicts.filter((v) => v.status === 'verified').length;
    return {
        verdicts,
        metrics: {
            claims: claims.length,
            verified,
            blocked: claims.length - verified,
            citationsChecked,
            citationsFailed,
        },
    };
}
