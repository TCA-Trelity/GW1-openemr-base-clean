// Overview tab — manifest §4 order: contradiction alerts -> Why They're Here ->
// What They're Hoping For -> Key Discussion Points -> Questions to Confirm ->
// Medication Risk Flags -> compact imaging block (full workstation lands in S2.2).
import { AlertTriangle, GitMerge, HelpCircle, Info, Pill, ExternalLink, Activity } from 'lucide-react';
import type {
    BriefContent,
    CitationRef,
    ContradictionSeverity,
    MedicationRiskFlag,
    RuntimeContradiction,
    RuntimeContradictionSource,
} from './types';
import { Card, SectionLabel, asSourceType, titleCase } from './ui';
import { CitationChips } from './CitationChip';

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

function ContradictionAlerts({ alerts }: { alerts: RuntimeContradiction[] }) {
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
                            <li key={alert.id}>
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

// ---- Compact imaging block (data from S1 engines; the four full features are S2.2) ----

const HCQ_ALERT_STYLES: Record<'high' | 'medium' | 'low', string> = {
    high: 'bg-red-50 border-red-200 text-red-800',
    medium: 'bg-amber-50 border-amber-200 text-amber-800',
    low: 'bg-slate-50 border-slate-200 text-slate-700',
};

function ImagingSummary({ imaging }: { imaging: BriefContent['imaging'] }) {
    const { timeline_summary, interval_analysis, hcq_progression } = imaging;
    const modalityCounts = new Map<string, number>();
    for (const entry of timeline_summary) {
        const key = `${entry.modality.toUpperCase()} ${entry.laterality.toUpperCase()}`;
        modalityCounts.set(key, (modalityCounts.get(key) ?? 0) + 1);
    }
    return (
        <section>
            <SectionLabel>
                <Activity className="w-4 h-4" />
                Imaging
            </SectionLabel>
            <Card className="p-5 space-y-4">
                <p className="text-sm text-slate-600">
                    <span className="font-medium text-slate-700">{timeline_summary.length} studies on file</span>
                    {modalityCounts.size > 0 && (
                        <span className="text-slate-500">
                            {' · '}
                            {[...modalityCounts.entries()].map(([key, count]) => `${key} ×${count}`).join(' · ')}
                        </span>
                    )}
                </p>
                {interval_analysis.recommendation !== '' && (
                    <div className="p-3 rounded-lg bg-blue-50 border border-blue-200">
                        <p className="text-sm text-blue-800">
                            <span className="font-medium">Treatment intervals:</span> {interval_analysis.recommendation}
                        </p>
                        <p className="text-xs text-blue-600 mt-1">
                            {interval_analysis.pattern_summary.total_cycles} cycles analyzed
                            {interval_analysis.optimal_interval !== null && ` · optimal ~${interval_analysis.optimal_interval} weeks`}
                            {' · confidence: '}
                            {interval_analysis.confidence}
                        </p>
                    </div>
                )}
                {hcq_progression.progression_detected && (
                    <div className={`p-3 rounded-lg border ${HCQ_ALERT_STYLES[hcq_progression.alert_level]}`}>
                        <p className="text-sm font-medium flex items-center gap-1.5">
                            <AlertTriangle className="w-4 h-4" />
                            HCQ progression: {hcq_progression.progression_description}
                        </p>
                        {hcq_progression.recommendation !== '' && <p className="text-sm mt-1">{hcq_progression.recommendation}</p>}
                    </div>
                )}
                <p className="text-xs text-slate-400 italic">
                    Full imaging timeline, trends, and side-by-side comparison arrive with the imaging workstation (S2.2).
                </p>
            </Card>
        </section>
    );
}

// ---- The tab ----

export default function Overview({ brief }: { brief: BriefContent }) {
    const whyFact = brief.facts_by_type.chief_complaint.find((fact) => fact.id === brief.why_they_are_here?.fact_id);
    const goalFact = brief.facts_by_type.patient_goal.find((fact) => fact.id === brief.what_they_are_hoping_for?.fact_id);
    const why = brief.why_they_are_here;
    const hoping = brief.what_they_are_hoping_for;

    return (
        <div className="space-y-10">
            <ContradictionAlerts alerts={brief.contradiction_alerts} />

            {why !== null && (
                <section>
                    <SectionLabel>Why They&rsquo;re Here</SectionLabel>
                    <div className="text-lg text-slate-700 leading-relaxed">
                        {why.content.statement}
                        {whyFact !== undefined && <CitationChips citations={whyFact.sources} />}
                    </div>
                    <div className="mt-2 text-sm text-slate-500 space-y-0.5">
                        {why.content.onset !== undefined && <p>Onset: {why.content.onset}</p>}
                        {why.content.progression !== undefined && <p>Progression: {why.content.progression}</p>}
                        {why.content.pertinent_negatives !== undefined && why.content.pertinent_negatives.length > 0 && (
                            <p>Pertinent negatives: {why.content.pertinent_negatives.join('; ')}</p>
                        )}
                    </div>
                </section>
            )}

            {hoping !== null && (
                <section className="relative">
                    {/* Highlighted card — port of ReadyToWalkIn.jsx "What They're Hoping For" */}
                    <div className="absolute inset-0 bg-gradient-to-br from-blue-100/30 to-blue-50/20 rounded-2xl blur-xl" />
                    <div className="relative bg-gradient-to-br from-blue-50 to-white rounded-2xl p-6 border-2 border-blue-200 shadow-sm">
                        <h2 className="text-xs font-bold uppercase tracking-wider text-blue-700 mb-3">
                            What They&rsquo;re Hoping For
                        </h2>
                        <div className="text-[17px] text-slate-800 leading-relaxed font-medium">
                            {hoping.content.goal}
                            {goalFact !== undefined && <CitationChips citations={goalFact.sources} />}
                        </div>
                        {hoping.content.specific_concerns !== undefined && hoping.content.specific_concerns.length > 0 && (
                            <ul className="mt-3 space-y-1">
                                {hoping.content.specific_concerns.map((concern, i) => (
                                    <li key={i} className="flex items-start gap-2 text-sm text-slate-600">
                                        <span className="text-blue-500 mt-0.5">•</span>
                                        {concern}
                                    </li>
                                ))}
                            </ul>
                        )}
                        {hoping.content.verbatim_quotes !== undefined && hoping.content.verbatim_quotes.length > 0 && (
                            <p className="mt-3 text-sm text-slate-500 italic">&ldquo;{hoping.content.verbatim_quotes[0]}&rdquo;</p>
                        )}
                    </div>
                </section>
            )}

            {brief.key_discussion_points.length > 0 && (
                <section>
                    <SectionLabel>Key Discussion Points ({brief.key_discussion_points.length})</SectionLabel>
                    <ol className="space-y-2.5">
                        {brief.key_discussion_points.map((point, i) => (
                            <li key={i} className="flex items-start gap-3">
                                <span className="flex-shrink-0 w-5 h-5 mt-0.5 rounded-full bg-blue-50 border border-blue-200 text-blue-700 text-xs font-semibold flex items-center justify-center">
                                    {i + 1}
                                </span>
                                <span className="text-slate-700">{point}</span>
                            </li>
                        ))}
                    </ol>
                </section>
            )}

            {brief.questions_to_confirm.length > 0 && (
                <section>
                    <SectionLabel>
                        <HelpCircle className="w-4 h-4" />
                        Questions to Confirm ({brief.questions_to_confirm.length})
                    </SectionLabel>
                    <ul className="space-y-2">
                        {brief.questions_to_confirm.map((question, i) => (
                            <li key={i} className="flex items-start gap-3 p-3 rounded-lg bg-amber-50/60 border border-amber-100">
                                <HelpCircle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                                <span className="text-sm text-slate-700">{question}</span>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            <MedicationRiskFlags flags={brief.medication_risk_flags} />

            <ImagingSummary imaging={brief.imaging} />
        </div>
    );
}
