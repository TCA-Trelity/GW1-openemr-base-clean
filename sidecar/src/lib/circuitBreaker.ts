// H.10 (REQ G2, G14): hand-rolled per-dependency circuit breaker. The requirements register
// allows a "simple breaker or documented equivalent fallback" and the merged plan explicitly
// bans a commercial breaker library — so this is deliberately a consecutive-failure counter
// plus two timestamps, nothing more. After `failureThreshold` CONSECUTIVE failures the
// circuit opens and every call short-circuits with CircuitOpenError (no hammering a dead
// dependency); once `cooldownMs` elapses exactly ONE half-open probe passes through —
// success re-closes the circuit, failure re-opens it with a fresh cooldown.
//
// Composition rule (beside lib/httpRetry.ts on purpose): the breaker sits OUTSIDE
// withTimeoutAndRetry. One exec() = one LOGICAL call = ONE breaker failure, however many
// attempts the retry helper made inside — counting per attempt would double-trip.
// One instance per dependency (openemr, anthropic, cohere), created once at boot.

export type BreakerState = 'closed' | 'open' | 'half_open';

/**
 * Thrown WITHOUT invoking the wrapped call while the circuit is open (or while the single
 * half-open probe is already in flight). Degrade lanes catch exactly this class; every
 * other error is the dependency's own, rethrown unwrapped (it is what feeds the breaker).
 */
export class CircuitOpenError extends Error {
    constructor(
        public readonly dependency: string,
        /** Epoch ms when the cooldown ends and the next call is admitted as the probe. */
        public readonly retryAtMs: number,
    ) {
        super(`${dependency} circuit open — short-circuiting until ${new Date(retryAtMs).toISOString()}`);
        this.name = 'CircuitOpenError';
    }
}

export interface CircuitBreakerOptions {
    /** Dependency name ('openemr' | 'anthropic' | 'cohere') — surfaces in errors, transition logs, /ready. */
    name: string;
    /** Consecutive failures that trip the circuit (a success resets the counter to 0). */
    failureThreshold?: number;
    /** How long an open circuit short-circuits before admitting one half-open probe. */
    cooldownMs?: number;
    /** Epoch-milliseconds clock, injectable for deterministic tests (same shape as auth.ts). */
    now?: () => number;
    /** Structured-log hook — dependency name + states only, PHI-free by construction (G18/P5). */
    onTransition?: (from: BreakerState, to: BreakerState) => void;
}

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 30_000;

export class CircuitBreaker {
    public readonly name: string;
    private readonly failureThreshold: number;
    private readonly cooldownMs: number;
    private readonly now: () => number;
    private readonly onTransition: ((from: BreakerState, to: BreakerState) => void) | undefined;

    private stored: BreakerState = 'closed';
    private consecutiveFailures = 0;
    private openedAtMs = 0;

    constructor(options: CircuitBreakerOptions) {
        this.name = options.name;
        this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
        this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
        this.now = options.now ?? Date.now;
        this.onTransition = options.onTransition;
    }

    /**
     * Current state. An open circuit whose cooldown has elapsed reads as half_open — the
     * next exec() will be admitted as the probe — so /ready stops suppressing a dependency
     * the breaker is ready to re-test.
     */
    get state(): BreakerState {
        if (this.stored === 'open' && this.now() >= this.openedAtMs + this.cooldownMs) {
            return 'half_open';
        }
        return this.stored;
    }

    /**
     * Run one LOGICAL call through the circuit. Open → CircuitOpenError without invoking
     * `fn`; half-open admits exactly one in-flight probe (concurrent calls short-circuit
     * until the probe settles). The underlying error is always rethrown unchanged.
     */
    async exec<T>(fn: () => Promise<T>): Promise<T> {
        const probing = this.admit();
        try {
            const result = await fn();
            this.onSuccess(probing);
            return result;
        } catch (error) {
            this.onFailure(probing);
            throw error;
        }
    }

    /**
     * Gate the call; returns true when this call is the half-open probe. Runs synchronously
     * at exec() entry, so a concurrent call arriving while the probe is in flight can never
     * slip past it.
     */
    private admit(): boolean {
        if (this.stored === 'closed') {
            return false;
        }
        const retryAtMs = this.openedAtMs + this.cooldownMs;
        if (this.stored === 'open' && this.now() >= retryAtMs) {
            this.transitionTo('half_open');
            return true;
        }
        // Still cooling down, or the single half-open probe is already in flight.
        throw new CircuitOpenError(this.name, retryAtMs);
    }

    private onSuccess(probing: boolean): void {
        this.consecutiveFailures = 0;
        if (probing) {
            this.transitionTo('closed');
        }
    }

    private onFailure(probing: boolean): void {
        if (probing) {
            // The half-open probe failed: re-open with a FRESH cooldown.
            this.openedAtMs = this.now();
            this.transitionTo('open');
            return;
        }
        this.consecutiveFailures += 1;
        // Late failures from calls admitted before the trip keep counting but never
        // re-fire the transition — only a closed circuit trips open.
        if (this.stored === 'closed' && this.consecutiveFailures >= this.failureThreshold) {
            this.openedAtMs = this.now();
            this.transitionTo('open');
        }
    }

    private transitionTo(to: BreakerState): void {
        const from = this.stored;
        if (from === to) {
            return;
        }
        this.stored = to;
        this.onTransition?.(from, to);
    }
}

/** Run `work` through `breaker` when one is wired — the no-breaker path adds nothing. */
export function guardedBy<T>(breaker: CircuitBreaker | undefined, work: () => Promise<T>): Promise<T> {
    return breaker === undefined ? work() : breaker.exec(work);
}
