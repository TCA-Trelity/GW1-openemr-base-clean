// Sidecar test scope: panel/ has its own vitest (jsdom); keep it out of this run.
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['test/**/*.test.ts'],
    },
});
