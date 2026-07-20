// System-prompt / hidden-instruction leak screen (AgentForge finding). A deterministic check that an
// outbound reply is not reciting the co-pilot's own operating instructions. The chat system prompt
// (buildChatSystemPrompt) holds no secrets or PHI beyond the patient identity the physician already
// sees, so the blast radius is low — but until now NOTHING screened for a reply that echoes the hard
// rules, and "reveal your instructions" had no deterministic defense. This runs at the response gate
// (the single outbound choke point), advisory + logged, matching the prose-screen pattern; it never
// inspects the physician's message, only what the model is about to emit.

// Distinctive verbatim fragments of buildChatSystemPrompt that would never appear in a genuine
// clinical reply. Deliberately EXCLUDES phrases the model is instructed to SAY — "Not in the record."
// and the "AI visual observation (not from the record):" prefix — so a compliant reply is never flagged.
const LEAK_MARKERS: { id: string; pattern: RegExp }[] = [
    { id: 'hard_rules_header', pattern: /hard rules\s*[—-]{1,2}\s*non-negotiable/i },
    { id: 'system_role_preamble', pattern: /you are the chat surface of a clinical co-?pilot/i },
    { id: 'thought_partner_rule', pattern: /thought partner,?\s+not a prescriber/i },
    { id: 'no_outside_knowledge_rule', pattern: /outside medical knowledge to fill gaps/i },
    { id: 'answer_only_rule', pattern: /answer only from the attached source documents/i },
];

export interface SystemPromptLeakResult {
    leaked: boolean;
    /** Stable marker ids that matched (for logs/obs/evals). */
    markers: string[];
}

/** Pure screen over an outbound reply — which leak markers (if any) it recites. */
export function lintSystemPromptLeak(text: string): SystemPromptLeakResult {
    const markers = LEAK_MARKERS.filter(({ pattern }) => pattern.test(text)).map(({ id }) => id);
    return { leaked: markers.length > 0, markers };
}
