export function checkCitation(citation, resolve) {
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
    return { result: 'excerpt_mismatch' };
}
/**
 * Strict policy: a claim is verified only if it has at least one citation AND
 * every attached citation resolves. One dead citation blocks the whole claim —
 * partial provenance is not provenance.
 */
export function runCitationGate(claims, resolve) {
    let citationsChecked = 0;
    let citationsFailed = 0;
    const verdicts = claims.map((claim) => {
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
//# sourceMappingURL=citationGate.js.map