// App-level tests (S2.11/S2.12 realignment): instant deterministic landing from
// /api/overview, day-schedule sidebar + ?patient= deep links, async AI insights card
// (generate/poll/reuse/429), and the chip -> Sources deep link. fetch is stubbed per test.
import { describe, expect, it, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from '../App';
import {
    factBundle,
    overviewNoBrief,
    overviewPayload,
    patients,
    storedBrief,
    williamOverview,
} from './fixtures';
import type { OverviewPayload, PatientRecord } from '../types';

type FetchStub = (url: string, init?: RequestInit) => { status: number; body: unknown } | undefined;

function stubFetch(handler: FetchStub) {
    const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        const result = handler(url, init);
        if (result === undefined) {
            throw new Error(`unstubbed fetch: ${url}`);
        }
        return {
            ok: result.status >= 200 && result.status < 300,
            status: result.status,
            json: async () => result.body,
        } as Response;
    });
    vi.stubGlobal('fetch', mock);
    return mock;
}

interface StubOptions {
    patientList?: PatientRecord[];
    overview?: OverviewPayload;
    /** Per-patient overrides (e.g. william-thompson) on top of `overview` for everyone else. */
    overviews?: Record<string, OverviewPayload>;
    brief?: { status: number; body: unknown };
    prep?: { status: number; body: unknown };
    prepRuns?: { status: number; body: unknown };
}

function stubApp(options: StubOptions = {}) {
    const {
        patientList = patients,
        overview = overviewPayload,
        overviews = {},
        brief = { status: 200, body: storedBrief },
        prep = { status: 202, body: { prep_run_id: 'run-1', correlation_id: 'corr-1' } },
        prepRuns = { status: 200, body: { runs: [] } },
    } = options;
    return stubFetch((url, init) => {
        if (url.includes('/api/patients')) {
            return { status: 200, body: { patients: patientList } };
        }
        if (url.includes('/api/overview/')) {
            const id = decodeURIComponent(url.split('/api/overview/')[1] ?? '');
            return { status: 200, body: overviews[id] ?? overview };
        }
        if (url.includes('/api/facts/')) {
            return { status: 200, body: factBundle };
        }
        if (url.includes('/api/prep-runs/')) {
            return prepRuns;
        }
        if (url.includes('/api/prep/') && init?.method === 'POST') {
            return prep;
        }
        if (url.includes('/api/brief/')) {
            return brief;
        }
        return undefined;
    });
}

function briefCalls(mock: ReturnType<typeof stubFetch>): number {
    return mock.mock.calls.filter(([input]) => String(input).includes('/api/brief')).length;
}

afterEach(() => {
    vi.unstubAllGlobals();
    // Selection pushes ?patient= — reset so the next test starts without a deep link.
    window.history.replaceState(null, '', '/');
});

