// Barrel for the sidecar's ported data contracts (execution plan S1.2). These schemas are
// the source of truth for the fact store, prep pipeline, and panel — import from here.
export * from './citations.js';
export * from './extraction.js';
export * from './facts.js';
export * from './contradictions.js';
export * from './sources.js';
export * from './provider.js';
export * from './imaging.js';
export * from './verification.js';
// H.11 (REQ G1): contracts on the previously-unchecked W2 shapes — ingestion job state,
// retriever query/response, outbound vitals write. Runtime types stay exported from
// their source modules (src/ingest/, src/retrieval/, src/openemr/) via z.infer.
export * from './ingestion.js';
export * from './retrieval.js';
export * from './ehrWrites.js';
