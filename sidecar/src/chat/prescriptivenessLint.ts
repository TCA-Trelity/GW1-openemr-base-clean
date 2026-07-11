// Prescriptiveness lint (M3): a deterministic post-generation check that the reply obeys
// the thought-partner contract (docs/prompt-guide.md) — the agent never ORIGINATES
// treatment/dosing/diagnosis direction. Same philosophy as citation verification: flags are
// surfaced and counted, never silently passed. Deliberately conservative: a sentence is
// flagged only when it carries directive advice AND names no source (the attribution
// carve-out — relaying documented plans or engine/guideline output is correct behavior),
// and question-shaped sentences are exempt (questions are the sanctioned reframe).

export interface PrescriptivenessFlag {
    /** The offending sentence, trimmed, as the log/obs excerpt. */
    excerpt: string;
    /** Which rule fired (stable ids for dashboards and evals). */
    rule: 'first_person_advice' | 'second_person_directive' | 'passive_directive' | 'imperative_directive';
}

export interface PrescriptivenessLintResult {
    flags: PrescriptivenessFlag[];
}

// Clinical-direction verbs (base + past-participle forms derived below).
const DIRECTIVE_VERBS =
    'start|stop|increase|decrease|switch|taper|discontinue|hold|prescribe|order|begin|reduce|shorten|extend|adjust|add|restart|resume|titrate';
const DIRECTIVE_VERBS_PAST =
    'started|stopped|increased|decreased|switched|tapered|discontinued|held|prescribed|ordered|begun|reduced|shortened|extended|adjusted|added|restarted|resumed|titrated';
// Objects that make a leading imperative clinical ("Start her on 200 mg", "Order a consult").
const CLINICAL_OBJECTS =
    'dose|dosing|mg|medication|therapy|treatment|interval|injection|drops?|screening|imaging|referral|refill|regimen|prescription|consult|exam';

// A sentence naming any of these is treated as a relay with provenance, not origination.
// Mirrors the prompt's carve-out: "per AAO screening guidelines", "the interval engine
// derives…", "Dr. Reyes' note recommends…", "the documented plan…".
const ATTRIBUTION = new RegExp(
    String.raw`\b(?:per|according to|guidelines?|AAO|engine|protocol|documented|the record|record shows|Dr\.|consult(?:'s)? (?:note|plan)|note(?:'s)?\s+(?:plan|recommend)|notes? recommend|plan recommends?)\b`,
    'i',
);

const RULES: { rule: PrescriptivenessFlag['rule']; pattern: RegExp }[] = [
    {
        rule: 'first_person_advice',
        pattern: new RegExp(String.raw`\b(?:I(?:'d| would)? (?:recommend|suggest|advise)|my (?:recommendation|advice))\b`, 'i'),
    },
    {
        rule: 'second_person_directive',
        pattern: new RegExp(String.raw`\b(?:you|we) (?:should|need to|ought to|must)\s+(?:${DIRECTIVE_VERBS})\b`, 'i'),
    },
    {
        rule: 'passive_directive',
        pattern: new RegExp(String.raw`\bshould be (?:${DIRECTIVE_VERBS_PAST})\b`, 'i'),
    },
    {
        rule: 'imperative_directive',
        pattern: new RegExp(
            String.raw`^(?:${DIRECTIVE_VERBS}|recommend|require)\b[^.?!\n]*\b(?:${CLINICAL_OBJECTS})\b`,
            'i',
        ),
    },
];

// Sentence-ish units: split at sentence punctuation and line breaks, then strip bullet
// markers so the imperative rule anchors on the real first word.
function sentencesOf(reply: string): string[] {
    return reply
        .split(/(?<=[.!?])\s+|\n+/)
        .map((raw) => raw.trim().replace(/^[-•*\d.)\s]+/, '').trim())
        .filter((sentence) => sentence.length > 0);
}

/** Pure lint over a completed reply. Question-shaped sentences are never flagged. */
export function lintPrescriptiveness(reply: string): PrescriptivenessLintResult {
    const flags: PrescriptivenessFlag[] = [];
    for (const sentence of sentencesOf(reply)) {
        if (sentence.endsWith('?') || ATTRIBUTION.test(sentence)) {
            continue;
        }
        const hit = RULES.find(({ pattern }) => pattern.test(sentence));
        if (hit !== undefined) {
            flags.push({ excerpt: sentence, rule: hit.rule });
        }
    }
    return { flags };
}
