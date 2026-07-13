// The authorization subject the sidecar constructs (AZ1). AUDIT.md S1: OpenEMR's per-patient
// access check is a hardcoded `return true;` (BearerTokenAuthorizationStrategy.php:479-485), so
// we build the patient-scope control it cannot inherit. A Principal is ONLY ever produced by
// verifying a token — routes receive a typed Principal, never a raw caller-supplied id — so the
// credential is the boundary, not the model's judgment (ARCHITECTURE.md §3).

/** The three clinical roles the demo models, with real capability differences (user-approved). */
export const ROLES = ['physician', 'nurse', 'resident'] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
    return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** How a token was obtained: a real OpenEMR SMART launch, or a sidecar-minted demo token. */
export type TokenType = 'smart' | 'dev';

/**
 * The verified caller. `patient` is the sidecar patient id the token is bound to — the
 * structural cross-patient boundary. It is null only for a non-interactive principal (not
 * accepted on the patient-scoped routes; those demand a bound patient).
 */
export interface Principal {
    readonly user: string;
    readonly patient: string | null;
    readonly role: Role;
    readonly scopes: readonly string[];
    readonly tokenType: TokenType;
}

/**
 * What a role may do. `read` is universal for a bound clinician; the rest shape capability.
 * `verify` encodes fact-verification authority for the role-gated verification UI (S3.3):
 * a physician signs off directly, a resident's sign-off needs an attending, a nurse cannot.
 */
export interface Capabilities {
    readonly read: boolean;
    readonly triggerPrep: boolean;
    readonly verify: 'full' | 'needs_attending_sign_off' | false;
    /** Week 2 (E.3): attaching outside documents to the chart. Physicians and nurses
     *  (who staff intake) may; residents may not attach outside records unsupervised —
     *  an adjustable product default, chosen so the demo shows a live 403. */
    readonly documentsWrite: boolean;
}

// Exhaustive over Role (no default branch): adding a role forces a compile error here.
export function capabilitiesFor(role: Role): Capabilities {
    switch (role) {
        case 'physician':
            return { read: true, triggerPrep: true, verify: 'full', documentsWrite: true };
        case 'resident':
            return { read: true, triggerPrep: true, verify: 'needs_attending_sign_off', documentsWrite: false };
        case 'nurse':
            return { read: true, triggerPrep: false, verify: false, documentsWrite: true };
    }
}

/**
 * Authentication/authorization failure carrying the HTTP status to send. `reason` is a stable
 * machine code (never a raw token detail) safe to return to the caller and log.
 */
export class AuthError extends Error {
    constructor(
        public readonly status: 401 | 403,
        public readonly reason: string,
    ) {
        super(reason);
        this.name = 'AuthError';
    }
}

/** Space-delimited scope string (OAuth) -> list; tolerates missing/blank. */
export function splitScope(value: unknown): string[] {
    return typeof value === 'string' ? value.split(' ').filter((s) => s !== '') : [];
}
