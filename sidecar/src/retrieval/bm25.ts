// In-process BM25 keyword index (Wave B.4, REQ S2/R3). This is the keyword half of the
// hybrid retriever in memory mode — and the documented fallback when Postgres tsvector
// is unavailable. Deterministic and dependency-free: at guideline-corpus scale (10²–10³
// chunks) exact BM25 over an in-memory inverted index is milliseconds, and determinism
// is what lets the retrieval goldens (B.6) run in CI without live services.
export interface Bm25Doc {
    id: string;
    text: string;
}

export interface Bm25Hit {
    id: string;
    score: number;
}

const K1 = 1.2;
const B = 0.75;

export function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9%./-]+/g, ' ')
        .split(/\s+/)
        .map((token) => token.replace(/^[./-]+|[./-]+$/g, ''))
        .map(stemPlural)
        .filter((token) => token.length > 1);
}

/** Minimal plural stem ("intervals"→"interval") — enough for clinical prose, deterministic. */
function stemPlural(token: string): string {
    if (token.length >= 4 && token.endsWith('s') && !token.endsWith('ss') && !token.endsWith('us')) {
        return token.slice(0, -1);
    }
    return token;
}

export class Bm25Index {
    private readonly docLengths = new Map<string, number>();
    private readonly termFrequencies = new Map<string, Map<string, number>>(); // term -> docId -> tf
    private readonly ids: string[] = [];
    private averageLength = 0;

    constructor(docs: readonly Bm25Doc[]) {
        let totalLength = 0;
        for (const doc of docs) {
            const tokens = tokenize(doc.text);
            this.ids.push(doc.id);
            this.docLengths.set(doc.id, tokens.length);
            totalLength += tokens.length;
            for (const token of tokens) {
                let postings = this.termFrequencies.get(token);
                if (postings === undefined) {
                    postings = new Map<string, number>();
                    this.termFrequencies.set(token, postings);
                }
                postings.set(doc.id, (postings.get(doc.id) ?? 0) + 1);
            }
        }
        this.averageLength = this.ids.length === 0 ? 0 : totalLength / this.ids.length;
    }

    get size(): number {
        return this.ids.length;
    }

    search(query: string, topK: number): Bm25Hit[] {
        const scores = new Map<string, number>();
        const n = this.ids.length;
        for (const term of new Set(tokenize(query))) {
            const postings = this.termFrequencies.get(term);
            if (postings === undefined) {
                continue;
            }
            const idf = Math.log(1 + (n - postings.size + 0.5) / (postings.size + 0.5));
            for (const [docId, tf] of postings) {
                const length = this.docLengths.get(docId) ?? this.averageLength;
                const denominator = tf + K1 * (1 - B + (B * length) / (this.averageLength || 1));
                scores.set(docId, (scores.get(docId) ?? 0) + idf * ((tf * (K1 + 1)) / denominator));
            }
        }
        return [...scores.entries()]
            .map(([id, score]) => ({ id, score }))
            .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
            .slice(0, topK);
    }
}
