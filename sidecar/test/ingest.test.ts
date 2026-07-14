// A.3–A.6 (REQ S1/R1, R5/P2, G3, G17): the ingestion spine, exercised on the COMMITTED
// fixture documents with a stubbed VLM. Failure modes guarded: fabricated geometry
// (grounding must locate quotes in the real text layer or say unverified), duplicate
// records on re-upload, wrong-patient documents silently merging, partial persistence of
// invalid extractions, and the renal→HCQ re-tier arc not firing.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { calculateMedicationDurationYears, computeMedicationRiskFlags } from '../src/engines/medicationRisk.js';
import { renalContextOf } from '../src/chat/tools/checkMedRisk.js';
import { VlmExtractor, ExtractionValidationError } from '../src/ingest/extractor.js';
import { groundExtraction } from '../src/ingest/grounding.js';
import { extractPdfWords } from '../src/ingest/pdf.js';
import {
    factsOf,
    IngestionService,
    mapIntakeVitals,
    MemoryIngestionRecordStore,
    patientMismatch,
} from '../src/ingest/service.js';
import type { AnthropicCompletion } from '../src/prep/anthropic.js';
import type { ExtractionResult } from '../src/schemas/extraction.js';
import type { FactBundle } from '../src/store/factStore.js';

const FIXTURES = fileURLToPath(new URL('../eval/fixtures/documents/', import.meta.url));
const cleanRenal = new Uint8Array(readFileSync(`${FIXTURES}renal-panel-clean.pdf`));
const skewedRenal = new Uint8Array(readFileSync(`${FIXTURES}renal-panel-skewed.pdf`));

const RENAL_EXTRACTION: ExtractionResult = {
    doc_type: 'lab_pdf',
    document_patient: { name: 'CHEN, MARGARET L', dob: '1967-03-14', citation: { page: 1, bbox: null, quote: 'CHEN, MARGARET L', grounding: 'page' } },
    performing_lab: 'Orlando Diagnostic Laboratories',
    collection_date: '2024-12-20',
    collection_date_citation: { page: 1, bbox: null, quote: 'Collected: 12/20/2024 09:15', grounding: 'page' },
    results: [
        { test_name: 'eGFR (CKD-EPI)', value: '42', value_numeric: 42, unit: 'mL/min/1.73m²', reference_range: '≥60', abnormal_flag: 'low', citation: { page: 1, bbox: null, quote: 'eGFR (CKD-EPI) 42', grounding: 'page' } },
        { test_name: 'Creatinine', value: '1.58', value_numeric: 1.58, unit: 'mg/dL', reference_range: '0.50–1.10', abnormal_flag: 'high', citation: { page: 1, bbox: null, quote: 'Creatinine 1.58', grounding: 'page' } },
        { test_name: 'Invented Test', value: '99', value_numeric: 99, unit: null, reference_range: null, abnormal_flag: null, citation: { page: 1, bbox: null, quote: 'this text is not on the document', grounding: 'page' } },
    ],
};

function vlmReturning(...texts: string[]): { complete: ReturnType<typeof vi.fn> } {
    const complete = vi.fn(async (): Promise<AnthropicCompletion> => {
        const text = texts[Math.min(complete.mock.calls.length - 1, texts.length - 1)] ?? '';
        return { text, citations: [], tool_uses: [], usage: { input_tokens: 1000, output_tokens: 300 }, stop_reason: 'end_turn', model: 'stub-vlm' };
    });
    return { complete };
}

describe('extractPdfWords (real committed fixtures)', () => {
    it('reads word geometry from the clean renal panel text layer', async () => {
        const pdf = await extractPdfWords(cleanRenal);
        expect(pdf.pages).toHaveLength(1);
        expect(pdf.pages[0]!.words.length).toBeGreaterThan(80);
        expect(pdf.fullText).toContain('CHEN, MARGARET L');
        expect(pdf.fullText).toContain('1.58');
        const word = pdf.pages[0]!.words.find((w) => w.text === 'Creatinine');
        expect(word).toBeDefined();
        expect(word!.x).toBeGreaterThanOrEqual(0);
        expect(word!.x + word!.w).toBeLessThanOrEqual(1);
    });

    it('the degraded scan has NO text layer — zero words, empty text', async () => {
        const pdf = await extractPdfWords(skewedRenal);
        expect(pdf.pages[0]!.words).toHaveLength(0);
        expect(pdf.fullText.trim()).toBe('');
    });
});

describe('groundExtraction — the ladder on real geometry (A.5)', () => {
    it('locates real quotes (word_box), flags invented quotes unverified, never fabricates boxes', async () => {
        const pdf = await extractPdfWords(cleanRenal);
        const { extraction, summary } = groundExtraction(RENAL_EXTRACTION, pdf);
        if (extraction.doc_type !== 'lab_pdf') {
            throw new Error('unreachable');
        }
        const [egfr, creatinine, invented] = extraction.results;
        expect(egfr!.citation.grounding).toBe('word_box');
        expect(egfr!.citation.bbox).not.toBeNull();
        expect(creatinine!.citation.grounding).toBe('word_box');
        expect(invented!.citation.grounding).toBe('unverified');
        expect(invented!.citation.bbox).toBeNull();
        expect(summary.unverified).toBe(1);
        expect(summary.confidence).toBeLessThan(1);
        expect(summary.confidence).toBeGreaterThan(0.5);
    });

    it('on the image-only scan every citation lands unverified — the honest bottom rung', async () => {
        const pdf = await extractPdfWords(skewedRenal);
        const { summary } = groundExtraction(RENAL_EXTRACTION, pdf);
        expect(summary.word_box).toBe(0);
        expect(summary.unverified).toBe(summary.total);
        expect(summary.confidence).toBe(0);
    });
});

