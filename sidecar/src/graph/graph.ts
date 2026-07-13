// The Week 2 supervisor/worker graph (Wave C, REQ S3/R4 — W2_ARCHITECTURE.md §4).
// LangGraph.js StateGraph, exactly five nodes: supervisor → {intake_extractor |
// evidence_retriever | fast_path} → critic → answer. Nodes WRAP the shipped services
// (ingestion, hybrid retriever, citation gate) — LangGraph orchestrates; it does not
// replace the direct Anthropic client, the Zod contracts, or the gate layer.
//
// Inspectability is the requirement, not a nicety (pitfall P3): every transition appends
// a HandoffEvent {from, to, routing_reason} to the state AND logs a `worker_handoff`
// event with the correlation ID, so one ID reconstructs the full multi-agent trace (G4);
// span parenting (worker ⊂ supervisor) rides the same events into the tracer (G13).
//
// Latency tiers (locked decision #4): document uploads run this graph at prep time
// (Tier 2); guideline-shaped chat turns take the bounded evidence lane (Tier 1, ~5 s
// streamed by the caller); fast_path turns EXIT the graph immediately and the caller
// delegates to the unchanged Week 1 chat loop — the graph never sits in the fast path.
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { runCitationGate, type Claim, type DocumentTextResolver } from '../gate/citationGate.js';
import { lintPrescriptiveness } from '../gate/prescriptivenessLint.js';
import type { AttachAndExtractInput, IngestionRecord, IngestionService } from '../ingest/service.js';
import type { EvidenceSnippet, HybridRetriever } from '../retrieval/retriever.js';
import type { CitationRef } from '../schemas/citations.js';
import { parseEvidencePayload, parseGraphAsk } from './contracts.js';
import type { PinnedEvidenceStore } from './pins.js';
import { routeAsk, type RouterModel, type RoutingDecision } from './router.js';

export interface HandoffEvent {
    from: string;
    to: string;
    routing_reason: string;
    at: string;
}

export interface GraphAsk {
    kind: 'chat_turn' | 'document_upload';
    patientId: string;
    question?: string;
    upload?: Omit<AttachAndExtractInput, 'patientId' | 'correlationId'>;
    /** Clinical concepts for evidence retrieval context (PHI-free by construction). */
    concepts?: string[];
}

export interface DraftAnswer {
    text: string;
    /** Claims with guideline citations — the critic verifies every quote before release. */
    claims: Claim[];
}

/** The answer-composition seam: LLM-backed in production, stubbed in tests. */
export interface AnswerComposer {
    compose(ask: GraphAsk, evidence: EvidenceSnippet[], extraction: IngestionRecord | null, correlationId: string): Promise<DraftAnswer>;
}

export interface GraphLogger {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
}

export interface ClinicalGraphDeps {
    retriever: HybridRetriever;
    ingestion: IngestionService;
    composer: AnswerComposer;
    routerModel?: RouterModel;
    /** When present, extraction-driven retrievals pin their chunks per patient (C.6). */
    pins?: PinnedEvidenceStore;
    /** Tier-1 retrieval budget in ms (default 5000) — exceeded → degraded empty result. */
    evidenceBudgetMs?: number;
    logger?: GraphLogger;
    now?: () => string;
}

export interface GraphOutcome {
    route: RoutingDecision['route'];
    routing: RoutingDecision;
    handoffs: HandoffEvent[];
    evidence: EvidenceSnippet[];
    ingestion: IngestionRecord | null;
    /** Present unless the route was fast_path (the caller's chat loop answers those). */
    answer: {
        text: string;
        verified_claims: number;
        blocked_claims: number;
        citations: CitationRef[];
        prescriptive_flags: number;
    } | null;
}

// Tier-1 evidence-turn budget (locked decision #4: evidence turns ≤ 5 s streamed) —
// the retrieval leg gets the full window; composition streams within the caller's SSE.
const EVIDENCE_BUDGET_MS = 5000;

