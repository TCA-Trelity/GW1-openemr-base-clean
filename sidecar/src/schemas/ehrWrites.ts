// Outbound EHR write contracts (H.11, REQ G1): the native OpenEMR vitals payload — the
// Week 2 write that carries clinical measurements into the chart (A.6 round-trip). The
// runtime type in src/openemr/standardApi.ts is inferred from here (z.infer), and the
// parse sits at the outbound boundary (StandardApiClient.addVital) BEFORE any network
// call: a malformed value or an invented key fails closed sidecar-side, kind
// 'validation', and never reaches OpenEMR.
import { z } from 'zod';

/** Native OpenEMR vitals write (EncounterService::validateVital — every field optional).
 *  Weight/height are US units (lbs / inches) — what the stock vitals form stores and
 *  displays. `.strict()`: an invented key must fail closed before it reaches OpenEMR. */
export const EhrVitalPayloadSchema = z
    .object({
        bps: z.number().int().positive().optional(),
        bpd: z.number().int().positive().optional(),
        pulse: z.number().int().positive().optional(),
        respiration: z.number().int().positive().optional(),
        temperature: z.number().positive().optional(),
        oxygen_saturation: z.number().positive().optional(),
        weight: z.number().positive().optional(),
        height: z.number().positive().optional(),
        note: z.string().optional(),
    })
    .strict();
