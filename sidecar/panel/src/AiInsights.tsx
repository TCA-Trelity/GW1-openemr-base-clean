// AI insights (S2.11, R2 IA + R4 density): the LLM brief as an async enhancement that
// never gates the deterministic landing. useInsights owns the state machine (load an
// existing brief, generate + live prep-run stage polling); InsightsHeaderControl is the
// compact Generate/progress/Refresh affordance App mounts in the patient header band;
// AiInsightsTab renders the citation-gated brief on its own tab — one-line structured
// discussion points with kind icons + citation chips, contradiction anchors, and a
// capped questions list. Clicking Generate never navigates.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AlertTriangle,
    ArrowDown,
    CalendarRange,
    Clock,
    GitMerge,
    HelpCircle,
    Pill,
    RefreshCw,
    Scan,
    ShieldCheck,
    Sparkles,
} from 'lucide-react';
import { fetchBrief, fetchPrepRuns, startPrep } from './api';
import type { BriefContent, DiscussionPoint, DiscussionPointKind, LatestBriefPointer, PatientFact, StoredBrief } from './types';
import { formatDate, titleCase } from './ui';
import { CitationChips, factChipCitation } from './CitationChip';
import { ContradictionAlerts } from './Overview';

const POLL_INTERVAL_MS = 5000;
const FIRST_POLL_DELAY_MS = 250; // the POST already opened the prep_run row — peek right away
const POLL_LIMIT = 60; // ~5 minutes
const MAX_VISIBLE_QUESTIONS = 4;

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

// One-word spellings for the header chip — "Reading 7/12" fits where a sentence cannot.
const COMPACT_STAGE_LABELS: Record<string, string> = {
    budget_check: 'Budget',
    load_sources: 'Loading',
    llm_extraction: 'Reading',
    citation_gate: 'Verifying',
    medication_risk: 'Meds',
    imaging_analytics: 'Imaging',
    brief_assembly: 'Assembling',
    save_brief: 'Saving',
};

function labelledStage(stage: string | null, labels: Record<string, string>): string {
    if (stage === null || stage === '') {
        return 'Starting…';
    }
    const [name, progress] = stage.split(':');
    const label = labels[name ?? ''] ?? titleCase(name ?? stage);
    return progress !== undefined ? `${label} ${progress}` : label;
}

/** 'llm_extraction:7/12' -> 'Reading documents 7/12'; unknown stages fall back to title case. */
export function stageLabel(stage: string | null): string {
    return labelledStage(stage, STAGE_LABELS);
}

/** 'llm_extraction:7/12' -> 'Reading 7/12' — the header chip spelling. */
export function compactStageLabel(stage: string | null): string {
    return labelledStage(stage, COMPACT_STAGE_LABELS);
}

export type InsightsState =
    | { kind: 'loading' }
    | { kind: 'idle' }
    | { kind: 'generating'; stage: string | null }
    | { kind: 'ready'; brief: StoredBrief }
    | { kind: 'error'; message: string; retry: 'load' | 'generate' };

export interface InsightsController {
    state: InsightsState;
    generate: () => void;
    /** Error-state retry: re-runs whichever step failed (load vs generate). */
    retry: () => void;
}

/**
 * The insights state machine, lifted to App (R2): the header control and the AI Insights
 * tab render the same state. /api/brief is fetched ONLY when the overview says a brief
 * exists — never in the deterministic load path otherwise.
 */
