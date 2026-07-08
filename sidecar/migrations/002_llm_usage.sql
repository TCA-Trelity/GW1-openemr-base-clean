-- 002_llm_usage.sql — LLM spend ledger (cost guardrails). One row per Anthropic call,
-- priced at insert time from the configured per-MTok rates; SpendGuard sums the trailing
-- 24h window against LLM_DAILY_BUDGET_USD. Operational table like prep_runs: intentionally
-- not FK-bound to patients, survives wipePatient/wipeAll rebuilds as the audit trail.

CREATE TABLE llm_calls (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    correlation_id text NOT NULL,
    purpose        text NOT NULL,
    model          text NOT NULL,
    input_tokens   int NOT NULL,
    output_tokens  int NOT NULL,
    est_cost_usd   numeric(10,6) NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);

-- The budget gate and usage summary both scan the trailing 24h window.
CREATE INDEX llm_calls_created_at_idx ON llm_calls (created_at);
