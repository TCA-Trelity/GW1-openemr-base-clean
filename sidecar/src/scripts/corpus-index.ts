// B.3-live (REQ S2/R3, G18): rebuild/sync the persisted dense index for the guideline
// corpus — the wipe-and-rebuild path the corpus README promises. Embeds ONLY chunks whose
// content hash changed (an unchanged corpus is a zero-Cohere-call no-op) and reports counts.
//
//   DATABASE_URL='postgres://…' COHERE_API_KEY='…' npm run corpus:index
//   … add --rebuild to wipe the table first and re-embed everything from scratch.
//
// Exit codes: 0 synced · 2 not applicable (no DATABASE_URL / no COHERE_API_KEY — the
// in-memory dense path needs no persisted index) · 1 failure.
import { loadConfig } from '../config.js';
import { createPool } from '../store/index.js';
import { migrate } from '../store/migrate.js';
import { CohereEmbeddings } from '../retrieval/embeddings.js';
import { PgVectorDenseIndex } from '../retrieval/denseIndex.js';
import { loadCorpusChunks } from '../retrieval/retriever.js';
import { fileURLToPath } from 'node:url';

const config = loadConfig();

if (config.DATABASE_URL === undefined) {
    console.error('corpus:index — DATABASE_URL is not set; the in-memory dense path needs no persisted index (exit 2)');
    process.exit(2);
}
if (config.COHERE_API_KEY === undefined) {
    console.error('corpus:index — COHERE_API_KEY is not set; the persisted index stores Cohere vectors only (exit 2)');
    process.exit(2);
}

const corpusDir = fileURLToPath(new URL('../../corpus/', import.meta.url));
const chunks = loadCorpusChunks(corpusDir);
const pool = createPool(config);
const embeddings = new CohereEmbeddings({ apiKey: config.COHERE_API_KEY, model: config.COHERE_EMBED_MODEL });
const logger = { info: (obj: Record<string, unknown>, msg: string) => console.log(JSON.stringify({ msg, ...obj })) };

try {
    await migrate(pool);
    if (process.argv.includes('--rebuild')) {
        await pool.query('DELETE FROM corpus_embeddings');
        console.log('corpus:index — table wiped (--rebuild); re-embedding everything');
    }
    await PgVectorDenseIndex.sync(pool, chunks, embeddings, 'corpus-index-cli', logger);
    console.log(`corpus:index — OK (${chunks.length} chunks, backend pgvector, model ${embeddings.id})`);
    process.exit(0);
} catch (error) {
    console.error('corpus:index — failed:', error instanceof Error ? error.message : error);
    process.exit(1);
} finally {
    await pool.end();
}
