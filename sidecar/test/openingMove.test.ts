// Opening-move composer tests (M9). Failure modes: a malformed brief producing an invented
// digest (must return null — absence over invention), points/urgency/questions leaking in
// wrong shapes, unbounded length, and the 3-point cap drifting.
import { describe, expect, it } from 'vitest';
import { composeOpeningMove } from '../src/chat/openingMove.js';

const PREPARED_AT = '2026-07-11T08:00:00.000Z';

describe('composeOpeningMove', () => {
    it('digests urgency, capped points (object and legacy string), and question count', () => {
        const digest = composeOpeningMove(
            {
                urgency: { level: 'high', reason: 'HCQ toxicity at threshold' },
                key_discussion_points: [
                    { kind: 'risk_flag', text: 'Point one' },
                    'Point two (legacy string)',
                    { kind: 'contradiction', text: 'Point three' },
                    { kind: 'imaging', text: 'Point four — must be capped away' },
                ],
                questions_to_confirm: ['q1', 'q2'],
            },
            PREPARED_AT,
        );
        expect(digest).toContain('I read the record during check-in (brief prepared 2026-07-11).');
        expect(digest).toContain('Urgency: high — HCQ toxicity at threshold.');
        expect(digest).toContain('Worth discussing: 1) Point one 2) Point two (legacy string) 3) Point three');
        expect(digest).not.toContain('Point four');
        expect(digest).toContain('2 questions queued to ask the patient.');
        expect(digest).toContain('Ask me to drill in — trends, comparisons, sources; every claim stays cited.');
    });

    it('still composes from a sparse brief (no urgency, no points, no questions)', () => {
        const digest = composeOpeningMove({ key_discussion_points: [], questions_to_confirm: [] }, PREPARED_AT);
        expect(digest).toBe(
            'I read the record during check-in (brief prepared 2026-07-11). ' +
                'Ask me to drill in — trends, comparisons, sources; every claim stays cited.',
        );
    });

    it('clips oversized points and singularizes one question', () => {
        const long = 'x'.repeat(200);
        const digest = composeOpeningMove(
            { key_discussion_points: [long], questions_to_confirm: ['q1'] },
            PREPARED_AT,
        );
        expect(digest).toContain(`1) ${'x'.repeat(109)}…`);
        expect(digest).not.toContain('x'.repeat(120));
        expect(digest).toContain('1 question queued to ask the patient.');
    });

    it('returns null for non-object content — the route skips seeding, never invents', () => {
        expect(composeOpeningMove(null, PREPARED_AT)).toBeNull();
        expect(composeOpeningMove('a whole brief as a string', PREPARED_AT)).toBeNull();
        expect(composeOpeningMove([1, 2], PREPARED_AT)).toBeNull();
    });
});
