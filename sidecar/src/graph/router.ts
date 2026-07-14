// Supervisor routing decision (Wave C.2, REQ S3/R4 — locked decision #4). Every ask gets
// exactly one cheap, logged decision: deterministic short-circuits first (free, instant,
// explainable), then a small fast-model tie-break ONLY for genuinely ambiguous turns.
// The router never answers anything — it names the lane and the reason, and both are
// logged on the handoff (pitfall P3: the supervisor is never a black box).
export type Route = 'fast_path' | 'needs_evidence' | 'needs_extraction';

export interface RoutingDecision {
    route: Route;
    /** Human-readable rationale — logged verbatim on the worker_handoff event. */
    reason: string;
    /** 'rule' = deterministic short-circuit; 'model' = fast-model tie-break. */
    decided_by: 'rule' | 'model';
}

/** The model tie-break seam: Haiku-backed in production, stubbed in tests. */
export interface RouterModel {
    decide(question: string, correlationId: string): Promise<Route>;
}

// Guideline-shaped language → evidence lane. These mirror what the corpus can actually
// answer (protocols, thresholds, intervals, standards) — not generic question words.
const EVIDENCE_PATTERNS: { pattern: RegExp; label: string }[] = [
    { pattern: /\b(guidelines?|protocols?|standards? of care|recommend(?:s|ed|ations?)?)\b/i, label: 'asks for guideline/protocol' },
    { pattern: /\b(screening|monitoring)\s+(intervals?|schedules?|frequenc(?:y|ies))\b/i, label: 'asks a screening-interval question' },
    { pattern: /\bhow often\b|\bwhen should\b|\bshould (i|we|she|he|they)\b/i, label: 'asks a should/frequency question' },
    { pattern: /\b(threshold|cutoff|criteria|indication)s?\b/i, label: 'asks for thresholds/criteria' },
    { pattern: /\b(per|according to)\s+(the\s+)?(aao|guidelines?|protocols?)\b/i, label: 'cites guidelines explicitly' },
    { pattern: /\b(treat[- ]and[- ]extend|areds2?|4-2-1)\b/i, label: 'names a protocol concept' },
];

// Record-shaped language → fast path (the Week 1 chat loop answers from prepared facts).
const FAST_PATTERNS: { pattern: RegExp; label: string }[] = [
    { pattern: /\b(when did|what did|who (verified|prescribed|said)|last (visit|scan|injection))\b/i, label: 'record-history question' },
    { pattern: /\b(show|open|pull up|display)\b/i, label: 'navigation ask' },
    { pattern: /\b(his|her|their|this patient'?s)\s+(medication|allerg|scan|image|history|goal)/i, label: 'patient-record lookup' },
];

export interface RouteInput {
    kind: 'chat_turn' | 'document_upload';
    question?: string;
}

export async function routeAsk(input: RouteInput, model: RouterModel | undefined, correlationId: string): Promise<RoutingDecision> {
    // Rule 1: a document upload IS the extraction lane — nothing to deliberate.
    if (input.kind === 'document_upload') {
        return { route: 'needs_extraction', reason: 'document upload event', decided_by: 'rule' };
    }
    const question = (input.question ?? '').trim();
    if (question === '') {
        return { route: 'fast_path', reason: 'empty question — default lane', decided_by: 'rule' };
    }
    for (const { pattern, label } of EVIDENCE_PATTERNS) {
        if (pattern.test(question)) {
            return { route: 'needs_evidence', reason: label, decided_by: 'rule' };
        }
    }
    for (const { pattern, label } of FAST_PATTERNS) {
        if (pattern.test(question)) {
            return { route: 'fast_path', reason: label, decided_by: 'rule' };
        }
    }
    // Ambiguous → one bounded fast-model call (~200–400 ms); no model → fast path, which
    // is always safe (the Week 1 loop can still consult its tools).
    if (model === undefined) {
        return { route: 'fast_path', reason: 'ambiguous; no router model configured — safe default', decided_by: 'rule' };
    }
    const route = await model.decide(question, correlationId);
    return { route, reason: 'fast-model tie-break on ambiguous phrasing', decided_by: 'model' };
}
