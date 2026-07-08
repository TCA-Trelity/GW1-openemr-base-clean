// The findings + measurements analysis panel (research brief §2 "AI-findings presentation"):
// a structured pathology list with severity + confidence, a first-class fluid wet/dry chip
// (brief §3 must-have #1), and measurement rows carrying value + reference band + delta vs
// baseline AND delta vs prior (must-haves #2, #5). Everything renders from the record's own
// authored ai_analysis — no LLM, and no confirm/reject on findings (a later verification ticket).
import { AlertTriangle } from 'lucide-react';
import type { ImageRecord, ImagingMeasurement, ImagingScanFinding } from '../types';
import { formatDate, titleCase } from '../ui';
import { CHANGE_BADGES, RESPONSE_BADGES } from './badges';
import { DeltaBadge } from './delta';
import { deriveFluidStatus, FluidChip } from './fluid';
import { baselineInSeries, measurementDeltaBetween, priorInSeries } from './series';
import { metricPolarity } from './summary';

const FINDING_SEVERITY: Record<'mild' | 'moderate' | 'severe', string> = {
    severe: 'bg-red-50 text-red-700 border-red-200',
    moderate: 'bg-amber-50 text-amber-700 border-amber-200',
    mild: 'bg-slate-50 text-slate-600 border-slate-200',
};

export function FindingRow({ finding }: { finding: ImagingScanFinding }) {
    const detail = [finding.description, finding.location].filter((part) => part !== undefined && part !== '').join(' · ');
    return (
        <li
            data-testid="finding-row"
            className="flex items-center gap-2 py-1.5 border-b border-slate-100 last:border-0 min-w-0"
        >
            <span className="text-sm font-medium text-slate-700 flex-shrink-0">{titleCase(finding.finding_type)}</span>
            {finding.severity !== undefined && (
                <span
                    className={`inline-flex px-1.5 py-0.5 rounded-md border text-[11px] font-medium flex-shrink-0 ${FINDING_SEVERITY[finding.severity]}`}
                >
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

/**
 * One scalar measurement: value + unit, in-range coloring against its reference band, and two
 * deltas — vs the prior scan and vs the series baseline — each colored by the metric's polarity.
 */
export function MeasurementRow({
    measurement,
    image,
    prior,
    baseline,
}: {
    measurement: ImagingMeasurement;
    image: ImageRecord;
    prior: ImageRecord | null;
    baseline: ImageRecord | null;
}) {
    const range = measurement.reference_range;
    const inRange =
        range !== undefined ? measurement.value >= range.normal_min && measurement.value <= range.normal_max : null;
    const polarity = metricPolarity(measurement.measurement_type);
    const priorDelta = measurementDeltaBetween(measurement.measurement_type, image, prior);
    const baselineDelta = measurementDeltaBetween(measurement.measurement_type, image, baseline);
    return (
        <li
            data-testid="measurement-row"
            className="flex items-center gap-2 py-1.5 border-b border-slate-100 last:border-0 min-w-0 flex-wrap"
        >
            <span className="text-sm text-slate-600 truncate">{titleCase(measurement.measurement_type)}</span>
            <span className="ml-auto flex items-baseline gap-1 flex-shrink-0">
                <span className={`text-sm font-semibold ${inRange === false ? 'text-amber-700' : 'text-slate-800'}`}>
                    {measurement.value}
                </span>
                {measurement.unit !== undefined && <span className="text-xs text-slate-400">{measurement.unit}</span>}
            </span>
            {range !== undefined && (
                <span className="text-[11px] text-slate-400 flex-shrink-0">
                    normal {range.normal_min}–{range.normal_max}
                </span>
            )}
            <span className="flex items-center gap-1 flex-shrink-0 basis-full justify-end sm:basis-auto">
                {priorDelta !== null && (
                    <DeltaBadge delta={priorDelta} polarity={polarity} caption="vs prior" testId="measurement-delta" />
                )}
                {baselineDelta !== null && (
                    <DeltaBadge
                        delta={baselineDelta}
                        polarity={polarity}
                        caption="vs base"
                        testId="measurement-baseline-delta"
                    />
                )}
            </span>
        </li>
    );
}

/**
 * The full right-margin analysis panel for a selected scan.
 * `images` is the whole record set — prior + baseline in the same series resolve from it.
 */
export default function AnalysisPanel({ image, images }: { image: ImageRecord; images: ImageRecord[] }) {
    const analysis = image.ai_analysis ?? null;
    const prior = priorInSeries(image, images);
    const baseline = baselineInSeries(image, images);
    const comparison = analysis?.comparison_to_prior;
    const change = comparison?.overall_change;
    const response = comparison?.treatment_response;
    const findings = analysis?.findings ?? [];
    const measurements = analysis?.measurements ?? [];
    const alerts = analysis?.summary?.alerts ?? [];
    const fluid = deriveFluidStatus(analysis);

    return (
        <div data-testid="analysis-panel" className="space-y-4">
            {analysis === null && <p className="text-sm text-slate-400">No AI analysis recorded for this scan.</p>}

            {/* Headline + fluid chip + overall-change badge — the top-line read for the scan. */}
            <div className="flex items-start justify-between gap-2 flex-wrap">
                <div className="min-w-0 space-y-1.5">
                    {analysis?.summary?.headline !== undefined && (
                        <p className="text-sm font-semibold text-slate-800">{analysis.summary.headline}</p>
                    )}
                    {fluid.state !== 'unknown' && <FluidChip status={fluid} />}
                </div>
                {change !== undefined && (
                    <span
                        className={`inline-flex px-2 py-0.5 rounded-md border text-xs font-medium flex-shrink-0 ${CHANGE_BADGES[change]}`}
                    >
                        {change}
                    </span>
                )}
            </div>

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
                            <MeasurementRow
                                key={index}
                                measurement={measurement}
                                image={image}
                                prior={prior}
                                baseline={baseline}
                            />
                        ))}
                    </ul>
                </section>
            )}

            {comparison != null && (
                <div
                    data-testid="comparison-block"
                    className="pt-3 border-t border-slate-100 flex flex-wrap items-center gap-2 text-xs text-slate-500"
                >
                    <span className="font-semibold uppercase tracking-wide text-slate-400">vs prior</span>
                    {comparison.prior_image_date !== undefined && <span>{formatDate(comparison.prior_image_date)}</span>}
                    {comparison.interval_days != null && <span>({comparison.interval_days}d)</span>}
                    {response != null && (
                        <span
                            className={`inline-flex px-2 py-0.5 rounded-md border font-medium ${RESPONSE_BADGES[response.assessment].className}`}
                        >
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
        </div>
    );
}