const GraphAnnotation = Annotation.Root({
    ask: Annotation<GraphAsk>,
    correlationId: Annotation<string>,
    routing: Annotation<RoutingDecision | null>({ reducer: (_prev, next) => next, default: () => null }),
    handoffs: Annotation<HandoffEvent[]>({ reducer: (prev, next) => [...prev, ...next], default: () => [] }),
    evidence: Annotation<EvidenceSnippet[]>({ reducer: (_prev, next) => next, default: () => [] }),
    ingestion: Annotation<IngestionRecord | null>({ reducer: (_prev, next) => next, default: () => null }),
    draft: Annotation<DraftAnswer | null>({ reducer: (_prev, next) => next, default: () => null }),
    answer: Annotation<GraphOutcome['answer']>({ reducer: (_prev, next) => next, default: () => null }),
});
type GraphStateType = typeof GraphAnnotation.State;

export function buildClinicalGraph(deps: ClinicalGraphDeps) {
    const now = deps.now ?? (() => new Date().toISOString());
    const handoff = (state: GraphStateType, from: string, to: string, reason: string): HandoffEvent[] => {
        const event: HandoffEvent = { from, to, routing_reason: reason, at: now() };
        deps.logger?.info(
            { correlation_id: state.correlationId, patient_id: state.ask.patientId, from, to, routing_reason: reason },
            'worker_handoff',
        );
        return [event];
    };

    const graph = new StateGraph(GraphAnnotation)
        .addNode('supervisor', async (state) => {
            const routeInput: Parameters<typeof routeAsk>[0] = { kind: state.ask.kind };
            if (state.ask.question !== undefined) {
                routeInput.question = state.ask.question;
            }
            const routing = await routeAsk(routeInput, deps.routerModel, state.correlationId);
            return {
                routing,
                handoffs: handoff(
                    state,
                    'supervisor',
                    routing.route === 'needs_extraction' ? 'intake_extractor' : routing.route === 'needs_evidence' ? 'evidence_retriever' : 'fast_path',
                    `${routing.reason} (${routing.decided_by})`,
                ),
            };
        })
        .addNode('intake_extractor', async (state) => {
            if (state.ask.upload === undefined) {
                throw new Error('needs_extraction route without an upload payload');
            }
            const record = await deps.ingestion.attachAndExtract({
                ...state.ask.upload,
                patientId: state.ask.patientId,
                correlationId: state.correlationId,
            });
            // Evidence pinning (C.6): extraction findings become retrieval concepts so the
            // evidence lands NOW, at prep time — most in-visit guideline asks then read it
            // as a Tier-0 lookup instead of a live search.
            return {
                ingestion: record,
                handoffs: handoff(state, 'intake_extractor', 'evidence_retriever', `extraction ${record.status}; pin protocol evidence for extracted findings`),
            };
        })
        .addNode('evidence_retriever', async (state) => {
            const concepts = [...(state.ask.concepts ?? []), ...conceptsFromIngestion(state.ingestion)];
            const query = state.ask.question ?? concepts.join(' ');
            const searchOptions: Parameters<HybridRetriever['search']>[1] = { correlationId: state.correlationId, topK: 4 };
            if (concepts.length > 0) {
                searchOptions.context = { concepts };
            }
            // Tier-1 latency budget (C.3, G2): a slow retrieval degrades to an honest empty
            // result — the composer says "no protocol on file" instead of blowing the ≤5 s
            // evidence-turn budget or wedging the graph.
            const budgetMs = deps.evidenceBudgetMs ?? EVIDENCE_BUDGET_MS;
            let budgetTimer: ReturnType<typeof setTimeout> | undefined;
            const budget = new Promise<'budget_exceeded'>((resolve) => {
                budgetTimer = setTimeout(() => resolve('budget_exceeded'), budgetMs);
            });
            const raced = await Promise.race([deps.retriever.search(query, searchOptions), budget]).finally(() =>
                clearTimeout(budgetTimer),
            );
            if (raced === 'budget_exceeded') {
                deps.logger?.warn({ correlation_id: state.correlationId, budget_ms: budgetMs }, 'evidence_degraded');
                return {
                    evidence: [],
                    handoffs: handoff(
                        state,
                        'evidence_retriever',
                        'critic',
                        `degraded: retrieval exceeded ${budgetMs}ms budget — answering without evidence`,
                    ),
                };
            }
            // Worker-output contract (C.1, G1/G7): a drifted payload fails loudly here,
            // never as a half-shaped citation downstream.
            const snippets = parseEvidencePayload(raced.snippets);
            // Evidence pinning (C.6): extraction-driven retrievals persist their chunks
            // against the patient, keyed to the motivating ingestion — the in-visit chat
            // loop reads them as a Tier-0 lookup.
            if (deps.pins !== undefined && state.routing?.route === 'needs_extraction' && state.ingestion !== null && snippets.length > 0) {
                await deps.pins.save({
                    patient_id: state.ask.patientId,
                    ingestion_id: state.ingestion.id,
                    pinned_at: now(),
                    snippets,
                });
                deps.logger?.info(
                    {
                        correlation_id: state.correlationId,
                        patient_id: state.ask.patientId,
                        ingestion_id: state.ingestion.id,
                        pinned: snippets.length,
                    },
                    'evidence_pinned',
                );
            }
            return {
                evidence: snippets,
                handoffs: handoff(
                    state,
                    'evidence_retriever',
                    'critic',
                    raced.empty
                        ? 'no protocol cleared the confidence floor — answer must say so'
                        : `${snippets.length} chunk(s), rerank_applied=${String(raced.rerank_applied)}`,
                ),
            };
        })
        .addNode('critic', async (state) => {
            // The Week 1 deterministic gate, promoted to a graph citizen (E1): every claim's
            // quote must resolve verbatim against the retrieved chunk bodies or it blocks.
            const draft = await deps.composer.compose(state.ask, state.evidence, state.ingestion, state.correlationId);
            const resolver: DocumentTextResolver = (chunkId) =>
                state.evidence.find((snippet) => snippet.chunk_id === chunkId)?.quote;
            const gate = runCitationGate(draft.claims, resolver);
            const lint = lintPrescriptiveness(draft.text);
            const released = gate.verdicts.filter((verdict) => verdict.status === 'verified');
            const citations = released.flatMap((verdict) => verdict.citations.map((entry) => entry.citation));
            if (gate.metrics.blocked > 0 || lint.flags.length > 0) {
                deps.logger?.warn(
                    { correlation_id: state.correlationId, blocked: gate.metrics.blocked, prescriptive_flags: lint.flags.length },
                    'critic_flags',
                );
            }
            return {
                draft,
                answer: {
                    text: draft.text,
                    verified_claims: gate.metrics.verified,
                    blocked_claims: gate.metrics.blocked,
                    citations,
                    prescriptive_flags: lint.flags.length,
                },
                handoffs: handoff(state, 'critic', 'answer', `${gate.metrics.verified} verified / ${gate.metrics.blocked} blocked claim(s); ${lint.flags.length} lint flag(s)`),
            };
        })
        .addEdge(START, 'supervisor')
        .addConditionalEdges('supervisor', (state) => state.routing?.route ?? 'fast_path', {
            needs_extraction: 'intake_extractor',
            needs_evidence: 'evidence_retriever',
            // fast_path exits the graph: the caller delegates to the Week 1 chat loop.
            fast_path: END,
        })
        .addEdge('intake_extractor', 'evidence_retriever')
        .addEdge('evidence_retriever', 'critic')
        .addEdge('critic', END);

    return graph.compile();
}