describe('VlmExtractor (A.4 — schema is the source of truth, G3)', () => {
    const validJson = JSON.stringify({
        doc_type: 'lab_pdf',
        document_patient: null,
        performing_lab: null,
        collection_date: '2024-12-20',
        collection_date_citation: null,
        results: [{ test_name: 'eGFR', value: '42', value_numeric: 42, unit: null, reference_range: null, abnormal_flag: 'low', citation: { page: 1, bbox: null, quote: 'eGFR 42', grounding: 'page' } }],
    });

    it('parses a valid first response without retrying', async () => {
        const client = vlmReturning(validJson);
        const extractor = new VlmExtractor(client);
        const outcome = await extractor.extract({ bytes: cleanRenal, mimeType: 'application/pdf', docType: 'lab_pdf', correlationId: 'c1' });
        expect(outcome.retried).toBe(false);
        expect(outcome.usage).toHaveLength(1);
        expect(client.complete).toHaveBeenCalledTimes(1);
    });

    it('feedback-retries once on invalid output, then succeeds', async () => {
        const client = vlmReturning('{"doc_type":"lab_pdf","results":[], "hallucinated": true}', validJson);
        const extractor = new VlmExtractor(client);
        const outcome = await extractor.extract({ bytes: cleanRenal, mimeType: 'application/pdf', docType: 'lab_pdf', correlationId: 'c2' });
        expect(outcome.retried).toBe(true);
        expect(client.complete).toHaveBeenCalledTimes(2);
    });

    it('fails closed after the second invalid output — nothing persistable escapes', async () => {
        const client = vlmReturning('not json at all', '{"doc_type":"lab_pdf"}');
        const extractor = new VlmExtractor(client);
        await expect(
            extractor.extract({ bytes: cleanRenal, mimeType: 'application/pdf', docType: 'lab_pdf', correlationId: 'c3' }),
        ).rejects.toBeInstanceOf(ExtractionValidationError);
    });
});

describe('IngestionService end-to-end (A.3/A.6, stubbed VLM over the real fixture)', () => {
    const RENAL_JSON = JSON.stringify(RENAL_EXTRACTION);

    function makeSink() {
        return {
            insertSourceDocuments: vi.fn(async (_pid: string, docs: unknown[]) => docs.length),
            insertFacts: vi.fn(async (_pid: string, facts: unknown[]) => facts.length),
            wipeEhrSnapshot: vi.fn(async () => undefined),
        };
    }

    it('runs received → grounded → persisted with staged record + correlation id', async () => {
        const sink = makeSink();
        const service = new IngestionService({
            extractor: new VlmExtractor(vlmReturning(RENAL_JSON)),
            records: new MemoryIngestionRecordStore(),
            factSink: sink,
        });
        const record = await service.attachAndExtract({
            patientId: 'margaret-chen',
            docType: 'lab_pdf',
            filename: 'renal-panel-clean.pdf',
            mimeType: 'application/pdf',
            bytes: cleanRenal,
            correlationId: 'corr-ing-1',
            expectedPatient: { name: 'Margaret L. Chen' },
        });
        expect(record.status).toBe('complete');
        expect(record.stages.map((stage) => stage.stage)).toContain('grounded');
        expect(record.grounding?.word_box).toBeGreaterThan(0);
        expect(record.facts_persisted).toBe(3); // three lab_result facts
        expect(sink.wipeEhrSnapshot).toHaveBeenCalledWith('margaret-chen', record.source_document_id);
        // Source document stores the text layer — the gate's verification substrate.
        const doc = sink.insertSourceDocuments.mock.calls[0]?.[1]?.[0] as { content: { text_content: string } };
        expect(doc.content.text_content).toContain('eGFR');
    });

    it('byte-identical re-upload returns the SAME record — no duplicate rows or facts', async () => {
        const sink = makeSink();
        const records = new MemoryIngestionRecordStore();
        const service = new IngestionService({ extractor: new VlmExtractor(vlmReturning(RENAL_JSON, RENAL_JSON)), records, factSink: sink });
        const input = { patientId: 'margaret-chen', docType: 'lab_pdf' as const, filename: 'renal.pdf', mimeType: 'application/pdf', bytes: cleanRenal };
        const first = await service.attachAndExtract(input);
        const second = await service.attachAndExtract(input);
        expect(second.id).toBe(first.id);
        expect(sink.insertFacts).toHaveBeenCalledTimes(1);
    });

    it("blocks a document printed for a different patient BEFORE any fact persists", async () => {
        const sink = makeSink();
        const service = new IngestionService({ extractor: new VlmExtractor(vlmReturning(RENAL_JSON)), records: new MemoryIngestionRecordStore(), factSink: sink });
        const record = await service.attachAndExtract({
            patientId: 'robert-alvarez',
            docType: 'lab_pdf',
            filename: 'renal.pdf',
            mimeType: 'application/pdf',
            bytes: cleanRenal,
            expectedPatient: { name: 'Robert M. Alvarez' },
        });
        expect(record.status).toBe('blocked_patient_mismatch');
        expect(sink.insertFacts).not.toHaveBeenCalled();
    });

    it('patientMismatch: absent printed identity is NOT a mismatch', () => {
        expect(patientMismatch({ ...RENAL_EXTRACTION, document_patient: null }, { name: 'Anyone Else' })).toBeNull();
    });
});

