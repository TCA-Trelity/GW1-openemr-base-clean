// Sidecar entrypoint. Every request gets a correlation ID (honoring an incoming
// x-correlation-id) that appears on every log line, response header, tool call and
// LLM interaction, so a full trace reconstructs from logs alone (project brief
// engineering requirement). Store-backed deps wire in only when DATABASE_URL is set.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { Langfuse } from 'langfuse';
import { ChatService } from './chat/chat.js';
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
import { AnthropicClient } from './prep/anthropic.js';
import { SpendGuard } from './prep/budget.js';
import { FactExtractor } from './prep/extraction.js';
import { StoreDocumentSource } from './prep/sources.js';
import { registerChatRoutes, type ChatRouteDeps } from './routes/chat.js';
import { registerEhrRoutes, type EhrRouteDeps } from './routes/ehr.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerOverviewRoutes, type OverviewRouteDeps } from './routes/overview.js';
import { registerPrepRoutes, type PrepRouteDeps } from './routes/prep.js';
import { createPool, FactStore } from './store/index.js';
import { migrate } from './store/migrate.js';

export interface AppDeps {
    /** Real readiness probe for /ready (SELECT 1 through the pool). */
    checkPostgres: () => Promise<void>;
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
}

// Store-backed dependencies exist only when DATABASE_URL is configured; without it the
// scaffold still boots and the prep routes answer 503 store_not_configured.
export function buildDeps(config: Config): AppDeps | undefined {
    if (config.DATABASE_URL === undefined) {
        return undefined;
    }
    const pool = createPool(config);
    const store = new FactStore(pool);
    const extractor = new FactExtractor(
        new AnthropicClient({
            apiKey: config.ANTHROPIC_API_KEY ?? '',
            model: config.ANTHROPIC_MODEL_PREP,
            maxTokens: config.LLM_MAX_OUTPUT_TOKENS,
        }),
    );
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

    return {
        checkPostgres: async () => {
            await pool.query('SELECT 1');
        },
        runMigrations: () => migrate(pool),
        prep: {
            store,
            // Tier-1 demo path reads the seeded fact store; FhirDocumentSource swaps in
            // once the live FHIR client credentials land with S1.9.
            source: new StoreDocumentSource(store, pool),
            extractor,
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
            ),
            spendGuard,
        },
        auth: { verifier, mode: authMode },
        authRoutes: {
            ...(devTokens !== undefined ? { devTokens } : {}),
            patientExists: async (patientId) => (await store.getPatient(patientId)) !== null,
            mode: authMode,
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

    registerHealthRoutes(app, config, deps === undefined ? undefined : { checkPostgres: deps.checkPostgres });
    registerAuthRoutes(app, deps?.authRoutes);
    registerPrepRoutes(app, deps?.prep);
    registerOverviewRoutes(app, deps?.overview);
    registerChatRoutes(app, deps?.chat);
    registerEhrRoutes(app, deps?.ehr);

    // Scan images (S2.13): image_records carry a storage_key; the panel loads
    // /api/images/<storage_key>. fastify-static owns traversal safety.
    const imagesDir = config.SCAN_IMAGES_DIR ?? fileURLToPath(new URL('../seed/images/', import.meta.url));
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

// Boot only when executed directly (tests import buildServer instead).
if (process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('server.ts')) {
    const config = loadConfig();
    const deps = buildDeps(config);
    const app = buildServer(config, deps);
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
