// W2 baseline probe (F.1, REQ G11): measure the Week 2 flows IN PROCESS — ingestion
// (attach_and_extract over the committed fixtures), hybrid retrieval, and the full
// supervisor graph — and report p50/p95/p99/max. This script measures; it never asserts
// a fabricated number, and it NAMES ITS BACKENDS in the output: the LLM/VLM legs run the
// same scripted stubs the test suite uses, so these are pipeline-mechanics numbers
// (parse, grounding geometry, persistence, BM25+dense+RRF, gate) — the live-model legs
// are measured separately after the key drop (docs/w2/tickets/USER-ACTIONS.md).
// Not a CI gate by design: dev-machine profiling only (SLO judgment lands in
// docs/execution/baselines.md, labeled by backend).
//
// Run:  npm run baseline:w2          Env: W2_BASE_RUNS (scale factor, default 1)
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { runClinicalGraph, type AnswerComposer, type ClinicalGraphDeps } from '../graph/graph.js';
import { routeAsk } from '../graph/router.js';
import { VlmExtractor } from '../ingest/extractor.js';
import { IngestionService, MemoryIngestionRecordStore } from '../ingest/service.js';
import type { AnthropicCompletion } from '../prep/anthropic.js';
import { HashEmbeddings } from '../retrieval/embeddings.js';
import { PassthroughReranker } from '../retrieval/rerank.js';
import { HybridRetriever, loadCorpusChunks } from '../retrieval/retriever.js';

const FIXTURES = fileURLToPath(new URL('../../eval/fixtures/documents/', import.meta.url));
const CORPUS = fileURLToPath(new URL('../../corpus/', import.meta.url));
const SCALE = Math.max(0.2, Number(process.env['W2_BASE_RUNS'] ?? 1));

const LAB_JSON = JSON.stringify({
    doc_type: 'lab_pdf',
    document_patient: null,
    performing_lab: null,
    collection_date: '2024-12-20',
    collection_date_citation: null,
    results: [
        { test_name: 'eGFR (CKD-EPI)', value: '42', value_numeric: 42, unit: 'mL/min/1.73m²', reference_range: '≥60', abnormal_flag: 'low', citation: { page: 1, bbox: null, quote: 'eGFR (CKD-EPI) 42', grounding: 'page' } },
        { test_name: 'Creatinine', value: '1.58', value_numeric: 1.58, unit: 'mg/dL', reference_range: '0.50–1.10', abnormal_flag: 'high', citation: { page: 1, bbox: null, quote: 'Creatinine 1.58', grounding: 'page' } },
    ],
});

function stubVlm(): { complete: () => Promise<AnthropicCompletion> } {
    return {
        complete: async () => ({
            text: LAB_JSON, citations: [], tool_uses: [], usage: { input_tokens: 900, output_tokens: 250 }, stop_reason: 'end_turn', model: 'stub-vlm',
        }),
    };
}

// Same verbatim-quoting composer shape the graph tests use (LLM leg stubbed).
const composer: AnswerComposer = {
    compose: async (_ask, evidence) => {
        const top = evidence[0];
        if (top === undefined) {
            return { text: 'No practice protocol on file covers this question.', claims: [] };
        }
        const quote = top.quote.slice(0, 120);
        return {
            text: `Per ${top.guideline_source}: ${quote}`,
            claims: [{
                id: 'claim-1',
                citations: [{
                    id: 'cit-1', fact_id: null, source_label: top.guideline_source, source_type: 'guideline_evidence',
                    excerpt_text: quote, excerpt_location: null, attribution: null, source_document_id: top.chunk_id,
                    document_date: null, deep_link_url: null, page_or_section: top.section_title, field_or_chunk_id: top.chunk_id,
                }],
            }],
        };
    },
};

function stats(samples: number[]): { n: number; p50: number; p95: number; p99: number; max: number } {
    const sorted = [...samples].sort((a, b) => a - b);
    const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
    return { n: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1) ?? 0 };
}

function row(flow: string, backends: string, s: ReturnType<typeof stats>): string {
    const ms = (v: number): string => (v < 1 ? v.toFixed(2) : v.toFixed(1));
    return `| ${flow} | ${backends} | ${String(s.n)} | ${ms(s.p50)} ms | ${ms(s.p95)} ms | ${ms(s.p99)} ms | ${ms(s.max)} ms |`;
}

