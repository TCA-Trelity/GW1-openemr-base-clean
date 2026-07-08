// `npm run eval` entry point (S2.5): clears the ledger, runs the eval suite under its own
// vitest config, then ALWAYS regenerates docs/execution/eval-results.md — a failing eval
// still publishes its failing row before the process exits non-zero (CI uploads the doc
// as an artifact either way).
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESULTS_PATH } from './collector.js';
import { generateReport } from './report.js';

const sidecarDir = fileURLToPath(new URL('..', import.meta.url));

rmSync(RESULTS_PATH, { force: true });

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

if (total === 0) {
    console.error('eval run recorded no results — treating as failure');
}
process.exit(suiteFailed || failed > 0 || total === 0 ? 1 : 0);
