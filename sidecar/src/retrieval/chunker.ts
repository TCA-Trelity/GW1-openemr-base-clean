// Structure-aware corpus chunker (Wave B.2, REQ S2/R3 — W2_ARCHITECTURE.md §5).
// Input: authored practice-protocol markdown (sidecar/corpus/*.md) with the fixed YAML
// frontmatter contract (corpus/README.md). Output: section-scoped chunks.
//
// The clinical-text rule this exists for: THRESHOLDS STAY WITH THEIR CONDITIONS. A dose
// cutoff, screening interval, or staging table split from its qualifying sentence turns
// grounded evidence into a wrong answer. So the section (## heading) is the atomic unit:
// tables and lists never split, every chunk is prefixed with `doc title › section title`
// context, and an oversized section splits only at paragraph boundaries — never inside a
// table or list block — with the heading prefix repeated on continuation chunks.
//
// Chunk ids are stable (`<docId>#<heading-slug>[.N]`) — they are citation
// `field_or_chunk_id`s (schemas/citations.ts v2), so re-chunking an unchanged doc must
// reproduce ids byte-for-byte.
import { z } from 'zod';

// Frontmatter contract — mirrors corpus/README.md. Parsed with a deliberately small
// reader (fixed key set, scalars + [inline, lists] only): the corpus is ours, the
// contract is pinned by tests, and a full YAML dependency would be surface without need.
export const CorpusDocMetaSchema = z.object({
    id: z.string().min(1).regex(/^[a-z0-9-]+$/, 'kebab-case id'),
    title: z.string().min(1),
    guideline_source: z.string().min(1),
    version: z.string().min(1),
    effective_date: z.string().min(1),
    disease_tags: z.array(z.string().min(1)).min(1),
    laterality_applicability: z.enum(['OD', 'OS', 'OU', 'NA']),
    recommendation_strength: z.string().min(1),
});
export type CorpusDocMeta = z.infer<typeof CorpusDocMetaSchema>;

export const CorpusChunkSchema = z.object({
    /** Stable citation key: `<docId>#<heading-slug>` (+ `.N` for continuation chunks). */
    chunk_id: z.string().min(1),
    doc_id: z.string().min(1),
    section_title: z.string().min(1),
    /** `doc title › section` context prefix + section body — what gets embedded. */
    text: z.string().min(1),
    /** Body without the context prefix — what quote verification runs against. */
    body: z.string().min(1),
    meta: CorpusDocMetaSchema,
});
export type CorpusChunk = z.infer<typeof CorpusChunkSchema>;

/** Sections longer than this split at paragraph boundaries (tables/lists never split). */
export const MAX_CHUNK_CHARS = 2200;

export class CorpusParseError extends Error {
    constructor(docPath: string, detail: string) {
        super(`corpus document ${docPath}: ${detail}`);
        this.name = 'CorpusParseError';
    }
}

export function parseFrontmatter(markdown: string, docPath: string): { meta: CorpusDocMeta; body: string } {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
    if (match === null) {
        throw new CorpusParseError(docPath, 'missing YAML frontmatter fence');
    }
    const raw: Record<string, unknown> = {};
    for (const line of match[1]!.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#')) {
            continue;
        }
        const colon = trimmed.indexOf(':');
        if (colon === -1) {
            throw new CorpusParseError(docPath, `frontmatter line is not \`key: value\`: "${trimmed}"`);
        }
        const key = trimmed.slice(0, colon).trim();
        let value = trimmed.slice(colon + 1).trim();
        const commentAt = findUnquotedHash(value);
        if (commentAt !== -1) {
            value = value.slice(0, commentAt).trim();
        }
        raw[key] = value.startsWith('[') ? parseInlineList(value, docPath) : unquote(value);
    }
    const parsed = CorpusDocMetaSchema.safeParse(raw);
    if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
        throw new CorpusParseError(docPath, `frontmatter failed the contract (${issues})`);
    }
    return { meta: parsed.data, body: markdown.slice(match[0].length) };
}

