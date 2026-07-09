// Role switcher (AZ4): a demo control to switch the clinical role, so a grader can watch the
// capability model change live — a nurse loses the AI-prep trigger, a resident's verifications
// need an attending. Changing the role re-mints the dev token with that role (App re-runs its
// load effect), so the change is enforced end-to-end, not just cosmetic. Only rendered when
// dev-login is active (authActive), i.e. never in a real SMART-launched session.
import type { AuthCapabilities, ClinicalRole } from './api';

const ROLES: { id: ClinicalRole; label: string }[] = [
    { id: 'physician', label: 'Physician' },
    { id: 'nurse', label: 'Nurse' },
    { id: 'resident', label: 'Resident' },
];

function capabilityHint(capabilities: AuthCapabilities | null): string {
    if (capabilities === null) {
        return 'demo role';
    }
    if (!capabilities.triggerPrep) {
        return 'read-only · cannot run AI prep';
    }
    if (capabilities.verify === 'needs_attending_sign_off') {
        return 'full read · sign-off needs attending';
    }
    return 'full clinical access';
}

export default function RoleSwitcher({
    role,
    capabilities,
    onChange,
}: {
    role: ClinicalRole;
    capabilities: AuthCapabilities | null;
    onChange: (role: ClinicalRole) => void;
}) {
    return (
        <div className="flex flex-col items-end gap-1">
            <div role="radiogroup" aria-label="Demo role" className="inline-flex p-0.5 bg-slate-700/60 rounded-lg">
                {ROLES.map((option) => (
                    <button
                        key={option.id}
                        type="button"
                        role="radio"
                        aria-checked={role === option.id}
                        onClick={() => onChange(option.id)}
                        className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                            role === option.id ? 'bg-white text-slate-800' : 'text-slate-300 hover:text-white'
                        }`}
                    >
                        {option.label}
                    </button>
                ))}
            </div>
            <p className="text-[10px] text-slate-400">{capabilityHint(capabilities)}</p>
        </div>
    );
}
