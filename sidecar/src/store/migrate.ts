// Tiny migration runner (S1.6): applies sidecar/migrations/*.sql in filename order inside
// one transaction each, tracked in _migrations, idempotent, advisory-locked against
// concurrent boots. No framework. CLI form: `tsx src/store/migrate.ts` (needs DATABASE_URL).
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

// Resolves to sidecar/migrations/ from both src/store/ (tsx) and dist/store/ (built).
const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

// Arbitrary app-scoped advisory lock key: two runners racing at deploy time serialize here.
const MIGRATION_LOCK_KEY = 727254;

/** Applies pending migrations; returns the filenames applied by this call (may be empty). */
export async function migrate(pool: Pool, migrationsDir: string = DEFAULT_MIGRATIONS_DIR): Promise<string[]> {
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    const client = await pool.connect();
    const applied: string[] = [];
    try {
        await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
        await client.query(
            'CREATE TABLE IF NOT EXISTS _migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
        );
        const seen = await client.query<{ filename: string }>('SELECT filename FROM _migrations');
        const done = new Set(seen.rows.map((r) => r.filename));
        for (const file of files) {
            if (done.has(file)) {
                continue;
            }
            const sql = await readFile(path.join(migrationsDir, file), 'utf8');
            await client.query('BEGIN');
            try {
                await client.query(sql); // whole file, one multi-statement simple query
                await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
                await client.query('COMMIT');
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            }
            applied.push(file);
        }
        return applied;
    } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
        client.release();
    }
}

// Run directly (mirrors server.ts): apply migrations and exit. Deliberately a floating
// async IIFE, not top-level await — index.js re-exports this module, so awaiting its import
// here before evaluation finishes would deadlock the module graph.
if (process.argv[1]?.endsWith('migrate.js') || process.argv[1]?.endsWith('migrate.ts')) {
    void (async () => {
        const { loadConfig } = await import('../config.js');
        const { createPool } = await import('./index.js');
        const pool = createPool(loadConfig());
        try {
            const applied = await migrate(pool);
            console.log(applied.length > 0 ? `migrated: ${applied.join(', ')}` : 'migrations up to date');
        } finally {
            await pool.end();
        }
    })().catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
    });
}
