// get_imaging_overview (IC1): the one-call answer to "what trends are you seeing?" — the
// SAME derived imaging block buildOverview feeds the panel's analytics rail (timeline with
// treatment context, interval analysis, HCQ progression), so chat and rail quote one source
// of truth. Derived: engine output over stored analyses, never fabricated — no source-text
// provenance. Pure over the bundle (all date arithmetic uses stored dates; no clock).
// Zero scans is DATA (absence rendered as absence), not an error.
import { z } from 'zod';
import { analyzeHCQProgression, analyzeIntervalPatterns, computeTreatmentContext } from '../../engines/index.js';
import {
    HcqProgressionAnalysisSchema,
    ImagingTimelineEntrySchema,
    IntervalPatternAnalysisSchema,
} from '../../prep/brief.js';
import { TreatmentRecordSchema, type TreatmentRecord } from '../../schemas/index.js';
import type { FactBundle } from '../../store/index.js';
import { defineTool } from './types.js';

const InputSchema = z.object({}).strict();
type Input = z.infer<typeof InputSchema>;

const SuccessSchema = z.object({
    scan_count: z.number().int(),
    first_capture_date: z.string().nullable(),
    latest_capture_date: z.string().nullable(),
    timeline: z.array(ImagingTimelineEntrySchema),
    interval_analysis: IntervalPatternAnalysisSchema,
    hcq_progression: HcqProgressionAnalysisSchema,
    derived: z.literal(true),
});
export const getImagingOverviewOutputSchema = z.union([SuccessSchema, z.object({ error: z.string() })]);
type Output = z.infer<typeof getImagingOverviewOutputSchema>;

/** buildOverview parses treatment payloads strictly; a tool never throws, so skip bad rows. */
function treatmentsOf(bundle: FactBundle): TreatmentRecord[] {
    return bundle.treatments.flatMap((treatment) => {
        const parsed = TreatmentRecordSchema.safeParse(treatment.payload);
        return parsed.success ? [parsed.data] : [];
    });
}

export const getImagingOverview = defineTool<Input, Output>({
    name: 'get_imaging_overview',
    description:
        "THIS patient's whole imaging story in one call: every scan with its treatment context, the " +
        'treat-and-extend interval analysis, and HCQ progression — the same derived analytics the panel shows. ' +
        "Prefer this for any 'trends' / 'progression' / 'how are the scans looking' question; it reads the " +
        'stored image analyses, which documents do not carry.',
    inputSchema: InputSchema,
    outputSchema: getImagingOverviewOutputSchema,
    inputJsonSchema: { type: 'object', properties: {}, additionalProperties: false },
    run(bundle) {
        const treatments = treatmentsOf(bundle);
        const imagesByDate = [...bundle.images].sort(
            (a, b) => new Date(a.image_metadata.capture_date).getTime() - new Date(b.image_metadata.capture_date).getTime(),
        );
        return {
            scan_count: imagesByDate.length,
            first_capture_date: imagesByDate[0]?.image_metadata.capture_date ?? null,
            latest_capture_date: imagesByDate.at(-1)?.image_metadata.capture_date ?? null,
            // Identical derivations to buildOverview's `imaging` block (the analytics rail).
            timeline: imagesByDate.map((image) => ({
                image_id: image.id,
                capture_date: image.image_metadata.capture_date,
                modality: image.image_metadata.modality,
                laterality: image.image_metadata.laterality,
                treatment_context: computeTreatmentContext(image.image_metadata.capture_date, treatments),
            })),
            interval_analysis: analyzeIntervalPatterns(bundle.images, treatments),
            hcq_progression: analyzeHCQProgression(bundle.images),
            derived: true,
        };
    },
});
