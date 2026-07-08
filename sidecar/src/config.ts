// Environment configuration, parsed once at boot via Zod (parse, don't validate).
// Dependencies may be absent in dev/test; /ready reports each as not_configured
// rather than crashing, so the scaffold runs before every service exists.
import { z } from 'zod';

const EnvSchema = z.object({
    PORT: z.coerce.number().int().positive().default(8080),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    OPENEMR_BASE_URL: z.string().url().optional(),
    // EHR FHIR-read client (E2 sync). System client_credentials — system role is permitted
    // on /fhir/ routes; sync engages only when base URL + client id + private key are all set.
    OPENEMR_CLIENT_ID: z.string().min(1).optional(),
    OPENEMR_PRIVATE_KEY: z.string().min(1).optional(),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    // Haiku 4.5 for all prep extraction (user call, 2026-07-08): no default thinking to
    // spiral, 1/5 the Sonnet price, and per-document calls fit comfortably in its window.
    ANTHROPIC_MODEL_PREP: z.string().min(1).default('claude-haiku-4-5'),
    ANTHROPIC_MODEL_CHAT: z.string().min(1).default('claude-haiku-4-5'),
    // Chat replies are short by design; a tight ceiling caps worst-case turn cost.
    LLM_CHAT_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(1024),
    LANGFUSE_HOST: z.string().url().optional(),
    // Scan-image directory for /api/images (defaults to the baked-in seed/images).
    SCAN_IMAGES_DIR: z.string().min(1).optional(),
    // Tracing engages only when host + both keys are present; otherwise a silent no-op.
    LANGFUSE_PUBLIC_KEY: z.string().min(1).optional(),
    LANGFUSE_SECRET_KEY: z.string().min(1).optional(),
    DATABASE_URL: z.string().min(1).optional(),
    REDIS_URL: z.string().min(1).optional(),
    // LLM spend guardrails. The per-MTok rates price each call into the llm_calls ledger
    // and default to the pinned Haiku 4.5 tier ($1 in / $5 out per million tokens) —
    // override via env when pricing or the pinned model changes.
    LLM_DAILY_BUDGET_USD: z.coerce.number().positive().default(5),
    // Per-call output ceiling. Extraction is per-document now, so one call's output is
    // bounded by one document's facts — 8K is generous headroom, and hitting it means
    // something degenerate (fail fast + one fresh retry, never feedback-retry truncation).
    LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(8192),
    LLM_MAX_CONCURRENT_PREPS: z.coerce.number().int().positive().default(2),
    PREP_REUSE_WINDOW_MINUTES: z.coerce.number().int().nonnegative().default(10),
    LLM_INPUT_USD_PER_MTOK: z.coerce.number().positive().default(1),
    LLM_OUTPUT_USD_PER_MTOK: z.coerce.number().positive().default(5),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    return EnvSchema.parse(env);
}
