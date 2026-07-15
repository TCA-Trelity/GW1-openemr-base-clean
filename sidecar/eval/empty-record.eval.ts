// Eval: empty-record-boundary (S2.5). A patient with a registered but empty record (no
// facts, no images, no documents, no treatments) must render as ABSENCE, not as an error
// and not as invented content: buildOverview returns a well-formed payload with empty
// groups, zero risk flags, and the engines' documented empty shapes. This is the
// "missing information is absence, not an estimate" invariant at the API-assembly level.
import { isDeepStrictEqual } from 'node:util';
import { describe, it } from 'vitest';
import { buildOverview } from '../src/routes/overview.js';
import type { FactBundle } from '../src/store/index.js';
import { recordEval } from './collector.js';

const NOW = new Date('2026-01-15T09:00:00Z');

describe('empty-record-boundary', () => {
    it('buildOverview over an empty-but-valid bundle renders absence as absence', () => {
        const bundle: FactBundle = {
            patient: { id: 'empty-patient', openemr_patient_id: null, name: 'Empty Record', demographics: {} },
            facts: [],
            contradictions: [],
            images: [],
            treatments: [],
            documents: [],
        };

        let overview: Record<string, unknown> | undefined;
        let threw: string | undefined;
        try {
            overview = buildOverview(bundle, null, NOW);
        } catch (error) {
            threw = error instanceof Error ? error.message : String(error);
        }

        // The full deterministic expectation: every group empty, every engine at its
        // documented empty shape, nothing invented to fill the gaps.
        const expected = {
            patient: bundle.patient,
            facts_by_type: {},
            medication_risk_flags: [],
            care_plan: {
                active_condition_fact_ids: [],
                protocol: null,
                monitoring: [],
                follow_up: { recommendation: null, optimal_interval_weeks: null, confidence: 'low' },
            },
            contradictions: [],
            documents: [],
            images: [],
            imaging: {
                timeline_summary: [],
                interval_analysis: {
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
                },
                hcq_progression: {
                    gc_thickness_trend: [],
                    rpe_changes_trend: [],
                    progression_detected: false,
                    progression_description: '',
                    alert_level: 'low',
                    recommendation: 'Continue routine HCQ monitoring per AAO guidelines',
                },
            },
            latest_brief: null,
            generated_at: NOW.toISOString(),
        };

        const pass = threw === undefined && isDeepStrictEqual(overview, expected);

        recordEval({
            id: 'empty-record-boundary.overview',
            description:
                'buildOverview over a no-facts/no-images/no-docs bundle returns a well-formed payload: empty groups, zero risk flags, no throw',
            metric: 'well-formed empty payload',
            value:
                threw !== undefined
                    ? `threw: ${threw}`
                    : pass
                      ? '0 facts, 0 flags, 0 contradictions, 0 images/docs; engines at empty shapes; no throw'
                      : 'payload diverged from the documented empty shape',
            threshold: 'exact deterministic empty payload (absence rendered as absence)',
            pass,
            difficulty: 'edge-case',
        });
    });
});
