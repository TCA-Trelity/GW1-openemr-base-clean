// Citation chip + source card (the verification affordance, presearch Q10 / CitationBubble.jsx
// port, R8 source labels): a compact pill naming the source type ("Pharmacy", "Intake") ->
// popover card with type badge, date, attribution, and the verbatim excerpt highlighted in
// context; "View source" deep-links into the Sources tab. Same-source-type citations on one
// claim collapse into a single chip with a ×n count.
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Calendar, MapPin, User } from 'lucide-react';
import type { Attribution, CitationRef, PatientFact } from './types';
import { sourceChipLabel } from './sourceLabels';
import { formatDate, sourceTypeConfig, titleCase } from './ui';

/** Provided by App; lets any chip anywhere jump to the Sources tab. No-op by default so chips render standalone. */
export const SourceNavContext = createContext<(citation: CitationRef) => void>(() => undefined);

// Port of CitationBubble.jsx attributionLabels/getAttributionText.
const ATTRIBUTION_LABELS: Record<Attribution['speaker_role'], string> = {
    patient: 'Reported by patient',
    family_member: 'Reported by family member',
    physician: 'Documented by physician',
    nurse: 'Documented by nurse',
    technician: 'Documented by technician',
    pharmacist: 'From pharmacy record',
    external_provider: 'From external provider',
    system: 'System imported',
};

function attributionText(attribution: Attribution): string {
    const { speaker_role, speaker_name, speaker_relationship } = attribution;
    if (speaker_name != null && speaker_name !== '') {
        return speaker_role === 'family_member' && speaker_relationship != null
            ? `${speaker_name} (${speaker_relationship})`
            : speaker_name;
    }
    if (speaker_role === 'family_member' && speaker_relationship != null) {
        return `Patient's ${speaker_relationship}`;
    }
    return ATTRIBUTION_LABELS[speaker_role] ?? 'Unknown source';
}

function Excerpt({ citation }: { citation: CitationRef }) {
    if (citation.excerpt_text == null || citation.excerpt_text === '') {
        return <p className="text-sm text-slate-500 italic">No excerpt available</p>;
    }
    // v2: excerpt_location is a union; only character_range carries surrounding context.
    const location = citation.excerpt_location;
    const range = location?.type === 'character_range' ? location : null;
    const hasContext = range != null && (range.context_before != null || range.context_after != null);
    return (
        <p className="text-sm text-slate-600 leading-relaxed">
            {hasContext ? (
                <>
                    {range.context_before != null && <span className="text-slate-500">{range.context_before}</span>}
                    <mark className="bg-yellow-100 px-0.5 rounded font-medium text-slate-800">{citation.excerpt_text}</mark>
                    {range.context_after != null && <span className="text-slate-500">{range.context_after}</span>}
                </>
            ) : (
                <span className="italic">&ldquo;{citation.excerpt_text}&rdquo;</span>
            )}
        </p>
    );
}

