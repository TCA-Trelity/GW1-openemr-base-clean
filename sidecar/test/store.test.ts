// Fact-store tests (S1.6), two layers: always-run pure checks over the migration SQL and
// FactStore source (no DB needed), and a DATABASE_URL-gated integration round-trip that
// loads the entire Margaret Chen corpus, reads it back, and exercises the wipe levers.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { loadConfig } from '../src/config.js';
import {
    createPool,
    FactStore,
    migrate,
    type ContradictionInput,
    type FactInput,
    type ImageRecordInput,
    type SourceDocumentInput,
    type TreatmentInput,
} from '../src/store/index.js';

const SIDECAR_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIGRATION_PATH = path.join(SIDECAR_ROOT, 'migrations', '001_init.sql');
const FACT_STORE_SOURCE_PATH = path.join(SIDECAR_ROOT, 'src', 'store', 'factStore.ts');
const CORPUS_PATH = path.join(SIDECAR_ROOT, 'seed', 'margaret-chen.json');

const EXPECTED_TABLES = [
    'patients',
    'source_documents',
    'patient_facts',
    'contradictions',
    'image_records',
    'treatments',
    'briefs',
    'prep_runs',
] as const;

/** Comment-stripped, semicolon-split statements — a cheap "not obviously broken" parse. */
function splitStatements(sql: string): string[] {
    const withoutComments = sql
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n');
    return withoutComments
        .split(';')
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0);
}

describe('001_init.sql (always-run)', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    const statements = splitStatements(sql);

    // Guards: a truncated/mangled migration (unterminated statement, stray text) shipping and
    // failing only at first deploy-time migrate.
    it('splits into well-formed DDL statements', () => {
        expect(statements.length).toBeGreaterThanOrEqual(EXPECTED_TABLES.length);
        for (const statement of statements) {
            expect(statement).toMatch(/^CREATE (TABLE|INDEX) /);
            const opens = (statement.match(/\(/g) ?? []).length;
            const closes = (statement.match(/\)/g) ?? []).length;
            expect(opens, `unbalanced parens in: ${statement.slice(0, 60)}`).toBe(closes);
        }
        expect(sql.trimEnd().endsWith(';')).toBe(true);
    });

    // Guards: a table silently dropped from (or misnamed in) the initial schema — every
    // ticketed table must be created, and nothing unexpected.
    it('creates exactly the eight expected tables', () => {
        const created = statements
            .filter((s) => s.startsWith('CREATE TABLE'))
            .map((s) => /^CREATE TABLE (\w+)/.exec(s)?.[1]);
        expect([...created].sort()).toEqual([...EXPECTED_TABLES].sort());
    });

    // Guards: losing the patient_id access path a per-patient store lives on, or the
    // fact_type / (patient_id, is_current) indexes the ticket requires.
    it('indexes patient_id on every child table plus fact_type and is_current on facts', () => {
        const indexes = statements.filter((s) => s.startsWith('CREATE INDEX'));
        for (const table of EXPECTED_TABLES.filter((t) => t !== 'patients')) {
            expect(
                indexes.some((s) => new RegExp(`ON ${table} \\(patient_id`).test(s)),
                `missing patient_id index on ${table}`,
            ).toBe(true);
        }
        expect(indexes.some((s) => s.includes('ON patient_facts (fact_type)'))).toBe(true);
        expect(indexes.some((s) => s.includes('ON patient_facts (patient_id, is_current)'))).toBe(true);
    });

    // Guards: the migration creating the runner's own bookkeeping table (owned by migrate.ts,
    // which must be able to create it before any migration runs).
    it('does not create _migrations itself', () => {
        expect(sql).not.toContain('_migrations');
    });
});

