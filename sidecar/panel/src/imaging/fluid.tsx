// Fluid wet/dry derivation — the core wet-AMD call, promoted out of the findings list into a
// first-class chip (research brief §3 must-have #1).
//
// Clinical logic (research brief §1, wet-AMD row): "dry macula" = treatment success and keys on
// intra-/sub-retinal FLUID being absent. IRF is less tolerated than SRF. A pigment epithelial
// detachment (PED) is tracked alongside, but a shallow/stable PED persists in a treated *dry*
// macula — so PED on its own does NOT flip the call to wet. Fluid in our data is categorical
// (finding_type + severity), never a quantified volume (brief §3 skip-list), so this is a
// present/absent read, not a nL trajectory.
import { Droplet, Droplets, HelpCircle } from 'lucide-react';
import type { ImagingAiAnalysis, ImagingScanFinding } from '../types';

export type FluidState = 'wet' | 'dry' | 'unknown';

/** Finding types that constitute active macular fluid and drive a "wet" call. */
const WET_TRIGGER_TYPES = new Set([
    'subretinal_fluid',
    'intraretinal_fluid',
    'macular_edema',
    'cystoid_macular_edema',
]);
const PED_TYPE = 'pigment_epithelial_detachment';

export interface FluidStatus {
    state: FluidState;
    /** SRF/IRF findings driving a wet call (empty when dry). */
    wetFindings: ImagingScanFinding[];
    /** A PED is present — shown as a modifier, never the sole trigger of "wet". */
    pedPresent: boolean;
}

/**
 * Derive wet/dry from a scan's authored findings.
 * - Any SRF/IRF/edema finding ⇒ wet.
 * - An analyzed scan with no fluid trigger ⇒ dry (a persistent PED does not change this).
 * - No ai_analysis at all ⇒ unknown (never assert "dry" for an unread scan).
 */
export function deriveFluidStatus(analysis: ImagingAiAnalysis | null | undefined): FluidStatus {
    if (analysis == null) {
        return { state: 'unknown', wetFindings: [], pedPresent: false };
    }
    const findings = analysis.findings ?? [];
    const wetFindings = findings.filter((finding) => WET_TRIGGER_TYPES.has(finding.finding_type));
    const pedPresent = findings.some((finding) => finding.finding_type === PED_TYPE);
    return { state: wetFindings.length > 0 ? 'wet' : 'dry', wetFindings, pedPresent };
}

const FLUID_CHIP_CONFIG: Record<FluidState, { label: string; icon: typeof Droplet; className: string }> = {
    wet: { label: 'Wet', icon: Droplets, className: 'bg-red-50 text-red-700 border-red-200' },
    dry: { label: 'Dry', icon: Droplet, className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
    unknown: { label: 'Fluid n/a', icon: HelpCircle, className: 'bg-slate-50 text-slate-500 border-slate-200' },
};

/** The wet/dry chip. `data-fluid-state` carries the raw state for tests / styling hooks. */
export function FluidChip({ status, className = '' }: { status: FluidStatus; className?: string }) {
    const config = FLUID_CHIP_CONFIG[status.state];
    const Icon = config.icon;
    return (
        <span
            data-testid="fluid-chip"
            data-fluid-state={status.state}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-xs font-medium ${config.className} ${className}`}
        >
            <Icon className="w-3.5 h-3.5" />
            {config.label}
            {status.state !== 'unknown' && <span className="font-normal"> macula</span>}
            {status.pedPresent && status.state === 'dry' && (
                <span className="font-normal opacity-70" title="Pigment epithelial detachment persists">
                    {' '}
                    · PED
                </span>
            )}
        </span>
    );
}
