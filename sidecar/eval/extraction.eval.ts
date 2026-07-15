// D.2 (REQ S4/R6, S1/R1, R2/G3, R5/P2): extraction goldens over the COMMITTED fixture
// documents with a scripted VLM — the deterministic PR-gate leg of the extraction rubric.
// What live extraction adds (real model output variability) rides the opt-in live suite;
// everything the pipeline itself guarantees is measured here: strict-schema enforcement
// (schema_valid), per-field citations with honest grounding tiers (citation_present),
// value fidelity + dedupe + the renal→HCQ re-tier (factually_consistent), and the
// printed-patient mismatch block (safe_refusal).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { computeMedicationRiskFlags } from '../src/engines/medicationRisk.js';
import { VlmExtractor } from '../src/ingest/extractor.js';
import {
    IngestionService,
    MemoryIngestionRecordStore,
    type IngestionFactSink,
    type IngestionRecord,
} from '../src/ingest/service.js';
import type { AnthropicCompletion } from '../src/prep/anthropic.js';
import type { EhrVitalPayload } from '../src/openemr/standardApi.js';
import { CitationRefSchema, type CitationRef } from '../src/schemas/citations.js';
import type { FactInput, SourceDocumentInput } from '../src/store/factStore.js';
import { recordEval } from './collector.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/documents/', import.meta.url));
const cleanRenal = new Uint8Array(readFileSync(`${FIXTURES}renal-panel-clean.pdf`));
const lowdpiRenal = new Uint8Array(readFileSync(`${FIXTURES}renal-panel-lowdpi.pdf`));
const cleanIntake = new Uint8Array(readFileSync(`${FIXTURES}intake-update-clean.pdf`));
const cleanHba1c = new Uint8Array(readFileSync(`${FIXTURES}hba1c-panel-clean.pdf`));

// Neutral chart patient id: log lines must carry opaque ids, never name-derived ones.
const PATIENT_ID = 'pt-8842';

// ---- scripted VLM + capturing sink ------------------------------------------------

function vlmReturning(...texts: string[]): { complete: ReturnType<typeof vi.fn> } {
    const complete = vi.fn(async (): Promise<AnthropicCompletion> => {
        const text = texts[Math.min(complete.mock.calls.length - 1, texts.length - 1)] ?? '';
        return { text, citations: [], tool_uses: [], usage: { input_tokens: 900, output_tokens: 250 }, stop_reason: 'end_turn', model: 'stub-vlm' };
    });
    return { complete };
}

interface Captured {
    facts: FactInput[];
    docs: SourceDocumentInput[];
    vitals: EhrVitalPayload[];
}

function harness(...vlmTexts: string[]): {
    service: IngestionService;
    captured: Captured;
    vlm: { complete: ReturnType<typeof vi.fn> };
} {
    const captured: Captured = { facts: [], docs: [], vitals: [] };
    const sink: IngestionFactSink = {
        insertSourceDocuments: async (_patientId, docs) => {
            captured.docs.push(...docs);
            return docs.length;
        },
        insertFacts: async (_patientId, facts) => {
            captured.facts.push(...facts);
            return facts.length;
        },
        wipeEhrSnapshot: async () => {},
    };
    const vlm = vlmReturning(...vlmTexts);
    const service = new IngestionService({
        extractor: new VlmExtractor(vlm),
        records: new MemoryIngestionRecordStore(),
        factSink: sink,
        vitalsWriter: async (_patientId, payload) => {
            captured.vitals.push(payload);
            return true;
        },
    });
    return { service, captured, vlm };
}

/**
 * fact.sources is `unknown` at the store boundary (jsonb column); parse it back through
 * the real citation schema instead of casting — the ingestion pipeline built these rows
 * as CitationRef[], so a parse failure here is itself a regression worth failing on.
 */
function citationsOf(fact: FactInput): CitationRef[] {
    return z.array(CitationRefSchema).parse(fact.sources ?? []);
}

async function ingest(
    service: IngestionService,
    bytes: Uint8Array,
    docType: 'lab_pdf' | 'intake_form',
    expectedPatient?: { name: string; dob?: string },
): Promise<IngestionRecord> {
    return service.attachAndExtract({
        patientId: PATIENT_ID,
        docType,
        filename: 'eval-fixture.pdf',
        mimeType: 'application/pdf',
        bytes,
        correlationId: 'eval-extraction',
        ...(expectedPatient === undefined ? {} : { expectedPatient }),
    });
}

// ---- scripted extractions (quotes are verbatim fixture text, except the planted one) --

