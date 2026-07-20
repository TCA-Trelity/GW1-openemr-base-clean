// Sidecar entrypoint. Every request gets a correlation ID (honoring an incoming
// x-correlation-id) that appears on every log line, response header, tool call and
// LLM interaction, so a full trace reconstructs from logs alone (project brief
// engineering requirement). Store-backed deps wire in only when DATABASE_URL is set.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { Langfuse } from 'langfuse';
import { ChatService, type ChatImageLoader } from './chat/chat.js';
import { DevTokenService } from './auth/devToken.js';
import { SmartTokenVerifier } from './auth/smartVerifier.js';
import { CompositeVerifier } from './auth/verifier.js';
import { registerAuth, type AuthDeps, type AuthMode } from './auth/middleware.js';
import { registerAuthRoutes, type AuthRouteDeps } from './routes/auth.js';
import { EhrSyncService } from './openemr/ehrSync.js';
import { OpenEmrAuthClient } from './openemr/auth.js';
import { FhirClient } from './openemr/fhir.js';
import { loadConfig, type Config } from './config.js';
import { CircuitBreaker, type BreakerState } from './lib/circuitBreaker.js';
import { registerRateLimit } from './lib/rateLimiter.js';
import { LangfuseTracer } from './obs/langfuse.js';
import { tracingGraphLogger } from './obs/graphTracer.js';
import { AnthropicClient } from './prep/anthropic.js';
import { SpendGuard } from './prep/budget.js';
import { FactExtractor } from './prep/extraction.js';
import { GamePlanComposer } from './prep/gamePlan.js';
import { StoreDocumentSource } from './prep/sources.js';
import { registerChatRoutes, type ChatRouteDeps } from './routes/chat.js';
import { registerEvidenceRoutes, registerIngestRoutes, type EvidenceRouteDeps, type IngestRouteDeps } from './routes/ingest.js';
import { LlmAnswerComposer } from './graph/composer.js';
import { LlmRouterModel } from './graph/routerModel.js';
import { MemoryPinnedEvidenceStore } from './graph/pins.js';
import { registerEhrRoutes, type EhrRouteDeps } from './routes/ehr.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerOverviewRoutes, type OverviewRouteDeps } from './routes/overview.js';
import { registerPrepRoutes, type PrepRouteDeps } from './routes/prep.js';
import { registerVerifyRoutes, type VerifyRouteDeps } from './routes/verify.js';
import { createPool, FactStore } from './store/index.js';
import { migrate } from './store/migrate.js';
import { IngestionService, MemoryIngestionRecordStore } from './ingest/service.js';
import { VlmExtractor } from './ingest/extractor.js';
import { CircuitGuardedEmbeddings, CircuitGuardedReranker } from './retrieval/circuitGuards.js';
import { CohereEmbeddings, HashEmbeddings, type EmbeddingsProvider } from './retrieval/embeddings.js';
import { CohereReranker, PassthroughReranker, type Reranker } from './retrieval/rerank.js';
import { HybridRetriever, loadCorpusChunks, type RetrievalLogger } from './retrieval/retriever.js';
import { PgVectorDenseIndex, type DenseIndex, type PgQueryable } from './retrieval/denseIndex.js';
import { OpenEmrPasswordAuthClient } from './openemr/auth.js';
import { StandardApiClient } from './openemr/standardApi.js';

export interface AppDeps {
    /** The fact store's pg pool — shared by the pgvector dense index (B.3-live). */
    pool: PgQueryable;
    /** Real readiness probe for /ready (SELECT 1 through the pool). */
    checkPostgres: () => Promise<void>;
    /** E.6: proves the OpenEMR write client can mint a token (document storage). */
    checkDocumentStorage?: () => Promise<void>;
    /** Applies pending fact-store migrations (idempotent, advisory-locked). */
    runMigrations: () => Promise<string[]>;
    prep: PrepRouteDeps;
    /** Deterministic landing-page reads (no LLM in the load path). */
    overview: OverviewRouteDeps;
    /** Streaming chat over the stored fact bundle (S2.3). */
    chat: ChatRouteDeps;
    /** Live EHR FHIR sync (E2); absent until the OpenEMR read client is configured. */
    ehr?: EhrRouteDeps;
    /** Authorization PEP (AZ2): the global preHandler's verifier + mode. */
    auth?: AuthDeps;
    /** Dev-login + /api/me (AZ4). */
    authRoutes?: AuthRouteDeps;
    /** Role-gated fact verification (S3.3). */
    verify?: VerifyRouteDeps;
    /** Week 2 A.3: document ingestion (attach_and_extract). */
    ingest?: IngestRouteDeps;
    /** Week 2 B.4: hybrid guideline retrieval — built async at boot (embeds the corpus). */
    evidence?: EvidenceRouteDeps;
    /** H.10: ONE circuit breaker per dependency, created once in buildDeps and shared by
     *  every client of that dependency (the 'cohere' breaker lives on `evidence`, built in
     *  buildEvidenceDeps). Always present from buildDeps; optional only so scaffold test
     *  doubles stay minimal. buildServer reflects their states on /ready. */
    breakers?: { openemr: CircuitBreaker; anthropic: CircuitBreaker };
}

