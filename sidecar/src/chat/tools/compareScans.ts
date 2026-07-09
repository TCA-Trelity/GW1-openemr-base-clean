// compare_scans (TC1): run the deterministic computeComparison engine over two of the
// patient's image records. The later capture is treated as current, the earlier as prior, so
// the diff reads chronologically. Derived: the result is computed by the engine, never
// fabricated, so it carries no source-text provenance. Unknown image id -> { error }.
import { z } from 'zod';
import {
    AiAnalysisSchema,
    ComparisonToPriorSchema,
    TreatmentRecordSchema,
    type ImagingFinding,
    type ImagingMeasurement,
    type TreatmentRecord,
} from '../../schemas/index.js';
import { computeComparison, computeTreatmentContext } from '../../engines/index.js';
import type { FactBundle, StoredImageRecord } from '../../store/index.js';
import { defineTool } from './types.js';

const InputSchema = z.object({
    image_id_a: z.string().min(1),
    image_id_b: z.string().min(1),
});
type Input = z.infer<typeof InputSchema>;

const SuccessSchema = z.object({
    current_image_id: z.string(),
    prior_image_id: z.string(),
    comparison: ComparisonToPriorSchema,
    derived: z.literal(true),
});
export const compareScansOutputSchema = z.union([SuccessSchema, z.object({ error: z.string() })]);
type Output = z.infer<typeof compareScansOutputSchema>;

interface AnalysisParts {
    findings: ImagingFinding[];
    measurements: ImagingMeasurement[];
}

function analysisOf(image: StoredImageRecord): AnalysisParts {
    const parsed = AiAnalysisSchema.safeParse(image['ai_analysis']);
    if (!parsed.success) {
        return { findings: [], measurements: [] };
    }
    return { findings: parsed.data.findings, measurements: parsed.data.measurements };
}

function treatmentsOf(bundle: FactBundle): TreatmentRecord[] {
    return bundle.treatments.flatMap((treatment) => {
        const parsed = TreatmentRecordSchema.safeParse(treatment.payload);
        return parsed.success ? [parsed.data] : [];
    });
}

export const compareScans = defineTool<Input, Output>({
    name: 'compare_scans',
    description:
        "Compare two of THIS patient's OCT/imaging scans by id and return the deterministic diff " +
        '(resolved/new findings, CRT delta, overall change, treatment response). The later scan is treated as current.',
    inputSchema: InputSchema,
    outputSchema: compareScansOutputSchema,
    inputJsonSchema: {
        type: 'object',
        properties: {
            image_id_a: { type: 'string', description: 'One image record id.' },
            image_id_b: { type: 'string', description: 'The other image record id.' },
        },
        required: ['image_id_a', 'image_id_b'],
        additionalProperties: false,
    },
    run(bundle, input) {
        const imageA = bundle.images.find((image) => image.id === input.image_id_a);
        const imageB = bundle.images.find((image) => image.id === input.image_id_b);
        if (imageA === undefined) {
            return { error: `no image with id "${input.image_id_a}" in this patient's record` };
        }
        if (imageB === undefined) {
            return { error: `no image with id "${input.image_id_b}" in this patient's record` };
        }

        // Order chronologically: later capture is current, earlier is prior.
        const timeA = new Date(imageA.image_metadata.capture_date).getTime();
        const timeB = new Date(imageB.image_metadata.capture_date).getTime();
        const [current, prior] = timeA >= timeB ? [imageA, imageB] : [imageB, imageA];

        const currentParts = analysisOf(current);
        const priorParts = analysisOf(prior);
        const treatmentContext = computeTreatmentContext(current.image_metadata.capture_date, treatmentsOf(bundle));

        const comparison = computeComparison(currentParts.findings, currentParts.measurements, {
            image_id: prior.id,
            capture_date: prior.image_metadata.capture_date,
            findings: priorParts.findings,
            measurements: priorParts.measurements,
        }, treatmentContext);

        return {
            current_image_id: current.id,
            prior_image_id: prior.id,
            comparison,
            derived: true,
        };
    },
});

// (committed member of the chat tool registry — re-sync marker for the build context)
