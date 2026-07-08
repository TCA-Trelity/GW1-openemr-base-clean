// App-level tests (S2.11/S2.12 realignment + R2/R3/R4): instant deterministic landing
// from /api/overview, day-schedule sidebar + ?patient= deep links, the header-bar AI
// insights control (generate/poll/reuse/429) with the brief on its own tab, the
// deterministic Diagnosis & Care tab, and the chip -> Sources deep link. fetch is
// stubbed per test.
import { describe, expect, it, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from '../App';
import {
    briefContent,
    factBundle,
    overviewNoBrief,
    overviewPayload,
    patients,
    storedBrief,
    williamOverview,
} from './fixtures';
import { wtOverview } from './imaging-fixtures';
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
        // R7 section order: chief complaint -> recent scans -> data conflicts -> meds
        const strip = screen.getByTestId('recent-scans');
        const complaint = screen.getByText(/Floaters and flashes x 2-3 weeks, worse OD/);
        const conflicts = screen.getByText('2 Data Conflicts Detected');
        const meds = screen.getByText(/Hydroxychloroquine \(Plaquenil\) · 200mg/);
        expect(complaint.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(strip.compareDocumentPosition(conflicts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(conflicts.compareDocumentPosition(meds) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        // The Generate control lives in the patient header band, left of the time chip (R2)
        expect(screen.getByRole('button', { name: /Generate AI insights/i })).toBeInTheDocument();
        // The invariant itself: zero /api/brief traffic
        expect(briefCalls(mock)).toBe(0);
    });

    // Failure mode: the tab bar regresses to the old IA — EHR Record leads (system of
    // record, E3), then AI Insights must be its own top-level tab right of Imaging (R2).
    it('orders the tabs EHR Record, Overview, Medical Background, Imaging, AI Insights, Diagnosis & Care, Sources', async () => {
        stubApp({ overview: overviewNoBrief });
        render(<App />);
        const tabs = await screen.findAllByRole('tab');
        expect(tabs.map((tab) => tab.textContent)).toEqual([
            'EHR Record',
            'Overview',
            'Medical Background',
            'Imaging',
            'AI Insights',
            'Diagnosis & Care',
            'Sources',
        ]);
    });

    // Failure mode: a stored contradiction quotes only one side — the doctor cannot
    // weigh the conflict without both verbatim sources. Same-source-type grouping (R8)
    // must never collapse a conflict's two sides into one chip.
    it('quotes both sources of a rich-seed contradiction via citation chips', async () => {
        stubApp({ overview: overviewNoBrief });
        render(<App />);
        await screen.findByText('2 Data Conflicts Detected');
        const chips = screen.getAllByRole('button', { name: /Citation \d: Source Document/i });
        expect(chips).toHaveLength(2); // rich-seed row projects source_documents[0..1]
        fireEvent.click(chips[0]!);
        const card = await screen.findByRole('dialog');
        expect(within(card).getByText(/Hydroxychloroquine \(Plaquenil\) 200mg daily - for RA, ~4 years duration/)).toBeInTheDocument();
        // R8 labels: runtime-shape sides carry their real source types on the chip
        expect(screen.getByRole('button', { name: 'Citation 1: Referral Letter' })).toHaveTextContent('Referral');
        expect(screen.getByRole('button', { name: 'Citation 2: Intake Transcript' })).toHaveTextContent('Intake');
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

    // Failure mode (R3): the Diagnosis & Care tab waits on an LLM or renders a
    // placeholder — it must render deterministically on first load from care_plan.
    it('renders the Diagnosis & Care tab deterministically from the overview care_plan', async () => {
        const mock = stubApp({ overview: overviewNoBrief });
        render(<App />);
        fireEvent.click(await screen.findByRole('tab', { name: /Diagnosis & Care/ }));
        // Active conditions resolve fact ids against facts_by_type.condition (shared row)
        expect(screen.getByText(/Active Conditions \(1\)/)).toBeInTheDocument();
        expect(screen.getByText(/Rheumatoid arthritis \(M06\.9\)/)).toBeInTheDocument();
        // No protocol for Margaret — honest empty state, not a blank card
        expect(screen.getByText('No active treatment protocol on record.')).toBeInTheDocument();
        // Monitoring rows: severity-styled, source attributed
        const rows = screen.getAllByTestId('monitoring-item');
        expect(rows).toHaveLength(2);
        expect(rows[0]).toHaveTextContent('Baseline and annual OCT plus visual field screening');
        expect(rows[0]!.className).toContain('bg-red-50');
        expect(rows[0]).toHaveTextContent('AAO HCQ Screening Guidelines 2016 (revised 2020)');
        expect(rows[1]!.className).toContain('bg-amber-50');
        expect(rows[1]).toHaveTextContent('imaging trend analysis');
        // Follow-up card with confidence, no fabricated recommendation
        const followUp = screen.getByTestId('follow-up-card');
        expect(followUp).toHaveTextContent(/No interval recommendation yet/);
        expect(followUp).toHaveTextContent('low confidence');
        // Zero LLM traffic in this path
        expect(briefCalls(mock)).toBe(0);
    });

    // Failure mode (R3): a treatment-bearing record loses its protocol/follow-up cards.
    it('renders protocol and follow-up from a treatment-bearing care_plan', async () => {
        window.history.replaceState(null, '', '?patient=william-thompson');
        stubApp({ overviews: { 'william-thompson': wtOverview } });
        render(<App />);
        fireEvent.click(await screen.findByRole('tab', { name: /Diagnosis & Care/ }));
        const protocol = screen.getByTestId('protocol-card');
        expect(protocol).toHaveTextContent('Eylea protocol');
        expect(protocol).toHaveTextContent('4 injections on record');
        expect(protocol).toHaveTextContent('Last: Oct 22, 2025');
        const followUp = screen.getByTestId('follow-up-card');
        expect(followUp).toHaveTextContent('Optimal: 7 weeks');
        expect(followUp).toHaveTextContent(/Recommend 7-week intervals/);
        expect(followUp).toHaveTextContent('high confidence');
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

describe('AI insights', () => {
    // Failure mode: an existing brief renders unlabeled (or the gate metrics vanish) —
    // LLM output must be visibly marked as AI-prepared and citation-gated.
    it('renders the LLM sections from an existing brief on the AI Insights tab', async () => {
        stubApp(); // overviewPayload carries latest_brief -> the hook fetches /api/brief
        render(<App />);
        // Header flips to the subtle refresh affordance once the stored brief loads (R2)
        expect(await screen.findByRole('button', { name: /Refresh insights/i })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('tab', { name: 'AI Insights' }));
        const tab = screen.getByTestId('ai-insights');
        expect(within(tab).getByText('AI-prepared · citation-gated')).toBeInTheDocument();
        expect(within(tab).getByText(/Prepared Dec 26, 2024/)).toBeInTheDocument();
        expect(within(tab).getByText(/13\/14 claims verified/)).toBeInTheDocument();
        // Urgency banner, red for high
        const banner = within(tab).getByTestId('urgency-banner');
        expect(banner.className).toContain('bg-red-50');
        expect(banner).toHaveTextContent('Critical contradiction in the record');
        // The LLM-derived sections
        expect(within(tab).getByText(/Why They.re Here/i)).toBeInTheDocument();
        expect(within(tab).getByText(/rule out the retinal detachment her mother had/)).toBeInTheDocument();
        expect(within(tab).getByText(/Key Discussion Points \(3\)/)).toBeInTheDocument();
        expect(within(tab).getByText(/Questions to Confirm \(2\)/)).toBeInTheDocument();
    });

    // Failure mode (R4): structured discussion points render as blobs (or crash on the
    // legacy plain-string shape) instead of one-line rows with chips and conflict links.
    it('renders structured discussion points as one-line rows with chips, tolerating strings', async () => {
        stubApp();
        render(<App />);
        await screen.findByRole('button', { name: /Refresh insights/i });
        fireEvent.click(screen.getByRole('tab', { name: 'AI Insights' }));
        const tab = screen.getByTestId('ai-insights');
        const points = within(tab).getAllByTestId('discussion-point');
        expect(points).toHaveLength(3);
        // risk_flag point: kind icon + terse text + source-labelled citation chip (R8)
        expect(points[0]).toHaveTextContent('Hydroxychloroquine (Plaquenil): HIGH retinal toxicity risk');
        expect(
            within(points[0]!).getByRole('button', { name: 'Citation 1: Rheumatology office note - Dr. Anita Patel' }),
        ).toHaveTextContent('Prior visit');
        // contradiction point: link to the matching alert card
        expect(within(points[1]!).getByRole('button', { name: /view conflict/i })).toBeInTheDocument();
        // legacy plain string renders plainly, numbered
        expect(points[2]).toHaveTextContent('Family history of retinal detachment (mother) with new floaters');
        expect(within(points[2]!).queryByRole('button')).not.toBeInTheDocument();
    });

    // Failure mode (R4): the conflict link is decorative — it must scroll to the
    // matching contradiction alert card rendered on the same tab.
    it('scrolls to the matching contradiction alert card from a contradiction point', async () => {
        const scrollSpy = vi.fn();
        const original = window.HTMLElement.prototype.scrollIntoView;
        window.HTMLElement.prototype.scrollIntoView = scrollSpy;
        try {
            stubApp();
            render(<App />);
            await screen.findByRole('button', { name: /Refresh insights/i });
            fireEvent.click(screen.getByRole('tab', { name: 'AI Insights' }));
            const tab = screen.getByTestId('ai-insights');
            // The alert card carries the anchor id the point links to
            const anchor = document.getElementById('insights-alert-contra-mc-002');
            expect(anchor).not.toBeNull();
            expect(anchor).toHaveTextContent(/Referral letter documents NKDA/);
            fireEvent.click(within(tab).getByRole('button', { name: /view conflict/i }));
            expect(scrollSpy).toHaveBeenCalled();
        } finally {
            window.HTMLElement.prototype.scrollIntoView = original;
        }
    });

    // Failure mode (R4): a long question list buries the page — cap at 4 with an
    // explicit "show all" expander.
    it('caps visible questions at 4 with a show-all expander', async () => {
        const manyQuestions = {
            ...storedBrief,
            content: { ...briefContent, questions_to_confirm: ['Q1?', 'Q2?', 'Q3?', 'Q4?', 'Q5?', 'Q6?'] },
        };
        stubApp({ brief: { status: 200, body: manyQuestions } });
        render(<App />);
        await screen.findByRole('button', { name: /Refresh insights/i });
        fireEvent.click(screen.getByRole('tab', { name: 'AI Insights' }));
        expect(screen.getByText(/Questions to Confirm \(6\)/)).toBeInTheDocument();
        expect(screen.getAllByTestId('question-item')).toHaveLength(4);
        fireEvent.click(screen.getByRole('button', { name: /Show all \(6\)/i }));
        expect(screen.getAllByTestId('question-item')).toHaveLength(6);
        expect(screen.queryByRole('button', { name: /Show all/i })).not.toBeInTheDocument();
    });

    // Failure mode (R2): Generate navigates away or repaints the page instead of running
    // as a header-bar affordance with compact live progress.
    it('POSTs /api/prep on the header Generate and shows compact progress without navigating', async () => {
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
        // Compact progress in the header chip; clicking never navigated
        const progress = await screen.findByTestId('insights-header-progress');
        await waitFor(() => expect(progress).toHaveTextContent('Reading 7/12'));
        expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
        const prepCall = mock.mock.calls.find(
            ([input, init]) => String(input).includes('/api/prep/margaret-chen') && (init as RequestInit | undefined)?.method === 'POST',
        );
        expect(prepCall).toBeDefined();
        // The rest of the landing never blanks while generating
        expect(screen.getByText(/Hydroxychloroquine \(Plaquenil\) · 200mg/)).toBeInTheDocument();
        // The AI Insights tab reports the same run with the full stage label
        fireEvent.click(screen.getByRole('tab', { name: 'AI Insights' }));
        expect(screen.getByTestId('insights-progress')).toHaveTextContent('Reading documents 7/12');
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
        expect(await screen.findByRole('button', { name: /Refresh insights/i })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('tab', { name: 'AI Insights' }));
        expect(await screen.findByText('AI-prepared · citation-gated')).toBeInTheDocument();
    });

    // Failure mode: a 429 guard rejection crashes the header control or takes the page
    // with it — it must surface compactly in the header and in full on the tab.
    it('surfaces a 429 guard rejection gracefully in the header and on the tab', async () => {
        stubApp({ overview: overviewNoBrief, prep: { status: 429, body: { error: 'too_many_preps' } } });
        render(<App />);
        fireEvent.click(await screen.findByRole('button', { name: /Generate AI insights/i }));
        expect(await screen.findByRole('button', { name: /Retry insights/i })).toBeInTheDocument();
        // Page unaffected
        expect(screen.getByText(/Floaters and flashes x 2-3 weeks/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('tab', { name: 'AI Insights' }));
        expect(await screen.findByText(/pipeline is busy/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument();
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
        expect(await screen.findByRole('button', { name: /Retry insights/i })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('tab', { name: 'AI Insights' }));
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
        // Open the chief-complaint citation chip on the landing card (labelled "Intake", R8).
        const chips = await screen.findAllByRole('button', { name: /Citation 1: Conversational intake transcript/i });
        expect(chips[0]).toHaveTextContent('Intake');
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
