// Eval: calculator-goldens (S2.5). Runs the REAL pure engines over the REAL seed corpora
// and locks the clinically load-bearing outputs the demo narrative depends on: Margaret's
// HCQ retinal-toxicity flag fires HIGH at her authored visit date, her serial OCTs show
// the authored ganglion-cell decline as a progression alert, and William's injection
// series carries the 49→71-day interval over-extension with a flagged worsened cycle.
// The engines' branch/boundary behavior is unit-tested exhaustively in
// test/engines.test.ts with synthetic fixtures; these evals are the corpus-level
// acceptance numbers over the authored records themselves.
import { isDeepStrictEqual } from 'node:util';
import { describe, it } from 'vitest';
import {
    analyzeHCQProgression,
    analyzeIntervalPatterns,
    calculateMedicationDurationYears,
    computeMedicationRiskFlags,
    type MedicationInput,
} from '../src/engines/index.js';
import { DEFAULT_PROVIDER_PROFILE } from '../src/schemas/index.js';
import { recordEval } from './collector.js';
import { margaretChen, williamThompson } from './corpus.js';

// Margaret's authored visit date: HCQ (first fill 2019-01-15) is ~5.9 years in — the
// same clock test/prep.test.ts pins for the pipeline end-to-end run.
const MARGARET_VISIT = new Date('2024-12-26T12:00:00Z');

const DAY_MS = 24 * 60 * 60 * 1000;

