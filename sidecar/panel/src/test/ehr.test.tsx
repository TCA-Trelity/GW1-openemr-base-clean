// EHR Record + origin tests (E3): the co-pilot as an information layer on top of the EHR.
// The EHR Record tab renders the EHR-origin overview slice with a "Live from OpenEMR" sync
// header; Sync now POSTs /api/ehr-sync then refetches; 409/503 surface as inline messages;
// origin badges (EHR vs External) ride fact rows and both sides of an EHR-vs-external
// conflict; factOrigin is unit-checked. fetch is stubbed per test.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from '../App';
import { factOrigin } from '../OriginBadge';
import { formatRelativeSync } from '../EhrRecord';
import {
    EHR_SNAPSHOT_DOC_ID,
    bareCitation,
    ehrContradictionOverview,
    ehrOverview,
    factBundle,
    hcqCitation,
    margaretChen,
    overviewNoBrief,
} from './fixtures';
import type { CitationRef, OverviewPayload, PatientFact } from '../types';

type FetchStub = (url: string, init?: RequestInit) => { status: number; body: unknown } | undefined;

function stubFetch(handler: FetchStub) {
    const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        const result = handler(url, init);
        if (result === undefined) {
            throw new Error(`unstubbed fetch: ${url}`);
        }
        return { ok: result.status >= 200 && result.status < 300, status: result.status, json: async () => result.body } as Response;
    });
    vi.stubGlobal('fetch', mock);
    return mock;
}

const SYNCED_BODY = {
    synced: true,
    factCount: 4,
    resourceCounts: { AllergyIntolerance: 1, Condition: 1, MedicationRequest: 1, Observation: 1 },
    snapshotDocumentId: EHR_SNAPSHOT_DOC_ID,
    syncedAt: '2026-07-08T14:05:00.000Z',
};

function stubEhr(options: { overview?: OverviewPayload; sync?: { status: number; body: unknown } } = {}) {
    const { overview = ehrOverview, sync = { status: 200, body: SYNCED_BODY } } = options;
    return stubFetch((url, init) => {
        if (url.includes('/api/patients')) {
            return { status: 200, body: { patients: [margaretChen] } };
        }
        if (url.includes('/api/ehr-sync/') && init?.method === 'POST') {
            return sync;
        }
        if (url.includes('/api/overview/')) {
            return { status: 200, body: overview };
        }
        if (url.includes('/api/facts/')) {
            return { status: 200, body: factBundle };
        }
        if (url.includes('/api/prep-runs/')) {
            return { status: 200, body: { runs: [] } };
        }
        if (url.includes('/api/brief/')) {
            return { status: 404, body: {} };
        }
        return undefined;
    });
}

async function openEhrTab() {
    fireEvent.click(await screen.findByRole('tab', { name: 'EHR Record' }));
}

afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
});

// ---- factOrigin (pure) ----

const factBase = {
    patient_id: 'margaret-chen',
    is_current: true,
    source_document_id: 'd',
    verification: { status: 'unverified' as const },
    laterality: null,
};

function medFactWith(sources: CitationRef[]): PatientFact {
    return { ...factBase, id: 'f-origin', fact_type: 'medication', content: { name: 'X' }, sources };
}

describe('factOrigin', () => {
    // Failure mode: EHR provenance is misread, so live-EHR facts render as external (or the
    // reverse) and the whole origin story inverts.
    it('reads EHR from an external_ehr_import citation', () => {
        const ehrByType: CitationRef = { ...bareCitation, id: 'c-ehr-type', source_type: 'external_ehr_import' };
        expect(factOrigin(medFactWith([ehrByType]))).toBe('ehr');
    });

    it('reads EHR from an ehr-snapshot source_document_id even when the source_type is not ehr', () => {
        const ehrByDoc: CitationRef = { ...bareCitation, id: 'c-ehr-doc', source_type: 'provider_note', source_document_id: EHR_SNAPSHOT_DOC_ID };
        expect(factOrigin(medFactWith([ehrByDoc]))).toBe('ehr');
    });

    it('reads external for pharmacy/prior-visit citations and for a fact with no citations', () => {
        expect(factOrigin(medFactWith([bareCitation]))).toBe('external'); // pharmacy_record
        expect(factOrigin(medFactWith([hcqCitation]))).toBe('external'); // prior_visit_note
        expect(factOrigin(medFactWith([]))).toBe('external');
    });
});

