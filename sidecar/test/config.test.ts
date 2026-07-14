// Config resilience (boot hardening): a single malformed env var must degrade to a safe
// default with a warning — NEVER throw and crash-loop the deployment. Each test names the
// misconfiguration it tolerates.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('loadConfig boot resilience', () => {
    // Failure mode: a URL var missing its scheme throws and the whole process exits on boot.
    it('ignores a malformed OPENEMR_BASE_URL instead of throwing', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const config = loadConfig({ NODE_ENV: 'test', OPENEMR_BASE_URL: 'gw1.up.railway.app' });
        expect(config.OPENEMR_BASE_URL).toBeUndefined(); // feature disabled, app still boots
    });

    // Failure mode: a mistyped AUTH_MODE (true/on/enabled) crashes boot.
    it('falls back to off for an invalid AUTH_MODE', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'enabled' }).AUTH_MODE).toBe('off');
        expect(loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'enforced' }).AUTH_MODE).toBe('enforced');
    });

    // Failure mode: a too-short DEV_LOGIN_SECRET crashes boot instead of just disabling dev-login.
    it('drops a too-short DEV_LOGIN_SECRET', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(loadConfig({ NODE_ENV: 'test', DEV_LOGIN_SECRET: 'short' }).DEV_LOGIN_SECRET).toBeUndefined();
        expect(loadConfig({ NODE_ENV: 'test', DEV_LOGIN_SECRET: 'a-long-enough-secret-value' }).DEV_LOGIN_SECRET).toBe(
            'a-long-enough-secret-value',
        );
    });

    // Failure mode: a non-numeric override for a coerced number crashes boot.
    it('falls back to the default for a non-numeric budget', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(loadConfig({ NODE_ENV: 'test', LLM_DAILY_BUDGET_USD: 'lots' }).LLM_DAILY_BUDGET_USD).toBe(5);
    });

    // Failure mode: a malformed LANGFUSE_HOST crashes boot rather than disabling tracing.
    it('ignores a malformed LANGFUSE_HOST', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(loadConfig({ NODE_ENV: 'test', LANGFUSE_HOST: 'not a url' }).LANGFUSE_HOST).toBeUndefined();
    });

    // Failure mode: several bad vars at once still crash. loadConfig must survive all of them,
    // warn per variable, and keep every VALID value.
    it('survives multiple invalid vars at once and keeps the valid ones', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const config = loadConfig({
            NODE_ENV: 'test',
            OPENEMR_BASE_URL: 'nope',
            AUTH_MODE: 'yes',
            DEV_LOGIN_SECRET: 'x',
            DEV_TOKEN_TTL_SECONDS: 'soon',
            DATABASE_URL: 'postgres://valid/url',
        });
        expect(config.OPENEMR_BASE_URL).toBeUndefined();
        expect(config.AUTH_MODE).toBe('off');
        expect(config.DEV_LOGIN_SECRET).toBeUndefined();
        expect(config.DEV_TOKEN_TTL_SECONDS).toBe(3600);
        expect(config.DATABASE_URL).toBe('postgres://valid/url'); // valid value preserved
        expect(warn.mock.calls.length).toBeGreaterThanOrEqual(4); // one warning per bad var
    });

    // Failure mode (Wave 0.4): a bad Week 2 retrieval/tracing var must disable that feature,
    // never crash boot — and LangSmith must stay off unless explicitly enabled (demo fence).
    it('falls back safely on invalid Week 2 vars and keeps LangSmith off by default', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const config = loadConfig({
            RETRIEVER_DENSE_BACKEND: 'qdrant',
            LANGSMITH_TRACING: 'yes-please',
            COHERE_API_KEY: '',
        });
        warn.mockRestore();
        expect(config.RETRIEVER_DENSE_BACKEND).toBe('pgvector');
        expect(config.LANGSMITH_TRACING).toBe('false');
        expect(config.COHERE_API_KEY).toBeUndefined();
        expect(config.COHERE_EMBED_MODEL).toBe('embed-english-v3.0');
        expect(config.COHERE_RERANK_MODEL).toBe('rerank-english-v3.0');
    });

    // Failure mode: a fully valid config regresses (hardening changed a real value).
    it('passes valid values through unchanged', () => {
        const config = loadConfig({
            NODE_ENV: 'production',
            AUTH_MODE: 'enforced',
            OPENEMR_BASE_URL: 'https://ehr.example.com',
            LLM_DAILY_BUDGET_USD: '12',
        });
        expect(config.NODE_ENV).toBe('production');
        expect(config.AUTH_MODE).toBe('enforced');
        expect(config.OPENEMR_BASE_URL).toBe('https://ehr.example.com');
        expect(config.LLM_DAILY_BUDGET_USD).toBe(12);
    });
});
