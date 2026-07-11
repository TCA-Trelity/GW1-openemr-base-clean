// Overview landing (S2.11, R2 IA, P5/P6, Q8 minimalism) — rendered instantly from
// GET /api/overview, no LLM in the path, and deliberately spare: "Why are we here
// today?" (patient goal + chief complaint), the recent-scans workspace with its at-hand
// analytics rail, and the compact facts-to-resolve card. Medications, risk alerts,
// allergies, and conditions live on Medical Background (Q7/Q8) — not repeated here. The
// patient header band is exported for App to mount above the tab bar (it hosts the AI
// insights control); AI insights itself lives on its own tab.
import { useState, type ReactNode } from 'react';
import { ChevronDown, Clock, ExternalLink, GitMerge, MessageCircle, MessageSquare, Scan } from 'lucide-react';
import type {
    CitationRef,
    ContradictionSeverity,
    ImageRecord,
    OverviewPayload,
    PatientFact,
    PatientRecord,
    RuntimeContradiction,
    RuntimeContradictionSource,
    StoredContradictionRow,
} from './types';
import { Card, SectionLabel, VisitTypeChip, asSourceType, computeAge, formatAppointmentTime, formatDate, titleCase } from './ui';
import { CitationChip, CitationChips } from './CitationChip';
import { OriginBadge, citationOrigin } from './OriginBadge';
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

// ---- Facts-to-resolve card (P5: quieter than the old red data-conflicts banner) ----

