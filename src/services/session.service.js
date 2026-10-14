/**
 * SEC-14: access-token revocation, mirrored from ol-node-rest
 * (`middlewares/auth.middleware.ts` applyVerifiedAccessPayload + `services/session.service.ts`).
 *
 * Both services verify the same access tokens, so a token ol-node-rest has revoked must stop
 * working here too: a ban, logout-all or password reset bumps users.token_version; a logout
 * revokes the session row; and devices can be banned. These are the same Redis keys, written by
 * ol-node-rest. Live-server only reads them:
 *   user:<userId>:token_version   cached users.token_version (ol-node-rest TTL 1h)
 *   session:<sessionId>           JSON { userId, revoked, sessionTokenVersion, ... }
 *   device:<deviceId>:banned      "1" | "0"
 * Missing keys fall back to Postgres (users.token_version, sessions). Nothing is written back,
 * because ol-node-rest owns those keys and their shapes. (The old Live-server-only cache
 * `user:token_version:<id>` is no longer read.)
 *
 * LIVE_SESSION_CHECK_MODE:
 *   log     - default: verify, count and log what would be rejected, let the request through
 *   enforce - reject with the same 401/403 codes ol-node-rest returns
 * A wrong check here would log every user out of live and calls, so it rolls out like SEC-05.
 */
import prisma from "../config/prisma.js";
import { client as redisClient } from "../config/redis.js";

const MODES = new Set(["log", "enforce"]);

export const sessionCheckMode = () => {
    const m = String(process.env.LIVE_SESSION_CHECK_MODE || "log").trim().toLowerCase();
    return MODES.has(m) ? m : "log";
};

export const sessionKeys = {
    userTokenVersion: (userId) => `user:${userId}:token_version`,
    session: (sessionId) => `session:${sessionId}`,
    deviceBanned: (deviceId) => `device:${deviceId}:banned`
};

const deny = (statusCode, code, message) => ({ ok: false, statusCode, code, message });
const ALLOW = { ok: true };

const redisMget = async (list) => {
    if (!redisClient.isOpen) return list.map(() => null);
    try {
        return await redisClient.mGet(list);
    } catch {
        return list.map(() => null);
    }
};

const defaultDeps = {
    mget: redisMget,
    findUserTokenVersion: async (userId) =>
        (await prisma.user.findUnique({ where: { id: userId }, select: { tokenVersion: true } }))?.tokenVersion ?? 0,
    findSession: (sessionId) =>
        prisma.session.findUnique({
            where: { id: sessionId },
            select: { userId: true, isRevoked: true, isActive: true, tokenVersion: true }
        })
};

/**
 * Decide whether a verified access-token payload is still valid.
 * `deps` is for unit tests; production uses Redis + Prisma.
 * @returns {Promise<{ok: true} | {ok: false, statusCode: number, code: string, message: string}>}
 */
export const checkAccessPayload = async (payload, deps = defaultDeps) => {
    const userId = payload?.userId || payload?.sub;
    if (!userId) return deny(401, "INVALID_TOKEN", "Invalid token");

    const sessionId = payload.sessionId || null;
    const deviceId = typeof payload.deviceId === "string" ? payload.deviceId.trim() : "";

    const list = [sessionKeys.userTokenVersion(userId)];
    if (sessionId) list.push(sessionKeys.session(sessionId));
    if (deviceId) list.push(sessionKeys.deviceBanned(deviceId));
    const values = await deps.mget(list);
    let i = 0;
    const tvRaw = values[i++];
    const sessionRaw = sessionId ? values[i++] : null;
    const deviceBanned = deviceId ? values[i++] : null;

    const tokenTv = payload.tokenVersion ?? 0;
    const userTv =
        tvRaw !== null && tvRaw !== undefined && tvRaw !== "" ? Number(tvRaw) : await deps.findUserTokenVersion(userId);
    if (tokenTv !== userTv) {
        return deny(401, "SESSION_INVALID", "Session revoked. Please log in again.");
    }

    if (sessionId) {
        const expected = payload.sessionTokenVersion ?? 0;
        let blob = null;
        if (sessionRaw) {
            try {
                blob = JSON.parse(sessionRaw);
            } catch {
                blob = { revoked: true };
            }
        }
        if (blob) {
            if (blob.revoked || blob.userId !== userId) return deny(401, "SESSION_INVALID", "Session invalid");
            if (blob.sessionTokenVersion !== expected) return deny(401, "SESSION_TOKEN_STALE", "Session token stale");
        } else {
            const row = await deps.findSession(sessionId);
            if (!row || row.isRevoked || !row.isActive || row.userId !== userId) {
                return deny(401, "SESSION_INVALID", "Session invalid");
            }
            if (row.tokenVersion !== expected) return deny(401, "SESSION_TOKEN_STALE", "Session token stale");
        }
    }

    // ol-node-rest refreshes this cache on every authenticated request; a miss is not a ban.
    if (deviceBanned === "1") {
        return deny(403, "DEVICE_BANNED", "This device has been banned from the platform");
    }

    return ALLOW;
};

/** At most one "would reject" line per user per 10 minutes (heartbeats repeat every few seconds). */
const lastLoggedAt = new Map();
export const shouldLogRejection = (userId) => {
    const now = Date.now();
    if (now - (lastLoggedAt.get(userId) || 0) < 10 * 60 * 1000) return false;
    if (lastLoggedAt.size > 20000) lastLoggedAt.clear();
    lastLoggedAt.set(userId, now);
    return true;
};

// Rolling counters, printed every 10 minutes so log mode shows what enforce would reject.
const counts = {};
let windowStart = Date.now();
export const recordSessionCheck = (where, result) => {
    const key = `${where}:${result.ok ? "ok" : result.code}`;
    counts[key] = (counts[key] || 0) + 1;
    if (Date.now() - windowStart >= 10 * 60 * 1000) {
        console.log(`[Session Check] mode=${sessionCheckMode()} last 10m: ${JSON.stringify(counts)}`);
        for (const k of Object.keys(counts)) delete counts[k];
        windowStart = Date.now();
    }
};
