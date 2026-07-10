// Renders the deterministic overview payload for every corpus patient WITHOUT a database:
// maps each seed JSON through the same projections seed.ts + FactStore.getFactBundle apply,
// then runs the REAL buildOverview. Powers offline visual checks (P7): panel dist + these
// JSONs = the live landing pages, no Postgres and no LLM anywhere.
//   npx tsx src/scripts/dump-overview.ts <outDir>     (default tmp/overview-dump)
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOverview } from '../routes/overview.js';
import type { FactBundle, StoredPatient } from '../store/index.js';

const SEED_DIR = fileURLToPath(new URL('../../seed/', import.meta.url));
const outDir = process.argv[2] ?? 'tmp/overview-dump';

type CorpusRecord = Record<string, unknown>;

function asArray(value: unknown): CorpusRecord[] {
    return Array.isArray(value) ? (value as CorpusRecord[]) : [];
}

/** Mirror of FactStore.insertFacts defaults + getFactBundle row shape. */
function toStoredFact(fact: CorpusRecord): FactBundle['facts'][number] {
    return {
        id: String(fact.id),
        patient_id: String(fact.patient_id),
        fact_type: fact.fact_type as FactBundle['facts'][number]['fact_type'],
        content: fact.content,
        is_current: (fact.is_current as boolean | undefined) ?? true,
        laterality: (fact.laterality as FactBundle['facts'][number]['laterality'] | undefined) ?? null,
        verification: (fact.verification as FactBundle['facts'][number]['verification'] | undefined) ?? { status: 'unverified' },
        source_document_id: String(fact.source_document_id),
        sources: (fact.sources as unknown[] | undefined) ?? [],
        created_date: (fact.created_date as string | undefined) ?? null,
        updated_date: (fact.updated_date as string | undefined) ?? null,
    };
}

async function main(): Promise<void> {
    await mkdir(outDir, { recursive: true });
    const patients: StoredPatient[] = [];
    const files = (await readdir(SEED_DIR)).filter((file) => file.endsWith('.json'));
    for (const file of files.sort()) {
        const corpus = JSON.parse(await readFile(join(SEED_DIR, file), 'utf8')) as CorpusRecord;
        const { patient_id: patientId, name, ...demographics } = corpus.patient as CorpusRecord;
        const patient: StoredPatient = {
            id: String(patientId),
            openemr_patient_id: null,
            name: String(name),
            demographics,
        };
        patients.push(patient);
        const bundle: FactBundle = {
            patient,
            facts: [
                ...asArray(corpus.medications),
                ...asArray(corpus.allergies),
                ...asArray(corpus.conditions),
                ...asArray(corpus.family_history),
                ...asArray(corpus.patient_goals),
                ...(corpus.chief_complaint !== undefined ? [corpus.chief_complaint as CorpusRecord] : []),
            ].map(toStoredFact),
            contradictions: asArray(corpus.contradictions).map((item) => ({
                id: String(item.contradiction_id ?? item.id),
                patient_id: patient.id,
                status: String(item.status ?? 'active'),
                severity: item.severity as FactBundle['contradictions'][number]['severity'],
                payload: item,
            })),
            images: asArray(corpus.images) as unknown as FactBundle['images'],
            treatments: [...asArray(corpus.treatments), ...asArray(corpus.events)].map((treatment) => ({
                id: String(treatment.id),
                patient_id: patient.id,
                treatment_date: String(treatment.treatment_date ?? ''),
                payload: treatment,
            })) as unknown as FactBundle['treatments'],
            documents: asArray(corpus.source_documents).map((doc) => {
                const { id, document_id, patient_id: _scope, document_type, document_date, content, metadata, intentional_issues: _stripped, ...extras } = doc;
                return {
                    id: String(id ?? document_id),
                    patient_id: patient.id,
                    document_type: String(document_type),
                    document_date: (document_date as string | undefined) ?? null,
                    content,
                    metadata: (metadata as Record<string, unknown> | undefined) ?? {},
                    extras,
                } as unknown as FactBundle['documents'][number];
            }),
        };
        const payload = buildOverview(bundle, null, new Date('2024-12-26T09:55:00Z'));
        await writeFile(join(outDir, `overview-${patient.id}.json`), JSON.stringify(payload, null, 1));
        // GET /api/facts/:id serves the raw bundle (prep.ts) — Sources/Imaging read it.
        await writeFile(join(outDir, `facts-${patient.id}.json`), JSON.stringify(bundle, null, 1));
        console.log(`${file} -> overview/facts-${patient.id}.json (${bundle.facts.length} facts, ${bundle.documents.length} docs, ${bundle.images.length} images)`);
    }
    await writeFile(join(outDir, 'patients.json'), JSON.stringify({ patients }, null, 1));
    console.log(`patients.json (${patients.length}) -> ${outDir}`);
}

main().catch((error: unknown) => {
    console.error('dump-overview failed:', error);
    process.exit(1);
});
