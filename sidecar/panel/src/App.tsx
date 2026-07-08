// Panel shell: patientId from ?patient=, brief/facts fetch states, urgency banner ABOVE
// the four tabs (manifest §4), prepare-and-poll flow, and citation deep-links into Sources.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Clock, MessageSquare, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react';
import { fetchBrief, fetchFacts, startPrep, type FactsFetchResult } from './api';
import type { BriefContent, CitationRef, StoredBrief } from './types';
import { Card, formatDate } from './ui';
import { SourceNavContext } from './CitationChip';
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

type BriefState =
    | { kind: 'loading' }
    | { kind: 'ready'; brief: StoredBrief }
    | { kind: 'not_prepared' }
    | { kind: 'preparing' }
    | { kind: 'error'; message: string };

const POLL_INTERVAL_MS = 2500;
const POLL_LIMIT = 60; // ~2.5 minutes

// Urgency banner colors: high=red, moderate=amber (ContradictionAlert.jsx palette).
const URGENCY_STYLES: Record<'high' | 'moderate', { container: string; icon: string; label: string }> = {
    high: { container: 'bg-red-50 border-red-300 text-red-800', icon: 'text-red-600', label: 'High urgency' },
    moderate: { container: 'bg-amber-50 border-amber-300 text-amber-800', icon: 'text-amber-600', label: 'Moderate urgency' },
};

export function UrgencyBanner({ urgency }: { urgency: BriefContent['urgency'] }) {
    if (urgency === null) {
        return null;
    }
    const styles = URGENCY_STYLES[urgency.level];
    return (
        <div data-testid="urgency-banner" className={`rounded-xl border-2 p-4 flex items-start gap-3 ${styles.container}`}>
            <AlertTriangle className={`w-5 h-5 flex-shrink-0 mt-0.5 ${styles.icon}`} />
            <div>
                <p className="font-semibold">{styles.label}</p>
                <p className="text-sm mt-0.5">{urgency.reason}</p>
            </div>
        </div>
    );
}

