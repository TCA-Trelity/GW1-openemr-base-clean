// Panel shell (S2.11 realignment): day-schedule sidebar + instant deterministic landing
// from GET /api/overview — no LLM in any load path; the brief is an async enhancement
// card inside the Overview tab. ?patient= deep links stay authoritative.
import { useCallback, useEffect, useState } from 'react';
import { MessageSquare, RefreshCw } from 'lucide-react';
import {
    fetchFacts,
    fetchOverview,
    fetchPatients,
    type FactsFetchResult,
    type OverviewFetchResult,
    type PatientsFetchResult,
} from './api';
import type { CitationRef } from './types';
import { SourceNavContext } from './CitationChip';
import PatientSidebar, { sortByAppointment } from './PatientSidebar';
import AiInsights from './AiInsights';
import Overview from './Overview';
import MedicalBackground from './MedicalBackground';
import Imaging from './imaging/Imaging';
import SourcesTab, { type SourceFocus } from './SourcesTab';

type TabId = 'overview' | 'background' | 'imaging' | 'careplan' | 'sources';

const TABS: { id: TabId; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'background', label: 'Medical Background' },
    { id: 'imaging', label: 'Imaging' },
    { id: 'careplan', label: 'Diagnosis & Care' },
    { id: 'sources', label: 'Sources' },
];

function patientIdFromUrl(): string | null {
    return new URLSearchParams(window.location.search).get('patient');
}

