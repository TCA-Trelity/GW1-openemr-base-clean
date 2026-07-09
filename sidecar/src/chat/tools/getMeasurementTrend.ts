// get_measurement_trend (TC1): the time series of one OCT measurement (e.g. CST, GC-IPL)
// per eye, read from the patient's image records' ai_analysis.measurements. Derived: the
// numbers come straight from the stored analyses, not from source prose, so no citation
// provenance. A metric with no recorded data points degrades to a structured { error }.
import { z } from 'zod';
import { AiAnalysisSchema, type ImagingMeasurement, type MeasurementType } from '../../schemas/index.js';
import type { StoredImageRecord } from '../../store/index.js';
import { defineTool } from './types.js';

const InputSchema = z.object({
    metric: z.string().min(1),
    // Accept both fact-level (OD/OS) and imaging-level (od/os) spellings; normalized below.
    laterality: z.enum(['OD', 'OS', 'od', 'os']).optional(),
});
type Input = z.infer<typeof InputSchema>;

const SeriesPointSchema = z.object({
    date: z.string().nullable(),
    laterality: z.string(),
    value: z.number(),
    unit: z.string().nullable(),
    image_id: z.string(),
});

const SuccessSchema = z.object({
    metric: z.string(),
    laterality: z.string().nullable(),
    series: z.array(SeriesPointSchema),
    derived: z.literal(true),
});
export const getMeasurementTrendOutputSchema = z.union([SuccessSchema, z.object({ error: z.string() })]);
type Output = z.infer<typeof getMeasurementTrendOutputSchema>;

// Common physician shorthand -> canonical measurement_type. Anything not listed is matched
// verbatim against the stored measurement_type, so the exact enum also works.
const METRIC_ALIASES: Record<string, MeasurementType> = {
    cst: 'central_subfield_thickness',
    central_subfield_thickness: 'central_subfield_thickness',
    crt: 'central_retinal_thickness',
    cmt: 'central_retinal_thickness',
    central_retinal_thickness: 'central_retinal_thickness',
    gc: 'ganglion_cell_thickness',
    gcl: 'ganglion_cell_thickness',
    gcipl: 'ganglion_cell_thickness',
    gc_ipl: 'ganglion_cell_thickness',
    ganglion_cell: 'ganglion_cell_thickness',
    ganglion_cell_thickness: 'ganglion_cell_thickness',
    rnfl: 'rnfl_thickness',
    rnfl_thickness: 'rnfl_thickness',
    macular_volume: 'macular_volume',
    rpe_elevation: 'rpe_elevation',
    srf_height: 'srf_height',
    irf_volume: 'irf_volume',
};

function normalizeMetric(raw: string): string {
    return raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function measurementsOf(image: StoredImageRecord): ImagingMeasurement[] {
    const parsed = AiAnalysisSchema.safeParse(image['ai_analysis']);
    return parsed.success ? parsed.data.measurements : [];
}

export const getMeasurementTrend = defineTool<Input, Output>({
    name: 'get_measurement_trend',
    description:
        "Return the time series of one OCT measurement (e.g. 'CST', 'GC-IPL', 'RNFL') for THIS patient, " +
        'optionally filtered to one eye (OD/OS). Values come from the stored image analyses.',
    inputSchema: InputSchema,
    outputSchema: getMeasurementTrendOutputSchema,
    inputJsonSchema: {
        type: 'object',
        properties: {
            metric: { type: 'string', description: "Measurement to trend, e.g. 'CST', 'GC-IPL', 'RNFL'." },
            laterality: { type: 'string', enum: ['OD', 'OS'], description: 'Optional eye filter.' },
        },
        required: ['metric'],
        additionalProperties: false,
    },
    run(bundle, input) {
        const resolved: string = METRIC_ALIASES[normalizeMetric(input.metric)] ?? normalizeMetric(input.metric);
        const eyeFilter = input.laterality === undefined ? null : input.laterality.toLowerCase();

        const series = bundle.images
            .flatMap((image) => {
                const eye = image.image_metadata.laterality;
                if (eyeFilter !== null && eye !== eyeFilter) {
                    return [];
                }
                return measurementsOf(image)
                    .filter((measurement) => measurement.measurement_type === resolved)
                    .map((measurement) => ({
                        date: image.image_metadata.capture_date,
                        laterality: eye,
                        value: measurement.value,
                        unit: measurement.unit ?? null,
                        image_id: image.id,
                    }));
            })
            .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

        if (series.length === 0) {
            return {
                error: `no "${input.metric}" measurements found for this patient${
                    eyeFilter === null ? '' : ` (${input.laterality})`
                }`,
            };
        }
        return { metric: resolved, laterality: eyeFilter, series, derived: true };
    },
});
