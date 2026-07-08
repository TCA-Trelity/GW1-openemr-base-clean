// Golden-number tests for the S1.3 pure clinical engines. Every threshold and string here
// is copied from the second-opinion prototype (medicationRiskFlags.jsx, imagingAnalysis.jsx)
// — each test names the failure mode it guards (project convention).
import { describe, expect, it } from 'vitest';
import {
    analyzeHCQProgression,
    analyzeIntervalPatterns,
    calculateMedicationDurationYears,
    computeComparison,
    computeMedicationRiskFlags,
    computeTreatmentContext,
    severityToNumber,
} from '../src/engines/index.js';
import {
    DEFAULT_PROVIDER_PROFILE,
    ImageRecordSchema,
    TreatmentRecordSchema,
} from '../src/schemas/index.js';
import type { ImageRecord, TreatmentContext, TreatmentRecord } from '../src/schemas/index.js';

// ---------------------------------------------------------------------------
// Fixture builders — parsed through the landed schemas so the tests double as
// proof that schema-shaped records feed the engines without adaptation.
// ---------------------------------------------------------------------------

function injection(n: number, treatment_date: string): TreatmentRecord {
    return TreatmentRecordSchema.parse({
        id: `tx-${n}`,
        treatment_type: 'anti_vegf_injection',
        treatment_date,
        injection_details: { medication: 'Eylea', dose: '2mg', injection_number: n },
    });
}

function octWithResponse(
    n: number,
    capture_date: string,
    assessment: 'good_response' | 'worsened' | 'no_response' | 'partial_response',
): ImageRecord {
    return ImageRecordSchema.parse({
        id: `img-${n}`,
        image_metadata: { capture_date, modality: 'oct', laterality: 'od' },
        ai_analysis: { comparison_to_prior: { treatment_response: { assessment } } },
    });
}

function gcImage(id: string, capture_date: string, value: number): ImageRecord {
    return ImageRecordSchema.parse({
        id,
        image_metadata: { capture_date, modality: 'oct', laterality: 'od' },
        ai_analysis: {
            measurements: [{ measurement_type: 'ganglion_cell_thickness', value, unit: 'microns' }],
        },
    });
}

function rpeImage(
    id: string,
    capture_date: string,
    severity: 'mild' | 'moderate' | 'severe',
): ImageRecord {
    return ImageRecordSchema.parse({
        id,
        image_metadata: { capture_date, modality: 'oct', laterality: 'od' },
        ai_analysis: {
            findings: [{ finding_type: 'rpe_changes', severity, confidence: 0.8 }],
        },
    });
}

function context(days: number | null): TreatmentContext {
    return {
        days_since_last_treatment: days,
        last_treatment: null,
        interval_from_prior_image: null,
        treatment_cycle_number: 1,
    };
}

// ---------------------------------------------------------------------------
// (a) computeMedicationRiskFlags — HCQ dose/duration arithmetic and every rule
// ---------------------------------------------------------------------------

