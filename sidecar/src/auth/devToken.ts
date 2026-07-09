// Sidecar-minted dev tokens (AZ4). A self-signed, patient-bound, role-carrying bearer for the
// standalone demo/grading path, so a grader can exercise the whole auth model — 401, the
// cross-patient 403, the role capability gate, the role switcher — WITHOUT standing up a full
// OpenEMR SMART launch. It is deliberately, visibly a demo credential (tokenType 'dev',
// issuer 'copilot-sidecar-dev') and only exists when DEV_LOGIN_SECRET is configured. The real
// launch path (SmartTokenVerifier) is structurally identical from the middleware's point of
// view: both yield a Principal bound to exactly one patient.
import { AuthError, isRole, splitScope, type Principal, type Role } from './principal.js';
import { algOf, decodeJwt, signHs256, verifyHs256 } from './jwt.js';

export const DEV_TOKEN_ISSUER = 'copilot-sidecar-dev';

// A dev clinician can read the bound chart and drive the demo; role then narrows capability.
const DEFAULT_DEV_SCOPES: readonly string[] = ['patient/*.read', 'launch/patient'];

export interface DevTokenClaims {
    /** Display name for the demo user (e.g. 'dr-demo'); lands in Principal.user. */
    username: string;
    /** Sidecar patient id this token is bound to — the cross-patient boundary. */
    patient: string;
    role: Role;
    scopes?: readonly string[];
}

export interface DevTokenServiceOptions {
    secret: string;
    /** Token lifetime; short by design (a demo session), refreshed by re-login. */
    ttlSeconds?: number;
    /** Injectable epoch-ms clock for deterministic tests. */
    now?: () => number;
}

export class DevTokenService {
    private readonly secret: string;
    private readonly ttlSeconds: number;
    private readonly now: () => number;

    constructor(options: DevTokenServiceOptions) {
        this.secret = options.secret;
        this.ttlSeconds = options.ttlSeconds ?? 3600;
        this.now = options.now ?? Date.now;
    }

    /** Mint a patient-bound dev token. Returns the compact JWT and its lifetime in seconds. */
    mint(claims: DevTokenClaims): { token: string; expiresIn: number } {
        const issuedAt = Math.floor(this.now() / 1000);
        const payload: Record<string, unknown> = {
            iss: DEV_TOKEN_ISSUER,
            sub: claims.username,
            patient: claims.patient,
            role: claims.role,
            scope: (claims.scopes ?? DEFAULT_DEV_SCOPES).join(' '),
            iat: issuedAt,
            exp: issuedAt + this.ttlSeconds,
        };
        return { token: signHs256({ alg: 'HS256', typ: 'JWT' }, payload, this.secret), expiresIn: this.ttlSeconds };
    }

    /**
     * Verify a dev token into a Principal, or throw AuthError(401). Only ever called for HS256
     * tokens (the verifier dispatches on alg), so an RS256 OpenEMR token can never be validated
     * against this HMAC secret — and vice-versa.
     */
    verify(token: string): Principal {
        const parts = decodeJwt(token);
        if (parts === null || algOf(parts) !== 'HS256') {
            throw new AuthError(401, 'malformed_token');
        }
        if (!verifyHs256(parts, this.secret)) {
            throw new AuthError(401, 'bad_signature');
        }
        const { payload } = parts;
        if (payload['iss'] !== DEV_TOKEN_ISSUER) {
            throw new AuthError(401, 'wrong_issuer');
        }
        const exp = payload['exp'];
        if (typeof exp !== 'number' || Math.floor(this.now() / 1000) >= exp) {
            throw new AuthError(401, 'token_expired');
        }
        const user = payload['sub'];
        const patient = payload['patient'];
        const role = payload['role'];
        if (typeof user !== 'string' || user === '' || typeof patient !== 'string' || patient === '' || !isRole(role)) {
            throw new AuthError(401, 'bad_claims');
        }
        return { user, patient, role, scopes: splitScope(payload['scope']), tokenType: 'dev' };
    }
}
