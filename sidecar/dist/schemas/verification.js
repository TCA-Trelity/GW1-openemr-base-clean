// Fact types verifiable under delegated authority (permissions.jsx:267-272).
export const DELEGATED_VERIFICATION_ALLOWED = [
    'social_history',
    'family_history',
    'patient_goal',
    'chief_complaint',
];
// Fact types requiring physician verification (permissions.jsx:275-282).
// Note: vital_sign appears in neither tier list in the prototype.
export const PHYSICIAN_VERIFICATION_REQUIRED = [
    'allergy',
    'medication',
    'condition',
    'clinical_finding',
    'imaging_finding',
    'procedure_history',
];
// The prototype's role keys (permissions.jsx ROLES table).
export const PROVIDER_ROLES = [
    'physician',
    'nurse',
    'technician',
    'coordinator',
    'scheduler',
    'front_desk',
    'billing_specialist',
    'office_manager',
    'medical_assistant',
];
// Roles holding fact:verify / fact:verify_delegated in permissions.jsx ROLES.
const FULL_VERIFICATION_ROLES = ['physician'];
const DELEGATED_VERIFICATION_ROLES = ['nurse'];
// Port of canVerifyFactType (permissions.jsx:296-306): physicians verify anything,
// delegated verifiers only the allowed tier, unknown roles verify nothing.
export function canVerifyFactType(role, factType) {
    if (FULL_VERIFICATION_ROLES.includes(role)) {
        return true;
    }
    if (DELEGATED_VERIFICATION_ROLES.includes(role)) {
        return DELEGATED_VERIFICATION_ALLOWED.includes(factType);
    }
    return false;
}
//# sourceMappingURL=verification.js.map