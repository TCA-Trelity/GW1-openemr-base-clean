// App-level tests: brief IA, urgency banner placement/coloring, fetch states,
// prepare flow, and the chip -> Sources deep link. fetch is stubbed per test.
import { describe, expect, it, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import App from '../App';
import { briefContent, factBundle, storedBrief } from './fixtures';
import type { BriefContent } from '../types';

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

function stubHappyPath(content: BriefContent = briefContent) {
    return stubFetch((url) => {
        if (url.includes('/api/brief/')) {
            return { status: 200, body: { ...storedBrief, content } };
        }
        if (url.includes('/api/facts/')) {
            return { status: 200, body: factBundle };
        }
        return undefined;
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('App', () => {
    // Failure mode: a section of the validated Overview IA silently drops out of the
    // brief (renamed key, dead conditional) and the doctor walks in without it.
    it('renders every Overview section from the fixture brief, in the manifest §4 shape', async () => {
        stubHappyPath();
        render(<App />);

        // Contradiction alerts banner
        expect(await screen.findByText('2 Data Conflicts Detected')).toBeInTheDocument();
        // Why They're Here
        expect(screen.getByText(/Why They.re Here/i)).toBeInTheDocument();
        expect(screen.getByText(/Floaters and flashes x 2-3 weeks, worse OD/)).toBeInTheDocument();
        // What They're Hoping For
        expect(screen.getByText(/What They.re Hoping For/i)).toBeInTheDocument();
        expect(screen.getByText(/rule out the retinal detachment her mother had/)).toBeInTheDocument();
        // Key Discussion Points / Questions to Confirm
        expect(screen.getByText(/Key Discussion Points \(3\)/i)).toBeInTheDocument();
        expect(screen.getByText(/Questions to Confirm \(2\)/i)).toBeInTheDocument();
        // Medication risk flag with the AAO source string visible
        expect(screen.getByText(/Medication Risk Alerts \(1\)/i)).toBeInTheDocument();
        expect(screen.getByText('AAO HCQ Screening Guidelines 2016 (revised 2020)')).toBeInTheDocument();
        // Compact imaging block: HCQ progression + timeline counts + S2.2 placeholder note
        expect(screen.getByText(/Ganglion cell layer declined 12µm/)).toBeInTheDocument();
        expect(screen.getByText(/2 studies on file/)).toBeInTheDocument();
        expect(screen.getByText(/imaging workstation \(S2\.2\)/)).toBeInTheDocument();
        // Gate metrics surface in the header
        expect(screen.getByText(/13\/14 claims verified/)).toBeInTheDocument();
    });

    // Failure mode: urgency banner slips below the tab bar (or loses its color coding)
    // and stops being the first thing the doctor sees.
    it('renders the urgency banner red for high level, ABOVE the tab bar', async () => {
        stubHappyPath();
        render(<App />);
        const banner = await screen.findByTestId('urgency-banner');
        expect(banner.className).toContain('bg-red-50');
        expect(banner).toHaveTextContent('Critical contradiction in the record');
        const tablist = screen.getByRole('tablist');
        // Banner must precede the tabs in document order.
        expect(banner.compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    // Failure mode: moderate urgency renders with the high-urgency (red) treatment,
    // or a null urgency still paints a banner — both miscalibrate the doctor.
    it('colors moderate urgency amber and hides the banner when urgency is null', async () => {
        stubHappyPath({ ...briefContent, urgency: { level: 'moderate', reason: 'Unresolved contradiction: HCQ duration' } });
        render(<App />);
        const banner = await screen.findByTestId('urgency-banner');
        expect(banner.className).toContain('bg-amber-50');

        vi.unstubAllGlobals();
        stubHappyPath({ ...briefContent, urgency: null });
        render(<App />);
        expect(await screen.findAllByRole('tablist')).not.toHaveLength(0);
        // Only the first render (still mounted) has a banner; the null-urgency render adds none.
        expect(screen.getAllByTestId('urgency-banner')).toHaveLength(1);
    });

    // Failure mode: a 404 not_prepared response renders as a crash/blank instead of
    // offering the doctor the way to run preparation.
    it('shows the Prepare brief button on not_prepared and POSTs /api/prep', async () => {
        const mock = stubFetch((url, init) => {
            if (url.includes('/api/prep/') && init?.method === 'POST') {
                return { status: 202, body: { prep_run_id: 'run-1', correlation_id: 'corr-1' } };
            }
            if (url.includes('/api/brief/')) {
                return { status: 404, body: { status: 'not_prepared' } };
            }
            if (url.includes('/api/facts/')) {
                return { status: 200, body: factBundle };
            }
            return undefined;
        });
        render(<App />);
        const button = await screen.findByRole('button', { name: /Prepare brief/i });
        fireEvent.click(button);
        expect(await screen.findByText(/Preparing brief/)).toBeInTheDocument();
        const prepCall = mock.mock.calls.find(([input]) => String(input).includes('/api/prep/margaret-chen'));
        expect(prepCall).toBeDefined();
        expect((prepCall?.[1] as RequestInit).method).toBe('POST');
    });

    // Failure mode: network/API errors render as an infinite spinner with no retry.
    it('shows an error state with a Retry control when the API is unreachable', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('boom'))));
        render(<App />);
        expect(await screen.findByText('Could not reach the sidecar API.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument();
    });

    // Failure mode: the chip's "View source" deep link breaks — it must land on the
    // Sources tab with the cited document open and the excerpt highlighted from its
    // character range (the presearch Q10 contract).
    it('deep-links from a citation chip to the Sources tab with the excerpt highlighted', async () => {
        stubHappyPath();
        const { container } = render(<App />);
        // Open the chief-complaint citation chip in "Why They're Here" (the goal card
        // cites the same transcript, so take the first matching chip).
        const chips = await screen.findAllByRole('button', { name: /Citation 1: Conversational intake transcript/i });
        fireEvent.click(chips[0]!);
        const card = await screen.findByRole('dialog', { name: /Source: Conversational intake transcript/i });
        fireEvent.click(within(card).getByRole('button', { name: /View source/i }));

        // Sources tab is now active with the intake transcript open and the range marked.
        expect(screen.getByRole('tab', { name: 'Sources' })).toHaveAttribute('aria-selected', 'true');
        expect(await screen.findByText('Showing citation location.')).toBeInTheDocument();
        const mark = container.querySelector('#citation-highlight');
        expect(mark).not.toBeNull();
        expect(mark).toHaveTextContent("I've been seeing these floaters in my vision, especially in my right eye.");
    });

    // Failure mode: the Diagnosis & Care tab renders stale/fabricated care-plan data
    // before S2.3 exists, instead of an honest placeholder.
    it('renders the Diagnosis & Care tab as a "Coming with chat" placeholder', async () => {
        stubHappyPath();
        render(<App />);
        fireEvent.click(await screen.findByRole('tab', { name: /Diagnosis & Care/ }));
        expect(screen.getByText('Coming with chat')).toBeInTheDocument();
        expect(screen.getByText(/S2\.3/)).toBeInTheDocument();
    });
});