// Deliberately capped at amber: this card asks the clinician to reconcile sources, it is
// not an emergency banner — red is reserved for the medication-risk alerts.
const SEVERITY_BANNER: Record<'high' | 'medium' | 'low', { accent: string; iconBg: string; iconColor: string; chip: string }> = {
    high: { accent: 'border-l-amber-400', iconBg: 'bg-amber-100', iconColor: 'text-amber-600', chip: 'bg-amber-100 text-amber-700' },
    medium: { accent: 'border-l-amber-300', iconBg: 'bg-amber-50', iconColor: 'text-amber-500', chip: 'bg-amber-50 text-amber-700' },
    low: { accent: 'border-l-slate-300', iconBg: 'bg-slate-100', iconColor: 'text-slate-500', chip: 'bg-slate-100 text-slate-600' },
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

/**
 * The two sides of a conflict, each carrying its own origin marker (EHR vs External) beside
 * its citation chip — so an EHR value pitted against an external document reads "your EHR
 * says X, this source says Y". Rendered per-side (never grouped) so the distinct claims stay
 * separate, with chip indices preserved.
 */
function ContradictionSides({ alert }: { alert: RuntimeContradiction }) {
    const sides = [
        alert.source_a !== null ? contradictionCitation(alert.id, 'a', alert.source_a) : null,
        alert.source_b !== null ? contradictionCitation(alert.id, 'b', alert.source_b) : null,
    ].filter((citation): citation is CitationRef => citation !== null);
    if (sides.length === 0) {
        return null;
    }
    return (
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 ml-1 align-text-top">
            {sides.map((citation, index) => (
                <span key={citation.id} className="inline-flex items-center gap-1">
                    <OriginBadge origin={citationOrigin(citation)} />
                    <CitationChip citation={citation} index={index + 1} />
                </span>
            ))}
        </span>
    );
}

export function ContradictionAlerts({
    alerts,
    anchorPrefix,
    collapsible = false,
    onAsk,
}: {
    alerts: RuntimeContradiction[];
    /** When set, each alert row gets id `${anchorPrefix}-${alert.id}` so links can scroll to it. */
    anchorPrefix?: string;
    /** Overview renders the card collapsed to a summary row; deep-link surfaces keep it open. */
    collapsible?: boolean;
    /** Ask-about-this (M6): seeds the conflict into the chat pane, prefilled — never auto-sent. */
    onAsk?: (text: string) => void;
}) {
    const [open, setOpen] = useState(!collapsible);
    if (alerts.length === 0) {
        return null;
    }
    const tiers = alerts.map((alert) => bannerTier(alert.severity));
    const topTier = tiers.includes('high') ? 'high' : tiers.includes('medium') ? 'medium' : 'low';
    const config = SEVERITY_BANNER[topTier];
    const highCount = tiers.filter((tier) => tier === 'high').length;
    const header = (
        <>
            <div className={`p-1.5 rounded-lg ${config.iconBg}`}>
                <GitMerge className={`w-4 h-4 ${config.iconColor}`} />
            </div>
            <h3 className="text-sm font-semibold text-slate-700">
                {alerts.length} fact{alerts.length !== 1 ? 's' : ''} to resolve
            </h3>
            {highCount > 0 && (
                <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${config.chip}`}>
                    {highCount} high priority
                </span>
            )}
        </>
    );
    return (
        <section data-testid="facts-to-resolve">
        <Card className={`border-l-4 ${config.accent}`}>
            {collapsible ? (
                <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setOpen((current) => !current)}
                    className="w-full flex items-center gap-2.5 px-4 py-3 text-left"
                >
                    {header}
                    {!open && (
                        <span className="flex-1 min-w-0 truncate text-xs text-slate-400">
                            {titleCase(alerts[0]?.type ?? '')}: {alerts[0]?.description}
                        </span>
                    )}
                    <ChevronDown
                        className={`w-4 h-4 text-slate-400 ml-auto flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
                    />
                </button>
            ) : (
                <div className="flex items-center gap-2.5 px-4 py-3">{header}</div>
            )}
            {open && (
                <ul className="space-y-3 px-4 pb-4 pt-1">
                    {alerts.map((alert) => (
                        <li key={alert.id} id={anchorPrefix !== undefined ? `${anchorPrefix}-${alert.id}` : undefined}>
                            {/* div, not p: the chip popover nests block elements */}
                            <div className="text-sm text-slate-600">
                                <span className="font-medium text-slate-700">{titleCase(alert.type)}:</span> {alert.description}
                                {/* Per-side (never grouped): distinct claims, each with its own origin marker. */}
                                <ContradictionSides alert={alert} />
                            </div>
                            {alert.suggested_question !== null && alert.suggested_question !== '' && (
                                <p className="text-sm text-slate-500 italic mt-0.5">→ {alert.suggested_question}</p>
                            )}
                            {onAsk !== undefined && (
                                <button
                                    type="button"
                                    onClick={() =>
                                        onAsk(
                                            `About the ${titleCase(alert.type).toLowerCase()} conflict — ${alert.description} What does each source say?`,
                                        )
                                    }
                                    className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 hover:text-slate-700"
                                >
                                    <MessageCircle className="w-3 h-3" />
                                    Ask the record
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </Card>
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

/**
 * "Why are we here today?" (P5) — one centered line the physician can hold in context: the
 * patient's own goal for the visit (authored per storyline, cited to the intake corpus),
 * followed by the clinical chief-complaint detail it frames.
 */
function WhyHereCard({ goal, complaint }: { goal: PatientFact | undefined; complaint: PatientFact | undefined }) {
    const goalContent = goal !== undefined && goal.fact_type === 'patient_goal' ? goal.content : null;
    const ccContent = complaint !== undefined && complaint.fact_type === 'chief_complaint' ? complaint.content : null;
    if (goalContent === null && ccContent === null) {
        return null;
    }
    return (
        <section data-testid="why-here">
            <SectionLabel>
                <MessageSquare className="w-4 h-4" />
                Why are we here today?
            </SectionLabel>
            <Card className="p-5">
                {goalContent !== null && (
                    <div className={`text-center px-2 ${ccContent !== null ? 'pb-4 mb-4 border-b border-slate-100' : ''}`}>
                        {/* div, not p: the chip popover nests block elements */}
                        <div className="text-lg font-medium text-slate-800 leading-snug">
                            {goalContent.goal}
                            {goal !== undefined && <CitationChips citations={goal.sources} />}
                        </div>
                    </div>
                )}
                {ccContent !== null && (
                    <>
                        <div className="text-base text-slate-700 leading-relaxed">
                            {ccContent.statement}
                            {complaint !== undefined && <CitationChips citations={complaint.sources} />}
                        </div>
                        <div className="mt-2 text-sm text-slate-500 space-y-0.5">
                            {ccContent.onset !== undefined && <p>Onset: {ccContent.onset}</p>}
                            {ccContent.progression !== undefined && <p>Progression: {ccContent.progression}</p>}
                            {ccContent.pertinent_negatives !== undefined && ccContent.pertinent_negatives.length > 0 && (
                                <p>Pertinent negatives: {ccContent.pertinent_negatives.join('; ')}</p>
                            )}
                        </div>
                    </>
                )}
            </Card>
        </section>
    );
}

// ---- Recent scans workspace (P6): stacked scans left, at-hand analytics rail right ----

/** One label/value line on the analytics rail. */
function RailRow({ label, value }: { label: string; value: ReactNode }) {
    return (
        <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="text-slate-500">{label}</span>
            <span className="font-semibold text-slate-800 text-right">{value}</span>
        </div>
    );
}

const RAIL_ALERT_CHIP: Record<'high' | 'medium' | 'low', string> = {
    high: 'bg-amber-100 text-amber-700',
    medium: 'bg-amber-50 text-amber-600',
    low: 'bg-slate-100 text-slate-600',
};

/**
 * The numbers Dan reaches for while looking at the scans, lifted from the same engines the
 * Imaging tab renders (overview.imaging is deterministic — no extra fetch). HCQ patients get
 * the GC-IPL story; treat-and-extend patients get the interval story; everyone gets a
 * pointer deeper into the Imaging tab.
 */
function ImagingAtHand({ imaging, latest }: { imaging: OverviewPayload['imaging']; latest: ImageRecord | undefined }) {
    const hcq = imaging.hcq_progression;
    const intervals = imaging.interval_analysis;
    const gcTrend = hcq.gc_thickness_trend;
    const hasHcq = gcTrend.length > 0;
    const hasIntervals = intervals.intervals.length > 0;
    const lastGc = gcTrend.at(-1);
    const priorGc = gcTrend.at(-2);
    const gcDelta = lastGc !== undefined && priorGc !== undefined ? lastGc.value - priorGc.value : null;
    const lastInterval = intervals.intervals.at(-1);
    const daysSinceTreatment = latest?.treatment_context?.days_since_last_treatment ?? null;
    return (
        <aside data-testid="imaging-at-hand" className="rounded-lg bg-slate-50 border border-slate-100 p-4 space-y-2.5 self-start">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">At-hand analytics</p>
            {hasHcq && (
                <>
                    <RailRow
                        label="HCQ alert"
                        value={
                            <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold uppercase ${RAIL_ALERT_CHIP[hcq.alert_level]}`}>
                                {hcq.alert_level}
                            </span>
                        }
                    />
                    {lastGc !== undefined && (
                        <RailRow
                            label="GC-IPL thickness"
                            value={`${lastGc.value} µm${gcDelta !== null ? ` (${gcDelta > 0 ? '+' : ''}${gcDelta} µm)` : ''}`}
                        />
                    )}
                    {hcq.progression_description !== '' && (
                        <p className="text-xs text-slate-500 leading-relaxed">{hcq.progression_description}</p>
                    )}
                </>
            )}
            {hasIntervals && (
                <>
                    {lastInterval !== undefined && (
                        <RailRow label="Current interval" value={`${lastInterval.interval_weeks} wks (${titleCase(lastInterval.outcome)})`} />
                    )}
                    {intervals.optimal_interval !== null && <RailRow label="Optimal interval" value={`${intervals.optimal_interval} wks`} />}
                    <RailRow
                        label="Response pattern"
                        value={`${intervals.pattern_summary.good_response_count} good / ${intervals.pattern_summary.poor_response_count} poor`}
                    />
                </>
            )}
            {!hasHcq && !hasIntervals && (
                <>
                    {daysSinceTreatment !== null && <RailRow label="Days since last treatment" value={`${daysSinceTreatment}`} />}
                    <p className="text-xs text-slate-500 leading-relaxed">No trend analytics for this modality yet — the Imaging tab has the full workspace.</p>
                </>
            )}
        </aside>
    );
}

function RecentScans({
    images,
    imaging,
    onOpenImaging,
}: {
    images: ImageRecord[];
    imaging: OverviewPayload['imaging'];
    onOpenImaging: () => void;
}) {
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
                    // P6: scans stack vertically (taller) so the analytics rail rides beside
                    // them — the numbers Dan wants are at hand, not a tab away.
                    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
                        <div className="space-y-4">
                            {shown.map((image) => (
                                <figure key={image.id}>
                                    <ScanImage image={image} className="w-full h-56" />
                                    <figcaption className="mt-1.5 text-xs text-slate-500">
                                        {modalityLabel(image.image_metadata.modality)} {image.image_metadata.laterality.toUpperCase()} ·{' '}
                                        {formatDate(image.image_metadata.capture_date)}
                                    </figcaption>
                                </figure>
                            ))}
                        </div>
                        <ImagingAtHand imaging={imaging} latest={shown[0]} />
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
    onAsk,
}: {
    overview: OverviewPayload;
    onOpenImaging: () => void;
    /** Ask-about-this (M6): seeds the chat pane with the clicked context. */
    onAsk?: (text: string) => void;
}) {
    const facts = overview.facts_by_type;
    const alerts = overview.contradictions.filter((row) => row.status !== 'resolved').map(projectContradictionRow);

    // Q8 minimalism: the landing holds only what the doctor needs walking in — the why,
    // the scans, and what needs reconciling. The full record lives on Medical Background.
    return (
        <div className="space-y-10">
            <WhyHereCard goal={(facts.patient_goal ?? [])[0]} complaint={(facts.chief_complaint ?? [])[0]} />

            <RecentScans images={overview.images} imaging={overview.imaging} onOpenImaging={onOpenImaging} />

            <ContradictionAlerts alerts={alerts} collapsible {...(onAsk === undefined ? {} : { onAsk })} />
        </div>
    );
}