describe('App landing (deterministic overview)', () => {
    // Failure mode: the landing regresses to gating on the LLM — any /api/brief call
    // before the doctor asks for insights breaks the "instant render" invariant.
    it('renders the full landing from /api/overview without ever calling /api/brief', async () => {
        const mock = stubApp({ overview: overviewNoBrief });
        render(<App />);

        // Patient header band: name + age (from dob at generated_at) + sex + MRN + visit type
        expect(await screen.findByText('57 yrs · Female · MRN FPA-2019-4521')).toBeInTheDocument();
        expect(screen.getAllByText('10:30 AM').length).toBeGreaterThanOrEqual(1); // band + sidebar
        expect(screen.getAllByText('New patient').length).toBeGreaterThanOrEqual(1);
        // Chief complaint card
        expect(screen.getByText(/Floaters and flashes x 2-3 weeks, worse OD/)).toBeInTheDocument();
        // Medications card with a severity-styled risk badge on the HCQ row
        expect(screen.getByText(/Hydroxychloroquine \(Plaquenil\) · 200mg · daily · PO/)).toBeInTheDocument();
        const riskBadge = screen.getByTestId('med-risk-badge');
        expect(riskBadge).toHaveTextContent(/Retinal Toxicity · HIGH/);
        expect(riskBadge.className).toContain('text-red-700');
        // Risk detail section still carries the AAO source string
        expect(screen.getByText('AAO HCQ Screening Guidelines 2016 (revised 2020)')).toBeInTheDocument();
        // Allergies + conditions
        expect(screen.getByText('Sulfa antibiotics')).toBeInTheDocument();
        expect(screen.getByText(/Rheumatoid arthritis \(M06\.9\)/)).toBeInTheDocument();
        // Contradiction alerts from BOTH stored payload shapes (runtime + rich seed)
        expect(screen.getByText('2 Data Conflicts Detected')).toBeInTheDocument();
        expect(screen.getByText(/Referral letter documents NKDA/)).toBeInTheDocument();
        expect(screen.getByText(/HCQ duration conflicts across sources/)).toBeInTheDocument();
        expect(screen.getByText(/How long have you actually been taking hydroxychloroquine\?/)).toBeInTheDocument();
        // Recent scans strip (placeholder pixels) + insights idle card
        expect(screen.getByTestId('recent-scans')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Generate AI insights/i })).toBeInTheDocument();
        // The invariant itself: zero /api/brief traffic
        expect(briefCalls(mock)).toBe(0);
    });

    // Failure mode: a stored contradiction quotes only one side — the doctor cannot
    // weigh the conflict without both verbatim sources.
    it('quotes both sources of a rich-seed contradiction via citation chips', async () => {
        stubApp({ overview: overviewNoBrief });
        render(<App />);
        await screen.findByText('2 Data Conflicts Detected');
        const chips = screen.getAllByRole('button', { name: /Citation \d: Source Document/i });
        expect(chips).toHaveLength(2); // rich-seed row projects source_documents[0..1]
        fireEvent.click(chips[0]!);
        const card = await screen.findByRole('dialog');
        expect(within(card).getByText(/Hydroxychloroquine \(Plaquenil\) 200mg daily - for RA, ~4 years duration/)).toBeInTheDocument();
    });

    // Failure mode: the scans strip loses the OD/OS toggle or the Imaging deep link.
    it('shows recent scans with an OD/OS toggle and a link into the Imaging tab', async () => {
        stubApp({ overview: overviewNoBrief });
        render(<App />);
        const strip = await screen.findByTestId('recent-scans');
        // Newest capture is the OS scan -> toggle defaults to OS
        expect(within(strip).getByRole('button', { name: 'OS' })).toHaveAttribute('aria-pressed', 'true');
        expect(within(strip).getByText('OCT OS')).toBeInTheDocument();
        expect(within(strip).getAllByText(/Dec 26, 2024/).length).toBeGreaterThanOrEqual(1); // capture date caption
        fireEvent.click(within(strip).getByRole('button', { name: 'OD' }));
        expect(within(strip).getByText('OCT OD')).toBeInTheDocument();
        fireEvent.click(within(strip).getByRole('button', { name: /Open Imaging tab/i }));
        expect(screen.getByRole('tab', { name: 'Imaging' })).toHaveAttribute('aria-selected', 'true');
    });

    // Failure mode: network/API errors render as an infinite spinner with no retry.
    it('shows an error state with a Retry control when the API is unreachable', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('boom'))));
        render(<App />);
        expect(await screen.findByText('Could not reach the sidecar API.')).toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: /Retry/i }).length).toBeGreaterThanOrEqual(1);
    });

    // Failure mode: the Diagnosis & Care tab renders stale/fabricated care-plan data
    // before S2.3 exists, instead of an honest placeholder.
    it('renders the Diagnosis & Care tab as a "Coming with chat" placeholder', async () => {
        stubApp();
        render(<App />);
        fireEvent.click(await screen.findByRole('tab', { name: /Diagnosis & Care/ }));
        expect(screen.getByText('Coming with chat')).toBeInTheDocument();
        expect(screen.getByText(/S2\.3/)).toBeInTheDocument();
    });
});