export default function App() {
    const patientId = new URLSearchParams(window.location.search).get('patient') ?? 'margaret-chen';
    const [briefState, setBriefState] = useState<BriefState>({ kind: 'loading' });
    const [factsState, setFactsState] = useState<FactsFetchResult | { kind: 'loading' }>({ kind: 'loading' });
    const [activeTab, setActiveTab] = useState<TabId>('overview');
    const [sourceFocus, setSourceFocus] = useState<SourceFocus | null>(null);
    const pollCount = useRef(0);

    const loadBrief = useCallback(async () => {
        setBriefState({ kind: 'loading' });
        const result = await fetchBrief(patientId);
        setBriefState(result.kind === 'error' ? { kind: 'error', message: result.message } : result);
    }, [patientId]);

    const loadFacts = useCallback(async () => {
        setFactsState(await fetchFacts(patientId));
    }, [patientId]);

    useEffect(() => {
        void loadBrief();
        void loadFacts();
    }, [loadBrief, loadFacts]);

    // Prepare-and-poll: POST /api/prep, then poll GET /api/brief until it lands.
    const prepare = useCallback(async () => {
        setBriefState({ kind: 'preparing' });
        pollCount.current = 0;
        const accepted = await startPrep(patientId);
        if (!accepted) {
            setBriefState({ kind: 'error', message: 'The sidecar did not accept the preparation request.' });
        }
    }, [patientId]);

    useEffect(() => {
        if (briefState.kind !== 'preparing') {
            return;
        }
        const timer = setTimeout(() => {
            void (async () => {
                pollCount.current += 1;
                const result = await fetchBrief(patientId);
                if (result.kind === 'ready') {
                    setBriefState(result);
                    void loadFacts();
                } else if (pollCount.current >= POLL_LIMIT) {
                    setBriefState({ kind: 'error', message: 'Preparation timed out — check the sidecar logs.' });
                } else {
                    setBriefState({ kind: 'preparing' }); // new object re-arms this effect
                }
            })();
        }, POLL_INTERVAL_MS);
        return () => clearTimeout(timer);
    }, [briefState, patientId, loadFacts]);

    const viewSource = useCallback((citation: CitationRef) => {
        setSourceFocus({
            documentId: citation.source_document_id,
            start: citation.excerpt_location?.start_char ?? null,
            end: citation.excerpt_location?.end_char ?? null,
            excerpt: citation.excerpt_text,
        });
        setActiveTab('sources');
    }, []);

    const patientName = factsState.kind === 'ready' ? factsState.bundle.patient.name : patientId;
    const brief = briefState.kind === 'ready' ? briefState.brief : null;
    const documents = factsState.kind === 'ready' ? (factsState.bundle.documents ?? []) : [];

    return (
        <SourceNavContext.Provider value={viewSource}>
            <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
                {/* Dark chrome — echo of the prototype's slate-800 nav rail */}
                <header className="bg-slate-800 text-white">
                    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Clinical Co-Pilot</p>
                            <h1 className="text-xl font-semibold tracking-tight">{patientName}</h1>
                        </div>
                        {brief !== null && (
                            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
                                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-700/60">
                                    <Clock className="w-3.5 h-3.5" />
                                    Prepared {formatDate(brief.prepared_at)}
                                </span>
                                <span
                                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-700/60"
                                    title={`${brief.content.gate_metrics.citationsChecked} citations checked, ${brief.content.gate_metrics.citationsFailed} failed`}
                                >
                                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                                    {brief.content.gate_metrics.verified}/{brief.content.gate_metrics.claims} claims verified
                                    {brief.content.gate_metrics.blocked > 0 && ` · ${brief.content.gate_metrics.blocked} blocked`}
                                </span>
                            </div>
                        )}
                    </div>
                </header>

                <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                    {briefState.kind === 'loading' && <p className="text-center py-16 text-slate-400">Loading brief…</p>}

                    {briefState.kind === 'not_prepared' && (
                        <Card className="max-w-md mx-auto mt-8 p-8 text-center">
                            <Sparkles className="w-10 h-10 mx-auto mb-4 text-blue-500" />
                            <h2 className="text-lg font-semibold text-slate-800">No brief prepared yet</h2>
                            <p className="text-sm text-slate-500 mt-2">
                                The preparation pipeline has not run for <span className="font-medium">{patientId}</span>. It extracts
                                facts, checks every citation, and assembles the walk-in brief.
                            </p>
                            <button
                                type="button"
                                onClick={() => void prepare()}
                                className="mt-5 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors"
                            >
                                <Sparkles className="w-4 h-4" />
                                Prepare brief
                            </button>
                        </Card>
                    )}

                    {briefState.kind === 'preparing' && (
                        <div className="text-center py-16">
                            <span className="inline-flex items-center gap-2 text-slate-600">
                                <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
                                Preparing brief — extracting facts and verifying citations…
                            </span>
                        </div>
                    )}

                    {briefState.kind === 'error' && (
                        <div className="text-center py-16">
                            <p className="text-red-600">{briefState.message}</p>
                            <button
                                type="button"
                                onClick={() => void loadBrief()}
                                className="mt-4 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50"
                            >
                                <RefreshCw className="w-3.5 h-3.5" />
                                Retry
                            </button>
                        </div>
                    )}

                    {brief !== null && (
                        <>
                            {/* Urgency banner renders ABOVE the tabs (manifest §4) */}
                            <UrgencyBanner urgency={brief.content.urgency} />

                            <div className="mt-6 mb-8">
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
                                {activeTab === 'overview' && <Overview brief={brief.content} />}
                                {activeTab === 'background' && <MedicalBackground factsByType={brief.content.facts_by_type} />}
                                {activeTab === 'imaging' && (
                                    <>
                                        {factsState.kind === 'error' && (
                                            <p className="mb-4 p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800">
                                                {factsState.message}
                                            </p>
                                        )}
                                        <Imaging
                                            imaging={brief.content.imaging}
                                            images={factsState.kind === 'ready' ? factsState.bundle.images : []}
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
        </SourceNavContext.Provider>
    );
}
