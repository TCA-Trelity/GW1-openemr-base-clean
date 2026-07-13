// The chat-path response gate: the single choke point every outbound chat payload passes
// before it is streamed, persisted, or returned — the chat counterpart of citationGate.ts,
// which guards the prep path. Two policies, deliberately different:
//
//   - Citations (provenance) — ENFORCED. A citation that fails verbatim re-verification is
//     withheld here and never reaches the wire; only its count travels (unverified_count),
//     so failures are surfaced, never silent — and never renderable, by any client.
//   - Prose (the reply text) — SCREENED, advisory. The prescriptiveness lint runs on every
//     completed reply and on the seed/opening move; flags are logged with rule + excerpt
//     for the engineering team and counted on the wire (prescriptive_flag_count), but the
//     text is never altered. Redacting or rewriting in front of the physician was rejected
//     as a product decision (docs/prompt-guide.md): the physician reads an unedited reply,
//     the flag routes to the people who fix the prompt.
import type { ChatCitation } from './chatCitations.js';
import { lintPrescriptiveness, type PrescriptivenessFlag } from './prescriptivenessLint.js';

/** The slice of the app logger the gate needs (PrepLogger satisfies it structurally). */
export interface GateLogger {
    warn(obj: Record<string, unknown>, msg?: string): void;
}

/** Exactly what may leave the server for one turn. */
export interface GatedTurn {
    /** Citations released to the wire — verified-only, by construction. */
    citations: ChatCitation[];
    unverified_count: number;
    prescriptive_flag_count: number;
}

export class ChatResponseGate {
    private readonly released: ChatCitation[] = [];
    private unverified = 0;

    constructor(
        private readonly logger: GateLogger,
        private readonly context: { correlationId: string; conversationId: string },
        private readonly onRelease?: (citation: ChatCitation) => void,
    ) {}

    /**
     * Admit one mapped citation. Verified → released (streamed via onRelease, kept for the
     * result). Unverified → withheld and counted. `null` (structurally unmappable: empty
     * cited text or unknown document index) → dropped as malformed, uncounted — it was
     * never provenance to begin with.
     */
    admit(mapped: ChatCitation | null): void {
        if (mapped === null) {
            return;
        }
        if (!mapped.verified) {
            this.unverified += 1;
            return;
        }
        this.released.push(mapped);
        this.onRelease?.(mapped);
    }

    /**
     * Close the turn: aggregate-log withheld provenance, screen the reply, and hand back
     * exactly what may leave the server.
     */
    finalize(reply: string): GatedTurn {
        if (this.unverified > 0) {
            // The chat verification metric: unverifiable spans are surfaced, never provenance.
            this.logger.warn(
                { ...this.context, unverified: this.unverified },
                'chat citations failed verbatim verification',
            );
        }
        const flags = screenOutboundText(reply, this.logger, this.context);
        return {
            citations: this.released,
            unverified_count: this.unverified,
            prescriptive_flag_count: flags.length,
        };
    }
}

/**
 * Advisory prose screen (M3), shared by chat replies and the seed/opening move: directive
 * advice without attribution is counted and logged per docs/prompt-guide.md — never
 * redacted. Returns the flags so callers can count them onto the wire.
 */
export function screenOutboundText(
    text: string,
    logger: GateLogger,
    context: Record<string, unknown>,
): PrescriptivenessFlag[] {
    const { flags } = lintPrescriptiveness(text);
    if (flags.length > 0) {
        logger.warn(
            {
                ...context,
                prescriptive_flags: flags.length,
                rules: flags.map((flag) => flag.rule),
                excerpts: flags.map((flag) => flag.excerpt),
            },
            'chat reply flagged by prescriptiveness lint',
        );
    }
    return flags;
}
