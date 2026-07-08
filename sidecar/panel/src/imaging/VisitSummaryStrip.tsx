// Visit summary strip (research brief §3 must-have #4): the baseline→latest one-glance numbers
// across the top of the Imaging tab. Adaptive — each card renders only when the patient has that
// data, so William (CST + treat-and-extend) and Margaret (CST + GC-IPL, no injections) each get
// the cards their record supports and nothing is zero-filled.
import { Activity, AlertTriangle, CalendarClock, ShieldCheck } from 'lucide-react';
import type { TreatmentResponseAssessment } from '../types';
import { Card } from '../ui';
import { DeltaBadge } from './delta';
import { FluidChip } from './fluid';
import type { AlertLevel, MetricSummary, VisitSummary } from './summary';

function StatCard({ children }: { children: React.ReactNode }) {
    return <Card className="p-3 min-w-0">{children}</Card>;
}

function CardLabel({ children }: { children: React.ReactNode }) {
    return <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">{children}</p>;
}

function MetricCard({ metric }: { metric: MetricSummary }) {
    return (
        <StatCard>
            <CardLabel>{metric.label}</CardLabel>
            <div className="flex items-baseline gap-1.5 flex-wrap">
                <span className="text-lg font-bold text-slate-800">{metric.latestValue}</span>
                {metric.unit !== undefined && <span className="text-xs text-slate-400">{metric.unit}</span>}
                {metric.delta !== null && (
                    <DeltaBadge delta={metric.delta} polarity={metric.polarity} caption="vs base" />
                )}
            </div>
            <p className="text-[11px] text-slate-400 mt-0.5">
                baseline {metric.baselineValue}
                {metric.referenceRange !== undefined && (
                    <span>
                        {' '}
                        · normal {metric.referenceRange.normal_min}–{metric.referenceRange.normal_max}
                    </span>
                )}
            </p>
        </StatCard>
    );
}

const OUTCOME_LABEL: Record<TreatmentResponseAssessment, { label: string; className: string }> = {
    good_response: { label: 'Dry', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
    worsened: { label: 'Leaked', className: 'bg-red-50 text-red-700 border-red-200' },
    no_response: { label: 'Leaked', className: 'bg-red-50 text-red-700 border-red-200' },
    partial_response: { label: 'Partial', className: 'bg-amber-50 text-amber-700 border-amber-200' },
};

const ALERT_CONFIG: Record<AlertLevel, { label: string; className: string; icon: typeof ShieldCheck }> = {
    low: { label: 'None', className: 'bg-emerald-50 text-emerald-700 border-emerald-200', icon: ShieldCheck },
    medium: { label: 'Watch', className: 'bg-amber-50 text-amber-700 border-amber-200', icon: AlertTriangle },
    high: { label: 'High', className: 'bg-red-50 text-red-700 border-red-200', icon: AlertTriangle },
};

export default function VisitSummaryStrip({ summary }: { summary: VisitSummary }) {
    const alert = ALERT_CONFIG[summary.alertLevel];
    const AlertIcon = alert.icon;
    return (
        <div
            data-testid="visit-summary-strip"
            className="grid gap-3 mb-5 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:auto-cols-fr xl:grid-flow-col"
        >
            {summary.metrics.map((metric) => (
                <MetricCard key={metric.measurementType} metric={metric} />
            ))}

            {summary.fluid !== null && summary.fluid.state !== 'unknown' && (
                <StatCard>
                    <CardLabel>
                        <span className="inline-flex items-center gap-1">
                            <Activity className="w-3 h-3" />
                            Current fluid
                        </span>
                    </CardLabel>
                    <FluidChip status={summary.fluid} className="text-sm px-2.5 py-1" />
                </StatCard>
            )}

            {summary.interval !== null && (
                <StatCard>
                    <CardLabel>
                        <span className="inline-flex items-center gap-1">
                            <CalendarClock className="w-3 h-3" />
                            Latest interval
                        </span>
                    </CardLabel>
                    <div className="flex items-baseline gap-1.5">
                        <span className="text-lg font-bold text-slate-800">{summary.interval.weeks}</span>
                        <span className="text-xs text-slate-400">weeks</span>
                        <span
                            data-testid="summary-interval-outcome"
                            className={`inline-flex px-2 py-0.5 rounded-md border text-[11px] font-medium ${OUTCOME_LABEL[summary.interval.outcome].className}`}
                        >
                            {OUTCOME_LABEL[summary.interval.outcome].label}
                        </span>
                    </div>
                </StatCard>
            )}

            <StatCard>
                <CardLabel>Alert level</CardLabel>
                <div className="flex items-center gap-1.5">
                    <span
                        data-testid="summary-alert-level"
                        data-alert-level={summary.alertLevel}
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-xs font-medium ${alert.className}`}
                    >
                        <AlertIcon className="w-3.5 h-3.5" />
                        {alert.label}
                    </span>
                    {summary.alertSource !== null && summary.alertLevel !== 'low' && (
                        <span className="text-[11px] text-slate-400 truncate">{summary.alertSource}</span>
                    )}
                </div>
            </StatCard>
        </div>
    );
}