describe('FactStore SQL hygiene (always-run)', () => {
    const source = readFileSync(FACT_STORE_SOURCE_PATH, 'utf8');

    // Guards: SQL injection — a value interpolated into a query template instead of being
    // passed as a $n parameter would splice patient data straight into SQL text.
    it('uses parameterized SQL only (no ${} interpolation inside SQL template literals)', () => {
        const templates = source.match(/`[^`]*`/gs) ?? [];
        const sqlTemplates = templates.filter((t) => /\b(SELECT|INSERT|UPDATE|DELETE|TRUNCATE)\b/.test(t));
        expect(sqlTemplates.length).toBeGreaterThan(0);
        for (const template of sqlTemplates) {
            expect(template, `interpolation in SQL: ${template.slice(0, 80)}`).not.toContain('${');
        }
        expect(source).toContain('$1'); // sanity: placeholders actually in use
    });
});

describe('createPool (always-run)', () => {
    // Guards: booting with a silently unconfigured store and failing on first query instead.
    it('throws when DATABASE_URL is unset', () => {
        expect(() => createPool(loadConfig({}))).toThrow('DATABASE_URL');
    });

    // Guards: Railway ssl handling — public proxy URLs (sslmode=require) need ssl with an
    // unverifiable cert accepted, while private-network URLs must not force TLS.
    it('enables ssl only when the connection string demands it', async () => {
        const withSsl = createPool(loadConfig({ DATABASE_URL: 'postgres://u:p@host:5432/db?sslmode=require' }));
        const withoutSsl = createPool(loadConfig({ DATABASE_URL: 'postgres://u:p@host:5432/db' }));
        const sslOf = (pool: Pool): unknown => (pool as unknown as { options: { ssl?: unknown } }).options.ssl;
        expect(sslOf(withSsl)).toEqual({ rejectUnauthorized: false });
        expect(sslOf(withoutSsl)).toBeFalsy();
        await Promise.all([withSsl.end(), withoutSsl.end()]);
    });
});

// ---- Integration layer: full corpus round-trip against a real Postgres ----

type Corpus = {
    patient: { patient_id: string; name: string } & Record<string, unknown>;
    medications: FactInput[];
    allergies: FactInput[];
    conditions: FactInput[];
    family_history: FactInput[];
    patient_goals: FactInput[];
    chief_complaint: FactInput;
    source_documents: SourceDocumentInput[];
    contradictions: ContradictionInput[];
    images: ImageRecordInput[];
    treatments: TreatmentInput[];
    events: TreatmentInput[];
};

const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as Corpus;
const corpusFacts: FactInput[] = [
    ...corpus.medications,
    ...corpus.allergies,
    ...corpus.conditions,
    ...corpus.family_history,
    ...corpus.patient_goals,
    corpus.chief_complaint,
];
const corpusTreatments: TreatmentInput[] = [...corpus.treatments, ...corpus.events];
const PATIENT_ID = corpus.patient.patient_id;

describe.skipIf(!process.env.DATABASE_URL)('FactStore integration (requires DATABASE_URL)', () => {
    let pool: Pool;
    let store: FactStore;

    const countRows = async (table: string): Promise<number> => {
        // Table names come from the fixed EXPECTED_TABLES vocabulary above, never from data.
        const result = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
        return result.rows[0]?.n ?? -1;
    };

    beforeAll(async () => {
        pool = createPool(loadConfig(process.env));
        await migrate(pool);
        store = new FactStore(pool);
        await store.wipeAll(); // clean slate: this store is wipeable by design
    });

    afterAll(async () => {
        await store.wipeAll();
        await pool.end();
    });

    // Guards: the runner re-applying applied migrations — every boot after the first would
    // crash on duplicate tables.
    it('migrate is idempotent and tracked in _migrations', async () => {
        expect(await migrate(pool)).toEqual([]);
        const tracked = await pool.query<{ filename: string }>('SELECT filename FROM _migrations');
        expect(tracked.rows.map((r) => r.filename)).toContain('001_init.sql');
    });

    // Guards: the store being unable to hold its own seed corpus — the whole prep pipeline
    // and demo depend on every section of margaret-chen.json persisting.
    it('loads the entire Margaret Chen corpus', async () => {
        const { patient_id, name, ...demographics } = corpus.patient;
        await store.upsertPatient({ id: patient_id, name, demographics });
        expect(await store.insertSourceDocuments(PATIENT_ID, corpus.source_documents)).toBe(12);
        expect(await store.insertFacts(PATIENT_ID, corpusFacts)).toBe(12);
        expect(await store.insertContradictions(PATIENT_ID, corpus.contradictions)).toBe(4);
        expect(await store.insertImageRecords(PATIENT_ID, corpus.images)).toBe(6);
        expect(await store.insertTreatments(PATIENT_ID, corpusTreatments)).toBe(1);
    });

    // Guards: demo/eval planted-issue annotations leaking into the EHR-facing store — the
    // schemas (sources.ts) forbid persisting intentional_issues anywhere.
    it('strips intentional_issues from persisted source documents', async () => {
        expect(corpus.source_documents.some((d) => d.intentional_issues !== undefined)).toBe(true);
        const leaked = await pool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM source_documents WHERE extras ? 'intentional_issues' OR content ? 'intentional_issues'",
        );
        expect(leaked.rows[0]?.n).toBe(0);
    });

    // Guards: the bundle the chat/prep consume dropping or duplicating rows relative to the
    // corpus (wrong joins, missing sections, patient scoping bugs).
    it('getFactBundle counts match the corpus', async () => {
        const bundle = await store.getFactBundle(PATIENT_ID);
        expect(bundle).not.toBeNull();
        expect(bundle?.patient.name).toBe(corpus.patient.name);
        expect(bundle?.patient.demographics['mrn']).toBe(corpus.patient['mrn']);
        expect(bundle?.facts).toHaveLength(corpusFacts.length);
        expect(bundle?.contradictions).toHaveLength(corpus.contradictions.length);
        expect(bundle?.images).toHaveLength(corpus.images.length);
        expect(bundle?.treatments).toHaveLength(corpusTreatments.length);
        // Every fact_type present in the corpus survives the round-trip.
        const types = new Set(bundle?.facts.map((f) => f.fact_type));
        expect(types).toEqual(new Set(corpusFacts.map((f) => f.fact_type)));
    });

    // Guards: jsonb round-trip corrupting citation excerpts — the citation gate (S1.8) does
    // byte-level excerpt matching, so any mangling (escapes, newlines, unicode) breaks it.
    it('citation excerpt survives the jsonb round-trip byte-identical', async () => {
        const bundle = await store.getFactBundle(PATIENT_ID);
        const corpusFact = corpus.medications.find((f) => f.id === 'fact-mc-med-001');
        const storedFact = bundle?.facts.find((f) => f.id === 'fact-mc-med-001');
        const byId = (sources: unknown, id: string): Record<string, unknown> => {
            const hit = (sources as Record<string, unknown>[]).find((s) => s['id'] === id);
            if (hit === undefined) {
                throw new Error(`citation ${id} not found`);
            }
            return hit;
        };
        // cit-mc-002's excerpt contains embedded double quotes; its location context contains
        // real newlines — both must come back byte-identical.
        const original = byId(corpusFact?.sources, 'cit-mc-002');
        const stored = byId(storedFact?.sources, 'cit-mc-002');
        expect(original['excerpt_text']).toBe('"first_fill_date": "2019-01-15"');
        expect(stored['excerpt_text']).toBe(original['excerpt_text']);
        expect(stored['excerpt_location']).toEqual(original['excerpt_location']);
        expect(stored).toEqual(original);
    });

    // Guards: getBrief returning a stale, failed, or draft brief — the panel must only ever
    // see the newest complete one.
    it('getBrief returns the latest complete brief only', async () => {
        expect(await store.getBrief(PATIENT_ID)).toBeNull();
        await store.saveBrief({ patient_id: PATIENT_ID, correlation_id: 'corr-1', content: { headline: 'first' } });
        await store.saveBrief({ patient_id: PATIENT_ID, correlation_id: 'corr-2', content: { headline: 'draft' }, status: 'draft' });
        const latest = await store.saveBrief({ patient_id: PATIENT_ID, correlation_id: 'corr-3', content: { headline: 'newest complete' } });
        const fetched = await store.getBrief(PATIENT_ID);
        expect(fetched?.id).toBe(latest.id);
        expect(fetched?.correlation_id).toBe('corr-3');
        expect(fetched?.content).toEqual({ headline: 'newest complete' });
    });

    // Guards: losing the prep-pipeline audit trail — a run that cannot be closed out (or a
    // failure whose error text vanishes) makes live incidents undebuggable.
    it('records the prep run lifecycle including failures', async () => {
        const okRun = await store.startPrepRun(PATIENT_ID, 'corr-ok');
        await store.finishPrepRun(okRun, 'complete');
        const failedRun = await store.startPrepRun(PATIENT_ID, 'corr-fail');
        await store.finishPrepRun(failedRun, 'failed', 'extraction returned invalid facts');
        const rows = await pool.query<{ id: string; status: string; error: string | null; finished_at: Date | null }>(
            'SELECT id, status, error, finished_at FROM prep_runs WHERE id = ANY($1)',
            [[okRun, failedRun]],
        );
        const byId = new Map(rows.rows.map((r) => [r.id, r]));
        expect(byId.get(okRun)?.status).toBe('complete');
        expect(byId.get(okRun)?.error).toBeNull();
        expect(byId.get(okRun)?.finished_at).not.toBeNull();
        expect(byId.get(failedRun)?.status).toBe('failed');
        expect(byId.get(failedRun)?.error).toBe('extraction returned invalid facts');
        await expect(store.finishPrepRun('00000000-0000-0000-0000-000000000000', 'complete')).rejects.toThrow('not found');
    });

    // Guards: re-registration crashing on duplicate key, or updates not landing — rebuilds
    // upsert the same patient id every time.
    it('upsertPatient is idempotent and applies updates', async () => {
        const { patient_id, name, ...demographics } = corpus.patient;
        await store.upsertPatient({ id: patient_id, name: 'Renamed For Test', demographics, openemr_patient_id: 'uuid-123' });
        const renamed = await store.getFactBundle(PATIENT_ID);
        expect(renamed?.patient.name).toBe('Renamed For Test');
        expect(renamed?.patient.openemr_patient_id).toBe('uuid-123');
        await store.upsertPatient({ id: patient_id, name, demographics }); // restore
    });

    // Guards: silent cross-tenant bleed — an item stamped with one patient_id must never be
    // written under another patient's scope.
    it('rejects cross-patient writes', async () => {
        const medication = corpus.medications[0];
        await expect(store.insertFacts('someone-else', [medication as FactInput])).rejects.toThrow('cross-patient');
    });

    // Guards: facts persisting without provenance — the FK to source_documents enforces the
    // "every fact cites a stored document" invariant, and the transaction must roll back.
    it('rejects facts whose source document is absent and rolls back the batch', async () => {
        const orphan: FactInput = { ...(corpus.medications[0] as FactInput), id: 'fact-orphan', source_document_id: 'doc-nope' };
        await expect(store.insertFacts(PATIENT_ID, [orphan])).rejects.toThrow();
        expect(await countRows('patient_facts')).toBe(12); // nothing partial persisted
    });

    // Guards: the rollback lever failing — wipePatient must erase the whole derived view
    // (rebuildable from the EHR) while prep_runs survive as the operational audit trail.
    it('wipePatient empties the derived view but keeps prep_runs', async () => {
        await store.wipePatient(PATIENT_ID);
        expect(await store.getFactBundle(PATIENT_ID)).toBeNull();
        expect(await store.getBrief(PATIENT_ID)).toBeNull();
        for (const table of ['patients', 'source_documents', 'patient_facts', 'contradictions', 'image_records', 'treatments', 'briefs']) {
            expect(await countRows(table), `${table} not emptied`).toBe(0);
        }
        expect(await countRows('prep_runs')).toBeGreaterThanOrEqual(2);
    });
});
