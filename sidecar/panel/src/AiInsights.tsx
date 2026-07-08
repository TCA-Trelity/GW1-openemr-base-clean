// AI insights card (S2.11): the LLM brief as an async enhancement — renders the
// citation-gated sections when a brief exists, else offers Generate + live prep-run
// stage polling. It never gates or blocks the deterministic landing around it.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Clock, HelpCircle, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react';
import { fetchBrief, fetchPrepRuns, startPrep } from './api';
import type { BriefContent, LatestBriefPointer, StoredBrief } from './types';
import { Card, SectionLabel, formatDate, titleCase } from './ui';
import { CitationChips } from './CitationChip';

const POLL_INTERVAL_MS = 5000;
const FIRST_POLL_DELAY_MS = 250; // the POST already opened the prep_run row — peek right away
const POLL_LIMIT = 60; // ~5 minutes

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

// Doctor-facing labels for the pipeline's stage names (prep/pipeline.ts runStage calls).
const STAGE_LABELS: Record<string, string> = {
    budget_check: 'Checking budget',
    load_sources: 'Loading documents',
    llm_extraction: 'Reading documents',
    citation_gate: 'Verifying citations',
    medication_risk: 'Screening medication risks',
    imaging_analytics: 'Analyzing imaging',
    brief_assembly: 'Assembling insights',
    save_brief: 'Saving insights',
};

/** 'llm_extraction:7/12' -> 'Reading documents 7/12'; unknown stages fall back to title case. */
export function stageLabel(stage: string | null): string {
    if (stage === null || stage === '') {
        return 'Starting…';
    }
    const [name, progress] = stage.split(':');
    const label = STAGE_LABELS[name ?? ''] ?? titleCase(name ?? stage);
    return progress !== undefined ? `${label} ${progress}` : label;
}

type InsightsState =
    | { kind: 'loading' }
    | { kind: 'idle' }
    | { kind: 'generating'; stage: string | null }
    | { kind: 'ready'; brief: StoredBrief }
    | { kind: 'error'; message: string; retry: 'load' | 'generate' };

// ---- The LLM-derived sections (urgency, why, hoping, discussion points, questions) ----

function InsightsBody({ brief }: { brief: StoredBrief }) {
    const content = brief.content;
    const whyFact = content.facts_by_type.chief_complaint.find((fact) => fact.id === content.why_they_are_here?.fact_id);
    const goalFact = content.facts_by_type.patient_goal.find((fact) => fact.id === content.what_they_are_hoping_for?.fact_id);
    const why = content.why_they_are_here;
    const hoping = content.what_they_are_hoping_for;
    const metrics = content.gate_metrics;

    return (
        <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border bg-violet-50 text-violet-700 border-violet-200 font-medium">
                    <Sparkles className="w-3.5 h-3.5" />
                    AI-prepared · citation-gated
                </span>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border bg-slate-50 text-slate-600 border-slate-200">
                    <Clock className="w-3.5 h-3.5" />
                    Prepared {formatDate(brief.prepared_at)}
                </span>
                <span
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border bg-emerald-50 text-emerald-700 border-emerald-200"
                    title={`${metrics.citationsChecked} citations checked, ${metrics.citationsFailed} failed`}
                >
                    <ShieldCheck className="w-3.5 h-3.5" />
                    {metrics.verified}/{metrics.claims} claims verified
                    {metrics.blocked > 0 && ` · ${metrics.blocked} blocked`}
                </span>
            </div>

            <UrgencyBanner urgency={content.urgency} />

            {why !== null && (
                <section>
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Why They&rsquo;re Here</h3>
                    <div className="text-slate-700 leading-relaxed">
                        {why.content.statement}
                        {whyFact !== undefined && <CitationChips citations={whyFact.sources} />}
                    </div>
                    <div className="mt-1.5 text-sm text-slate-500 space-y-0.5">
                        {why.content.onset !== undefined && <p>Onset: {why.content.onset}</p>}
                        {why.content.progression !== undefined && <p>Progression: {why.content.progression}</p>}
                        {why.content.pertinent_negatives !== undefined && why.content.pertinent_negatives.length > 0 && (
                            <p>Pertinent negatives: {why.content.pertinent_negatives.join('; ')}</p>
                        )}
                    </div>
                </section>
            )}

            {hoping !== null && (
                <section className="bg-gradient-to-br from-blue-50 to-white rounded-xl p-4 border border-blue-200">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-blue-700 mb-2">What They&rsquo;re Hoping For</h3>
                    <div className="text-slate-800 leading-relaxed font-medium">
                        {hoping.content.goal}
                        {goalFact !== undefined && <CitationChips citations={goalFact.sources} />}
                    </div>
                    {hoping.content.specific_concerns !== undefined && hoping.content.specific_concerns.length > 0 && (
                        <ul className="mt-2 space-y-1">
                            {hoping.content.specific_concerns.map((concern, i) => (
                                <li key={i} className="flex items-start gap-2 text-sm text-slate-600">
                                    <span className="text-blue-500 mt-0.5">•</span>
                                    {concern}
                                </li>
                            ))}
                        </ul>
                    )}
                    {hoping.content.verbatim_quotes !== undefined && hoping.content.verbatim_quotes.length > 0 && (
                        <p className="mt-2 text-sm text-slate-500 italic">&ldquo;{hoping.content.verbatim_quotes[0]}&rdquo;</p>
                    )}
                </section>
            )}

            {content.key_discussion_points.length > 0 && (
                <section>
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">
                        Key Discussion Points ({content.key_discussion_points.length})
                    </h3>
                    <ol className="space-y-2">
                        {content.key_discussion_points.map((point, i) => (
                            <li key={i} className="flex items-start gap-3">
                                <span className="flex-shrink-0 w-5 h-5 mt-0.5 rounded-full bg-blue-50 border border-blue-200 text-blue-700 text-xs font-semibold flex items-center justify-center">
                                    {i + 1}
                                </span>
                                <span className="text-sm text-slate-700">{point}</span>
                            </li>
                        ))}
                    </ol>
                </section>
            )}

            {content.questions_to_confirm.length > 0 && (
                <section>
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-2">
                        <HelpCircle className="w-4 h-4" />
                        Questions to Confirm ({content.questions_to_confirm.length})
                    </h3>
                    <ul className="space-y-2">
                        {content.questions_to_confirm.map((question, i) => (
                            <li key={i} className="flex items-start gap-3 p-3 rounded-lg bg-amber-50/60 border border-amber-100">
                                <HelpCircle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                                <span className="text-sm text-slate-700">{question}</span>
                            </li>
                        ))}
                    </ul>
                </section>
            )}
        </div>
    );
}

