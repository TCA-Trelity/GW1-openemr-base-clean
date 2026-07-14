// E.1/E.2 tests. Failure modes guarded: the upload card silently swallowing a blocked
// mismatch (it must be loud), the completion callback firing per poll instead of once,
// overlay geometry drifting off the normalized [0,1] contract, and unverified citations
// gaining geometry (they must render as flags, never boxes).
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { IngestionRecordView } from '../api';
import { citationsForDocument, overlayRectStyle } from '../DocumentOverlay';
import DocumentOverlay from '../DocumentOverlay';
import UploadCard from '../UploadCard';

const uploadDocument = vi.hoisted(() => vi.fn());
const fetchIngestion = vi.hoisted(() => vi.fn());
vi.mock('../api', () => ({
    uploadDocument,
    fetchIngestion,
    ingestionFileUrl: (id: string) => `/api/ingestions/${id}/file`,
}));

function record(overrides: Partial<IngestionRecordView>): IngestionRecordView {
    return {
        id: 'ing-abc',
        patient_id: 'pt-1',
        doc_type: 'lab_pdf',
        filename: 'renal.pdf',
        status: 'complete',
        stages: [
            { stage: 'received', at: 't0' },
            { stage: 'grounding', at: 't1' },
            { stage: 'complete', at: 't2' },
        ],
        source_document_id: 'doc-upload-123',
        grounding: { total: 4, word_box: 3, page: 0, unverified: 1, confidence: 0.75 },
        facts_persisted: 3,
        vitals_written: false,
        error: null,
        ...overrides,
    };
}

describe('overlayRectStyle (E.2 geometry contract)', () => {
    it('maps normalized [0,1] bbox to absolute pixels for the rendered page', () => {
        const style = overlayRectStyle({ x: 0.25, y: 0.5, w: 0.2, h: 0.05 }, 800, 1000);
        expect(style.left).toBe('200.0px');
        expect(style.top).toBe('500.0px');
        expect(style.width).toBe('160.0px');
        expect(style.height).toBe('50.0px');
    });

    it('enforces a minimum visible size for hairline boxes', () => {
        const style = overlayRectStyle({ x: 0, y: 0, w: 0.0001, h: 0.0001 }, 1000, 1000);
        expect(parseFloat(String(style.width))).toBeGreaterThanOrEqual(4);
        expect(parseFloat(String(style.height))).toBeGreaterThanOrEqual(4);
    });
});

describe('citationsForDocument', () => {
    const facts = [
        {
            id: 'f1',
            fact_type: 'lab_result',
            content: { test_name: 'eGFR', value: '42' },
            source_document_id: 'doc-upload-123',
            sources: [{ id: 'c1', source_label: 'Lab', source_type: 'lab_report', excerpt_text: 'eGFR 42', excerpt_location: { type: 'page_bbox', page: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.02 }, attribution: null, source_document_id: 'doc-upload-123', document_date: null }],
        },
        { id: 'f2', fact_type: 'medication', content: { name: 'HCQ' }, source_document_id: 'other-doc', sources: [] },
        'not-a-fact',
    ];

    it('keeps only facts of the target document and tolerates malformed rows', () => {
        const entries = citationsForDocument(facts, 'doc-upload-123');
        expect(entries).toHaveLength(1);
        expect(entries[0]!.factLabel).toBe('eGFR 42');
    });

    it('returns empty when the record has no source document id', () => {
        expect(citationsForDocument(facts, null)).toEqual([]);
    });
});

