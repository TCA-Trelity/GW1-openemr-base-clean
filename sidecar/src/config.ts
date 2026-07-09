// Environment configuration, parsed once at boot via Zod (parse, don't validate).
// Dependencies may be absent in dev/test; /ready reports each as not_configured
// rather than crashing, so the scaffold runs before every service exists.
//
// BOOT RESILIENCE: a single malformed env var must never crash the process. Every field
// `.catch(...)`es its own parse failure — an invalid value logs a warning and falls back to a
// safe default (or "unset"), so the feature that value controls is disabled rather than the
// whole app taken down. `loadConfig` therefore never throws; the operator sees exactly which
// variable was ignored in the logs. This is what keeps a typo'd OPENEMR_BASE_URL / AUTH_MODE /
// DEV_LOGIN_SECRET from restart-looping the deployment.
import { z } from 'zod';

/** Zod `.catch` handler: log which variable was invalid, then fall back to `fallback`. */
function orWarn<T>(fallback: T, variable: string): (ctx: { error: z.ZodError }) => T {
    return (ctx) => {
        const issues = ctx.error.issues.map((issue) => issue.message).join('; ');
        console.warn(`[config] ${variable} is invalid and was ignored (${issues}); using fallback`);
        return fallback;
    };
}

const EnvSchema = z.object({
    PORT: z.coerce.number().int().positive().default(8080).catch(orWarn(8080, 'PORT')),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development').catch(orWarn('development' as const, 'NODE_ENV')),
    OPENEMR_BASE_URL: z.string().url().optional().catch(orWarn(undefined, 'OPENEMR_BASE_URL')),
    // EHR FHIR-read client (E2 sync). System client_credentials — system role is permitted
    // on /fhir/ routes; sync engages only when base URL + client id + private key are all set.
    OPENEMR_CLIENT_ID: z.string().min(1).optional().catch(orWarn(undefined, 'OPENEMR_CLIENT_ID')),
    OPENEMR_CLIENT_KEY: z.string().min(1).optional().catch(orWarn(undefined, 'OPENEMR_CLIENT_KEY')),
    ANTHROPIC_API_KEY: z.string().min(1).optional().catch(orWarn(undefined, 'ANTHROPIC_API_KEY')),
    // Haiku 4.5 for all prep extraction (user call, 2026-07-08): no default thinking to
    // spiral, 1/5 the Sonnet price, and per-document calls fit comfortably in its window.
    ANTHROPIC_MODEL_PREP: z.string().min(1).default('claude-haiku-4-5').catch(orWarn('claude-haiku-4-5', 'ANTHROPIC_MODEL_PREP')),
    ANTHROPIC_MODEL_CHAT: z.string().min(1).default('claude-haiku-4-5').catch(orWarn('claude-haiku-4-5', 'ANTHROPIC_MODEL_CHAT')),
    // Chat replies are short by design; a tight ceiling caps worst-case turn cost.
    LLM_CHAT_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(1024).catch(orWarn(1024, 'LLM_CHAT_MAX_OUTPUT_TOKENS')),
    LANGFUSE_HOST: z.string().url().optional().catch(orWarn(undefined, 'LANGFUSE_HOST')),
    // Scan-image directory for /api/images (defaults to the baked-in seed/images).
    SCAN_IMAGES_DIR: z.string().min(1).optional().catch(orWarn(undefined, 'SCAN_IMAGES_DIR')),
    // Tracing engages only when host + both keys are present; otherwise a silent no-op.
    LANGFUSE_PUBLIC_KEY: z.string().min(1).optional().catch(orWarn(undefined, 'LANGFUSE_PUBLIC_KEY')),
    LANGFUSE_SECRET_KEY: z.string().min(1).optional().catch(orWarn(undefined, 'LANGFUSE_SECRET_KEY')),
    DATABASE_URL: z.string().min(1).optional().catch(orWarn(undefined, 'DATABASE_URL')),
    REDIS_URL: z.string().min(1).optional().catch(orWarn(undefined, 'REDIS_URL')),
    // LLM spend guardrails. The per-MTok rates price each call into the llm_calls ledger
    // and default to the pinned Haiku 4.5 tier ($1 in / $5 out per million tokens) —
    // override via env when pricing or the pinned model changes.
    LLM_DAILY_BUDGET_USD: z.coerce.number().positive().default(5).catch(orWarn(5, 'LLM_DAILY_BUDGET_USD')),
    // Per-call output ceiling. Extraction is per-document now, so one call's output is
    // bounded by one document's facts — 8K is generous headroom, and hitting it means
    // something degenerate (fail fast + one fresh retry, never feedback-retry truncation).
    LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(8192).catch(orWarn(8192, 'LLM_MAX_OUTPUT_TOKENS')),
    LLM_MAX_CONCURRENT_PREPS: z.coerce.number().int().positive().default(2).catch(orWarn(2, 'LLM_MAX_CONCURRENT_PREPS')),
    PREP_REUSE_WINDOW_MINUTES: z.coerce.number().int().nonnegative().default(10).catch(orWarn(10, 'PREP_REUSE_WINDOW_MINUTES')),
    LLM_INPUT_USD_PER_MTOK: z.coerce.number().positive().default(1).catch(orWarn(1, 'LLM_INPUT_USD_PER_MTOK')),
    LLM_OUTPUT_USD_PER_MTOK: z.coerce.number().positive().default(5).catch(orWarn(5, 'LLM_OUTPUT_USD_PER_MTOK')),
    // Authorization (Wave AZ). 'off' attaches a Principal when a token is present but never
    // rejects (preserves the live demo before the panel ships tokens); 'enforced' turns on the
    // PEP: 401 unauthenticated, 403 cross-patient, 403 role-capability. Enforcement engages only
    // when a token path below is also configured. A bad value falls back to the safe 'off'.
    AUTH_MODE: z.enum(['off', 'enforced']).default('off').catch(orWarn('off' as const, 'AUTH_MODE')),
    // Shared secret for sidecar-minted dev tokens (AZ4 demo/grading path). Its presence enables
    // POST /api/dev-login + HS256 verification. Require a strong secret so demo tokens are not
    // guessable; keep it out of the repo (Railway variable only). Too-short -> dev-login stays off.
    DEV_LOGIN_SECRET: z.string().min(16).optional().catch(orWarn(undefined, 'DEV_LOGIN_SECRET')),
    DEV_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(3600).catch(orWarn(3600, 'DEV_TOKEN_TTL_SECONDS')),
    // OAuth site under /oauth2/<site>/ (OpenEMR default is 'default'); shapes the SMART issuer,
    // JWKS, and introspection URLs the resource-server verifier uses.
    OPENEMR_OAUTH_SITE: z.string().min(1).default('default').catch(orWarn('default', 'OPENEMR_OAUTH_SITE')),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    // Every field catches its own failure, so parse cannot throw on a bad value. The extra
    // guard is a last resort: if some future field forgets `.catch`, boot on defaults and log
    // rather than crash-loop the deployment.
    try {
        return EnvSchema.parse(env);
    } catch (error) {
        console.error('[config] configuration failed to parse; booting on defaults', error);
        return EnvSchema.parse({});
    }
}
