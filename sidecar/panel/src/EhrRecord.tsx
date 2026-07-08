// EHR Record tab (E3) — the co-pilot as an information layer ON TOP OF the EHR: this tab
// is the system of record. It renders the EHR-origin slice of the deterministic overview
// (demographics + problem list, allergies, medications, observations) cleanly, headed by a
// "Live from OpenEMR · FHIR R4 · synced <relative>" line. Sync now POSTs /api/ehr-sync then
// refetches overview + facts; unlinked (409) / not-configured (503) surface inline, never
// as a crash. Empty until the first sync.
import { useState, type ComponentType } from 'react';
import { Activity, AlertTriangle, Database, Pill, RefreshCw, Stethoscope } from 'lucide-react';
import { syncEhr } from './api';
import type { FactType, OverviewPayload, PatientFact } from './types';
import { Card, computeAge, formatDate } from './ui';
import { FactRow } from './MedicalBackground';
import { factOrigin } from './OriginBadge';

const SEX_LABELS: Record<string, string> = { F: 'Female', M: 'Male' };

/** ISO instant -> "just now" / "N minutes ago" / … , falling back to an absolute date past 30 days. */
export function formatRelativeSync(iso: string | undefined, now: Date = new Date()): string {
    if (iso === undefined || iso === '') {
        return '';
    }
    const then = new Date(iso);
    if (Number.isNaN(then.getTime())) {
        return '';
    }
    const diffMs = now.getTime() - then.getTime();
    if (diffMs < 60_000) {
        return 'just now';
    }
    const minutes = Math.floor(diffMs / 60_000);
    if (minutes < 60) {
        return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    }
    const days = Math.floor(hours / 24);
    if (days < 30) {
        return `${days} day${days === 1 ? '' : 's'} ago`;
    }
    return formatDate(iso);
}

type SyncNote = { tone: 'ok' | 'info' | 'error'; text: string };

const NOTE_STYLES: Record<SyncNote['tone'], string> = {
    ok: 'bg-emerald-50 border-emerald-200 text-emerald-800',
    info: 'bg-slate-50 border-slate-200 text-slate-600',
    error: 'bg-red-50 border-red-200 text-red-700',
};

function SyncButton({ syncing, onClick, prominent = false }: { syncing: boolean; onClick: () => void; prominent?: boolean }) {
    const base = prominent
        ? 'bg-blue-600 text-white hover:bg-blue-700 px-3 py-1.5 text-sm'
        : 'border border-slate-200 text-slate-600 hover:bg-slate-50 px-2.5 py-1 text-xs';
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={syncing}
            className={`inline-flex items-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-60 ${base}`}
        >
            <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Syncing…' : 'Sync now'}
        </button>
    );
}

/** One EHR-origin fact group card (empty groups are omitted by the caller). */
function EhrGroup({ title, icon: Icon, facts }: { title: string; icon: ComponentType<{ className?: string }>; facts: PatientFact[] }) {
    return (
        <Card className="p-5">
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
    );
}

function Demographics({ overview }: { overview: OverviewPayload }) {
    const demo = overview.patient.demographics;
    const age = computeAge(demo.dob, overview.generated_at);
    const rows: { label: string; value: string }[] = [
        { label: 'Name', value: overview.patient.name },
        { label: 'Date of birth', value: [formatDate(demo.dob), age !== null ? `(${age} yrs)` : ''].filter((part) => part !== '').join(' ') },
        { label: 'Sex', value: demo.sex !== undefined && demo.sex !== '' ? (SEX_LABELS[demo.sex] ?? demo.sex) : '' },
        { label: 'MRN', value: demo.mrn ?? '' },
        { label: 'Phone', value: demo.phone ?? '' },
        { label: 'Address', value: demo.address ?? '' },
    ].filter((row) => row.value !== '');
    return (
        <Card className="p-5">
            <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2 mb-3">
                <Database className="w-4 h-4 text-slate-400" />
                Demographics
            </h3>
            <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                {rows.map((row) => (
                    <div key={row.label} className="flex items-baseline gap-2">
                        <dt className="text-xs font-medium uppercase tracking-wide text-slate-400 w-28 flex-shrink-0">{row.label}</dt>
                        <dd className="text-sm text-slate-700">{row.value}</dd>
                    </div>
                ))}
            </dl>
        </Card>
    );
}

