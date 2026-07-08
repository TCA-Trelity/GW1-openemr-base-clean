// The preparation pipeline (S1.7): startPrepRun -> load sources -> LLM extraction ->
// citation gate (blocked facts rewritten as absence) -> med-risk arithmetic -> imaging
// analytics -> brief assembly -> saveBrief -> finishPrepRun. Every stage logs with the
// correlation ID and duration. In-process async at Tier 1 — the BullMQ queue is S1.9 scope.
import {
    analyzeHCQProgression,
    analyzeIntervalPatterns,
    calculateMedicationDurationYears,
    computeMedicationRiskFlags,
    computeTreatmentContext,
    type MedicationInput,
} from '../engines/index.js';
import { runCitationGate, type Claim } from '../gate/citationGate.js';
import { DEFAULT_PROVIDER_PROFILE, type PatientFact, type ProviderProfile } from '../schemas/index.js';
import type { BriefInput, PrepRunStatus, StoredBrief } from '../store/index.js';
import { assembleBrief, type BriefContent } from './brief.js';
import type { FactExtractor, PrepLogger } from './extraction.js';
import type { DocumentSource } from './sources.js';

/** The FactStore surface the pipeline writes through (FactStore satisfies it; tests fake it). */
export interface PrepStore {
    startPrepRun(patientId: string, correlationId: string): Promise<string>;
    finishPrepRun(runId: string, status: PrepRunStatus, error?: string): Promise<void>;
    saveBrief(brief: BriefInput): Promise<StoredBrief>;
}

export interface PrepDeps {
    store: PrepStore;
    source: DocumentSource;
    extractor: FactExtractor;
    logger: PrepLogger;
    /** Injected clock (PSR-20 spirit): medication-duration arithmetic and prepared_at. */
    clock?: () => Date;
    providerProfile?: ProviderProfile;
}

export interface PrepRunContext {
    prepRunId: string;
    patientId: string;
    correlationId: string;
}

export interface PrepRunResult {
    prepRunId: string;
    brief: StoredBrief;
    content: BriefContent;
}

/** Convenience wrapper: open the prep_run row, then execute. */
export async function runPrep(deps: PrepDeps, patientId: string, correlationId: string): Promise<PrepRunResult> {
    const prepRunId = await deps.store.startPrepRun(patientId, correlationId);
    return executePrep(deps, { prepRunId, patientId, correlationId });
}

/**
 * Everything after startPrepRun. Failures are recorded on the prep_run row and rethrown —
 * a fire-and-forget caller logs them; an awaiting caller (tests, future queue worker) sees them.
 */
export async function executePrep(deps: PrepDeps, ctx: PrepRunContext): Promise<PrepRunResult> {
    const { logger } = deps;
    const { prepRunId, patientId, correlationId } = ctx;
    const now = (deps.clock ?? (() => new Date()))();
    const profile = deps.providerProfile ?? DEFAULT_PROVIDER_PROFILE;
    try {
        const sources = await stage(logger, correlationId, 'load_sources', () =>
            deps.source.load(patientId, correlationId),
        );

        const extraction = await stage(logger, correlationId, 'llm_extraction', () =>
            deps.extractor.extract(
                { patientId, patientName: sources.patient.name, documents: sources.documents },
                correlationId,
                logger,
            ),
        );

        // Citation gate over every extracted fact: blocked facts are dropped from the
        // brief (the rewrite-as-absence) and logged alongside the gate metrics.
        const { verifiedFacts, metrics } = await stage(logger, correlationId, 'citation_gate', () => {
            const textById = new Map(sources.documents.map((doc) => [doc.id, doc.text]));
            const claims: Claim[] = extraction.facts.map((fact) => ({ id: fact.id, citations: fact.sources }));
            const gate = runCitationGate(claims, (id) => textById.get(id));
            const verdictById = new Map(gate.verdicts.map((verdict) => [verdict.id, verdict]));
            const verified = extraction.facts.filter((fact) => verdictById.get(fact.id)?.status === 'verified');
            const blocked = gate.verdicts.filter((verdict) => verdict.status === 'blocked');
            logger.info(
                {
                    correlationId,
                    metrics: gate.metrics,
                    blockedFacts: blocked.map((verdict) => ({ id: verdict.id, reason: verdict.reason })),
                },
                'citation gate verdicts',
            );
            return { verifiedFacts: verified, metrics: gate.metrics };
        });

        const medicationRiskFlags = await stage(logger, correlationId, 'medication_risk', () =>
            computeMedicationRiskFlags(medicationEngineInputs(verifiedFacts, now), profile),
        );

        const imaging = await stage(logger, correlationId, 'imaging_analytics', () => ({
            timeline_summary: [...sources.images]
                .sort(
                    (a, b) =>
                        new Date(a.image_metadata.capture_date).getTime() -
                        new Date(b.image_metadata.capture_date).getTime(),
                )
                .map((image) => ({
                    image_id: image.id,
                    capture_date: image.image_metadata.capture_date,
                    modality: image.image_metadata.modality,
                    laterality: image.image_metadata.laterality,
                    treatment_context: computeTreatmentContext(image.image_metadata.capture_date, sources.treatments),
                })),
            interval_analysis: analyzeIntervalPatterns(sources.images, sources.treatments),
            hcq_progression: analyzeHCQProgression(sources.images),
        }));

        const content = await stage(logger, correlationId, 'brief_assembly', () =>
            assembleBrief({
                verifiedFacts,
                contradictions: extraction.contradictions,
                medicationRiskFlags,
                imaging,
                gateMetrics: metrics,
                preparedAt: now.toISOString(),
                correlationId,
            }),
        );

        const brief = await stage(logger, correlationId, 'save_brief', () =>
            deps.store.saveBrief({
                patient_id: patientId,
                correlation_id: correlationId,
                content,
                status: 'complete',
            }),
        );

        await deps.store.finishPrepRun(prepRunId, 'complete');
        logger.info({ correlationId, prepRunId, patientId, briefId: brief.id }, 'prep run complete');
        return { prepRunId, brief, content };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ correlationId, prepRunId, patientId, err: message }, 'prep run failed');
        await deps.store
            .finishPrepRun(prepRunId, 'failed', message)
            .catch((finishError: unknown) =>
                logger.error(
                    { correlationId, prepRunId, err: String(finishError) },
                    'failed to record prep run failure',
                ),
            );
        throw error;
    }
}

// Bridge fact contents to the engine's prototype-faithful input: MedicationContentSchema
// carries start_date, not the duration string the engine parses — derive it via the
// clock-injected duration calculation (floor'd to whole years, matching the prototype).
function medicationEngineInputs(facts: PatientFact[], now: Date): MedicationInput[] {
    return facts
        .filter((fact): fact is Extract<PatientFact, { fact_type: 'medication' }> => fact.fact_type === 'medication')
        .map((fact) => {
            const years = calculateMedicationDurationYears(
                { start_date: fact.content.start_date ?? undefined },
                now,
            );
            const input: MedicationInput = { content: fact.content };
            if (years !== null && years >= 0) {
                input.duration = `${Math.floor(years)} years`;
            }
            return input;
        });
}

async function stage<T>(
    logger: PrepLogger,
    correlationId: string,
    name: string,
    fn: () => T | Promise<T>,
): Promise<T> {
    const startedAt = Date.now();
    const result = await fn();
    logger.info({ correlationId, stage: name, durationMs: Date.now() - startedAt }, 'prep stage complete');
    return result;
}
