// Q3 game plan composer: ONE bounded Haiku call that turns the already-gated brief into
// the visit's who-does-what — nurse check-ins, forms, call-backs, meds to prescribe — a
// consultative proposal the physician reacts to, never a data dump. Hard rules: input is
// ONLY citation-gated brief content (no documents, no raw model output), the reply is
// schema-validated with the extraction module's exact retry discipline, and ANY failure
// yields null — the brief completes without a plan rather than failing the prep.
import { z } from 'zod';
import type { AnthropicClient } from './anthropic.js';
import { GamePlanSchema, type BriefContent, type GamePlan } from './brief.js';
import { schemaValidatedJsonCall, stripNullsDeep, type OnUsage, type PrepLogger, type Validation } from './extraction.js';

const GAME_PLAN_SYSTEM_PROMPT = `You draft the visit game plan for an ophthalmology practice.
You receive VERIFIED chart-prep content (already citation-checked). Compose the concrete plan
the care team runs for today's visit and its follow-through — who does what.

Rules:
- Use ONLY the provided content. Never invent clinical facts, values, medications, or dates.
- owner is one of: physician | nurse | front_desk | patient.
- kind is one of: order | check_in | form | call_back | prescription | monitoring | education.
- 4 to 8 items. Each action is one concrete step under 160 characters, in clinical-workflow
  language (e.g. "Repeat 10-2 visual fields and SD-OCT before dilation", "Call in 2 weeks to
  check drop tolerance and refill needs").
- timing is a short phrase ("today, before dilation", "within 2 weeks", "next visit") or null.
- summary_line is ONE sentence framing the plan around the patient's stated goal.
- Tone: a competent charge nurse's run sheet — plain, specific, calm. No alarm language.

Reply with a single JSON object only, no markdown fences:
{"summary_line": string, "items": [{"owner": string, "action": string, "timing": string|null, "kind": string}]}`;

/** The gated slice the composer sees — compact by construction (no documents, no fact dumps). */
export interface GamePlanInput {
    patientName: string;
    urgency: BriefContent['urgency'];
    patientGoal: string | null;
    chiefComplaint: string | null;
    discussionPoints: string[];
    questionsToConfirm: string[];
    medicationRisks: { medication: string; message: string; recommendation: string }[];
    imaging: {
        intervalRecommendation: string | null;
        optimalIntervalWeeks: number | null;
        hcqRecommendation: string | null;
        hcqAlertLevel: string | null;
    };
}

/** Project the assembled brief into the composer's input — the ONLY thing the model sees. */
export function gamePlanInputFromBrief(content: BriefContent, patientName: string): GamePlanInput {
    return {
        patientName,
        urgency: content.urgency,
        patientGoal: content.what_they_are_hoping_for?.content.goal ?? null,
        chiefComplaint: content.why_they_are_here?.content.statement ?? null,
        discussionPoints: content.key_discussion_points.map((point) => point.text),
        questionsToConfirm: content.questions_to_confirm,
        medicationRisks: content.medication_risk_flags.map((flag) => ({
            medication: flag.medication,
            message: flag.message,
            recommendation: flag.recommendation,
        })),
        imaging: {
            intervalRecommendation:
                content.imaging.interval_analysis.recommendation === '' ? null : content.imaging.interval_analysis.recommendation,
            optimalIntervalWeeks: content.imaging.interval_analysis.optimal_interval,
            hcqRecommendation:
                content.imaging.hcq_progression.recommendation === '' ? null : content.imaging.hcq_progression.recommendation,
            hcqAlertLevel: content.imaging.hcq_progression.gc_thickness_trend.length > 0 ? content.imaging.hcq_progression.alert_level : null,
        },
    };
}

function validateGamePlan(text: string): Validation<GamePlan> {
    let parsed: unknown;
    try {
        parsed = stripNullsDeep(JSON.parse(stripFences(text)));
    } catch (error) {
        return { ok: false, issues: [`response is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
    }
    // timing is nullable-by-contract: restore explicit nulls the strip removed.
    const checked = GamePlanSchema.safeParse(parsed);
    if (!checked.success) {
        return { ok: false, issues: checked.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`) };
    }
    return { ok: true, result: checked.data };
}

// Local fence stripper (extraction's is module-private): tolerate ```json ... ``` wrapping.
function stripFences(text: string): string {
    const trimmed = text.trim();
    const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
    return match?.[1] ?? trimmed;
}

export class GamePlanComposer {
    constructor(private readonly client: AnthropicClient) {}

    /**
     * Compose the plan, or null on ANY failure — the game plan is an enhancement on the
     * brief, never a gate on it (the caller stores null and the prep completes).
     */
    async compose(input: GamePlanInput, correlationId: string, logger: PrepLogger, onUsage?: OnUsage): Promise<GamePlan | null> {
        try {
            return await schemaValidatedJsonCall(
                this.client,
                GAME_PLAN_SYSTEM_PROMPT,
                JSON.stringify(input, null, 1),
                'game_plan',
                validateGamePlan,
                correlationId,
                logger,
                onUsage,
            );
        } catch (error) {
            logger.warn(
                { correlationId, err: error instanceof Error ? error.message : String(error) },
                'game plan composition failed — brief proceeds without a plan',
            );
            return null;
        }
    }
}
