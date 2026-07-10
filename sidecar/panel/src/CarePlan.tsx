// Diagnosis & Care tab (R3) — rendered deterministically on first load from the overview
// payload's care_plan block (sidecar routes/overview.ts buildOverview). No LLM anywhere:
// active conditions resolve fact ids against the overview facts (the shared condition row
// with citation chips), and the protocol / monitoring / follow-up cards render the pure
// engine outputs. Single-line rows — the whole tab reads in seconds.
import { AlertTriangle, CalendarClock, ClipboardList, Info, PhoneCall, Pill, Sparkles, Stethoscope, Syringe, UserRound } from 'lucide-react';
import type { ComponentType } from 'react';
import type { CarePlan as CarePlanData, GamePlan, GamePlanItem, PatientFact } from './types';
import { Card, SectionLabel, formatDate, titleCase } from './ui';
import { FactRow } from './MedicalBackground';
import { medicationLabel } from './imaging/badges';

const MONITOR_STYLES: Record<'high' | 'medium' | 'low', { container: string; icon: string }> = {
    high: { container: 'bg-red-50 border-red-200 text-red-800', icon: 'text-red-600' },
    medium: { container: 'bg-amber-50 border-amber-200 text-amber-800', icon: 'text-amber-600' },
    low: { container: 'bg-blue-50 border-blue-200 text-blue-800', icon: 'text-blue-600' },
};

const CONFIDENCE_BADGES: Record<'high' | 'medium' | 'low', string> = {
    high: 'border-emerald-300 text-emerald-700',
    medium: 'border-amber-300 text-amber-700',
    low: 'border-slate-300 text-slate-500',
};

// ---- Q3: the game plan — who does what, composed from the citation-gated brief ----

const OWNER_LABELS: Record<GamePlanItem['owner'], string> = {
    physician: 'Physician',
    nurse: 'Nurse',
    front_desk: 'Front desk',
    patient: 'Patient',
};
const OWNER_ORDER: GamePlanItem['owner'][] = ['physician', 'nurse', 'front_desk', 'patient'];

const KIND_ICONS: Record<GamePlanItem['kind'], ComponentType<{ className?: string }>> = {
    order: Stethoscope,
    check_in: UserRound,
    form: ClipboardList,
    call_back: PhoneCall,
    prescription: Pill,
    monitoring: CalendarClock,
    education: Info,
};