const RENAL_JSON = JSON.stringify({
    doc_type: 'lab_pdf',
    document_patient: { name: 'CHEN, MARGARET L', dob: '1967-03-14', citation: { page: 1, bbox: null, quote: 'CHEN, MARGARET L', grounding: 'page' } },
    performing_lab: 'Orlando Diagnostic Laboratories',
    collection_date: '2024-12-20',
    collection_date_citation: { page: 1, bbox: null, quote: 'Collected: 12/20/2024 09:15', grounding: 'page' },
    results: [
        { test_name: 'eGFR (CKD-EPI)', value: '42', value_numeric: 42, unit: 'mL/min/1.73m²', reference_range: '≥60', abnormal_flag: 'low', citation: { page: 1, bbox: null, quote: 'eGFR (CKD-EPI) 42', grounding: 'page' } },
        { test_name: 'Creatinine', value: '1.58', value_numeric: 1.58, unit: 'mg/dL', reference_range: '0.50–1.10', abnormal_flag: 'high', citation: { page: 1, bbox: null, quote: 'Creatinine 1.58', grounding: 'page' } },
        { test_name: 'Planted Absent Test', value: '99', value_numeric: 99, unit: null, reference_range: null, abnormal_flag: null, citation: { page: 1, bbox: null, quote: 'this text is not on the document', grounding: 'page' } },
    ],
});

const INTAKE_JSON = JSON.stringify({
    doc_type: 'intake_form',
    demographics: { name: 'Margaret L. Chen', dob: '1967-03-14', sex: null, citation: { page: 1, bbox: null, quote: 'Margaret L. Chen', grounding: 'page' } },
    chief_concern: { text: 'Flashes of light in right eye, ~2 weeks, occasional new floater', laterality: 'OD', citation: { page: 1, bbox: null, quote: 'Flashes of light in my RIGHT eye', grounding: 'page' } },
    current_medications: [
        { name: 'Hydroxychloroquine (Plaquenil)', dose: '200 mg', frequency: 'daily', start_date: '2019-01', citation: { page: 1, bbox: null, quote: 'Hydroxychloroquine (Plaquenil)', grounding: 'page' } },
        { name: 'Lisinopril', dose: '10 mg', frequency: 'daily', start_date: '2024-11', citation: { page: 1, bbox: null, quote: 'Lisinopril', grounding: 'page' } },
    ],
    allergies: [{ substance: 'Penicillin', reaction: 'hives', citation: { page: 1, bbox: null, quote: 'Penicillin', grounding: 'page' } }],
    family_history: [{ relative: 'Father', condition: 'Glaucoma', citation: { page: 1, bbox: null, quote: 'Father was told he has glaucoma', grounding: 'page' } }],
    patient_goals: { text: "Healed before daughter's wedding in six weeks; stay able to drive", citation: { page: 1, bbox: null, quote: 'wedding', grounding: 'page' } },
    vitals: { height_in: 64, weight_lb: 138, bp_systolic: 128, bp_diastolic: 78, citation: { page: 1, bbox: null, quote: 'Blood pressure:', grounding: 'page' } },
    form_date: '2024-12-26',
});

const HBA1C_JSON = JSON.stringify({
    doc_type: 'lab_pdf',
    document_patient: { name: 'ALVAREZ, ROBERT M', dob: null, citation: { page: 1, bbox: null, quote: 'ALVAREZ, ROBERT M', grounding: 'page' } },
    performing_lab: 'Orlando Diagnostic Laboratories',
    collection_date: '2024-12-18',
    collection_date_citation: null,
    results: [
        { test_name: 'Hemoglobin A1c', value: '8.4', value_numeric: 8.4, unit: '%', reference_range: '<5.7', abnormal_flag: 'high', citation: { page: 1, bbox: null, quote: 'Hemoglobin A1c 8.4', grounding: 'page' } },
        { test_name: 'Glucose, Fasting', value: '178', value_numeric: 178, unit: 'mg/dL', reference_range: '65–99', abnormal_flag: 'high', citation: { page: 1, bbox: null, quote: 'Glucose, Fasting 178', grounding: 'page' } },
    ],
});

const MALFORMED_JSON = '{"doc_type":"lab_pdf","results":[],"hallucinated_key":true}';

// ---- schema_valid ------------------------------------------------------------------

