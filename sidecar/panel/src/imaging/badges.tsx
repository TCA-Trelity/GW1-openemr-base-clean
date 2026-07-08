// Shared imaging badge vocabulary — split out of Imaging.tsx so the combined scan view
// (R6), the Compare grid, and the care plan (R3) reuse the exact palette and medication
// spellings without circular imports.
import { Minus, Syringe, TrendingDown, TrendingUp } from 'lucide-react';
import type { ImageTreatmentContext, OverallChange, TreatmentResponseAssessment } from '../types';

const MEDICATION_LABELS: Record<string, string> = {
    eylea: 'Eylea',
    avastin: 'Avastin',
    lucentis: 'Lucentis',
    vabysmo: 'Vabysmo',
    beovu: 'Beovu',
    ozurdex: 'Ozurdex',
};

export function medicationLabel(medication: string): string {
    return MEDICATION_LABELS[medication.toLowerCase()] ?? medication;
}

export const RESPONSE_BADGES: Record<TreatmentResponseAssessment, { label: string; className: string }> = {
    good_response: { label: 'Good response', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
    worsened: { label: 'Worsened', className: 'bg-red-50 text-red-700 border-red-200' },
    no_response: { label: 'No response', className: 'bg-red-50 text-red-700 border-red-200' },
    partial_response: { label: 'Partial response', className: 'bg-amber-50 text-amber-700 border-amber-200' },
};

export const CHANGE_ICONS: Record<OverallChange, { icon: typeof Minus; className: string }> = {
    improved: { icon: TrendingUp, className: 'text-emerald-600' },
    worsened: { icon: TrendingDown, className: 'text-red-600' },
    stable: { icon: Minus, className: 'text-blue-600' },
    mixed: { icon: Minus, className: 'text-amber-600' },
};

// Light-theme translation of the prototype's overall_change badge palette (ImageComparison.jsx).
export const CHANGE_BADGES: Record<OverallChange, string> = {
    improved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    worsened: 'bg-red-50 text-red-700 border-red-200',
    stable: 'bg-blue-50 text-blue-700 border-blue-200',
    mixed: 'bg-amber-50 text-amber-700 border-amber-200',
};

/** Purple "Xd post-<medication>" chip from an image's treatment_context. */
export function TreatmentContextBadge({ context }: { context: ImageTreatmentContext | null | undefined }) {
    const daysPost = context?.days_since_last_treatment;
    if (daysPost == null) {
        return null;
    }
    const medication = context?.last_treatment?.medication;
    return (
        <span
            data-testid="treatment-context-badge"
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[11px] font-medium bg-purple-50 text-purple-700 border-purple-200"
        >
            <Syringe className="w-3 h-3" />
            {daysPost}d post-{medication !== undefined ? medicationLabel(medication) : 'injection'}
        </span>
    );
}