describe('Day-schedule sidebar', () => {
    // Failure mode: patients render in wire order (or selection stops driving ?patient=)
    // and the doctor's schedule/deep links stop lining up.
    it('lists patients sorted by appointment time and switches selection via ?patient=', async () => {
        stubApp({ overviews: { 'william-thompson': williamOverview } });
        render(<App />);
        const sidebar = screen.getByRole('complementary', { name: /Today.s patients/i });
        const rows = await within(sidebar).findAllByRole('button');
        // Fixture order is [William 13:15, Margaret 10:30]; the rail sorts by time.
        expect(rows[0]!.textContent).toContain('Margaret Chen');
        expect(rows[1]!.textContent).toContain('William Thompson');
        expect(within(sidebar).getByText('New patient')).toBeInTheDocument();
        expect(within(sidebar).getByText('Established')).toBeInTheDocument();

        // No ?patient= param -> the first patient by time is default-selected.
        await screen.findByText('57 yrs · Female · MRN FPA-2019-4521'); // Margaret's header band
        expect(window.location.search).toBe('?patient=margaret-chen');
        expect(rows[0]).toHaveAttribute('aria-current', 'true');

        // Clicking switches the selected patient and updates the URL param.
        fireEvent.click(within(sidebar).getByRole('button', { name: /William Thompson/ }));
        expect(window.location.search).toBe('?patient=william-thompson');
        expect((await screen.findAllByText('William Thompson')).length).toBeGreaterThanOrEqual(2); // rail + header
        expect(within(sidebar).getByRole('button', { name: /William Thompson/ })).toHaveAttribute('aria-current', 'true');
    });

    // Failure mode: ?patient= deep links stop being honored on load.
    it('honors an existing ?patient= deep link instead of default-selecting', async () => {
        window.history.replaceState(null, '', '?patient=william-thompson');
        stubApp({ overviews: { 'william-thompson': williamOverview } });
        render(<App />);
        expect((await screen.findAllByText('William Thompson')).length).toBeGreaterThanOrEqual(2);
        expect(window.location.search).toBe('?patient=william-thompson');
    });
});

