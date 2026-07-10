// Panel shell (S2.11 realignment, R2 IA): day-schedule sidebar + instant deterministic
// landing from GET /api/overview — no LLM in any load path. The patient header band sits
// above the tab bar on every tab and hosts the AI insights control (Generate -> compact
// progress -> Refresh); the brief renders on its own AI Insights tab, and Diagnosis &
// Care renders deterministically from the overview's care_plan. ?patient= deep links
// stay authoritative. The S2.3 chat drawer ("Ask the record") docks over every tab.
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
    devLogin,
    fetchFacts,
    fetchMe,
    fetchOverview,
    fetchPatients,
    setAuthToken,
    verifyFact,
    type AuthCapabilities,
    type ClinicalRole,
    type FactsFetchResult,
    type OverviewFetchResult,
    type PatientsFetchResult,
} from './api';
import type { CitationRef } from './types';
import RoleSwitcher from './RoleSwitcher';
import { SourceNavContext } from './CitationChip';
import PatientSidebar, { sortByAppointment } from './PatientSidebar';
import AiInsightsTab, { InsightsHeaderControl, useInsights } from './AiInsights';
import CarePlan from './CarePlan';
import ChatDrawer from './ChatDrawer';
import EhrRecord from './EhrRecord';
import Overview, { PatientHeaderBand } from './Overview';
import MedicalBackground from './MedicalBackground';
import Imaging from './imaging/Imaging';
import SourcesTab, { type SourceFocus } from './SourcesTab';

type TabId = 'ehr' | 'overview' | 'background' | 'imaging' | 'insights' | 'careplan' | 'sources';

// Overview leads (P5 — it's the working surface); EHR Record sits beside it as the
// system of record the co-pilot layers on top of.
const TABS: { id: TabId; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'ehr', label: 'EHR Record' },
    { id: 'background', label: 'Medical Background' },
    { id: 'imaging', label: 'Imaging' },
    { id: 'insights', label: 'AI Insights' },
    { id: 'careplan', label: 'Diagnosis & Care' },
    { id: 'sources', label: 'Sources' },
];

function patientIdFromUrl(): string | null {
    return new URLSearchParams(window.location.search).get('patient');
}

/** ?tab= deep link (Q-wave): lands on a named tab — demo links and the screenshot harness. */
function tabFromUrl(): TabId {
    const requested = new URLSearchParams(window.location.search).get('tab');
    return TABS.some((tab) => tab.id === requested) ? (requested as TabId) : 'overview';
}