/** H.10: circuit-breaker transition hook — structured console JSON (same shape as the app's
 *  pino stream), dependency name + states only: PHI-free by construction (G18/P5). */
function breakerTransitionLog(dependency: string): (from: BreakerState, to: BreakerState) => void {
    return (from, to) =>
        console.warn(JSON.stringify({ level: 'warn', msg: 'circuit_breaker_transition', dependency, from, to }));
}

/** One resolution for the scan-pixels directory: /api/images static route + chat's loader. */
function scanImagesDir(config: Config): string {
    return config.SCAN_IMAGES_DIR ?? fileURLToPath(new URL('../seed/images/', import.meta.url));
}

const SCAN_MEDIA_TYPES: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
};

/**
 * Filesystem ChatImageLoader (IC4): reads a scan's pixels from the same directory
 * /api/images serves. storage_key is a flat filename by contract — anything path-like is
 * refused, and every failure degrades to null (the loader never throws).
 */
export function fsImageLoader(imagesDir: string): ChatImageLoader {
    return async (storageKey) => {
        if (storageKey.includes('/') || storageKey.includes('\\') || storageKey.includes('..')) {
            return null;
        }
        const mediaType = SCAN_MEDIA_TYPES[path.extname(storageKey).toLowerCase()];
        if (mediaType === undefined) {
            return null;
        }
        try {
            const bytes = await readFile(path.join(imagesDir, storageKey));
            return { mediaType, base64: bytes.toString('base64') };
        } catch {
            return null;
        }
    };
}

