// Imaging workstation tab — the image-first workspace: a visit summary strip across the top,
// then Workspace / Timeline / Trends / Intervals / Compare sub-tabs over the fact bundle's
// image+treatment records. The Workspace (default) puts the selected B-scan center-stage on a
// dark surround with acquisition metadata + findings/measurements in the margins and the trend
// charts beneath; the Timeline keeps the merged image+injection stream. Timeline merging, series
// extraction, and the visit summary are display math only; the clinical judgments (interval
// recommendation, HCQ progression) render from the overview's server-computed imaging block.
import { useEffect, useState } from 'react';
import { AlertTriangle, CalendarRange, CheckCircle, Clock, GitCompare, LayoutDashboard, Syringe, TrendingUp } from 'lucide-react';
import type {
    BriefContent,
    ImageRecord,
    IntervalPatternAnalysis,
    TreatmentResponseAssessment,
    TreatmentWireRecord,
} from '../types';
import { Card, formatDate, titleCase } from '../ui';
import { CHANGE_ICONS, RESPONSE_BADGES, TreatmentContextBadge, medicationLabel } from './badges';
import ScanImage, { modalityLabel } from './ScanImage';
import Workspace from './Workspace';
import Trends from './Trends';
import Compare from './Compare';
import IntervalLadder from './IntervalLadder';
import VisitSummaryStrip from './VisitSummaryStrip';
import { computeVisitSummary } from './summary';

type SubTabId = 'workspace' | 'timeline' | 'trends' | 'intervals' | 'compare';

const SUB_TABS: { id: SubTabId; label: string; icon: typeof Clock }[] = [
    { id: 'workspace', label: 'Workspace', icon: LayoutDashboard },
    { id: 'timeline', label: 'Timeline', icon: Clock },
    { id: 'trends', label: 'Trends', icon: TrendingUp },
    { id: 'intervals', label: 'Intervals', icon: CalendarRange },
    { id: 'compare', label: 'Compare', icon: GitCompare },
];

// ---- Timeline (port of ImagingTimeline.jsx, light theme) ----

export type TimelineEvent =
    | { kind: 'image'; date: string; image: ImageRecord }
    | { kind: 'treatment'; date: string; treatment: TreatmentWireRecord };

