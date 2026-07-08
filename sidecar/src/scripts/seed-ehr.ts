// EHR seeding CLI (E1): creates the five corpus patients INSIDE OpenEMR via the standard REST
// API and links each sidecar patient row to its OpenEMR uuid, so the sidecar's FHIR reads
// return real EHR records. Runs on Railway as `node dist/scripts/seed-ehr.js`, or locally as
// `npx tsx src/scripts/seed-ehr.ts`. Idempotent: patients are found by fname+lname+DOB before
// being created, and list entries are deduplicated by title.
//
// RUNBOOK (in order — steps 1 and 3 are clicks in OpenEMR, the rest are Railway SSH):
//   1. OpenEMR admin, one-time (Administration > Config > Connectors):
//        - Enable OpenEMR Standard REST API          (the /apis/default/api/* routes)
//        - Enable OAuth2 Password Grant              (user-role tokens; system clients cannot
//                                                     write via the standard API — see
//                                                     src/openemr/auth.ts STANDARD_API_SEED_SCOPES)
//   2. Register the OAuth client (skip if already registered WITH write scopes):
//        railway ssh "node dist/scripts/register-oauth.js"
//      then set the printed OPENEMR_CLIENT_ID / OPENEMR_CLIENT_KEY on the sidecar service.
//   3. OpenEMR admin: Administration > System > API Clients > find the client > Enable.
//      (Clients registered with system/user scopes always start disabled.)
//   4. Seed the EHR:
//        railway ssh "OPENEMR_SEED_USERNAME=admin OPENEMR_SEED_PASSWORD=<admin password> node dist/scripts/seed-ehr.js"
//
// What is seeded per patient: demographics (POST /api/patient), problem list with ICD-10
// (POST /api/patient/:puuid/medical_problem), allergies (POST /api/patient/:puuid/allergy,
// reaction/severity ride in comments — the route has no reaction field), and the medication
// list (POST /api/patient/:pid/medication, dose/frequency encoded in the title — the lists
// route has no structured dose columns). Prescriptions/drugs have no standard-API write route
// (only GET /api/patient/:pid/prescription exists), so richer medication structure is
// intentionally out of scope rather than written via SQL.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { OpenEmrAuthError, OpenEmrPasswordAuthClient } from '../openemr/auth.js';
import { EhrSeedCorpusSchema, seedPatientIntoEhr, type SeedListOutcome } from '../openemr/ehrSeed.js';
import { StandardApiClient, StandardApiError } from '../openemr/standardApi.js';
import { createPool, FactStore } from '../store/index.js';

// Resolves to sidecar/seed/ from both src/scripts/ (tsx) and dist/scripts/ (built).
const SEED_DIR = fileURLToPath(new URL('../../seed/', import.meta.url));

function requiredEnv(name: string): string {
    const value = process.env[name];
    if (value === undefined || value === '') {
        console.error(`${name} is required. See the runbook in the header of src/scripts/seed-ehr.ts.`);
        process.exit(1);
    }
    return value;
}

function formatList(name: string, outcome: SeedListOutcome): string {
    const skipped = outcome.skipped.length > 0 ? ` skipped=${outcome.skipped.length}` : '';
    return `${name} +${outcome.created}/=${outcome.existing}${skipped}`;
}

// Auth failures need different fixes depending on where they happened; say which one.
function explainFailure(error: unknown): string {
    if (error instanceof OpenEmrAuthError) {
        const hints: string[] = [];
        if (error.oauthError === 'invalid_client') {
            hints.push('is the API client enabled? (Administration > System > API Clients)');
        }
        if (error.oauthError === 'unsupported_grant_type') {
            hints.push('is the OAuth2 Password Grant enabled? (Administration > Config > Connectors)');
        }
        if (error.oauthError === 'invalid_grant') {
            hints.push('check OPENEMR_SEED_USERNAME / OPENEMR_SEED_PASSWORD');
        }
        if (error.oauthError === 'invalid_scope') {
            hints.push('re-register the client — it predates the standard-API write scopes (node dist/scripts/register-oauth.js)');
        }
        return `auth error: ${error.message}${hints.length > 0 ? ` — ${hints.join('; ')}` : ''}`;
    }
    if (error instanceof StandardApiError) {
        if (error.kind === 'auth') {
            return (
                `authorization error: ${error.message} — the token lacks a needed api:oemr/user scope. ` +
                'Re-register the client with write scopes (node dist/scripts/register-oauth.js), enable it, and retry.'
            );
        }
        if (error.kind === 'validation') {
            return `validation error (payload rejected by OpenEMR): ${error.message}`;
        }
        return `request error: ${error.message}`;
    }
    return error instanceof Error ? error.message : String(error);
}

