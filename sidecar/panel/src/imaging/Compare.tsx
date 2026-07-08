// Compare sub-tab — port of ImageComparison.jsx: up to 4 side-by-side ScanImage cards with
// per-image change badges, picked via a checkbox list (selection state lives in Imaging.tsx).
import type { ImageRecord, OverallChange } from '../types';
import { formatDate } from '../ui';
import ScanImage, { modalityLabel } from './ScanImage';

export const MAX_COMPARE = 4;

// Light-theme translation of the prototype's overall_change badge palette.
const CHANGE_BADGES: Record<OverallChange, string> = {
    improved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    worsened: 'bg-red-50 text-red-700 border-red-200',
    stable: 'bg-blue-50 text-blue-700 border-blue-200',
    mixed: 'bg-amber-50 text-amber-700 border-amber-200',
};

const GRID_BY_COUNT: Record<number, string> = {
    1: 'grid-cols-1',
    2: 'grid-cols-2',
    3: 'grid-cols-3',
    4: 'grid-cols-2',
};

function crtOf(image: ImageRecord): number | undefined {
    return image.ai_analysis?.measurements?.find((m) => m.measurement_type === 'central_retinal_thickness')?.value;
}

function CompareCard({ image }: { image: ImageRecord }) {
    const meta = image.image_metadata;
    const change = image.ai_analysis?.comparison_to_prior?.overall_change;
    const crt = crtOf(image);
    const daysPost = image.treatment_context?.days_since_last_treatment;
    return (
        <div className="rounded-xl overflow-hidden bg-white border border-slate-200">
            <ScanImage image={image} detail className="aspect-[4/3] w-full rounded-none border-x-0 border-t-0" />
            <div className="p-3 border-t border-slate-200">
                <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium text-slate-800">
                        {modalityLabel(meta.modality)} {meta.laterality.toUpperCase()}
                    </span>
                    <span className="inline-flex px-2 py-0.5 rounded-md border border-slate-200 text-xs text-slate-600">
                        {formatDate(meta.capture_date)}
                    </span>
                </div>
                <div className="flex items-center gap-3 text-xs text-slate-500">
                    {daysPost != null && <span>{daysPost}d post-tx</span>}
                    {crt !== undefined && <span>CRT: {crt}µm</span>}
                    {change !== undefined && (
                        <span className={`inline-flex px-2 py-0.5 rounded-md border font-medium ${CHANGE_BADGES[change]}`}>
                            {change}
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
}

export default function Compare({
    images,
    selectedIds,
    onChange,
}: {
    images: ImageRecord[];
    selectedIds: string[];
    onChange: (ids: string[]) => void;
}) {
    const selected = images.filter((image) => selectedIds.includes(image.id));
    const full = selected.length >= MAX_COMPARE;

    const toggle = (id: string) => {
        if (selectedIds.includes(id)) {
            onChange(selectedIds.filter((selectedId) => selectedId !== id));
        } else if (!full) {
            onChange([...selectedIds, id]);
        }
    };

    return (
        <div className="space-y-4">
            {selected.length === 0 ? (
                <div className="text-center py-12 text-slate-400 border border-dashed border-slate-200 rounded-xl">
                    <p className="text-sm font-medium text-slate-500">Select images below to compare</p>
                    <p className="text-xs mt-1">You can compare up to {MAX_COMPARE} images side by side</p>
                </div>
            ) : (
                <div data-testid="compare-grid" className={`grid gap-4 ${GRID_BY_COUNT[selected.length] ?? 'grid-cols-2'}`}>
                    {selected.map((image) => (
                        <CompareCard key={image.id} image={image} />
                    ))}
                </div>
            )}

            {/* Selection list (checkbox picker replaces the prototype's thumbnail strip) */}
            <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex items-center gap-3 mb-2">
                    <span className="text-sm text-slate-500">
                        {selected.length}/{MAX_COMPARE} images selected
                    </span>
                    {selected.length > 0 && (
                        <button
                            type="button"
                            onClick={() => onChange([])}
                            className="text-xs text-slate-400 hover:text-slate-600"
                        >
                            Clear all
                        </button>
                    )}
                </div>
                <ul className="divide-y divide-slate-100">
                    {images.map((image) => {
                        const isSelected = selectedIds.includes(image.id);
                        const crt = crtOf(image);
                        return (
                            <li key={image.id}>
                                <label className={`flex items-center gap-3 py-2 text-sm ${!isSelected && full ? 'opacity-50' : 'cursor-pointer'}`}>
                                    <input
                                        type="checkbox"
                                        checked={isSelected}
                                        disabled={!isSelected && full}
                                        onChange={() => toggle(image.id)}
                                        className="w-4 h-4 rounded border-slate-300"
                                        aria-label={`Compare ${modalityLabel(image.image_metadata.modality)} ${formatDate(image.image_metadata.capture_date)}`}
                                    />
                                    <span className="text-slate-700 font-medium">{formatDate(image.image_metadata.capture_date)}</span>
                                    <span className="text-slate-500">
                                        {modalityLabel(image.image_metadata.modality)} {image.image_metadata.laterality.toUpperCase()}
                                    </span>
                                    {crt !== undefined && <span className="text-xs text-slate-400">CRT {crt}µm</span>}
                                </label>
                            </li>
                        );
                    })}
                </ul>
            </div>
        </div>
    );
}
