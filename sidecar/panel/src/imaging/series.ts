// Series math shared across the imaging workspace: a "series" is the set of scans in the
// same modality + laterality (OD/OS discipline — never mix eyes), ordered by capture date.
// Baseline = first in series; prior = immediately preceding. All pure display math over the
// authored records — no clinical judgment lives here.
import type { ImageRecord } from '../types';

/** Records in the same modality+laterality series as `image`, ascending by capture date. */
export function seriesFor(image: ImageRecord, images: ImageRecord[]): ImageRecord[] {
    return images
        .filter(
            (candidate) =>
                candidate.image_metadata.modality === image.image_metadata.modality &&
                candidate.image_metadata.laterality.toUpperCase() === image.image_metadata.laterality.toUpperCase(),
        )
        .sort(
            (a, b) =>
                new Date(a.image_metadata.capture_date).getTime() - new Date(b.image_metadata.capture_date).getTime(),
        );
}

/** The prior image in the same series, by capture date — null when `image` is the baseline. */
export function priorInSeries(image: ImageRecord, images: ImageRecord[]): ImageRecord | null {
    const series = seriesFor(image, images);
    const index = series.findIndex((candidate) => candidate.id === image.id);
    return index > 0 ? (series[index - 1] ?? null) : null;
}

/** The first (baseline) image in the series — null when `image` itself is the baseline. */
export function baselineInSeries(image: ImageRecord, images: ImageRecord[]): ImageRecord | null {
    const series = seriesFor(image, images);
    const baseline = series[0] ?? null;
    return baseline === null || baseline.id === image.id ? null : baseline;
}

/**
 * Value delta of one measurement_type on `image` vs the same type on `other`.
 * null when either record lacks that measurement — never zero-fill a missing metric.
 */
export function measurementDeltaBetween(
    measurementType: string,
    image: ImageRecord,
    other: ImageRecord | null,
): number | null {
    const current = image.ai_analysis?.measurements?.find((m) => m.measurement_type === measurementType);
    const previous = other?.ai_analysis?.measurements?.find((m) => m.measurement_type === measurementType);
    return current === undefined || previous === undefined ? null : current.value - previous.value;
}
