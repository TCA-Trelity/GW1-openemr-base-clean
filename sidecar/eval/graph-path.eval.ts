// D.3 (REQ S3/R4, E1, G17): the FULL ingestion→answer path as eval goldens — fixture
// document in, supervisor-routed graph run, cited answer out, with the critic gating
// every release. Stubbed VLM + offline retrieval backends: the whole multi-agent path
// runs in CI with zero live keys (G17), so a routing/pinning/gate regression fails a
// golden here before it can reach a grader.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { runClinicalGraph, type AnswerComposer, type ClinicalGraphDeps } from '../src/graph/graph.js';
import { MemoryPinnedEvidenceStore } from '../src/graph/pins.js';
import { VlmExtractor } from '../src/ingest/extractor.js';
import { IngestionService, MemoryIngestionRecordStore } from '../src/ingest/service.js';
import type { AnthropicCompletion } from '../src/prep/anthropic.js';
import { HashEmbeddings } from '../src/retrieval/embeddings.js';
import { PassthroughReranker } from '../src/retrieval/rerank.js';
import { HybridRetriever, loadCorpusChunks } from '../src/retrieval/retriever.js';
import { recordEval } from './collector.js';

const CORPUS = fileURLToPath(new URL('../corpus/', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures/documents/', import.meta.url));
const renalPdf = new Uint8Array(readFileSync(`${FIXTURES}renal-panel-clean.pdf`));

const LAB_JSON = JSON.stringify({
    doc_type: 'lab_pdf',
    document_patient: null,
    performing_lab: null,
    collection_date: '2024-12-20',
    collection_date_citation: null,
    results: [{ test_name: 'eGFR', value: '42', value_numeric: 42, unit: null, reference_range: null, abnormal_flag: 'low', citation: { page: 1, bbox: null, quote: 'eGFR (CKD-EPI) 42', grounding: 'page' } }],
});

function composer(invent = false): AnswerComposer {
    return {
        compose: async (_ask, evidence) => {
            const top = evidence[0];
            if (top === undefined) {
                return { text: 'No practice protocol on file covers this question.', claims: [] };
            }
            const quote = invent ? 'the guideline says to double the dose immediately' : top.quote.slice(0, 120);
            return {
                text: `Per ${top.guideline_source}: ${quote}`,
                claims: [
                    {
                        id: 'claim-1',
                        citations: [
                            {
                                id: 'cit-g-1',
                                fact_id: null,
                                source_label: top.guideline_source,
                                source_type: 'guideline_evidence',
                                excerpt_text: quote,
                                excerpt_location: null,
                                attribution: null,
                                source_document_id: top.chunk_id,
                                document_date: null,
                                deep_link_url: null,
                                page_or_section: top.section_title,
                                field_or_chunk_id: top.chunk_id,
                            },
                        ],
                    },
                ],
            };
        },
    };
}

async function makeDeps(invent = false): Promise<{ deps: ClinicalGraphDeps; pins: MemoryPinnedEvidenceStore }> {
    const retriever = await HybridRetriever.build(loadCorpusChunks(CORPUS), {
        embeddings: new HashEmbeddings(),
        reranker: new PassthroughReranker(),
    });
    const vlm = {
        complete: vi.fn(async (): Promise<AnthropicCompletion> => ({
            text: LAB_JSON, citations: [], tool_uses: [], usage: { input_tokens: 100, output_tokens: 50 }, stop_reason: 'end_turn', model: 'stub',
        })),
    };
    const pins = new MemoryPinnedEvidenceStore();
    const deps: ClinicalGraphDeps = {
        retriever,
        ingestion: new IngestionService({ extractor: new VlmExtractor(vlm), records: new MemoryIngestionRecordStore() }),
        composer: composer(invent),
        pins,
    };
    return { deps, pins };
}

const UPLOAD_ASK = {
    kind: 'document_upload' as const,
    patientId: 'pt-8842',
    upload: { docType: 'lab_pdf' as const, filename: 'renal.pdf', mimeType: 'application/pdf', bytes: renalPdf },
    concepts: ['hydroxychloroquine screening', 'reduced eGFR renal impairment'],
};

describe('full-path graph goldens (D.3)', () => {
    it('document upload → extraction → retrieval → critic → answer with a VERIFIED guideline citation', async () => {
        const { deps } = await makeDeps();
        const outcome = await runClinicalGraph(deps, UPLOAD_ASK, 'eval-graph-upload');
        const citation = outcome.answer?.citations[0];
        const pass =
            outcome.ingestion?.status === 'complete' &&
            outcome.answer !== null &&
            outcome.answer.verified_claims >= 1 &&
            outcome.answer.blocked_claims === 0 &&
            citation?.source_type === 'guideline_evidence';
        recordEval({
            id: 'graph-path.upload-to-cited-answer',
            description: 'The full Tier-2 path (fixture PDF → extraction → pinned retrieval → critic) releases an answer whose guideline citation verified verbatim',
            metric: 'extraction status / verified claims / citation type',
            value: `${outcome.ingestion?.status ?? 'none'} / ${outcome.answer?.verified_claims ?? 0} verified / ${citation?.source_type ?? 'none'}`,
            threshold: 'complete / ≥1 verified / guideline_evidence',
            pass,
            category: 'citation_present',
        });
        expect(pass).toBe(true);
    });

    it('the critic BLOCKS an invented quote on the full path — nothing fabricated releases', async () => {
        const { deps } = await makeDeps(true);
        const outcome = await runClinicalGraph(
            deps,
            { kind: 'chat_turn', patientId: 'pt-8842', question: 'What do the guidelines recommend for screening intervals?' },
            'eval-graph-critic',
        );
        const pass =
            outcome.answer !== null &&
            outcome.answer.blocked_claims === 1 &&
            outcome.answer.verified_claims === 0 &&
            outcome.answer.citations.length === 0;
        recordEval({
            id: 'graph-path.critic-blocks-invention',
            description: 'A composer that invents a guideline quote is caught by the critic: the claim blocks and zero citations reach the wire (E1)',
            metric: 'blocked / verified / released citations',
            value: `${outcome.answer?.blocked_claims ?? 0} blocked / ${outcome.answer?.verified_claims ?? 0} verified / ${outcome.answer?.citations.length ?? 0} citations`,
            threshold: '1 blocked / 0 verified / 0 citations',
            pass,
            category: 'citation_present',
        });
        expect(pass).toBe(true);
    });

    it('out-of-corpus evidence ask answers honestly from an EMPTY retrieval', async () => {
        const { deps } = await makeDeps();
        const outcome = await runClinicalGraph(
            deps,
            { kind: 'chat_turn', patientId: 'pt-8842', question: 'What do the guidelines recommend for knee replacement rehabilitation?' },
            'eval-graph-empty',
        );
        const pass =
            outcome.route === 'needs_evidence' &&
            outcome.evidence.length === 0 &&
            (outcome.answer?.text.includes('No practice protocol on file') ?? false) &&
            outcome.answer?.verified_claims === 0;
        recordEval({
            id: 'graph-path.out-of-corpus-honest',
            description: 'An out-of-domain guideline ask routes to evidence, retrieves EMPTY, and the answer says so — no forced match, no fabricated claim',
            metric: 'route / evidence count / honest empty answer',
            value: `${outcome.route} / ${outcome.evidence.length} snippets / ${outcome.answer?.text.slice(0, 40) ?? 'none'}…`,
            threshold: 'needs_evidence / 0 snippets / "No practice protocol on file"',
            pass,
            category: 'safe_refusal',
        });
        expect(pass).toBe(true);
    });

    it('extraction findings pin ON-TOPIC protocols (HCQ/renal) for the visit', async () => {
        const { deps, pins } = await makeDeps();
        await runClinicalGraph(deps, UPLOAD_ASK, 'eval-graph-pin');
        const stored = await pins.listFor('pt-8842');
        const docs = stored[0]?.snippets.map((snippet) => snippet.doc_id) ?? [];
        const onTopic = docs.includes('hcq-screening') || docs.includes('renal-function-ocular-drug-safety');
        recordEval({
            id: 'graph-path.pinned-evidence-on-topic',
            description: 'The renal-panel ingestion pins the HCQ-screening / renal-safety protocols against the patient (Tier-0 for the in-visit ask)',
            metric: 'pinned docs',
            value: docs.join(', ') || 'none',
            threshold: 'includes hcq-screening or renal-function-ocular-drug-safety',
            pass: stored.length === 1 && onTopic,
            category: 'retrieval_grounded',
            enforce: 'soft',
        });
        expect(onTopic).toBe(true);
    });
});
