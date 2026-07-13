// Shared primitives + design tokens ported from the second-opinion prototype:
// source-type chip palette (CitationBubble.jsx), verification badges (FactBadge.jsx),
// section labels / cards (ReadyToWalkIn.jsx, ClinicalDetail.jsx).
import type { ComponentType, ReactNode } from 'react';
import {
    Check,
    AlertTriangle,
    HelpCircle,
    User,
    Mic,
    FileText,
    Pill,
    Image,
    FlaskConical,
    Clock,
    ExternalLink,
    MicVocal,
    ClipboardList,
    MessageSquare,
    Upload,
} from 'lucide-react';
import type { FactLaterality, SourceType, VerificationStatus } from './types';

interface TypeConfig {
    icon: ComponentType<{ className?: string }>;
    color: string; // chip classes: bg + text + border (+ hover)
    label: string;
}

// Verbatim palette from CitationBubble.jsx sourceConfig, extended with the corpus
// document_type spellings (clinical_note, tech_workup, imaging, ...) used by seed docs.
export const SOURCE_TYPE_CONFIG: Record<string, TypeConfig> = {
    intake_transcript: { icon: Mic, color: 'bg-purple-50 text-purple-700 border-purple-200 hover:bg-purple-100', label: 'Intake' },
    provider_note: { icon: FileText, color: 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100', label: 'Provider Note' },
    pharmacy_record: { icon: Pill, color: 'bg-pink-50 text-pink-700 border-pink-200 hover:bg-pink-100', label: 'Pharmacy' },
    imaging_report: { icon: Image, color: 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100', label: 'Imaging' },
    lab_report: { icon: FlaskConical, color: 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100', label: 'Lab' },
    prior_visit_note: { icon: Clock, color: 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100', label: 'Prior Visit' },
    external_ehr_import: { icon: ExternalLink, color: 'bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100', label: 'External' },
    scribe_transcript: { icon: MicVocal, color: 'bg-violet-50 text-violet-700 border-violet-200 hover:bg-violet-100', label: 'Scribe' },
    patient_self_report: { icon: User, color: 'bg-teal-50 text-teal-700 border-teal-200 hover:bg-teal-100', label: 'Patient Report' },
    clinical_observation: { icon: FileText, color: 'bg-cyan-50 text-cyan-700 border-cyan-200 hover:bg-cyan-100', label: 'Clinical Obs' },
    referral_letter: { icon: ExternalLink, color: 'bg-orange-50 text-orange-700 border-orange-200 hover:bg-orange-100', label: 'Referral' },
    guideline_evidence: { icon: FileText, color: 'bg-lime-50 text-lime-700 border-lime-200 hover:bg-lime-100', label: 'Practice Protocol' },
    // Corpus document_type spellings (sidecar schemas/sources.ts DOCUMENT_TYPES):
    clinical_note: { icon: FileText, color: 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100', label: 'Clinical Note' },
    tech_workup: { icon: ClipboardList, color: 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100', label: 'Tech Workup' },
    imaging: { icon: Image, color: 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100', label: 'Imaging' },
    imaging_internal: { icon: Image, color: 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100', label: 'Imaging' },
    patient_portal_message: { icon: MessageSquare, color: 'bg-teal-50 text-teal-700 border-teal-200 hover:bg-teal-100', label: 'Portal Message' },
    patient_upload: { icon: Upload, color: 'bg-teal-50 text-teal-700 border-teal-200 hover:bg-teal-100', label: 'Patient Upload' },
    external_records: { icon: ExternalLink, color: 'bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100', label: 'External' },
};

const DEFAULT_TYPE_CONFIG: TypeConfig = SOURCE_TYPE_CONFIG['provider_note'] as TypeConfig;

export function sourceTypeConfig(type: string): TypeConfig {
    return SOURCE_TYPE_CONFIG[type] ?? DEFAULT_TYPE_CONFIG;
}

/** Narrow an arbitrary label (e.g. a contradiction source's `type`) to a SourceType. */
export function asSourceType(type: string): SourceType {
    return (SOURCE_TYPE_CONFIG[type] !== undefined ? type : 'provider_note') as SourceType;
}

// Verification badge styling from FactBadge.jsx statusConfig (+ patient_reported,
// which the sidecar adds — styled like the patient_self_report source family).
export const VERIFICATION_CONFIG: Record<VerificationStatus, { icon: ComponentType<{ className?: string }>; label: string; badgeClass: string }> = {
    verified: { icon: Check, label: 'Verified', badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
    unverified: { icon: HelpCircle, label: 'Unverified', badgeClass: 'bg-slate-50 text-slate-600 border-slate-200' },
    disputed: { icon: AlertTriangle, label: 'Disputed', badgeClass: 'bg-amber-50 text-amber-700 border-amber-200' },
    patient_reported: { icon: User, label: 'Patient reported', badgeClass: 'bg-teal-50 text-teal-700 border-teal-200' },
};

const LATERALITY_TITLES: Record<FactLaterality, string> = { OD: 'Right eye', OS: 'Left eye', OU: 'Both eyes' };

export function LateralityBadge({ laterality }: { laterality: FactLaterality }) {
    return (
        <span
            title={LATERALITY_TITLES[laterality]}
            className="inline-flex items-center px-2 py-0.5 rounded-md border text-xs font-semibold bg-indigo-50 text-indigo-700 border-indigo-200"
        >
            {laterality}
        </span>
    );
}

export function VerificationBadge({ status }: { status: VerificationStatus }) {
    const config = VERIFICATION_CONFIG[status] ?? VERIFICATION_CONFIG.unverified;
    const Icon = config.icon;
    return (
        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-xs font-medium ${config.badgeClass}`}>
            <Icon className="w-3 h-3" />
            {config.label}
        </span>
    );
}

/** Prototype's uppercase tracking-wider section label (ReadyToWalkIn.jsx). */
export function SectionLabel({ children }: { children: ReactNode }) {
    return (
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3 flex items-center gap-2">
            {children}
        </h2>
    );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
    return <div className={`bg-white rounded-xl border border-slate-200 ${className}`}>{children}</div>;
}

export function formatDate(dateString: string | null | undefined): string {
    if (dateString == null || dateString === '') {
        return '';
    }
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) {
        return dateString;
    }
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function titleCase(value: string): string {
    return value.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

// Visit-type chips for the schedule sidebar + patient header band (seed visit_type spellings).
const VISIT_TYPE_CHIPS: Record<string, { label: string; className: string }> = {
    new_patient: { label: 'New patient', className: 'bg-blue-50 text-blue-700 border-blue-200' },
    established_patient: { label: 'Established', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
    established: { label: 'Established', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
};

export function VisitTypeChip({ visitType }: { visitType: string | undefined }) {
    if (visitType === undefined || visitType === '') {
        return null;
    }
    const config = VISIT_TYPE_CHIPS[visitType] ?? {
        label: titleCase(visitType),
        className: 'bg-slate-50 text-slate-600 border-slate-200',
    };
    return (
        <span className={`inline-flex items-center px-1.5 py-0.5 rounded-md border text-[10px] font-medium ${config.className}`}>
            {config.label}
        </span>
    );
}

/** '13:15' -> '1:15 PM' (the seed stores 24h HH:MM strings); non-matching input passes through. */
export function formatAppointmentTime(time: string | undefined): string {
    if (time === undefined || !/^\d{1,2}:\d{2}$/.test(time)) {
        return time ?? '';
    }
    const [hoursRaw = '0', minutes = '00'] = time.split(':');
    const hours = Number(hoursRaw);
    const display = hours % 12 === 0 ? 12 : hours % 12;
    return `${display}:${minutes} ${hours >= 12 ? 'PM' : 'AM'}`;
}

/** Whole-year age at the reference instant from an ISO dob; null when either is unparsable. */
export function computeAge(dob: string | undefined, at: string): number | null {
    if (dob === undefined || dob === '') {
        return null;
    }
    const birth = new Date(dob);
    const ref = new Date(at);
    if (Number.isNaN(birth.getTime()) || Number.isNaN(ref.getTime())) {
        return null;
    }
    let age = ref.getUTCFullYear() - birth.getUTCFullYear();
    const monthDiff = ref.getUTCMonth() - birth.getUTCMonth();
    if (monthDiff < 0 || (monthDiff === 0 && ref.getUTCDate() < birth.getUTCDate())) {
        age -= 1;
    }
    return age;
}
