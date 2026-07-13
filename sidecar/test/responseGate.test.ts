// Response-gate unit tests: the chat-path choke point (src/gate/responseGate.ts). Each
// case documents the failure mode it guards. Citation policy is ENFORCED — verified
// citations released, unverified withheld and counted, malformed dropped — so unverified
// provenance cannot leave the server. The prose screen is ADVISORY — flags are logged and
// counted, the text is never altered (product decision: no redactions in front of the
// physician; flags route to the engineering team).
import { describe, expect, it, vi } from 'vitest';
import type { ChatCitation } from '../src/gate/chatCitations.js';
import { ChatResponseGate, screenOutboundText, type GateLogger } from '../src/gate/responseGate.js';

function citation(overrides: Partial<ChatCitation> = {}): ChatCitation {
    return {
        document_id: 'doc-mc-004',
        document_title: 'pharmacy_record (2024-11-01)',
        cited_text: 'Plaquenil 200 mg daily',
        start_char: 21,
        end_char: 43,
        verified: true,
        ...overrides,
    };
}

const CONTEXT = { correlationId: 'corr-1', conversationId: 'conv-1' };

function gateWith(onRelease?: (released: ChatCitation) => void) {
    const warn = vi.fn();
    const logger: GateLogger = { warn };
    return { gate: new ChatResponseGate(logger, CONTEXT, onRelease), warn };
}

describe('ChatResponseGate — citation policy (enforced)', () => {
    it('releases a verified citation to the sink and the result', () => {
        const onRelease = vi.fn();
        const { gate } = gateWith(onRelease);
        const verified = citation();

        gate.admit(verified);
        const turn = gate.finalize('Plaquenil 200 mg daily is on file.');

        expect(onRelease).toHaveBeenCalledTimes(1);
        expect(onRelease).toHaveBeenCalledWith(verified);
        expect(turn.citations).toEqual([verified]);
        expect(turn.unverified_count).toBe(0);
    });

    // Failure mode: fabricated provenance crossing the wire for ANY client to render.
    it('withholds an unverified citation: counted, never released', () => {
        const onRelease = vi.fn();
        const { gate } = gateWith(onRelease);

        gate.admit(citation({ cited_text: 'invented span not in any document', verified: false }));
        const turn = gate.finalize('Some reply.');

        expect(onRelease).not.toHaveBeenCalled();
        expect(turn.citations).toEqual([]);
        expect(turn.unverified_count).toBe(1);
    });

    // A structurally unmappable citation (empty cited text / unknown document index) maps
    // to null upstream — it was never provenance, so it is dropped without counting.
    it('drops a malformed (null) citation without counting it', () => {
        const onRelease = vi.fn();
        const { gate } = gateWith(onRelease);

        gate.admit(null);
        const turn = gate.finalize('Some reply.');

        expect(onRelease).not.toHaveBeenCalled();
        expect(turn.citations).toEqual([]);
        expect(turn.unverified_count).toBe(0);
    });

    // Failure mode: withheld provenance disappearing silently (the governing rule is
    // "surfaced, never silent").
    it('aggregate-logs withheld provenance once, at finalize', () => {
        const { gate, warn } = gateWith();

        gate.admit(citation({ verified: false }));
        gate.admit(citation({ verified: false }));
        gate.finalize('Some reply.');

        const call = warn.mock.calls.find(([, message]) => message === 'chat citations failed verbatim verification');
        expect(call).toBeDefined();
        expect(call![0]).toMatchObject({ ...CONTEXT, unverified: 2 });
    });

    it('logs nothing about citations when every citation verified', () => {
        const { gate, warn } = gateWith();

        gate.admit(citation());
        gate.finalize('Plaquenil 200 mg daily is on file.');

        expect(
            warn.mock.calls.find(([, message]) => message === 'chat citations failed verbatim verification'),
        ).toBeUndefined();
    });
});

describe('ChatResponseGate — prose screen (advisory)', () => {
    // Failure mode: a violating reply passing through the turn uncounted/unlogged. The
    // text itself is untouched by construction — the gate never returns or rewrites prose.
    it('counts and logs a directive reply', () => {
        const { gate, warn } = gateWith();

        const turn = gate.finalize('You should increase the dose to 400 mg.');

        expect(turn.prescriptive_flag_count).toBe(1);
        const call = warn.mock.calls.find(([, message]) => message === 'chat reply flagged by prescriptiveness lint');
        expect(call).toBeDefined();
        expect(call![0]).toMatchObject({ ...CONTEXT, prescriptive_flags: 1, rules: ['second_person_directive'] });
    });

    it('screens a compliant consultative reply silently', () => {
        const { gate, warn } = gateWith();

        const turn = gate.finalize('Per AAO guidelines this is high risk. Worth asking: any new visual symptoms?');

        expect(turn.prescriptive_flag_count).toBe(0);
        expect(
            warn.mock.calls.find(([, message]) => message === 'chat reply flagged by prescriptiveness lint'),
        ).toBeUndefined();
    });
});

describe('screenOutboundText — the seed/opening-move screen', () => {
    it('flags directive text and logs with the caller context', () => {
        const warn = vi.fn();

        const flags = screenOutboundText('Start her on 200 mg daily dosing.', { warn }, { correlationId: 'corr-seed', surface: 'opening_move' });

        expect(flags).toHaveLength(1);
        const call = warn.mock.calls.find(([, message]) => message === 'chat reply flagged by prescriptiveness lint');
        expect(call).toBeDefined();
        expect(call![0]).toMatchObject({ correlationId: 'corr-seed', surface: 'opening_move', prescriptive_flags: 1 });
    });

    it('passes clean text without logging', () => {
        const warn = vi.fn();

        const flags = screenOutboundText('Vision stable; last OCT 2026-05-02.', { warn }, { correlationId: 'corr-seed' });

        expect(flags).toHaveLength(0);
        expect(warn).not.toHaveBeenCalled();
    });
});