describe('formatRelativeSync', () => {
    const now = new Date('2026-07-08T14:00:00.000Z');
    // Failure mode: the sync header shows a raw timestamp instead of a human relative time.
    it('renders coarse relative buckets and empty for missing input', () => {
        expect(formatRelativeSync('2026-07-08T13:59:30.000Z', now)).toBe('just now');
        expect(formatRelativeSync('2026-07-08T13:59:00.000Z', now)).toBe('1 minute ago');
        expect(formatRelativeSync('2026-07-08T13:55:00.000Z', now)).toBe('5 minutes ago');
        expect(formatRelativeSync('2026-07-08T13:00:00.000Z', now)).toBe('1 hour ago');
        expect(formatRelativeSync('2026-07-06T14:00:00.000Z', now)).toBe('2 days ago');
        expect(formatRelativeSync(undefined, now)).toBe('');
    });
});

// ---- EHR Record tab ----

describe('EHR Record tab', () => {
    // Failure mode: the tab dumps raw JSON or the wrong slice — it must render the EHR-origin
    // facts grouped and cleanly, under the live-sync header, and never external-only facts.
    it('renders the sync header and grouped EHR facts, excluding external-origin facts', async () => {
        stubEhr();
        render(<App />);
        await openEhrTab();
        const panel = screen.getByRole('tabpanel');
        expect(within(panel).getByText(/Live from OpenEMR · FHIR R4 · synced/)).toBeInTheDocument();
        // Demographics from the patient record
        expect(within(panel).getByText('Demographics')).toBeInTheDocument();
        expect(within(panel).getByText('Margaret Chen')).toBeInTheDocument();
        expect(within(panel).getByText('FPA-2019-4521')).toBeInTheDocument();
        // Grouped EHR-origin facts, rendered cleanly (not raw JSON)
        expect(within(panel).getByText('Problem list')).toBeInTheDocument();
        expect(within(panel).getByText(/Rheumatoid arthritis \(M06\.9\)/)).toBeInTheDocument();
        expect(within(panel).getByText('Sulfonamides')).toBeInTheDocument();
        expect(within(panel).getByText(/Hydroxychloroquine · 200 mg daily/)).toBeInTheDocument();
        expect(within(panel).getByText('IOP: 24 mmHg')).toBeInTheDocument();
        // The external pharmacy medication is NOT part of the EHR record
        expect(within(panel).queryByText(/Aspirin/)).not.toBeInTheDocument();
        // Every rendered EHR fact row carries the EHR origin badge
        expect(within(panel).getAllByTestId('origin-badge').every((b) => b.getAttribute('data-origin') === 'ehr')).toBe(true);
    });

    // Failure mode: Sync now is decorative — it must POST /api/ehr-sync and then refetch the
    // deterministic overview + facts so the tab reflects the fresh pull.
    it('POSTs /api/ehr-sync on Sync now and refetches overview + facts', async () => {
        const mock = stubEhr();
        render(<App />);
        await openEhrTab();
        const overviewBefore = mock.mock.calls.filter(([u]) => String(u).includes('/api/overview/')).length;
        const factsBefore = mock.mock.calls.filter(([u]) => String(u).includes('/api/facts/')).length;

        fireEvent.click(screen.getByRole('button', { name: /Sync now/i }));

        await waitFor(() => {
            const post = mock.mock.calls.find(
                ([u, init]) => String(u).includes('/api/ehr-sync/margaret-chen') && (init as RequestInit | undefined)?.method === 'POST',
            );
            expect(post).toBeDefined();
        });
        await waitFor(() => {
            const overviewAfter = mock.mock.calls.filter(([u]) => String(u).includes('/api/overview/')).length;
            expect(overviewAfter).toBeGreaterThan(overviewBefore);
        });
        const factsAfter = mock.mock.calls.filter(([u]) => String(u).includes('/api/facts/')).length;
        expect(factsAfter).toBeGreaterThan(factsBefore);
    });

    // Failure mode: with nothing synced the tab is blank or crashes — it must explain the
    // state, offer Sync, and hint that linking to OpenEMR comes first.
    it('shows an empty state with a Sync button and a linking hint before the first sync', async () => {
        stubEhr({ overview: overviewNoBrief });
        render(<App />);
        await openEhrTab();
        const panel = screen.getByRole('tabpanel');
        expect(within(panel).getByText(/been synced from OpenEMR yet/)).toBeInTheDocument();
        expect(within(panel).getByRole('button', { name: /Sync now/i })).toBeInTheDocument();
        expect(within(panel).getByText(/must be linked \(seeded into OpenEMR\)/)).toBeInTheDocument();
    });

    // Failure mode: a 409 unlinked patient blows up instead of a calm inline message.
    it('surfaces a 409 not_linked as an inline message, never a crash', async () => {
        stubEhr({ overview: overviewNoBrief, sync: { status: 409, body: { synced: false, reason: 'not_linked_to_openemr' } } });
        render(<App />);
        await openEhrTab();
        fireEvent.click(screen.getByRole('button', { name: /Sync now/i }));
        expect(await screen.findByText(/linked to an OpenEMR chart yet/)).toBeInTheDocument();
    });

    // Failure mode: a deployment without a read client 500s or wedges instead of saying so.
    it('surfaces a 503 not-configured as an inline message', async () => {
        stubEhr({ overview: overviewNoBrief, sync: { status: 503, body: { error: 'ehr_sync_not_configured' } } });
        render(<App />);
        await openEhrTab();
        fireEvent.click(screen.getByRole('button', { name: /Sync now/i }));
        expect(await screen.findByText(/configured on this deployment/)).toBeInTheDocument();
    });
});

