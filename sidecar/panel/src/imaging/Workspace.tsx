// Image-first scan workspace (research brief §2 viewer conventions + §3 must-haves #1,#2,#5,#6):
// the selected B-scan center-stage on a dark surround with OD/OS labeling and prev/next, a
// thumbnail filmstrip of the series beneath for scrubbing, acquisition metadata in the LEFT
// margin and the findings + measurements analysis panel in the RIGHT margin, with the trend
// charts riding directly beneath so the image and its trend read as one story. Selecting a
// filmstrip thumbnail (or an arrow) swaps the main scan and every margin around it.
//
// Deliberately NOT built (brief §3 skip-list, data can't support): segmentation overlays on the
// B-scan, thickness/en-face heatmaps, ETDRS 9-sector grids, slice-scrolling through a volume —
// each scan is a single 2D JPEG, so the filmstrip scrubs *scans in the series*, not slices.
import { ArrowLeft, ChevronLeft, ChevronRight, ScanEye, Sparkles } from 'lucide-react';
import type { HcqProgressionAnalysis, ImageRecord } from '../types';
import { Card, formatDate } from '../ui';
import AnalysisPanel from './AnalysisPanel';
import { TreatmentContextBadge } from './badges';
import ScanImage, { modalityLabel } from './ScanImage';
import { seriesFor } from './series';
import Trends from './Trends';

function LateralityTag({ laterality }: { laterality: string }) {
    const value = laterality.toUpperCase();
    const title = value === 'OD' ? 'Right eye' : value === 'OS' ? 'Left eye' : value === 'OU' ? 'Both eyes' : value;
    return (
        <span
            title={title}
            className="inline-flex items-center px-1.5 py-0.5 rounded-md border text-xs font-semibold bg-indigo-50 text-indigo-700 border-indigo-200"
        >
            {value}
        </span>
    );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex items-baseline justify-between gap-2 py-1.5 border-b border-slate-100 last:border-0">
            <dt className="text-[11px] font-medium uppercase tracking-wide text-slate-400 flex-shrink-0">{label}</dt>
            <dd className="text-sm text-slate-700 text-right min-w-0">{children}</dd>
        </div>
    );
}

/** LEFT margin — how/when the scan was acquired (research brief §3 must-have #6, OD/OS + context). */
function AcquisitionMargin({ image }: { image: ImageRecord }) {
    const meta = image.image_metadata;
    const context = image.treatment_context;
    return (
        <Card className="p-4" data-testid="acquisition-margin">
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">Acquisition</h4>
            <dl>
                <MetaRow label="Date">{formatDate(meta.capture_date)}</MetaRow>
                <MetaRow label="Modality">{modalityLabel(meta.modality)}</MetaRow>
                <MetaRow label="Eye">
                    <LateralityTag laterality={meta.laterality} />
                </MetaRow>
                {meta.scan_type !== undefined && meta.scan_type !== '' && (
                    <MetaRow label="Scan">{meta.scan_type}</MetaRow>
                )}
                {meta.scan_quality !== undefined && <MetaRow label="Quality">{meta.scan_quality}/10</MetaRow>}
                {meta.capture_device !== undefined && meta.capture_device !== '' && (
                    <MetaRow label="Device">{meta.capture_device}</MetaRow>
                )}
                {context?.treatment_cycle_number != null && (
                    <MetaRow label="Cycle">#{context.treatment_cycle_number}</MetaRow>
                )}
                {context?.days_since_last_treatment != null && (
                    <MetaRow label="Post-tx">
                        <TreatmentContextBadge context={context} />
                    </MetaRow>
                )}
            </dl>
        </Card>
    );
}