describe('computeMedicationRiskFlags — HCQ retinal toxicity', () => {
    // Guards: the canonical 400mg x 5y case dropping below 'high' or the cumulative-dose
    // arithmetic (400*365*5/1000 = 730g) drifting from the prototype.
    it('flags 400mg x 5 years as high with 730g cumulative', () => {
        const flags = computeMedicationRiskFlags([
            { content: { name: 'Hydroxychloroquine', duration: '5 years', dose: '400mg daily' } },
        ]);
        expect(flags).toHaveLength(1);
        expect(flags[0]).toEqual({
            medication: 'Hydroxychloroquine',
            flag_type: 'retinal_toxicity',
            severity: 'high',
            message: 'HCQ use 5+ years (est. 730g cumulative) — HIGH retinal toxicity risk per AAO guidelines',
            recommendation: 'Require annual retinal screening with 10-2 VF, SD-OCT, and FAF',
            source: 'AAO HCQ Screening Guidelines 2016 (revised 2020)',
            details: { duration_years: 5, cumulative_dose_grams: 730, daily_dose_mg: 400 },
        });
    });

    // Guards: the independent >=1000g cumulative branch — 800mg x 4y = 1168g must be high
    // even though 4 years is below the 5-year threshold.
    it('flags via the 1000g cumulative-dose branch below the year threshold', () => {
        const flags = computeMedicationRiskFlags([
            { content: { name: 'Plaquenil', duration: '4 years', dose: '800 mg' } },
        ]);
        expect(flags[0].severity).toBe('high');
        expect(flags[0].message).toBe(
            'HCQ use 4+ years (est. 1168g cumulative) — HIGH retinal toxicity risk per AAO guidelines',
        );
        expect(flags[0].details).toEqual({
            duration_years: 4,
            cumulative_dose_grams: 1168,
            daily_dose_mg: 800,
        });
    });

    // Guards: the exact >= boundary at hcq_high_risk_years (5) — off-by-one would demote
    // the canonical AAO threshold case to medium.
    it('treats exactly 5 years as high (boundary is inclusive)', () => {
        const flags = computeMedicationRiskFlags([
            { content: { name: 'hydroxychloroquine', duration: '5 years', dose: '200mg' } },
        ]);
        expect(flags[0].severity).toBe('high');
    });

    // Guards: the exact years-2 medium boundary (3 years with default threshold 5).
    it('treats exactly threshold-2 years (3y) as medium with the approaching message', () => {
        const flags = computeMedicationRiskFlags([
            { content: { name: 'Hydroxychloroquine', duration: '3 years', dose: '200mg' } },
        ]);
        expect(flags[0].severity).toBe('medium');
        expect(flags[0].message).toBe('HCQ use 3 years — approaching AAO screening threshold');
        expect(flags[0].recommendation).toBe('Standard monitoring per AAO guidelines');
    });

    // Guards: short-duration HCQ escalating spuriously.
    it('treats 2 years as low with the routine-monitoring message', () => {
        const flags = computeMedicationRiskFlags([
            { content: { name: 'Hydroxychloroquine', duration: '2 years', dose: '200mg' } },
        ]);
        expect(flags[0].severity).toBe('low');
        expect(flags[0].message).toBe('HCQ use 2 years — routine monitoring');
    });

    // Guards: the 200mg default daily dose when the dose string is absent (5y -> 365g).
    it('defaults the daily dose to 200mg when no dose is given', () => {
        const flags = computeMedicationRiskFlags([
            { content: { name: 'Hydroxychloroquine', duration: '5 years' } },
        ]);
        expect(flags[0].details).toEqual({
            duration_years: 5,
            cumulative_dose_grams: 365,
            daily_dose_mg: 200,
        });
    });

    // Guards: provider-configured hcq_high_risk_years being ignored — with threshold 7,
    // 5 years must land in the medium band (>= 7-2), not high.
    it('respects a provider-configured hcq_high_risk_years threshold', () => {
        const profile = { risk_sensitivity: { thresholds: { hcq_high_risk_years: 7 } } };
        const five = computeMedicationRiskFlags(
            [{ content: { name: 'Hydroxychloroquine', duration: '5 years', dose: '200mg' } }],
            profile,
        );
        expect(five[0].severity).toBe('medium');
        const seven = computeMedicationRiskFlags(
            [{ content: { name: 'Hydroxychloroquine', duration: '7 years', dose: '200mg' } }],
            profile,
        );
        expect(seven[0].severity).toBe('high');
    });

    // Guards: the landed ProviderProfile schema type no longer being accepted by the engine.
    it('accepts the schema DEFAULT_PROVIDER_PROFILE as the provider profile', () => {
        const flags = computeMedicationRiskFlags(
            [{ content: { name: 'Hydroxychloroquine', duration: '5 years', dose: '400mg' } }],
            DEFAULT_PROVIDER_PROFILE,
        );
        expect(flags[0].severity).toBe('high');
    });

    // Guards: the prototype's parseDuration quirk — a year figure zeroes any month figure,
    // and month-only durations contribute 0 years.
    it('preserves parseDuration quirks (year zeroes months; months alone count 0 years)', () => {
        const mixed = computeMedicationRiskFlags([
            { content: { name: 'Hydroxychloroquine', duration: '2 years 6 months', dose: '200mg' } },
        ]);
        expect(mixed[0].details?.duration_years).toBe(2);
        const monthsOnly = computeMedicationRiskFlags([
            { content: { name: 'Hydroxychloroquine', duration: '18 months', dose: '200mg' } },
        ]);
        expect(monthsOnly[0].details?.duration_years).toBe(0);
        expect(monthsOnly[0].message).toBe('HCQ use 0 years — routine monitoring');
    });

    // Guards: the "4+ years" duration format the corpus uses.
    it('parses the "4+ years" duration format', () => {
        const flags = computeMedicationRiskFlags([
            { content: { name: 'Hydroxychloroquine', duration: '4+ years', dose: '200mg' } },
        ]);
        expect(flags[0].details?.duration_years).toBe(4);
        expect(flags[0].severity).toBe('medium');
    });
});

