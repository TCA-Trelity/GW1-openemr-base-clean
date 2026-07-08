// Injection-interval ladder (research brief §3 must-have #3): the treat-and-extend visualization.
// Each anti-VEGF cycle's interval (weeks) is a bar colored by its outcome — dry (extend) emerald,
// leaked (shorten) red — with the engine's optimal_interval drawn as a reference line. William's
// 49→71d over-extension reads as a red bar spiking above the optimal line, then a short emerald
// rescue bar. Interval weeks + outcome are authored/server-computed (interval_analysis.intervals);
// the reference line is the engine's optimal_interval, not an invented threshold.
import { Bar, BarChart, Cell, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { IntervalPatternAnalysis, TreatmentResponseAssessment } from '../types';
import { Card } from '../ui';
import { medicationLabel } from './badges';

export const OUTCOME_FILL: Record<TreatmentResponseAssessment, string> = {
    good_response: '#10b981', // emerald-500 — dry, interval held/extended
    worsened: '#ef4444', // red-500 — leaked, shorten
    no_response: '#ef4444',
    partial_response: '#f59e0b', // amber-500
};

const OUTCOME_TEXT: Record<TreatmentResponseAssessment, string> = {
    good_response: 'Dry',
    worsened: 'Leaked',
    no_response: 'Leaked',
    partial_response: 'Partial',
};

export interface LadderDatum {
    label: string;
    weeks: number;
    outcome: TreatmentResponseAssessment;
    date: string | undefined;
    medication: string | undefined;
}

function shortDate(iso: string | undefined): string | undefined {
    if (iso === undefined || iso === '') {
        return undefined;
    }
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
        ? undefined
        : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** One bar per treat-and-extend cycle: interval weeks + outcome, straight from the engine's intervals[]. */
export function buildLadderData(analysis: IntervalPatternAnalysis): LadderDatum[] {
    return analysis.intervals.map((interval, index) => ({
        label: shortDate(interval.image_date) ?? `Cycle ${index + 1}`,
        weeks: interval.interval_weeks,
        outcome: interval.outcome,
        date: shortDate(interval.image_date),
        medication: interval.medication,
    }));
}

function LadderTooltip({ active, payload }: { active?: boolean; payload?: { payload: LadderDatum }[] }) {
    if (active !== true || payload === undefined || payload[0] === undefined) {
        return null;
    }
    const datum = payload[0].payload;
    return (
        <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-sm">
            <p className="font-semibold text-slate-800">{datum.weeks}-week interval</p>
            <p className="text-slate-500">
                {OUTCOME_TEXT[datum.outcome]}
                {datum.date !== undefined && ` · ${datum.date}`}
                {datum.medication !== undefined && ` · ${medicationLabel(datum.medication)}`}
            </p>
        </div>
    );
}

export default function IntervalLadder({ analysis }: { analysis: IntervalPatternAnalysis }) {
    if (analysis.intervals.length === 0) {
        return null;
    }

    const data = buildLadderData(analysis);
    const maxWeeks = Math.max(...data.map((datum) => datum.weeks), analysis.optimal_interval ?? 0);

    return (
        <Card className="p-5">
            <div data-testid="interval-ladder">
            <h3 className="text-base font-semibold text-slate-800 mb-1">Treat-and-Extend Interval Ladder</h3>
            <p className="text-xs text-slate-500 mb-3">
                Weeks between injection and follow-up scan, colored by outcome. Bars above the optimal line are
                over-extensions.
            </p>
            <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data} margin={{ top: 16, right: 12, left: 0, bottom: 0 }}>
                        <XAxis dataKey="label" stroke="#64748b" fontSize={12} />
                        <YAxis
                            stroke="#64748b"
                            fontSize={12}
                            domain={[0, Math.ceil((maxWeeks + 2) / 2) * 2]}
                            label={{ value: 'weeks', angle: -90, position: 'insideLeft', fill: '#94a3b8', fontSize: 11 }}
                        />
                        <Tooltip content={<LadderTooltip />} cursor={{ fill: '#f1f5f9' }} />
                        {analysis.optimal_interval !== null && (
                            <ReferenceLine
                                y={analysis.optimal_interval}
                                stroke="#059669"
                                strokeDasharray="4 3"
                                label={{
                                    value: `Optimal ${analysis.optimal_interval} wk`,
                                    fill: '#047857',
                                    fontSize: 11,
                                    position: 'right',
                                }}
                            />
                        )}
                        <Bar dataKey="weeks" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                            <LabelList dataKey="weeks" position="top" fontSize={11} fill="#475569" />
                            {data.map((datum, index) => (
                                <Cell key={index} fill={OUTCOME_FILL[datum.outcome]} />
                            ))}
                        </Bar>
                    </BarChart>
                </ResponsiveContainer>
            </div>
            <div className="flex items-center gap-4 mt-3 text-xs text-slate-500">
                <span className="inline-flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: OUTCOME_FILL.good_response }} />
                    Dry (extend)
                </span>
                <span className="inline-flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: OUTCOME_FILL.worsened }} />
                    Leaked (shorten)
                </span>
                <span className="inline-flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: OUTCOME_FILL.partial_response }} />
                    Partial
                </span>
            </div>
            </div>
        </Card>
    );
}
