// E.1 (REQ S1/R1, S5): panel document upload — drag-drop or pick a file, choose the doc
// type, watch the staged ingestion advance live (the same stages the record carries, so
// the UI is the trace), then open the citation overlay (E.2) on the completed document.
// Write-path auth hardening (dev bearer + role gate on the server) is ticket E.3; the
// card itself is role-agnostic demo surface until then.
import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, CloudUpload, CopyCheck, FileUp, Loader2, ScanSearch, ShieldAlert, XCircle } from 'lucide-react';
import { fetchIngestion, uploadDocument, type IngestionRecordView } from './api';
import { Card } from './ui';

const TERMINAL_PREFIXES = ['complete', 'blocked', 'failed'];
const POLL_MS = 700;
const POLL_LIMIT = 120; // ~84 s ceiling — ingestion p95 budget is 90 s/doc (G2)

function isTerminal(status: string): boolean {
    return TERMINAL_PREFIXES.some((prefix) => status.startsWith(prefix));
}

/** U.1: the EHR write dedupes byte-identical files — the record says so in a stage detail
 *  (`stored_ehr — deduped: byte-identical document already filed`). That run must read as
 *  "already on file", not as a fresh completion (manual test plan A3). */
function isDeduped(record: IngestionRecordView): boolean {
    return record.stages.some((stage) => stage.detail !== undefined && stage.detail.includes('deduped'));
}

/** Friendly stage labels — the record's stage names, humanized (order preserved). */
function stageLabel(stage: string): string {
    return stage.replace(/_/g, ' ');
}

export type UploadPhase =
    | { kind: 'idle' }
    | { kind: 'uploading' }
    | { kind: 'tracking'; record: IngestionRecordView | null; ingestionId: string }
    | { kind: 'done'; record: IngestionRecordView }
    | { kind: 'error'; message: string };

export interface UploadCardProps {
    patientId: string;
    /** Called once when an ingestion reaches `complete` — the app refetches the bundle. */
    onIngested: (record: IngestionRecordView) => void;
    /** Open the E.2 overlay for a completed ingestion. */
    onPreview: (record: IngestionRecordView) => void;
}

