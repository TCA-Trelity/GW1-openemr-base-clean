// Eval result collector (S2.5). Every eval case records one EvalRecord into a JSONL
// ledger that eval/report.ts turns into docs/execution/eval-results.md. recordEval also
// enforces the verdict: a failing record throws, so the vitest run (and CI) fails on any
// eval failure while the ledger still carries the failing row for the published report.
// No vitest import here — report.ts and run.ts import this module outside a test run.
//
// Week 2 (REQ S4/R6, D.1): records carry a rubric `category` (eval/categories.ts) and an
// `enforce` tier. 'hard' (default, and forced for safety categories) throws on failure —
// any newly-failing case fails the suite. 'soft' records the failure without throwing;
// the category gate (eval/gate.ts) then applies the baseline math: >5% category drop vs
// the committed baseline, or a rate below the category threshold, fails the run instead.
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isSafetyCategory, type EvalCategory } from './categories.js';

// Difficulty tiers (CT2). REQUIRED on every record — deliberately compile-breaking for any
// call site that omits it (`npm run typecheck:eval` enforces), so a case can never slip in
// untagged. Reporting-only: the gate (eval/gate.ts) and baseline never read difficulty.
//   straightforward — clean input, expected happy path.
//   ambiguous       — requires judgment/disambiguation: multi-turn context, degraded
//                     scans, overlapping-document tie-breaks, nuanced phrasing.
//   edge-case       — adversarial or degenerate: injection, PHI canaries, empty record,
//                     cross-patient isolation, malformed model output, refusals.
export const EVAL_DIFFICULTIES = ['straightforward', 'ambiguous', 'edge-case'] as const;
export type EvalDifficulty = (typeof EVAL_DIFFICULTIES)[number];

export interface EvalRecord {
    /** Stable id, `<suite>.<case>` (e.g. `citation-validity-100.margaret-chen`). */
    id: string;
    /** One-line human description of what the case checks. */
    description: string;
    /** What is being measured (e.g. `verified_claims`, `structural check`). */
    metric: string;
    /** The observed value, formatted for the report table. */
    value: string | number;
    /** The acceptance threshold the value is judged against. */
    threshold: string | number;
    pass: boolean;
    /** Difficulty tier (CT2, required — see EVAL_DIFFICULTIES above). */
    difficulty: EvalDifficulty;
    /** Honest caveats surfaced in the report's notes section. */
    notes?: string;
    /** Rubric category (Week 2). Legacy suites map via eval/categories.ts when absent. */
    category?: EvalCategory;
    /**
     * 'hard' (default): a failing record throws, failing the suite on that case.
     * 'soft': the failure is recorded for the category gate's baseline math only.
     * Safety categories are always hard — 'soft' is ignored for them by design.
     */
    enforce?: 'hard' | 'soft';
}

export const RESULTS_PATH = fileURLToPath(new URL('./.results.jsonl', import.meta.url));

// ---- metrics side-channel (CT3) ----------------------------------------------------
// Quantitative measurements that ride ALONGSIDE a pass/fail record — never instead of
// one. First (and so far only) kind: per-golden retrieval rank, so the report can state
// hit rate and average rank from the actual result lists rather than inferring them from
// pass booleans. Reporting-only: the gate never reads this ledger.

export interface RetrievalRankMetric {
    kind: 'retrieval_rank';
    /** The EvalRecord id this measurement belongs to (`retrieval-grounded.golden-<id>`). */
    evalId: string;
    /** The document the golden expects. */
    expectedDoc: string;
    /** Ordered doc ids of the snippets the retriever actually returned (top-K window). */
    returnedDocs: string[];
    /** 1-based position of expectedDoc's first snippet in returnedDocs; null = not returned. */
    rank: number | null;
}

export type EvalMetric = RetrievalRankMetric;

export const METRICS_PATH = fileURLToPath(new URL('./.metrics.jsonl', import.meta.url));

export function recordMetric(metric: EvalMetric): void {
    appendFileSync(METRICS_PATH, `${JSON.stringify(metric)}\n`, 'utf8');
}

export function recordEval(record: EvalRecord): void {
    appendFileSync(RESULTS_PATH, `${JSON.stringify(record)}\n`, 'utf8');
    const safetyForcedHard = record.category !== undefined && isSafetyCategory(record.category);
    const hard = record.enforce !== 'soft' || safetyForcedHard;
    if (!record.pass && hard) {
        throw new Error(
            `eval failed — ${record.id}: ${record.metric} = ${String(record.value)} (threshold: ${String(record.threshold)})`,
        );
    }
}
