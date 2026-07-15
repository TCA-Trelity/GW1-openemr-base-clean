// Wave C (REQ S3/R4, E1, G4/G13, P3): the supervisor/worker graph. Failure modes
// guarded: a black-box supervisor (every transition must log a reasoned handoff), the
// graph sneaking into the fast path (fast_path must EXIT to the Week 1 loop), an
// uncited claim escaping the critic, and upload asks not pinning evidence.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { ALL_CHAT_TOOLS } from '../src/chat/tools/index.js';
import { GraphContractError } from '../src/graph/contracts.js';
import { runClinicalGraph, type AnswerComposer, type ClinicalGraphDeps } from '../src/graph/graph.js';
import { MemoryPinnedEvidenceStore, type PinnedEvidenceStore } from '../src/graph/pins.js';
import { routeAsk } from '../src/graph/router.js';
import { attachAndExtractTool } from '../src/graph/tools.js';
import { VlmExtractor } from '../src/ingest/extractor.js';
import { IngestionService, MemoryIngestionRecordStore, type IngestionRecord } from '../src/ingest/service.js';
import type { AnthropicCompletion } from '../src/prep/anthropic.js';
import { HashEmbeddings } from '../src/retrieval/embeddings.js';
import { PassthroughReranker } from '../src/retrieval/rerank.js';
import { HybridRetriever, loadCorpusChunks } from '../src/retrieval/retriever.js';

