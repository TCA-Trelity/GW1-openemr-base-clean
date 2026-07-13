// Chat citation verification — the chat half of the gate layer (ARCHITECTURE.md §4).
// Every citation the model emits — native Citations-API spans and document-quoting tool
// excerpts alike — is re-verified VERBATIM against our stored copy of the document before
// it may count as provenance. These are the deterministic checks; the withhold-on-failure
// policy that keeps unverified citations off the wire lives in responseGate.ts.
// (The prep-path equivalent, which blocks unsourced facts before the brief is assembled,
// is citationGate.ts.)

/** A citation mapped to OUR document ids and re-verified against stored text. */
export interface ChatCitation {
    document_id: string;
    document_title: string;
    cited_text: string;
    start_char: number;
    end_char: number;
    verified: boolean;
}

const NULLISH_WS = /\s+/g;

/** Verbatim re-verification (gate philosophy): the cited span must exist in OUR copy. */
export function verifyCitation(
    raw: Record<string, unknown>,
    documents: { id: string; title: string; text: string }[],
): ChatCitation | null {
    const citedText = raw['cited_text'];
    const index = raw['document_index'];
    if (typeof citedText !== 'string' || citedText.length === 0 || typeof index !== 'number') {
        return null;
    }
    const doc = documents[index];
    if (doc === undefined) {
        return null;
    }
    const start = typeof raw['start_char_index'] === 'number' ? raw['start_char_index'] : -1;
    const end = typeof raw['end_char_index'] === 'number' ? raw['end_char_index'] : -1;
    // Exact range first, then verbatim search (whitespace-normalized) as recovery.
    let verified = start >= 0 && end > start && doc.text.slice(start, end) === citedText;
    let resolvedStart = start;
    let resolvedEnd = end;
    if (!verified) {
        const at = doc.text.indexOf(citedText);
        if (at >= 0) {
            verified = true;
            resolvedStart = at;
            resolvedEnd = at + citedText.length;
        } else {
            verified =
                doc.text.replace(NULLISH_WS, ' ').includes(citedText.replace(NULLISH_WS, ' ').trim());
        }
    }
    return {
        document_id: doc.id,
        document_title: doc.title,
        cited_text: citedText,
        start_char: resolvedStart,
        end_char: resolvedEnd,
        verified,
    };
}

/**
 * Verify a tool's document-quoting excerpt against OUR stored copy (same gate philosophy as
 * verifyCitation, keyed by source_document_id instead of a document_index). A document-quoting
 * tool result becomes a citation only when its excerpt exists verbatim in the named document.
 */
export function verifyDocumentExcerpt(
    sourceDocumentId: string,
    excerpt: string,
    documents: { id: string; title: string; text: string }[],
): ChatCitation | null {
    if (excerpt.length === 0) {
        return null;
    }
    const doc = documents.find((candidate) => candidate.id === sourceDocumentId);
    if (doc === undefined) {
        return null;
    }
    const at = doc.text.indexOf(excerpt);
    if (at >= 0) {
        return {
            document_id: doc.id,
            document_title: doc.title,
            cited_text: excerpt,
            start_char: at,
            end_char: at + excerpt.length,
            verified: true,
        };
    }
    const verified = doc.text.replace(NULLISH_WS, ' ').includes(excerpt.replace(NULLISH_WS, ' ').trim());
    return { document_id: doc.id, document_title: doc.title, cited_text: excerpt, start_char: -1, end_char: -1, verified };
}
