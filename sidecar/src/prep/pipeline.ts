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
import type { PrepTracer, PrepTraceHandle } from '../obs/langfuse.js';
import { DEFAULT_PROVIDER_PROFILE, type PatientFact, type ProviderProfile } from '../schemas/index.js';
import type { BriefInput, PrepRunStatus, StoredBrief } from '../store/index.js';
import { assembleBrief, type BriefContent } from './brief.js';
import type { LlmCallRecord } from './budget.js';
import type { FactExtractor, PrepLogger } from './extraction.js';
import type { DocumentSource } from './sources.js';

/** The FactStore surface the pipeline writes through (FactStore satisfies it; tests fake it). */
export interface PrepStore {
    startPrepRun(patientId: string, correlationId: string): Promise<string>;
    finishPrepRun(runId: string, status: PrepRunStatus, error?: string): Promise<void>;
    /** Optional stage stamping — a failed run's row then shows where it died (/api/prep-runs). */
    setPrepRunStage?(runId: string, stageName: string): Promise<void>;
    saveBrief(brief: BriefInput): Promise<StoredBrief>;
}

/** The SpendGuard surface the pipeline needs (SpendGuard satisfies it; tests fake it). */
export interface PrepSpendGuard {
    assertBudget(): Promise<void>;
    recordCall(call: LlmCallRecord): Promise<void>;
}

export interface PrepDeps {
    store: PrepStore;
    source: DocumentSource;
    extractor: FactExtractor;
    logger: PrepLogger;
    /** Spend guardrails: 24h budget gate before the LLM call + per-call ledger writes. */
    spendGuard?: PrepSpendGuard;
    /** Langfuse tracing: one trace per run, spans per stage, generations per LLM attempt. */
    tracer?: PrepTracer;
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
    const spendGuard = deps.spendGuard;
    const trace: PrepTraceHandle | undefined = deps.tracer?.startTrace({ correlationId, patientId, prepRunId });
    // Stamp the stage being ENTERED on the prep_run row before running it: a running run
    // shows where it is, a failed run shows where it died.
    const runStage = async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
        await deps.store.setPrepRunStage?.(prepRunId, name);
        const startedAt = new Date();
        const result = await stage(logger, correlationId, name, fn);
        trace?.stage({ name, startedAt, durationMs: Date.now() - startedAt.getTime() });
        return result;
    };
    try {
        // Budget gate BEFORE any token is bought: a blown 24h budget throws
        // BudgetExceededError here, and the catch below records its clear message
        // on the prep_run row as the failure.
        if (spendGuard !== undefined) {
            await runStage('budget_check', () => spendGuard.assertBudget());
        }

        const sources = await runStage('load_sources', () =>
            deps.source.load(patientId, correlationId),
        );

        const extraction = await runStage('llm_extraction', () =>
            deps.extractor.extract(
                { patientId, patientName: sources.patient.name, documents: sources.documents },
                correlationId,
                logger,
                // Ledger + trace every Anthropic call (all attempts) under this run's ID.
                async (usage) => {
                    trace?.generation({
                        label: usage.label,
                        attempt: usage.attempt,
                        model: usage.model,
                        inputTokens: usage.inputTokens,
                        outputTokens: usage.outputTokens,
                        startedAt: usage.startedAt,
                        endedAt: usage.endedAt,
                    });
                    await spendGuard?.recordCall({
                        model: usage.model,
                        inputTokens: usage.inputTokens,
                        outputTokens: usage.outputTokens,
                        correlationId,
                        purpose: 'prep_extraction',
                    });
                },
                // Per-document progress lands on the prep_run row: /api/prep-runs shows
                // llm_extraction:7/12 instead of one opaque multi-minute stage.
                (progress) =>
                    deps.store.setPrepRunStage?.(prepRunId, `llm_extraction:${progress.done}/${progress.total}`),
            ),
        );

        // Citation gate over every extracted fact: blocked facts are dropped from the
        // brief (the rewrite-as-absence) and logged alongside the gate metrics.
        const { verifiedFacts, metrics } = await runStage('citation_gate', () => {
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

        const medicationRiskFlags = await runStage('medication_risk', () =>
            computeMedicationRiskFlags(medicationEngineInputs(verifiedFacts, now), profile),
        );

        const imaging = await runStage('imaging_analytics', () => ({
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

        const content = await runStage('brief_assembly', () =>
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

        const brief = await runStage('save_brief', () =>
            deps.store.saveBrief({
                patient_id: patientId,
                correlation_id: correlationId,
                content,
                status: 'complete',
            }),
        );

        await deps.store.finishPrepRun(prepRunId, 'complete');
        logger.info({ correlationId, prepRunId, patientId, briefId: brief.id }, 'prep run complete');
        await trace?.end({ status: 'complete', gateMetrics: metrics });
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
        await trace?.end({ status: 'failed', error: message });
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
