// Medical Background tab (Q7/Q8 home) — the full clinical record: medications with their
// risk story, allergies, medical history, findings, vitals, and histories, as cards of fact
// rows with laterality + verification badges and citation chips. Chief complaint and patient
// goals are NOT repeated here — they live on the Overview's "Why are we here today?" card.
// No brief required: this renders straight from GET /api/overview.
import {
    Pill,
    AlertTriangle,
    Stethoscope,
    Eye,
    Scan,
    History,
    Activity,
    Users,
    Home,
    Check,
    ExternalLink,
    Info,
} from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import type { FactType, MedicationRiskFlag, PatientFact } from './types';
import { Card, LateralityBadge, VerificationBadge, formatDate, titleCase } from './ui';
import { CitationChips } from './CitationChip';
import { OriginBadge, factOrigin } from './OriginBadge';

const GROUPS: { type: FactType; title: string; icon: ComponentType<{ className?: string }> }[] = [
    { type: 'medication', title: 'Medications', icon: Pill },
    { type: 'allergy', title: 'Allergies', icon: AlertTriangle },
    // Q7: conditions read as the patient's medical history here, beside meds + allergies.
    { type: 'condition', title: 'Medical History', icon: Stethoscope },
    { type: 'clinical_finding', title: 'Clinical Findings', icon: Eye },
    { type: 'imaging_finding', title: 'Imaging Findings', icon: Scan },
    { type: 'procedure_history', title: 'Procedure History', icon: History },
    { type: 'vital_sign', title: 'Vitals', icon: Activity },
    { type: 'family_history', title: 'Family Ocular History', icon: Users },
    { type: 'social_history', title: 'Social History', icon: Home },
];

// ---- Medication risk rendering (Q8: moved here from the Overview with the meds) ----

const FLAG_STYLES: Record<MedicationRiskFlag['severity'], { container: string; icon: string; title: string; badge: string }> = {
    high: { container: 'bg-red-50 border-red-200', icon: 'text-red-600', title: 'text-red-800', badge: 'bg-red-100 text-red-700 border-red-200' },
    medium: { container: 'bg-amber-50 border-amber-200', icon: 'text-amber-600', title: 'text-amber-800', badge: 'bg-amber-100 text-amber-700 border-amber-200' },
    low: { container: 'bg-blue-50 border-blue-200', icon: 'text-blue-600', title: 'text-blue-800', badge: 'bg-blue-100 text-blue-700 border-blue-200' },
};