describe('computeMedicationRiskFlags — other rules', () => {
    // Guards: anticoagulant detection via top-level name (no content wrapper) and the
    // non-retina default recommendation.
    it('flags warfarin as bleeding_risk with the generic recommendation', () => {
        const flags = computeMedicationRiskFlags([{ name: 'Warfarin' }]);
        expect(flags).toHaveLength(1);
        expect(flags[0]).toEqual({
            medication: 'warfarin',
            flag_type: 'bleeding_risk',
            severity: 'medium',
            message: 'On warfarin — bleeding risk for injections/procedures',
            recommendation: 'Document anticoagulation status before any procedure',
            source: 'Clinical practice',
        });
    });

    // Guards: the retina-subspecialty recommendation branch.
    it('switches the bleeding_risk recommendation for retina specialists', () => {
        const flags = computeMedicationRiskFlags([{ content: { name: 'Eliquis' } }], {
            specialty: { primary: 'Ophthalmology', subspecialty: 'Retina' },
        });
        expect(flags[0].recommendation).toBe(
            'Consider timing of anti-VEGF injections; generally safe to continue but note for subretinal hemorrhage risk assessment',
        );
    });

    // Guards: aspirin staying in the anticoagulant substring list.
    it('flags aspirin as bleeding_risk', () => {
        const flags = computeMedicationRiskFlags([{ content: { name: 'Aspirin 81mg' } }]);
        expect(flags[0].flag_type).toBe('bleeding_risk');
    });

    // Guards: the steroid IOP rule and its exact recommendation string.
    it('flags prednisone as iop_risk', () => {
        const flags = computeMedicationRiskFlags([{ content: { name: 'Prednisone' } }]);
        expect(flags[0]).toEqual({
            medication: 'Prednisone',
            flag_type: 'iop_risk',
            severity: 'medium',
            message: 'On Prednisone — monitor for steroid-induced IOP elevation',
            recommendation: 'Check IOP at each visit; consider steroid-sparing alternatives if elevated',
            source: 'Clinical practice',
        });
    });

    // Guards: the IFIS rule being demoted from high — it drives cataract-surgery planning.
    it('flags tamsulosin as high-severity ifis_risk', () => {
        const flags = computeMedicationRiskFlags([{ content: { name: 'Flomax (tamsulosin)' } }]);
        expect(flags[0].flag_type).toBe('ifis_risk');
        expect(flags[0].severity).toBe('high');
        expect(flags[0].source).toBe('AAO Cataract Surgery Guidelines');
    });

    // Guards: diabetes medications triggering the retinopathy-screening flag.
    it('flags metformin as diabetic_screening', () => {
        const flags = computeMedicationRiskFlags([{ content: { name: 'Metformin' } }]);
        expect(flags[0].flag_type).toBe('diabetic_screening');
        expect(flags[0].recommendation).toBe('Annual dilated fundus exam; document retinopathy status');
    });

    // Guards: severity ordering — high flags must sort ahead of medium regardless of
    // medication input order.
    it('sorts flags high-first', () => {
        const flags = computeMedicationRiskFlags([
            { content: { name: 'Metformin' } },
            { content: { name: 'Tamsulosin' } },
        ]);
        expect(flags.map((f) => f.flag_type)).toEqual(['ifis_risk', 'diabetic_screening']);
    });

    // Guards: custom high-priority regex matching, the exact message join, and the
    // configured boost being carried through.
    it('flags provider-configured high-priority medications', () => {
        const flags = computeMedicationRiskFlags([{ content: { name: 'Dupixent' } }], {
            relevance_configuration: {
                high_priority_medications: [
                    {
                        pattern: 'dupixent',
                        reason: 'Ocular surface disease risk',
                        recommendation: 'Ask about eye dryness',
                        relevance_boost: 0.5,
                    },
                ],
            },
        });
        expect(flags).toHaveLength(1);
        expect(flags[0]).toEqual({
            medication: 'Dupixent',
            flag_type: 'custom_priority',
            severity: 'medium',
            message: 'Dupixent — Ocular surface disease risk',
            recommendation: 'Ask about eye dryness',
            source: 'Provider Configuration',
            relevance_boost: 0.5,
        });
    });

    // Guards: the 0.3 default boost / default recommendation, and the duplicate-flag
    // suppression for repeated medication names.
    it('defaults custom-flag boost to 0.3 and de-duplicates repeated names', () => {
        const profile = {
            relevance_configuration: {
                high_priority_medications: [{ pattern: 'dupixent', reason: 'watch' }],
            },
        };
        const flags = computeMedicationRiskFlags(
            [{ content: { name: 'Dupixent' } }, { content: { name: 'Dupixent' } }],
            profile,
        );
        expect(flags).toHaveLength(1);
        expect(flags[0].relevance_boost).toBe(0.3);
        expect(flags[0].recommendation).toBe('Review as configured in provider settings');
    });

    // Guards: the empty-input boundary — no medications means no flags, not a throw.
    it('returns [] for an empty medication list', () => {
        expect(computeMedicationRiskFlags([])).toEqual([]);
    });
});