export function chunkCorpusDocument(markdown: string, docPath: string): CorpusChunk[] {
    const { meta, body } = parseFrontmatter(markdown, docPath);
    const sections = splitSections(body);
    if (sections.length === 0) {
        throw new CorpusParseError(docPath, 'no `## ` sections found — nothing to index');
    }

    const chunks: CorpusChunk[] = [];
    const seenSlugs = new Map<string, number>();
    for (const section of sections) {
        const baseSlug = slugify(section.title);
        const dupCount = seenSlugs.get(baseSlug) ?? 0;
        seenSlugs.set(baseSlug, dupCount + 1);
        const slug = dupCount === 0 ? baseSlug : `${baseSlug}-${dupCount + 1}`;

        const pieces = splitOversized(section.body);
        pieces.forEach((piece, index) => {
            const chunkId = pieces.length === 1 ? `${meta.id}#${slug}` : `${meta.id}#${slug}.${index + 1}`;
            const prefix = `${meta.title} › ${section.title}`;
            chunks.push(
                CorpusChunkSchema.parse({
                    chunk_id: chunkId,
                    doc_id: meta.id,
                    section_title: section.title,
                    text: `${prefix}\n\n${piece}`,
                    body: piece,
                    meta,
                }),
            );
        });
    }
    return chunks;
}

// ---- internals ----

function findUnquotedHash(value: string): number {
    let inQuote: '"' | "'" | undefined;
    for (let i = 0; i < value.length; i += 1) {
        const ch = value[i];
        if (inQuote !== undefined) {
            if (ch === inQuote) {
                inQuote = undefined;
            }
        } else if (ch === '"' || ch === "'") {
            inQuote = ch;
        } else if (ch === '#' && i > 0 && value[i - 1] === ' ') {
            return i;
        }
    }
    return -1;
}

function unquote(value: string): string {
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
        return value.slice(1, -1);
    }
    return value;
}

function parseInlineList(value: string, docPath: string): string[] {
    if (!value.endsWith(']')) {
        throw new CorpusParseError(docPath, `unterminated inline list: "${value}"`);
    }
    const inner = value.slice(1, -1).trim();
    if (inner === '') {
        return [];
    }
    return inner.split(',').map((item) => unquote(item.trim()));
}

interface Section {
    title: string;
    body: string;
}

function splitSections(body: string): Section[] {
    const lines = body.split(/\r?\n/);
    const sections: Section[] = [];
    let current: { title: string; lines: string[] } | undefined;
    for (const line of lines) {
        const heading = /^##\s+(.+)$/.exec(line);
        if (heading !== null) {
            if (current !== undefined) {
                pushSection(sections, current);
            }
            current = { title: heading[1]!.trim(), lines: [] };
        } else if (current !== undefined) {
            current.lines.push(line);
        }
        // Prose before the first ## heading (the doc preamble) is intentionally not
        // indexed — every retrievable statement must live under a titled section.
    }
    if (current !== undefined) {
        pushSection(sections, current);
    }
    return sections;
}

function pushSection(sections: Section[], current: { title: string; lines: string[] }): void {
    const body = current.lines.join('\n').trim();
    if (body !== '') {
        sections.push({ title: current.title, body });
    }
}

/**
 * Split an oversized section at paragraph boundaries only. A "block" is a run of
 * non-blank lines; table blocks (every line starts with `|`) and list blocks are atomic
 * by construction since they contain no blank lines. Never splits inside a block — a
 * single block larger than MAX_CHUNK_CHARS stays whole (correctness over uniformity).
 */
function splitOversized(body: string): string[] {
    if (body.length <= MAX_CHUNK_CHARS) {
        return [body];
    }
    const blocks = body.split(/\n{2,}/).map((block) => block.trim()).filter((block) => block !== '');
    const pieces: string[] = [];
    let current = '';
    for (const block of blocks) {
        const candidate = current === '' ? block : `${current}\n\n${block}`;
        if (candidate.length > MAX_CHUNK_CHARS && current !== '') {
            pieces.push(current);
            current = block;
        } else {
            current = candidate;
        }
    }
    if (current !== '') {
        pieces.push(current);
    }
    return pieces;
}

function slugify(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-');
}
