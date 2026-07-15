// `npm run eval` entry point (S2.5): clears the ledger, runs the eval suite under its own
// vitest config, then ALWAYS regenerates docs/execution/eval-results.md — a failing eval
// still publishes its failing row before the process exits non-zero (CI uploads the doc
// as an artifact either way).
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { METRICS_PATH, RESULTS_PATH } from './collector.js';
import { applyGate, formatGateReport, readBaseline, readLedgerRecords } from './gate.js';
import { generateReport } from './report.js';

const sidecarDir = fileURLToPath(new URL('..', import.meta.url));

rmSync(RESULTS_PATH, { force: true });
rmSync(METRICS_PATH, { force: true });

const vitest = spawnSync(
    process.execPath,
    [
        join(sidecarDir, 'node_modules', 'vitest', 'vitest.mjs'),
        'run',
        '--config',
        join(sidecarDir, 'eval', 'vitest.config.ts'),
    ],
    { cwd: sidecarDir, stdio: 'inherit' },
);
const suiteFailed = vitest.status !== 0;

const { total, failed } = generateReport({ suiteFailed });
console.log(`\neval report: ${total - failed}/${total} evals passed — docs/execution/eval-results.md regenerated`);

// Week 2 category gate (D.1): tiered baseline comparison over the same ledger. Runs even
// when the suite already failed, so the category view is always printed; a missing
// baseline fails the run (the gate is not optional equipment).
let gateFailed = false;
const baseline = readBaseline();
if (baseline === undefined) {
    console.error('category gate: eval/baseline.json missing — run `npm run eval:baseline` and commit it');
    gateFailed = true;
} else {
    const gate = applyGate(readLedgerRecords(), baseline);
    console.log(formatGateReport(gate, baseline));
    gateFailed = !gate.pass;
    // G5 `eval_run_outcome`: one structured event per eval run, same JSON shape as the
    // service log stream, so run outcomes are greppable alongside runtime events.
    console.log(
        JSON.stringify({
            level: 'info',
            msg: 'eval_run_outcome',
            total,
            passed: total - failed,
            gate: gate.pass ? 'pass' : 'fail',
            categories: Object.fromEntries(
                gate.verdicts.map((verdict) => [
                    verdict.category,
                    verdict.status === 'not-measured' ? 'not-measured' : `${verdict.stats.passed}/${verdict.stats.total}`,
                ]),
            ),
        }),
    );
}

if (total === 0) {
    console.error('eval run recorded no results — treating as failure');
}
process.exit(suiteFailed || failed > 0 || total === 0 || gateFailed ? 1 : 0);