async function listCorpusFiles(): Promise<string[]> {
    return (await readdir(SEED_DIR)).filter((name) => name.endsWith('.json')).sort();
}

async function main(): Promise<void> {
    const config = loadConfig();
    const baseUrl = config.OPENEMR_BASE_URL ?? requiredEnv('OPENEMR_BASE_URL');
    const clientId = requiredEnv('OPENEMR_CLIENT_ID');
    const username = requiredEnv('OPENEMR_SEED_USERNAME');
    const password = requiredEnv('OPENEMR_SEED_PASSWORD');
    if (config.DATABASE_URL === undefined) {
        console.error('DATABASE_URL is required to link seeded patients back to the fact store.');
        process.exit(1);
    }

    const auth = new OpenEmrPasswordAuthClient({ baseUrl, clientId, username, password });
    const api = new StandardApiClient({ baseUrl, tokenProvider: auth });

    // Fail fast on auth before touching anything: every later step needs this token.
    try {
        await auth.getAccessToken();
    } catch (error) {
        console.error(explainFailure(error));
        printRunbook();
        process.exit(1);
    }

    const pool = createPool(config);
    const store = new FactStore(pool);
    let failures = 0;
    for (const file of await listCorpusFiles()) {
        try {
            const corpus = EhrSeedCorpusSchema.parse(JSON.parse(await readFile(new URL(file, `file://${SEED_DIR}`), 'utf8')));
            const outcome = await seedPatientIntoEhr(api, corpus);
            await store.setOpenemrPatientId(outcome.patientId, outcome.uuid);
            console.log(
                `${file}: ${outcome.action} patient uuid=${outcome.uuid} pid=${outcome.pid} ` +
                    `${formatList('problems', outcome.problems)} ${formatList('allergies', outcome.allergies)} ` +
                    `${formatList('medications', outcome.medications)} — linked to ${outcome.patientId}`,
            );
            for (const skipped of [...outcome.problems.skipped, ...outcome.allergies.skipped, ...outcome.medications.skipped]) {
                console.log(`${file}:   skipped ${skipped.factId}: ${skipped.reason}`);
            }
        } catch (error) {
            failures += 1;
            console.error(`${file}: FAILED — ${explainFailure(error)}`);
        }
    }
    await pool.end();
    if (failures > 0) {
        console.error(`seed-ehr finished with ${failures} failure(s).`);
        process.exit(1);
    }
    console.log('seed-ehr complete: OpenEMR now holds the corpus patients and the fact store links to them.');
}

function printRunbook(): void {
    console.error(`
Runbook (in order):
  1. OpenEMR admin (Administration > Config > Connectors):
       - Enable OpenEMR Standard REST API
       - Enable OAuth2 Password Grant
  2. Register the client:      railway ssh "node dist/scripts/register-oauth.js"
     then set OPENEMR_CLIENT_ID / OPENEMR_CLIENT_KEY on the sidecar service.
  3. OpenEMR admin: Administration > System > API Clients > enable the client.
  4. Seed:                     railway ssh "OPENEMR_SEED_USERNAME=admin OPENEMR_SEED_PASSWORD=... node dist/scripts/seed-ehr.js"`);
}

main().catch((error) => {
    console.error('seed-ehr failed:', error);
    process.exit(1);
});