/** The run-sheet card: grouped by owner, one concrete action per row, timing at the right. */
export function GamePlanCard({ gamePlan }: { gamePlan: GamePlan }) {
    const byOwner = OWNER_ORDER.map((owner) => ({
        owner,
        items: gamePlan.items.filter((item) => item.owner === owner),
    })).filter((group) => group.items.length > 0);
    return (
        <section data-testid="game-plan">
            <SectionLabel>
                <Sparkles className="w-4 h-4" />
                Today&rsquo;s Game Plan
            </SectionLabel>
            <Card className="p-5">
                <p className="text-[15px] font-medium text-slate-800 leading-snug">{gamePlan.summary_line}</p>
                <div className="mt-4 space-y-4">
                    {byOwner.map(({ owner, items }) => (
                        <div key={owner}>
                            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1.5">{OWNER_LABELS[owner]}</p>
                            <ul className="space-y-1">
                                {items.map((item, index) => {
                                    const Icon = KIND_ICONS[item.kind];
                                    return (
                                        <li key={index} className="flex items-start justify-between gap-3 py-1.5 border-b border-slate-100 last:border-0">
                                            <span className="flex items-start gap-2 text-sm text-slate-700 min-w-0">
                                                <Icon className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5" />
                                                <span>{item.action}</span>
                                            </span>
                                            <span className="flex items-center gap-1.5 flex-shrink-0">
                                                {item.timing !== null && item.timing !== '' && (
                                                    <span className="inline-flex px-2 py-0.5 rounded-full bg-slate-100 text-[11px] text-slate-600">{item.timing}</span>
                                                )}
                                                <span className="inline-flex px-1.5 py-0.5 rounded-md border border-slate-200 text-[10px] text-slate-400">
                                                    {titleCase(item.kind)}
                                                </span>
                                            </span>
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>
                    ))}
                </div>
                <p className="mt-4 text-xs text-slate-400 flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5" />
                    AI-drafted proposal from the citation-gated brief — confirm before acting.
                </p>
            </Card>
        </section>
    );
}

export default function CarePlan({
    carePlan,
    conditions,
    gamePlan = null,
}: {
    carePlan: CarePlanData;
    /** The overview's condition facts — active_condition_fact_ids resolve against these. */
    conditions: PatientFact[];
    /** Q3: from the latest brief when one exists; null renders the deterministic tab as before. */
    gamePlan?: GamePlan | null;
}) {
    const active = carePlan.active_condition_fact_ids
        .map((id) => conditions.find((fact) => fact.id === id))
        .filter((fact): fact is PatientFact => fact !== undefined);
    const protocol = carePlan.protocol;
    const followUp = carePlan.follow_up;

    return (
        <div className="space-y-8">
            {gamePlan !== null && <GamePlanCard gamePlan={gamePlan} />}

            <section>
                <SectionLabel>
                    <Stethoscope className="w-4 h-4" />
                    Active Conditions ({active.length})
                </SectionLabel>
                {active.length === 0 ? (
                    <Card className="p-4">
                        <p className="text-sm text-slate-400">No active conditions on record.</p>
                    </Card>
                ) : (
                    <Card className="px-5 py-1">
                        {active.map((fact) => (
                            <FactRow key={fact.id} fact={fact} />
                        ))}
                    </Card>
                )}
            </section>

            <section>
                <SectionLabel>
                    <Syringe className="w-4 h-4" />
                    Current Protocol
                </SectionLabel>
                <Card className="p-4">
                    {protocol === null ? (
                        <p className="text-sm text-slate-400">No active treatment protocol on record.</p>
                    ) : (
                        <div data-testid="protocol-card" className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                            <span className="text-sm font-medium text-slate-800">
                                {protocol.medication !== null ? medicationLabel(protocol.medication) : 'Treatment'} protocol
                            </span>
                            <span className="text-sm text-slate-600">
                                {protocol.treatment_count} injection{protocol.treatment_count !== 1 ? 's' : ''} on record
                            </span>
                            <span className="text-sm text-slate-500">Last: {formatDate(protocol.last_treatment_date)}</span>
                        </div>
                    )}
                </Card>
            </section>

            <section>
                <SectionLabel>
                    <AlertTriangle className="w-4 h-4" />
                    Monitoring ({carePlan.monitoring.length})
                </SectionLabel>
                {carePlan.monitoring.length === 0 ? (
                    <Card className="p-4">
                        <p className="text-sm text-slate-400">No monitoring recommendations on record.</p>
                    </Card>
                ) : (
                    <ul className="space-y-2">
                        {carePlan.monitoring.map((item, index) => {
                            const styles = MONITOR_STYLES[item.severity];
                            const Icon = item.severity === 'high' ? AlertTriangle : Info;
                            return (
                                <li
                                    key={index}
                                    data-testid="monitoring-item"
                                    className={`flex items-center gap-2 p-2.5 rounded-lg border text-sm ${styles.container}`}
                                >
                                    <Icon className={`w-4 h-4 flex-shrink-0 ${styles.icon}`} />
                                    <span className="min-w-0 truncate" title={item.text}>
                                        {item.text}
                                    </span>
                                    <span className="ml-auto flex-shrink-0 text-xs italic opacity-75">{item.source}</span>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </section>

            <section>
                <SectionLabel>
                    <CalendarClock className="w-4 h-4" />
                    Follow-up
                </SectionLabel>
                <Card className="p-4">
                    <div data-testid="follow-up-card">
                        <div className="flex flex-wrap items-center gap-2">
                            {followUp.optimal_interval_weeks !== null && (
                                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium bg-blue-50 text-blue-700 border-blue-200">
                                    <CalendarClock className="w-3.5 h-3.5" />
                                    Optimal: {followUp.optimal_interval_weeks} weeks
                                </span>
                            )}
                            <span className={`inline-flex px-2 py-0.5 rounded-md border text-xs font-medium ${CONFIDENCE_BADGES[followUp.confidence]}`}>
                                {followUp.confidence} confidence
                            </span>
                        </div>
                        <p className="text-sm text-slate-700 mt-2">
                            {followUp.recommendation ?? 'No interval recommendation yet — more treatment-response cycles are needed.'}
                        </p>
                    </div>
                </Card>
            </section>
        </div>
    );
}
