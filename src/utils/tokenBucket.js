/**
 * In-memory token buckets (LIVE-47). Each key holds up to `capacity` tokens and regains
 * `refillPerSec`; a request takes one. No Redis round trip, so no added latency.
 *
 * Limits are per process. With N Live-server nodes a user could get up to N times the budget,
 * which is fine for what these guard against (floods and runaway clients, not exact quotas).
 */
export class TokenBuckets {
    constructor({ capacity, refillPerSec, idleMs = 120_000 }) {
        this.capacity = capacity;
        this.refillPerMs = refillPerSec / 1000;
        this.idleMs = idleMs;
        this.map = new Map();
    }

    /** true when allowed (a token was taken). */
    take(key, now = Date.now()) {
        let b = this.map.get(key);
        if (!b) {
            b = { tokens: this.capacity, at: now };
            this.map.set(key, b);
        } else {
            b.tokens = Math.min(this.capacity, b.tokens + (now - b.at) * this.refillPerMs);
            b.at = now;
        }
        if (b.tokens >= 1) {
            b.tokens -= 1;
            return true;
        }
        return false;
    }

    /** Drop keys idle long enough to be full again (call periodically). */
    prune(now = Date.now()) {
        for (const [k, b] of this.map) if (now - b.at > this.idleMs) this.map.delete(k);
    }

    get size() {
        return this.map.size;
    }
}

/** A single bucket kept on an object (e.g. one socket), no map needed. */
export const takeToken = (state, capacity, refillPerSec, now = Date.now()) => {
    if (state.tokens === undefined) {
        state.tokens = capacity;
        state.at = now;
    } else {
        state.tokens = Math.min(capacity, state.tokens + ((now - state.at) * refillPerSec) / 1000);
        state.at = now;
    }
    if (state.tokens >= 1) {
        state.tokens -= 1;
        return true;
    }
    return false;
};

const MODES = new Set(["off", "log", "enforce"]);
export const modeFromEnv = (name, fallback = "log") => {
    const m = String(process.env[name] || fallback).trim().toLowerCase();
    return MODES.has(m) ? m : fallback;
};

/**
 * Rolling counters, printed every 10 minutes, plus a capped number of detail lines per window so a
 * flood can't flood the log too.
 */
export const makeWindowLog = (label, { windowMs = 10 * 60 * 1000, maxDetailLines = 50 } = {}) => {
    const counts = {};
    const seen = new Set();
    let windowStart = Date.now();
    let detailLines = 0;
    const roll = () => {
        if (Date.now() - windowStart < windowMs) return;
        if (Object.keys(counts).length) console.log(`[${label}] last 10m: ${JSON.stringify(counts)}`);
        for (const k of Object.keys(counts)) delete counts[k];
        seen.clear();
        detailLines = 0;
        windowStart = Date.now();
    };
    return {
        count(key) {
            roll();
            counts[key] = (counts[key] || 0) + 1;
        },
        /** One line per detailKey per window, at most maxDetailLines per window. */
        detail(detailKey, message) {
            if (seen.has(detailKey) || detailLines >= maxDetailLines) return;
            seen.add(detailKey);
            detailLines += 1;
            console.warn(`[${label}] ${message}`);
        }
    };
};