export function useInsights(patientId: string | null, latestBrief: LatestBriefPointer | null): InsightsController {
    const [state, setState] = useState<InsightsState>({ kind: 'idle' });
    const pollCount = useRef(0);

    const loadBrief = useCallback(async () => {
        if (patientId === null) {
            return;
        }
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

    // Reset per patient / brief pointer — switching patients abandons any in-flight run's UI.
    useEffect(() => {
        pollCount.current = 0;
        if (patientId !== null && latestBrief !== null) {
            void loadBrief();
        } else {
            setState({ kind: 'idle' });
        }
    }, [patientId, latestBrief, loadBrief]);

    const generate = useCallback(async () => {
        if (patientId === null) {
            return;
        }
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
        if (state.kind !== 'generating' || patientId === null) {
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

    const retry = useCallback(() => {
        if (state.kind === 'error') {
            void (state.retry === 'load' ? loadBrief() : generate());
        }
    }, [state, loadBrief, generate]);

    return { state, generate: () => void generate(), retry };
}

// ---- Header control (R2): Generate -> compact progress -> subtle Refresh ----

export function InsightsHeaderControl({
    state,
    onGenerate,
    onRetry,
}: {
    state: InsightsState;
    onGenerate: () => void;
    onRetry: () => void;
}) {
    if (state.kind === 'loading') {
        return <span className="text-xs text-slate-400">Loading insights…</span>;
    }
    if (state.kind === 'generating') {
        return (
            <span
                data-testid="insights-header-progress"
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-blue-200 bg-blue-50 text-xs font-medium text-blue-700"
            >
                <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse" />
                {compactStageLabel(state.stage)}
            </span>
        );
    }
    if (state.kind === 'ready') {
        return (
            <button
                type="button"
                onClick={onGenerate}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-slate-200 text-xs text-slate-500 hover:text-slate-700 hover:bg-slate-50 transition-colors"
            >
                <RefreshCw className="w-3 h-3" />
                Refresh insights
            </button>
        );
    }
    if (state.kind === 'error') {
        return (
            <button
                type="button"
                title={state.message}
                onClick={onRetry}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-red-200 bg-red-50 text-xs font-medium text-red-700 hover:bg-red-100 transition-colors"
            >
                <RefreshCw className="w-3 h-3" />
                Retry insights
            </button>
        );
    }
    return (
        <button
            type="button"
            onClick={onGenerate}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 transition-colors"
        >
            <Sparkles className="w-3.5 h-3.5" />
            Generate AI insights
        </button>
    );
}

// ---- Discussion points (R4): one line each — kind icon, terse text, chips, conflict link ----

const KIND_META: Record<DiscussionPointKind, { icon: typeof Pill; className: string }> = {
    med_change: { icon: Pill, className: 'text-pink-600 bg-pink-50 border-pink-200' },
    risk_flag: { icon: AlertTriangle, className: 'text-red-600 bg-red-50 border-red-200' },
    contradiction: { icon: GitMerge, className: 'text-amber-600 bg-amber-50 border-amber-200' },
    imaging: { icon: Scan, className: 'text-blue-600 bg-blue-50 border-blue-200' },
    interval: { icon: CalendarRange, className: 'text-violet-600 bg-violet-50 border-violet-200' },
};

const ALERT_ANCHOR_PREFIX = 'insights-alert';

function scrollToAlert(contradictionId: string): void {
    const element = document.getElementById(`${ALERT_ANCHOR_PREFIX}-${contradictionId}`);
    if (element !== null && typeof element.scrollIntoView === 'function') {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

function DiscussionPointRow({
    point,
    index,
    factById,
}: {
    point: string | DiscussionPoint;
    index: number;
    factById: Map<string, PatientFact>;
}) {
    // Older stored briefs carry plain strings — render them plainly, numbered.
    if (typeof point === 'string') {
        return (
            <li data-testid="discussion-point" className="flex items-center gap-2 min-w-0">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-blue-50 border border-blue-200 text-blue-700 text-xs font-semibold flex items-center justify-center">
                    {index + 1}
                </span>
                <span className="text-sm text-slate-700 truncate" title={point}>
                    {point}
                </span>
            </li>
        );
    }
    const meta = KIND_META[point.kind];
    const Icon = meta.icon;
    const contradictionId = point.contradiction_id;
    const citations = point.fact_ids
        .map((id) => factById.get(id))
        .filter((fact): fact is PatientFact => fact !== undefined)
        .map(factChipCitation);
    return (
        <li data-testid="discussion-point" className="flex items-center gap-2 min-w-0">
            <span
                title={titleCase(point.kind)}
                className={`flex-shrink-0 w-5 h-5 rounded-md border flex items-center justify-center ${meta.className}`}
            >
                <Icon className="w-3 h-3" />
            </span>
            <span className="text-sm text-slate-700 truncate" title={point.text}>
                {point.text}
            </span>
            {citations.length > 0 && <CitationChips citations={citations} />}
            {contradictionId !== null && (
                <button
                    type="button"
                    onClick={() => scrollToAlert(contradictionId)}
                    className="flex-shrink-0 inline-flex items-center gap-1 text-[11px] font-medium text-amber-700 hover:text-amber-800"
                >
                    <ArrowDown className="w-3 h-3" />
                    view conflict
                </button>
            )}
        </li>
    );
}

// ---- The LLM-derived sections (urgency, alerts, why, hoping, discussion points, questions) ----

function InsightsBody({ brief }: { brief: StoredBrief }) {
    const content = brief.content;
    const [showAllQuestions, setShowAllQuestions] = useState(false);
    const whyFact = content.facts_by_type.chief_complaint.find((fact) => fact.id === content.why_they_are_here?.fact_id);
    const goalFact = content.facts_by_type.patient_goal.find((fact) => fact.id === content.what_they_are_hoping_for?.fact_id);
    const why = content.why_they_are_here;
    const hoping = content.what_they_are_hoping_for;
    const metrics = content.gate_metrics;
    const factById = useMemo(() => {
        const map = new Map<string, PatientFact>();
        for (const group of Object.values(content.facts_by_type)) {
            for (const fact of group) {
                map.set(fact.id, fact);
            }
        }
        return map;
    }, [content]);
    const questions = content.questions_to_confirm;
    const visibleQuestions = showAllQuestions ? questions : questions.slice(0, MAX_VISIBLE_QUESTIONS);

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

            <ContradictionAlerts alerts={content.contradiction_alerts} anchorPrefix={ALERT_ANCHOR_PREFIX} />

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
                    <ol className="space-y-1.5">
                        {content.key_discussion_points.map((point, i) => (
                            <DiscussionPointRow key={i} point={point} index={i} factById={factById} />
                        ))}
                    </ol>
                </section>
            )}

            {questions.length > 0 && (
                <section>
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-2">
                        <HelpCircle className="w-4 h-4" />
                        Questions to Confirm ({questions.length})
                    </h3>
                    <ul className="space-y-1.5">
                        {visibleQuestions.map((question, i) => (
                            <li
                                key={i}
                                data-testid="question-item"
                                className="flex items-start gap-2 p-2 rounded-lg bg-amber-50/60 border border-amber-100"
                            >
                                <HelpCircle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                                <span className="text-sm text-slate-700">{question}</span>
                            </li>
                        ))}
                    </ul>
                    {!showAllQuestions && questions.length > MAX_VISIBLE_QUESTIONS && (
                        <button
                            type="button"
                            onClick={() => setShowAllQuestions(true)}
                            className="mt-2 text-xs font-medium text-blue-600 hover:text-blue-700"
                        >
                            Show all ({questions.length})
                        </button>
                    )}
                </section>
            )}
        </div>
    );
}

// ---- The tab ----

export default function AiInsightsTab({ state, onRetry }: { state: InsightsState; onRetry: () => void }) {
    return (
        <div data-testid="ai-insights">
            {state.kind === 'loading' && <p className="text-sm text-slate-400">Loading AI insights…</p>}

            {state.kind === 'idle' && (
                <div className="text-center py-16 text-slate-400 border border-dashed border-slate-200 rounded-xl">
                    <Sparkles className="w-10 h-10 mx-auto mb-3 text-slate-300" />
                    <p className="text-sm font-medium text-slate-500">No AI insights yet</p>
                    <p className="text-xs mt-1 max-w-md mx-auto">
                        Use &ldquo;Generate AI insights&rdquo; in the patient header — the pipeline reads every document,
                        verifies each claim, and the result lands here while the rest of the app stays live.
                    </p>
                </div>
            )}

            {state.kind === 'generating' && (
                <div data-testid="insights-progress" className="flex items-center gap-2 py-2 text-sm text-slate-600">
                    <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
                    {stageLabel(state.stage)}
                    <span className="text-slate-400">— the rest of the app stays live while this runs</span>
                </div>
            )}

            {state.kind === 'error' && (
                <div className="py-2">
                    <p className="text-sm text-red-600">{state.message}</p>
                    <button
                        type="button"
                        onClick={onRetry}
                        className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-300 text-sm text-slate-600 hover:bg-slate-50"
                    >
                        <RefreshCw className="w-3.5 h-3.5" />
                        Try again
                    </button>
                </div>
            )}

            {state.kind === 'ready' && <InsightsBody brief={state.brief} />}
        </div>
    );
}
