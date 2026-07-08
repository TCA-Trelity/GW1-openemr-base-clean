// Combined scan view (R6) — AIFindingsPanel.jsx's information design on the panel's light
// surface: the scan LEFT, an analysis panel RIGHT driven entirely by the record's authored
// ai_analysis + image_metadata (findings with severity styling, measurements with reference
// ranges and the delta vs the prior image in the series, treatment context, comparison to
// prior), with the Trends chart directly beneath — one sweep, no sub-tab hopping.
import { AlertTriangle, ArrowLeft, Minus, Sparkles, TrendingDown, TrendingUp } from 'lucide-react';
import type { HcqProgressionAnalysis, ImageRecord, ImagingMeasurement, ImagingScanFinding } from '../types';
import { Card, formatDate, titleCase } from '../ui';
import { CHANGE_BADGES, RESPONSE_BADGES, TreatmentContextBadge } from './badges';
import ScanImage, { modalityLabel } from './ScanImage';
import Trends from './Trends';

/** The prior image in the same modality+laterality series, by capture date. */
export function priorInSeries(image: ImageRecord, images: ImageRecord[]): ImageRecord | null {
    const series = images
        .filter(
            (candidate) =>
                candidate.image_metadata.modality === image.image_metadata.modality &&
                candidate.image_metadata.laterality.toUpperCase() === image.image_metadata.laterality.toUpperCase(),
        )
        .sort((a, b) => new Date(a.image_metadata.capture_date).getTime() - new Date(b.image_metadata.capture_date).getTime());
    const index = series.findIndex((candidate) => candidate.id === image.id);
    return index > 0 ? (series[index - 1] ?? null) : null;
}

/** Delta vs the prior record where computable — the same measurement_type on both records. */
export function measurementDelta(measurement: ImagingMeasurement, prior: ImageRecord | null): number | null {
    const previous = prior?.ai_analysis?.measurements?.find((m) => m.measurement_type === measurement.measurement_type);
    return previous === undefined ? null : measurement.value - previous.value;
}

const FINDING_SEVERITY: Record<'mild' | 'moderate' | 'severe', string> = {
    severe: 'bg-red-50 text-red-700 border-red-200',
    moderate: 'bg-amber-50 text-amber-700 border-amber-200',
    mild: 'bg-slate-50 text-slate-600 border-slate-200',
};

function FindingRow({ finding }: { finding: ImagingScanFinding }) {
    const detail = [finding.description, finding.location].filter((part) => part !== undefined && part !== '').join(' · ');
    return (
        <li data-testid="finding-row" className="flex items-center gap-2 py-1.5 border-b border-slate-100 last:border-0 min-w-0">
            <span className="text-sm font-medium text-slate-700 flex-shrink-0">{titleCase(finding.finding_type)}</span>
            {finding.severity !== undefined && (
                <span className={`inline-flex px-1.5 py-0.5 rounded-md border text-[11px] font-medium flex-shrink-0 ${FINDING_SEVERITY[finding.severity]}`}>
                    {finding.severity}
                </span>
            )}
            {finding.confidence !== undefined && (
                <span className="text-[11px] text-slate-400 flex-shrink-0">{Math.round(finding.confidence * 100)}%</span>
            )}
            {detail !== '' && (
                <span className="text-xs text-slate-500 truncate" title={detail}>
                    {detail}
                </span>
            )}
        </li>
    );
}

function MeasurementRow({ measurement, prior }: { measurement: ImagingMeasurement; prior: ImageRecord | null }) {
    const range = measurement.reference_range;
    const inRange = range !== undefined ? measurement.value >= range.normal_min && measurement.value <= range.normal_max : null;
    const delta = measurementDelta(measurement, prior);
    const DeltaIcon = delta === null ? null : delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : Minus;
    return (
        <li data-testid="measurement-row" className="flex items-center gap-2 py-1.5 border-b border-slate-100 last:border-0 min-w-0">
            <span className="text-sm text-slate-600 truncate">{titleCase(measurement.measurement_type)}</span>
            <span className="ml-auto flex items-baseline gap-1 flex-shrink-0">
                <span className={`text-sm font-semibold ${inRange === false ? 'text-amber-700' : 'text-slate-800'}`}>
                    {measurement.value}
                </span>
                {measurement.unit !== undefined && <span className="text-xs text-slate-400">{measurement.unit}</span>}
            </span>
            {delta !== null && DeltaIcon !== null && (
                // Direction only — whether a rise is good or bad depends on the metric, so no judgment color.
                <span
                    data-testid="measurement-delta"
                    className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md border text-[11px] font-medium flex-shrink-0 bg-slate-50 text-slate-600 border-slate-200"
                >
                    <DeltaIcon className="w-3 h-3" />
                    {delta > 0 ? `+${delta}` : delta} vs prior
                </span>
            )}
            {range !== undefined && (
                <span className="text-[11px] text-slate-400 flex-shrink-0">
                    normal {range.normal_min}–{range.normal_max}
                </span>
            )}
        </li>
    );
}