export default function App() {
    const [patientId, setPatientId] = useState<string | null>(patientIdFromUrl);
    const [patientsState, setPatientsState] = useState<PatientsFetchResult | { kind: 'loading' }>({ kind: 'loading' });
    const [overviewState, setOverviewState] = useState<OverviewFetchResult | { kind: 'loading' }>({ kind: 'loading' });
    const [factsState, setFactsState] = useState<FactsFetchResult | { kind: 'loading' }>({ kind: 'loading' });
    const [activeTab, setActiveTab] = useState<TabId>(tabFromUrl);
    const [sourceFocus, setSourceFocus] = useState<SourceFocus | null>(null);
    const [reloadNonce, setReloadNonce] = useState(0);
    const [chatOpen, setChatOpen] = useState(false);
    // Auth (Wave AZ): the demo role, whether dev-login is active, and the current capabilities.
    const [role, setRole] = useState<ClinicalRole>('physician');
    const [authActive, setAuthActive] = useState(false);
    const [capabilities, setCapabilities] = useState<AuthCapabilities | null>(null);

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
    // Auth first (Wave AZ): mint a dev token bound to THIS patient + role before the reads, so
    // enforced mode authorizes them and the cross-patient boundary is real (the token is
    // re-minted on every patient/role switch). When dev-login is disabled the reads run
    // tokenless, which is correct in AUTH_MODE=off — the panel behaves exactly as before.
    useEffect(() => {
        if (patientId === null) {
            return;
        }
        let cancelled = false;
        setOverviewState({ kind: 'loading' });
        setFactsState({ kind: 'loading' });
        void (async () => {
            const auth = await devLogin(role, patientId);
            if (cancelled) {
                return;
            }
            if (auth.ok) {
                setAuthToken(auth.token);
                setAuthActive(true);
                const me = await fetchMe();
                if (cancelled) {
                    return;
                }
                setCapabilities(me?.capabilities ?? null);
            } else {
                setAuthToken(null);
                setAuthActive(false);
                setCapabilities(null);
            }
            const [overviewResult, factsResult] = await Promise.all([fetchOverview(patientId), fetchFacts(patientId)]);
            if (!cancelled) {
                setOverviewState(overviewResult);
                setFactsState(factsResult);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [patientId, reloadNonce, role]);

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

    // Role-gated fact verification (S3.3): a physician/resident can verify; the write is
    // authorized + attributed server-side, then the overview is refetched to show the new status.
    const canVerify = capabilities !== null && capabilities.verify !== false;
    const handleVerify = useCallback(
        async (factId: string) => {
            if (patientId === null) {
                return;
            }
            const result = await verifyFact(patientId, factId);
            if (result.ok) {
                setReloadNonce((nonce) => nonce + 1);
            }
        },
        [patientId],
    );

    const overview = overviewState.kind === 'ready' ? overviewState.overview : null;
    // The insights state machine is shared by the header control and the AI Insights tab.
    const insights = useInsights(patientId, overview?.latest_brief ?? null);
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
                        <div className="max-w-6xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between gap-4">
                            <div className="min-w-0">
                                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Clinical Co-Pilot</p>
                                <h1 className="text-xl font-semibold tracking-tight truncate">{patientName}</h1>
                            </div>
                            {authActive && <RoleSwitcher role={role} capabilities={capabilities} onChange={setRole} />}
                        </div>
                    </header>

                    {/* Q5: the imaging suite escapes the centered column — scans get the full
                        viewport width beside the sidebar; every other tab keeps the reading width. */}
                    <main className={`${activeTab === 'imaging' ? 'max-w-none' : 'max-w-6xl'} mx-auto w-full px-4 sm:px-6 lg:px-8 py-8 flex-1`}>
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
                                {/* Patient header band on every tab — hosts the insights control (R2) */}
                                <div className="mb-6">
                                    <PatientHeaderBand
                                        patient={overview.patient}
                                        generatedAt={overview.generated_at}
                                        action={
                                            // Role capability made visible (AZ4): a read-only role (nurse) cannot
                                            // trigger an AI prep — the server 403s it, and the panel reflects that.
                                            capabilities !== null && !capabilities.triggerPrep ? (
                                                <span className="inline-flex items-center px-2.5 py-1 rounded-md bg-slate-100 text-xs font-medium text-slate-500">
                                                    Read-only role — AI prep disabled
                                                </span>
                                            ) : (
                                                <InsightsHeaderControl
                                                    state={insights.state}
                                                    onGenerate={insights.generate}
                                                    onRetry={insights.retry}
                                                />
                                            )
                                        }
                                    />
                                </div>

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
                                    {activeTab === 'ehr' && (
                                        <EhrRecord
                                            key={patientId}
                                            overview={overview}
                                            patientId={patientId}
                                            onSynced={() => setReloadNonce((nonce) => nonce + 1)}
                                        />
                                    )}
                                    {activeTab === 'overview' && (
                                        <Overview key={patientId} overview={overview} onOpenImaging={() => setActiveTab('imaging')} />
                                    )}
                                    {activeTab === 'background' && (
                                        <MedicalBackground factsByType={overview.facts_by_type} riskFlags={overview.medication_risk_flags} canVerify={canVerify} onVerify={handleVerify} />
                                    )}
                                    {activeTab === 'imaging' && (
                                        <>
                                            {factsState.kind === 'error' && (
                                                <p className="mb-4 p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800">
                                                    {factsState.message}
                                                </p>
                                            )}
                                            <Imaging
                                                key={patientId}
                                                imaging={overview.imaging}
                                                images={overview.images}
                                                treatments={factsState.kind === 'ready' ? factsState.bundle.treatments : []}
                                            />
                                        </>
                                    )}
                                    {activeTab === 'insights' && <AiInsightsTab state={insights.state} onRetry={insights.retry} />}
                                    {activeTab === 'careplan' && (
                                        <CarePlan
                                            carePlan={overview.care_plan}
                                            conditions={overview.facts_by_type.condition ?? []}
                                            gamePlan={insights.state.kind === 'ready' ? (insights.state.brief.content.game_plan ?? null) : null}
                                        />
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

                {/* Docked chat — keyed by patient so switching patients switches conversations */}
                {patientId !== null && overview !== null && (
                    <ChatDrawer key={patientId} patientId={patientId} open={chatOpen} onToggle={setChatOpen} />
                )}
            </div>
        </SourceNavContext.Provider>
    );
}