/** Merge image and treatment records into one reverse-chronological stream. */
export function mergeTimeline(images: ImageRecord[], treatments: TreatmentWireRecord[]): TimelineEvent[] {
    return [
        ...images.map<TimelineEvent>((image) => ({ kind: 'image', date: image.image_metadata.capture_date, image })),
        ...treatments.map<TimelineEvent>((treatment) => ({ kind: 'treatment', date: treatment.treatment_date, treatment })),
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

function TreatmentRow({ treatment }: { treatment: TreatmentWireRecord }) {
    const details = treatment.payload.injection_details;
    const name =
        details != null ? medicationLabel(details.medication) : titleCase(treatment.payload.treatment_type ?? 'treatment');
    return (
        <div data-testid="timeline-event" className="flex items-center gap-3 py-2 px-3">
            <div className="w-8 h-8 rounded-full bg-purple-50 border border-purple-200 flex items-center justify-center flex-shrink-0">
                <Syringe className="w-4 h-4 text-purple-600" />
            </div>
            <div>
                <p className="text-sm font-medium text-purple-700">
                    {name}
                    {details?.dose !== undefined && <span className="text-purple-500 font-normal"> · {details.dose}</span>}
                </p>
                <p className="text-xs text-slate-500">
                    {formatDate(treatment.treatment_date)}
                    {details?.laterality !== undefined && <span> · {details.laterality.toUpperCase()}</span>}
                    {details?.injection_number !== undefined && <span> · Injection #{details.injection_number}</span>}
                </p>
            </div>
        </div>
    );
}

function ImageRow({ image, onSelect }: { image: ImageRecord; onSelect: () => void }) {
    const meta = image.image_metadata;
    const analysis = image.ai_analysis;
    const change = analysis?.comparison_to_prior?.overall_change;
    const changeConfig = change !== undefined ? CHANGE_ICONS[change] : null;
    const ChangeIcon = changeConfig?.icon ?? null;
    const response = analysis?.comparison_to_prior?.treatment_response;
    const crt = analysis?.measurements?.find((m) => m.measurement_type === 'central_retinal_thickness');
    const highAlert = analysis?.summary?.alerts?.some((alert) => alert.level === 'high') ?? false;

    return (
        <button
            type="button"
            data-testid="timeline-event"
            aria-label={`Open ${modalityLabel(meta.modality)} ${meta.laterality.toUpperCase()} — ${formatDate(meta.capture_date)}`}
            onClick={onSelect}
            className="w-full text-left flex items-start gap-3 p-3 rounded-xl bg-white border border-slate-200 hover:border-blue-300 hover:shadow-sm transition-all"
        >
            <ScanImage image={image} className="w-20 h-14 flex-shrink-0" />
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-sm font-medium text-slate-800">
                        {modalityLabel(meta.modality)} {meta.laterality.toUpperCase()}
                    </span>
                    {ChangeIcon !== null && changeConfig !== null && (
                        <ChangeIcon aria-label={`Change: ${change ?? ''}`} className={`w-3.5 h-3.5 ${changeConfig.className}`} />
                    )}
                    {highAlert && <AlertTriangle className="w-3.5 h-3.5 text-red-500" />}
                </div>
                <p className="text-xs text-slate-500 mb-1 flex items-center gap-2 flex-wrap">
                    {formatDate(meta.capture_date)}
                    <TreatmentContextBadge context={image.treatment_context} />
                </p>
                {analysis?.summary?.headline !== undefined && (
                    <p className="text-xs text-slate-600 truncate">{analysis.summary.headline}</p>
                )}
                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    {crt !== undefined && (
                        <span className="inline-flex px-2 py-0.5 rounded-md border text-xs bg-slate-50 text-slate-600 border-slate-200">
                            CRT: {crt.value}µm
                        </span>
                    )}
                    {response != null && (
                        <span className={`inline-flex px-2 py-0.5 rounded-md border text-xs font-medium ${RESPONSE_BADGES[response.assessment].className}`}>
                            {RESPONSE_BADGES[response.assessment].label}
                        </span>
                    )}
                </div>
            </div>
        </button>
    );
}

function Timeline({
    images,
    treatments,
    onSelectImage,
}: {
    images: ImageRecord[];
    treatments: TreatmentWireRecord[];
    onSelectImage: (id: string) => void;
}) {
    const events = mergeTimeline(images, treatments);
    return (
        <div className="space-y-2">
            {events.map((event) =>
                event.kind === 'image' ? (
                    <ImageRow key={`img-${event.image.id}`} image={event.image} onSelect={() => onSelectImage(event.image.id)} />
                ) : (
                    <TreatmentRow key={`tx-${event.treatment.id}`} treatment={event.treatment} />
                ),
            )}
        </div>
    );
}

// ---- Interval analysis (ports of IntervalAnalysis.jsx banner + TrendAnalysis.jsx card) ----

const OUTCOME_BADGES: Record<TreatmentResponseAssessment, { label: string; className: string }> = {
    good_response: { label: 'Dry', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
    worsened: { label: 'Leaked', className: 'bg-red-50 text-red-700 border-red-200' },
    no_response: { label: 'Leaked', className: 'bg-red-50 text-red-700 border-red-200' },
    partial_response: { label: 'Partial', className: 'bg-amber-50 text-amber-700 border-amber-200' },
};

const CONFIDENCE_BADGES: Record<IntervalPatternAnalysis['confidence'], string> = {
    high: 'border-emerald-300 text-emerald-700',
    medium: 'border-amber-300 text-amber-700',
    low: 'border-slate-300 text-slate-500',
};

/** Bottom recommendation bar (IntervalAnalysis.jsx) — shown with the Timeline sub-tab. */
function IntervalRecommendationBanner({ analysis }: { analysis: IntervalPatternAnalysis }) {
    if (analysis.recommendation === '') {
        return null;
    }
    return (
        <div
            data-testid="interval-banner"
            className="mt-4 p-3 rounded-xl border border-blue-200 bg-blue-50 flex flex-wrap items-center justify-between gap-3"
        >
            <div className="flex flex-wrap items-center gap-4">
                {analysis.optimal_interval !== null && (
                    <span className="flex items-center gap-2 text-sm text-slate-700">
                        <Clock className="w-4 h-4 text-blue-600" />
                        Optimal interval: <strong className="text-slate-900">{analysis.optimal_interval} weeks</strong>
                    </span>
                )}
                <span className="flex items-center gap-1 text-sm text-emerald-700">
                    <CheckCircle className="w-3.5 h-3.5" />
                    {analysis.pattern_summary.good_response_count} dry
                </span>
                {analysis.pattern_summary.poor_response_count > 0 && (
                    <span className="flex items-center gap-1 text-sm text-red-700">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        {analysis.pattern_summary.poor_response_count} leaked
                    </span>
                )}
            </div>
            <div className="flex items-center gap-2">
                <p className="text-sm text-slate-600 max-w-md">{analysis.recommendation}</p>
                <span className={`inline-flex px-2 py-0.5 rounded-md border text-xs font-medium ${CONFIDENCE_BADGES[analysis.confidence]}`}>
                    {analysis.confidence} confidence
                </span>
            </div>
        </div>
    );
}

function IntervalsView({ analysis }: { analysis: IntervalPatternAnalysis }) {
    if (analysis.intervals.length === 0) {
        return (
            <div className="text-center py-12 text-slate-400 border border-dashed border-slate-200 rounded-xl">
                <Syringe className="w-10 h-10 mx-auto mb-3 text-slate-300" />
                <p className="text-sm font-medium text-slate-500">No treatment cycles to analyze</p>
                <p className="text-xs mt-1">Interval analysis needs images with a treatment response assessment</p>
            </div>
        );
    }
    const stats: { value: string; label: string; className: string }[] = [
        { value: String(analysis.pattern_summary.total_cycles), label: 'Treatment Cycles', className: 'text-slate-800' },
        { value: String(analysis.pattern_summary.good_response_count), label: 'Good Response', className: 'text-emerald-600' },
        { value: String(analysis.pattern_summary.poor_response_count), label: 'Poor Response', className: 'text-red-600' },
        { value: analysis.pattern_summary.average_interval !== null ? String(analysis.pattern_summary.average_interval) : '—', label: 'Avg Interval (wks)', className: 'text-blue-600' },
    ];
    return (
        <div className="space-y-6">
            {/* The treat-and-extend ladder (must-have #3) reads the same intervals[] as the table below. */}
            <IntervalLadder analysis={analysis} />
            <Card className="p-5">
            <h3 className="text-base font-semibold text-slate-800 mb-4 flex items-center gap-2">
                <Syringe className="w-5 h-5 text-purple-600" />
                Treatment Interval Analysis
            </h3>
            <div className="grid grid-cols-4 gap-4 mb-4">
                {stats.map((stat) => (
                    <div key={stat.label} className="text-center">
                        <p className={`text-2xl font-bold ${stat.className}`}>{stat.value}</p>
                        <p className="text-xs text-slate-500">{stat.label}</p>
                    </div>
                ))}
            </div>
            {analysis.recommendation !== '' && (
                <div className="p-3 rounded-lg bg-blue-50 border border-blue-200">
                    <p className="text-sm text-blue-800">{analysis.recommendation}</p>
                    <p className="text-xs text-blue-600 mt-1">
                        {analysis.optimal_interval !== null && `Optimal ~${analysis.optimal_interval} weeks · `}
                        confidence: {analysis.confidence}
                    </p>
                </div>
            )}
            <ul className="mt-4 space-y-2">
                {analysis.intervals.map((interval, index) => (
                    <li key={index} className="flex items-center justify-between p-2 rounded-lg bg-slate-50 border border-slate-100">
                        <span className="flex items-baseline gap-2">
                            <span className="text-sm text-slate-700 font-medium">{interval.interval_weeks} weeks</span>
                            {interval.image_date !== undefined && (
                                <span className="text-xs text-slate-400">{formatDate(interval.image_date)}</span>
                            )}
                            {interval.medication !== undefined && (
                                <span className="text-xs text-slate-400">{medicationLabel(interval.medication)}</span>
                            )}
                        </span>
                        <span className={`inline-flex px-2 py-0.5 rounded-md border text-xs font-medium ${OUTCOME_BADGES[interval.outcome].className}`}>
                            {OUTCOME_BADGES[interval.outcome].label}
                        </span>
                    </li>
                ))}
            </ul>
            </Card>
        </div>
    );
}

// ---- The tab ----

export default function Imaging({
    imaging,
    images,
    treatments,
    onAsk,
    onViewScan,
    focus = null,
}: {
    imaging: BriefContent['imaging'];
    images: ImageRecord[];
    treatments: TreatmentWireRecord[];
    /** Ask-about-this-scan (M6): threaded to the Workspace's seed button. */
    onAsk?: (text: string) => void;
    /** IC3: reports the scan open in the Workspace so chat turns can say "this scan". */
    onViewScan?: (id: string | null) => void;
    /** IC2: chat -> viewer focus; a fresh object per request re-fires even for the same id. */
    focus?: { id: string; nonce: number } | null;
}) {
    const hasImages = images.length > 0;
    // Land on the image-first Workspace when there are scans; fall back to Timeline otherwise.
    const [activeSubTab, setActiveSubTab] = useState<SubTabId>(hasImages ? 'workspace' : 'timeline');
    const [compareIds, setCompareIds] = useState<string[]>([]);
    // Default the workspace to the most recent scan so it is never empty on first paint.
    const [selectedImageId, setSelectedImageId] = useState<string | null>(() => latestImageId(images));
    // True only when the workspace was opened by clicking a timeline row (shows a back link).
    const [fromTimeline, setFromTimeline] = useState(false);

    const summary = computeVisitSummary(images, imaging.interval_analysis, imaging.hcq_progression);

    // IC3: report the viewed scan upward — on mount (the workspace defaults to the latest
    // scan) and on every selection. Deliberately not cleared on unmount: "the scan I was
    // just looking at" should still resolve after the physician switches tabs to ask.
    useEffect(() => {
        onViewScan?.(selectedImageId);
    }, [selectedImageId, onViewScan]);

    // IC2: chat asked to open a scan (sparkline point / compare thumbnail). Honor it on
    // mount and on every fresh request; ids not in this patient's set are ignored.
    useEffect(() => {
        if (focus !== null && images.some((image) => image.id === focus.id)) {
            setSelectedImageId(focus.id);
            setFromTimeline(false);
            setActiveSubTab('workspace');
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- fire per focus request, not per images identity
    }, [focus]);

    const selectTab = (id: SubTabId) => {
        setFromTimeline(false);
        setActiveSubTab(id);
    };

    const openInWorkspace = (id: string) => {
        setSelectedImageId(id);
        setFromTimeline(true);
        setActiveSubTab('workspace');
    };

    if (images.length === 0 && treatments.length === 0) {
        return (
            <div className="text-center py-16 text-slate-400 border border-dashed border-slate-200 rounded-xl">
                <Clock className="w-10 h-10 mx-auto mb-3 text-slate-300" />
                <p className="text-sm font-medium text-slate-500">No imaging records on file for this patient</p>
            </div>
        );
    }

    return (
        <div>
            {/* Header line + optimal-interval chip (ImagingView.jsx header) */}
            <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                <p className="text-sm text-slate-500">
                    {images.length} image{images.length !== 1 ? 's' : ''} · {treatments.length} treatment
                    {treatments.length !== 1 ? 's' : ''}
                </p>
                {imaging.interval_analysis.optimal_interval !== null && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium bg-blue-50 text-blue-700 border-blue-200">
                        <Clock className="w-3.5 h-3.5" />
                        Optimal: {imaging.interval_analysis.optimal_interval} weeks
                    </span>
                )}
            </div>

            {/* Visit summary strip across the top of the tab (must-have #4) — always visible. */}
            {hasImages && <VisitSummaryStrip summary={summary} />}

            {/* Sub-tab bar */}
            <div role="tablist" aria-label="Imaging views" className="inline-flex p-1 bg-slate-100 rounded-xl mb-5 flex-wrap">
                {SUB_TABS.map((tab) => {
                    const Icon = tab.icon;
                    return (
                        <button
                            key={tab.id}
                            role="tab"
                            aria-selected={activeSubTab === tab.id}
                            onClick={() => selectTab(tab.id)}
                            className={`flex items-center gap-1.5 px-3 sm:px-4 py-2 text-sm font-medium rounded-lg transition-all duration-200 ${
                                activeSubTab === tab.id ? 'text-slate-800 bg-white shadow-sm' : 'text-slate-500 hover:text-slate-700'
                            }`}
                        >
                            <Icon className="w-4 h-4" />
                            {tab.label}
                        </button>
                    );
                })}
            </div>

            <div role="tabpanel">
                {activeSubTab === 'workspace' && (
                    <Workspace
                        images={images}
                        selectedId={selectedImageId}
                        onSelect={setSelectedImageId}
                        hcq={imaging.hcq_progression}
                        onBack={fromTimeline ? () => setActiveSubTab('timeline') : undefined}
                        {...(onAsk === undefined ? {} : { onAsk })}
                    />
                )}
                {activeSubTab === 'timeline' && (
                    <>
                        <Timeline images={images} treatments={treatments} onSelectImage={openInWorkspace} />
                        <IntervalRecommendationBanner analysis={imaging.interval_analysis} />
                    </>
                )}
                {activeSubTab === 'trends' && <Trends images={images} hcq={imaging.hcq_progression} />}
                {activeSubTab === 'intervals' && <IntervalsView analysis={imaging.interval_analysis} />}
                {activeSubTab === 'compare' && <Compare images={images} selectedIds={compareIds} onChange={setCompareIds} />}
            </div>
        </div>
    );
}

/** Most recent scan's id by capture date, or null when there are no scans. */
function latestImageId(images: ImageRecord[]): string | null {
    return (
        [...images].sort(
            (a, b) =>
                new Date(b.image_metadata.capture_date).getTime() - new Date(a.image_metadata.capture_date).getTime(),
        )[0]?.id ?? null
    );
}
