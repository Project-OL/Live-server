/**
 * Minimal circuit breaker: after `failureThreshold` consecutive failures it opens for `openMs`
 * and fails fast; then one trial call (half-open) decides whether it closes again.
 * `isFailure(err)` lets callers keep errors that say nothing about the dependency's health
 * (bad input, 4xx) from counting.
 */
export class CircuitOpenError extends Error {
    constructor(name) {
        super(`${name} circuit open`);
        this.name = 'CircuitOpenError';
        this.code = 'CIRCUIT_OPEN';
    }
}

export const createCircuitBreaker = ({
    name,
    failureThreshold = 5,
    openMs = 30_000,
    isFailure = () => true,
    now = () => Date.now(),
} = {}) => {
    let failures = 0;
    let openedAt = 0;
    let trialInFlight = false;

    const state = () => {
        if (!openedAt) return 'closed';
        return now() - openedAt >= openMs ? 'half-open' : 'open';
    };

    const exec = async (fn) => {
        const s = state();
        if (s === 'open' || (s === 'half-open' && trialInFlight)) throw new CircuitOpenError(name);
        const trial = s === 'half-open';
        if (trial) trialInFlight = true;
        try {
            const out = await fn();
            failures = 0;
            openedAt = 0;
            return out;
        } catch (err) {
            if (isFailure(err)) {
                failures += 1;
                if (trial || failures >= failureThreshold) {
                    if (!openedAt || trial) console.warn(`[Breaker] ${name} opened after ${failures} failure(s): ${err?.message}`);
                    openedAt = now();
                }
            }
            throw err;
        } finally {
            if (trial) trialInFlight = false;
        }
    };

    return { exec, state };
};
