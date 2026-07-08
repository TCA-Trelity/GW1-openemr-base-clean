// Environment configuration, parsed once at boot via Zod (parse, don't validate).
// Dependencies may be absent in dev/test; /ready reports each as not_configured
// rather than crashing, so the scaffold runs before every service exists.
import { z } from 'zod';

const EnvSchema = z.object({
    PORT: z.coerce.number().int().positive().default(8080),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    OPENEMR_BASE_URL: z.string().url().optional(),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    ANTHROPIC_MODEL_PREP: z.string().min(1).default('claude-sonnet-5'),
    LANGFUSE_HOST: z.string().url().optional(),
    // Tracing engages only when host + both keys are present; otherwise a silent no-op.
    LANGFUSE_PUBLIC_KEY: z.string().min(1).optional(),
    LANGFUSE_SECRET_KEY: z.string().min(1).optional(),
    DATABASE_URL: z.string().min(1).optional(),
    REDIS_URL: z.string().min(1).optional(),
    // LLM spend guardrails. The per-MTok rates price each call into the llm_calls ledger
    // and default to the pinned Sonnet tier (ANTHROPIC_MODEL_PREP: $3 in / $15 out per
    // million tokens) — override via env when pricing or the pinned model changes.
    LLM_DAILY_BUDGET_USD: z.coerce.number().positive().default(5),
    // Streaming output ceiling per call (sonnet-5 allows 128K; extraction re-quotes source
    // text per citation, so the old 16K non-streaming cap truncated real patients mid-JSON).
    LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(64000),
    LLM_MAX_CONCURRENT_PREPS: z.coerce.number().int().positive().default(2),
    PREP_REUSE_WINDOW_MINUTES: z.coerce.number().int().nonnegative().default(10),
    LLM_INPUT_USD_PER_MTOK: z.coerce.number().positive().default(3),
    LLM_OUTPUT_USD_PER_MTOK: z.coerce.number().positive().default(15),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    return EnvSchema.parse(env);
}