describe('factsOf + vitals mapping (A.6)', () => {
    it('lab facts carry page_bbox citations when grounded, none when unverified', async () => {
        const pdf = await extractPdfWords(cleanRenal);
        const { extraction } = groundExtraction(RENAL_EXTRACTION, pdf);
        const facts = factsOf('doc-upload-abc', 'margaret-chen', extraction, 'renal-panel-clean.pdf');
        expect(facts).toHaveLength(3);
        const egfr = facts[0]!;
        expect(egfr.fact_type).toBe('lab_result');
        const source = (egfr.sources as { excerpt_location: { type: string } | null; field_or_chunk_id: string }[])[0]!;
        expect(source.excerpt_location?.type).toBe('page_bbox');
        expect(source.field_or_chunk_id).toBe('results[0]');
        const invented = (facts[2]!.sources as { excerpt_location: unknown }[])[0]!;
        expect(invented.excerpt_location).toBeNull(); // unverified → uncitable by construction
    });

    it('maps intake vitals to the fixed-field native payload', () => {
        const intake: ExtractionResult = {
            doc_type: 'intake_form',
            demographics: { name: null, dob: null, sex: null, citation: null },
            chief_concern: { text: null, laterality: null, citation: null },
            current_medications: [],
            allergies: [],
            family_history: [],
            patient_goals: { text: null, citation: null },
            vitals: { height_in: 64, weight_lb: 138, bp_systolic: 128, bp_diastolic: 78, citation: null },
            form_date: null,
        };
        expect(mapIntakeVitals(intake)).toEqual({ height: 64, weight: 138, bps: 128, bpd: 78 });
    });
});

describe('renal → HCQ re-tier (A.6, the hero arc: UC-4)', () => {
    const margaretMeds = [{ content: { name: 'Hydroxychloroquine (Plaquenil)', dose: '200mg', duration: '5 years' } }];

    it('eGFR 42 escalates the HCQ tier and carries the AAO rationale', () => {
        const without = computeMedicationRiskFlags(margaretMeds);
        const withRenal = computeMedicationRiskFlags(margaretMeds, {}, { renal: { egfr: 42 } });
        expect(without[0]!.severity).toBe('high'); // 5y × 200mg already crosses the AAO threshold
        expect(withRenal[0]!.severity).toBe('high');
        expect(withRenal[0]!.message).toContain('renal impairment (eGFR 42)');
        expect(withRenal[0]!.details?.egfr).toBe(42);
        // The re-tier is visible where it matters: a sub-threshold patient jumps a tier.
        const shortUse = [{ content: { name: 'Hydroxychloroquine', dose: '200mg', duration: '1 year' } }];
        expect(computeMedicationRiskFlags(shortUse)[0]!.severity).toBe('low');
        expect(computeMedicationRiskFlags(shortUse, {}, { renal: { egfr: 42 } })[0]!.severity).toBe('medium');
        expect(computeMedicationRiskFlags(shortUse, {}, { renal: { egfr: 72 } })[0]!.severity).toBe('low'); // normal renal fn: no escalation
    });

    it('renalContextOf finds the most recent extracted eGFR in the bundle', () => {
        const bundle = {
            facts: [
                { fact_type: 'lab_result', content: { test_name: 'eGFR (CKD-EPI)', value: '58', value_numeric: 58, unit: null, reference_range: null, abnormal_flag: 'low', collection_date: '2024-03-22', performing_lab: null } },
                { fact_type: 'lab_result', content: { test_name: 'eGFR (CKD-EPI)', value: '42', value_numeric: 42, unit: null, reference_range: null, abnormal_flag: 'low', collection_date: '2024-12-20', performing_lab: null } },
                { fact_type: 'medication', content: { name: 'Hydroxychloroquine' } },
            ],
        } as unknown as FactBundle;
        expect(renalContextOf(bundle)).toEqual({ renal: { egfr: 42, collected_date: '2024-12-20' } });
    });

    it('start_date bridges to engine duration (the chat tool now tiers real chart meds)', () => {
        const years = calculateMedicationDurationYears({ start_date: '2019-01-15' }, new Date('2024-12-26'));
        expect(years).toBeGreaterThanOrEqual(5);
    });
});
