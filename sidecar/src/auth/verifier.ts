// The principal verifier (AZ1): turns a bearer token into a typed Principal, or throws
// AuthError. It dispatches STRICTLY on the JWT `alg` header — HS256 -> our dev tokens, RS256 ->
// OpenEMR SMART tokens — and rejects everything else. That strict split is the alg-confusion
// defense: an RS256 OpenEMR token can never be validated against the HMAC dev secret, an "alg:
// none" token is refused, and a dev token cannot masquerade as a SMART one.
import { algOf, decodeJwt } from './jwt.js';
import { AuthError, type Principal } from './principal.js';
import type { DevTokenService } from './devToken.js';
import type { SmartTokenVerifier } from './smartVerifier.js';

export interface PrincipalVerifier {
    verify(token: string): Promise<Principal>;
}

export class CompositeVerifier implements PrincipalVerifier {
    constructor(
        private readonly dev: DevTokenService | undefined,
        private readonly smart: SmartTokenVerifier | undefined,
    ) {}

    /** True when at least one token path is configured — otherwise enforcement cannot be turned on. */
    get isConfigured(): boolean {
        return this.dev !== undefined || this.smart !== undefined;
    }

    async verify(token: string): Promise<Principal> {
        const parts = decodeJwt(token);
        if (parts === null) {
            throw new AuthError(401, 'malformed_token');
        }
        switch (algOf(parts)) {
            case 'HS256':
                if (this.dev === undefined) {
                    throw new AuthError(401, 'dev_login_disabled');
                }
                return this.dev.verify(token);
            case 'RS256':
                if (this.smart === undefined) {
                    throw new AuthError(401, 'smart_not_configured');
                }
                return this.smart.verify(token);
            default:
                throw new AuthError(401, 'unsupported_alg');
        }
    }
}