// ---- Origin badges elsewhere ----

describe('Origin badges', () => {
    // Failure mode: origin badges only appear on the EHR tab — they must also mark provenance
    // on the Overview fact rows and the Medical Background rows.
    it('marks fact origin on Overview and Medical Background rows', async () => {
        stubEhr();
        render(<App />);
        await screen.findByRole('tab', { name: 'EHR Record' }); // landing ready (Overview active)
        const overviewBadges = screen.getAllByTestId('origin-badge');
        expect(overviewBadges.some((b) => b.getAttribute('data-origin') === 'ehr')).toBe(true);
        expect(overviewBadges.some((b) => b.getAttribute('data-origin') === 'external')).toBe(true);

        fireEvent.click(screen.getByRole('tab', { name: 'Medical Background' }));
        const mbBadges = screen.getAllByTestId('origin-badge');
        expect(mbBadges.length).toBeGreaterThan(0);
        expect(mbBadges.some((b) => b.getAttribute('data-origin') === 'ehr')).toBe(true);
    });

    // Failure mode: an EHR-vs-external conflict reads as one undifferentiated dispute — both
    // sides must visibly carry their origin so it's "your EHR says X, this source says Y".
    it('labels both sides of an EHR-vs-external contradiction with their origin', async () => {
        stubEhr({ overview: ehrContradictionOverview });
        render(<App />);
        await screen.findByText('1 Data Conflict Detected');
        expect(screen.getByText(/OpenEMR lists Hydroxychloroquine 200mg/)).toBeInTheDocument();

        const badges = screen.getAllByTestId('origin-badge');
        expect(badges).toHaveLength(2);
        expect(badges[0]).toHaveAttribute('data-origin', 'ehr');
        expect(badges[0]).toHaveTextContent('EHR');
        expect(badges[1]).toHaveAttribute('data-origin', 'external');
        expect(badges[1]).toHaveTextContent('External');
        // Both sides keep their own source-name chip alongside the origin marker (R8 intact).
        expect(screen.getByRole('button', { name: 'Citation 1: External Ehr Import' })).toHaveTextContent('EHR');
        expect(screen.getByRole('button', { name: 'Citation 2: Pharmacy Record' })).toHaveTextContent('Pharmacy');
    });
});