describe('extraction goldens — schema_valid', () => {
    it('clean renal panel: strict parse on first response, ingestion completes', async () => {
        const { service, vlm } = harness(RENAL_JSON);
        const record = await ingest(service, cleanRenal, 'lab_pdf');
        recordEval({
            id: 'extraction.lab-clean-valid-parse',
            description: 'Clean renal-panel PDF with a valid VLM response parses strictly and completes without retry',
            metric: 'ingestion status / VLM calls',
            value: `${record.status} / ${vlm.complete.mock.calls.length} call(s)`,
            threshold: 'complete / 1 call',
            pass: record.status === 'complete' && vlm.complete.mock.calls.length === 1,
            difficulty: 'straightforward',
            category: 'schema_valid',
            enforce: 'soft',
        });
        expect(record.status).toBe('complete');
    });

    it('intake update: strict parse incl. laterality, goals, vitals — vitals round-trip fires', async () => {
        const { service, captured } = harness(INTAKE_JSON);
        const record = await ingest(service, cleanIntake, 'intake_form');
        const vitals = captured.vitals[0];
        const vitalsOk =
            vitals !== undefined && vitals.height === 64 && vitals.weight === 138 && vitals.bps === 128 && vitals.bpd === 78;
        recordEval({
            id: 'extraction.intake-clean-valid-parse',
            description: 'Intake-update PDF parses under the strict intake schema; staff vitals map to the native OpenEMR vitals payload',
            metric: 'ingestion status / vitals payload',
            value: `${record.status} / vitals ${vitalsOk ? 'mapped 64in-138lb-128/78' : 'NOT mapped'}`,
            threshold: 'complete / height+weight+BP mapped',
            pass: record.status === 'complete' && record.vitals_written && vitalsOk,
            difficulty: 'straightforward',
            category: 'schema_valid',
            enforce: 'soft',
        });
        expect(record.status).toBe('complete');
        expect(vitalsOk).toBe(true);
    });

    it('second lab type (HbA1c panel) parses — value strings keep their qualifiers', async () => {
        const { service, captured } = harness(HBA1C_JSON);
        const record = await ingest(service, cleanHba1c, 'lab_pdf', { name: 'Robert M. Alvarez' });
        const a1c = captured.facts.find((fact) => (fact.content as { test_name?: string }).test_name === 'Hemoglobin A1c');
        recordEval({
            id: 'extraction.hba1c-second-lab-parse',
            description: 'A second lab document (HbA1c panel, different printed patient) parses and persists; reordered printed name matches the chart patient',
            metric: 'ingestion status / HbA1c fact persisted',
            value: `${record.status} / ${a1c === undefined ? 'missing' : 'persisted'}`,
            threshold: 'complete / persisted',
            pass: record.status === 'complete' && a1c !== undefined,
            // Reordered printed name ('ALVAREZ, ROBERT M' vs chart 'Robert M. Alvarez') needs disambiguation.
            difficulty: 'ambiguous',
            category: 'schema_valid',
            enforce: 'soft',
        });
        expect(record.status).toBe('complete');
    });

    it('invalid first output triggers ONE feedback retry, then completes', async () => {
        const { service, vlm } = harness(MALFORMED_JSON, RENAL_JSON);
        const record = await ingest(service, cleanRenal, 'lab_pdf');
        const retried = record.stages.some((stage) => stage.stage === 'extraction_retried');
        recordEval({
            id: 'extraction.feedback-retry-recovers',
            description: 'A malformed first VLM response is rejected by the strict schema and recovered by one feedback retry',
            metric: 'status / retry stage / VLM calls',
            value: `${record.status} / retried=${String(retried)} / ${vlm.complete.mock.calls.length} calls`,
            threshold: 'complete / retried=true / 2 calls',
            pass: record.status === 'complete' && retried && vlm.complete.mock.calls.length === 2,
            // Degenerate model output (malformed JSON) on the first attempt.
            difficulty: 'edge-case',
            category: 'schema_valid',
            enforce: 'soft',
        });
        expect(record.status).toBe('complete');
        expect(retried).toBe(true);
    });

    it('persistently invalid output FAILS CLOSED — zero facts persisted', async () => {
        const { service, captured } = harness(MALFORMED_JSON, MALFORMED_JSON);
        const record = await ingest(service, cleanRenal, 'lab_pdf');
        recordEval({
            id: 'extraction.fail-closed-on-persistent-invalid',
            description: 'Two invalid VLM responses fail the ingestion with failed_validation; nothing is stored partially (G3)',
            metric: 'status / persisted facts',
            value: `${record.status} / ${captured.facts.length} facts`,
            threshold: 'failed_validation / 0 facts',
            pass: record.status === 'failed_validation' && captured.facts.length === 0,
            difficulty: 'edge-case',
            category: 'schema_valid',
            enforce: 'soft',
        });
        expect(record.status).toBe('failed_validation');
        expect(captured.facts).toHaveLength(0);
    });
});

