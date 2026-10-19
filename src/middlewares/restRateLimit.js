import { TokenBuckets, modeFromEnv, makeWindowLog } from "../utils/tokenBucket.js";

/**
 * LIVE-47: per-user REST rate limits, by route class. LIVE_RATE_LIMIT_MODE (off | log | enforce,
 * default log; shared with the socket guard). Called from `authenticate`, so the key is the verified
 * user id. Enforce answers 429 { success:false, code:'RATE_LIMITED' } with Retry-After.
 *
 * Budgets are deliberately generous (a burst, then a sustained rate): they stop floods and runaway
 * retry loops, not normal use. Log mode shows who would be limited before anything is enforced.
 */
const CLASSES = {
    gift: { capacity: 40, refillPerSec: 10 }, // gift + lucky gift sends (combo taps are fast)
    chat: { capacity: 10, refillPerSec: 2 }, // room chat, global message
    golive: { capacity: 5, refillPerSec: 0.2 }, // go-live, end
    translate: { capacity: 20, refillPerSec: 5 },
    default: { capacity: 120, refillPerSec: 30 }
};
const buckets = Object.fromEntries(Object.entries(CLASSES).map(([k, v]) => [k, new TokenBuckets(v)]));
const report = makeWindowLog("Rate Limit");

setInterval(() => {
    for (const b of Object.values(buckets)) b.prune();
}, 60_000).unref?.();

export const restClassOf = (method, path) => {
    if (method === "GET") return "default";
    if (/\/send-gift$|\/lucky-gift\/send$/.test(path)) return "gift";
    if (/\/live-stream\/[^/]+\/message$|\/global-message$/.test(path)) return "chat";
    if (/\/go-live$|\/live-stream\/end\/[^/]+$/.test(path)) return "golive";
    if (/\/translate$/.test(path)) return "translate";
    return "default";
};

/** true when the request may proceed. */
export const restRateAllow = (req, res, userId) => {
    const mode = modeFromEnv("LIVE_RATE_LIMIT_MODE");
    if (mode === "off") return true;
    const path = String(req.originalUrl || req.url || "").split("?")[0];
    const cls = restClassOf(req.method, path);
    if (buckets[cls].take(`${userId}`)) return true;
    report.count(`rest:${cls}`);
    report.detail(`rest:${userId}:${cls}`, `user ${userId} over the ${cls} REST rate (${req.method} ${path}; mode=${mode})`);
    if (mode !== "enforce") return true;
    const { refillPerSec } = CLASSES[cls];
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil(1 / refillPerSec))));
    res.status(429).json({ success: false, code: "RATE_LIMITED", message: "Too many requests. Please slow down." });
    return false;
};
