// Corpus↔schema contract lock: every record in the seed corpus must strictly
// parse through the landed Zod schemas. This is the contract S1.7's extraction
// and the fact store rely on; if it breaks, fix the source (schema or corpus),
// never the sink. Added after S1.6 found five silent drift points.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    ContradictionSchema,
    ImageRecordSchema,
    PatientFactSchema,
    SeedSourceDocumentSchema,
    TreatmentRecordSchema,
} from '../src/schemas/index.js';

function load(name: string) {
    return JSON.parse(readFileSync(new URL(`../seed/${name}`, import.meta.url), 'utf8'));
}

// Sweep every *.json directly in seed/ (same glob seed.ts loads), so a newly added
// patient corpus is conformance-locked without editing this list.
const corpora = readdirSync(new URL('../seed/', import.meta.url))
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => [name, load(name)] as const);

describe.each(corpora)('corpus conformance: %s', (_name, corpus) => {
    // Guards: facts the prep pipeline would emit/consume failing strict parse.
    it('every fact parses through PatientFactSchema', () => {
        const facts = [
            ...(corpus.medications ?? []),
            ...(corpus.allergies ?? []),
            ...(corpus.conditions ?? []),
            ...(corpus.family_history ?? []),
            ...(corpus.patient_goals ?? []),
            corpus.chief_complaint,
        ].filter(Boolean);
        expect(facts.length).toBeGreaterThan(0);
        for (const fact of facts) {
            const result = PatientFactSchema.safeParse(fact);
            expect(result.success, `${fact.id}: ${JSON.stringify(result.success ? '' : result.error.issues)}`).toBe(true);
        }
    });

    // Guards: source documents (incl. eval-only intentional_issues wrapper).
    it('every source document parses through SeedSourceDocumentSchema', () => {
        for (const doc of corpus.source_documents ?? []) {
            const result = SeedSourceDocumentSchema.safeParse(doc);
            expect(result.success, `${doc.document_id}: ${JSON.stringify(result.success ? '' : result.error.issues)}`).toBe(true);
        }
    });

    // Guards: imaging records the four analytics engines consume.
    it('every image record parses through ImageRecordSchema', () => {
        for (const image of corpus.images ?? []) {
            const result = ImageRecordSchema.safeParse(image);
            expect(result.success, `${image.id}: ${JSON.stringify(result.success ? '' : result.error.issues)}`).toBe(true);
        }
    });

    // Guards: treatment records feeding interval analysis.
    it('every treatment parses through TreatmentRecordSchema', () => {
        for (const treatment of corpus.treatments ?? []) {
            const result = TreatmentRecordSchema.safeParse(treatment);
            expect(result.success, `${treatment.id ?? treatment.treatment_date}: ${JSON.stringify(result.success ? '' : result.error.issues)}`).toBe(true);
        }
    });

    // Guards: rich contradictions (the eval ground-truth carrier).
    it('every contradiction parses through ContradictionSchema', () => {
        for (const contradiction of corpus.contradictions ?? []) {
            const result = ContradictionSchema.safeParse(contradiction);
            expect(
                result.success,
                `${contradiction.contradiction_id}: ${JSON.stringify(result.success ? '' : result.error.issues)}`,
            ).toBe(true);
        }
    });
});
