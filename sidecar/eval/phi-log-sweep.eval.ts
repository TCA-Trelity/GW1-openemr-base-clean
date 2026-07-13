// D.5 (REQ S4/R6 `no_phi_in_logs`, G5, P5): the log-capture PHI sweep. Real pipeline
// runs (ingestion with a PHI-laden stub extraction; the full graph over the fixture PDF)
// execute against a CAPTURING logger, and every emitted line is swept for planted
// canaries — printed patient name, DOB, family names from the goals line, allergy text.
// The invariant under test is W2_ARCHITECTURE §8/G5: log events carry opaque IDs, stage
// names, and counts — never extracted values or document text. Safety category: one
// leaked canary anywhere fails the build, no baseline forgives it.
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
const intakePdf = new Uint8Array(readFileSync(`${FIXTURES}intake-update-clean.pdf`));

// Canaries: every string here is PHI-shaped content the pipeline READS during the run.
// None may appear in any log line. (The chart patient id used in the runs is the opaque
// 'pt-8842' — name-derived ids would themselves be leaks.)
const CANARIES = ['Margaret', 'Chen', '1967', 'Emily', 'Penicillin', 'glaucoma', 'wedding'];

// The stub extraction deliberately routes canaries through every fact type.
const INTAKE_PHI_JSON = JSON.stringify({
    doc_type: 'intake_form',
    demographics: { name: 'Margaret L. Chen', dob: '1967-03-14', sex: null, citation: { page: 1, bbox: null, quote: 'Margaret L. Chen', grounding: 'page' } },
    chief_concern: { text: 'Flashes of light, right eye', laterality: 'OD', citation: { page: 1, bbox: null, quote: 'Flashes of light in my RIGHT eye', grounding: 'page' } },
    current_medications: [
        { name: 'Hydroxychloroquine (Plaquenil)', dose: '200 mg', frequency: 'daily', start_date: '2019-01', citation: { page: 1, bbox: null, quote: 'Hydroxychloroquine (Plaquenil)', grounding: 'page' } },
    ],
    allergies: [{ substance: 'Penicillin', reaction: 'hives', citation: { page: 1, bbox: null, quote: 'Penicillin', grounding: 'page' } }],
    family_history: [{ relative: 'Father', condition: 'Glaucoma', citation: { page: 1, bbox: null, quote: 'Father was told he has glaucoma', grounding: 'page' } }],
    patient_goals: { text: "Healed before daughter Emily's wedding", citation: { page: 1, bbox: null, quote: 'wedding', grounding: 'page' } },
    vitals: null,
    form_date: '2024-12-26',
});

function capturingLogger(lines: string[]): { info: (obj: unknown, msg: string) => void; warn: (obj: unknown, msg: string) => void } {
    return {
        info: (obj, msg) => lines.push(`${msg} ${JSON.stringify(obj)}`),
        warn: (obj, msg) => lines.push(`${msg} ${JSON.stringify(obj)}`),
    };
}

function sweep(lines: string[]): string[] {
    return CANARIES.filter((canary) => lines.some((line) => line.toLowerCase().includes(canary.toLowerCase())));
}

describe('PHI log sweep (D.5)', () => {
    it('a full ingestion run over a PHI-laden document emits ZERO canaries into its logs', async () => {
        const lines: string[] = [];
        const vlm = {
            complete: vi.fn(async (): Promise<AnthropicCompletion> => ({
                text: INTAKE_PHI_JSON, citations: [], tool_uses: [], usage: { input_tokens: 900, output_tokens: 250 }, stop_reason: 'end_turn', model: 'stub',
            })),
        };
        const service = new IngestionService({
            extractor: new VlmExtractor(vlm),
            records: new MemoryIngestionRecordStore(),
            logger: capturingLogger(lines),
        });
        const record = await service.attachAndExtract({
            patientId: 'pt-8842',
            docType: 'intake_form',
            filename: 'intake.pdf',
            mimeType: 'application/pdf',
            bytes: intakePdf,
            correlationId: 'eval-phi-ingest',
        });
        const leaked = sweep(lines);
        recordEval({
            id: 'phi-log-sweep.ingestion-logs-clean',
            description: 'Ingesting an intake form carrying name/DOB/family/allergy canaries logs stages and ids only — zero canaries in any line',
            metric: 'leaked canaries across captured ingestion log lines',
            value: leaked.length === 0 ? `0 leaked (${lines.length} lines swept)` : `LEAKED: ${leaked.join(', ')}`,
            threshold: '0 leaked',
            pass: record.status === 'complete' && lines.length > 0 && leaked.length === 0,
            category: 'no_phi_in_logs',
        });
        expect(record.status).toBe('complete');
        expect(lines.length).toBeGreaterThan(0);
        expect(leaked).toEqual([]);
    });

    it('a full graph run (upload → pin → critic) emits ZERO canaries into handoff/pin logs', async () => {
        const lines: string[] = [];
        const retriever = await HybridRetriever.build(loadCorpusChunks(CORPUS), {
            embeddings: new HashEmbeddings(),
            reranker: new PassthroughReranker(),
        });
        const vlm = {
            complete: vi.fn(async (): Promise<AnthropicCompletion> => ({
                text: INTAKE_PHI_JSON, citations: [], tool_uses: [], usage: { input_tokens: 900, output_tokens: 250 }, stop_reason: 'end_turn', model: 'stub',
            })),
        };
        const composer: AnswerComposer = {
            compose: async () => ({ text: 'No practice protocol on file covers this question.', claims: [] }),
        };
        const deps: ClinicalGraphDeps = {
            retriever,
            ingestion: new IngestionService({ extractor: new VlmExtractor(vlm), records: new MemoryIngestionRecordStore(), logger: capturingLogger(lines) }),
            composer,
            pins: new MemoryPinnedEvidenceStore(),
            logger: capturingLogger(lines),
        };
        const outcome = await runClinicalGraph(
            deps,
            {
                kind: 'document_upload',
                patientId: 'pt-8842',
                upload: { docType: 'intake_form', filename: 'intake.pdf', mimeType: 'application/pdf', bytes: intakePdf },
                concepts: ['hydroxychloroquine screening'],
            },
            'eval-phi-graph',
        );
        const leaked = sweep(lines);
        recordEval({
            id: 'phi-log-sweep.graph-logs-clean',
            description: 'The full multi-agent run logs worker handoffs, pin counts, and gate verdicts by id — zero document-content canaries in any line',
            metric: 'leaked canaries across captured graph log lines',
            value: leaked.length === 0 ? `0 leaked (${lines.length} lines swept)` : `LEAKED: ${leaked.join(', ')}`,
            threshold: '0 leaked',
            pass: outcome.ingestion?.status === 'complete' && lines.length > 0 && leaked.length === 0,
            category: 'no_phi_in_logs',
        });
        expect(outcome.ingestion?.status).toBe('complete');
        expect(leaked).toEqual([]);
    });
});