// Store-backed dependencies exist only when DATABASE_URL is configured; without it the
// scaffold still boots and the prep routes answer 503 store_not_configured.
export function buildDeps(config: Config): AppDeps | undefined {
    if (config.DATABASE_URL === undefined) {
        return undefined;
    }
    const pool = createPool(config);
    const store = new FactStore(pool);
    // H.10 (REQ G2): ONE breaker per dependency, created once at boot and threaded into
    // every client of that dependency. 5 consecutive failures → 30 s cooldown → one
    // half-open probe (circuitBreaker.ts defaults); /ready reflects the open state.
    const openemrBreaker = new CircuitBreaker({ name: 'openemr', onTransition: breakerTransitionLog('openemr') });
    const anthropicBreaker = new CircuitBreaker({ name: 'anthropic', onTransition: breakerTransitionLog('anthropic') });
    const prepLlmClient = new AnthropicClient({
        apiKey: config.ANTHROPIC_API_KEY ?? '',
        model: config.ANTHROPIC_MODEL_PREP,
        maxTokens: config.LLM_MAX_OUTPUT_TOKENS,
        breaker: anthropicBreaker,
    });
    const extractor = new FactExtractor(prepLlmClient);
    // Q3: the game-plan composer shares the prep model/budget — one extra bounded call per prep.
    const gamePlanComposer = new GamePlanComposer(prepLlmClient);
    // Spend guardrails share the store's pool: llm_calls ledger + rolling 24h budget gate.
    const spendGuard = new SpendGuard(pool, {
        dailyBudgetUsd: config.LLM_DAILY_BUDGET_USD,
        inputUsdPerMtok: config.LLM_INPUT_USD_PER_MTOK,
        outputUsdPerMtok: config.LLM_OUTPUT_USD_PER_MTOK,
    });
    // Langfuse tracing (S2.6) engages only when fully configured; a bare pino logger is
    // fine here — tracer warnings carry the correlation ID themselves.
    const tracer =
        config.LANGFUSE_HOST !== undefined &&
        config.LANGFUSE_PUBLIC_KEY !== undefined &&
        config.LANGFUSE_SECRET_KEY !== undefined
            ? new LangfuseTracer(
                  new Langfuse({
                      baseUrl: config.LANGFUSE_HOST,
                      publicKey: config.LANGFUSE_PUBLIC_KEY,
                      secretKey: config.LANGFUSE_SECRET_KEY,
                      requestTimeout: 10_000,
                  }),
                  console,
              )
            : undefined;

    // Authorization (Wave AZ). Two token paths feed one verifier: sidecar-minted dev tokens
    // (present when DEV_LOGIN_SECRET is set — the demo/grading path) and OpenEMR SMART tokens
    // (present when the EHR base URL + our client id are set — the production path, patient
    // resolved from the token's introspection back to a seeded sidecar patient). Enforcement
    // engages only when AUTH_MODE=enforced AND at least one path is configured, so a bare or
    // half-configured deploy keeps serving instead of 401-ing everything.
    const devTokens =
        config.DEV_LOGIN_SECRET !== undefined
            ? new DevTokenService({ secret: config.DEV_LOGIN_SECRET, ttlSeconds: config.DEV_TOKEN_TTL_SECONDS })
            : undefined;
    const smartVerifier =
        config.OPENEMR_BASE_URL !== undefined && config.OPENEMR_CLIENT_ID !== undefined
            ? new SmartTokenVerifier({
                  oauthBaseUrl: `${config.OPENEMR_BASE_URL.replace(/\/+$/, '')}/oauth2/${config.OPENEMR_OAUTH_SITE}`,
                  clientId: config.OPENEMR_CLIENT_ID,
                  resolvePatient: (openemrPatientUuid) => store.findPatientIdByOpenemrId(openemrPatientUuid),
              })
            : undefined;
    const verifier = new CompositeVerifier(devTokens, smartVerifier);
    const authMode: AuthMode = config.AUTH_MODE === 'enforced' && verifier.isConfigured ? 'enforced' : 'off';

    // Week 2 (A.3/A.6): document ingestion. The VLM extractor shares the prep-model
    // client; EHR document storage engages only when the password-grant user is
    // configured (standard API rejects client_credentials — see openemr/auth.ts).
    const ingestionRecords = new MemoryIngestionRecordStore();
    const ehrTokenProvider =
        config.OPENEMR_BASE_URL !== undefined &&
        config.OPENEMR_CLIENT_ID !== undefined &&
        config.OPENEMR_API_USERNAME !== undefined &&
        config.OPENEMR_API_PASSWORD !== undefined
            ? new OpenEmrPasswordAuthClient({
                  baseUrl: config.OPENEMR_BASE_URL,
                  clientId: config.OPENEMR_CLIENT_ID,
                  username: config.OPENEMR_API_USERNAME,
                  password: config.OPENEMR_API_PASSWORD,
                  breaker: openemrBreaker,
              })
            : undefined;
    const ehrDocsClient =
        ehrTokenProvider !== undefined && config.OPENEMR_BASE_URL !== undefined
            ? new StandardApiClient({
                  baseUrl: config.OPENEMR_BASE_URL,
                  tokenProvider: ehrTokenProvider,
                  breaker: openemrBreaker,
              })
            : undefined;
    // H.7 (step 5, H.8 seam): ingestion stage events (`ingestion_*`,
    // `extraction_field_outcome`) were silent in production — give them the same
    // structured-JSON console shape as the graph logger so every stage is one
    // correlation-id grep away. H.8 owns upgrading this to the shared app logger;
    // graph-run ingestions additionally nest under the intake_extractor span once
    // these events route through tracingGraphLogger (adapter side shipped with H.7).
    const ingestionLogger = {
        info: (obj: unknown, msg: string): void =>
            console.log(JSON.stringify({ level: 'info', msg, ...(typeof obj === 'object' && obj !== null ? obj : {}) })),
        warn: (obj: unknown, msg: string): void =>
            console.warn(JSON.stringify({ level: 'warn', msg, ...(typeof obj === 'object' && obj !== null ? obj : {}) })),
    };
    const ingestionService = new IngestionService({
        extractor: new VlmExtractor(prepLlmClient),
        records: ingestionRecords,
        factSink: store,
        logger: ingestionLogger,
        ...(ehrDocsClient !== undefined
            ? {
                  ehr: {
                      client: ehrDocsClient,
                      openemrPatientId: async (patientId: string) =>
                          (await store.getPatient(patientId))?.openemr_patient_id ?? null,
                  },
              }
            : {}),
    });

    return {
        checkPostgres: async () => {
            await pool.query('SELECT 1');
        },
        // E.6: document-storage probe — a token mint proves base URL, client id, and
        // password-grant credentials in one cheap round trip (cached between probes,
        // no chart data touched).
        ...(ehrTokenProvider !== undefined
            ? {
                  checkDocumentStorage: async () => {
                      await ehrTokenProvider.getAccessToken();
                  },
              }
            : {}),
        pool,
        runMigrations: () => migrate(pool),
        prep: {
            store,
            // Tier-1 demo path reads the seeded fact store; FhirDocumentSource swaps in
            // once the live FHIR client credentials land with S1.9.
            source: new StoreDocumentSource(store, pool),
            extractor,
            gamePlanComposer,
            spendGuard,
            ...(tracer !== undefined ? { tracer } : {}),
            reuseWindowMinutes: config.PREP_REUSE_WINDOW_MINUTES,
            maxConcurrentPreps: config.LLM_MAX_CONCURRENT_PREPS,
        },
        overview: { store },
        ...(config.OPENEMR_BASE_URL !== undefined &&
        config.OPENEMR_CLIENT_ID !== undefined &&
        config.OPENEMR_CLIENT_KEY !== undefined
            ? {
                  ehr: {
                      service: new EhrSyncService(
                          new FhirClient({
                              baseUrl: config.OPENEMR_BASE_URL,
                              tokenProvider: new OpenEmrAuthClient({
                                  baseUrl: config.OPENEMR_BASE_URL,
                                  clientId: config.OPENEMR_CLIENT_ID,
                                  privateKeyPem: config.OPENEMR_CLIENT_KEY,
                                  breaker: openemrBreaker,
                              }),
                              breaker: openemrBreaker,
                          }),
                          store,
                      ),
                  },
              }
            : {}),
        chat: {
            store,
            service: new ChatService(
                new AnthropicClient({
                    apiKey: config.ANTHROPIC_API_KEY ?? '',
                    model: config.ANTHROPIC_MODEL_CHAT,
                    maxTokens: config.LLM_CHAT_MAX_OUTPUT_TOKENS,
                    breaker: anthropicBreaker,
                }),
                store,
                spendGuard,
                undefined, // default tool registry
                fsImageLoader(scanImagesDir(config)), // IC4: describe_scan pixel attachment
            ),
            spendGuard,
        },
        auth: { verifier, mode: authMode },
        authRoutes: {
            ...(devTokens !== undefined ? { devTokens } : {}),
            patientExists: async (patientId) => (await store.getPatient(patientId)) !== null,
            mode: authMode,
        },
        verify: { store },
        ingest: {
            service: ingestionService,
            records: ingestionRecords,
            enforcePatientScope: authMode === 'enforced',
            expectedPatientOf: async (patientId) => {
                const bundle = await store.getFactBundle(patientId);
                return bundle === null ? undefined : { name: bundle.patient.name };
            },
        },
        breakers: { openemr: openemrBreaker, anthropic: anthropicBreaker },
    };
}

