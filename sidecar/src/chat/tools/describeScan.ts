// describe_scan (IC4): the vision seam — ask the model to LOOK at one stored scan. The
// tool itself stays pure sync over the bundle (validate the id, return the scan's
// metadata + storage_key + an attach_image marker); ChatService owns the async part,
// loading the pixels through an injected loader and appending them to the tool_result as
// an image content block. What the model then sees is an AI VISUAL OBSERVATION, not the
// record: hard rule 6 quarantines it (prefixed, never cited, morphology only), and any
// authored analysis rides along here so conflicts are surfaced against the record's own
// reading. Unknown id or a scan without stored pixels -> structured { error }.
import { z } from 'zod';
import { AiAnalysisSchema } from '../../schemas/index.js';
import type { StoredImageRecord } from '../../store/index.js';
import { defineTool } from './types.js';

const InputSchema = z.object({
    image_id: z.string().min(1),
});
type Input = z.infer<typeof InputSchema>;

const SuccessSchema = z.object({
    image_id: z.string(),
    capture_date: z.string(),
    modality: z.string(),
    laterality: z.string(),
    /** The record's own reading of this scan, for conflict-surfacing (rule 6). */
    authored_headline: z.string().nullable(),
    storage_key: z.string(),
    /** ChatService replaces this marker with an actual image content block on the wire. */
    attach_image: z.literal(true),
    derived: z.literal(true),
});
export const describeScanOutputSchema = z.union([SuccessSchema, z.object({ error: z.string() })]);
type Output = z.infer<typeof describeScanOutputSchema>;

function authoredHeadline(image: StoredImageRecord): string | null {
    const parsed = AiAnalysisSchema.safeParse(image['ai_analysis']);
    if (!parsed.success) {
        return null;
    }
    const headline = parsed.data.summary?.headline;
    return headline !== undefined && headline !== '' ? headline : null;
}

export const describeScan = defineTool<Input, Output>({
    name: 'describe_scan',
    description:
        "LOOK at one of THIS patient's stored scans: the actual image is attached to the result for your own " +
        'visual read. Use when the physician asks what a scan looks like or to describe visible morphology. ' +
        'Your observation is NOT from the record — follow the visual-observation rule: prefix it, never cite ' +
        'it, and surface conflicts with the authored analysis included in the result.',
    inputSchema: InputSchema,
    outputSchema: describeScanOutputSchema,
    inputJsonSchema: {
        type: 'object',
        properties: {
            image_id: { type: 'string', description: 'The image record id to look at.' },
        },
        required: ['image_id'],
        additionalProperties: false,
    },
    run(bundle, input) {
        const image = bundle.images.find((candidate) => candidate.id === input.image_id);
        if (image === undefined) {
            return { error: `no image with id "${input.image_id}" in this patient's record` };
        }
        const storageKey = image['storage_key'];
        if (typeof storageKey !== 'string' || storageKey === '') {
            return { error: `scan "${input.image_id}" has no stored pixels to look at` };
        }
        return {
            image_id: image.id,
            capture_date: image.image_metadata.capture_date,
            modality: image.image_metadata.modality,
            laterality: image.image_metadata.laterality,
            authored_headline: authoredHeadline(image),
            storage_key: storageKey,
            attach_image: true,
            derived: true,
        };
    },
});