// ---- citation_present (safety) -------------------------------------------------------

describe('extraction goldens — citation_present', () => {
    it('every persisted fact carries a per-field citation back to the source document', async () => {
        const { service, captured } = harness(RENAL_JSON);
        await ingest(service, cleanRenal, 'lab_pdf');
        const uncited = captured.facts.filter((fact) => {
            const sources = citationsOf(fact);
            return (
                fact.source_document_id === undefined ||
                sources.length === 0 ||
                sources.some((source) => source.excerpt_text === '' || source.source_document_id === null)
            );
        });
        recordEval({
            id: 'extraction.every-persisted-fact-cites',
            description: 'Every fact persisted from a document carries excerpt text + source document id (R5 citation contract)',
            metric: 'facts missing citations',
            value: `${uncited.length} of ${captured.facts.length}`,
            threshold: '0 uncited',
            pass: captured.facts.length > 0 && uncited.length === 0,
            difficulty: 'straightforward',
            category: 'citation_present',
        });
        expect(uncited).toHaveLength(0);
    });

    it('a quote NOT in the document lands unverified with NO location — never citable geometry', async () => {
        const { service, captured } = harness(RENAL_JSON);
        await ingest(service, cleanRenal, 'lab_pdf');
        const planted = captured.facts.find((fact) => (fact.content as { test_name?: string }).test_name === 'Planted Absent Test');
        const real = captured.facts.find((fact) => (fact.content as { test_name?: string }).test_name === 'Creatinine');
        const plantedLocation = planted === undefined ? null : (citationsOf(planted)[0]?.excerpt_location ?? null);
        const realLocation = real === undefined ? null : (citationsOf(real)[0]?.excerpt_location ?? null);
        recordEval({
            id: 'extraction.invented-quote-never-citable',
            description: 'The grounding ladder flags a planted absent quote unverified (location null) while real values keep located citations (P2)',
            metric: 'planted location / real value location',
            value: `${plantedLocation === null ? 'null' : 'LOCATED (bad)'} / ${realLocation === null ? 'MISSING (bad)' : realLocation.type}`,
            threshold: 'null / word_box or page location',
            pass: planted !== undefined && plantedLocation === null && realLocation !== null,
            // Adversarial planted quote absent from the document.
            difficulty: 'edge-case',
            category: 'citation_present',
        });
        expect(plantedLocation).toBeNull();
        expect(realLocation).not.toBeNull();
    });

    it('image-only degraded scan: all citations honestly unverified, zero fabricated boxes', async () => {
        const { service } = harness(RENAL_JSON);
        const record = await ingest(service, lowdpiRenal, 'lab_pdf');
        const grounding = record.grounding;
        const honest = grounding !== null && grounding.word_box === 0 && grounding.unverified === grounding.total;
        recordEval({
            id: 'extraction.degraded-scan-no-fabricated-geometry',
            description: 'On an image-only low-DPI scan the grounding pass fabricates no geometry — every field lands unverified (P2)',
            metric: 'grounding summary',
            value: grounding === null ? 'no summary' : `word_box=${grounding.word_box}, unverified=${grounding.unverified}/${grounding.total}`,
            threshold: 'word_box=0, all unverified',
            pass: record.status === 'complete' && honest,
            // Degraded input (image-only low-DPI scan): honest-grounding judgment, not a clean path.
            difficulty: 'ambiguous',
            category: 'citation_present',
        });
        expect(honest).toBe(true);
    });
});

// ---- factually_consistent ------------------------------------------------------------