export function buildServer(config: Config, deps?: AppDeps): FastifyInstance {
    const app = Fastify({
        logger: {
            level: config.NODE_ENV === 'test' ? 'silent' : 'info',
        },
        genReqId: (req) => (req.headers['x-correlation-id'] as string | undefined) ?? randomUUID(),
    });

    app.addHook('onSend', async (request, reply) => {
        reply.header('x-correlation-id', request.id);
    });

    // Authorization first: decorates request.principal and installs the global PEP preHandler
    // (a no-op in 'off' mode) before any route is registered, so every /api route is guarded.
    registerAuth(app, deps?.auth);

    // Per-caller rate limit on the expensive LLM/write routes — after auth so it can key on the
    // bound principal. Bounds a single caller's request rate so one client cannot exhaust the shared
    // LLM budget and deny the assistant to everyone (economic-DoS defense).
    registerRateLimit(app, { max: config.RATE_LIMIT_MAX, windowMs: config.RATE_LIMIT_WINDOW_MS });

    registerHealthRoutes(
        app,
        config,
        deps === undefined
            ? undefined
            : {
                  checkPostgres: deps.checkPostgres,
                  ...(deps.checkDocumentStorage === undefined ? {} : { checkDocumentStorage: deps.checkDocumentStorage }),
                  // E.6: retriever probe — an empty guideline index is a real failure
                  // once evidence routes are wired (out-of-domain floors depend on it).
                  ...(deps.evidence === undefined
                      ? {}
                      : {
                            checkRetrieverIndex: async () => {
                                const size = deps.evidence?.retriever.size ?? 0;
                                if (size === 0) {
                                    throw new Error('guideline index holds zero chunks');
                                }
                            },
                        }),
                  // Reranker (H.2): the probe reflects the outcome of the last REAL rerank
                  // made by traffic — key presence alone is no evidence Cohere answers, and
                  // a per-poll live call is ruled out (rate limits + per-call cost). Wired
                  // beside the CohereReranker in buildEvidenceDeps; unkeyed deployments run
                  // PassthroughReranker with no probe → not_configured (degraded, accurate —
                  // fused order still serves).
                  ...(deps.evidence?.checkReranker === undefined ? {} : { checkReranker: deps.evidence.checkReranker }),
                  // H.10: /ready reflects circuit state — an OPEN dependency reports failed
                  // with circuit_open and its live check is suppressed (no hammering, not
                  // even from readiness). The cohere breaker surfaces under the `reranker`
                  // dep name, composing with H.2's probe: open wins; otherwise the probe
                  // answers exactly as it does today. Evaluated per poll, so the evidence
                  // deps (attached after buildDeps at boot) are picked up late.
                  breakerStates: (): Record<string, BreakerState> => ({
                      ...(deps.breakers === undefined
                          ? {}
                          : { openemr: deps.breakers.openemr.state, anthropic: deps.breakers.anthropic.state }),
                      ...(deps.evidence?.cohereBreaker === undefined ? {} : { reranker: deps.evidence.cohereBreaker.state }),
                  }),
              },
    );
    registerAuthRoutes(app, deps?.authRoutes);
    registerPrepRoutes(app, deps?.prep);
    registerVerifyRoutes(app, deps?.verify);
    registerOverviewRoutes(app, deps?.overview);
    registerChatRoutes(app, deps?.chat);
    registerEhrRoutes(app, deps?.ehr);
    registerIngestRoutes(app, deps?.ingest);
    registerEvidenceRoutes(app, deps?.evidence);

    // Scan images (S2.13): image_records carry a storage_key; the panel loads
    // /api/images/<storage_key>. fastify-static owns traversal safety.
    const imagesDir = scanImagesDir(config);
    if (existsSync(imagesDir)) {
        void app.register(fastifyStatic, {
            root: imagesDir,
            prefix: '/api/images/',
            decorateReply: false,
            index: false,
            maxAge: '7d',
        });
    }

    // Serve the built panel when present (panel/dist ships in the image); SPA
    // fallback for non-API GETs so ?patient= URLs deep-link correctly.
    const panelDist = fileURLToPath(new URL('../panel/dist/', import.meta.url));
    if (existsSync(path.join(panelDist, 'index.html'))) {
        void app.register(fastifyStatic, { root: panelDist, index: ['index.html'] });
        app.setNotFoundHandler((request, reply) => {
            if (request.method === 'GET' && !request.url.startsWith('/api')) {
                return reply.sendFile('index.html');
            }
            return reply.status(404).send({ message: `Route ${request.method}:${request.url} not found`, error: 'Not Found', statusCode: 404 });
        });
    }
    return app;
}

