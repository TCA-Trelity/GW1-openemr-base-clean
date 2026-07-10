// Prep/brief/facts/usage routes (S1.7 + spend guardrails). POST /api/prep runs the
// pipeline async in-process behind four cost guards (reuse window -> in-flight dedupe ->
// concurrency cap -> budget precheck); reads return the latest complete brief, the fact
// bundle, or the 24h LLM usage summary. Without a configured store the routes answer 503.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { BudgetExceededError, type UsageSummary } from '../prep/budget.js';
import type { PrepTracer } from '../obs/langfuse.js';
import { executePrep, type PrepDeps, type PrepSpendGuard, type PrepStore } from '../prep/pipeline.js';
import type { DocumentSource } from '../prep/sources.js';
import type { FactExtractor } from '../prep/extraction.js';
import type { GamePlanComposer } from '../prep/gamePlan.js';
import type { ProviderProfile } from '../schemas/index.js';
import type { FactBundle, StoredBrief, StoredPrepRun } from '../store/index.js';

/** The FactStore surface these routes need (FactStore satisfies it; tests fake it). */
export interface PrepRouteStore extends PrepStore {
    getBrief(patientId: string): Promise<StoredBrief | null>;
    getFactBundle(patientId: string): Promise<FactBundle | null>;
    getPrepRuns(patientId: string, limit?: number): Promise<StoredPrepRun[]>;
}

/** The SpendGuard surface these routes need (SpendGuard satisfies it; tests fake it). */
export interface PrepRouteSpendGuard extends PrepSpendGuard {
    usageSummary(): Promise<UsageSummary>;
}

export interface PrepRouteDeps {
    store: PrepRouteStore;
    source: DocumentSource;
    extractor: FactExtractor;
    /** Q3 game-plan composer — optional; briefs store game_plan: null without it. */
    gamePlanComposer?: GamePlanComposer;
    /** Spend guardrails: budget precheck + GET /api/usage (absent only in bare scaffolds). */
    spendGuard?: PrepRouteSpendGuard;
    /** Langfuse tracing, passed through to the pipeline when configured. */
    tracer?: PrepTracer;
    /** Reuse a brief newer than this instead of re-running (config PREP_REUSE_WINDOW_MINUTES). */
    reuseWindowMinutes?: number;
    /** Cap on concurrently executing preps in this process (config LLM_MAX_CONCURRENT_PREPS). */
    maxConcurrentPreps?: number;
    clock?: () => Date;
    providerProfile?: ProviderProfile;
}

type PatientParams = { Params: { patientId: string } };
type PrepRequest = PatientParams & { Querystring: { force?: string } };

// Defaults mirror the config.ts Zod defaults; server.ts passes the parsed config values.
const DEFAULT_REUSE_WINDOW_MINUTES = 10;
const DEFAULT_MAX_CONCURRENT_PREPS = 2;

// In-flight preps in THIS process (fire-and-forget executions): patientId -> prep_run_id.
// Backs the dedupe and concurrency guards; entries are removed when the run settles.
const inFlightPreps = new Map<string, string>();

function storeNotConfigured(reply: FastifyReply): FastifyReply {
    return reply.status(503).send({ error: 'store_not_configured' });
}