describe('calculator-goldens', () => {
    it('HCQ risk flag fires HIGH for Margaret at the corpus visit date (~5.9y on 200mg)', () => {
        // The same start_date -> "N years" duration bridge buildOverview and the prep
        // pipeline use before calling the engine.
        const inputs: MedicationInput[] = [];
        for (const fact of margaretChen.facts) {
            if (fact.fact_type !== 'medication') {
                continue;
            }
            const years = calculateMedicationDurationYears(
                { start_date: fact.content.start_date ?? undefined },
                MARGARET_VISIT,
            );
            const input: MedicationInput = { content: fact.content };
            if (years !== null && years >= 0) {
                input.duration = `${Math.floor(years)} years`;
            }
            inputs.push(input);
        }

        const flags = computeMedicationRiskFlags(inputs, DEFAULT_PROVIDER_PROFILE);
        const hcqFlags = flags.filter((flag) => flag.flag_type === 'retinal_toxicity');
        const hcq = hcqFlags[0];

        const pass =
            hcqFlags.length === 1 &&
            hcq !== undefined &&
            hcq.severity === 'high' &&
            hcq.message === 'HCQ use 5+ years (est. 365g cumulative) — HIGH retinal toxicity risk per AAO guidelines' &&
            hcq.recommendation === 'Require annual retinal screening with 10-2 VF, SD-OCT, and FAF' &&
            isDeepStrictEqual(hcq.details, { duration_years: 5, cumulative_dose_grams: 365, daily_dose_mg: 200 });

        recordEval({
            id: 'calculator-goldens.hcq-risk-flag',
            description:
                "Margaret's authored HCQ medication (start 2019-01-15, 200mg) trips the AAO >= 5-year HIGH branch at the 2024-12-26 visit",
            metric: 'retinal_toxicity flag severity + dose arithmetic',
            value:
                hcq === undefined
                    ? 'no retinal_toxicity flag fired'
                    : `severity=${hcq.severity}; ${hcq.details?.duration_years ?? '?'}y @ ${hcq.details?.daily_dose_mg ?? '?'}mg = ${hcq.details?.cumulative_dose_grams ?? '?'}g cumulative`,
            threshold: 'severity=high; 5y @ 200mg = 365g (AAO 2016 rev. 2020 golden)',
            pass,
        });
    });

    it("Margaret's serial OCTs raise a non-null HCQ progression alert from the authored GC decline", () => {
        const result = analyzeHCQProgression(margaretChen.images);
        const first = result.gc_thickness_trend[0];
        const last = result.gc_thickness_trend[result.gc_thickness_trend.length - 1];

        const pass =
            result.progression_detected &&
            result.alert_level === 'high' &&
            result.gc_thickness_trend.length === 6 &&
            first?.value === 82 &&
            last?.value === 70 &&
            result.progression_description ===
                'Ganglion cell layer thinning of 12 microns detected over 6 images. Progressive RPE changes noted across serial images' &&
            result.recommendation === 'Consider rheumatology consultation regarding HCQ discontinuation';

        recordEval({
            id: 'calculator-goldens.hcq-progression',
            description:
                "Margaret's authored GC series (82→70 microns over 6 OCTs) plus RPE escalation (mild→moderate) is detected as progression",
            metric: 'alert_level + trend endpoints',
            value: `alert_level=${result.alert_level} (non-null); GC ${first?.value ?? '?'}→${last?.value ?? '?'} microns over ${result.gc_thickness_trend.length} images; detected=${result.progression_detected}`,
            threshold: 'alert_level=high; 12-micron decline detected; rheumatology-consult recommendation',
            pass,
        });
    });

    it("William's injection series carries the 49→71-day over-extension and the engine flags the worsened cycle", () => {
        // Ground truth straight from the authored treatment dates: three inter-injection
        // gaps, the last stretched from 49 to 71 days.
        const injectionTimes = williamThompson.treatments
            .filter((treatment) => treatment.treatment_type === 'anti_vegf_injection')
            .map((treatment) => new Date(treatment.treatment_date).getTime())
            .sort((a, b) => a - b);
        const gapDays = injectionTimes.slice(1).map((time, i) => Math.round((time - (injectionTimes[i] ?? 0)) / DAY_MS));

        // Ground truth on the authored scan at the over-extension: 71 days post-injection,
        // assessed as worsened (fluid recurrence at the extended interval).
        const overExtensionScan = williamThompson.images.find((image) => image.id === 'img-wt-005');
        const authoredDaysSince = overExtensionScan?.treatment_context?.days_since_last_treatment;
        const authoredAssessment = overExtensionScan?.ai_analysis?.comparison_to_prior?.treatment_response?.assessment;

        // The real engine over the real corpus (same inputs buildOverview feeds it).
        const analysis = analyzeIntervalPatterns(williamThompson.images, williamThompson.treatments);

        const pass =
            isDeepStrictEqual(gapDays, [49, 49, 71]) &&
            authoredDaysSince === 71 &&
            authoredAssessment === 'worsened' &&
            analysis.pattern_summary.total_cycles === 6 &&
            analysis.pattern_summary.good_response_count === 5 &&
            analysis.pattern_summary.poor_response_count === 1 &&
            analysis.intervals.some((interval) => interval.outcome === 'worsened') &&
            analysis.optimal_interval === 7 &&
            analysis.confidence === 'high';

        recordEval({
            id: 'calculator-goldens.interval-over-extension',
            description:
                "William's 4 injections span gaps of 49/49/71 days; the 71-day extension's scan is worsened and the engine derives a 7-week optimal interval",
            metric: 'injection gaps + worsened cycle + optimal interval',
            value: `gaps=${gapDays.join('/')}d; authored over-extension scan: ${String(authoredDaysSince)}d post-injection, ${String(authoredAssessment)}; engine: ${analysis.pattern_summary.poor_response_count} worsened of ${analysis.pattern_summary.total_cycles} cycles, optimal_interval=${String(analysis.optimal_interval)}wk (confidence=${analysis.confidence})`,
            threshold: 'gaps 49/49/71d; worsened cycle flagged; optimal_interval=7wk at high confidence',
            pass,
            notes:
                'Engine/corpus seam surfaced by this eval: three OCTs are captured hours AFTER a same-day injection, and the engine (dates-only treatment timestamps, strict `<` match) attributes them to that same-day injection at a 0-week interval — including the worsened 71-day-extension scan. The worsened cycle IS flagged (poor_response_count=1) and the 7-week optimal interval IS derived, but the headline recommendation string comes from the "consistently stable" branch rather than the "leaked at 10 weeks" branch the synthetic unit-test series produces. Recorded honestly rather than patched around; candidate fix tracked as future work (match scans to the last treatment strictly before the capture DATE, not datetime).',
        });
    });
});
