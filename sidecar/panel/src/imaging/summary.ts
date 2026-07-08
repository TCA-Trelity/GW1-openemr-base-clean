// Visit-summary computation (research brief §3 must-have #4): the baseline→latest one-glance
// numbers rendered as the strip across the top of the Imaging tab. Pure display math over the
// authored records + the server-computed interval/HCQ blocks — no clinical judgment invented
// here, and metrics absent for a patient are omitted, never zero-filled (brief §3).
import type {
    HcqProgressionAnalysis,
    ImageRecord,
    IntervalPatternAnalysis,
    TreatmentResponseAssessment,
} from '../types';
import { deriveFluidStatus, type FluidStatus } from './fluid';

/**
 * Whether a rise in a metric is clearly good or bad, so a delta can carry a judgment color
 * (research brief §1): CST rise = recurrence signal (higher worse); GC-IPL / RNFL thinning =
 * toxicity (lower worse). Anything without a clear direction stays neutral — direction only.
 */
export type MetricPolarity = 'higher_worse' | 'lower_worse' | 'neutral';

const METRIC_POLARITY: Record<string, MetricPolarity> = {
    central_retinal_thickness: 'higher_worse',
    ganglion_cell_thickness: 'lower_worse',
    rnfl_thickness: 'lower_worse',
};

export function metricPolarity(measurementType: string): MetricPolarity {
    return METRIC_POLARITY[measurementType] ?? 'neutral';
}

const METRIC_LABELS: Record<string, string> = {
    central_retinal_thickness: 'Central Thickness',
    ganglion_cell_thickness: 'Ganglion Cell (GC-IPL)',
    rnfl_thickness: 'RNFL',
};

export function metricLabel(measurementType: string): string {
    return METRIC_LABELS[measurementType] ?? measurementType;
}

export interface MetricSummary {
    measurementType: string;
    label: string;
    unit: string | undefined;
    baselineValue: number;
    latestValue: number;
    /** latest − baseline; null when the series has only one scan (no baseline to diff against). */
    delta: number | null;
    polarity: MetricPolarity;
    referenceRange: { normal_min: number; normal_max: number } | undefined;
    /** latest value within its reference band; null when the metric has no band. */
    latestInRange: boolean | null;
}

interface DatedValue {
    date: string;
    value: number;
    unit?: string;
    referenceRange?: { normal_min: number; normal_max: number };
}

/** Ordered (date-ascending) values of one measurement_type across the record set. */
function measurementSeries(images: ImageRecord[], measurementType: string): DatedValue[] {
    return images
        .flatMap((image) => {
            const measurement = image.ai_analysis?.measurements?.find((m) => m.measurement_type === measurementType);
            if (measurement === undefined) {
                return [];
            }
            return [
                {
                    date: image.image_metadata.capture_date,
                    value: measurement.value,
                    unit: measurement.unit,
                    referenceRange: measurement.reference_range,
                },
            ];
        })
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

/** Baseline→latest summary of one metric, or null when the metric is absent for this patient. */
export function computeMetricSummary(images: ImageRecord[], measurementType: string): MetricSummary | null {
    const series = measurementSeries(images, measurementType);
    const baseline = series[0];
    const latest = series[series.length - 1];
    if (baseline === undefined || latest === undefined) {
        return null;
    }
    const referenceRange = latest.referenceRange;
    return {
        measurementType,
        label: metricLabel(measurementType),
        unit: latest.unit,
        baselineValue: baseline.value,
        latestValue: latest.value,
        delta: series.length > 1 ? latest.value - baseline.value : null,
        polarity: metricPolarity(measurementType),
        referenceRange,
        latestInRange:
            referenceRange === undefined
                ? null
                : latest.value >= referenceRange.normal_min && latest.value <= referenceRange.normal_max,
    };
}

export type AlertLevel = 'low' | 'medium' | 'high';
const ALERT_RANK: Record<AlertLevel, number> = { low: 0, medium: 1, high: 2 };

function maxAlert(a: AlertLevel, b: AlertLevel): AlertLevel {
    return ALERT_RANK[a] >= ALERT_RANK[b] ? a : b;
}

export interface VisitSummary {
    /** CST, GC-IPL, … in a stable order — only those the patient actually has. */
    metrics: MetricSummary[];
    /** Fluid state of the most recent scan (null when there are no scans). */
    fluid: FluidStatus | null;
    latestScanDate: string | null;
    /** Latest treat-and-extend interval + its outcome — null for non-injection patients. */
    interval: { weeks: number; outcome: TreatmentResponseAssessment } | null;
    alertLevel: AlertLevel;
    alertSource: string | null;
}

const SUMMARY_METRIC_ORDER = ['central_retinal_thickness', 'ganglion_cell_thickness', 'rnfl_thickness'];

/** Newest scan by capture date. */
function latestScan(images: ImageRecord[]): ImageRecord | null {
    return (
        [...images].sort(
            (a, b) =>
                new Date(b.image_metadata.capture_date).getTime() - new Date(a.image_metadata.capture_date).getTime(),
        )[0] ?? null
    );
}

export function computeVisitSummary(
    images: ImageRecord[],
    intervalAnalysis: IntervalPatternAnalysis,
    hcq: HcqProgressionAnalysis,
): VisitSummary {
    const metrics = SUMMARY_METRIC_ORDER.flatMap((type) => {
        const summary = computeMetricSummary(images, type);
        return summary === null ? [] : [summary];
    });

    const latest = latestScan(images);
    const fluid = latest === null ? null : deriveFluidStatus(latest.ai_analysis);

    const lastInterval = intervalAnalysis.intervals[intervalAnalysis.intervals.length - 1];
    const interval =
        lastInterval === undefined ? null : { weeks: lastInterval.interval_weeks, outcome: lastInterval.outcome };

    // Overall alert = the worst of: standing HCQ progression, the latest scan's own alerts, and a
    // latest-scan "worsened" read. Honest to what the record says — no synthetic escalation.
    let alertLevel: AlertLevel = 'low';
    let alertSource: string | null = null;
    if (hcq.progression_detected) {
        alertLevel = maxAlert(alertLevel, hcq.alert_level);
        alertSource = 'HCQ monitoring';
    }
    for (const alert of latest?.ai_analysis?.summary?.alerts ?? []) {
        if (ALERT_RANK[alert.level] > ALERT_RANK[alertLevel]) {
            alertLevel = alert.level;
            alertSource = 'Latest scan';
        }
    }
    if (latest?.ai_analysis?.comparison_to_prior?.overall_change === 'worsened' && alertLevel === 'low') {
        alertLevel = 'medium';
        alertSource = 'Latest scan';
    }

    return {
        metrics,
        fluid,
        latestScanDate: latest?.image_metadata.capture_date ?? null,
        interval,
        alertLevel,
        alertSource,
    };
}
