-- 005: persisted dense index for the guideline corpus (S2/R3 — RETRIEVER_DENSE_BACKEND=pgvector).
-- Guarded: on a Postgres without the pgvector extension this migration records itself as
-- applied but creates nothing, and the retriever falls back to the in-memory dense path
-- (loudly logged at boot). The deploy target has pgvector verified available (2026-07-14,
-- v0.8.4, enabled by verify:pgvector). No ANN index on purpose: the corpus is O(10^2)
-- chunks, where an exact scan via <=> beats index build/upkeep.
DO $$
BEGIN
    BEGIN
        CREATE EXTENSION IF NOT EXISTS vector;
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'pgvector extension unavailable (%) — corpus_embeddings not created; in-memory dense path serves', SQLERRM;
    END;
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
        CREATE TABLE IF NOT EXISTS corpus_embeddings (
            chunk_id     text PRIMARY KEY,
            doc_id       text NOT NULL,
            model        text NOT NULL,
            content_hash text NOT NULL,
            embedding    vector(1024) NOT NULL,
            updated_at   timestamptz NOT NULL DEFAULT now()
        );
    END IF;
END $$;
