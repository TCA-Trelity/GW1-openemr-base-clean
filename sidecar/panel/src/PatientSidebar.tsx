// Day-schedule sidebar (S2.11): today's patients sorted by appointment time — the doctor
// toggles between them; selection drives the ?patient= deep link. Dark slate rail pattern
// from the second-opinion prototype's nav chrome.
import { CalendarClock, RefreshCw } from 'lucide-react';
import type { PatientRecord } from './types';
import { VisitTypeChip, formatAppointmentTime } from './ui';

export type SidebarState =
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; patients: PatientRecord[] };

/** Schedule order: appointment_time (zero-padded HH:MM sorts lexically), then name. */
export function sortByAppointment(patients: PatientRecord[]): PatientRecord[] {
    return [...patients].sort((a, b) => {
        const timeA = a.demographics.appointment_time ?? '';
        const timeB = b.demographics.appointment_time ?? '';
        return timeA === timeB ? a.name.localeCompare(b.name) : timeA.localeCompare(timeB);
    });
}

export default function PatientSidebar({
    state,
    activeId,
    onSelect,
    onRetry,
}: {
    state: SidebarState;
    activeId: string | null;
    onSelect: (id: string) => void;
    onRetry: () => void;
}) {
    return (
        <aside aria-label="Today's patients" className="w-60 flex-shrink-0 bg-slate-800 text-white flex flex-col">
            <div className="px-4 py-4 border-b border-slate-700 flex items-center gap-2">
                <CalendarClock className="w-4 h-4 text-slate-400" />
                <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Today&rsquo;s Patients</h2>
            </div>
            <nav className="flex-1 overflow-y-auto p-2 space-y-1">
                {state.kind === 'loading' && <p className="px-2 py-3 text-xs text-slate-400">Loading schedule…</p>}
                {state.kind === 'error' && (
                    <div className="px-2 py-3">
                        <p className="text-xs text-slate-400">Schedule unavailable.</p>
                        <button
                            type="button"
                            onClick={onRetry}
                            className="mt-2 inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-slate-600 text-xs text-slate-300 hover:bg-slate-700"
                        >
                            <RefreshCw className="w-3 h-3" />
                            Retry
                        </button>
                    </div>
                )}
                {state.kind === 'ready' && state.patients.length === 0 && (
                    <p className="px-2 py-3 text-xs text-slate-400">No patients scheduled.</p>
                )}
                {state.kind === 'ready' &&
                    sortByAppointment(state.patients).map((patient) => {
                        const isActive = patient.id === activeId;
                        return (
                            <button
                                key={patient.id}
                                type="button"
                                aria-current={isActive ? 'true' : undefined}
                                onClick={() => onSelect(patient.id)}
                                className={`w-full text-left rounded-lg px-3 py-2.5 border-l-2 transition-colors ${
                                    isActive ? 'bg-slate-700 border-blue-400' : 'border-transparent hover:bg-slate-700/60'
                                }`}
                            >
                                <span className="block text-sm font-medium text-white truncate">{patient.name}</span>
                                <span className="mt-1 flex items-center gap-2 text-xs text-slate-300">
                                    {formatAppointmentTime(patient.demographics.appointment_time)}
                                    <VisitTypeChip visitType={patient.demographics.visit_type} />
                                </span>
                            </button>
                        );
                    })}
            </nav>
        </aside>
    );
}
