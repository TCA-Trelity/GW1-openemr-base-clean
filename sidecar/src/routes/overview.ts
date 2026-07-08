// Deterministic overview API (realignment 2026-07-08): the panel's landing page reads
// ONLY stored EHR facts + pure engines — no LLM anywhere in the load path, so the page
// renders in one store round-trip. GET /api/patients backs the day-schedule sidebar;
// GET /api/overview/:patientId backs everything above the fold.
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
    analyzeHCQProgression,
    analyzeIntervalPatterns,
    calculateMedicationDurationYears,
    computeMedicationRiskFlags,
    computeTreatmentContext,
    type MedicationInput,
} from '../engines/index.js';
import { DEFAULT_PROVIDER_PROFILE, MedicationContentSchema, TreatmentRecordSchema, type ProviderProfile } from '../schemas/index.js';
import type { FactBundle, StoredBrief, StoredFact, StoredPatient } from '../store/index.js';

/** The FactStore surface these routes need (FactStore satisfies it; tests fake it). */
export interface OverviewRouteStore {
    listPatients(): Promise<StoredPatient[]>;
    getFactBundle(patientId: string): Promise<FactBundle | null>;
    getBrief(patientId: string): Promise<StoredBrief | null>;
}

export interface OverviewRouteDeps {
    store: OverviewRouteStore;
    clock?: () => Date;
    providerProfile?: ProviderProfile;
}

/** Pure builder — everything below derives deterministically from the stored bundle. */
export function buildOverview(
    bundle: FactBundle,
    latestBrief: StoredBrief | null,
    now: Date,
    profile: ProviderProfile = DEFAULT_PROVIDER_PROFILE,
): Record<string, unknown> {
    const factsByType: Record<string, StoredFact[]> = {};
    for (const fact of bundle.facts) {
        (factsByType[fact.fact_type] ??= []).push(fact);
    }

    // Same duration bridge the prep pipeline uses: MedicationContent carries start_date,
    // the engine wants a "N years" duration string.
    const medicationInputs: MedicationInput[] = (factsByType['medication'] ?? []).flatMap((fact) => {
        const content = MedicationContentSchema.safeParse(fact.content);
        if (!content.success) {
            return [];
        }
        const years = calculateMedicationDurationYears({ start_date: content.data.start_date ?? undefined }, now);
        const input: MedicationInput = { content: content.data };
        if (years !== null && years >= 0) {
            input.duration = `${Math.floor(years)} years`;
        }
        return [input];
    });

    const imagesByDate = [...bundle.images].sort(
        (a, b) => new Date(a.image_metadata.capture_date).getTime() - new Date(b.image_metadata.capture_date).getTime(),
    );
    // Same payload -> engine-shape parse the prep document source performs.
    const treatments = bundle.treatments.map((treatment) => TreatmentRecordSchema.parse(treatment.payload));

    const riskFlags = computeMedicationRiskFlags(medicationInputs, profile);
    const intervalAnalysis = analyzeIntervalPatterns(bundle.images, treatments);
    const hcqProgression = analyzeHCQProgression(bundle.images);
    const injections = treatments
        .filter((treatment) => treatment.injection_details !== null)
        .sort((a, b) => new Date(a.treatment_date).getTime() - new Date(b.treatment_date).getTime());
    const lastInjection = injections.at(-1);

    return {
        patient: bundle.patient,
        facts_by_type: factsByType,
        medication_risk_flags: riskFlags,
        // Deterministic Diagnosis & Care (R3): populated on first load, no LLM anywhere.
        care_plan: {
            active_condition_fact_ids: (factsByType['condition'] ?? []).map((fact) => fact.id),
            protocol:
                lastInjection === undefined
                    ? null
                    : {
                          last_treatment_date: lastInjection.treatment_date,
                          medication: lastInjection.injection_details?.medication ?? null,
                          treatment_count: injections.length,
                      },
            monitoring: [
                ...riskFlags.map((flag) => ({
                    text: flag.recommendation,
                    severity: flag.severity,
                    source: flag.source,
                })),
                ...(hcqProgression.progression_detected
                    ? [{ text: hcqProgression.recommendation, severity: hcqProgression.alert_level, source: 'imaging trend analysis' }]
                    : []),
            ],
            follow_up: {
                recommendation: intervalAnalysis.recommendation === '' ? null : intervalAnalysis.recommendation,
                optimal_interval_weeks: intervalAnalysis.optimal_interval,
                confidence: intervalAnalysis.confidence,
            },
        },
        contradictions: bundle.contradictions,
        // Metadata only — the doc viewer loads full text via /api/facts.
        documents: bundle.documents.map((doc) => ({
            id: doc.id,
            document_type: doc.document_type,
            document_date: doc.document_date,
            metadata: doc.metadata,
            extras: doc.extras,
        })),
        images: imagesByDate,
        imaging: {
            timeline_summary: imagesByDate.map((image) => ({
                image_id: image.id,
                capture_date: image.image_metadata.capture_date,
                modality: image.image_metadata.modality,
                laterality: image.image_metadata.laterality,
                treatment_context: computeTreatmentContext(image.image_metadata.capture_date, treatments),
            })),
            interval_analysis: intervalAnalysis,
            hcq_progression: hcqProgression,
        },
        latest_brief:
            latestBrief === null
                ? null
                : { id: latestBrief.id, prepared_at: latestBrief.prepared_at, correlation_id: latestBrief.correlation_id },
        generated_at: now.toISOString(),
    };
}

function storeNotConfigured(reply: FastifyReply): FastifyReply {
    return reply.status(503).send({ error: 'store_not_configured' });
}

export function registerOverviewRoutes(app: FastifyInstance, deps: OverviewRouteDeps | undefined): void {
    app.get('/api/patients', async (_request, reply) => {
        if (deps === undefined) {
            return storeNotConfigured(reply);
        }
        return reply.send({ patients: await deps.store.listPatients() });
    });

    app.get<{ Params: { patientId: string } }>('/api/overview/:patientId', async (request, reply) => {
        if (deps === undefined) {
            return storeNotConfigured(reply);
        }
        const bundle = await deps.store.getFactBundle(request.params.patientId);
        if (bundle === null) {
            return reply.status(404).send({ error: 'patient_not_found' });
        }
        const latestBrief = await deps.store.getBrief(request.params.patientId);
        const now = (deps.clock ?? (() => new Date()))();
        return reply.send(buildOverview(bundle, latestBrief, now, deps.providerProfile));
    });
}
