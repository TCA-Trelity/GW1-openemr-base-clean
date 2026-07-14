// Wave 0.1 (REQ S2/R3): verify pgvector availability on the target Postgres — the Week 1
// "pgvector installed as headroom" line was a doc claim, so Week 2 verifies before the
// dense index assumes it. Run against any DATABASE_URL:
//
//   DATABASE_URL=postgres://... npm run verify:pgvector
//
// Outcomes (also the runbook decision table):
//   AVAILABLE      — extension present or creatable → RETRIEVER_DENSE_BACKEND=pgvector
//   NOT AVAILABLE  — extension missing from the image → set RETRIEVER_DENSE_BACKEND=memory
//                    (in-process cosine over the same retriever interface; fine at corpus
//                    scale) and file the infra follow-up
//   NO DATABASE    — DATABASE_URL unset; nothing to verify (exit 2)
import pg from 'pg';
import { loadConfig } from '../config.js';

const config = loadConfig();

if (config.DATABASE_URL === undefined) {
    console.error('verify:pgvector — DATABASE_URL is not set; nothing to verify (exit 2)');
    process.exit(2);
}

const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 1 });

try {
    const installed = await pool.query(
        `SELECT extversion FROM pg_extension WHERE extname = 'vector'`,
    );
    if (installed.rowCount !== null && installed.rowCount > 0) {
        console.log(`pgvector AVAILABLE (already installed, version ${String(installed.rows[0].extversion)})`);
        console.log('→ RETRIEVER_DENSE_BACKEND=pgvector is safe on this database');
        process.exit(0);
    }

    const creatable = await pool.query(
        `SELECT default_version FROM pg_available_extensions WHERE name = 'vector'`,
    );
    if (creatable.rowCount !== null && creatable.rowCount > 0) {
        await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
        console.log(`pgvector AVAILABLE (installed now, version ${String(creatable.rows[0].default_version)})`);
        console.log('→ RETRIEVER_DENSE_BACKEND=pgvector is safe on this database');
        process.exit(0);
    }

    console.error('pgvector NOT AVAILABLE on this Postgres image.');
    console.error('→ set RETRIEVER_DENSE_BACKEND=memory (in-process cosine fallback; same retriever');
    console.error('  interface, viable at guideline-corpus scale) and file the infra follow-up.');
    process.exit(1);
} catch (error) {
    console.error('verify:pgvector — query failed:', error instanceof Error ? error.message : error);
    process.exit(1);
} finally {
    await pool.end();
}
