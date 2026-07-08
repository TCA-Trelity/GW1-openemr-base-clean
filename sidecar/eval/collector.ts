// Eval result collector (S2.5). Every eval case records one EvalRecord into a JSONL
// ledger that eval/report.ts turns into docs/execution/eval-results.md. recordEval also
// enforces the verdict: a failing record throws, so the vitest run (and CI) fails on any
// eval failure while the ledger still carries the failing row for the published report.
// No vitest import here — report.ts and run.ts import this module outside a test run.
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
    /** Honest caveats surfaced in the report's notes section. */
    notes?: string;
}

export const RESULTS_PATH = fileURLToPath(new URL('./.results.jsonl', import.meta.url));

export function recordEval(record: EvalRecord): void {
    appendFileSync(RESULTS_PATH, `${JSON.stringify(record)}\n`, 'utf8');
    if (!record.pass) {
        throw new Error(
            `eval failed — ${record.id}: ${record.metric} = ${String(record.value)} (threshold: ${String(record.threshold)})`,
        );
    }
}
