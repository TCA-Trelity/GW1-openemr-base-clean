// Imaging workstation tests (S2.2): timeline merge/order + badges, trend series
// extraction, interval recommendation rendering, compare 4-max, and the ScanImage
// placeholder/pixel seam — all against the William Thompson-faithful fixture.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import App from '../App';
import Imaging, { mergeTimeline } from '../imaging/Imaging';
import Trends, { extractMeasurementSeries, selectedPoint } from '../imaging/Trends';
import ScanImage from '../imaging/ScanImage';
import { deriveFluidStatus } from '../imaging/fluid';
import { buildLadderData, OUTCOME_FILL } from '../imaging/IntervalLadder';
import { briefContent } from './fixtures';
import {
    mcGcImages,
    mcImages,
    mcImaging,
    wtFactBundle,
    wtImages,
    wtImaging,
    wtIntervalAnalysis,
    wtOverview,
    wtPatient,
    wtTreatments,
} from './imaging-fixtures';

/** Click the Timeline sub-tab (the merged image+injection stream is no longer the default view). */
function openTimeline() {
    fireEvent.click(screen.getByRole('tab', { name: /Timeline/ }));
}

afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
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
        openTimeline();
        const rows = screen.getAllByTestId('timeline-event');
        expect(rows).toHaveLength(11);
        expect(within(rows[0]!).getByText('Dec 10, 2025')).toBeInTheDocument(); // newest: img-wt-007
        expect(within(rows[rows.length - 1]!).getByText('May 5, 2025')).toBeInTheDocument(); // oldest: img-wt-001
        // Injection rows carry medication + dose + injection number; the Oct 22 scan
        // (11:30Z) sorts above the same-day injection, so tx-wt-004 is row 3.
        expect(within(rows[3]!).getByText('Eylea')).toBeInTheDocument();
        expect(within(rows[3]!).getByText(/· 2mg/)).toBeInTheDocument();
        expect(within(rows[3]!).getByText(/Injection #4/)).toBeInTheDocument();
    });

    // Failure mode: the days-post-injection badge drops treatment_context math and the
    // doctor can no longer read response-at-interval off the timeline.
    it('renders days-post-injection badges from treatment_context', () => {
        renderImaging();
        openTimeline();
        expect(screen.getByText(/71d post-Eylea/)).toBeInTheDocument(); // the 10-week leak scan
        expect(screen.getByText(/28d post-Eylea/)).toBeInTheDocument(); // rescue check
        expect(screen.getAllByText(/49d post-Eylea/)).toHaveLength(4);
    });

    // Failure mode: response badges lose their color coding (worsened rendered like
    // good_response) or the CRT value disappears from image rows.
    it('shows CRT values and color-coded treatment response badges', () => {
        renderImaging();
        openTimeline();
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
        openTimeline();
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

describe('Imaging workspace — scan open + fluid + deltas', () => {
    // Failure mode: selecting a scan goes nowhere (or opens a bare lightbox) — it must open the
    // image-first workspace: viewer center-stage, acquisition metadata in the left margin, the
    // findings + measurements analysis in the right margin (fluid chip, delta vs prior AND vs
    // baseline, reference band), with the Trends chart directly beneath.
    it('opens the selected scan in the workspace from a timeline row, with margins + deltas', () => {
        renderImaging();
        openTimeline();
        fireEvent.click(screen.getByRole('button', { name: 'Open OCT OD — Oct 22, 2025' }));
        const workspace = screen.getByTestId('workspace');

        // LEFT margin (acquisition) binds to the selected scan
        expect(within(workspace).getByTestId('acquisition-margin')).toHaveTextContent('Oct 22, 2025');
        // Headline + overall-change badge from the record's own ai_analysis
        expect(within(workspace).getByText('Fluid recurrence at extended 10-week interval')).toBeInTheDocument();
        expect(within(workspace).getByText('worsened')).toBeInTheDocument();
        // Fluid chip derives WET from the subretinal-fluid finding (must-have #1)
        expect(within(workspace).getByTestId('fluid-chip')).toHaveAttribute('data-fluid-state', 'wet');
        // High alert row
        expect(within(workspace).getByText('Fluid recurrence — interval extension failed')).toBeInTheDocument();
        // Findings: severity-styled one-line rows with confidence
        const findings = within(workspace).getAllByTestId('finding-row');
        expect(findings).toHaveLength(2);
        expect(findings[0]).toHaveTextContent('Subretinal Fluid');
        expect(findings[0]).toHaveTextContent('moderate');
        expect(findings[0]).toHaveTextContent('94%');
        expect(findings[1]).toHaveTextContent('Pigment Epithelial Detachment');
        // Measurement: value + reference band + delta vs prior (264->331) AND vs baseline (385->331)
        const measurement = within(workspace).getByTestId('measurement-row');
        expect(measurement).toHaveTextContent('Central Retinal Thickness');
        expect(measurement).toHaveTextContent('331');
        expect(measurement).toHaveTextContent('normal 240–280');
        const priorDelta = within(workspace).getByTestId('measurement-delta');
        expect(priorDelta).toHaveTextContent('+67 vs prior');
        expect(priorDelta.className).toContain('text-red-700'); // CST rise = worse -> red
        const baselineDelta = within(workspace).getByTestId('measurement-baseline-delta');
        expect(baselineDelta).toHaveTextContent('-54 vs base');
        expect(baselineDelta.className).toContain('text-emerald-700'); // below baseline = better -> emerald
        // Treatment context + treatment-response assessment
        expect(within(workspace).getByTestId('treatment-context-badge')).toHaveTextContent('71d post-Eylea');
        expect(within(workspace).getByText('Worsened')).toBeInTheDocument();
        // Trends chart rides directly beneath — no sub-tab hop
        expect(within(workspace).getByText('Central Retinal Thickness Over Time')).toBeInTheDocument();

        // Back returns to the timeline; Compare stays reachable throughout
        expect(screen.getByRole('tab', { name: /Compare/ })).toBeInTheDocument();
        fireEvent.click(within(workspace).getByRole('button', { name: /Back to timeline/i }));
        expect(screen.getAllByTestId('timeline-event')).toHaveLength(11);
    });

    // Failure mode: the filmstrip is decorative — clicking a thumbnail must actually swap the
    // main scan AND every margin/analysis around it (the whole point of an image-first scrubber).
    it('scrubs the series via the filmstrip, swapping the main scan and its margins', () => {
        renderImaging(); // default workspace, latest scan (Dec 10) selected
        const workspace = screen.getByTestId('workspace');
        expect(within(workspace).getAllByTestId('filmstrip-thumb')).toHaveLength(7); // full OD series
        expect(within(workspace).getByTestId('acquisition-margin')).toHaveTextContent('Dec 10, 2025');
        expect(within(workspace).getByTestId('fluid-chip')).toHaveAttribute('data-fluid-state', 'dry');

        // Select the baseline thumbnail (May 5) — main scan + margins + analysis all swap
        fireEvent.click(within(workspace).getByRole('button', { name: 'Show OCT OD — May 5, 2025' }));
        expect(within(workspace).getByTestId('acquisition-margin')).toHaveTextContent('May 5, 2025');
        expect(within(workspace).getByTestId('fluid-chip')).toHaveAttribute('data-fluid-state', 'wet'); // baseline had SRF
        expect(within(workspace).getByTestId('measurement-row')).toHaveTextContent('385');
        // The baseline scan has no prior and no earlier baseline — no delta chips (never zero-filled)
        expect(within(workspace).queryByTestId('measurement-delta')).not.toBeInTheDocument();
        expect(within(workspace).queryByTestId('measurement-baseline-delta')).not.toBeInTheDocument();
    });
});

describe('Fluid wet/dry derivation', () => {
    // Failure mode: PED (which persists in a treated dry macula) flips the call to wet, or an
    // unread scan is silently called dry.
    it('derives wet from SRF, dry from a PED-only macula, and unknown without analysis', () => {
        const leak = wtImages.find((image) => image.id === 'img-wt-005');
        expect(deriveFluidStatus(leak?.ai_analysis).state).toBe('wet');

        const dry = wtImages.find((image) => image.id === 'img-wt-007');
        const dryStatus = deriveFluidStatus(dry?.ai_analysis);
        expect(dryStatus.state).toBe('dry');
        expect(dryStatus.pedPresent).toBe(true); // PED present but does not make it wet

        // Margaret's parafoveal RPE/thinning is not fluid -> dry
        expect(deriveFluidStatus(mcImages[mcImages.length - 1]?.ai_analysis).state).toBe('dry');
        // No analysis -> unknown (never assert dry for an unread scan)
        expect(deriveFluidStatus(null).state).toBe('unknown');
    });
});

describe('Visit summary strip', () => {
    // Failure mode: the strip stops computing baseline deltas, or renders a fixed card set that
    // fabricates metrics a patient lacks (e.g. a GC card for William, an interval card for HCQ).
    it('computes the baseline->latest CST delta and shows William interval (no GC card)', () => {
        renderImaging();
        const strip = screen.getByTestId('visit-summary-strip');
        expect(strip).toHaveTextContent('Central Thickness');
        expect(strip).toHaveTextContent('262'); // latest
        expect(strip).toHaveTextContent('-123 vs base'); // 385 -> 262
        expect(strip).toHaveTextContent('baseline 385');
        expect(strip).toHaveTextContent('normal 240–280');
        expect(within(strip).getByTestId('fluid-chip')).toHaveAttribute('data-fluid-state', 'dry');
        expect(within(strip).getByTestId('summary-interval-outcome')).toHaveTextContent('Dry');
        expect(strip).toHaveTextContent('Latest interval');
        // Graceful omit: William has no ganglion-cell measurement, so no GC card
        expect(within(strip).queryByText('Ganglion Cell (GC-IPL)')).not.toBeInTheDocument();
        expect(within(strip).getByTestId('summary-alert-level')).toHaveAttribute('data-alert-level', 'low');
    });

    // Failure mode: the strip can't degrade for a non-injection patient — it shows an empty/zeroed
    // interval card and drops the GC-IPL number that actually matters for HCQ.
    it('degrades gracefully for Margaret: CST + GC cards, no interval card, medium HCQ alert', () => {
        render(<Imaging imaging={mcImaging} images={mcImages} treatments={[]} />);
        const strip = screen.getByTestId('visit-summary-strip');
        expect(strip).toHaveTextContent('Central Thickness');
        expect(within(strip).getByText('Ganglion Cell (GC-IPL)')).toBeInTheDocument();
        expect(strip).toHaveTextContent('-12 vs base'); // GC 82 -> 70
        // No injections -> no interval card
        expect(within(strip).queryByTestId('summary-interval-outcome')).not.toBeInTheDocument();
        expect(within(strip).queryByText('Latest interval')).not.toBeInTheDocument();
        expect(within(strip).getByTestId('fluid-chip')).toHaveAttribute('data-fluid-state', 'dry');
        expect(within(strip).getByTestId('summary-alert-level')).toHaveAttribute('data-alert-level', 'medium');
    });
});

describe('Interval ladder', () => {
    // Failure mode: the ladder mis-maps outcomes to colors, hiding the over-extension that the
    // whole treat-and-extend view exists to surface.
    it('maps each cycle to weeks + an outcome color, exposing the 49->71d over-extension', () => {
        const data = buildLadderData(wtIntervalAnalysis);
        expect(data.map((datum) => datum.weeks)).toEqual([7, 7, 7, 10, 4, 7]);
        expect(data.map((datum) => OUTCOME_FILL[datum.outcome])).toEqual([
            OUTCOME_FILL.good_response,
            OUTCOME_FILL.good_response,
            OUTCOME_FILL.good_response,
            OUTCOME_FILL.worsened, // the 10-week over-extension leaked (red)
            OUTCOME_FILL.good_response,
            OUTCOME_FILL.good_response,
        ]);
        const overExtension = data.find((datum) => datum.weeks === 10);
        expect(overExtension?.outcome).toBe('worsened');
        expect(OUTCOME_FILL.worsened).toBe('#ef4444');
        expect(overExtension!.weeks).toBeGreaterThan(wtIntervalAnalysis.optimal_interval ?? 0); // above the optimal line
    });

    it('renders the ladder card with an outcome legend on the Intervals tab', () => {
        renderImaging();
        fireEvent.click(screen.getByRole('tab', { name: /Intervals/ }));
        const ladder = screen.getByTestId('interval-ladder');
        expect(ladder).toHaveTextContent('Treat-and-Extend Interval Ladder');
        expect(ladder).toHaveTextContent('Dry (extend)');
        expect(ladder).toHaveTextContent('Leaked (shorten)');
    });
});

describe('Trend selected-scan highlight', () => {
    // Failure mode: the highlight marker floats free of the selected scan, so image + trend stop
    // telling one story.
    it('locates the selected scan on the CST series (and nothing when the date is absent)', () => {
        const crt = extractMeasurementSeries(wtImages, 'central_retinal_thickness', 'day');
        const point = selectedPoint(crt, '2025-10-22T11:30:00Z'); // the leak scan
        expect(point?.value).toBe(331);
        expect(point?.dateLabel).toBe('Oct 22');
        expect(selectedPoint(crt, '2020-01-01T00:00:00Z')).toBeNull();
        expect(selectedPoint(crt, undefined)).toBeNull();
    });
});

describe('Imaging workspace — HCQ patient', () => {
    // Failure mode: the workspace can't render an HCQ patient — it expects CRT-recurrence context
    // and drops the GC-IPL deltas / toxicity card that are the whole point for Margaret.
    it('renders GC-IPL deltas + the HCQ toxicity card, and omits absent injection context', () => {
        render(<Imaging imaging={mcImaging} images={mcImages} treatments={[]} />);
        const workspace = screen.getByTestId('workspace'); // default: latest scan (Dec 2024)
        expect(within(workspace).getByTestId('fluid-chip')).toHaveAttribute('data-fluid-state', 'dry');

        const gcRow = within(workspace)
            .getAllByTestId('measurement-row')
            .find((row) => row.textContent?.includes('Ganglion Cell Thickness'));
        expect(gcRow).toBeDefined();
        expect(within(gcRow!).getByTestId('measurement-delta')).toHaveTextContent('-2 vs prior'); // 72 -> 70
        expect(within(gcRow!).getByTestId('measurement-baseline-delta')).toHaveTextContent('-12 vs base'); // 82 -> 70
        expect(gcRow!).toHaveTextContent('normal 70–95');
        // GC-IPL decline is bad for HCQ (lower_worse) -> red
        expect(within(gcRow!).getByTestId('measurement-delta').className).toContain('text-red-700');

        // Trends beneath: HCQ toxicity card present with the server-computed description
        expect(within(workspace).getByText('HCQ Toxicity Monitoring')).toBeInTheDocument();
        expect(
            within(workspace).getByText('Ganglion cell layer declined 12µm across serial OCTs'),
        ).toBeInTheDocument();
        // No days-post-injection context for a non-injection patient
        expect(within(workspace).queryByTestId('treatment-context-badge')).not.toBeInTheDocument();
    });
});

describe('App imaging tab', () => {
    // Failure mode: the tab bar regresses — Imaging must sit between Medical Background
    // and AI Insights (R2 order), still mounting the workstation from GET /api/overview.
    it('keeps the Imaging tab in the R2 tab order and lands on the workspace', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input);
                const body = url.includes('/api/patients')
                    ? { patients: [wtPatient] }
                    : url.includes('/api/overview/')
                      ? wtOverview
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
            'AI Insights',
            'Diagnosis & Care',
            'Sources',
        ]);
        fireEvent.click(screen.getByRole('tab', { name: 'Imaging' }));
        expect(screen.getByText('7 images · 4 treatments')).toBeInTheDocument();
        // Lands on the image-first workspace with the summary strip across the top
        expect(screen.getByTestId('visit-summary-strip')).toBeInTheDocument();
        expect(screen.getByTestId('workspace')).toBeInTheDocument();
        // Timeline (with its interval-recommendation banner) is one sub-tab away
        fireEvent.click(screen.getByRole('tab', { name: /Timeline/ }));
        expect(screen.getAllByTestId('timeline-event')).toHaveLength(11);
        expect(screen.getByTestId('interval-banner')).toBeInTheDocument();
    });
});
