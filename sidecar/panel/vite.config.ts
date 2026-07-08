// Vite + Vitest config: dev proxies /api to the sidecar on :8080; tests run in jsdom.
/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    server: {
        proxy: { '/api': 'http://localhost:8080' },
    },
    build: { outDir: 'dist' },
    test: {
        environment: 'jsdom',
        setupFiles: './src/test/setup.ts',
    },
});
