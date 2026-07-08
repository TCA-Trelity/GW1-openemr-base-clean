// The pixel seam: OCT files are sourced later, so records without a storage_key render a
// schematic metadata card; the moment a record carries one, this swaps to a real <img>
// served from the sidecar ImageStore. Nothing else in the panel knows pixels exist.
import { ScanEye } from 'lucide-react';
import type { ImageRecord } from '../types';
import { formatDate } from '../ui';

const MODALITY_LABELS: Record<string, string> = { oct: 'OCT', fundus_photo: 'Fundus' };

export function modalityLabel(modality: string): string {
    return MODALITY_LABELS[modality] ?? modality.toUpperCase();
}

export default function ScanImage({
    image,
    detail = false,
    className = '',
}: {
    image: ImageRecord;
    /** true renders the full placeholder card (date, dataset class); false a compact thumbnail. */
    detail?: boolean;
    className?: string;
}) {
    const meta = image.image_metadata;
    const label = `${modalityLabel(meta.modality)} ${meta.laterality.toUpperCase()}`;

    if (image.storage_key != null && image.storage_key !== '') {
        return (
            <img
                src={`/api/images/${encodeURIComponent(image.storage_key)}`}
                alt={`${label} — ${formatDate(meta.capture_date)}`}
                className={`object-cover bg-slate-900 ${className}`}
            />
        );
    }

    return (
        <div
            data-testid="scan-placeholder"
            title={`${label} — ${formatDate(meta.capture_date)} — image pending`}
            className={`relative overflow-hidden rounded-lg border border-dashed border-slate-300 bg-slate-50 ${className}`}
        >
            {detail ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 p-3 text-center">
                    <ScanEye className="w-6 h-6 text-slate-300" />
                    <p className="text-sm font-medium text-slate-600 flex items-center gap-1.5">
                        {modalityLabel(meta.modality)}
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded-md border text-xs font-semibold bg-indigo-50 text-indigo-700 border-indigo-200">
                            {meta.laterality.toUpperCase()}
                        </span>
                    </p>
                    <p className="text-xs text-slate-500">{formatDate(meta.capture_date)}</p>
                    {image.dataset_class !== undefined && (
                        <p className="text-[10px] uppercase tracking-wider text-slate-400">{image.dataset_class}</p>
                    )}
                    <p className="mt-1 text-[10px] font-semibold uppercase tracking-widest text-slate-300">Image pending</p>
                </div>
            ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5">
                    <ScanEye className="w-4 h-4 text-slate-300" />
                    <span className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">{label}</span>
                    <span className="text-[8px] uppercase tracking-widest text-slate-300">pending</span>
                </div>
            )}
        </div>
    );
}
