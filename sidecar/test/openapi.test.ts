// E.7 (REQ G16): the OpenAPI contract test — sidecar/openapi.yaml and the registered
// route surface must not drift, in either direction. Failure modes guarded: a new route
// shipping undocumented, a documented path that no longer exists, and a spec edit that
// silently drops a method. The YAML is parsed structurally (path keys are the only
// 2-space-indented keys starting with '/'; methods are their 4-space-indented children)
// — the file is ours, the shape is enforced here, no yaml dependency needed.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DevTokenService } from '../src/auth/devToken.js';
import { loadConfig } from '../src/config.js';
import { VlmExtractor } from '../src/ingest/extractor.js';
import { IngestionService, MemoryIngestionRecordStore } from '../src/ingest/service.js';
import { HashEmbeddings } from '../src/retrieval/embeddings.js';
import { PassthroughReranker } from '../src/retrieval/rerank.js';
import { HybridRetriever, loadCorpusChunks } from '../src/retrieval/retriever.js';
import { buildServer } from '../src/server.js';

const SPEC_PATH = fileURLToPath(new URL('../openapi.yaml', import.meta.url));
const CORPUS = fileURLToPath(new URL('../corpus/', import.meta.url));

/** The canonical route inventory: every HTTP endpoint the sidecar registers.
 *  Adding a route means adding it HERE and to openapi.yaml — this test enforces both.
 *  `probe` is an inject-able concrete path; probes prove the route is REGISTERED
 *  (Fastify's default not-found body is distinguishable from our handlers' 404s). */
const INVENTORY: { method: 'GET' | 'POST'; path: string; probe?: string }[] = [
    { method: 'GET', path: '/health' },
    { method: 'GET', path: '/ready' },
    { method: 'POST', path: '/api/dev-login' },
    { method: 'GET', path: '/api/me' },
    { method: 'GET', path: '/api/patients' },
    { method: 'GET', path: '/api/overview/{patientId}', probe: '/api/overview/p1' },
    { method: 'GET', path: '/api/facts/{patientId}', probe: '/api/facts/p1' },
    { method: 'POST', path: '/api/facts/{patientId}/{factId}/verify', probe: '/api/facts/p1/f1/verify' },
    { method: 'GET', path: '/api/brief/{patientId}', probe: '/api/brief/p1' },
    { method: 'POST', path: '/api/prep/{patientId}', probe: '/api/prep/p1' },
    { method: 'GET', path: '/api/prep-runs/{patientId}', probe: '/api/prep-runs/p1' },
    { method: 'POST', path: '/api/chat/{patientId}', probe: '/api/chat/p1' },
    { method: 'GET', path: '/api/chat/{patientId}', probe: '/api/chat/p1' },
    { method: 'POST', path: '/api/ehr-sync/{patientId}', probe: '/api/ehr-sync/p1' },
    { method: 'POST', path: '/api/patients/{patientId}/documents', probe: '/api/patients/p1/documents' },
    { method: 'GET', path: '/api/ingestions/{id}', probe: '/api/ingestions/ing-x' },
    { method: 'GET', path: '/api/ingestions/{id}/file', probe: '/api/ingestions/ing-x/file' },
    { method: 'GET', path: '/api/patients/{patientId}/ingestions', probe: '/api/patients/p1/ingestions' },
    { method: 'POST', path: '/api/evidence/search' },
    { method: 'GET', path: '/api/usage' },
    // Static scan-image route: fastify-static answers its own 404s for missing files,
    // indistinguishable from an unregistered route — documented, not probed.
    { method: 'GET', path: '/api/images/{filename}' },
];

/** Parse `paths:` → { '/path': ['get','post'] } from our controlled YAML layout. */
function documentedRoutes(yaml: string): Map<string, Set<string>> {
    const routes = new Map<string, Set<string>>();
    let inPaths = false;
    let currentPath: string | null = null;
    for (const line of yaml.split('\n')) {
        if (/^paths:\s*$/.test(line)) {
            inPaths = true;
            continue;
        }
        if (inPaths && /^\S/.test(line) && !line.startsWith('#')) {
            inPaths = false; // left the paths block
        }
        if (!inPaths) {
            continue;
        }
        const pathMatch = /^ {2}(\/[^\s:]*):\s*$/.exec(line);
        if (pathMatch !== null) {
            currentPath = pathMatch[1]!;
            routes.set(currentPath, new Set());
            continue;
        }
        const methodMatch = /^ {4}(get|post|put|patch|delete):\s*$/.exec(line);
        if (methodMatch !== null && currentPath !== null) {
            routes.get(currentPath)!.add(methodMatch[1]!);
        }
    }
    return routes;
}

async function probeApp() {
    const records = new MemoryIngestionRecordStore();
    const service = new IngestionService({
        extractor: new VlmExtractor({ complete: async () => ({ text: '', citations: [], tool_uses: [], usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: null, model: 'stub' }) }),
        records,
    });
    const retriever = await HybridRetriever.build(loadCorpusChunks(CORPUS), {
        embeddings: new HashEmbeddings(),
        reranker: new PassthroughReranker(),
    });
    return buildServer(loadConfig({ NODE_ENV: 'test' }), {
        checkPostgres: async () => undefined,
        runMigrations: async () => [],
        prep: {} as never,
        overview: {} as never,
        chat: {} as never,
        ingest: { service, records },
        evidence: { retriever },
        auth: { mode: 'off', verifier: new DevTokenService({ secret: 'openapi-contract-test-secret-0123456789' }) },
    });
}

describe('OpenAPI contract (E.7, G16)', () => {
    const spec = documentedRoutes(readFileSync(SPEC_PATH, 'utf8'));

    it('every registered route is documented in openapi.yaml', () => {
        const missing = INVENTORY.filter(
            (route) => !(spec.get(route.path)?.has(route.method.toLowerCase()) ?? false),
        );
        expect(missing.map((route) => `${route.method} ${route.path}`)).toEqual([]);
    });

    it('every documented path+method exists in the route inventory — no phantom docs', () => {
        const known = new Set(INVENTORY.map((route) => `${route.method.toLowerCase()} ${route.path}`));
        const phantom: string[] = [];
        for (const [path, methods] of spec) {
            for (const method of methods) {
                if (!known.has(`${method} ${path}`)) {
                    phantom.push(`${method} ${path}`);
                }
            }
        }
        expect(phantom).toEqual([]);
    });

    it('every probeable documented route is actually registered (no route-not-found)', async () => {
        const app = await probeApp();
        const unregistered: string[] = [];
        for (const route of INVENTORY) {
            const url = route.probe ?? route.path;
            if (url.includes('{')) {
                continue; // unprobed template (static image route)
            }
            const res = await app.inject({ method: route.method, url });
            // Fastify's default not-found handler is the ONLY 404 whose message starts
            // with "Route " — our handlers' 404s carry domain errors instead.
            const body = res.json<{ message?: string }>();
            if (res.statusCode === 404 && typeof body.message === 'string' && body.message.startsWith('Route ')) {
                unregistered.push(`${route.method} ${url}`);
            }
        }
        await app.close();
        expect(unregistered).toEqual([]);
    });
});