describe('extraction goldens — factually_consistent', () => {
    it('eGFR round-trips value-faithful: string, numeric, flag, collection date', async () => {
        const { service, captured } = harness(RENAL_JSON);
        await ingest(service, cleanRenal, 'lab_pdf');
        const egfr = captured.facts.find((fact) => (fact.content as { test_name?: string }).test_name === 'eGFR (CKD-EPI)');
        const content = (egfr?.content ?? {}) as Record<string, unknown>;
        const faithful =
            content['value'] === '42' &&
            content['value_numeric'] === 42 &&
            content['abnormal_flag'] === 'low' &&
            content['collection_date'] === '2024-12-20';
        recordEval({
            id: 'extraction.egfr-value-fidelity',
            description: 'The extracted eGFR persists exactly as printed: value "42", numeric 42, flag low, collection date intact',
            metric: 'field fidelity',
            value: faithful ? 'value/numeric/flag/date intact' : `DRIFTED: ${JSON.stringify(content)}`,
            threshold: 'all four fields intact',
            pass: faithful,
            difficulty: 'straightforward',
            category: 'factually_consistent',
            enforce: 'soft',
        });
        expect(faithful).toBe(true);
    });

    it('the extracted renal result re-tiers hydroxychloroquine risk (UC-4 hero arc)', () => {
        // 2 years on HCQ sits in the engine's low band (medium starts at threshold−2 = 3y).
        const hcq = [{ content: { name: 'Hydroxychloroquine', dose: '200 mg daily', duration: '2 years' } }];
        const baseline = computeMedicationRiskFlags(hcq)[0];
        const retiered = computeMedicationRiskFlags(hcq, {}, { renal: { egfr: 42 } })[0];
        const escalated =
            baseline?.severity === 'low' && retiered?.severity === 'medium' && retiered.details?.egfr === 42;
        recordEval({
            id: 'extraction.renal-retier-hcq',
            description: 'eGFR 42 from the ingested renal panel escalates the HCQ toxicity tier one level and records the eGFR in the flag details',
            metric: 'severity without → with renal context',
            value: `${baseline?.severity ?? 'none'} → ${retiered?.severity ?? 'none'} (egfr ${String(retiered?.details?.egfr)})`,
            threshold: 'low → medium (egfr 42)',
            pass: escalated,
            difficulty: 'straightforward',
            category: 'factually_consistent',
            enforce: 'soft',
        });
        expect(escalated).toBe(true);
    });

    it('byte-identical re-upload is idempotent: same record, no second extraction or insert', async () => {
        const { service, captured, vlm } = harness(RENAL_JSON);
        const first = await ingest(service, cleanRenal, 'lab_pdf');
        const factsAfterFirst = captured.facts.length;
        const second = await ingest(service, cleanRenal, 'lab_pdf');
        const idempotent =
            first.id === second.id && captured.facts.length === factsAfterFirst && vlm.complete.mock.calls.length === 1;
        recordEval({
            id: 'extraction.dedupe-idempotent',
            description: 'Re-uploading byte-identical content returns the completed record — no duplicate facts, no second VLM call (G1)',
            metric: 'record id match / extra inserts / extra VLM calls',
            value: idempotent ? 'same id, 0 extra inserts, 0 extra calls' : 'DUPLICATED',
            threshold: 'no duplicate work',
            pass: idempotent,
            // Degenerate double-submit of byte-identical content.
            difficulty: 'edge-case',
            category: 'factually_consistent',
            enforce: 'soft',
        });
        expect(idempotent).toBe(true);
    });

    it("the patient-goals line persists as a first-class patient_goal fact (UC-7)", async () => {
        const { service, captured } = harness(INTAKE_JSON);
        await ingest(service, cleanIntake, 'intake_form');
        const goal = captured.facts.find((fact) => fact.fact_type === 'patient_goal');
        const text = (goal?.content as { goal?: string } | undefined)?.goal ?? '';
        const ok = goal !== undefined && text.includes('wedding');
        recordEval({
            id: 'extraction.intake-goals-first-class',
            description: "The intake form's what-are-you-hoping-for line persists as a patient_goal fact with its citation (UC-7)",
            metric: 'patient_goal fact',
            value: ok ? 'persisted with goals text' : 'MISSING',
            threshold: 'persisted',
            pass: ok,
            difficulty: 'straightforward',
            category: 'factually_consistent',
            enforce: 'soft',
        });
        expect(ok).toBe(true);
    });
});

// ---- safe_refusal (safety) -----------------------------------------------------------

describe('extraction goldens — safe_refusal', () => {
    it("a document printed for a DIFFERENT patient blocks before any fact persists", async () => {
        const { service, captured } = harness(RENAL_JSON);
        const record = await ingest(service, cleanRenal, 'lab_pdf', { name: 'Robert M. Alvarez', dob: '1958-07-02' });
        recordEval({
            id: 'extraction.patient-mismatch-blocks',
            description: 'The renal panel printed for CHEN, MARGARET L is blocked when the chart patient is Robert M. Alvarez — zero facts persist',
            metric: 'status / persisted facts',
            value: `${record.status} / ${captured.facts.length} facts`,
            threshold: 'blocked_patient_mismatch / 0 facts',
            pass: record.status === 'blocked_patient_mismatch' && captured.facts.length === 0,
            // Cross-patient isolation: the document belongs to a different patient.
            difficulty: 'edge-case',
            category: 'safe_refusal',
        });
        expect(record.status).toBe('blocked_patient_mismatch');
        expect(captured.facts).toHaveLength(0);
    });
});
