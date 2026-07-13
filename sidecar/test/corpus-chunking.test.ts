// B.1 × B.2 (REQ S2/R3, G18): every authored corpus document must pass the frontmatter
// contract and chunk cleanly through the real chunker — the index is derived state, so a
// doc that fails here would poison retrieval at build time, not at answer time. Also
// guards the corpus's zero-PHI invariant: practice protocols must never mention patients.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { chunkCorpusDocument, type CorpusChunk } from '../src/retrieval/chunker.js';

const CORPUS_DIR = fileURLToPath(new URL('../corpus/', import.meta.url));
const docFiles = readdirSync(CORPUS_DIR)
    .filter((file) => file.endsWith('.md') && file !== 'README.md')
    .sort();

function allChunks(): { file: string; chunks: CorpusChunk[] }[] {
    return docFiles.map((file) => ({
        file,
        chunks: chunkCorpusDocument(readFileSync(join(CORPUS_DIR, file), 'utf8'), file),
    }));
}

describe('authored corpus conforms to the chunking contract', () => {
    it('has the committed 8-protocol corpus', () => {
        expect(docFiles.length).toBeGreaterThanOrEqual(8);
    });

    it('every document parses, chunks, and matches its filename id', () => {
        for (const { file, chunks } of allChunks()) {
            expect(chunks.length, `${file} produced no chunks`).toBeGreaterThanOrEqual(3);
            const expectedId = file.replace(/\.md$/, '');
            for (const chunk of chunks) {
                expect(chunk.doc_id, `${file} id/filename mismatch`).toBe(expectedId);
                expect(chunk.chunk_id.startsWith(`${expectedId}#`)).toBe(true);
                expect(chunk.text.length).toBeGreaterThan(40);
            }
        }
    });

    it('chunk ids are unique across the whole corpus (citation keys)', () => {
        const ids = allChunks().flatMap(({ chunks }) => chunks.map((chunk) => chunk.chunk_id));
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('every document carries a References section (grounded-in-named-guidelines invariant)', () => {
        for (const { file, chunks } of allChunks()) {
            expect(
                chunks.some((chunk) => /references/i.test(chunk.section_title)),
                `${file} has no References section`,
            ).toBe(true);
        }
    });

    it('the HCQ dosing threshold stays with its table (the chunking rule, on real content)', () => {
        const hcq = allChunks().find(({ file }) => file === 'hcq-screening.md');
        expect(hcq).toBeDefined();
        const dosing = hcq!.chunks.find((chunk) => chunk.body.includes('5.0 mg/kg'));
        expect(dosing).toBeDefined();
        // Threshold sentence and the drug/threshold table share one chunk.
        expect(dosing!.body).toContain('Hydroxychloroquine');
        expect(dosing!.body).toContain('2.3 mg/kg');
    });

    it('the renal protocol carries eGFR bands (the hero-arc evidence)', () => {
        const renal = allChunks().find(({ file }) => file === 'renal-function-ocular-drug-safety.md');
        expect(renal).toBeDefined();
        const text = renal!.chunks.map((chunk) => chunk.body).join('\n');
        expect(text).toMatch(/eGFR/);
        expect(text).toMatch(/60/);
        expect(text).toMatch(/30/);
    });

    it('contains zero patient references (corpus is practice policy, never PHI)', () => {
        const seedNames = ['Margaret', 'Chen', 'Thompson', 'Whitfield', 'Okafor', 'Alvarez'];
        for (const { file, chunks } of allChunks()) {
            const text = chunks.map((chunk) => chunk.body).join('\n');
            for (const name of seedNames) {
                expect(text.includes(name), `${file} mentions seed patient name "${name}"`).toBe(false);
            }
        }
    });
});
