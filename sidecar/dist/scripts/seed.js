// Seed CLI (node dist/scripts/seed.js on Railway, or npx tsx src/scripts/seed.ts locally):
// migrates the fact store, then loads the ground-truthed corpus (seed/*.json) into it.
// Idempotent: each patient is wiped and re-inserted, so re-runs converge (prep_runs survive).
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { createPool, FactStore } from '../store/index.js';
import { migrate } from '../store/migrate.js';
// Resolves to sidecar/seed/ from both src/scripts/ (tsx) and dist/scripts/ (built).
const SEED_DIR = fileURLToPath(new URL('../../seed/', import.meta.url));
const CORPUS_FILES = ['margaret-chen.json', 'william-thompson.json'];
async function main() {
    const config = loadConfig();
    if (config.DATABASE_URL === undefined) {
        console.error('DATABASE_URL is required to seed the fact store.');
        process.exit(1);
    }
    const pool = createPool(config);
    const applied = await migrate(pool);
    console.log(`migrations applied: ${applied.length === 0 ? '(none pending)' : applied.join(', ')}`);
    const store = new FactStore(pool);
    for (const file of CORPUS_FILES) {
        const corpus = JSON.parse(await readFile(new URL(file, `file://${SEED_DIR}`), 'utf8'));
        // Corpus uses patient_id as the identity key; everything else is demographics.
        const { patient_id: patientId, name, ...demographics } = corpus.patient;
        await store.wipePatient(patientId);
        await store.upsertPatient({ id: patientId, name, demographics });
        await store.insertSourceDocuments(patientId, corpus.source_documents ?? []);
        const facts = [
            ...(corpus.medications ?? []),
            ...(corpus.allergies ?? []),
            ...(corpus.conditions ?? []),
            ...(corpus.family_history ?? []),
            ...(corpus.patient_goals ?? []),
            ...(corpus.chief_complaint ? [corpus.chief_complaint] : []),
        ];
        await store.insertFacts(patientId, facts);
        await store.insertContradictions(patientId, corpus.contradictions ?? []);
        await store.insertImageRecords(patientId, corpus.images ?? []);
        await store.insertTreatments(patientId, [...(corpus.treatments ?? []), ...(corpus.events ?? [])]);
        console.log(`${file}: patient=${patientId} docs=${(corpus.source_documents ?? []).length} facts=${facts.length} ` +
            `contradictions=${(corpus.contradictions ?? []).length} images=${(corpus.images ?? []).length} ` +
            `treatments=${(corpus.treatments ?? []).length + (corpus.events ?? []).length}`);
    }
    await pool.end();
    console.log('seed complete.');
}
main().catch((error) => {
    console.error('seed failed:', error);
    process.exit(1);
});
//# sourceMappingURL=seed.js.map