describe('UploadCard (E.1)', () => {
    it('uploads, polls the staged record, fires onIngested ONCE, and offers the overlay', async () => {
        uploadDocument.mockResolvedValue({ ok: true, ingestionId: 'ing-abc' });
        fetchIngestion.mockResolvedValue(record({}));
        const onIngested = vi.fn();
        const onPreview = vi.fn();
        render(<UploadCard patientId="pt-1" onIngested={onIngested} onPreview={onPreview} />);

        const input = screen.getByLabelText('Choose document file');
        const file = new File([new Uint8Array([1, 2, 3])], 'renal.pdf', { type: 'application/pdf' });
        fireEvent.change(input, { target: { files: [file] } });

        await waitFor(() => expect(screen.getByTestId('ingestion-complete')).toBeInTheDocument());
        expect(uploadDocument).toHaveBeenCalledWith('pt-1', file, 'lab_pdf');
        expect(onIngested).toHaveBeenCalledTimes(1);
        expect(screen.getByText(/3 fact\(s\) persisted/)).toBeInTheDocument();
        expect(screen.getByText(/3 tight \/ 0 page-level \/ 1 not\s+located/)).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /View document with citation overlay/ }));
        expect(onPreview).toHaveBeenCalledWith(expect.objectContaining({ id: 'ing-abc' }));
    });

    it('renders the patient-mismatch block loudly and persists nothing quietly', async () => {
        uploadDocument.mockResolvedValue({ ok: true, ingestionId: 'ing-mismatch' });
        fetchIngestion.mockResolvedValue(
            record({ id: 'ing-mismatch', status: 'blocked_patient_mismatch', error: 'document is printed for CHEN, MARGARET L', facts_persisted: 0, grounding: null }),
        );
        render(<UploadCard patientId="pt-1" onIngested={vi.fn()} onPreview={vi.fn()} />);
        const input = screen.getByLabelText('Choose document file');
        fireEvent.change(input, { target: { files: [new File([new Uint8Array([9])], 'x.pdf', { type: 'application/pdf' })] } });
        await waitFor(() => expect(screen.getByTestId('ingestion-blocked')).toBeInTheDocument());
        expect(screen.getByText(/printed patient does not match/)).toBeInTheDocument();
    });

    it('surfaces upload rejection as an inline error', async () => {
        uploadDocument.mockResolvedValue({ ok: false, message: 'doc_type must be one of: lab_pdf, intake_form' });
        render(<UploadCard patientId="pt-1" onIngested={vi.fn()} onPreview={vi.fn()} />);
        fireEvent.change(screen.getByLabelText('Choose document file'), {
            target: { files: [new File([new Uint8Array([9])], 'x.pdf', { type: 'application/pdf' })] },
        });
        await waitFor(() => expect(screen.getByText(/doc_type must be one of/)).toBeInTheDocument());
    });
});

describe('DocumentOverlay (E.2 outcomes)', () => {
    it('always lists the three grounding outcomes; unverified citations render as flags, never boxes', async () => {
        const citations = [
            { factId: 'f1', factLabel: 'eGFR 42', citation: { id: 'c1', source_label: 'Lab', source_type: 'lab_report' as const, excerpt_text: 'eGFR 42', excerpt_location: { type: 'page_bbox' as const, page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.02 }, attribution: null, source_document_id: 'd', document_date: null } },
            { factId: 'f2', factLabel: 'Creatinine 1.58', citation: { id: 'c2', source_label: 'Lab', source_type: 'lab_report' as const, excerpt_text: 'Creatinine 1.58', excerpt_location: { type: 'page' as const, page: 1 }, attribution: null, source_document_id: 'd', document_date: null } },
            { factId: 'f3', factLabel: 'Planted Absent Test 99', citation: { id: 'c3', source_label: 'Lab', source_type: 'lab_report' as const, excerpt_text: 'not on the document', excerpt_location: null, attribution: null, source_document_id: 'd', document_date: null } },
        ];
        render(<DocumentOverlay ingestionId="ing-abc" filename="renal.pdf" citations={citations} onClose={vi.fn()} />);
        expect(screen.getByText('Grounding outcomes')).toBeInTheDocument();
        expect(screen.getByText(/Located — tight geometry \(1\)/)).toBeInTheDocument();
        expect(screen.getByText(/Page-level \(1\)/)).toBeInTheDocument();
        expect(screen.getByText(/Not located — never citable \(1\)/)).toBeInTheDocument();
        const flag = screen.getByTestId('overlay-unverified');
        expect(flag).toHaveTextContent('Planted Absent Test 99');
        expect(flag).toHaveTextContent('excluded from citable claims');
        // jsdom has no canvas/pdf pipeline — the preview degrades but never hides outcomes.
        await waitFor(() => {
            expect(screen.queryByTestId('overlay-bbox') ?? screen.queryByText(/PDF preview unavailable/)).not.toBeNull();
        });
    });
});
