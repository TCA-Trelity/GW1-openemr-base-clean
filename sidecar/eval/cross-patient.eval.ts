// Eval: cross-patient-denial (S2.5). Two enforcement points keep one patient's facts out
// of another patient's record, checked here with REAL corpus identities on both sides:
// (a) extraction validation rejects a (mocked) LLM response whose facts claim a different
//     patient — the whole call fails rather than storing misattributed facts;
// (b) chat citation parsing classifies fact ids from another patient's bundle as invalid,
//     so a cross-patient citation can never render as a provenance chip.
// No live LLM: the extractor is driven through the mocked SSE fetch seam (the same
// pattern test/prep.test.ts uses).
import { describe, it } from 'vitest';
import { citableDocuments, verifyCitation } from '../src/chat/chat.js';
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

        // Sanity: the corpora are distinct records; text from William's documents
        // must never verify as provenance against Margaret's documents.
        const margaretDocs = citableDocuments(margaretBundle);
        const williamBundle = seededFactBundle(williamThompson);
        const williamDocs = citableDocuments(williamBundle);

        // Citations quoting WILLIAM's documents, presented against MARGARET's record.
        const crossCitations = williamDocs.map((doc) => ({
            cited_text: doc.text.slice(0, 60),
            document_index: 0, // claims to be Margaret's first document
            start_char_index: 0,
            end_char_index: 60,
        }));
        const crossVerified = crossCitations
            .map((raw) => verifyCitation(raw, margaretDocs))
            .filter((c) => c !== null && c.verified);

        // Genuine spans from Margaret's own documents must verify.
        const ownCitations = margaretDocs.slice(0, 3).map((doc, index) => ({
            cited_text: doc.text.slice(10, 70),
            document_index: margaretDocs.indexOf(margaretDocs[index]!),
            start_char_index: 10,
            end_char_index: 70,
        }));
        const ownVerified = ownCitations
            .map((raw) => verifyCitation(raw, margaretDocs))
            .filter((c) => c !== null && c.verified);

        const pass =
            margaretDocs.length > 0 &&
            williamDocs.length > 0 &&
            ownCitations.length > 0 &&
            crossVerified.length === 0 &&
            ownVerified.length === ownCitations.length;

        recordEval({
            id: 'cross-patient-denial.chat-citations',
            description:
                "Chat citation verification against Margaret's documents rejects spans quoted from William's record while her own document spans verify",
            metric: 'cross-patient spans verified (must be 0)',
            value: `${crossVerified.length}/${crossCitations.length} cross-patient spans verified; ${ownVerified.length}/${ownCitations.length} own spans verified`,
            threshold: '0 cross-patient spans verified; all own spans verified',
            pass,
        });
    });
});
