// Eval: citation-validity-100 (S2.5). Corpus-level acceptance check that EVERY authored
// fact's citations — across BOTH patient corpora — verify through the real citation gate
// against the real source-document text. This is the headline "100% citation validity"
// number the results doc publishes; the per-mechanism gate behavior (range drift, missing
// docs, fabricated excerpts) is unit-tested in test/gate.test.ts and not re-tested here.
import { describe, it } from 'vitest';
import { runCitationGate, type Claim } from '../src/gate/citationGate.js';
import { recordEval } from './collector.js';
import { CORPORA } from './corpus.js';

// Authored ground truth (execution plan S1.4): 12 facts for Margaret, 4 for William.
const EXPECTED_CLAIMS: Record<string, number> = {
    'margaret-chen': 12,
    'william-thompson': 4,
};

describe('citation-validity-100', () => {
    for (const corpus of CORPORA) {
        it(`every authored citation in ${corpus.id} verifies against its source document`, () => {
            const claims: Claim[] = corpus.facts.map((fact) => ({ id: fact.id, citations: fact.sources }));
            const result = runCitationGate(claims, corpus.resolveDocumentText);
            const { claims: total, verified, citationsChecked, citationsFailed } = result.metrics;
            const expected = EXPECTED_CLAIMS[corpus.id] ?? -1;

            recordEval({
                id: `citation-validity-100.${corpus.id}`,
                description: `All authored facts in ${corpus.name}'s corpus pass the citation gate against real document text`,
                metric: 'claims verified / citations resolved',
                value: `${verified}/${total} claims verified; ${citationsChecked - citationsFailed}/${citationsChecked} citations resolved`,
                threshold: `${expected}/${expected} claims verified; 0 citations failed`,
                pass: total === expected && verified === total && citationsFailed === 0 && citationsChecked > 0,
            });
        });
    }
});