/** Compact severity-styled badge shown inline on the medication row. */
export function RiskFlagBadge({ flag }: { flag: MedicationRiskFlag }) {
    const styles = FLAG_STYLES[flag.severity];
    return (
        <span
            data-testid="med-risk-badge"
            title={flag.message}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-xs font-semibold ${styles.badge}`}
        >
            <AlertTriangle className="w-3 h-3" />
            {titleCase(flag.flag_type)} · {flag.severity.toUpperCase()}
        </span>
    );
}

/** Flags matched to a medication row by name (flag.medication mirrors the fact's name). */
export function flagsForMedication(name: string, flags: MedicationRiskFlag[]): MedicationRiskFlag[] {
    const lower = name.toLowerCase();
    return flags.filter((flag) => {
        const flagName = flag.medication.toLowerCase();
        return flagName === lower || lower.includes(flagName) || flagName.includes(lower);
    });
}

export function MedicationRiskFlags({ flags }: { flags: MedicationRiskFlag[] }) {
    if (flags.length === 0) {
        return null;
    }
    return (
        <Card className="p-5" data-testid="med-risk-section">
            <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2 mb-3">
                <Pill className="w-4 h-4 text-slate-400" />
                Medication Risk Alerts
                <span className="text-xs font-normal text-slate-400">({flags.length})</span>
            </h3>
            <div className="space-y-3">
                {flags.map((flag, index) => {
                    const styles = FLAG_STYLES[flag.severity];
                    const Icon = flag.severity === 'high' ? AlertTriangle : Info;
                    return (
                        <div key={index} className={`p-4 rounded-lg border ${styles.container}`}>
                            <div className="flex items-start gap-3">
                                <Icon className={`w-5 h-5 ${styles.icon} flex-shrink-0 mt-0.5`} />
                                <div className="flex-1">
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className={`font-medium ${styles.title}`}>{flag.medication}</span>
                                        <span className={`inline-flex px-2 py-0.5 rounded-md border text-xs font-medium ${styles.badge}`}>
                                            {flag.flag_type.replace(/_/g, ' ')}
                                        </span>
                                        <span className={`inline-flex px-2 py-0.5 rounded-md border text-xs font-semibold uppercase ${styles.badge}`}>
                                            {flag.severity}
                                        </span>
                                    </div>
                                    <p className="text-sm text-slate-700">{flag.message}</p>
                                    {flag.recommendation !== '' && (
                                        <p className="text-sm text-slate-600 mt-2">
                                            <span className="font-medium">Recommendation:</span> {flag.recommendation}
                                        </p>
                                    )}
                                    {flag.details !== undefined && (
                                        <p className="mt-2 text-xs text-slate-500">
                                            Duration: {flag.details.duration_years} years · Cumulative: ~{flag.details.cumulative_dose_grams}g ·{' '}
                                            {flag.details.daily_dose_mg} mg/day
                                        </p>
                                    )}
                                    {flag.source !== '' && (
                                        <p className="text-xs text-slate-400 mt-2 italic flex items-center gap-1">
                                            <ExternalLink className="w-3 h-3" />
                                            {flag.source}
                                        </p>
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </Card>
    );
}

/** Primary line + secondary detail per fact type. Exhaustive switch: a new fact type fails the build. */
export function factSummary(fact: PatientFact): { primary: string; secondary: string[] } {
    switch (fact.fact_type) {
        case 'medication': {
            const c = fact.content;
            return {
                primary: [c.name, c.dose, c.frequency, c.route].filter((part) => part !== undefined && part !== '').join(' · '),
                secondary: [
                    c.indication !== undefined ? `For ${c.indication}` : '',
                    c.start_date != null ? `Since ${formatDate(c.start_date)}` : '',
                    c.end_date != null && c.end_date !== '' ? `Ended ${formatDate(c.end_date)}` : '',
                    c.prescriber != null ? `Prescriber: ${c.prescriber}` : '',
                ].filter((part) => part !== ''),
            };
        }
        case 'allergy': {
            const c = fact.content;
            return {
                primary: c.substance,
                secondary: [c.reaction ?? '', c.severity !== undefined ? `Severity: ${c.severity}` : ''].filter((part) => part !== ''),
            };
        }
        case 'condition': {
            const c = fact.content;
            return {
                primary: c.icd10 !== undefined ? `${c.name} (${c.icd10})` : c.name,
                secondary: [c.status ?? '', c.since !== undefined ? `Since ${c.since}` : ''].filter((part) => part !== ''),
            };
        }
        case 'clinical_finding': {
            const c = fact.content;
            return {
                primary: c.finding,
                secondary: [c.body_part ?? '', c.severity !== undefined ? `Severity: ${c.severity}` : ''].filter((part) => part !== ''),
            };
        }
        case 'imaging_finding': {
            const c = fact.content;
            return {
                primary: c.finding_type.replace(/_/g, ' '),
                secondary: [c.severity !== undefined ? `Severity: ${c.severity}` : ''].filter((part) => part !== ''),
            };
        }
        case 'procedure_history': {
            const c = fact.content;
            return {
                primary: c.procedure,
                secondary: [c.date !== undefined ? formatDate(c.date) : '', c.performed_by ?? ''].filter((part) => part !== ''),
            };
        }
        case 'vital_sign': {
            const c = fact.content;
            return {
                primary: `${c.name}: ${String(c.value)}${c.units !== undefined ? ` ${c.units}` : ''}`,
                secondary: [c.captured_at !== undefined ? formatDate(c.captured_at) : ''].filter((part) => part !== ''),
            };
        }
        case 'social_history': {
            const c = fact.content;
            return {
                primary: `${c.category.replace(/_/g, ' ')}: ${c.value}`,
                secondary: [c.notes ?? ''].filter((part) => part !== ''),
            };
        }
        case 'family_history': {
            const c = fact.content;
            return {
                primary: `${c.relative}: ${c.condition}`,
                secondary: [
                    c.age_at_diagnosis != null ? `Diagnosed at ${String(c.age_at_diagnosis)}` : '',
                    c.outcome ?? '',
                ].filter((part) => part !== ''),
            };
        }
        case 'chief_complaint':
            return { primary: fact.content.statement, secondary: [fact.content.onset ?? ''].filter((part) => part !== '') };
        case 'patient_goal':
            return { primary: fact.content.goal, secondary: [] };
    }
}

/** Shared fact row (Overview cards reuse it); `badges` prepends extra chips, e.g. med risk flags.
 * When `canVerify` is set and the fact is not already verified, a role-gated Verify button appears
 * (S3.3) — only the Medical Background tab passes it, so Overview stays read-only. */
export function FactRow({
    fact,
    badges,
    canVerify,
    onVerify,
}: {
    fact: PatientFact;
    badges?: ReactNode;
    canVerify?: boolean;
    onVerify?: (factId: string) => void;
}) {
    const { primary, secondary } = factSummary(fact);
    const showVerify = canVerify === true && onVerify !== undefined && fact.verification.status !== 'verified';
    return (
        <div className="flex items-start justify-between gap-3 py-3 border-b border-slate-100 last:border-0">
            <div className="min-w-0">
                {/* div, not p: the chip popover nests block elements */}
                <div className="text-sm font-medium text-slate-700">
                    {primary}
                    <CitationChips citations={fact.sources} />
                </div>
                {secondary.length > 0 && <p className="text-xs text-slate-500 mt-0.5">{secondary.join(' · ')}</p>}
            </div>
            <div className="flex items-center gap-1.5 flex-wrap justify-end flex-shrink-0">
                {badges}
                <OriginBadge origin={factOrigin(fact)} />
                {fact.laterality !== null && <LateralityBadge laterality={fact.laterality} />}
                <VerificationBadge status={fact.verification.status} />
                {showVerify && (
                    <button
                        type="button"
                        aria-label={`Verify ${primary}`}
                        onClick={() => onVerify(fact.id)}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-emerald-300 text-[11px] font-medium text-emerald-700 hover:bg-emerald-50 transition-colors"
                    >
                        <Check className="w-3 h-3" />
                        Verify
                    </button>
                )}
            </div>
        </div>
    );
}

export default function MedicalBackground({
    factsByType,
    riskFlags = [],
    canVerify,
    onVerify,
}: {
    factsByType: Partial<Record<FactType, PatientFact[]>>;
    /** Q8: deterministic med-risk flags render here beside the medications they flag. */
    riskFlags?: MedicationRiskFlag[];
    /** True when the current clinician's role may verify facts (physician / resident) — S3.3. */
    canVerify?: boolean;
    onVerify?: (factId: string) => void;
}) {
    const groups = GROUPS.map(({ type, title, icon }) => ({ type, title, icon, facts: factsByType[type] ?? [] })).filter(
        ({ facts }) => facts.length > 0,
    );
    if (groups.length === 0) {
        return <p className="text-sm text-slate-500 py-8 text-center">No verified facts on record for this patient.</p>;
    }
    return (
        <div className="space-y-6">
            {groups.map(({ type, title, icon: Icon, facts }) => (
                <div key={type} className="space-y-6">
                    <Card className="p-5">
                        <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2 mb-1">
                            <Icon className="w-4 h-4 text-slate-400" />
                            {title}
                            <span className="text-xs font-normal text-slate-400">({facts.length})</span>
                        </h3>
                        <div>
                            {facts.map((fact) => (
                                <FactRow
                                    key={fact.id}
                                    fact={fact}
                                    canVerify={canVerify}
                                    onVerify={onVerify}
                                    badges={
                                        fact.fact_type === 'medication'
                                            ? flagsForMedication(fact.content.name, riskFlags).map((flag, i) => (
                                                  <RiskFlagBadge key={i} flag={flag} />
                                              ))
                                            : undefined
                                    }
                                />
                            ))}
                        </div>
                    </Card>
                    {/* The risk detail rides directly under the medication list it annotates. */}
                    {type === 'medication' && <MedicationRiskFlags flags={riskFlags} />}
                </div>
            ))}
        </div>
    );
}
