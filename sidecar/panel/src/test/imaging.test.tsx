// Imaging workstation tests (S2.2): timeline merge/order + badges, trend series
// extraction, interval recommendation rendering, compare 4-max, and the ScanImage
// placeholder/pixel seam — all against the William Thompson-faithful fixture.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import App from '../App';
import Imaging, { mergeTimeline } from '../imaging/Imaging';
import Trends, { extractMeasurementSeries } from '../imaging/Trends';
import ScanImage from '../imaging/ScanImage';
import { briefContent, storedBrief } from './fixtures';
import { mcGcImages, wtBriefContent, wtFactBundle, wtImages, wtImaging, wtTreatments } from './imaging-fixtures';

afterEach(() => {
    vi.unstubAllGlobals();
});

function renderImaging() {
    return render(<Imaging imaging={wtImaging} images={wtImages} treatments={wtTreatments} />);
}

describe('Imaging timeline', () => {
    // Failure mode: images and injections render as separate lists (or in insertion order)
    // instead of one reverse-chronological stream — the doctor loses the cause->effect story.
    it('merges image and treatment events into one reverse-chronological stream', () => {
        const events = mergeTimeline(wtImages, wtTreatments);
        expect(events).toHaveLength(11); // 7 images + 4 injections
        const dates = events.map((event) => new Date(event.date).getTime());
        expect(dates).toEqual([...dates].sort((a, b) => b - a));

        renderImaging();
        const rows = screen.getAllByTestId('timeline-event');
        expect(rows).toHaveLength(11);
        expect(within(rows[0]!).getByText('Dec 10, 2025')).toBeInTheDocument(); // newest: img-wt-007
        expect(within(rows[rows.length - 1]!).getByText('May 5, 2025')).toBeInTheDocument(); // oldest: img-wt-001
        // Injection rows carry medication + dose + injection number
        expect(within(rows[2]!).getByText('Eylea')).toBeInTheDocument(); // tx-wt-004 (Oct 22)
        expect(within(rows[2]!).getByText(/· 2mg/)).toBeInTheDocument();
        expect(within(rows[2]!).getByText(/Injection #4/)).toBeInTheDocument();
    });

    // Failure mode: the days-post-injection badge drops treatment_context math and the
    // doctor can no longer read response-at-interval off the timeline.
    it('renders days-post-injection badges from treatment_context', () => {
        renderImaging();
        expect(screen.getByText(/71d post-Eylea/)).toBeInTheDocument(); // the 10-week leak scan
        expect(screen.getByText(/28d post-Eylea/)).toBeInTheDocument(); // rescue check
        expect(screen.getAllByText(/49d post-Eylea/)).toHaveLength(4);
    });

    // Failure mode: response badges lose their color coding (worsened rendered like
    // good_response) or the CRT value disappears from image rows.
    it('shows CRT values and color-coded treatment response badges', () => {
        renderImaging();
        expect(screen.getByText('CRT: 385µm')).toBeInTheDocument();
        expect(screen.getAllByText('Good response')).toHaveLength(5);
        const worsened = screen.getByText('Worsened');
        expect(worsened.className).toContain('text-red-700');
        expect(screen.getAllByText('Good response')[0]!.className).toContain('text-emerald-700');
    });

    // Failure mode: the treat-and-extend recommendation (server-computed) never surfaces
    // on the default view — it must ride the Timeline sub-tab as in the prototype.
    it('renders the interval recommendation banner with counts and confidence', () => {
        renderImaging();
        const banner = screen.getByTestId('interval-banner');
        expect(banner).toHaveTextContent('Optimal interval: 7 weeks');
        expect(banner).toHaveTextContent('5 dry');
        expect(banner).toHaveTextContent('1 leaked');
        expect(banner).toHaveTextContent('Patient stable at 7 weeks but leaked at 10 weeks. Recommend 7-week intervals.');
        expect(banner).toHaveTextContent('high confidence');
    });
});

describe('Imaging intervals', () => {
    // Failure mode: the Intervals view recomputes (or mangles) the engine's analysis
    // instead of rendering brief.content.imaging.interval_analysis verbatim.
    it('renders the interval table, pattern summary, and recommendation callout', () => {
        renderImaging();
        fireEvent.click(screen.getByRole('tab', { name: /Intervals/ }));
        expect(screen.getByText('Treatment Interval Analysis')).toBeInTheDocument();
        // Stat grid: 6 cycles / 5 good / 1 poor / avg 7
        expect(screen.getByText('Treatment Cycles').previousSibling).toHaveTextContent('6');
        expect(screen.getByText('Good Response').previousSibling).toHaveTextContent('5');
        expect(screen.getByText('Poor Response').previousSibling).toHaveTextContent('1');
        // The 10-week trial leaked; the 4-week rescue was dry
        expect(screen.getAllByText('7 weeks')).toHaveLength(4);
        expect(screen.getByText('10 weeks').parentElement?.parentElement).toHaveTextContent('Leaked');
        expect(screen.getByText('4 weeks').parentElement?.parentElement).toHaveTextContent('Dry');
        expect(screen.getByText(/Recommend 7-week intervals/)).toBeInTheDocument();
    });
});

describe('Imaging trends', () => {
    // Failure mode: the series extraction grabs the wrong measurement_type or loses
    // date ordering — the chart would plot garbage that still looks plausible.
    it('extracts measurement series in ascending date order', () => {
        const crt = extractMeasurementSeries(wtImages, 'central_retinal_thickness');
        expect(crt.map((point) => point.value)).toEqual([385, 266, 270, 264, 331, 268, 262]);
        expect(crt[0]!.dateLabel).toBe('May 5');
        const gc = extractMeasurementSeries(mcGcImages, 'ganglion_cell_thickness', 'month-year');
        expect(gc.map((point) => point.value)).toEqual([82, 70]);
        expect(gc[1]!.dateLabel).toBe('Dec 2024');
        expect(extractMeasurementSeries(wtImages, 'ganglion_cell_thickness')).toEqual([]);
    });

    // Failure mode: the HCQ card renders for non-HCQ patients (no GC data), or the
    // detected-progression alert loses its description/recommendation.
    it('shows the CRT chart for WT and the HCQ progression card only with GC data', () => {
        renderImaging();
        fireEvent.click(screen.getByRole('tab', { name: /Trends/ }));
        expect(screen.getByText('Central Retinal Thickness Over Time')).toBeInTheDocument();
        expect(screen.queryByText('HCQ Toxicity Monitoring')).not.toBeInTheDocument();

        render(<Trends images={mcGcImages} hcq={briefContent.imaging.hcq_progression} />);
        expect(screen.getByText('HCQ Toxicity Monitoring')).toBeInTheDocument();
        expect(screen.getByText('Ganglion cell layer declined 12µm across serial OCTs')).toBeInTheDocument();
        expect(screen.getByText(/discuss HCQ dosing with rheumatology/)).toBeInTheDocument();
    });
});

describe('Imaging compare', () => {
    // Failure mode: the 4-image cap silently drops or the per-image change badge
    // disappears — side-by-side reading depends on both.
    it('caps selection at 4 side-by-side cards and badges each with its overall change', () => {
        renderImaging();
        fireEvent.click(screen.getByRole('tab', { name: /Compare/ }));
        const checkboxes = screen.getAllByRole('checkbox');
        expect(checkboxes).toHaveLength(7);
        for (const checkbox of checkboxes) {
            fireEvent.click(checkbox); // try to select all seven
        }
        expect(screen.getByText('4/4 images selected')).toBeInTheDocument();
        const grid = screen.getByTestId('compare-grid');
        expect(within(grid).getAllByTestId('scan-placeholder')).toHaveLength(4);
        expect(checkboxes[4]).toBeDisabled(); // img-wt-005 could not join a full grid

        // Free a slot, add the leak scan: its worsened badge must be visible on the card.
        fireEvent.click(checkboxes[0]!); // deselect img-wt-001
        fireEvent.click(checkboxes[4]!); // select img-wt-005
        expect(within(screen.getByTestId('compare-grid')).getByText('worsened')).toBeInTheDocument();
        expect(within(screen.getByTestId('compare-grid')).getByText(/71d post-tx/)).toBeInTheDocument();
    });
});

describe('ScanImage seam', () => {
    // Failure mode: a record without pixels renders a broken <img> instead of the
    // schematic card, or a record WITH a storage_key keeps showing the placeholder.
    it('renders the metadata placeholder when storage_key is null and a real img when set', () => {
        const bare = { ...wtImages[0]!, dataset_class: 'CNV' };
        const { unmount } = render(<ScanImage image={bare} detail />);
        const placeholder = screen.getByTestId('scan-placeholder');
        expect(placeholder).toHaveTextContent('OCT');
        expect(placeholder).toHaveTextContent('OD');
        expect(placeholder).toHaveTextContent('May 5, 2025');
        expect(placeholder).toHaveTextContent('CNV');
        expect(placeholder).toHaveTextContent(/image pending/i);
        expect(screen.queryByRole('img')).not.toBeInTheDocument();
        unmount();

        render(<ScanImage image={{ ...bare, storage_key: 'img-wt-001.jpeg' }} detail />);
        const img = screen.getByRole('img');
        expect(img).toHaveAttribute('src', '/api/images/img-wt-001.jpeg');
        expect(img).toHaveAttribute('alt', 'OCT OD — May 5, 2025');
        expect(screen.queryByTestId('scan-placeholder')).not.toBeInTheDocument();
    });
});

describe('App imaging tab', () => {
    // Failure mode: the Imaging tab lands in the wrong slot (or never mounts the
    // workstation) — it must sit between Medical Background and Sources per S2.2.
    it('adds the Imaging tab between Medical Background and Sources and renders the timeline', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input);
                const body = url.includes('/api/brief/')
                    ? { ...storedBrief, content: wtBriefContent }
                    : url.includes('/api/facts/')
                      ? wtFactBundle
                      : undefined;
                if (body === undefined) {
                    throw new Error(`unstubbed fetch: ${url}`);
                }
                return { ok: true, status: 200, json: async () => body } as Response;
            }),
        );
        render(<App />);
        const tabs = await screen.findAllByRole('tab');
        expect(tabs.map((tab) => tab.textContent)).toEqual([
            'Overview',
            'Medical Background',
            'Imaging',
            'Diagnosis & Care',
            'Sources',
        ]);
        fireEvent.click(screen.getByRole('tab', { name: 'Imaging' }));
        expect(screen.getByText('7 images · 4 treatments')).toBeInTheDocument();
        expect(screen.getAllByTestId('timeline-event')).toHaveLength(11);
        expect(screen.getByTestId('interval-banner')).toBeInTheDocument();
    });
});