/** Week 2 (B.3/B.4): build the guideline retriever. Cohere when keyed; deterministic
 *  offline backends otherwise — retrieval never hard-depends on a vendor being up. */
export interface EvidenceBuildOptions {
    /** Fact-store pool: enables the persisted pgvector dense index (migration 005). */
    pool?: PgQueryable;
    /** Idempotent migration runner — invoked before the index sync so first boot works. */
    runMigrations?: () => Promise<string[]>;
    /** Ledger sink (R7): Cohere embed/rerank calls recorded as unit-counted llm_calls rows. */
    onCohereUsage?: (usage: { purpose: 'cohere_embed' | 'cohere_rerank'; model: string; units: number; correlationId: string }) => void;
}

export async function buildEvidenceDeps(
    config: Config,
    logger?: RetrievalLogger,
    options?: EvidenceBuildOptions,
): Promise<EvidenceRouteDeps | undefined> {
    const corpusDir = fileURLToPath(new URL('../corpus/', import.meta.url));
    if (!existsSync(corpusDir)) {
        return undefined;
    }
    const chunks = loadCorpusChunks(corpusDir);
    const onUsage = options?.onCohereUsage;
    // H.10: ONE 'cohere' breaker shared by both providers (one vendor, one counter),
    // existing only when the vendor does. The decorators catch ONLY CircuitOpenError and
    // degrade honestly — embed → [] (dense leg skips; keyword+fusion serves), rerank →
    // passthrough order with rerank_applied=false. Real errors propagate: they feed the
    // breaker. Keyless deployments keep the Week 1 offline backends, no breaker at all.
    let embeddings: EmbeddingsProvider = new HashEmbeddings();
    let reranker: Reranker = new PassthroughReranker();
    let cohereBreakerMaybe: CircuitBreaker | undefined;
    let cohereRerankerMaybe: CohereReranker | undefined;
    if (config.COHERE_API_KEY !== undefined) {
        const degradeLogger = {
            warn: (obj: Record<string, unknown>, msg: string): void =>
                console.warn(JSON.stringify({ level: 'warn', msg, ...obj })),
        };
        cohereBreakerMaybe = new CircuitBreaker({ name: 'cohere', onTransition: breakerTransitionLog('cohere') });
        cohereRerankerMaybe = new CohereReranker({
            apiKey: config.COHERE_API_KEY,
            model: config.COHERE_RERANK_MODEL,
            ...(onUsage === undefined
                ? {}
                : {
                      onUsage: (units: number, correlationId: string) =>
                          onUsage({ purpose: 'cohere_rerank', model: config.COHERE_RERANK_MODEL, units, correlationId }),
                  }),
        });
        embeddings = new CircuitGuardedEmbeddings(
            new CohereEmbeddings({
                apiKey: config.COHERE_API_KEY,
                model: config.COHERE_EMBED_MODEL,
                ...(onUsage === undefined
                    ? {}
                    : {
                          onUsage: (units: number, correlationId: string) =>
                              onUsage({ purpose: 'cohere_embed', model: config.COHERE_EMBED_MODEL, units, correlationId }),
                      }),
            }),
            cohereBreakerMaybe,
            degradeLogger,
        );
        reranker = new CircuitGuardedReranker(cohereRerankerMaybe, cohereBreakerMaybe, degradeLogger);
    }
    // Const captures so narrowing flows into the closures below.
    const cohereBreaker = cohereBreakerMaybe;
    const cohereReranker = cohereRerankerMaybe;

    // B.3-live: RETRIEVER_DENSE_BACKEND finally branches. pgvector engages when a database
    // is wired AND Cohere is keyed (the table is vector(1024) = embed-english-v3.0 dims);
    // any failure falls back to the in-memory dense path — loudly, never fatally.
    let denseIndex: DenseIndex | undefined;
    if (config.RETRIEVER_DENSE_BACKEND === 'pgvector' && options?.pool !== undefined && config.COHERE_API_KEY !== undefined) {
        try {
            await options.runMigrations?.();
            denseIndex = await PgVectorDenseIndex.sync(options.pool, chunks, embeddings, 'corpus-index-boot', logger);
        } catch (error) {
            logger?.info(
                { backend: 'pgvector', error: error instanceof Error ? error.message : String(error) },
                'pgvector dense index unavailable — in-memory dense path serves',
            );
        }
    }
    return {
        retriever: await HybridRetriever.build(chunks, {
            embeddings,
            reranker,
            ...(logger === undefined ? {} : { logger }),
            ...(denseIndex === undefined ? {} : { denseIndex }),
        }),
        // H.2: /ready's reranker probe. Reports the outcome of the LAST real rerank made
        // by traffic (the inner CohereReranker records it — the H.10 guard wrapping it
        // never touches the observation) — never a per-poll Cohere call: trial keys are
        // rate-limited and every rerank costs money. Keyed but not yet exercised is ok
        // with an explicit "unverified" detail; a failure more recent than the last
        // success reports failed until traffic succeeds again.
        ...(cohereReranker !== undefined
            ? {
                  checkReranker: async (): Promise<string> => {
                      const observed = cohereReranker.lastOutcome;
                      if (observed === undefined) {
                          return 'keyed (unverified since boot — no rerank traffic yet)';
                      }
                      if (!observed.ok) {
                          throw new Error(
                              `last real rerank failed at ${observed.at.toISOString()}${observed.detail === undefined ? '' : ` — ${observed.detail}`}`,
                          );
                      }
                      return `verified by live traffic (last rerank ok at ${observed.at.toISOString()})`;
                  },
              }
            : {}),
        // H.10: buildServer reflects this breaker's state on /ready under the `reranker`
        // dep name (open wins over the H.2 probe above).
        ...(cohereBreaker === undefined ? {} : { cohereBreaker }),
    };
}

