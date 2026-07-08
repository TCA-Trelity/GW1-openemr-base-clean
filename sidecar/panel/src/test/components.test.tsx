// Component tests: citation chip/source card behavior, Medical Background badges,
// and the Sources tab list + highlight rendering.
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CitationChip } from '../CitationChip';
import MedicalBackground from '../MedicalBackground';
import SourcesTab from '../SourcesTab';
import { HCQ_EXCERPT, bareCitation, briefContent, documents, hcqCitation } from './fixtures';

describe('CitationChip', () => {
    // Failure mode: the source card paraphrases or truncates the excerpt — the chip's
    // whole point is the VERBATIM cited span, visually distinct from its context.
    it('opens a source card with the verbatim excerpt highlighted inside its context', () => {
        const { container } = render(<CitationChip citation={hcqCitation} index={1} />);
        fireEvent.click(screen.getByRole('button', { name: /Citation 1/ }));

        const card = screen.getByRole('dialog');
        // Type badge + label + date + attribution
        expect(within(card).getByText('Prior Visit')).toBeInTheDocument();
        expect(within(card).getByText('Rheumatology office note - Dr. Anita Patel')).toBeInTheDocument();
        expect(within(card).getByText('Sep 10, 2024')).toBeInTheDocument();
        expect(within(card).getByText('Anita Patel, MD')).toBeInTheDocument();
        // The cited span is verbatim and wrapped in <mark>, with context around it
        const mark = container.querySelector('mark');
        expect(mark).not.toBeNull();
        expect(mark?.textContent).toBe(HCQ_EXCERPT);
        // Context around the mark (context_before is a 48-char window, so match its tail)
        expect(within(card).getByText(/MEDICATIONS \(confirmed with patient\)/)).toBeInTheDocument();
    });

    // Failure mode: a citation without excerpt_text renders an empty/broken card
    // instead of stating the absence.
    it('states "No excerpt available" for a citation with no excerpt text', () => {
        render(<CitationChip citation={bareCitation} index={2} />);
        fireEvent.click(screen.getByRole('button', { name: /Citation 2/ }));
        expect(screen.getByText('No excerpt available')).toBeInTheDocument();
    });
});

describe('MedicalBackground', () => {
    // Failure mode: laterality (OD/OS/OU) or verification state stops being visible at
    // a glance — both are load-bearing clinical context on every fact row.
    it('renders facts_by_type groups with laterality and verification badges', () => {
        render(<MedicalBackground factsByType={briefContent.facts_by_type} />);
        // Group cards from the fixture
        expect(screen.getByText('Medications')).toBeInTheDocument();
        expect(screen.getByText('Allergies')).toBeInTheDocument();
        expect(screen.getByText('Family Ocular History')).toBeInTheDocument();
        // Laterality badge on the OD clinical finding + chief complaint
        expect(screen.getAllByText('OD').length).toBeGreaterThanOrEqual(1);
        // All three verification states in the fixture are distinguishable
        expect(screen.getAllByText('Verified').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('Unverified').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('Patient reported').length).toBeGreaterThanOrEqual(1);
    });
});

describe('SourcesTab', () => {
    // Failure mode: the document list loses its type badge / date / filename triple,
    // or clicking a document no longer surfaces its full text.
    it('lists documents with type badge, date, and filename, and opens full text on click', () => {
        render(<SourcesTab documents={documents} focus={null} onClearFocus={() => undefined} />);
        expect(screen.getByText('2 Documents')).toBeInTheDocument();
        expect(screen.getByText('Clinical Note')).toBeInTheDocument(); // type badge
        expect(screen.getByText('rheum_note_sept2024.pdf')).toBeInTheDocument(); // filename
        expect(screen.getAllByText('Sep 10, 2024').length).toBeGreaterThanOrEqual(1); // date

        fireEvent.click(screen.getByRole('button', { name: /rheum_note_sept2024\.pdf/ }));
        expect(screen.getByText(/ORLANDO RHEUMATOLOGY ASSOCIATES/)).toBeInTheDocument();
    });

    // Failure mode: the character-range highlight drifts (wrong offsets, mutated text)
    // and marks the wrong span — worse than no highlight in a clinical UI.
    it('highlights exactly the cited character range in the full document text', () => {
        const location = hcqCitation.excerpt_location;
        const { container } = render(
            <SourcesTab
                documents={documents}
                focus={{
                    documentId: 'doc-mc-003',
                    start: location?.start_char ?? null,
                    end: location?.end_char ?? null,
                    excerpt: hcqCitation.excerpt_text,
                }}
                onClearFocus={() => undefined}
            />,
        );
        // Focus auto-opens the document and marks the span.
        const mark = container.querySelector('#citation-highlight');
        expect(mark).not.toBeNull();
        expect(mark?.textContent).toBe(HCQ_EXCERPT);
        expect(screen.getByText('Showing citation location.')).toBeInTheDocument();
    });

    // Failure mode: an empty bundle (documents not yet served by /api/facts) crashes
    // the tab instead of degrading to an explicit empty state.
    it('renders an explicit empty state when the bundle carries no documents', () => {
        render(<SourcesTab documents={[]} focus={null} onClearFocus={() => undefined} />);
        expect(screen.getByText('No source documents available for this patient.')).toBeInTheDocument();
    });

    // Failure mode (S2.12): provenance stops being visible at a glance — how a document
    // arrived (fax/portal/upload), its raw filename, and its OCR confidence all matter
    // when a doctor weighs a source.
    it('elevates received method, filename, and OCR quality badges on the document list', () => {
        render(<SourcesTab documents={documents} focus={null} onClearFocus={() => undefined} />);
        // extras.received_method badge
        expect(screen.getByText('Patient Upload')).toBeInTheDocument();
        // content.ocr_quality badge, amber below 90%
        const ocrBadge = screen.getByText('OCR 88%');
        expect(ocrBadge.className).toContain('text-amber-700');
        // extras.filename: title for the transcript (no metadata), sub-line under the pdf title
        expect(screen.getByText('intake-transcript-2024-12-26.txt')).toBeInTheDocument();
        expect(screen.getByText('rheumatology-note-2024-09-10.txt')).toBeInTheDocument();

        // The viewer header repeats the provenance line
        fireEvent.click(screen.getByRole('button', { name: /rheum_note_sept2024\.pdf/ }));
        expect(screen.getByText(/via patient_upload · received Dec 16, 2024 · OCR 88%/)).toBeInTheDocument();
    });
});