export default function App() {
    const [patientId, setPatientId] = useState<string | null>(patientIdFromUrl);
    const [patientsState, setPatientsState] = useState<PatientsFetchResult | { kind: 'loading' }>({ kind: 'loading' });
    const [overviewState, setOverviewState] = useState<OverviewFetchResult | { kind: 'loading' }>({ kind: 'loading' });
    const [factsState, setFactsState] = useState<FactsFetchResult | { kind: 'loading' }>({ kind: 'loading' });
    const [activeTab, setActiveTab] = useState<TabId>('overview');
    const [sourceFocus, setSourceFocus] = useState<SourceFocus | null>(null);
    const [reloadNonce, setReloadNonce] = useState(0);

    const loadPatients = useCallback(async () => {
        setPatientsState({ kind: 'loading' });
        setPatientsState(await fetchPatients());
    }, []);

    useEffect(() => {
        void loadPatients();
    }, [loadPatients]);

    // Default-select the earliest appointment when the URL names no patient.
    useEffect(() => {
        if (patientId === null && patientsState.kind === 'ready') {
            const first = sortByAppointment(patientsState.patients)[0];
            if (first !== undefined) {
                window.history.replaceState(null, '', `?patient=${encodeURIComponent(first.id)}`);
                setPatientId(first.id);
            }
        }
    }, [patientId, patientsState]);

    // Browser back/forward keeps ?patient= deep links honest.
    useEffect(() => {
        const onPopState = () => setPatientId(patientIdFromUrl());
        window.addEventListener('popstate', onPopState);
        return () => window.removeEventListener('popstate', onPopState);
    }, []);

    // One deterministic fetch renders the whole landing; facts ride along for Sources/Imaging.
    useEffect(() => {
        if (patientId === null) {
            return;
        }
        let cancelled = false;
        setOverviewState({ kind: 'loading' });
        setFactsState({ kind: 'loading' });
        void fetchOverview(patientId).then((result) => {
            if (!cancelled) {
                setOverviewState(result);
            }
        });
        void fetchFacts(patientId).then((result) => {
            if (!cancelled) {
                setFactsState(result);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [patientId, reloadNonce]);

    const selectPatient = useCallback(
        (id: string) => {
            if (id === patientId) {
                return;
            }
            window.history.pushState(null, '', `?patient=${encodeURIComponent(id)}`);
            setSourceFocus(null);
            setPatientId(id);
        },
        [patientId],
    );

    const viewSource = useCallback((citation: CitationRef) => {
        setSourceFocus({
            documentId: citation.source_document_id,
            start: citation.excerpt_location?.start_char ?? null,
            end: citation.excerpt_location?.end_char ?? null,
            excerpt: citation.excerpt_text,
        });
        setActiveTab('sources');
    }, []);

    const overview = overviewState.kind === 'ready' ? overviewState.overview : null;
    const documents = factsState.kind === 'ready' ? (factsState.bundle.documents ?? []) : [];
    const patientName =
        overview?.patient.name ??
        (patientsState.kind === 'ready' ? patientsState.patients.find((patient) => patient.id === patientId)?.name : undefined) ??
        patientId ??
        '';

    return (
        <SourceNavContext.Provider value={viewSource}>
            <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white flex">
                <PatientSidebar state={patientsState} activeId={patientId} onSelect={selectPatient} onRetry={() => void loadPatients()} />

                <div className="flex-1 min-w-0 flex flex-col">
                    {/* Dark chrome — echo of the prototype's slate-800 nav rail */}
                    <header className="bg-slate-800 text-white">
                        <div className="max-w-4xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-4">
                            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Clinical Co-Pilot</p>
                            <h1 className="text-xl font-semibold tracking-tight">{patientName}</h1>
                        </div>
                    </header>

                    <main className="max-w-4xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-8 flex-1">
                        {patientId === null && (
                            <>
                                {patientsState.kind === 'loading' && (
                                    <p className="text-center py-16 text-slate-400">Loading schedule…</p>
                                )}
                                {patientsState.kind === 'error' && (
                                    <div className="text-center py-16">
                                        <p className="text-red-600">{patientsState.message}</p>
                                        <button
                                            type="button"
                                            onClick={() => void loadPatients()}
                                            className="mt-4 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50"
                                        >
                                            <RefreshCw className="w-3.5 h-3.5" />
                                            Retry
                                        </button>
                                    </div>
                                )}
                                {patientsState.kind === 'ready' && (
                                    <p className="text-center py-16 text-slate-400">No patients on today&rsquo;s schedule.</p>
                                )}
                            </>
                        )}

                        {patientId !== null && overviewState.kind === 'loading' && (
                            <p className="text-center py-16 text-slate-400">Loading patient overview…</p>
                        )}

                        {patientId !== null && overviewState.kind === 'error' && (
                            <div className="text-center py-16">
                                <p className="text-red-600">{overviewState.message}</p>
                                <button
                                    type="button"
                                    onClick={() => setReloadNonce((nonce) => nonce + 1)}
                                    className="mt-4 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50"
                                >
                                    <RefreshCw className="w-3.5 h-3.5" />
                                    Retry
                                </button>
                            </div>
                        )}

                        {patientId !== null && overview !== null && (
                            <>
                                <div className="mb-8">
                                    <div role="tablist" className="inline-flex p-1 bg-slate-100 rounded-xl">
                                        {TABS.map((tab) => (
                                            <button
                                                key={tab.id}
                                                role="tab"
                                                aria-selected={activeTab === tab.id}
                                                onClick={() => setActiveTab(tab.id)}
                                                className={`relative px-4 sm:px-5 py-2.5 text-sm font-medium rounded-lg transition-all duration-200 ${
                                                    activeTab === tab.id
                                                        ? 'text-slate-800 bg-white shadow-sm'
                                                        : 'text-slate-500 hover:text-slate-700'
                                                }`}
                                            >
                                                {tab.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                <div role="tabpanel">
                                    {activeTab === 'overview' && (
                                        <Overview
                                            key={patientId}
                                            overview={overview}
                                            insights={
                                                <AiInsights key={patientId} patientId={patientId} latestBrief={overview.latest_brief} />
                                            }
                                            onOpenImaging={() => setActiveTab('imaging')}
                                        />
                                    )}
                                    {activeTab === 'background' && <MedicalBackground factsByType={overview.facts_by_type} />}
                                    {activeTab === 'imaging' && (
                                        <>
                                            {factsState.kind === 'error' && (
                                                <p className="mb-4 p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800">
                                                    {factsState.message}
                                                </p>
                                            )}
                                            <Imaging
                                                imaging={overview.imaging}
                                                images={overview.images}
                                                treatments={factsState.kind === 'ready' ? factsState.bundle.treatments : []}
                                            />
                                        </>
                                    )}
                                    {activeTab === 'careplan' && (
                                        <div className="text-center py-16 text-slate-400 border border-dashed border-slate-200 rounded-xl">
                                            <MessageSquare className="w-10 h-10 mx-auto mb-3 text-slate-300" />
                                            <p className="text-sm font-medium text-slate-500">Coming with chat</p>
                                            <p className="text-xs mt-1">Diagnosis &amp; Care arrives with the consult chat loop (S2.3).</p>
                                        </div>
                                    )}
                                    {activeTab === 'sources' && (
                                        <>
                                            {factsState.kind === 'error' && (
                                                <p className="mb-4 p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800">
                                                    {factsState.message}
                                                </p>
                                            )}
                                            <SourcesTab documents={documents} focus={sourceFocus} onClearFocus={() => setSourceFocus(null)} />
                                        </>
                                    )}
                                </div>

                                <footer className="mt-12 pt-6 border-t border-slate-200 text-center">
                                    <p className="text-sm text-slate-400">
                                        Page {TABS.findIndex((tab) => tab.id === activeTab) + 1} of {TABS.length}
                                    </p>
                                </footer>
                            </>
                        )}
                    </main>
                </div>
            </div>
        </SourceNavContext.Provider>
    );
}