/** Extraction findings → PHI-free retrieval concepts (drug names, flagged tests). */
export function conceptsFromIngestion(record: IngestionRecord | null): string[] {
    if (record === null) {
        return [];
    }
    const concepts: string[] = [];
    if (record.doc_type === 'lab_pdf') {
        concepts.push('laboratory monitoring');
    }
    if (record.doc_type === 'intake_form') {
        concepts.push('intake documentation');
    }
    // The record carries grounded summaries only (never raw values) — concept derivation
    // from persisted facts lands with the brief-refresh wiring; doc-type concepts are the
    // deterministic floor.
    return concepts;
}

/** Convenience runner returning the typed outcome (tests + route/chat callers). */
export async function runClinicalGraph(
    deps: ClinicalGraphDeps,
    ask: GraphAsk,
    correlationId: string,
): Promise<GraphOutcome> {
    // Entry contract (C.1): malformed asks — chat turn without a question, upload without
    // bytes — throw GraphContractError here, before any node runs. Route-layer callers
    // parse unknown JSON through the same schema (contracts.ts).
    parseGraphAsk(ask);
    const app = buildClinicalGraph(deps);
    const state = await app.invoke({ ask, correlationId });
    const routing = state.routing ?? { route: 'fast_path' as const, reason: 'unrouted', decided_by: 'rule' as const };
    return {
        route: routing.route,
        routing,
        handoffs: state.handoffs,
        evidence: state.evidence,
        ingestion: state.ingestion,
        answer: state.answer,
    };
}
