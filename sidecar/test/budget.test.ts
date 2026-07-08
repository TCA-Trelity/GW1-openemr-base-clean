// SpendGuard unit tests: pure pricing arithmetic plus the budget gate / llm_calls ledger /
// usage summary over a fake pg querier — no Postgres, no live Anthropic. Each test names
// the failure mode it guards.
import { describe, expect, it } from 'vitest';
import { BudgetExceededError, priceCall, SpendGuard, type SpendQuerier } from '../src/prep/budget.js';

const RATES = { inputUsdPerMtok: 3, outputUsdPerMtok: 15 };

function fakeQuerier(rows: Record<string, unknown>[]) {
    const calls: { text: string; values: unknown[] }[] = [];
    const querier: SpendQuerier = {
        query: async (text, values) => {
            calls.push({ text, values });
            return { rows };
        },
    };
    return { querier, calls };
}

describe('priceCall', () => {
    // Guards: the cost formula drifting off the pinned Sonnet tier arithmetic —
    // 30K in at $3/MTok ($0.09) + 8K out at $15/MTok ($0.12) = $0.21.
    it('prices 30000 input + 8000 output tokens at $0.21 on the default rates', () => {
        expect(
            priceCall({ model: 'claude-sonnet-5', inputTokens: 30_000, outputTokens: 8_000 }, RATES),
        ).toBeCloseTo(0.21, 10);
    });

    // Guards: transposing the two rates — both are bare numbers, so only a test catches it.
    it('applies the input rate to input tokens and the output rate to output tokens', () => {
        const rates = { inputUsdPerMtok: 1, outputUsdPerMtok: 10 };
        expect(priceCall({ model: 'm', inputTokens: 1_000_000, outputTokens: 0 }, rates)).toBeCloseTo(1, 10);
        expect(priceCall({ model: 'm', inputTokens: 0, outputTokens: 1_000_000 }, rates)).toBeCloseTo(10, 10);
    });
});

describe('SpendGuard', () => {
    const options = { dailyBudgetUsd: 5, ...RATES };

    // Guards: the gate leaking spend past the ceiling — AT the budget must already throw.
    it('assertBudget throws BudgetExceededError when spend equals the budget', async () => {
        const { querier } = fakeQuerier([{ spent: 5 }]);
        const guard = new SpendGuard(querier, options);
        await expect(guard.assertBudget()).rejects.toThrow(BudgetExceededError);
    });

    // Guards: the error dropping the numbers the route's 429 body carries to the caller.
    it('assertBudget carries the spent and budget amounts when over budget', async () => {
        const { querier } = fakeQuerier([{ spent: 6.5 }]);
        const guard = new SpendGuard(querier, options);
        const error = await guard.assertBudget().then(
            () => null,
            (thrown: unknown) => thrown,
        );
        expect(error).toBeInstanceOf(BudgetExceededError);
        expect((error as BudgetExceededError).spentUsd).toBe(6.5);
        expect((error as BudgetExceededError).budgetUsd).toBe(5);
        expect((error as BudgetExceededError).message).toContain('budget exceeded');
    });

    // Guards: the gate blocking preps while budget actually remains.
    it('assertBudget resolves when spend is under the budget', async () => {
        const { querier } = fakeQuerier([{ spent: 4.99 }]);
        const guard = new SpendGuard(querier, options);
        await expect(guard.assertBudget()).resolves.toBeUndefined();
    });

    // Guards: a string/NaN aggregate silently disabling the gate (NaN >= budget is false).
    it('spentLastDay rejects a non-numeric aggregate instead of returning NaN', async () => {
        const { querier } = fakeQuerier([{ spent: 'not-a-number' }]);
        const guard = new SpendGuard(querier, options);
        await expect(guard.spentLastDay()).rejects.toThrow(/non-numeric/);
    });

    // Guards: the ledger write drifting off the llm_calls columns or interpolating values.
    it('recordCall inserts a parameterized llm_calls row with the priced cost', async () => {
        const { querier, calls } = fakeQuerier([]);
        const guard = new SpendGuard(querier, options);
        await guard.recordCall({
            correlationId: 'corr-1',
            purpose: 'prep_extraction',
            model: 'claude-sonnet-5',
            inputTokens: 30_000,
            outputTokens: 8_000,
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]!.text).toContain('INSERT INTO llm_calls');
        expect(calls[0]!.text).toContain('$6'); // all six columns bound, none interpolated
        expect(calls[0]!.values.slice(0, 5)).toEqual(['corr-1', 'prep_extraction', 'claude-sonnet-5', 30_000, 8_000]);
        expect(calls[0]!.values[5]).toBeCloseTo(0.21, 10);
    });

    // Guards: the GET /api/usage contract — 24h window, totals, and remaining arithmetic.
    it('usageSummary returns the 24h window totals with the remaining budget', async () => {
        const { querier, calls } = fakeQuerier([
            { calls: 3, input_tokens: 90_000, output_tokens: 24_000, est_cost_usd: 0.63 },
        ]);
        const guard = new SpendGuard(querier, options);
        const summary = await guard.usageSummary();
        expect(summary).toMatchObject({
            window: '24h',
            calls: 3,
            input_tokens: 90_000,
            output_tokens: 24_000,
            est_cost_usd: 0.63,
            budget_usd: 5,
        });
        expect(summary.remaining_usd).toBeCloseTo(4.37, 10);
        expect(calls[0]!.text).toContain("interval '24 hours'");
    });

    // Guards: a blown budget reporting negative remaining dollars to the panel.
    it('usageSummary clamps remaining_usd at zero when over budget', async () => {
        const { querier } = fakeQuerier([
            { calls: 40, input_tokens: 1, output_tokens: 1, est_cost_usd: 7.2 },
        ]);
        const guard = new SpendGuard(querier, options);
        const summary = await guard.usageSummary();
        expect(summary.remaining_usd).toBe(0);
    });
});
