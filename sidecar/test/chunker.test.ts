// B.2 (REQ S2/R3): the structure-aware chunker. The failure modes these guard:
// a threshold table split from its qualifying conditions (wrong clinical evidence),
// unstable chunk ids (citations break on re-index), and malformed corpus docs slipping
// into the index unvalidated.
import { describe, expect, it } from 'vitest';
import {
    chunkCorpusDocument,
    CorpusParseError,
    MAX_CHUNK_CHARS,
    parseFrontmatter,
} from '../src/retrieval/chunker.js';

const FRONTMATTER = `---
id: hcq-screening
title: Hydroxychloroquine Retinopathy Screening Protocol
guideline_source: "AAO Statement: Recommendations on Screening (2016 revision)"
version: "2026-07"
effective_date: "2026-07-01"
disease_tags: [hydroxychloroquine-retinopathy, drug-toxicity]
laterality_applicability: OU
recommendation_strength: practice-adopted
---
`;

const DOC = `${FRONTMATTER}
Preamble prose that is deliberately not indexed.

## Dosing risk threshold

Daily dose above 5.0 mg/kg real body weight elevates risk.

| Dose band | Risk tier |
|-----------|-----------|
| <=5.0 mg/kg | standard |
| >5.0 mg/kg | elevated |

## Major risk factors

Duration >5 years, renal disease (reduced eGFR), tamoxifen use.
`;

describe('parseFrontmatter', () => {
    it('parses the fixed contract including quoted strings, inline lists, and comments', () => {
        const { meta, body } = parseFrontmatter(DOC, 'hcq-screening.md');
        expect(meta.id).toBe('hcq-screening');
        expect(meta.guideline_source).toContain('2016 revision');
        expect(meta.disease_tags).toEqual(['hydroxychloroquine-retinopathy', 'drug-toxicity']);
        expect(meta.laterality_applicability).toBe('OU');
        expect(body).toContain('## Dosing risk threshold');
    });

    it('rejects a doc with no frontmatter fence', () => {
        expect(() => parseFrontmatter('## Just a heading\ntext', 'x.md')).toThrow(CorpusParseError);
    });

    it('rejects frontmatter that fails the contract (bad laterality)', () => {
        const bad = DOC.replace('laterality_applicability: OU', 'laterality_applicability: BOTH');
        expect(() => parseFrontmatter(bad, 'x.md')).toThrow(/laterality_applicability/);
    });
});

describe('chunkCorpusDocument', () => {
    it('one chunk per section, stable ids, context prefix, table intact with its conditions', () => {
        const chunks = chunkCorpusDocument(DOC, 'hcq-screening.md');
        expect(chunks.map((c) => c.chunk_id)).toEqual([
            'hcq-screening#dosing-risk-threshold',
            'hcq-screening#major-risk-factors',
        ]);
        const dosing = chunks[0]!;
        // The threshold sentence AND its table live in the same chunk — the rule this file exists for.
        expect(dosing.body).toContain('5.0 mg/kg real body weight');
        expect(dosing.body).toContain('| >5.0 mg/kg | elevated |');
        expect(dosing.text.startsWith('Hydroxychloroquine Retinopathy Screening Protocol › Dosing risk threshold')).toBe(true);
        // Preamble prose is not indexed.
        expect(chunks.some((c) => c.body.includes('Preamble prose'))).toBe(false);
        // Every chunk carries the doc metadata for filters (disease/laterality, E5).
        expect(dosing.meta.disease_tags).toContain('drug-toxicity');
    });

    it('re-chunking an unchanged doc reproduces identical ids and text (citation stability)', () => {
        const a = chunkCorpusDocument(DOC, 'hcq-screening.md');
        const b = chunkCorpusDocument(DOC, 'hcq-screening.md');
        expect(b).toEqual(a);
    });

    it('splits an oversized section at paragraph boundaries, repeating the heading prefix — and never splits a table', () => {
        const bigTable = ['| Stage | Follow-up |', '|-------|-----------|', ...Array.from({ length: 40 }, (_, i) => `| stage-${i} | interval-${i} months |`)].join('\n');
        const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ${'x'.repeat(220)}.`).join('\n\n');
        const doc = `${FRONTMATTER}\n## Staging and follow-up\n\n${paragraphs}\n\n${bigTable}\n`;
        const chunks = chunkCorpusDocument(doc, 'staging.md');
        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.map((c) => c.chunk_id)).toEqual(chunks.map((_, i) => `hcq-screening#staging-and-follow-up.${i + 1}`));
        for (const chunk of chunks) {
            expect(chunk.text.startsWith('Hydroxychloroquine Retinopathy Screening Protocol › Staging and follow-up')).toBe(true);
            expect(chunk.body.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS + 2400); // one atomic block may exceed
        }
        // The table appears in exactly one chunk, unsplit.
        const withTable = chunks.filter((c) => c.body.includes('| stage-0 |'));
        expect(withTable).toHaveLength(1);
        expect(withTable[0]!.body).toContain('| stage-39 |');
    });

    it('rejects a doc with frontmatter but no sections', () => {
        expect(() => chunkCorpusDocument(`${FRONTMATTER}\njust prose\n`, 'empty.md')).toThrow(/no `## ` sections/);
    });
});
