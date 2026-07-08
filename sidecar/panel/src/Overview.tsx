// Overview landing (S2.11, R2 IA) — rendered instantly from GET /api/overview, no LLM in
// the path: contradiction alerts, chief complaint with the recent-scans strip directly
// beneath it, meds + deterministic risk flags, allergies, conditions. The patient header
// band is exported for App to mount above the tab bar (it hosts the AI insights control);
// AI insights itself lives on its own tab.
import { useState, type ComponentType, type ReactNode } from 'react';
import {
    AlertTriangle,
    Clock,
    ExternalLink,
    GitMerge,
    Info,
    MessageSquare,
    Pill,
    Scan,
    Stethoscope,
} from 'lucide-react';
import type {
    CitationRef,
    ContradictionSeverity,
    ImageRecord,
    MedicationRiskFlag,
    OverviewPayload,
    PatientFact,
    PatientRecord,
    RuntimeContradiction,
    RuntimeContradictionSource,
    StoredContradictionRow,
} from './types';
import { Card, SectionLabel, VisitTypeChip, asSourceType, computeAge, formatAppointmentTime, formatDate, titleCase } from './ui';
import { CitationChips } from './CitationChip';
import { FactRow } from './MedicalBackground';
import ScanImage, { modalityLabel } from './imaging/ScanImage';

// ---- Stored contradiction rows -> the runtime shape the alert banner renders ----

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value !== '' ? value : null;
}

function runtimeSource(value: unknown): RuntimeContradictionSource | null {
    const record = asRecord(value);
    if (record === null) {
        return null;
    }
    return {
        type: asString(record.type) ?? 'source_document',
        value: asString(record.value) ?? '',
        timestamp: asString(record.timestamp),
        document_id: asString(record.document_id),
        excerpt: asString(record.excerpt),
    };
}

/**
 * Stored contradiction payloads arrive in the runtime detector shape OR the rich seed
 * shape — project either into the RuntimeContradiction the alert banner renders
 * (mirror of sidecar schemas/contradictions.ts projectContradiction).
 */
export function projectContradictionRow(row: StoredContradictionRow): RuntimeContradiction {
    const payload = row.payload;
    const status: 'active' | 'resolved' = row.status === 'resolved' ? 'resolved' : 'active';
    const richDescription = asString(payload.clinical_significance);
    if (richDescription !== null) {
        const docs = Array.isArray(payload.source_documents) ? payload.source_documents : [];
        const toSource = (doc: unknown): RuntimeContradictionSource | null => {
            const record = asRecord(doc);
            if (record === null) {
                return null;
            }
            return {
                type: 'source_document',
                value: asString(record.claim) ?? '',
                document_id: asString(record.source_document_id) ?? asString(record.filename),
                excerpt: asString(record.exact_text),
                timestamp: null,
            };
        };
        const workflow = asRecord(payload.physician_workflow);
        return {
            id: row.id,
            patient_id: row.patient_id,
            status,
            severity: row.severity,
            type: asString(payload.type) ?? 'contradiction',
            description: richDescription,
            suggested_question: workflow !== null ? asString(workflow.auto_generate_question) : null,
            source_a: toSource(docs[0]),
            source_b: toSource(docs[1]),
        };
    }
    return {
        id: row.id,
        patient_id: row.patient_id,
        status,
        severity: row.severity,
        type: asString(payload.type) ?? 'contradiction',
        description: asString(payload.description) ?? 'Contradiction on record',
        suggested_question: asString(payload.suggested_question),
        source_a: runtimeSource(payload.source_a),
        source_b: runtimeSource(payload.source_b),
    };
}

// ---- Contradiction alerts banner (port of ContradictionAlert.jsx severityConfig) ----

const SEVERITY_BANNER: Record<'high' | 'medium' | 'low', { bg: string; border: string; iconBg: string; iconColor: string; text: string; subText: string }> = {
    high: { bg: 'bg-red-50', border: 'border-red-300', iconBg: 'bg-red-100', iconColor: 'text-red-600', text: 'text-red-800', subText: 'text-red-600' },
    medium: { bg: 'bg-amber-50', border: 'border-amber-300', iconBg: 'bg-amber-100', iconColor: 'text-amber-600', text: 'text-amber-800', subText: 'text-amber-600' },
    low: { bg: 'bg-slate-50', border: 'border-slate-300', iconBg: 'bg-slate-100', iconColor: 'text-slate-600', text: 'text-slate-800', subText: 'text-slate-600' },
};