export default function UploadCard({ patientId, onIngested, onPreview }: UploadCardProps) {
    const [docType, setDocType] = useState<'lab_pdf' | 'intake_form'>('lab_pdf');
    const [phase, setPhase] = useState<UploadPhase>({ kind: 'idle' });
    const [dragOver, setDragOver] = useState(false);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const notifiedRef = useRef(false);

    const begin = useCallback(
        async (file: File) => {
            notifiedRef.current = false;
            setPhase({ kind: 'uploading' });
            const result = await uploadDocument(patientId, file, docType);
            if (!result.ok) {
                setPhase({ kind: 'error', message: result.message });
                return;
            }
            setPhase({ kind: 'tracking', record: null, ingestionId: result.ingestionId });
        },
        [patientId, docType],
    );

    // Poll the staged record while tracking; stop on a terminal status.
    useEffect(() => {
        if (phase.kind !== 'tracking') {
            return;
        }
        let cancelled = false;
        let polls = 0;
        const tick = async (): Promise<void> => {
            polls += 1;
            const record = await fetchIngestion(phase.ingestionId);
            if (cancelled) {
                return;
            }
            if (record !== null && isTerminal(record.status)) {
                setPhase({ kind: 'done', record });
                if (record.status === 'complete' && !notifiedRef.current) {
                    notifiedRef.current = true;
                    onIngested(record);
                }
                return;
            }
            if (polls >= POLL_LIMIT) {
                setPhase({ kind: 'error', message: 'Ingestion is still running server-side; check back via the ingestion list.' });
                return;
            }
            setPhase({ kind: 'tracking', record, ingestionId: phase.ingestionId });
        };
        const timer = setTimeout(() => void tick(), phase.record === null ? 60 : POLL_MS);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [phase, onIngested]);

    const onFiles = useCallback(
        (list: FileList | null) => {
            const file = list?.[0];
            if (file !== undefined) {
                void begin(file);
            }
        },
        [begin],
    );

    const record = phase.kind === 'tracking' ? phase.record : phase.kind === 'done' ? phase.record : null;

    return (
        <Card>
            <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
                    <CloudUpload className="w-4 h-4 text-indigo-600" />
                    Attach a document
                </h3>
                <label className="text-xs text-slate-600 flex items-center gap-2">
                    Document type
                    <select
                        aria-label="Document type"
                        value={docType}
                        onChange={(event) => setDocType(event.target.value as 'lab_pdf' | 'intake_form')}
                        className="border border-slate-300 rounded-md px-2 py-1 text-xs bg-white"
                    >
                        <option value="lab_pdf">Outside lab report (PDF)</option>
                        <option value="intake_form">Intake update form</option>
                    </select>
                </label>
            </div>

            {(phase.kind === 'idle' || phase.kind === 'error') && (
                <div
                    data-testid="dropzone"
                    onDragOver={(event) => {
                        event.preventDefault();
                        setDragOver(true);
                    }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={(event) => {
                        event.preventDefault();
                        setDragOver(false);
                        onFiles(event.dataTransfer.files);
                    }}
                    className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors ${
                        dragOver ? 'border-indigo-400 bg-indigo-50' : 'border-slate-300 bg-slate-50'
                    }`}
                >
                    <FileUp className="w-6 h-6 text-slate-400 mx-auto mb-2" />
                    <p className="text-sm text-slate-600">
                        Drag a PDF/scan here, or{' '}
                        <button type="button" className="text-indigo-600 font-medium hover:underline" onClick={() => inputRef.current?.click()}>
                            browse
                        </button>
                    </p>
                    <p className="text-[11px] text-slate-400 mt-1">PDF, PNG, or JPEG · extraction runs at prep time, grounded to the document</p>
                    <input
                        ref={inputRef}
                        type="file"
                        accept="application/pdf,image/png,image/jpeg"
                        className="hidden"
                        aria-label="Choose document file"
                        onChange={(event) => onFiles(event.target.files)}
                    />
                    {phase.kind === 'error' && (
                        <p className="mt-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-2 py-1.5 inline-block">{phase.message}</p>
                    )}
                </div>
            )}

            {phase.kind === 'uploading' && (
                <div className="flex items-center gap-2 text-sm text-slate-600 p-4">
                    <Loader2 className="w-4 h-4 animate-spin" /> Uploading…
                </div>
            )}

            {(phase.kind === 'tracking' || phase.kind === 'done') && (
                <div className="space-y-2 p-1" data-testid="ingestion-progress">
                    <ol className="space-y-1">
                        {(record?.stages ?? []).map((stage, index) => (
                            <li key={`${stage.stage}-${String(index)}`} className="flex items-center gap-2 text-xs text-slate-600">
                                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                                <span className="capitalize">{stageLabel(stage.stage)}</span>
                                {stage.detail !== undefined && <span className="text-slate-400 truncate">— {stage.detail}</span>}
                            </li>
                        ))}
                        {phase.kind === 'tracking' && (
                            <li className="flex items-center gap-2 text-xs text-slate-500">
                                <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" /> working…
                            </li>
                        )}
                    </ol>

                    {/* U.1: a deduped EHR write is NOT a fresh ingestion — say so, visually distinct. */}
                    {phase.kind === 'done' && record !== null && record.status === 'complete' && isDeduped(record) && (
                        <div className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900 space-y-1" data-testid="ingestion-deduped">
                            <p className="font-semibold flex items-center gap-1.5">
                                <CopyCheck className="w-3.5 h-3.5" /> We already have this exact document on file — showing the existing copy
                            </p>
                            <p>No duplicate was filed to the chart; its {record.facts_persisted} extracted fact(s) are up to date.</p>
                            <button
                                type="button"
                                onClick={() => onPreview(record)}
                                className="inline-flex items-center gap-1.5 mt-1 px-2 py-1 rounded-md bg-white border border-sky-300 text-sky-800 font-medium hover:bg-sky-100"
                            >
                                <ScanSearch className="w-3.5 h-3.5" /> View document with citation overlay
                            </button>
                        </div>
                    )}
                    {phase.kind === 'done' && record !== null && record.status === 'complete' && !isDeduped(record) && (
                        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 space-y-1" data-testid="ingestion-complete">
                            <p className="font-semibold flex items-center gap-1.5">
                                <CheckCircle2 className="w-3.5 h-3.5" /> Extraction complete — {record.facts_persisted} fact(s) persisted
                                {record.vitals_written ? ', vitals written to the chart' : ''}
                            </p>
                            {record.grounding !== null && (
                                <p>
                                    Grounding: {record.grounding.word_box} tight / {record.grounding.page} page-level / {record.grounding.unverified} not
                                    located (confidence {(record.grounding.confidence * 100).toFixed(0)}%)
                                </p>
                            )}
                            <button
                                type="button"
                                onClick={() => onPreview(record)}
                                className="inline-flex items-center gap-1.5 mt-1 px-2 py-1 rounded-md bg-white border border-emerald-300 text-emerald-800 font-medium hover:bg-emerald-100"
                            >
                                <ScanSearch className="w-3.5 h-3.5" /> View document with citation overlay
                            </button>
                        </div>
                    )}
                    {phase.kind === 'done' && record !== null && record.status === 'blocked_patient_mismatch' && (
                        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 flex items-start gap-1.5" data-testid="ingestion-blocked">
                            <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                            <span>
                                <strong>Blocked:</strong> the document&apos;s printed patient does not match this chart. Nothing was saved. {record.error}
                            </span>
                        </p>
                    )}
                    {phase.kind === 'done' && record !== null && record.status.startsWith('failed') && (
                        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900 flex items-start gap-1.5">
                            <XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                            <span>
                                <strong>Ingestion failed</strong> ({record.status}). {record.error} — nothing was stored partially.
                            </span>
                        </p>
                    )}
                    {phase.kind === 'done' && (
                        <button type="button" className="text-xs text-indigo-600 hover:underline" onClick={() => setPhase({ kind: 'idle' })}>
                            Attach another document
                        </button>
                    )}
                </div>
            )}
        </Card>
    );
}
