// LLM spend guardrails: pure per-call pricing, the llm_calls ledger, and the rolling
// 24h budget gate (SpendGuard) that the prep pipeline and routes enforce BEFORE any
// Anthropic call is made. Parameterized SQL exclusively, matching factStore.ts.

export interface LlmRates {
    /** USD per million input tokens (pinned Sonnet tier by default — see config.ts). */
    inputUsdPerMtok: number;
    /** USD per million output tokens. */
    outputUsdPerMtok: number;
}

export interface LlmCallUsage {
    model: string;
    inputTokens: number;
    outputTokens: number;
}

export interface LlmCallRecord extends LlmCallUsage {
    correlationId: string;
    /** What the call was for, e.g. 'prep_extraction' — the ledger's audit dimension. */
    purpose: string;
}

/** Pure pricing arithmetic: tokens times per-MTok rates, in USD. */
export function priceCall(call: LlmCallUsage, rates: LlmRates): number {
    return (call.inputTokens * rates.inputUsdPerMtok + call.outputTokens * rates.outputUsdPerMtok) / 1_000_000;
}

/** Thrown by assertBudget when the trailing-24h spend has reached the configured budget. */
export class BudgetExceededError extends Error {
    constructor(
        public readonly spentUsd: number,
        public readonly budgetUsd: number,
    ) {
        super(
            `llm daily budget exceeded: spent $${spentUsd.toFixed(4)} of $${budgetUsd.toFixed(2)} in the last 24h`,
        );
        this.name = 'BudgetExceededError';
    }
}

/** The GET /api/usage response shape. */
export interface UsageSummary {
    window: '24h';
    calls: number;
    input_tokens: number;
    output_tokens: number;
    est_cost_usd: number;
    budget_usd: number;
    remaining_usd: number;
}

/** The one query surface SpendGuard needs (pg Pool satisfies it; tests fake it). */
export interface SpendQuerier {
    query(text: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface SpendGuardOptions extends LlmRates {
    /** Rolling 24h ceiling in USD (config LLM_DAILY_BUDGET_USD). */
    dailyBudgetUsd: number;
}

// Aggregates are cast to float8 in SQL so pg hands back JS numbers (numeric/bigint
// otherwise arrive as strings); narrow anyway — a silent NaN would disable the budget.
function numberField(row: Record<string, unknown> | undefined, field: string): number {
    const value = row?.[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`llm_calls aggregate returned a non-numeric '${field}'`);
    }
    return value;
}

export class SpendGuard {
    constructor(
        private readonly db: SpendQuerier,
        private readonly options: SpendGuardOptions,
    ) {}

    /** Ledger write: one row per Anthropic call, priced at insert time. */
    async recordCall(call: LlmCallRecord): Promise<void> {
        await this.db.query(
            `INSERT INTO llm_calls (correlation_id, purpose, model, input_tokens, output_tokens, est_cost_usd)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                call.correlationId,
                call.purpose,
                call.model,
                call.inputTokens,
                call.outputTokens,
                priceCall(call, this.options),
            ],
        );
    }

    /** Estimated USD spent across all purposes in the trailing 24 hours. */
    async spentLastDay(): Promise<number> {
        // No user input reaches this statement; the window is a SQL literal.
        const result = await this.db.query(
            `SELECT COALESCE(SUM(est_cost_usd), 0)::float8 AS spent
             FROM llm_calls
             WHERE created_at > now() - interval '24 hours'`,
            [],
        );
        return numberField(result.rows[0], 'spent');
    }

    /** The gate: throws BudgetExceededError once trailing-24h spend reaches the budget. */
    async assertBudget(): Promise<void> {
        const spent = await this.spentLastDay();
        if (spent >= this.options.dailyBudgetUsd) {
            throw new BudgetExceededError(spent, this.options.dailyBudgetUsd);
        }
    }

    /** Trailing-24h totals for GET /api/usage. */
    async usageSummary(): Promise<UsageSummary> {
        const result = await this.db.query(
            `SELECT COUNT(*)::int AS calls,
                    COALESCE(SUM(input_tokens), 0)::float8 AS input_tokens,
                    COALESCE(SUM(output_tokens), 0)::float8 AS output_tokens,
                    COALESCE(SUM(est_cost_usd), 0)::float8 AS est_cost_usd
             FROM llm_calls
             WHERE created_at > now() - interval '24 hours'`,
            [],
        );
        const row = result.rows[0];
        const estCostUsd = numberField(row, 'est_cost_usd');
        return {
            window: '24h',
            calls: numberField(row, 'calls'),
            input_tokens: numberField(row, 'input_tokens'),
            output_tokens: numberField(row, 'output_tokens'),
            est_cost_usd: estCostUsd,
            budget_usd: this.options.dailyBudgetUsd,
            remaining_usd: Math.max(0, this.options.dailyBudgetUsd - estCostUsd),
        };
    }
}