describe('AI insights card', () => {
    // Failure mode: an existing brief renders unlabeled (or the gate metrics vanish) —
    // LLM output must be visibly marked as AI-prepared and citation-gated.
    it('renders the LLM sections from an existing brief, clearly labeled', async () => {
        stubApp(); // overviewPayload carries latest_brief -> the card fetches /api/brief
        render(<App />);
        const card = await screen.findByTestId('ai-insights');
        expect(await within(card).findByText('AI-prepared · citation-gated')).toBeInTheDocument();
        expect(within(card).getByText(/Prepared Dec 26, 2024/)).toBeInTheDocument();
        expect(within(card).getByText(/13\/14 claims verified/)).toBeInTheDocument();
        // Urgency banner lives INSIDE the card now, red for high
        const banner = within(card).getByTestId('urgency-banner');
        expect(banner.className).toContain('bg-red-50');
        expect(banner).toHaveTextContent('Critical contradiction in the record');
        // The four LLM-derived sections
        expect(within(card).getByText(/Why They.re Here/i)).toBeInTheDocument();
        expect(within(card).getByText(/rule out the retinal detachment her mother had/)).toBeInTheDocument();
        expect(within(card).getByText(/Key Discussion Points \(3\)/)).toBeInTheDocument();
        expect(within(card).getByText(/Questions to Confirm \(2\)/)).toBeInTheDocument();
    });

    // Failure mode: Generate blocks or repaints the page instead of running as an
    // in-card async enhancement with live stage progress.
    it('POSTs /api/prep on Generate and shows the live prep-run stage in-card only', async () => {
        const mock = stubApp({
            overview: overviewNoBrief,
            prepRuns: {
                status: 200,
                body: {
                    runs: [
                        {
                            id: 'run-1',
                            patient_id: 'margaret-chen',
                            correlation_id: 'corr-1',
                            status: 'running',
                            stage: 'llm_extraction:7/12',
                            error: null,
                            started_at: '2024-12-26T09:56:00Z',
                            finished_at: null,
                        },
                    ],
                },
            },
        });
        render(<App />);
        fireEvent.click(await screen.findByRole('button', { name: /Generate AI insights/i }));
        expect(await screen.findByText(/Reading documents 7\/12/)).toBeInTheDocument();
        const prepCall = mock.mock.calls.find(
            ([input, init]) => String(input).includes('/api/prep/margaret-chen') && (init as RequestInit | undefined)?.method === 'POST',
        );
        expect(prepCall).toBeDefined();
        // The rest of the landing never blanks while generating
        expect(screen.getByText(/Hydroxychloroquine \(Plaquenil\) · 200mg/)).toBeInTheDocument();
        expect(briefCalls(mock)).toBe(0);
    });

    // Failure mode: the 200 "reused" guard answer renders as an error instead of
    // simply loading the fresh-enough brief.
    it('loads the existing brief when POST /api/prep answers 200 reused', async () => {
        stubApp({
            overview: overviewNoBrief,
            prep: { status: 200, body: { status: 'reused', brief_id: 'brief-fixture-001', prepared_at: '2024-12-26T11:00:00Z' } },
        });
        render(<App />);
        fireEvent.click(await screen.findByRole('button', { name: /Generate AI insights/i }));
        expect(await screen.findByText('AI-prepared · citation-gated')).toBeInTheDocument();
    });

    // Failure mode: a 429 guard rejection crashes the card or takes the page with it.
    it('surfaces a 429 guard rejection gracefully inside the card', async () => {
        stubApp({ overview: overviewNoBrief, prep: { status: 429, body: { error: 'too_many_preps' } } });
        render(<App />);
        fireEvent.click(await screen.findByRole('button', { name: /Generate AI insights/i }));
        expect(await screen.findByText(/pipeline is busy/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument();
        // Page unaffected
        expect(screen.getByText(/Floaters and flashes x 2-3 weeks/)).toBeInTheDocument();
    });

    // Failure mode: a failed prep run polls forever instead of reporting the error.
    it('reports a failed prep run with its recorded error', async () => {
        stubApp({
            overview: overviewNoBrief,
            prepRuns: {
                status: 200,
                body: {
                    runs: [
                        {
                            id: 'run-1',
                            patient_id: 'margaret-chen',
                            correlation_id: 'corr-1',
                            status: 'failed',
                            stage: 'llm_extraction',
                            error: 'extraction failed: model refused',
                            started_at: '2024-12-26T09:56:00Z',
                            finished_at: '2024-12-26T09:58:00Z',
                        },
                    ],
                },
            },
        });
        render(<App />);
        fireEvent.click(await screen.findByRole('button', { name: /Generate AI insights/i }));
        expect(await screen.findByText(/extraction failed: model refused/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument();
    });
});

describe('Citation deep links', () => {
    // Failure mode: the chip's "View source" deep link breaks — it must land on the
    // Sources tab with the cited document open and the excerpt highlighted from its
    // character range (the presearch Q10 contract).
    it('deep-links from a landing citation chip to the Sources tab with the excerpt highlighted', async () => {
        stubApp({ overview: overviewNoBrief });
        const { container } = render(<App />);
        // Open the chief-complaint citation chip on the landing card.
        const chips = await screen.findAllByRole('button', { name: /Citation 1: Conversational intake transcript/i });
        fireEvent.click(chips[0]!);
        const card = await screen.findByRole('dialog', { name: /Source: Conversational intake transcript/i });
        fireEvent.click(within(card).getByRole('button', { name: /View source/i }));

        // Sources tab is now active with the intake transcript open and the range marked.
        expect(screen.getByRole('tab', { name: 'Sources' })).toHaveAttribute('aria-selected', 'true');
        expect(await screen.findByText('Showing citation location.')).toBeInTheDocument();
        await waitFor(() => {
            const mark = container.querySelector('#citation-highlight');
            expect(mark).not.toBeNull();
            expect(mark).toHaveTextContent("I've been seeing these floaters in my vision, especially in my right eye.");
        });
    });
});
