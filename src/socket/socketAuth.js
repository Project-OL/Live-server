import jwt from "jsonwebtoken";

/**
 * Socket.io authentication (SEC-05).
 *
 * The live and video-call socket handlers read `userId` from the handshake (`auth.userId` /
 * `query.userId`) and trusted it, so a client could connect as anyone. The app already sends its
 * access token (`auth.token`, `query.token`, `Authorization` header); this verifies it.
 *
 * LIVE_SOCKET_AUTH_MODE:
 *   off     - no checks (old behaviour)
 *   log     - default: verify and count outcomes, never reject, keep the claimed userId
 *   enforce - reject without a valid token; the userId always comes from the token
 *
 * An expired token with a valid signature still proves identity (only that user could have it),
 * so it is accepted for up to EXPIRED_GRACE_SEC. The app keeps the token it connected with across
 * socket.io auto-reconnects, so rejecting on expiry would lock hosts out mid-stream.
 */
export const EXPIRED_GRACE_SEC = 30 * 86400;

const MODES = new Set(["off", "log", "enforce"]);

export const socketAuthMode = () => {
    const m = String(process.env.LIVE_SOCKET_AUTH_MODE || "log").trim().toLowerCase();
    return MODES.has(m) ? m : "log";
};

const jwtSecret = () =>
    process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET || process.env.JWT_SECRET_KEY;

const stripBearer = (v) => {
    if (typeof v !== "string") return "";
    const s = v.trim();
    return s.toLowerCase().startsWith("bearer ") ? s.slice(7).trim() : s;
};

/** First token found in the places the app (and older builds) send it. */
export const extractSocketToken = (handshake = {}) => {
    const auth = handshake.auth || {};
    const query = handshake.query || {};
    const headers = handshake.headers || {};
    for (const v of [auth.token, auth.Authorization, auth.authorization, headers.authorization, query.token]) {
        const t = stripBearer(v);
        if (t) return t;
    }
    return "";
};

export const claimedUserId = (handshake = {}) => {
    const v = handshake.auth?.userId || handshake.query?.userId;
    return v ? String(v) : null;
};

/**
 * Verify the handshake token.
 * @returns {{ outcome: 'ok'|'expired_ok'|'missing'|'invalid'|'expired_too_old', userId: string|null }}
 */
export const verifySocketToken = (handshake, secret = jwtSecret(), nowSec = Math.floor(Date.now() / 1000)) => {
    const token = extractSocketToken(handshake);
    if (!token) return { outcome: "missing", userId: null };
    if (!secret) return { outcome: "invalid", userId: null };
    let payload;
    let outcome = "ok";
    try {
        payload = jwt.verify(token, secret);
    } catch (err) {
        if (err?.name !== "TokenExpiredError") return { outcome: "invalid", userId: null };
        try {
            payload = jwt.verify(token, secret, { ignoreExpiration: true });
        } catch {
            return { outcome: "invalid", userId: null };
        }
        if (!payload.exp || nowSec - payload.exp > EXPIRED_GRACE_SEC) {
            return { outcome: "expired_too_old", userId: null };
        }
        outcome = "expired_ok";
    }
    const userId = payload?.userId || payload?.sub;
    if (!userId) return { outcome: "invalid", userId: null };
    return { outcome, userId: String(userId) };
};

/** Make every existing handler (which reads the handshake) see the verified id. */
const pinHandshakeUserId = (handshake, userId) => {
    handshake.auth = { ...(handshake.auth || {}), userId };
    handshake.query = { ...(handshake.query || {}), userId, user_id: userId, uid: userId, id: userId };
};

// Rolling counters, printed every 10 minutes so log mode shows what enforce would reject.
const counts = {};
let windowStart = Date.now();
const bump = (key) => {
    counts[key] = (counts[key] || 0) + 1;
    if (Date.now() - windowStart >= 10 * 60 * 1000) {
        console.log(`[Socket Auth] mode=${socketAuthMode()} last 10m: ${JSON.stringify(counts)}`);
        for (const k of Object.keys(counts)) delete counts[k];
        windowStart = Date.now();
    }
};

/** socket.io middleware: io.use(socketAuthMiddleware) before any connection handler. */
export const socketAuthMiddleware = (socket, next) => {
    const mode = socketAuthMode();
    if (mode === "off") return next();

    const hs = socket.handshake;
    const claimed = claimedUserId(hs);
    const { outcome, userId } = verifySocketToken(hs);
    const mismatch = Boolean(userId && claimed && claimed !== userId);
    bump(mismatch ? `${outcome}_mismatch` : outcome);

    if (mismatch) {
        console.warn(`[Socket Auth] claimed userId ${claimed} but token is for ${userId} (mode=${mode})`);
    }
    socket.data = socket.data || {};
    socket.data.authUserId = userId;

    if (mode === "log") return next();

    // enforce
    if (!userId) {
        const err = new Error("unauthorized");
        err.data = { code: "SOCKET_UNAUTHORIZED", reason: outcome };
        return next(err);
    }
    pinHandshakeUserId(hs, userId);
    return next();
};
