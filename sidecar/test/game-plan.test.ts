// Game-plan composer tests (Q3): schema-validated single call with the extraction retry
// discipline, null-on-failure (a plan is an enhancement, never a gate), and the input
// projection that guarantees the model only ever sees citation-gated brief content.
import { describe, expect, it, vi } from 'vitest';
import { AnthropicClient, type FetchLike } from '../src/prep/anthropic.js';
import { BriefContentSchema, type BriefContent } from '../src/prep/brief.js';
import { GamePlanComposer, gamePlanInputFromBrief } from '../src/prep/gamePlan.js';
import type { PrepLogger } from '../src/prep/extraction.js';

const silentLogger: PrepLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

function sseEvents(events: Record<string, unknown>[]): string {
    return events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

function llmResponse(payload: unknown, stopReason = 'end_turn'): Response {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const mid = Math.ceil(text.length / 2);
    return new Response(
        sseEvents([
            { type: 'message_start', message: { model: 'claude-haiku-4-5', usage: { input_tokens: 400, output_tokens: 3 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, mid) } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(mid) } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 200 } },
            { type: 'message_stop' },
        ]),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
}

function composerWith(...responses: Response[]) {
    const fetchMock = vi.fn<FetchLike>();
    for (const response of responses) {
        fetchMock.mockResolvedValueOnce(response);
    }
    const client = new AnthropicClient({ apiKey: 'test-key', model: 'claude-haiku-4-5', fetchImpl: fetchMock });
    return { composer: new GamePlanComposer(client), fetchMock };
}

const VALID_PLAN = {
    summary_line: "Protect Margaret's vision through the wedding: rule out a tear today, lock the screening cadence.",
    items: [
        { owner: 'physician', action: 'Complete dilated peripheral exam with scleral depression', timing: 'today', kind: 'order' },
        { owner: 'nurse', action: 'Repeat 10-2 visual fields and SD-OCT before dilation', timing: 'today, before dilation', kind: 'order' },
        { owner: 'front_desk', action: 'Book annual HCQ screening follow-up', timing: 'before leaving', kind: 'form' },
        { owner: 'nurse', action: 'Call in 2 weeks to check symptoms have not progressed', timing: 'within 2 weeks', kind: 'call_back' },
    ],
};

const INPUT = {
    patientName: 'Margaret L. Chen',
    urgency: { level: 'high' as const, reason: 'test' },
    patientGoal: 'goal',
    chiefComplaint: 'cc',
    discussionPoints: ['point'],
    questionsToConfirm: ['q'],
    medicationRisks: [],
    imaging: { intervalRecommendation: null, optimalIntervalWeeks: null, hcqRecommendation: null, hcqAlertLevel: null },
};

describe('GamePlanComposer', () => {
    // Guards: the happy path — a schema-valid reply becomes the typed plan, timing nulls intact.
    it('returns a validated plan from one call', async () => {
        const { composer, fetchMock } = composerWith(llmResponse(VALID_PLAN));
        const plan = await composer.compose(INPUT, 'corr-gp', silentLogger);
        expect(plan).not.toBeNull();
        expect(plan?.items).toHaveLength(4);
        expect(plan?.items[0]?.owner).toBe('physician');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        // The user content is the projected input — gated content only, never documents.
        const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { messages: { content: string }[] };
        expect(body.messages[0]?.content).toContain('Margaret L. Chen');
    });

    // Guards: the feedback retry — an invalid owner enum comes back corrected on attempt 2.
    it('feedback-retries a schema-invalid reply once', async () => {
        const invalid = { ...VALID_PLAN, items: [{ ...VALID_PLAN.items[0], owner: 'doctor' }, VALID_PLAN.items[1]] };
        const { composer, fetchMock } = composerWith(llmResponse(invalid), llmResponse(VALID_PLAN));
        const plan = await composer.compose(INPUT, 'corr-gp-retry', silentLogger);
        expect(plan?.items).toHaveLength(4);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    // Guards: THE contract — composition failure must yield null, never a thrown error
    // (a game plan is an enhancement on the brief, not a gate on the prep).
    it('returns null when both attempts fail, without throwing', async () => {
        const { composer } = composerWith(llmResponse('not json at all'), llmResponse('still not json'));
        await expect(composer.compose(INPUT, 'corr-gp-fail', silentLogger)).resolves.toBeNull();
    });
});

describe('gamePlanInputFromBrief', () => {
    // Guards: the projection is the model's entire world — it must carry the gated slices
    // (goal, complaint, points, risks, imaging recs) and nothing document-shaped.
    it('projects only gated brief content', () => {
        const content: BriefContent = BriefContentSchema.parse({
            urgency: { level: 'high', reason: 'sulfa allergy conflict' },
            contradiction_alerts: [],
            why_they_are_here: null,
            what_they_are_hoping_for: null,
            key_discussion_points: [{ text: 'HCQ duration conflicts across sources', kind: 'contradiction', fact_ids: [], contradiction_id: null }],
            questions_to_confirm: ['How long on hydroxychloroquine?'],
            medication_risk_flags: [],
            imaging: {
                timeline_summary: [],
                interval_analysis: {
                    intervals: [],
                    pattern_summary: { total_cycles: 0, good_response_count: 0, poor_response_count: 0, average_interval: null },
                    optimal_interval: 7,
                    recommendation: 'Recommend 7-week intervals.',
                    confidence: 'high',
                },
                hcq_progression: {
                    gc_thickness_trend: [],
                    rpe_changes_trend: [],
                    progression_detected: false,
                    progression_description: '',
                    alert_level: 'low',
                    recommendation: '',
                },
            },
            facts_by_type: {},
            gate_metrics: { claims: 0, verified: 0, blocked: 0, citationsChecked: 0, citationsFailed: 0 },
            prepared_at: '2026-07-10T00:00:00.000Z',
            correlation_id: 'corr-x',
        });
        const input = gamePlanInputFromBrief(content, 'Margaret L. Chen');
        expect(input.patientGoal).toBeNull();
        expect(input.discussionPoints).toEqual(['HCQ duration conflicts across sources']);
        expect(input.imaging.optimalIntervalWeeks).toBe(7);
        expect(input.imaging.intervalRecommendation).toBe('Recommend 7-week intervals.');
        // gc trend empty ⇒ HCQ alert suppressed (no invented signal for non-HCQ patients).
        expect(input.imaging.hcqAlertLevel).toBeNull();
        expect(JSON.stringify(input)).not.toContain('text_content');
    });
});