const CORPUS = fileURLToPath(new URL('../corpus/', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../eval/fixtures/documents/', import.meta.url));
const renalPdf = new Uint8Array(readFileSync(`${FIXTURES}renal-panel-clean.pdf`));

const LAB_JSON = JSON.stringify({
    doc_type: 'lab_pdf',
    document_patient: null,
    performing_lab: null,
    collection_date: '2024-12-20',
    collection_date_citation: null,
    results: [{ test_name: 'eGFR', value: '42', value_numeric: 42, unit: null, reference_range: null, abnormal_flag: 'low', citation: { page: 1, bbox: null, quote: 'eGFR (CKD-EPI) 42', grounding: 'page' } }],
});

// Composer stub: quotes the top snippet verbatim (verifiable) — or, when asked to
// misbehave, invents a quote the critic must block.
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

async function makeDeps(invent = false, pins?: PinnedEvidenceStore): Promise<{ deps: ClinicalGraphDeps; logs: string[] }> {
    const logs: string[] = [];
    const retriever = await HybridRetriever.build(loadCorpusChunks(CORPUS), {
        embeddings: new HashEmbeddings(),
        reranker: new PassthroughReranker(),
    });
    const vlm = {
        complete: vi.fn(async (): Promise<AnthropicCompletion> => ({
            text: LAB_JSON, citations: [], tool_uses: [], usage: { input_tokens: 100, output_tokens: 50 }, stop_reason: 'end_turn', model: 'stub',
        })),
    };
    const ingestion = new IngestionService({ extractor: new VlmExtractor(vlm), records: new MemoryIngestionRecordStore() });
    const deps: ClinicalGraphDeps = {
        retriever,
        ingestion,
        composer: composer(invent),
        ...(pins === undefined ? {} : { pins }),
        logger: {
            info: (obj, msg) => logs.push(`${msg}:${JSON.stringify(obj)}`),
            warn: (obj, msg) => logs.push(`${msg}:${JSON.stringify(obj)}`),
        },
    };
    return { deps, logs };
}

describe('supervisor routing (C.2)', () => {
    it('routes by deterministic rules with named reasons', async () => {
        expect((await routeAsk({ kind: 'document_upload' }, undefined, 'c')).route).toBe('needs_extraction');
        const evidence = await routeAsk({ kind: 'chat_turn', question: 'How often should she be screened per AAO guidelines?' }, undefined, 'c');
        expect(evidence.route).toBe('needs_evidence');
        expect(evidence.decided_by).toBe('rule');
        const fast = await routeAsk({ kind: 'chat_turn', question: 'When did she last have an injection?' }, undefined, 'c');
        expect(fast.route).toBe('fast_path');
    });

    it('uses the model tie-break only for ambiguity, and defaults safe without one', async () => {
        const model = { decide: vi.fn(async () => 'needs_evidence' as const) };
        const decision = await routeAsk({ kind: 'chat_turn', question: 'Thoughts on the kidneys here?' }, model, 'c');
        expect(decision.decided_by).toBe('model');
        expect(model.decide).toHaveBeenCalledTimes(1);
        const withoutModel = await routeAsk({ kind: 'chat_turn', question: 'Thoughts on the kidneys here?' }, undefined, 'c');
        expect(withoutModel.route).toBe('fast_path');
    });
});

describe('clinical graph (C.1/C.3–C.6)', () => {
    it('fast_path asks EXIT the graph untouched — the Week 1 loop owns them', async () => {
        const { deps } = await makeDeps();
        const outcome = await runClinicalGraph(deps, { kind: 'chat_turn', patientId: 'p1', question: 'Show me her last scan' }, 'corr-fast');
        expect(outcome.route).toBe('fast_path');
        expect(outcome.answer).toBeNull();
        expect(outcome.evidence).toEqual([]);
        expect(outcome.handoffs).toHaveLength(1); // just the routing decision
    });

    it('guideline asks run retrieve → critic → answer with verified guideline citations', async () => {
        const { deps, logs } = await makeDeps();
        const outcome = await runClinicalGraph(
            deps,
            { kind: 'chat_turn', patientId: 'p1', question: 'What screening interval do the guidelines recommend for hydroxychloroquine with reduced renal function?' },
            'corr-evidence',
        );
        expect(outcome.route).toBe('needs_evidence');
        expect(outcome.evidence.length).toBeGreaterThan(0);
        expect(outcome.answer).not.toBeNull();
        expect(outcome.answer!.verified_claims).toBe(1);
        expect(outcome.answer!.blocked_claims).toBe(0);
        expect(outcome.answer!.citations[0]?.source_type).toBe('guideline_evidence');
        // Handoffs: supervisor→evidence_retriever→critic→answer, all correlation-tagged.
        expect(outcome.handoffs.map((h) => `${h.from}>${h.to}`)).toEqual([
            'supervisor>evidence_retriever',
            'evidence_retriever>critic',
            'critic>answer',
        ]);
        expect(logs.filter((line) => line.startsWith('worker_handoff')).every((line) => line.includes('corr-evidence'))).toBe(true);
    });

    it('document uploads run extraction then PIN evidence then critic (Tier 2)', async () => {
        const { deps } = await makeDeps();
        const outcome = await runClinicalGraph(
            deps,
            {
                kind: 'document_upload',
                patientId: 'margaret-chen',
                upload: { docType: 'lab_pdf', filename: 'renal.pdf', mimeType: 'application/pdf', bytes: renalPdf },
                concepts: ['hydroxychloroquine screening', 'reduced eGFR renal impairment'],
            },
            'corr-upload',
        );
        expect(outcome.route).toBe('needs_extraction');
        expect(outcome.ingestion?.status).toBe('complete');
        expect(outcome.evidence.length).toBeGreaterThan(0); // pinned at prep time (C.6)
        const docs = outcome.evidence.map((snippet) => snippet.doc_id);
        expect(docs.some((doc) => doc === 'hcq-screening' || doc === 'renal-function-ocular-drug-safety')).toBe(true);
        expect(outcome.handoffs.map((h) => h.to)).toEqual(['intake_extractor', 'evidence_retriever', 'critic', 'answer']);
    });

    it('the critic BLOCKS an invented quote — uncited claims cannot release (E1)', async () => {
        const { deps, logs } = await makeDeps(true);
        const outcome = await runClinicalGraph(
            deps,
            { kind: 'chat_turn', patientId: 'p1', question: 'What do the guidelines recommend for screening intervals?' },
            'corr-critic',
        );
        expect(outcome.answer!.blocked_claims).toBe(1);
        expect(outcome.answer!.verified_claims).toBe(0);
        expect(outcome.answer!.citations).toEqual([]); // nothing fabricated reaches the wire
        expect(logs.some((line) => line.startsWith('critic_flags'))).toBe(true);
    });

    it('out-of-corpus evidence asks carry an honest empty result to the answer', async () => {
        const { deps } = await makeDeps();
        const outcome = await runClinicalGraph(
            deps,
            { kind: 'chat_turn', patientId: 'p1', question: 'What do the guidelines recommend for knee replacement rehabilitation?' },
            'corr-empty',
        );
        expect(outcome.route).toBe('needs_evidence');
        expect(outcome.evidence).toEqual([]);
        expect(outcome.answer!.text).toContain('No practice protocol on file');
        expect(outcome.answer!.verified_claims).toBe(0);
        expect(outcome.answer!.blocked_claims).toBe(0);
    });
});

describe('graph boundary contracts (C.1, G1/G7)', () => {
    it('rejects a chat turn without a question before any node runs', async () => {
        const { deps } = await makeDeps();
        await expect(runClinicalGraph(deps, { kind: 'chat_turn', patientId: 'p1' }, 'corr-contract-1')).rejects.toThrow(
            GraphContractError,
        );
    });

    it('rejects an upload with empty bytes', async () => {
        const { deps } = await makeDeps();
        await expect(
            runClinicalGraph(
                deps,
                {
                    kind: 'document_upload',
                    patientId: 'p1',
                    upload: { docType: 'lab_pdf', filename: 'x.pdf', mimeType: 'application/pdf', bytes: new Uint8Array() },
                },
                'corr-contract-2',
            ),
        ).rejects.toThrow(GraphContractError);
    });

    it('a malformed worker payload fails loudly — never flows into the critic', async () => {
        const { deps } = await makeDeps();
        const rogue = {
            search: async () => ({ snippets: [{ chunk_id: 'only-an-id' }], searched_query: 'q', rerank_applied: false, empty: false }),
        } as unknown as HybridRetriever;
        await expect(
            runClinicalGraph(
                { ...deps, retriever: rogue },
                { kind: 'chat_turn', patientId: 'p1', question: 'What do the guidelines recommend?' },
                'corr-rogue',
            ),
        ).rejects.toThrow(/evidence_retriever/);
    });
});

describe('attach_and_extract graph tool (H.9)', () => {
    const validUpload = { docType: 'lab_pdf' as const, filename: 'renal.pdf', mimeType: 'application/pdf', bytes: renalPdf };
    // Structural spy — the tool must treat the service as its only collaborator.
    const spyService = (record?: IngestionRecord) => {
        const attachAndExtract = vi.fn(async () => record ?? stubRecord());
        return { attachAndExtract, service: { attachAndExtract } as unknown as IngestionService };
    };
    const stubRecord = (): IngestionRecord => ({
        id: 'ing-stub',
        patient_id: 'margaret-chen',
        doc_type: 'lab_pdf',
        filename: 'renal.pdf',
        mime_type: 'application/pdf',
        sha3_512: 'stub-hash',
        correlation_id: 'corr-tool',
        status: 'complete',
        stages: [],
        openemr_document_id: null,
        source_document_id: null,
        grounding: null,
        facts_persisted: 0,
        vitals_written: false,
        error: null,
        created_at: '2026-01-01T00:00:00.000Z',
    });

    it('parses input at the boundary — a malformed payload throws GraphContractError naming the tool, never reaching the service', async () => {
        const { attachAndExtract, service } = spyService();
        const tool = attachAndExtractTool(service);
        await expect(tool.run({ patient_id: '', upload: validUpload }, { correlationId: 'c' })).rejects.toThrow(GraphContractError);
        await expect(
            tool.run({ patient_id: 'p', upload: { ...validUpload, bytes: new Uint8Array(0) } }, { correlationId: 'c' }),
        ).rejects.toThrow(/attach_and_extract/);
        await expect(tool.run({ patient_id: 'p', upload: validUpload, rogue: true }, { correlationId: 'c' })).rejects.toThrow(
            /graph_tool/,
        );
        expect(attachAndExtract).not.toHaveBeenCalled();
    });

    it('delegates valid input to IngestionService.attachAndExtract with the graph correlation id', async () => {
        const record = stubRecord();
        const { attachAndExtract, service } = spyService(record);
        const tool = attachAndExtractTool(service);
        const outcome = await tool.run({ patient_id: 'margaret-chen', upload: validUpload }, { correlationId: 'corr-tool' });
        expect(outcome).toBe(record);
        expect(attachAndExtract).toHaveBeenCalledTimes(1);
        expect(attachAndExtract).toHaveBeenCalledWith({
            patientId: 'margaret-chen',
            docType: 'lab_pdf',
            filename: 'renal.pdf',
            mimeType: 'application/pdf',
            bytes: renalPdf,
            correlationId: 'corr-tool',
        });
    });

    it('is not registered on the sync read-only chat tool list', () => {
        const { service } = spyService();
        // The discrete named tool object exists — but ONLY on the async graph surface.
        expect(attachAndExtractTool(service).name).toBe('attach_and_extract');
        expect(ALL_CHAT_TOOLS.map((tool) => tool.name)).not.toContain('attach_and_extract');
    });
});

describe('evidence budget (C.3, G2)', () => {
    it('degrades to an honest empty result when retrieval exceeds the Tier-1 budget', async () => {
        const { deps, logs } = await makeDeps();
        const slow = {
            search: () =>
                new Promise((resolve) =>
                    setTimeout(() => resolve({ snippets: [], searched_query: 'q', rerank_applied: false, empty: true }), 80),
                ),
        } as unknown as HybridRetriever;
        const outcome = await runClinicalGraph(
            { ...deps, retriever: slow, evidenceBudgetMs: 15 },
            { kind: 'chat_turn', patientId: 'p1', question: 'What do the guidelines recommend for screening intervals?' },
            'corr-budget',
        );
        expect(outcome.evidence).toEqual([]);
        expect(outcome.answer!.text).toContain('No practice protocol on file');
        expect(outcome.handoffs.some((event) => event.routing_reason.includes('degraded'))).toBe(true);
        expect(logs.some((line) => line.startsWith('evidence_degraded'))).toBe(true);
    });
});

describe('evidence pinning store (C.6)', () => {
    it('extraction-driven retrieval pins chunks per patient, keyed to the ingestion; chat turns never pin', async () => {
        const pins = new MemoryPinnedEvidenceStore();
        const { deps, logs } = await makeDeps(false, pins);
        const upload = {
            kind: 'document_upload' as const,
            patientId: 'margaret-chen',
            upload: { docType: 'lab_pdf' as const, filename: 'renal.pdf', mimeType: 'application/pdf', bytes: renalPdf },
            concepts: ['hydroxychloroquine screening', 'reduced eGFR renal impairment'],
        };
        const outcome = await runClinicalGraph(deps, upload, 'corr-pin');
        const stored = await pins.listFor('margaret-chen');
        expect(stored).toHaveLength(1);
        expect(stored[0]!.ingestion_id).toBe(outcome.ingestion!.id);
        expect(stored[0]!.snippets.length).toBeGreaterThan(0);
        expect(logs.some((line) => line.startsWith('evidence_pinned'))).toBe(true);
        // Re-ingesting the same document REPLACES its pin — no duplicate evidence (G1).
        await runClinicalGraph(deps, upload, 'corr-pin-2');
        expect(await pins.listFor('margaret-chen')).toHaveLength(1);
        // A plain guideline chat turn retrieves live but never writes pins.
        await runClinicalGraph(
            deps,
            { kind: 'chat_turn', patientId: 'margaret-chen', question: 'What do the guidelines recommend for screening intervals?' },
            'corr-pin-3',
        );
        expect(await pins.listFor('margaret-chen')).toHaveLength(1);
    });
});
