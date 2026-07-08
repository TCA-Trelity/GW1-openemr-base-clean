// Eval: contradiction-ground-truth (S2.5). Margaret Chen's corpus authors 4 rich
// contradictions, each citing the exact source excerpts that disagree. For a detector
// (rule-based or LLM) to ever surface these, the cited excerpts must actually exist
// verbatim in their referenced documents — the detectability precondition. This eval
// proves that precondition holds for 4/4 contradictions and publishes the count.
// (test/gate.test.ts locks the same invariant for regressions; this eval reports the
// corpus-level acceptance number for the results doc.)
import { describe, it } from 'vitest';
import { recordEval } from './collector.js';
import { margaretChen } from './corpus.js';

describe('contradiction-ground-truth', () => {
    it("every excerpt cited by Margaret Chen's 4 authored contradictions exists verbatim in its document", () => {
        const contradictions = margaretChen.raw.contradictions ?? [];
        let excerptsChecked = 0;
        let excerptsFound = 0;
        let detectableContradictions = 0;
        const failures: string[] = [];

        for (const contradiction of contradictions) {
            let allFound = true;
            for (const source of contradiction.source_documents) {
                excerptsChecked += 1;
                // Resolve by document id (the runtime key), falling back to filename
                // (the key the rich contradiction shape schematizes).
                const text =
                    (source.source_document_id !== undefined
                        ? margaretChen.resolveDocumentText(source.source_document_id)
                        : undefined) ?? margaretChen.documentTextByFilename.get(source.filename);
                if (text !== undefined && text.includes(source.exact_text)) {
                    excerptsFound += 1;
                } else {
                    allFound = false;
                    failures.push(`${contradiction.contradiction_id}: "${source.exact_text}" not in ${source.filename}`);
                }
            }
            if (allFound && contradiction.source_documents.length >= 1) {
                detectableContradictions += 1;
            }
        }

        recordEval({
            id: 'contradiction-ground-truth.margaret-chen',
            description:
                'Every source excerpt cited by the 4 authored contradictions exists verbatim in its referenced document (detectability precondition)',
            metric: 'detectable contradictions / verbatim excerpts',
            value: `${detectableContradictions}/${contradictions.length} contradictions detectable; ${excerptsFound}/${excerptsChecked} cited excerpts verbatim${failures.length > 0 ? `; failures: ${failures.join(' | ')}` : ''}`,
            threshold: '4/4 contradictions; all cited excerpts verbatim',
            pass:
                contradictions.length === 4 &&
                detectableContradictions === 4 &&
                excerptsChecked > 0 &&
                excerptsFound === excerptsChecked,
            notes:
                'Two of the four authored contradictions (medication_compliance_gap, symptom_progression) cite a single source document — the second "side" of the disagreement is the visit-date context or the patient\'s in-visit report, not another document. For those, the precondition checked is that the one cited excerpt is verbatim; the two multi-document contradictions have every conflicting excerpt checked pairwise-verbatim (4 and 3 sources respectively).',
        });
    });
});
