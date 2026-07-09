// Route-level contract for POST /api/ehr-sync/:patientId — especially the upstream-error
// mapping: OpenEMR failures must surface as a 502 envelope naming the dependency, never as
// the upstream status echoed at the caller (the live regression: an OAuth 400 rendered in
// the panel as if the panel's own POST were malformed).
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { OpenEmrAuthError } from '../src/openemr/auth.js';
import type { EhrSyncResult } from '../src/openemr/ehrSync.js';
import { FhirRequestError } from '../src/openemr/fhir.js';
import { registerEhrRoutes, type EhrSyncLike } from '../src/routes/ehr.js';

function appWith(sync: EhrSyncLike['sync']) {
    const app = Fastify();
    registerEhrRoutes(app, { service: { sync } });
    return app;
}

const syncedResult: EhrSyncResult = {
    synced: true,
    factCount: 3,
    resourceCounts: { Condition: 3 },
    snapshotDocumentId: 'ehr-snapshot-margaret-chen',
    syncedAt: '2026-07-09T19:00:00.000Z',
};

describe('POST /api/ehr-sync/:patientId', () => {
    it('passes a successful sync through as 200', async () => {
        const app = appWith(() => Promise.resolve(syncedResult));
        const res = await app.inject({ method: 'POST', url: '/api/ehr-sync/margaret-chen' });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ synced: true, factCount: 3 });
    });

    it('maps an unlinked patient to a clean 409 with the reason', async () => {
        const app = appWith(() =>
            Promise.resolve({ ...syncedResult, synced: false, reason: 'not_linked_to_openemr', factCount: 0 }),
        );
        const res = await app.inject({ method: 'POST', url: '/api/ehr-sync/margaret-chen' });
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ reason: 'not_linked_to_openemr' });
    });

    // Failure mode: Fastify's default handler echoes a thrown error's `.status`, so an OpenEMR
    // OAuth 400 reached the panel as HTTP 400 — indistinguishable from a bad request.
    it('maps an OpenEMR auth rejection to 502 ehr_upstream_auth', async () => {
        const app = appWith(() => Promise.reject(new OpenEmrAuthError('token', 400, 'invalid_client')));
        const res = await app.inject({ method: 'POST', url: '/api/ehr-sync/margaret-chen' });
        expect(res.statusCode).toBe(502);
        expect(res.json()).toEqual({ error: 'ehr_upstream_auth', upstream_status: 400 });
    });

    it('maps a FHIR request failure to 502 ehr_upstream_fhir', async () => {
        const app = appWith(() => Promise.reject(new FhirRequestError('/Condition', 400, 'invalid parameter')));
        const res = await app.inject({ method: 'POST', url: '/api/ehr-sync/margaret-chen' });
        expect(res.statusCode).toBe(502);
        expect(res.json()).toEqual({ error: 'ehr_upstream_fhir', upstream_status: 400 });
    });

    it('lets unexpected errors reach the default handler as 500', async () => {
        const app = appWith(() => Promise.reject(new Error('store exploded')));
        const res = await app.inject({ method: 'POST', url: '/api/ehr-sync/margaret-chen' });
        expect(res.statusCode).toBe(500);
    });

    it('answers 503 when no sync service is configured', async () => {
        const app = Fastify();
        registerEhrRoutes(app, undefined);
        const res = await app.inject({ method: 'POST', url: '/api/ehr-sync/margaret-chen' });
        expect(res.statusCode).toBe(503);
        expect(res.json()).toEqual({ error: 'ehr_sync_not_configured' });
    });
});