async function main(): Promise<void> {
    const rows: string[] = [];
    const json: Record<string, unknown> = {};

    // ---- Ingestion (fresh service per run: dedupe would measure the cache, not the pipeline)
    for (const fixture of ['renal-panel-clean.pdf', 'renal-panel-lowdpi.pdf']) {
        const bytes = new Uint8Array(readFileSync(`${FIXTURES}${fixture}`));
        const runs = Math.round(25 * SCALE);
        const samples: number[] = [];
        for (let i = 0; i < runs; i += 1) {
            const service = new IngestionService({ extractor: new VlmExtractor(stubVlm()), records: new MemoryIngestionRecordStore() });
            const start = performance.now();
            const record = await service.attachAndExtract({
                patientId: 'bench-pt', docType: 'lab_pdf', filename: fixture, mimeType: 'application/pdf', bytes, correlationId: `bench-ing-${String(i)}`,
            });
            samples.push(performance.now() - start);
            if (record.status !== 'complete') {
                throw new Error(`ingestion run failed: ${record.status} (${record.error ?? 'no error'})`);
            }
        }
        const s = stats(samples);
        rows.push(row(`ingestion — ${fixture}`, 'stub VLM · real pdf.js geometry + grounding', s));
        json[`ingestion_${fixture}`] = s;
    }

    // ---- Retrieval (index build reported once — boot cost, not per-query)
    const buildStart = performance.now();
    const retriever = await HybridRetriever.build(loadCorpusChunks(CORPUS), {
        embeddings: new HashEmbeddings(),
        reranker: new PassthroughReranker(),
    });
    const buildMs = performance.now() - buildStart;
    const QUERIES = [
        'hydroxychloroquine screening interval reduced renal function',
        'nonproliferative diabetic retinopathy severity follow-up',
        'AREDS2 supplement formula intermediate AMD',
        'treat and extend injection interval extension',
        'central retinal vein occlusion neovascular surveillance',
        'knee replacement rehabilitation weight bearing', // out-of-corpus control (empty path)
    ];
    {
        const runs = Math.round(200 * SCALE);
        const samples: number[] = [];
        for (let i = 0; i < runs; i += 1) {
            const start = performance.now();
            await retriever.search(QUERIES[i % QUERIES.length]!, { topK: 4, correlationId: `bench-ret-${String(i)}` });
            samples.push(performance.now() - start);
        }
        const s = stats(samples);
        rows.push(row('retrieval — hybrid search', 'BM25 + hash-dense (offline) · Passthrough rerank', s));
        json['retrieval'] = s;
        json['retrieval_index_build_ms'] = Math.round(buildMs);
    }

    // ---- Full graph (needs_evidence chat ask) + router rules path
    {
        const ingestion = new IngestionService({ extractor: new VlmExtractor(stubVlm()), records: new MemoryIngestionRecordStore() });
        const deps: ClinicalGraphDeps = { retriever, ingestion, composer };
        const runs = Math.round(50 * SCALE);
        const samples: number[] = [];
        for (let i = 0; i < runs; i += 1) {
            const start = performance.now();
            const outcome = await runClinicalGraph(
                deps,
                { kind: 'chat_turn', patientId: 'bench-pt', question: 'What screening interval do the guidelines recommend for hydroxychloroquine with reduced renal function?' },
                `bench-graph-${String(i)}`,
            );
            samples.push(performance.now() - start);
            if (outcome.answer === null || outcome.answer.verified_claims < 1) {
                throw new Error('graph run did not produce a verified answer');
            }
        }
        const s = stats(samples);
        rows.push(row('full graph — evidence turn', 'stub composer · offline retrieval · real router/critic/gate', s));
        json['graph_evidence_turn'] = s;

        const routerSamples: number[] = [];
        for (let i = 0; i < runs; i += 1) {
            const start = performance.now();
            await routeAsk({ kind: 'chat_turn', question: 'How often should she be screened per AAO guidelines?' }, undefined, `bench-route-${String(i)}`);
            routerSamples.push(performance.now() - start);
        }
        const r = stats(routerSamples);
        rows.push(row('router — deterministic rules path', 'no model call (tie-break is a live Haiku call — measure after keys)', r));
        json['router_rules_path'] = r;
    }

    console.log('\n## W2 flow baselines (in-process, stub LLM/VLM backends — pipeline mechanics only)\n');
    console.log('| Flow | Backends | Runs | p50 | p95 | p99 | max |');
    console.log('|---|---|---|---|---|---|---|');
    for (const line of rows) {
        console.log(line);
    }
    console.log(`\nRetriever index build (boot cost, once): ${String(Math.round(buildMs))} ms for ${String(retriever.size)} chunks`);
    console.log(`\nJSON: ${JSON.stringify(json)}`);
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
