// Origin helper + badge (E3): marks whether a fact/citation came live from the OpenEMR
// EHR (the system of record) or was extracted from an external document (fax, pharmacy
// pull, intake). A small marker that COMPLEMENTS the R8 source-name citation chips —
// EHR when any citation is an external_ehr_import or points at an ehr-snapshot document.
import { Database, FileText } from 'lucide-react';
import type { CitationRef, PatientFact } from './types';

export type FactOrigin = 'ehr' | 'external';

/** The snapshot document id prefix EHR sync writes (openemr/ehrSync.ts ehrSnapshotDocumentId). */
export const EHR_SNAPSHOT_PREFIX = 'ehr-snapshot-';

function citationIsEhr(citation: CitationRef): boolean {
    return (
        citation.source_type === 'external_ehr_import' ||
        (citation.source_document_id?.startsWith(EHR_SNAPSHOT_PREFIX) ?? false)
    );
}

/** A single citation's origin — EHR when it's an external_ehr_import or an ehr-snapshot ref. */
export function citationOrigin(citation: CitationRef): FactOrigin {
    return citationIsEhr(citation) ? 'ehr' : 'external';
}

/** A fact's origin — EHR when ANY of its citations reads as EHR, else external. */
export function factOrigin(fact: PatientFact): FactOrigin {
    return fact.sources.some(citationIsEhr) ? 'ehr' : 'external';
}

const ORIGIN_CONFIG: Record<FactOrigin, { label: string; title: string; icon: typeof Database; className: string }> = {
    ehr: {
        label: 'EHR',
        title: 'Live from the OpenEMR record',
        icon: Database,
        className: 'bg-blue-50 text-blue-700 border-blue-200',
    },
    external: {
        label: 'External',
        title: 'Extracted from an external document',
        icon: FileText,
        className: 'bg-slate-50 text-slate-600 border-slate-200',
    },
};

/** Subtle slate/blue pill naming a value's origin — an additional marker beside the R8 chips. */
export function OriginBadge({ origin }: { origin: FactOrigin }) {
    const config = ORIGIN_CONFIG[origin];
    const Icon = config.icon;
    return (
        <span
            data-testid="origin-badge"
            data-origin={origin}
            title={config.title}
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-semibold ${config.className}`}
        >
            <Icon className="w-3 h-3" />
            {config.label}
        </span>
    );
}