// Boot only when executed directly (tests import buildServer instead).
if (process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('server.ts')) {
    const config = loadConfig();
    const deps = buildDeps(config);
    // Evidence retriever builds before the server so its routes register at startup.
    // With pgvector (B.3-live) the boot sync embeds only changed chunks — an unchanged
    // corpus costs zero Cohere calls; keyless/db-less runs use the in-memory path.
    // Same structured-JSON shape as the app logger so retrieval_hit/miss events (G5)
    // stay one grep away from the pino stream.
    const retrievalBootLogger = {
        info: (obj: Record<string, unknown>, msg: string) => console.log(JSON.stringify({ level: 'info', msg, ...obj })),
    };
    const evidence = await buildEvidenceDeps(
        loadConfig(),
        retrievalBootLogger,
        deps === undefined
            ? undefined
            : {
                  pool: deps.pool,
                  runMigrations: deps.runMigrations,
                  // R7: Cohere calls ride the same llm_calls ledger as Anthropic calls —
                  // unit-counted (texts embedded / candidates reranked). est_cost_usd is 0,
                  // not priced through the Anthropic rate card: per-unit Cohere pricing
                  // stays a COSTS.md §6.2 verify-at-key-drop cell, never memory-quoted.
                  onCohereUsage: (usage) => {
                      void deps.pool
                          .query(
                              `INSERT INTO llm_calls (correlation_id, purpose, model, input_tokens, output_tokens, est_cost_usd)
                               VALUES ($1, $2, $3, $4, 0, 0)`,
                              [usage.correlationId, usage.purpose, usage.model, usage.units],
                          )
                          .catch(() => undefined); // the ledger must never fail retrieval
                  },
              },
    );
    if (deps !== undefined && evidence !== undefined) {
        deps.evidence = evidence;
        // E.9: assemble the chat evidence lane — router tie-break + LLM composer over
        // the same retriever/ingestion the routes use. Keyless deployments skip it and
        // every turn takes the Week 1 loop (an explicit boot log says so below).
        if (config.ANTHROPIC_API_KEY !== undefined && deps.ingest !== undefined) {
            // One structured JSON logger for the whole evidence lane (G12: every W2
            // component logs pino-shaped info/warn — ids/hashes/counts only, never
            // document text or patient identifiers). H.3: the router and composer log
            // through it too, so their degradation warnings never hit the raw console.
            const graphLogBase = {
                info: (obj: Record<string, unknown>, msg: string) => console.log(JSON.stringify({ level: 'info', msg, ...obj })),
                warn: (obj: Record<string, unknown>, msg: string) => console.warn(JSON.stringify({ level: 'warn', msg, ...obj })),
            };
            // H.10: router + composer share buildDeps' 'anthropic' breaker — one dependency,
            // one counter across prep/chat/router/composer. (H.4b's pre-check retry means up
            // to two exec calls per compose; each is its own logical call by design.) When
            // the circuit opens, CircuitOpenError rides the existing fallback lanes: router
            // → fast_path, composer → Week 1 loop.
            const anthropicBreakerSpread = deps.breakers === undefined ? {} : { breaker: deps.breakers.anthropic };
            const routerModel = new LlmRouterModel(
                new AnthropicClient({
                    apiKey: config.ANTHROPIC_API_KEY,
                    model: config.ANTHROPIC_MODEL_CHAT,
                    maxTokens: 16,
                    idleTimeoutMs: 3_000,
                    totalTimeoutMs: 5_000,
                    ...anthropicBreakerSpread,
                }),
                graphLogBase,
            );
            const composer = new LlmAnswerComposer(
                new AnthropicClient({
                    apiKey: config.ANTHROPIC_API_KEY,
                    model: config.ANTHROPIC_MODEL_CHAT,
                    maxTokens: 1500,
                    idleTimeoutMs: 10_000,
                    totalTimeoutMs: 20_000,
                    ...anthropicBreakerSpread,
                }),
                deps.chat.spendGuard,
                graphLogBase,
            );
            // E.4: when Langfuse is keyed, graph events additionally become spans on a
            // correlation-scoped trace (adapter over the same logger seam — no new
            // instrumentation points; docs/w2/trace-example.md is the span skeleton).
            const graphLangfuse =
                config.LANGFUSE_HOST !== undefined && config.LANGFUSE_PUBLIC_KEY !== undefined && config.LANGFUSE_SECRET_KEY !== undefined
                    ? new Langfuse({
                          baseUrl: config.LANGFUSE_HOST,
                          publicKey: config.LANGFUSE_PUBLIC_KEY,
                          secretKey: config.LANGFUSE_SECRET_KEY,
                          requestTimeout: 10_000,
                      })
                    : undefined;
            deps.chat.evidenceGraph = {
                clinical: {
                    retriever: evidence.retriever,
                    ingestion: deps.ingest.service,
                    composer,
                    routerModel,
                    pins: new MemoryPinnedEvidenceStore(),
                    logger: graphLangfuse === undefined ? graphLogBase : tracingGraphLogger(graphLogBase, graphLangfuse, console),
                },
                routerModel,
            };
        }
    }
    const app = buildServer(config, deps);
    if (deps?.chat !== undefined && deps.chat.evidenceGraph === undefined) {
        app.log.info({ composerConfigured: false }, 'evidence turns degrade to fast path — ANTHROPIC_API_KEY absent or ingestion off');
    }
    // E.5 (locked decision #2): LangSmith is a DEMO-ENV overlay only — LangGraph.js reads
    // the LANGSMITH_* env vars natively, so the fence is configuration, not code. The
    // committed posture stays Langfuse; production must never carry a LangSmith key.
    app.log.info(
        { langsmithTracing: config.LANGSMITH_TRACING === 'true', project: config.LANGSMITH_PROJECT },
        config.LANGSMITH_TRACING === 'true'
            ? 'LangSmith tracing ON — demo environment posture (synthetic data only)'
            : 'LangSmith tracing off — production posture (Langfuse is the committed backend)',
    );
    app.log.info(
        {
            corpusRetriever: evidence !== undefined,
            denseBackend: evidence?.retriever.denseBackend ?? 'off',
            embeddings: config.COHERE_API_KEY !== undefined ? 'cohere' : 'hash-offline',
        },
        evidence !== undefined ? 'guideline retriever ready' : 'guideline corpus absent — evidence routes off',
    );
    // Startup signal for EHR sync wiring: the panel's "not configured" state is exactly
    // deps.ehr being absent, so name the reason at boot instead of leaving it a mystery.
    const missingEhrConfig = [
        config.OPENEMR_BASE_URL === undefined ? 'OPENEMR_BASE_URL' : undefined,
        config.OPENEMR_CLIENT_ID === undefined ? 'OPENEMR_CLIENT_ID' : undefined,
        config.OPENEMR_CLIENT_KEY === undefined ? 'OPENEMR_CLIENT_KEY' : undefined,
    ].filter((name): name is string => name !== undefined);
    app.log.info(
        { ehrSyncConfigured: deps?.ehr !== undefined, missingEhrConfig },
        deps?.ehr !== undefined ? 'EHR sync configured' : 'EHR sync not configured',
    );
    // Migrations run at boot when the store is wired: idempotent + advisory-locked,
    // so concurrent replicas serialize and a no-op boot costs one SELECT.
    const boot = async (): Promise<void> => {
        if (deps !== undefined) {
            const applied = await deps.runMigrations();
            app.log.info({ applied }, 'fact store migrations checked');
        }
        await app.listen({ port: config.PORT, host: '0.0.0.0' });
    };
    boot().catch((error) => {
        app.log.error(error, 'failed to start');
        process.exit(1);
    });
}
