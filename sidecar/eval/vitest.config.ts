// Eval suite scope (S2.5): only eval/**/*.eval.ts, and only under this config — the
// sidecar's `npm test` (vitest.config.ts, test/**/*.test.ts) never sweeps evals, exactly
// as the panel keeps its jsdom suite out of the sidecar run. Files run sequentially so
// the JSONL result ledger appends in a deterministic order for the published report.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    root: fileURLToPath(new URL('..', import.meta.url)),
    test: {
        include: ['eval/**/*.eval.ts'],
        fileParallelism: false,
    },
});
