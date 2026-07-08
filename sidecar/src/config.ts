// Environment configuration, parsed once at boot via Zod (parse, don't validate).
// Dependencies may be absent in dev/test; /ready reports each as not_configured
// rather than crashing, so the scaffold runs before every service exists.
import { z } from 'zod';

const EnvSchema = z.object({
    PORT: z.coerce.number().int().positive().default(8080),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    OPENEMR_BASE_URL: z.string().url().optional(),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    LANGFUSE_HOST: z.string().url().optional(),
    DATABASE_URL: z.string().min(1).optional(),
    REDIS_URL: z.string().min(1).optional(),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    return EnvSchema.parse(env);
}