export function CitationChip({
    citation,
    index,
    count = 1,
}: {
    citation: CitationRef;
    index: number;
    /** How many same-source-type citations this chip stands for; > 1 renders a ×n count. */
    count?: number;
}) {
    const [isOpen, setIsOpen] = useState(false);
    const rootRef = useRef<HTMLSpanElement>(null);
    const viewSource = useContext(SourceNavContext);
    const config = sourceTypeConfig(citation.source_type);
    const Icon = config.icon;
    const label = sourceChipLabel(citation.source_type);

    // Close on outside click / Escape — plain-React stand-in for the prototype's Popover.
    useEffect(() => {
        if (!isOpen) {
            return;
        }
        const onPointerDown = (event: MouseEvent) => {
            if (rootRef.current !== null && event.target instanceof Node && !rootRef.current.contains(event.target)) {
                setIsOpen(false);
            }
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('mousedown', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [isOpen]);

    return (
        <span ref={rootRef} className="relative inline-block align-text-top">
            <button
                type="button"
                aria-label={`Citation ${index}: ${citation.source_label}`}
                aria-expanded={isOpen}
                title={count > 1 ? `${label} — ${count} citations` : label}
                onClick={() => setIsOpen((open) => !open)}
                className={`inline-flex items-center gap-0.5 h-[1.15rem] px-1.5 ml-0.5 rounded-full border text-[10px] font-semibold cursor-pointer transition-colors ${config.color}`}
            >
                <span className="truncate max-w-[14ch]">{label}</span>
                {count > 1 && <span className="flex-shrink-0 opacity-75">×{count}</span>}
            </button>
            {isOpen && (
                <div
                    role="dialog"
                    aria-label={`Source: ${citation.source_label}`}
                    className="absolute left-0 top-full mt-1 w-80 z-50 rounded-xl shadow-lg border border-slate-200 bg-white overflow-hidden text-left font-normal normal-case tracking-normal"
                >
                    {/* Header: source type badge + label + date */}
                    <div className={`px-4 py-3 border-b border-slate-200 ${config.color.split(' ').slice(0, 2).join(' ')}`}>
                        <div className="flex items-center gap-2">
                            <span className="p-1.5 rounded-md bg-white/60">
                                <Icon className="w-4 h-4" />
                            </span>
                            <span>
                                <span className="block font-semibold text-slate-800 text-sm">{config.label}</span>
                                <span className="block text-xs text-slate-600">{citation.source_label}</span>
                                {citation.document_date != null && (
                                    <span className="flex items-center gap-1 text-xs text-slate-500 mt-0.5">
                                        <Calendar className="w-3 h-3" />
                                        {formatDate(citation.document_date)}
                                    </span>
                                )}
                            </span>
                        </div>
                    </div>
                    {/* Verbatim excerpt, cited span highlighted within context */}
                    <div className="px-4 py-3 border-b border-slate-100 bg-white">
                        <div className="pl-3 border-l-2 border-slate-200">
                            <Excerpt citation={citation} />
                        </div>
                    </div>
                    {/* Footer: attribution + View source */}
                    <div className="px-4 py-2.5 bg-slate-50 flex items-center justify-between gap-2">
                        {citation.attribution !== null ? (
                            <span className="flex items-center gap-1.5 text-xs text-slate-600 bg-white px-2 py-1 rounded-full border border-slate-200">
                                <User className="w-3 h-3 text-slate-400" />
                                <span className="font-medium">{attributionText(citation.attribution)}</span>
                            </span>
                        ) : (
                            <span />
                        )}
                        <button
                            type="button"
                            disabled={citation.source_document_id === null}
                            onClick={() => {
                                setIsOpen(false);
                                viewSource(citation);
                            }}
                            className="flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-700 font-medium bg-blue-50 hover:bg-blue-100 disabled:opacity-40 disabled:cursor-not-allowed px-2.5 py-1.5 rounded-md transition-colors"
                        >
                            <MapPin className="w-3 h-3" />
                            View source
                        </button>
                    </div>
                </div>
            )}
        </span>
    );
}

/** A fact's chip ref: its own first source, else a minimal synthesized one (insights points share this). */
export function factChipCitation(fact: PatientFact): CitationRef {
    return (
        fact.sources[0] ?? {
            id: `fact-cit-${fact.id}`,
            fact_id: fact.id,
            source_label: titleCase(fact.fact_type),
            source_type: 'provider_note',
            excerpt_text: null,
            excerpt_location: null,
            attribution: null,
            source_document_id: fact.source_document_id,
            document_date: fact.created_date ?? null,
        }
    );
}

interface ChipGroup {
    /** The group's representative citation (first in list order) — its card opens on click. */
    citation: CitationRef;
    count: number;
}

/** Collapse same-source-type citations into one chip each, preserving first-appearance order. */
function groupBySourceType(citations: CitationRef[]): ChipGroup[] {
    const groups = new Map<string, ChipGroup>();
    for (const citation of citations) {
        const existing = groups.get(citation.source_type);
        if (existing === undefined) {
            groups.set(citation.source_type, { citation, count: 1 });
        } else {
            existing.count += 1;
        }
    }
    return [...groups.values()];
}

/** Source-labelled chip row for a claim's citation list — the one component shared everywhere. */
export function CitationChips({
    citations,
    group = true,
}: {
    citations: CitationRef[];
    /** Set false where each citation is a distinct claim that must stay its own chip (e.g. the two sides of a contradiction). */
    group?: boolean;
}) {
    if (citations.length === 0) {
        return null;
    }
    const chips = group ? groupBySourceType(citations) : citations.map((citation) => ({ citation, count: 1 }));
    return (
        <span className="inline-flex items-center gap-0.5 ml-1">
            {chips.map(({ citation, count }, i) => (
                <CitationChip key={citation.id} citation={citation} index={i + 1} count={count} />
            ))}
        </span>
    );
}