export function registerPrepRoutes(app: FastifyInstance, deps: PrepRouteDeps | undefined): void {
    app.post<PrepRequest>('/api/prep/:patientId', async (request, reply) => {
        if (deps === undefined) {
            return storeNotConfigured(reply);
        }
        const { patientId } = request.params;
        const correlationId = request.id;
        const now = (deps.clock ?? (() => new Date()))();

        // Guard (a) — reuse window: a fresh-enough complete brief answers without any
        // LLM spend; ?force=true bypasses for an explicit re-prep.
        if (request.query.force !== 'true') {
            const reuseWindowMs = (deps.reuseWindowMinutes ?? DEFAULT_REUSE_WINDOW_MINUTES) * 60_000;
            const brief = await deps.store.getBrief(patientId);
            if (brief !== null && now.getTime() - new Date(brief.prepared_at).getTime() < reuseWindowMs) {
                return reply.status(200).send({ status: 'reused', brief_id: brief.id, prepared_at: brief.prepared_at });
            }
        }

        // Guard (b) — in-flight dedupe: one running prep per patient per process.
        const runningId = inFlightPreps.get(patientId);
        if (runningId !== undefined) {
            return reply.status(202).send({ status: 'already_running', prep_run_id: runningId });
        }

        // Guard (c) — concurrency cap across all patients in this process.
        if (inFlightPreps.size >= (deps.maxConcurrentPreps ?? DEFAULT_MAX_CONCURRENT_PREPS)) {
            return reply.status(429).send({ error: 'too_many_preps' });
        }

        // Guard (d) — budget precheck before even opening a prep_run row (the pipeline
        // re-checks right before the LLM call for runs already in flight).
        if (deps.spendGuard !== undefined) {
            try {
                await deps.spendGuard.assertBudget();
            } catch (error) {
                if (error instanceof BudgetExceededError) {
                    return reply
                        .status(429)
                        .send({ error: 'llm_budget_exceeded', spent_usd: error.spentUsd, budget_usd: error.budgetUsd });
                }
                throw error;
            }
        }

        const prepRunId = await deps.store.startPrepRun(patientId, correlationId);
        const prepDeps: PrepDeps = {
            store: deps.store,
            source: deps.source,
            extractor: deps.extractor,
            logger: request.log,
            ...(deps.gamePlanComposer !== undefined ? { gamePlanComposer: deps.gamePlanComposer } : {}),
            ...(deps.spendGuard !== undefined ? { spendGuard: deps.spendGuard } : {}),
            ...(deps.tracer !== undefined ? { tracer: deps.tracer } : {}),
            ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
            ...(deps.providerProfile !== undefined ? { providerProfile: deps.providerProfile } : {}),
        };
        inFlightPreps.set(patientId, prepRunId);
        // Fire-and-forget (Tier-1 in-process async): executePrep records failures on the
        // prep_run row before rethrowing, so this catch only needs to log; the finally
        // releases the in-flight slot however the run ends.
        void executePrep(prepDeps, { prepRunId, patientId, correlationId })
            .catch((error: unknown) => {
                request.log.error({ correlationId, prepRunId, err: String(error) }, 'async prep run failed');
            })
            .finally(() => {
                inFlightPreps.delete(patientId);
            });
        return reply.status(202).send({ prep_run_id: prepRunId, correlation_id: correlationId });
    });

    app.get<PatientParams>('/api/brief/:patientId', async (request, reply) => {
        if (deps === undefined) {
            return storeNotConfigured(reply);
        }
        const brief = await deps.store.getBrief(request.params.patientId);
        if (brief === null) {
            return reply.status(404).send({ status: 'not_prepared' });
        }
        return reply.send(brief);
    });

    app.get<PatientParams>('/api/facts/:patientId', async (request, reply) => {
        if (deps === undefined) {
            return storeNotConfigured(reply);
        }
        const bundle = await deps.store.getFactBundle(request.params.patientId);
        if (bundle === null) {
            return reply.status(404).send({ error: 'patient_not_found' });
        }
        return reply.send(bundle);
    });

    // Run-status observability: newest-first prep history with stage + error, so "is my
    // prep stuck / why did it fail" answers over HTTP instead of Railway log archaeology.
    app.get<PatientParams>('/api/prep-runs/:patientId', async (request, reply) => {
        if (deps === undefined) {
            return storeNotConfigured(reply);
        }
        return reply.send({ runs: await deps.store.getPrepRuns(request.params.patientId, 20) });
    });

    app.get('/api/usage', async (_request, reply) => {
        if (deps?.spendGuard === undefined) {
            return storeNotConfigured(reply);
        }
        return reply.send(await deps.spendGuard.usageSummary());
    });
}