function Filmstrip({
    series,
    selectedId,
    onSelect,
}: {
    series: ImageRecord[];
    selectedId: string;
    onSelect: (id: string) => void;
}) {
    return (
        <div data-testid="filmstrip" className="flex gap-2 overflow-x-auto p-2 bg-slate-900 border-t border-slate-800">
            {series.map((scan) => {
                const isSelected = scan.id === selectedId;
                return (
                    <button
                        key={scan.id}
                        type="button"
                        data-testid="filmstrip-thumb"
                        data-selected={isSelected}
                        aria-label={`Show ${modalityLabel(scan.image_metadata.modality)} ${scan.image_metadata.laterality.toUpperCase()} — ${formatDate(scan.image_metadata.capture_date)}`}
                        aria-current={isSelected}
                        onClick={() => onSelect(scan.id)}
                        className={`flex-shrink-0 rounded-lg overflow-hidden transition-all ${
                            isSelected ? 'ring-2 ring-blue-400' : 'ring-1 ring-slate-700 opacity-70 hover:opacity-100'
                        }`}
                    >
                        <ScanImage image={scan} className="w-16 h-12" />
                        <span className="block px-1 py-0.5 text-[9px] text-center text-slate-300 bg-slate-900">
                            {new Date(scan.image_metadata.capture_date).toLocaleDateString('en-US', {
                                month: 'short',
                                day: 'numeric',
                            })}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}

/** CENTER — the dark viewer: OD/OS label, prev/next, big B-scan, filmstrip scrubber. */
function Viewer({
    image,
    series,
    onSelect,
}: {
    image: ImageRecord;
    series: ImageRecord[];
    onSelect: (id: string) => void;
}) {
    const meta = image.image_metadata;
    const index = series.findIndex((scan) => scan.id === image.id);
    const older = index > 0 ? series[index - 1] : undefined; // earlier scan (left)
    const newer = index < series.length - 1 ? series[index + 1] : undefined; // later scan (right)

    return (
        <div className="rounded-xl overflow-hidden bg-slate-900 border border-slate-800">
            <div className="flex items-center justify-between gap-2 p-3 bg-slate-900 border-b border-slate-800">
                <span className="flex items-center gap-2 text-sm font-medium text-white">
                    <ScanEye className="w-4 h-4 text-slate-400" />
                    {modalityLabel(meta.modality)} {meta.laterality.toUpperCase()}
                    <span className="text-xs font-normal text-slate-400">{formatDate(meta.capture_date)}</span>
                </span>
                <span className="flex items-center gap-1">
                    <button
                        type="button"
                        aria-label="Previous scan"
                        disabled={older === undefined}
                        onClick={() => older !== undefined && onSelect(older.id)}
                        className="h-7 w-7 flex items-center justify-center rounded-md text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-30 disabled:hover:bg-transparent"
                    >
                        <ChevronLeft className="w-4 h-4" />
                    </button>
                    <span className="text-xs text-slate-400 w-12 text-center tabular-nums">
                        {index + 1} / {series.length}
                    </span>
                    <button
                        type="button"
                        aria-label="Next scan"
                        disabled={newer === undefined}
                        onClick={() => newer !== undefined && onSelect(newer.id)}
                        className="h-7 w-7 flex items-center justify-center rounded-md text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-30 disabled:hover:bg-transparent"
                    >
                        <ChevronRight className="w-4 h-4" />
                    </button>
                </span>
            </div>
            <div className="flex items-center justify-center p-4 bg-slate-950">
                <ScanImage image={image} detail className="w-full max-h-[26rem] aspect-[4/3] object-contain" />
            </div>
            {series.length > 1 && <Filmstrip series={series} selectedId={image.id} onSelect={onSelect} />}
        </div>
    );
}

export default function Workspace({
    images,
    selectedId,
    onSelect,
    hcq,
    onBack,
}: {
    images: ImageRecord[];
    selectedId: string | null;
    onSelect: (id: string) => void;
    hcq: HcqProgressionAnalysis;
    /** When present (arrived from the timeline), a back link; omitted on the default workspace. */
    onBack?: () => void;
}) {
    // Resolve the selected scan, defaulting to the most recent so the workspace is never empty.
    const byDateDesc = [...images].sort(
        (a, b) => new Date(b.image_metadata.capture_date).getTime() - new Date(a.image_metadata.capture_date).getTime(),
    );
    const selected = images.find((image) => image.id === selectedId) ?? byDateDesc[0] ?? null;

    if (selected === null) {
        return (
            <div className="text-center py-16 text-slate-400 border border-dashed border-slate-200 rounded-xl">
                <ScanEye className="w-10 h-10 mx-auto mb-3 text-slate-300" />
                <p className="text-sm font-medium text-slate-500">No scans to display</p>
            </div>
        );
    }

    const series = seriesFor(selected, images);

    return (
        <div data-testid="workspace" className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
                {onBack !== undefined ? (
                    <button
                        type="button"
                        onClick={onBack}
                        className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 transition-colors"
                    >
                        <ArrowLeft className="w-4 h-4" />
                        Back to timeline
                    </button>
                ) : (
                    <span className="text-sm text-slate-500">
                        Viewing {series.length} {series.length === 1 ? 'scan' : 'scans'} · {selected.image_metadata.laterality.toUpperCase()}
                    </span>
                )}
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border bg-violet-50 text-violet-700 border-violet-200 text-xs font-medium">
                    <Sparkles className="w-3.5 h-3.5" />
                    AI analysis
                </span>
            </div>

            {/* Center-stage viewer flanked by margins: LEFT acquisition, RIGHT findings/measurements. */}
            <div className="grid gap-4 lg:grid-cols-12 items-start">
                <div className="lg:col-span-3 order-2 lg:order-1">
                    <AcquisitionMargin image={selected} />
                </div>
                <div className="lg:col-span-6 order-1 lg:order-2">
                    <Viewer image={selected} series={series} onSelect={onSelect} />
                </div>
                <div className="lg:col-span-3 order-3">
                    <Card className="p-4">
                        <AnalysisPanel image={selected} images={images} />
                    </Card>
                </div>
            </div>

            {/* Trends beneath, with the selected scan's date highlighted — image + trend, one story. */}
            <Trends images={images} hcq={hcq} selectedDate={selected.image_metadata.capture_date} />
        </div>
    );
}