export default function ScanDetail({
    image,
    images,
    hcq,
    onBack,
}: {
    image: ImageRecord;
    /** The full record set — prior-in-series resolution and the Trends chart read from it. */
    images: ImageRecord[];
    hcq: HcqProgressionAnalysis;
    onBack: () => void;
}) {
    const meta = image.image_metadata;
    const analysis = image.ai_analysis ?? null;
    const prior = priorInSeries(image, images);
    const comparison = analysis?.comparison_to_prior;
    const change = comparison?.overall_change;
    const response = comparison?.treatment_response;
    const findings = analysis?.findings ?? [];
    const measurements = analysis?.measurements ?? [];
    const alerts = analysis?.summary?.alerts ?? [];

    return (
        <div data-testid="scan-detail" className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                    type="button"
                    onClick={onBack}
                    className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 transition-colors"
                >
                    <ArrowLeft className="w-4 h-4" />
                    Back to timeline
                </button>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border bg-violet-50 text-violet-700 border-violet-200 text-xs font-medium">
                    <Sparkles className="w-3.5 h-3.5" />
                    AI analysis
                </span>
            </div>

            <div className="grid gap-4 lg:grid-cols-2 items-start">
                {/* The scan */}
                <div>
                    <ScanImage image={image} detail className="w-full aspect-[4/3]" />
                    <p className="mt-2 text-sm text-slate-600 flex flex-wrap items-center gap-2">
                        <span className="font-medium text-slate-800">
                            {modalityLabel(meta.modality)} {meta.laterality.toUpperCase()}
                        </span>
                        {formatDate(meta.capture_date)}
                        <TreatmentContextBadge context={image.treatment_context} />
                    </p>
                </div>

                {/* The analysis panel — record-authored, no LLM in this path */}
                <Card className="p-4 space-y-4">
                    {analysis === null && <p className="text-sm text-slate-400">No AI analysis recorded for this scan.</p>}

                    {analysis?.summary?.headline !== undefined && (
                        <div className="flex items-start justify-between gap-2">
                            <p className="text-sm font-semibold text-slate-800">{analysis.summary.headline}</p>
                            {change !== undefined && (
                                <span className={`inline-flex px-2 py-0.5 rounded-md border text-xs font-medium flex-shrink-0 ${CHANGE_BADGES[change]}`}>
                                    {change}
                                </span>
                            )}
                        </div>
                    )}

                    {analysis?.summary?.key_findings !== undefined && analysis.summary.key_findings.length > 0 && (
                        <ul className="space-y-0.5">
                            {analysis.summary.key_findings.map((finding, index) => (
                                <li key={index} className="text-xs text-slate-600 flex items-start gap-1.5">
                                    <span className="text-blue-500 mt-0.5">•</span>
                                    {finding}
                                </li>
                            ))}
                        </ul>
                    )}

                    {alerts.length > 0 && (
                        <ul className="space-y-1.5">
                            {alerts.map((alert, index) => (
                                <li
                                    key={index}
                                    className={`flex items-center gap-2 p-2 rounded-lg border text-xs ${
                                        alert.level === 'high'
                                            ? 'bg-red-50 border-red-200 text-red-800'
                                            : 'bg-amber-50 border-amber-200 text-amber-800'
                                    }`}
                                >
                                    <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                                    {alert.message}
                                </li>
                            ))}
                        </ul>
                    )}

                    {findings.length > 0 && (
                        <section>
                            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
                                Findings ({findings.length})
                            </h4>
                            <ul>
                                {findings.map((finding, index) => (
                                    <FindingRow key={finding.finding_id ?? index} finding={finding} />
                                ))}
                            </ul>
                        </section>
                    )}

                    {measurements.length > 0 && (
                        <section>
                            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
                                Measurements ({measurements.length})
                            </h4>
                            <ul>
                                {measurements.map((measurement, index) => (
                                    <MeasurementRow key={index} measurement={measurement} prior={prior} />
                                ))}
                            </ul>
                        </section>
                    )}

                    {comparison != null && (
                        <div data-testid="comparison-block" className="pt-3 border-t border-slate-100 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                            <span className="font-semibold uppercase tracking-wide text-slate-400">vs prior</span>
                            {comparison.prior_image_date !== undefined && <span>{formatDate(comparison.prior_image_date)}</span>}
                            {comparison.interval_days != null && <span>({comparison.interval_days}d)</span>}
                            {response != null && (
                                <span className={`inline-flex px-2 py-0.5 rounded-md border font-medium ${RESPONSE_BADGES[response.assessment].className}`}>
                                    {RESPONSE_BADGES[response.assessment].label}
                                </span>
                            )}
                            {response?.rationale !== undefined && (
                                <span className="truncate" title={response.rationale}>
                                    {response.rationale}
                                </span>
                            )}
                        </div>
                    )}
                </Card>
            </div>

            {/* Trends ride directly beneath — the series context without leaving the view */}
            <Trends images={images} hcq={hcq} />
        </div>
    );
}
