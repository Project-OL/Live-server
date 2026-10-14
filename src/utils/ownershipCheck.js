/**
 * SEC-09 / SEC-10: "is this user allowed to act on this call/stream" checks.
 *
 * LIVE_OWNERSHIP_CHECK_MODE:
 *   log     - default: count and log violations, let the request through (old behaviour)
 *   enforce - reject violations
 *
 * Rolled out like SEC-05: a wrong check on the call heartbeat would let the heartbeat-lost
 * sweep end real calls, so it runs in log mode until the 10-minute counters show no
 * violations from real users, then flips to enforce.
 */
const MODES = new Set(["log", "enforce"]);

export const ownershipCheckMode = () => {
    const m = String(process.env.LIVE_OWNERSHIP_CHECK_MODE || "log").trim().toLowerCase();
    return MODES.has(m) ? m : "log";
};

const counts = {};
let windowStart = Date.now();

const bump = (kind) => {
    counts[kind] = (counts[kind] || 0) + 1;
    if (Date.now() - windowStart >= 10 * 60 * 1000) {
        console.log(`[Ownership] mode=${ownershipCheckMode()} violations last 10m: ${JSON.stringify(counts)}`);
        for (const k of Object.keys(counts)) delete counts[k];
        windowStart = Date.now();
    }
};

/**
 * Record a violation and say whether to reject it.
 * @param {string} kind   e.g. "call_heartbeat", "camera_toggle"
 * @param {string} detail ids for the log line
 * @returns {boolean} true when the caller must reject (enforce mode)
 */
export const rejectNotOwner = (kind, detail) => {
    bump(kind);
    const mode = ownershipCheckMode();
    console.warn(`[Ownership] ${kind} not allowed (mode=${mode}): ${detail}`);
    return mode === "enforce";
};