function bannerTier(severity: ContradictionSeverity): 'high' | 'medium' | 'low' {
    if (severity === 'critical' || severity === 'high') {
        return 'high';
    }
    return severity === 'low' ? 'low' : 'medium';
}

/** Contradiction claims cite via the same chip: project the runtime source into a CitationRef. */
function contradictionCitation(alertId: string, side: 'a' | 'b', source: RuntimeContradictionSource): CitationRef {
    return {
        id: `${alertId}-${side}`,
        source_label: titleCase(source.type),
        source_type: asSourceType(source.type),
        excerpt_text: source.excerpt ?? source.value,
        excerpt_location: null,
        attribution: null,
        source_document_id: source.document_id ?? null,
        document_date: source.timestamp ?? null,
    };
}

export function ContradictionAlerts({
    alerts,
    anchorPrefix,
}: {
    alerts: RuntimeContradiction[];
    /** When set, each alert row gets id `${anchorPrefix}-${alert.id}` so links can scroll to it. */
    anchorPrefix?: string;
}) {
    if (alerts.length === 0) {
        return null;
    }
    const tiers = alerts.map((alert) => bannerTier(alert.severity));
    const topTier = tiers.includes('high') ? 'high' : tiers.includes('medium') ? 'medium' : 'low';
    const config = SEVERITY_BANNER[topTier];
    const highCount = tiers.filter((tier) => tier === 'high').length;
    return (
        <div className={`rounded-xl border-2 ${config.border} ${config.bg} p-4`}>
            <div className="flex items-start gap-3">
                <div className={`p-2 rounded-lg ${config.iconBg}`}>
                    <GitMerge className={`w-5 h-5 ${config.iconColor}`} />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                        <h3 className={`font-semibold ${config.text}`}>
                            {alerts.length} Data Conflict{alerts.length !== 1 ? 's' : ''} Detected
                        </h3>
                        {highCount > 0 && (
                            <span className="px-2 py-0.5 bg-red-100 text-red-700 text-xs font-medium rounded-full">
                                {highCount} High Priority
                            </span>
                        )}
                    </div>
                    <ul className="space-y-3">
                        {alerts.map((alert) => (
                            <li key={alert.id} id={anchorPrefix !== undefined ? `${anchorPrefix}-${alert.id}` : undefined}>
                                {/* div, not p: the chip popover nests block elements */}
                                <div className={`text-sm ${config.subText}`}>
                                    <span className="font-medium">{titleCase(alert.type)}:</span> {alert.description}
                                    <CitationChips
                                        citations={[
                                            ...(alert.source_a !== null ? [contradictionCitation(alert.id, 'a', alert.source_a)] : []),
                                            ...(alert.source_b !== null ? [contradictionCitation(alert.id, 'b', alert.source_b)] : []),
                                        ]}
                                    />
                                </div>
                                {alert.suggested_question !== null && alert.suggested_question !== '' && (
                                    <p className="text-sm text-slate-600 italic mt-0.5">→ {alert.suggested_question}</p>
                                )}
                            </li>
                        ))}
                    </ul>
                </div>
            </div>
        </div>
    );
}

// ---- Medication risk flags (port of MedicationRiskFlags.jsx getSeverityStyles) ----

const FLAG_STYLES: Record<MedicationRiskFlag['severity'], { container: string; icon: string; title: string; badge: string }> = {
    high: { container: 'bg-red-50 border-red-200', icon: 'text-red-600', title: 'text-red-800', badge: 'bg-red-100 text-red-700 border-red-200' },
    medium: { container: 'bg-amber-50 border-amber-200', icon: 'text-amber-600', title: 'text-amber-800', badge: 'bg-amber-100 text-amber-700 border-amber-200' },
    low: { container: 'bg-blue-50 border-blue-200', icon: 'text-blue-600', title: 'text-blue-800', badge: 'bg-blue-100 text-blue-700 border-blue-200' },
};