// ---- The card ----

export default function AiInsights({
    patientId,
    latestBrief,
}: {
    patientId: string;
    latestBrief: LatestBriefPointer | null;
}) {
    const [state, setState] = useState<InsightsState>(latestBrief !== null ? { kind: 'loading' } : { kind: 'idle' });
    const pollCount = useRef(0);

    const loadBrief = useCallback(async () => {
        setState({ kind: 'loading' });
        const result = await fetchBrief(patientId);
        if (result.kind === 'ready') {
            setState({ kind: 'ready', brief: result.brief });
        } else if (result.kind === 'not_prepared') {
            setState({ kind: 'idle' });
        } else {
            setState({ kind: 'error', message: result.message, retry: 'load' });
        }
    }, [patientId]);

    // /api/brief is fetched ONLY when the overview says a brief exists — never in the load path otherwise.
    useEffect(() => {
        if (latestBrief !== null) {
            void loadBrief();
        }
    }, [latestBrief, loadBrief]);

    const generate = useCallback(async () => {
        pollCount.current = 0;
        setState({ kind: 'generating', stage: null });
        const result = await startPrep(patientId);
        if (result.kind === 'reused') {
            void loadBrief();
        } else if (result.kind === 'rejected' || result.kind === 'error') {
            setState({ kind: 'error', message: result.message, retry: 'generate' });
        }
        // 'accepted' (or 'already_running'): the polling effect below takes over.
    }, [patientId, loadBrief]);

    // Poll prep-runs while generating; each setState with a fresh object re-arms this effect.
    useEffect(() => {
        if (state.kind !== 'generating') {
            return;
        }
        const timer = setTimeout(
            () => {
                void (async () => {
                    pollCount.current += 1;
                    const result = await fetchPrepRuns(patientId);
                    if (result.kind === 'error') {
                        // Transient — keep polling until the limit.
                        if (pollCount.current >= POLL_LIMIT) {
                            setState({ kind: 'error', message: result.message, retry: 'generate' });
                        } else {
                            setState({ kind: 'generating', stage: state.stage });
                        }
                        return;
                    }
                    const run = result.runs[0]; // newest-first
                    if (run !== undefined && run.status === 'complete') {
                        void loadBrief();
                        return;
                    }
                    if (run !== undefined && run.status === 'failed') {
                        setState({
                            kind: 'error',
                            message: run.error ?? 'Preparation failed — check the sidecar logs.',
                            retry: 'generate',
                        });
                        return;
                    }
                    if (pollCount.current >= POLL_LIMIT) {
                        setState({ kind: 'error', message: 'Preparation timed out — check the sidecar logs.', retry: 'generate' });
                        return;
                    }
                    setState({ kind: 'generating', stage: run?.stage ?? null });
                })();
            },
            pollCount.current === 0 ? FIRST_POLL_DELAY_MS : POLL_INTERVAL_MS,
        );
        return () => clearTimeout(timer);
    }, [state, patientId, loadBrief]);

    return (
        <section data-testid="ai-insights">
            <SectionLabel>
                <Sparkles className="w-4 h-4" />
                AI Insights
            </SectionLabel>
            <Card className="p-5">
                {state.kind === 'loading' && <p className="text-sm text-slate-400">Loading AI insights…</p>}

                {state.kind === 'idle' && (
                    <div className="text-center py-4">
                        <Sparkles className="w-8 h-8 mx-auto mb-3 text-blue-500" />
                        <p className="text-sm font-medium text-slate-700">No AI insights yet</p>
                        <p className="text-sm text-slate-500 mt-1 max-w-md mx-auto">
                            Generate a citation-gated briefing: the pipeline reads every document, verifies each claim, and lands
                            here when done — the rest of this page stays live.
                        </p>
                        <button
                            type="button"
                            onClick={() => void generate()}
                            className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors"
                        >
                            <Sparkles className="w-4 h-4" />
                            Generate AI insights
                        </button>
                    </div>
                )}

                {state.kind === 'generating' && (
                    <div data-testid="insights-progress" className="flex items-center gap-2 py-2 text-sm text-slate-600">
                        <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
                        {stageLabel(state.stage)}
                        <span className="text-slate-400">— the rest of the page stays live while this runs</span>
                    </div>
                )}

                {state.kind === 'error' && (
                    <div className="py-2">
                        <p className="text-sm text-red-600">{state.message}</p>
                        <button
                            type="button"
                            onClick={() => void (state.retry === 'load' ? loadBrief() : generate())}
                            className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50"
                        >
                            <RefreshCw className="w-3.5 h-3.5" />
                            Try again
                        </button>
                    </div>
                )}

                {state.kind === 'ready' && <InsightsBody brief={state.brief} />}
            </Card>
        </section>
    );
}