export default function EhrRecord({
    overview,
    patientId,
    onSynced,
}: {
    overview: OverviewPayload;
    patientId: string;
    /** Called after a successful sync so App refetches overview + facts. */
    onSynced: () => void;
}) {
    const [syncing, setSyncing] = useState(false);
    const [note, setNote] = useState<SyncNote | null>(null);

    const runSync = async (): Promise<void> => {
        setSyncing(true);
        setNote(null);
        const result = await syncEhr(patientId);
        setSyncing(false);
        switch (result.kind) {
            case 'synced':
                setNote({ tone: 'ok', text: `Synced ${result.factCount} record${result.factCount === 1 ? '' : 's'} live from OpenEMR.` });
                onSynced();
                return;
            case 'not_linked':
                setNote({ tone: 'info', text: "This patient isn't linked to an OpenEMR chart yet." });
                return;
            case 'patient_not_found':
                setNote({ tone: 'error', text: 'This patient could not be found for EHR sync.' });
                return;
            case 'not_configured':
                setNote({ tone: 'info', text: "EHR sync isn't configured on this deployment." });
                return;
            case 'error':
                setNote({ tone: 'error', text: result.message });
                return;
        }
    };
    const onSync = (): void => void runSync();

    const ehrDoc = overview.documents.find((doc) => doc.document_type === 'ehr_import');
    const importedAt = ehrDoc !== undefined && typeof ehrDoc.metadata.imported_at === 'string' ? ehrDoc.metadata.imported_at : undefined;
    const syncedLabel = formatRelativeSync(importedAt) || formatDate(ehrDoc?.document_date);

    const ehrFactsOf = (type: FactType): PatientFact[] => (overview.facts_by_type[type] ?? []).filter((fact) => factOrigin(fact) === 'ehr');
    const groups: { title: string; icon: ComponentType<{ className?: string }>; facts: PatientFact[] }[] = [
        { title: 'Problem list', icon: Stethoscope, facts: ehrFactsOf('condition') },
        { title: 'Allergies', icon: AlertTriangle, facts: ehrFactsOf('allergy') },
        { title: 'Medications', icon: Pill, facts: ehrFactsOf('medication') },
        { title: 'Observations & vitals', icon: Activity, facts: [...ehrFactsOf('vital_sign'), ...ehrFactsOf('clinical_finding')] },
    ].filter((group) => group.facts.length > 0);

    const inlineNote = note !== null && (
        <p data-testid="ehr-sync-note" className={`p-3 rounded-lg border text-sm ${NOTE_STYLES[note.tone]}`}>
            {note.text}
        </p>
    );

    if (ehrDoc === undefined) {
        return (
            <div className="space-y-6">
                {inlineNote}
                <div className="text-center py-12 px-6 border border-dashed border-slate-200 rounded-xl">
                    <Database className="w-12 h-12 mx-auto mb-4 text-slate-300" />
                    <p className="text-sm font-medium text-slate-600">This record hasn&rsquo;t been synced from OpenEMR yet.</p>
                    <div className="mt-4 flex justify-center">
                        <SyncButton syncing={syncing} onClick={onSync} prominent />
                    </div>
                    <p className="text-xs text-slate-400 mt-4 max-w-md mx-auto">
                        The patient must be linked (seeded into OpenEMR) before a sync can pull their chart over FHIR.
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <Card className="p-5 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm text-slate-600">
                    <span className="p-1.5 rounded-md bg-blue-50 text-blue-600">
                        <Database className="w-4 h-4" />
                    </span>
                    <span>{`Live from OpenEMR · FHIR R4${syncedLabel !== '' ? ` · synced ${syncedLabel}` : ''}`}</span>
                </div>
                <SyncButton syncing={syncing} onClick={onSync} />
            </Card>

            {inlineNote}

            <Demographics overview={overview} />

            {groups.map((group) => (
                <EhrGroup key={group.title} title={group.title} icon={group.icon} facts={group.facts} />
            ))}

            {groups.length === 0 && (
                <p className="text-sm text-slate-500 py-6 text-center">
                    The latest OpenEMR snapshot returned no problems, allergies, medications, or observations.
                </p>
            )}
        </div>
    );
}