describe('calculateMedicationDurationYears', () => {
    const now = new Date('2026-07-08T00:00:00Z');

    // Guards: unit conversion goldens from medicationRiskService.jsx:204-213.
    it('converts duration strings (years/months/weeks) exactly', () => {
        expect(calculateMedicationDurationYears({ duration: '5 years' }, now)).toBe(5);
        expect(calculateMedicationDurationYears({ duration: '18 months' }, now)).toBe(1.5);
        expect(calculateMedicationDurationYears({ duration: '26 weeks' }, now)).toBe(0.5);
    });

    // Guards: clock injection — start_date arithmetic must be deterministic against the
    // provided now. 2019-07-08 -> 2026-07-08 spans 2557 days = floor(7.0007) = 7.
    it('computes years from start_date against the injected clock', () => {
        expect(calculateMedicationDurationYears({ start_date: '2019-07-08' }, now)).toBe(7);
        expect(calculateMedicationDurationYears({ startDate: '2019-07-08' }, now)).toBe(7);
    });

    // Guards: the prototype's floor(days/365.25) quirk — exactly 6 calendar years with one
    // leap day (2191 days) reports 5. A "fix" here would diverge from validated behavior.
    it('preserves the 365.25 floor quirk (6 calendar years -> 5)', () => {
        expect(calculateMedicationDurationYears({ start_date: '2020-07-08' }, now)).toBe(5);
    });

    // Guards: duration string taking precedence over start_date, and an unparseable
    // duration falling through to start_date.
    it('prefers a parseable duration string over start_date', () => {
        expect(
            calculateMedicationDurationYears({ duration: '2 years', start_date: '2019-07-08' }, now),
        ).toBe(2);
        expect(
            calculateMedicationDurationYears({ duration: 'chronic', start_date: '2019-07-08' }, now),
        ).toBe(7);
    });

    // Guards: the null boundary when neither duration nor start date exists.
    it('returns null when no duration information exists', () => {
        expect(calculateMedicationDurationYears({ name: 'HCQ' }, now)).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// (d) computeTreatmentContext — days-since arithmetic
// ---------------------------------------------------------------------------

describe('computeTreatmentContext', () => {
    // Guards: exact day arithmetic (2025-01-10 -> 2025-03-01 = 50 days) and selection of
    // the most recent prior treatment, not the first.
    it('computes exact days since the most recent prior treatment', () => {
        const ctx = computeTreatmentContext('2025-03-01', [
            injection(2, '2024-12-01'),
            injection(3, '2025-01-10'),
        ]);
        expect(ctx).toEqual({
            days_since_last_treatment: 50,
            last_treatment: { medication: 'Eylea', date: '2025-01-10', dose: '2mg' },
            interval_from_prior_image: null,
            treatment_cycle_number: 3,
        });
    });

    // Guards: the strict < comparison — a same-day treatment must not count as prior.
    it('excludes treatments on the capture date itself', () => {
        const ctx = computeTreatmentContext('2025-03-01', [
            injection(3, '2025-01-10'),
            injection(4, '2025-03-01'),
        ]);
        expect(ctx.days_since_last_treatment).toBe(50);
        expect(ctx.treatment_cycle_number).toBe(3);
    });

    // Guards: the prototype's empty-input early-return shape (null/null/null/cycle 1).
    it('returns the no-prior-treatment shape for empty or future-only treatments', () => {
        const empty = computeTreatmentContext('2025-03-01', []);
        expect(empty).toEqual({
            days_since_last_treatment: null,
            last_treatment: null,
            interval_from_prior_image: null,
            treatment_cycle_number: 1,
        });
        expect(computeTreatmentContext('2025-03-01', [injection(5, '2025-04-01')])).toEqual(empty);
    });

    // Guards: medication_start-style events (injection_details null) falling back to
    // treatment_type and cycle 1.
    it('falls back to treatment_type when injection_details is null', () => {
        const medStart = TreatmentRecordSchema.parse({
            id: 'tx-med-start',
            treatment_type: 'medication_start',
            treatment_date: '2021-12-01',
            injection_details: null,
        });
        const ctx = computeTreatmentContext('2021-12-31', [medStart]);
        expect(ctx.last_treatment?.medication).toBe('medication_start');
        expect(ctx.last_treatment?.dose).toBeUndefined();
        expect(ctx.treatment_cycle_number).toBe(1);
        expect(ctx.days_since_last_treatment).toBe(30);
    });
});

// ---------------------------------------------------------------------------
// computeComparison — the deterministic diff
// ---------------------------------------------------------------------------

describe('computeComparison', () => {
    // Guards: resolved-finding detection, the formatFindingType label in the description,
    // and the good_response classification with the exact weeks arithmetic (49d -> 7wk).
    it('reports resolved fluid as improved with good_response at 7 weeks', () => {
        const result = computeComparison(
            [{ finding_type: 'normal' }],
            [],
            { findings: [{ finding_type: 'subretinal_fluid' }] },
            context(49),
        );
        expect(result.changes).toEqual([
            {
                finding_type: 'subretinal_fluid',
                change_type: 'resolved',
                description: 'Subretinal fluid has resolved',
            },
        ]);
        expect(result.overall_change).toBe('improved');
        expect(result.treatment_response).toEqual({
            assessment: 'good_response',
            confidence: 0.85,
            rationale: 'Macula dry at 7 weeks post-treatment',
        });
    });

    // Guards: new-finding detection and the worsened classification with the 71d -> 10wk
    // rationale (the William Thompson over-extension didactic).
    it('reports new fluid as worsened with the fluid-recurrence rationale at 10 weeks', () => {
        const result = computeComparison(
            [{ finding_type: 'subretinal_fluid' }],
            [],
            { findings: [{ finding_type: 'normal' }] },
            context(71),
        );
        expect(result.changes).toEqual([
            {
                finding_type: 'subretinal_fluid',
                change_type: 'new',
                description: 'New Subretinal fluid detected',
            },
        ]);
        expect(result.overall_change).toBe('worsened');
        expect(result.treatment_response).toEqual({
            assessment: 'worsened',
            confidence: 0.82,
            rationale: 'Fluid recurrence at 10 weeks — may need shorter interval',
        });
    });

    // Guards: CRT delta arithmetic and direction (265 -> 320 = +55 microns, worsened).
    it('reports a CRT increase over 20 microns as worsened with the exact delta', () => {
        const result = computeComparison(
            [{ finding_type: 'drusen' }],
            [{ measurement_type: 'central_retinal_thickness', value: 320 }],
            {
                findings: [{ finding_type: 'drusen' }],
                measurements: [{ measurement_type: 'central_retinal_thickness', value: 265 }],
            },
            context(null),
        );
        expect(result.changes).toEqual([
            {
                finding_type: 'central_retinal_thickness',
                change_type: 'worsened',
                description: 'CRT increased by 55 microns',
                measurement_delta: 55,
            },
        ]);
        expect(result.overall_change).toBe('worsened');
    });

    // Guards: the strict > 20 boundary — a delta of exactly 20 microns is NOT a change.
    it('ignores a CRT delta of exactly 20 microns', () => {
        const result = computeComparison(
            [],
            [{ measurement_type: 'central_retinal_thickness', value: 285 }],
            { measurements: [{ measurement_type: 'central_retinal_thickness', value: 265 }] },
            context(null),
        );
        expect(result.changes).toEqual([]);
        expect(result.overall_change).toBe('stable');
    });

    // Guards: the improved direction of the CRT rule (320 -> 290 = -30).
    it('reports a CRT decrease over 20 microns as improved', () => {
        const result = computeComparison(
            [],
            [{ measurement_type: 'central_retinal_thickness', value: 290 }],
            { measurements: [{ measurement_type: 'central_retinal_thickness', value: 320 }] },
            context(null),
        );
        expect(result.changes[0].change_type).toBe('improved');
        expect(result.changes[0].description).toBe('CRT decreased by 30 microns');
        expect(result.changes[0].measurement_delta).toBe(-30);
        expect(result.overall_change).toBe('improved');
    });

    // Guards: stable-with-persistent-fluid classifying as partial_response, not good.
    it('classifies persistent fluid with no changes as partial_response', () => {
        const result = computeComparison(
            [{ finding_type: 'subretinal_fluid' }],
            [],
            { findings: [{ finding_type: 'subretinal_fluid' }] },
            context(35),
        );
        expect(result.overall_change).toBe('stable');
        expect(result.treatment_response).toEqual({
            assessment: 'partial_response',
            confidence: 0.75,
            rationale: 'Persistent fluid but not worsened',
        });
    });

    // Guards: the prototype quirk that a mixed picture keeps the default no_response
    // classification (no branch matches 'mixed').
    it('keeps the default no_response for a mixed change picture', () => {
        const result = computeComparison(
            [{ finding_type: 'subretinal_fluid' }],
            [],
            { findings: [{ finding_type: 'drusen' }] },
            context(49),
        );
        expect(result.overall_change).toBe('mixed');
        expect(result.treatment_response).toEqual({
            assessment: 'no_response',
            confidence: 0.7,
            rationale: '',
        });
    });

    // Guards: the truthiness quirk — null OR zero days-since-treatment both keep the
    // default response (0 is falsy in the prototype's check).
    it('keeps the default response when days since treatment is null or 0', () => {
        for (const days of [null, 0]) {
            const result = computeComparison([], [], {}, context(days));
            expect(result.treatment_response?.assessment).toBe('no_response');
        }
    });

    // Guards: 'normal' being excluded from resolved/new changes, and the passthrough of
    // prior image id/date and interval_days from the treatment context.
    it('excludes normal findings and passes through prior image identity', () => {
        const result = computeComparison(
            [],
            [],
            { image_id: 'img-prior', capture_date: '2025-01-01', findings: [{ finding_type: 'normal' }] },
            { ...context(null), interval_from_prior_image: 42 },
        );
        expect(result.changes).toEqual([]);
        expect(result.prior_image_id).toBe('img-prior');
        expect(result.prior_image_date).toBe('2025-01-01');
        expect(result.interval_days).toBe(42);
    });

    // Guards: the fully-empty boundary shape.
    it('returns the stable/no_response shape for empty inputs', () => {
        expect(computeComparison([], [], {}, context(null))).toEqual({
            prior_image_id: undefined,
            prior_image_date: undefined,
            interval_days: null,
            overall_change: 'stable',
            changes: [],
            treatment_response: { assessment: 'no_response', confidence: 0.7, rationale: '' },
        });
    });
});

// ---------------------------------------------------------------------------
// (b) analyzeIntervalPatterns — 49d stable / 71d leak series
// ---------------------------------------------------------------------------

// William Thompson-style series: four 49-day (7-week) stable cycles, then a 71-day
// (10-week) over-extension that leaks. Dates verified by hand.
const wtTreatments = [
    injection(1, '2025-01-01'),
    injection(2, '2025-02-19'),
    injection(3, '2025-04-09'),
    injection(4, '2025-05-28'),
    injection(5, '2025-07-16'),
];
const wtImages = [
    octWithResponse(1, '2025-02-19', 'good_response'), // 49d after tx-1
    octWithResponse(2, '2025-04-09', 'good_response'), // 49d after tx-2
    octWithResponse(3, '2025-05-28', 'good_response'), // 49d after tx-3
    octWithResponse(4, '2025-07-16', 'good_response'), // 49d after tx-4
    octWithResponse(5, '2025-09-25', 'worsened'), // 71d after tx-5
];

describe('analyzeIntervalPatterns', () => {
    // Guards: THE golden scenario — 49-day stable vs 71-day leak must yield
    // optimal_interval 7 weeks and the exact recommendation string.
    it('recommends 7-week intervals for the 49d-stable / 71d-leak series', () => {
        const result = analyzeIntervalPatterns(
            [wtImages[0], wtImages[4]] as typeof wtImages,
            wtTreatments,
        );
        expect(result.intervals.map((i) => i.interval_weeks)).toEqual([7, 10]);
        expect(result.optimal_interval).toBe(7);
        expect(result.recommendation).toBe(
            'Patient stable at 7 weeks but leaked at 10 weeks. Recommend 7-week intervals.',
        );
        expect(result.confidence).toBe('low'); // only 2 samples
    });

    // Guards: full-series aggregates — interval matching to the MOST RECENT prior
    // treatment, the average rounding (38/5 = 7.6 -> 8), counts, and >=5 -> high.
    it('aggregates the full 5-cycle series with high confidence', () => {
        const result = analyzeIntervalPatterns(wtImages, wtTreatments);
        expect(result.intervals.map((i) => i.interval_weeks)).toEqual([7, 7, 7, 7, 10]);
        expect(result.intervals[0].medication).toBe('Eylea');
        expect(result.intervals[4].treatment_date).toBe('2025-07-16');
        expect(result.pattern_summary).toEqual({
            total_cycles: 5,
            good_response_count: 4,
            poor_response_count: 1,
            average_interval: 8,
        });
        expect(result.optimal_interval).toBe(7);
        expect(result.confidence).toBe('high');
    });

    // Guards: the confidence ladder boundaries (>=3 medium; >=5 high; else low).
    it('grades confidence by sample count', () => {
        expect(analyzeIntervalPatterns(wtImages.slice(0, 3), wtTreatments).confidence).toBe('medium');
        expect(analyzeIntervalPatterns(wtImages.slice(0, 4), wtTreatments).confidence).toBe('medium');
        expect(analyzeIntervalPatterns(wtImages.slice(0, 2), wtTreatments).confidence).toBe('low');
    });

    // Guards: the good-outcomes-only branch — extend recommendation (+2 weeks).
    it('recommends extending when all sampled intervals are stable', () => {
        const result = analyzeIntervalPatterns(wtImages.slice(0, 3), wtTreatments);
        expect(result.optimal_interval).toBe(7);
        expect(result.recommendation).toBe(
            'Patient consistently stable at 7-week intervals. Consider extending to 9 weeks.',
        );
    });

    // Guards: the bad-outcomes-only branch — shorten by 2 from the shortest leak.
    it('recommends shortening when all sampled intervals leak', () => {
        const treatments = [injection(1, '2025-01-01'), injection(2, '2025-03-13')];
        const images = [
            octWithResponse(1, '2025-03-13', 'worsened'), // 71d -> 10wk
            octWithResponse(2, '2025-05-15', 'worsened'), // 63d -> 9wk
        ];
        const result = analyzeIntervalPatterns(images, treatments);
        expect(result.optimal_interval).toBe(7);
        expect(result.recommendation).toBe(
            'Patient leaked at 9 weeks. Recommend shortening to 7-week intervals.',
        );
    });

    // Guards: the Math.max(4, ...) floor on the shorten recommendation.
    it('clamps the shorten recommendation at 4 weeks', () => {
        const treatments = [injection(1, '2025-01-01'), injection(2, '2025-02-05')];
        const images = [
            octWithResponse(1, '2025-02-05', 'worsened'), // 35d -> 5wk
            octWithResponse(2, '2025-03-19', 'worsened'), // 42d -> 6wk
        ];
        const result = analyzeIntervalPatterns(images, treatments);
        expect(result.optimal_interval).toBe(4);
        expect(result.recommendation).toBe(
            'Patient leaked at 5 weeks. Recommend shortening to 4-week intervals.',
        );
    });

    // Guards: the >=2 intervals gate — a single sample yields no recommendation.
    it('makes no recommendation from a single interval', () => {
        const result = analyzeIntervalPatterns([wtImages[0]] as typeof wtImages, wtTreatments);
        expect(result.pattern_summary.total_cycles).toBe(1);
        expect(result.optimal_interval).toBeNull();
        expect(result.recommendation).toBe('');
    });

    // Guards: images without a treatment_response (or without any prior treatment) being
    // skipped rather than counted as cycles.
    it('skips images with no prior treatment or no treatment response', () => {
        const noAnalysis = ImageRecordSchema.parse({
            id: 'img-raw',
            image_metadata: { capture_date: '2025-06-01', modality: 'oct', laterality: 'od' },
        });
        const beforeAnyTreatment = octWithResponse(9, '2024-12-01', 'good_response');
        const result = analyzeIntervalPatterns([noAnalysis, beforeAnyTreatment], wtTreatments);
        expect(result.intervals).toEqual([]);
        expect(result.pattern_summary.average_interval).toBeNull();
        expect(result.confidence).toBe('low');
    });

    // Guards: the prototype's empty-images early-return shape.
    it('returns the empty-analysis shape for no images', () => {
        expect(analyzeIntervalPatterns([], wtTreatments)).toEqual({
            intervals: [],
            pattern_summary: {
                total_cycles: 0,
                good_response_count: 0,
                poor_response_count: 0,
                average_interval: null,
            },
            optimal_interval: null,
            recommendation: '',
            confidence: 'low',
        });
    });
});

// ---------------------------------------------------------------------------
// (c) analyzeHCQProgression — GC decline and RPE escalation
// ---------------------------------------------------------------------------

describe('analyzeHCQProgression', () => {
    // Guards: the golden GC series 82 -> 70 microns = 12-micron decline -> progression at
    // medium alert, with the exact description and date-sorted trend (inputs unsorted).
    it('detects a 12-micron GC decline as medium-alert progression', () => {
        const result = analyzeHCQProgression([
            gcImage('img-b', '2025-06-01', 76),
            gcImage('img-a', '2025-01-01', 82),
            gcImage('img-c', '2025-12-01', 70),
        ]);
        expect(result.gc_thickness_trend.map((p) => p.value)).toEqual([82, 76, 70]);
        expect(result.progression_detected).toBe(true);
        expect(result.progression_description).toBe(
            'Ganglion cell layer thinning of 12 microns detected over 3 images',
        );
        expect(result.alert_level).toBe('medium');
        expect(result.recommendation).toBe(
            'Consider rheumatology consultation regarding HCQ discontinuation',
        );
    });

    // Guards: the >= 10 micron detection boundary (exactly 10 detects) and the >= 15
    // high-alert boundary (exactly 15 escalates).
    it('applies the 10 and 15 micron boundaries exactly', () => {
        const atTen = analyzeHCQProgression([
            gcImage('a', '2025-01-01', 82),
            gcImage('b', '2025-12-01', 72),
        ]);
        expect(atTen.progression_detected).toBe(true);
        expect(atTen.alert_level).toBe('medium');

        const atFifteen = analyzeHCQProgression([
            gcImage('a', '2025-01-01', 85),
            gcImage('b', '2025-12-01', 70),
        ]);
        expect(atFifteen.alert_level).toBe('high');
    });

    // Guards: a sub-threshold decline (82 -> 75 = 7 microns) NOT flagging progression.
    it('does not flag a decline under 10 microns', () => {
        const result = analyzeHCQProgression([
            gcImage('a', '2025-01-01', 82),
            gcImage('b', '2025-12-01', 75),
        ]);
        expect(result.progression_detected).toBe(false);
        expect(result.progression_description).toBe('');
        expect(result.alert_level).toBe('low');
        expect(result.recommendation).toBe('Continue routine HCQ monitoring per AAO guidelines');
    });

    // Guards: the first-to-last (endpoints only) semantics — a mid-series dip that
    // recovers must not flag. This is validated prototype behavior, not a bug to fix.
    it('compares only first-to-last GC values (mid-series dips ignored)', () => {
        const result = analyzeHCQProgression([
            gcImage('a', '2025-01-01', 82),
            gcImage('b', '2025-06-01', 60),
            gcImage('c', '2025-12-01', 78),
        ]);
        expect(result.progression_detected).toBe(false);
    });

    // Guards: RPE severity escalation (mild -> moderate) forcing high alert.
    it('detects RPE severity escalation as high-alert progression', () => {
        const result = analyzeHCQProgression([
            rpeImage('a', '2025-01-01', 'mild'),
            rpeImage('b', '2025-12-01', 'moderate'),
        ]);
        expect(result.progression_detected).toBe(true);
        expect(result.progression_description).toBe('Progressive RPE changes noted across serial images');
        expect(result.alert_level).toBe('high');
        expect(result.rpe_changes_trend.map((r) => r.severity)).toEqual(['mild', 'moderate']);
    });

    // Guards: severity regression (moderate -> mild) NOT counting as progression.
    it('does not flag improving RPE severity', () => {
        const result = analyzeHCQProgression([
            rpeImage('a', '2025-01-01', 'moderate'),
            rpeImage('b', '2025-12-01', 'mild'),
        ]);
        expect(result.progression_detected).toBe(false);
    });

    // Guards: the combined-description join ('. ') and RPE escalation overriding the
    // medium GC alert to high.
    it('joins GC and RPE descriptions and escalates the combined alert to high', () => {
        const combined = (id: string, date: string, gc: number, sev: 'mild' | 'moderate') =>
            ImageRecordSchema.parse({
                id,
                image_metadata: { capture_date: date, modality: 'oct', laterality: 'od' },
                ai_analysis: {
                    measurements: [{ measurement_type: 'ganglion_cell_thickness', value: gc }],
                    findings: [{ finding_type: 'rpe_changes', severity: sev, confidence: 0.8 }],
                },
            });
        const result = analyzeHCQProgression([
            combined('a', '2025-01-01', 82, 'mild'),
            combined('b', '2025-12-01', 70, 'moderate'),
        ]);
        expect(result.progression_description).toBe(
            'Ganglion cell layer thinning of 12 microns detected over 2 images. Progressive RPE changes noted across serial images',
        );
        expect(result.alert_level).toBe('high');
    });

    // Guards: the prototype's top-level capture_date fallback when image_metadata is
    // absent — legacy records must still sort into the trend correctly.
    it('sorts via the top-level capture_date fallback', () => {
        const legacy = (id: string, date: string, value: number) => ({
            id,
            capture_date: date,
            ai_analysis: {
                measurements: [{ measurement_type: 'ganglion_cell_thickness' as const, value }],
            },
        });
        const result = analyzeHCQProgression([
            legacy('b', '2025-12-01', 70),
            legacy('a', '2025-01-01', 82),
        ]);
        expect(result.gc_thickness_trend.map((p) => p.value)).toEqual([82, 70]);
        expect(result.gc_thickness_trend[0].date).toBe('2025-01-01');
        expect(result.progression_detected).toBe(true);
    });

    // Guards: the prototype's empty-images early-return shape.
    it('returns the empty-analysis shape for no images', () => {
        expect(analyzeHCQProgression([])).toEqual({
            gc_thickness_trend: [],
            rpe_changes_trend: [],
            progression_detected: false,
            progression_description: '',
            alert_level: 'low',
            recommendation: 'Continue routine HCQ monitoring per AAO guidelines',
        });
    });
});

describe('severityToNumber', () => {
    // Guards: the mild/moderate/severe ranking and the 0 fallback for unknown/absent —
    // an off ranking silently breaks RPE escalation detection.
    it('ranks severities with 0 for unknown', () => {
        expect(severityToNumber('mild')).toBe(1);
        expect(severityToNumber('moderate')).toBe(2);
        expect(severityToNumber('severe')).toBe(3);
        expect(severityToNumber('bogus')).toBe(0);
        expect(severityToNumber(undefined)).toBe(0);
    });
});
