// Medical Background tab — deterministic overview.facts_by_type groups as cards; each fact
// row carries laterality + verification badges and its citation chips (ClinicalDetail.jsx
// look). No brief required: this renders straight from GET /api/overview.
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
    Target,
    MessageSquare,
} from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import type { FactType, PatientFact } from './types';
import { Card, LateralityBadge, VerificationBadge, formatDate } from './ui';
import { CitationChips } from './CitationChip';
import { OriginBadge, factOrigin } from './OriginBadge';

const GROUPS: { type: FactType; title: string; icon: ComponentType<{ className?: string }> }[] = [
    { type: 'medication', title: 'Medications', icon: Pill },
    { type: 'allergy', title: 'Allergies', icon: AlertTriangle },
    { type: 'condition', title: 'Conditions', icon: Stethoscope },
    { type: 'clinical_finding', title: 'Clinical Findings', icon: Eye },
    { type: 'imaging_finding', title: 'Imaging Findings', icon: Scan },
    { type: 'procedure_history', title: 'Procedure History', icon: History },
    { type: 'vital_sign', title: 'Vitals', icon: Activity },
    { type: 'family_history', title: 'Family Ocular History', icon: Users },
    { type: 'social_history', title: 'Social History', icon: Home },
    { type: 'chief_complaint', title: 'Chief Complaint', icon: MessageSquare },
    { type: 'patient_goal', title: 'Patient Goals', icon: Target },
];

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

/** Shared fact row (Overview cards reuse it); `badges` prepends extra chips, e.g. med risk flags. */
export function FactRow({ fact, badges }: { fact: PatientFact; badges?: ReactNode }) {
    const { primary, secondary } = factSummary(fact);
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
            </div>
        </div>
    );
}

export default function MedicalBackground({ factsByType }: { factsByType: Partial<Record<FactType, PatientFact[]>> }) {
    const groups = GROUPS.map(({ type, title, icon }) => ({ type, title, icon, facts: factsByType[type] ?? [] })).filter(
        ({ facts }) => facts.length > 0,
    );
    if (groups.length === 0) {
        return <p className="text-sm text-slate-500 py-8 text-center">No verified facts on record for this patient.</p>;
    }
    return (
        <div className="space-y-6">
            {groups.map(({ type, title, icon: Icon, facts }) => (
                <Card key={type} className="p-5">
                    <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2 mb-1">
                        <Icon className="w-4 h-4 text-slate-400" />
                        {title}
                        <span className="text-xs font-normal text-slate-400">({facts.length})</span>
                    </h3>
                    <div>
                        {facts.map((fact) => (
                            <FactRow key={fact.id} fact={fact} />
                        ))}
                    </div>
                </Card>
            ))}
        </div>
    );
}