/** Compact severity-styled badge shown inline on the medication row. */
function RiskFlagBadge({ flag }: { flag: MedicationRiskFlag }) {
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
function flagsForMedication(name: string, flags: MedicationRiskFlag[]): MedicationRiskFlag[] {
    const lower = name.toLowerCase();
    return flags.filter((flag) => {
        const flagName = flag.medication.toLowerCase();
        return flagName === lower || lower.includes(flagName) || flagName.includes(lower);
    });
}

function MedicationRiskFlags({ flags }: { flags: MedicationRiskFlag[] }) {
    if (flags.length === 0) {
        return null;
    }
    return (
        <section>
            <SectionLabel>
                <Pill className="w-4 h-4" />
                Medication Risk Alerts ({flags.length})
            </SectionLabel>
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
        </section>
    );
}

// ---- Patient header band ----

const SEX_LABELS: Record<string, string> = { F: 'Female', M: 'Male' };

export function PatientHeaderBand({
    patient,
    generatedAt,
    action,
}: {
    patient: PatientRecord;
    generatedAt: string;
    /** The AI insights control (R2) — rendered just left of the time chip. */
    action?: ReactNode;
}) {
    const demo = patient.demographics;
    const age = computeAge(demo.dob, generatedAt);
    const identity = [
        age !== null ? `${age} yrs` : '',
        demo.sex !== undefined && demo.sex !== '' ? (SEX_LABELS[demo.sex] ?? demo.sex) : '',
        demo.mrn !== undefined && demo.mrn !== '' ? `MRN ${demo.mrn}` : '',
    ].filter((part) => part !== '');
    return (
        <Card className="p-5 flex flex-wrap items-center justify-between gap-4">
            <div>
                <h2 className="text-xl font-semibold text-slate-800">{patient.name}</h2>
                {identity.length > 0 && <p className="text-sm text-slate-500 mt-0.5">{identity.join(' · ')}</p>}
            </div>
            <div className="flex flex-wrap items-center gap-3">
                {action}
                <div className="flex items-center gap-2 text-sm text-slate-600">
                    {demo.appointment_time !== undefined && demo.appointment_time !== '' && (
                        <span className="inline-flex items-center gap-1.5">
                            <Clock className="w-4 h-4 text-slate-400" />
                            {formatAppointmentTime(demo.appointment_time)}
                        </span>
                    )}
                    <VisitTypeChip visitType={demo.visit_type} />
                </div>
            </div>
        </Card>
    );
}

// ---- Chief complaint card ----

function ChiefComplaintCard({ fact }: { fact: PatientFact | undefined }) {
    if (fact === undefined || fact.fact_type !== 'chief_complaint') {
        return null;
    }
    const content = fact.content;
    return (
        <section>
            <SectionLabel>
                <MessageSquare className="w-4 h-4" />
                Chief Complaint
            </SectionLabel>
            <Card className="p-5">
                {/* div, not p: the chip popover nests block elements */}
                <div className="text-lg text-slate-700 leading-relaxed">
                    {content.statement}
                    <CitationChips citations={fact.sources} />
                </div>
                <div className="mt-2 text-sm text-slate-500 space-y-0.5">
                    {content.onset !== undefined && <p>Onset: {content.onset}</p>}
                    {content.progression !== undefined && <p>Progression: {content.progression}</p>}
                    {content.pertinent_negatives !== undefined && content.pertinent_negatives.length > 0 && (
                        <p>Pertinent negatives: {content.pertinent_negatives.join('; ')}</p>
                    )}
                </div>
            </Card>
        </section>
    );
}

// ---- Fact group cards (meds / allergies / conditions) ----

function FactGroupCard({
    title,
    icon: Icon,
    facts,
    badgesFor,
}: {
    title: string;
    icon: ComponentType<{ className?: string }>;
    facts: PatientFact[];
    badgesFor?: (fact: PatientFact) => ReactNode;
}) {
    if (facts.length === 0) {
        return null;
    }
    return (
        <section>
            <SectionLabel>
                <Icon className="w-4 h-4" />
                {title} ({facts.length})
            </SectionLabel>
            <Card className="px-5 py-1">
                {facts.map((fact) => (
                    <FactRow key={fact.id} fact={fact} badges={badgesFor?.(fact)} />
                ))}
            </Card>
        </section>
    );
}

// ---- Recent scans strip ----

function RecentScans({ images, onOpenImaging }: { images: ImageRecord[]; onOpenImaging: () => void }) {
    // Wire order is ascending capture_date; re-sort defensively, newest first.
    const sorted = [...images].sort(
        (a, b) => new Date(b.image_metadata.capture_date).getTime() - new Date(a.image_metadata.capture_date).getTime(),
    );
    const sides = [...new Set(sorted.map((image) => image.image_metadata.laterality.toUpperCase()))];
    const [side, setSide] = useState(sorted[0]?.image_metadata.laterality.toUpperCase() ?? 'OD');
    if (sorted.length === 0) {
        return null;
    }
    const shown = sorted.filter((image) => image.image_metadata.laterality.toUpperCase() === side).slice(0, 2);
    return (
        <section data-testid="recent-scans">
            <SectionLabel>
                <Scan className="w-4 h-4" />
                Recent Scans
            </SectionLabel>
            <Card className="p-5">
                <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                    <div className="inline-flex p-1 bg-slate-100 rounded-lg">
                        {sides.map((option) => (
                            <button
                                key={option}
                                type="button"
                                aria-pressed={side === option}
                                onClick={() => setSide(option)}
                                className={`px-3 py-1 text-xs font-semibold rounded-md transition-all ${
                                    side === option ? 'text-slate-800 bg-white shadow-sm' : 'text-slate-500 hover:text-slate-700'
                                }`}
                            >
                                {option}
                            </button>
                        ))}
                    </div>
                    <button
                        type="button"
                        onClick={onOpenImaging}
                        className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-700"
                    >
                        Open Imaging tab
                        <ExternalLink className="w-3 h-3" />
                    </button>
                </div>
                {shown.length === 0 ? (
                    <p className="text-sm text-slate-400">No {side} scans on file.</p>
                ) : (
                    <div className="grid gap-4 sm:grid-cols-2">
                        {shown.map((image) => (
                            <figure key={image.id}>
                                <ScanImage image={image} className="w-full h-40" />
                                <figcaption className="mt-1.5 text-xs text-slate-500">
                                    {modalityLabel(image.image_metadata.modality)} {image.image_metadata.laterality.toUpperCase()} ·{' '}
                                    {formatDate(image.image_metadata.capture_date)}
                                </figcaption>
                            </figure>
                        ))}
                    </div>
                )}
            </Card>
        </section>
    );
}

// ---- The tab ----

export default function Overview({
    overview,
    onOpenImaging,
}: {
    overview: OverviewPayload;
    onOpenImaging: () => void;
}) {
    const facts = overview.facts_by_type;
    const medications = facts.medication ?? [];
    const alerts = overview.contradictions.filter((row) => row.status !== 'resolved').map(projectContradictionRow);

    return (
        <div className="space-y-10">
            <ContradictionAlerts alerts={alerts} />

            <ChiefComplaintCard fact={(facts.chief_complaint ?? [])[0]} />

            <RecentScans images={overview.images} onOpenImaging={onOpenImaging} />

            <FactGroupCard
                title="Medications"
                icon={Pill}
                facts={medications}
                badgesFor={(fact) =>
                    fact.fact_type === 'medication'
                        ? flagsForMedication(fact.content.name, overview.medication_risk_flags).map((flag, i) => (
                              <RiskFlagBadge key={i} flag={flag} />
                          ))
                        : null
                }
            />

            <MedicationRiskFlags flags={overview.medication_risk_flags} />

            <FactGroupCard title="Allergies" icon={AlertTriangle} facts={facts.allergy ?? []} />

            <FactGroupCard title="Conditions" icon={Stethoscope} facts={facts.condition ?? []} />
        </div>
    );
}
