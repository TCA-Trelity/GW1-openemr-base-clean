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
import { CohereEmbeddings, HashEmbeddings } from './retrieval/embeddings.js';
import { CohereReranker, PassthroughReranker } from './retrieval/rerank.js';
import { HybridRetriever, loadCorpusChunks } from './retrieval/retriever.js';
import { OpenEmrPasswordAuthClient } from './openemr/auth.js';
import { StandardApiClient } from './openemr/standardApi.js';

export interface AppDeps {
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
    const prepLlmClient = new AnthropicClient({
        apiKey: config.ANTHROPIC_API_KEY ?? '',
        model: config.ANTHROPIC_MODEL_PREP,
        maxTokens: config.LLM_MAX_OUTPUT_TOKENS,
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
              })
            : undefined;
    const ehrDocsClient =
        ehrTokenProvider !== undefined && config.OPENEMR_BASE_URL !== undefined
            ? new StandardApiClient({
                  baseUrl: config.OPENEMR_BASE_URL,
                  tokenProvider: ehrTokenProvider,
              })
            : undefined;
    const ingestionService = new IngestionService({
        extractor: new VlmExtractor(prepLlmClient),
        records: ingestionRecords,
        factSink: store,
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
                              }),
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
            expectedPatientOf: async (patientId) => {
                const bundle = await store.getFactBundle(patientId);
                return bundle === null ? undefined : { name: bundle.patient.name };
            },
        },
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
                  // Reranker: keyed → live Cohere client was constructed at boot; unkeyed
                  // deployments run PassthroughReranker and report not_configured (degraded,
                  // accurate — fused order still serves).
                  ...(config.COHERE_API_KEY === undefined ? {} : { checkReranker: async () => {} }),
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
export async function buildEvidenceDeps(config: Config): Promise<EvidenceRouteDeps | undefined> {
    const corpusDir = fileURLToPath(new URL('../corpus/', import.meta.url));
    if (!existsSync(corpusDir)) {
        return undefined;
    }
    const chunks = loadCorpusChunks(corpusDir);
    const embeddings =
        config.COHERE_API_KEY !== undefined
            ? new CohereEmbeddings({ apiKey: config.COHERE_API_KEY, model: config.COHERE_EMBED_MODEL })
            : new HashEmbeddings();
    const reranker =
        config.COHERE_API_KEY !== undefined
            ? new CohereReranker({ apiKey: config.COHERE_API_KEY, model: config.COHERE_RERANK_MODEL })
            : new PassthroughReranker();
    return { retriever: await HybridRetriever.build(chunks, { embeddings, reranker }) };
}

// Boot only when executed directly (tests import buildServer instead).
if (process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('server.ts')) {
    const config = loadConfig();
    const deps = buildDeps(config);
    // Evidence retriever builds before the server so its routes register at startup;
    // corpus embedding is a one-time boot cost (seconds, offline-free with HashEmbeddings).
    const evidence = await buildEvidenceDeps(loadConfig());
    if (deps !== undefined && evidence !== undefined) {
        deps.evidence = evidence;
        // E.9: assemble the chat evidence lane — router tie-break + LLM composer over
        // the same retriever/ingestion the routes use. Keyless deployments skip it and
        // every turn takes the Week 1 loop (an explicit boot log says so below).
        if (config.ANTHROPIC_API_KEY !== undefined && deps.ingest !== undefined) {
            const routerModel = new LlmRouterModel(
                new AnthropicClient({
                    apiKey: config.ANTHROPIC_API_KEY,
                    model: config.ANTHROPIC_MODEL_CHAT,
                    maxTokens: 16,
                    idleTimeoutMs: 3_000,
                    totalTimeoutMs: 5_000,
                }),
                console,
            );
            const composer = new LlmAnswerComposer(
                new AnthropicClient({
                    apiKey: config.ANTHROPIC_API_KEY,
                    model: config.ANTHROPIC_MODEL_CHAT,
                    maxTokens: 1500,
                    idleTimeoutMs: 10_000,
                    totalTimeoutMs: 20_000,
                }),
                deps.chat.spendGuard,
                console,
            );
            // E.4: when Langfuse is keyed, graph events additionally become spans on a
            // correlation-scoped trace (adapter over the same logger seam — no new
            // instrumentation points; docs/w2/trace-example.md is the span skeleton).
            const graphLogBase = {
                info: (obj: Record<string, unknown>, msg: string) => console.log(JSON.stringify({ level: 'info', msg, ...obj })),
                warn: (obj: Record<string, unknown>, msg: string) => console.warn(JSON.stringify({ level: 'warn', msg, ...obj })),
            };
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
        { corpusRetriever: evidence !== undefined, dense: config.COHERE_API_KEY !== undefined ? 'cohere' : 'hash-offline' },
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
