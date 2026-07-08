// Eval: cross-patient-denial (S2.5). Two enforcement points keep one patient's facts out
// of another patient's record, checked here with REAL corpus identities on both sides:
// (a) extraction validation rejects a (mocked) LLM response whose facts claim a different
//     patient — the whole call fails rather than storing misattributed facts;
// (b) chat citation parsing classifies fact ids from another patient's bundle as invalid,
//     so a cross-patient citation can never render as a provenance chip.
// No live LLM: the extractor is driven through the mocked SSE fetch seam (the same
// pattern test/prep.test.ts uses).
import { describe, it } from 'vitest';
import { parseCitations } from '../src/chat/chat.js';
import { AnthropicClient, type FetchLike } from '../src/prep/anthropic.js';
import { ExtractionError, FactExtractor, type PrepLogger } from '../src/prep/extraction.js';
import { recordEval } from './collector.js';
import { margaretChen, seededFactBundle, williamThompson } from './corpus.js';
import { llmResponse } from './sse.js';

const silentLogger: PrepLogger = { info: () => {}, warn: () => {}, error: () => {} };

describe('cross-patient-denial', () => {
    it('extraction rejects facts that claim another patient', async () => {
        // The mocked model returns Margaret's own authored facts but stamped with
        // William's patient id — a misattribution the validator must refuse on both the
        // first attempt and the feedback retry.
        const strayFacts = margaretChen.facts.map((fact) => ({ ...fact, patient_id: williamThompson.id }));
        const fetchImpl: FetchLike = () => Promise.resolve(llmResponse({ facts: strayFacts }));
        const extractor = new FactExtractor(
            new AnthropicClient({ apiKey: 'eval-key', model: 'claude-haiku-4-5', fetchImpl }),
        );

        const doc = margaretChen.raw.source_documents[0];
        let rejected = false;
        let mentionsPatientId = false;
        let extractedCount: number | null = null;
        try {
            const result = await extractor.extract(
                {
                    patientId: margaretChen.id,
                    patientName: margaretChen.name,
                    documents: [
                        {
                            id: doc?.document_id ?? 'doc-eval',
                            document_type: doc?.document_type ?? 'referral_letter',
                            document_date: doc?.document_date ?? '2024-12-15',
                            text: doc?.content.text_content ?? '',
                        },
                    ],
                },
                'eval-cross-patient',
                silentLogger,
            );
            extractedCount = result.facts.length;
        } catch (error) {
            rejected = error instanceof ExtractionError;
            mentionsPatientId = error instanceof Error && error.message.includes('patient_id');
        }

        recordEval({
            id: 'cross-patient-denial.extraction',
            description:
                "FactExtractor (mocked SSE) rejects a response whose facts claim william-thompson while extracting margaret-chen's record",
            metric: 'misattributed facts stored',
            value: rejected
                ? `0 stored — ExtractionError raised (names patient_id: ${mentionsPatientId}) for all ${strayFacts.length} stray facts`
                : `NOT rejected — ${String(extractedCount)} facts accepted`,
            threshold: 'ExtractionError naming patient_id; 0 facts stored',
            pass: rejected && mentionsPatientId,
        });
    });

    it("chat citation parsing classifies another patient's fact ids as invalid", () => {
        const margaretBundle = seededFactBundle(margaretChen);
        const williamIds = williamThompson.facts.map((fact) => fact.id);
        const margaretIds = margaretChen.facts.slice(0, 2).map((fact) => fact.id);

        // Sanity: the two corpora share no fact ids, so classification is meaningful.
        const margaretIdSet = new Set(margaretChen.facts.map((fact) => fact.id));
        const disjoint = williamIds.every((id) => !margaretIdSet.has(id));

        // A reply citing every William fact id plus two genuine Margaret ids.
        const reply =
            `Wet AMD status ${williamIds.map((id) => `[[fact:${id}]]`).join(' ')} ` +
            `and current medication ${margaretIds.map((id) => `[[fact:${id}]]`).join(' ')}.`;
        const { valid, invalid } = parseCitations(reply, margaretBundle);

        const pass =
            disjoint &&
            williamIds.length > 0 &&
            [...invalid].sort().join(',') === [...williamIds].sort().join(',') &&
            [...valid].sort().join(',') === [...margaretIds].sort().join(',');

        recordEval({
            id: 'cross-patient-denial.chat-citations',
            description:
                "parseCitations against Margaret's bundle marks all of William's fact ids invalid (never rendered as provenance) while her own ids stay valid",
            metric: 'cross-patient ids classified invalid',
            value: `${invalid.length}/${williamIds.length} william ids invalid; ${valid.length}/${margaretIds.length} margaret ids valid; corpora id sets disjoint=${disjoint}`,
            threshold: 'all cross-patient ids invalid; all same-patient ids valid',
            pass,
        });
    });
});
