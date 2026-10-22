import crypto from "crypto";
import { WalletCurrencyType, LedgerDirection, LevelType } from "@prisma/client";
import prisma from "../../config/prisma.js";
import { emitToUser } from "./socket.js";
import { closeLivekitRoom, generateLivekitToken } from "./livekit.js";
import { client as redisClient } from "../../config/redis.js";
import { moderateImage, uploadFlaggedFrameToS3 } from "./aws.service.js";
import { v2 } from "@google-cloud/translate";
import { checkCoinsFrozenFast } from "../../utils/coinRestriction.js";
import { broadcastToStream } from "../../routes/service/socket-live-service.js";
import { getSheetUsersService, removeUserFromSheetService } from "../../routes/service/serviceLive.js";
import { giftImageFields } from "../../utils/giftImage.js";
import { callLedger, toLocalError } from "../../services/ledgerClient.js";
import { unlinkByPattern } from "../../utils/redisScan.js";
import {
    isLeader,
    onShutdown,
    registerDurableHandler,
    scheduleDurable,
    cancelDurable,
    hasDurable
} from "../../services/cluster.service.js";
// Heartbeat disabled


/**
 * L2 (LIVE-09): call heartbeats are mirrored to Redis (`vc:hb:<sessionId>`), so
 * the sweep and the stale-call check see pings that reached another node. The
 * local Map stays as a fast path; reads take the newer of the two.
 */
export const heartbeatCache = new Map();
const HEARTBEAT_REDIS_TTL_SEC = 120;
const callHeartbeatKey = (sessionId) => `vc:hb:${sessionId}`;

export const recordHeartbeat = (sessionId, userId) => {
    if (!sessionId) return;
    const now = Date.now();
    heartbeatCache.set(sessionId, now);
    if (userId) {
        heartbeatCache.set(`${sessionId}:${userId}`, now);
    }
    if (redisClient.isOpen) {
        redisClient
            .set(callHeartbeatKey(sessionId), String(now), { EX: HEARTBEAT_REDIS_TTL_SEC })
            .catch((err) => console.error("[VideoCall] heartbeat redis set failed:", err.message));
    }
};

/** Latest heartbeat for a call from any node (epoch ms), or null. */
export const getCallHeartbeat = async (sessionId) => {
    const local = heartbeatCache.get(sessionId) || null;
    if (!redisClient.isOpen) return local;
    try {
        const raw = await redisClient.get(callHeartbeatKey(sessionId));
        const remote = raw ? Number(raw) : null;
        if (!remote || Number.isNaN(remote)) return local;
        return local && local > remote ? local : remote;
    } catch {
        return local;
    }
};

const clearCallHeartbeat = (sessionId, ...userIds) => {
    heartbeatCache.delete(sessionId);
    for (const u of userIds) if (u) heartbeatCache.delete(`${sessionId}:${u}`);
    if (redisClient.isOpen) redisClient.del(callHeartbeatKey(sessionId)).catch(() => { });
};

/**
 * L4 (LIVE-09): the two in-memory timers below are durable deadlines now
 * (cluster.service.js). A restart or another node still fires them, and the
 * handlers re-check state before acting.
 *   vc_lowcoin   end the call at the minute boundary the caller can't pay for
 *   host_return  end the host's paused live stream if they don't return in 2 min
 */
const LOWCOIN_TIMER = "vc_lowcoin";
const HOST_RETURN_TIMER = "host_return";

/** True when a low-balance disconnect is already pending for the call (any node). */
const lowCoinDisconnectPending = (sessionId) => hasDurable(LOWCOIN_TIMER, sessionId);

const scheduleLowCoinDisconnect = (sessionId, callerId, coinRate, disconnectAtMs, minute) =>
    scheduleDurable(LOWCOIN_TIMER, sessionId, disconnectAtMs, {
        callerId,
        coinRate: String(coinRate),
        disconnectAtMs,
        minute
    });

registerDurableHandler(LOWCOIN_TIMER, async (sessionId, payload) => {
    if (!payload?.callerId) return;
    const coinRate = BigInt(payload.coinRate);
    const fresh = await prisma.videoCallSession.findUnique({ where: { id: sessionId } });
    if (!fresh || fresh.status !== "ACTIVE") return;
    const w = await getOrCreateWallet(payload.callerId, WalletCurrencyType.COIN);
    const c = await getFastCoinBalance(w.id);
    if (c < coinRate) {
        console.log(`[VideoCall] Precision disconnect at minute ${payload.minute} boundary for session ${sessionId}`);
        await endCall(sessionId, payload.callerId, "INSUFFICIENT_BALANCE", new Date(payload.disconnectAtMs));
    }
});

export const clearHostReturnTimeout = (hostId) => {
    console.log(`[Return Grace Timer] Clearing background return timeout for host ${hostId}`);
    cancelDurable(HOST_RETURN_TIMER, hostId).catch(() => { });
};

registerDurableHandler(HOST_RETURN_TIMER, async (hostId, payload) => {
    const { streamId, sessionId } = payload || {};
    if (!streamId) return;
    const returnTimerKey1 = `host:return_timer:${streamId}:${hostId}`;
    const returnTimerKey2 = `host:return_timer:${hostId}`;
    let isStillPending = true;
    if (redisClient.isOpen) {
        const val1 = await redisClient.get(returnTimerKey1);
        const val2 = await redisClient.get(returnTimerKey2);
        isStillPending = (val1 === "pending" || val2 === "pending");
    }
    if (!isStillPending) return;

    console.log(`[VideoCall 2-Min Return Timeout] Host ${hostId} did NOT return to live stream ${streamId} within 2 minutes. Auto-ending live stream...`);
    if (redisClient.isOpen) {
        await Promise.all([
            redisClient.del(returnTimerKey1),
            redisClient.del(returnTimerKey2),
            sessionId ? redisClient.del(`video_call:stream_pause:${sessionId}`) : Promise.resolve()
        ]).catch(() => { });
    }

    const activeStream = await prisma.liveStream.findFirst({
        where: {
            OR: [{ streamId }, { userId: hostId }],
            isLive: true
        }
    });

    if (activeStream) {
        broadcastToStream(streamId, "stream_ended", {
            streamId,
            reason: "HOST_NOT_RETURNED_2MIN",
            message: "Live stream ended because host did not return within 2 minutes after video call."
        });

        const { endLiveStreamService } = await import("../../routes/service/serviceLive.js");
        await endLiveStreamService({ id: activeStream.id, userId: hostId, reason: "HOST_NOT_RETURNED_2MIN" });
        console.log(`[VideoCall 2-Min Return Timeout] Auto-ended live stream ${streamId} successfully.`);
    }
});

export const getOrCreateWallet = async (userId, currencyType, tx = prisma) => {
    let wallet = await tx.wallet.findUnique({
        where: { userId_currencyType: { userId, currencyType } }
    });
    if (!wallet) {
        // LIVE-56: find-then-create raced on a brand-new user's first parallel gifts; the losers hit
        // P2002, which aborts the money transaction and was reported as a duplicate send.
        // ON CONFLICT DO NOTHING waits for the concurrent creator instead.
        await tx.$executeRaw`
            INSERT INTO wallets (id, user_id, currency_type, version, unconfirmed_points, created_at, updated_at)
            VALUES (gen_random_uuid(), ${userId}::uuid, ${currencyType}::"WalletCurrencyType", 0, 0, NOW(), NOW())
            ON CONFLICT (user_id, currency_type) DO NOTHING
        `;
        wallet = await tx.wallet.findUnique({
            where: { userId_currencyType: { userId, currencyType } }
        });
    }
    return wallet;
};

export const getCoinBalance = async (walletId, tx = prisma) => {
    const credits = await tx.coinLedgerEntry.aggregate({
        where: { walletId, direction: LedgerDirection.CREDIT },
        _sum: { amount: true }
    });
    const debits = await tx.coinLedgerEntry.aggregate({
        where: { walletId, direction: LedgerDirection.DEBIT },
        _sum: { amount: true }
    });
    return (credits._sum.amount ?? 0n) - (debits._sum.amount ?? 0n);
};

export const getPointBalance = async (walletId, tx = prisma) => {
    const credits = await tx.pointLedgerEntry.aggregate({
        where: { walletId, direction: LedgerDirection.CREDIT },
        _sum: { amount: true }
    });
    const debits = await tx.pointLedgerEntry.aggregate({
        where: { walletId, direction: LedgerDirection.DEBIT },
        _sum: { amount: true }
    });
    return (credits._sum.amount ?? 0n) - (debits._sum.amount ?? 0n);
};

/**
 * Drop ol-node /commission/me + dashboard snapshots after a live/video-call
 * commission credit. INCR epoch so GET misses even if KEYS is empty.
 */
export const bustAgencyCommissionCaches = async (agencyUserId) => {
    if (!agencyUserId) return;
    try {
        await redisClient.incr(`agency:cache:epoch:${agencyUserId}`);
        await redisClient.del(`agency:rate:${agencyUserId}`);
        await redisClient.del(`agency:me:${agencyUserId}`);
        await redisClient.del(`agency:dashboard:today:${agencyUserId}`);
        const patterns = [
            `agency:commission:me:${agencyUserId}:*`,
            `agency:dashboard:earnings:${agencyUserId}:*`,
            `agency:dashboard:hosts:${agencyUserId}:*`,
            `agency:host:breakdown:${agencyUserId}:*`
        ];
        // LIVE-32: SCAN + UNLINK (the epoch INCR above already makes stale snapshots miss).
        for (const pattern of patterns) {
            await unlinkByPattern(pattern);
        }
    } catch (e) {
        console.error("[Agency] Cache invalidation error:", e);
    }
};

/**
 * LIVE-28: a short Redis lock on both users around the busy checks + session create, so a double tap
 * (or a client retry) can't create two RINGING sessions. Owner-checked release; the TTL bounds a
 * crash. Without Redis the old behaviour applies (DB checks only).
 */
const INITIATE_LOCK_MS = 5000;
const initiateLockKey = (userId) => `vc:initiate:lock:${userId}`;

const releaseInitiateLocks = async (keys, token) => {
    if (!redisClient.isOpen) return;
    for (const key of keys) {
        try {
            await redisClient.eval(
                "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
                { keys: [key], arguments: [token] }
            );
        } catch {
            // TTL clears it
        }
    }
};

export const initiateCall = async ({ callerId, creatorId }) => {
    if (callerId === creatorId) throw new Error("You can't call yourself.");
    if (!redisClient.isOpen) return initiateCallUnlocked({ callerId, creatorId });

    const token = crypto.randomUUID();
    const keys = [initiateLockKey(callerId), initiateLockKey(creatorId)];
    const held = [];
    try {
        for (const [i, key] of keys.entries()) {
            const ok = await redisClient.set(key, token, { NX: true, PX: INITIATE_LOCK_MS });
            if (ok !== "OK") {
                // Same answers the DB busy checks give a second, slower tap.
                if (i === 0) throw new Error("You are already in an active call.");
                emitToUser(callerId, "USER_BUSY", { creatorId });
                throw new Error("Receiver is currently busy.");
            }
            held.push(key);
        }
        return await initiateCallUnlocked({ callerId, creatorId });
    } finally {
        await releaseInitiateLocks(held, token);
    }
};

const initiateCallUnlocked = async ({ callerId, creatorId }) => {
    await checkCoinsFrozenFast(callerId);

    if (callerId === creatorId) throw new Error("You can't call yourself.");

    const creator = await prisma.user.findUnique({ where: { id: creatorId } });
    if (!creator) throw new Error("Receiver not found.");

    const settings = await prisma.videoCallSettings.findUnique({ where: { userId: creatorId } });
    if (!settings) throw new Error("Receiver has not enabled video calls.");

    if (settings.acceptVideoCalls === false) {
        throw new Error("This user is not accepting video calls right now.");
    }

    const isBlocked = await prisma.blockList.findFirst({
        where: {
            OR: [
                { blockerId: callerId, blockedId: creatorId },
                { blockerId: creatorId, blockedId: callerId }
            ]
        }
    });
    if (isBlocked) {
        throw new Error("Cannot call this user because of block restrictions.");
    }

    const wealthLevelRow = await prisma.walletUserLevel.findUnique({
        where: { userId_levelType: { userId: callerId, levelType: LevelType.WEALTH } }
    });
    const callerWealthLevel = wealthLevelRow ? wealthLevelRow.currentLevel : 1;

    if (settings.blockLv10 && callerWealthLevel <= 10) {
        throw new Error("Receiver is blocked for users below or equal to wealth level 10.");
    } else if (settings.blockLv5 && callerWealthLevel <= 5) {
        throw new Error("Receiver is blocked for users below or equal to wealth level 5.");
    }

    // Balance check for caller (1st minute rate)
    const coinRate = BigInt(Math.ceil((settings.pricePerMin * 5) / 3));
    const callerWallet = await getOrCreateWallet(callerId, WalletCurrencyType.COIN);
    const callerCoins = await getFastCoinBalance(callerWallet.id);

    if (callerCoins < coinRate) {
        throw new Error("Insufficient balance to initiate call.");
    }

    const callerBusy = await prisma.videoCallSession.findFirst({
        where: {
            OR: [
                { callerId: callerId, status: { in: ["RINGING", "ACTIVE"] } },
                { creatorId: callerId, status: { in: ["RINGING", "ACTIVE"] } }
            ]
        }
    });

    if (callerBusy) {
        let isStale = false;
        if (callerBusy.status === "RINGING") {
            const durationMs = Date.now() - new Date(callerBusy.startedAt).getTime();
            if (durationMs > 45000) {
                isStale = true;
            }
        } else if (callerBusy.status === "ACTIVE") {
            const lastPing = await getCallHeartbeat(callerBusy.id);
            if (!lastPing || (Date.now() - lastPing > 30000)) {
                isStale = true;
            }
        }

        if (isStale) {
            console.log(`[VideoCall] Cleaning up stale session ${callerBusy.id} for caller ${callerId}`);
            await endCall(callerBusy.id, callerBusy.callerId, "CLEANUP_STALE_BEFORE_INITIATE");
        } else {
            throw new Error("You are already in an active call.");
        }
    }

    const creatorBusy = await prisma.videoCallSession.findFirst({
        where: {
            OR: [
                { callerId: creatorId, status: { in: ["RINGING", "ACTIVE"] } },
                { creatorId: creatorId, status: { in: ["RINGING", "ACTIVE"] } }
            ]
        }
    });

    if (creatorBusy) {
        let isStale = false;
        if (creatorBusy.status === "RINGING") {
            const durationMs = Date.now() - new Date(creatorBusy.startedAt).getTime();
            if (durationMs > 45000) {
                isStale = true;
            }
        } else if (creatorBusy.status === "ACTIVE") {
            const lastPing = await getCallHeartbeat(creatorBusy.id);
            if (!lastPing || (Date.now() - lastPing > 30000)) {
                isStale = true;
            }
        }

        if (isStale) {
            console.log(`[VideoCall] Cleaning up stale session ${creatorBusy.id} for receiver ${creatorId}`);
            await endCall(creatorBusy.id, creatorBusy.callerId, "CLEANUP_STALE_BEFORE_INITIATE");
        } else {
            emitToUser(callerId, "USER_BUSY", { creatorId });
            throw new Error("Receiver is currently busy.");
        }
    }

    const livekitRoom = `room_${callerId}_${Date.now()}`;

    const session = await prisma.videoCallSession.create({
        data: {
            callerId,
            creatorId,
            livekitRoom,
            pricePerMin: settings.pricePerMin,
            status: "RINGING"
        }
    });

    const callerUser = await prisma.user.findUnique({
        where: { id: callerId },
        select: { username: true, firstName: true, lastName: true, avatarUrl: true, publicId: true }
    });

    const callerName = callerUser
        ? `${callerUser.firstName || ""} ${callerUser.lastName || ""}`.trim() || callerUser.username
        : "Unknown";
    const callerAvatar = callerUser ? callerUser.avatarUrl : null;
    const callerPublicId = callerUser && callerUser.publicId != null ? Number(callerUser.publicId) : null;

    emitToUser(creatorId, "CALL_INCOMING", {
        sessionId: session.id,
        callerId,
        callerPublicId,
        livekitRoom,
        callerName,
        callerAvatar
    });

    return session;
};

/**
 * BE-20 remote accept: ol-node-rest bills minute 1 (debit, credit, levels, commission) and flips the
 * session to ACTIVE in one transaction under the session row lock. The row is then read back with
 * this service's Prisma client, so the response is shaped exactly like the local path's.
 */
const acceptCallRemoteLedger = async (sessionId, receiverId) => {
    let r;
    try {
        r = await callLedger("CALL_ACCEPT", "call-accept", { sessionId, receiverId });
    } catch (err) {
        throw toLocalError(err, { insufficient: "Insufficient balance to accept call." });
    }
    const updatedSession = await prisma.videoCallSession.findUnique({ where: { id: sessionId } });
    return { updatedSession, agencyUserId: r.agencyUserId ?? null };
};

export const acceptCall = async (sessionId, receiverId) => {
    const session = await prisma.videoCallSession.findUnique({ where: { id: sessionId } });

    if (!session || session.status !== "RINGING" || session.creatorId !== receiverId) {
        throw new Error("Invalid session or unauthorized.");
    }

    await checkCoinsFrozenFast(session.callerId);

    const coinRate = BigInt(Math.ceil((session.pricePerMin * 5) / 3));
    const pointRate = BigInt(session.pricePerMin);

    // BE-20: minute 1 (balance check, debit, credit, levels, commission) and RINGING -> ACTIVE settle
    // in ol-node-rest's ledger in one transaction under the session row lock; it also drops the
    // balance/level caches and recomputes the agency tier. Strictly blocking: no tokens before it.
    // Live-server's own copy of this transaction was retired on 2026-10-21.
    const { updatedSession } = await acceptCallRemoteLedger(sessionId, receiverId);

    // Generate LiveKit tokens (In-memory, very fast!)
    const receiverToken = await generateLivekitToken(session.livekitRoom, receiverId, true);
    const callerToken = await generateLivekitToken(session.livekitRoom, session.callerId, false);

    // Fetch User Profiles (publicId, name, avatar) for both caller and receiver
    const [callerUser, receiverUser] = await Promise.all([
        prisma.user.findUnique({
            where: { id: session.callerId },
            select: { id: true, username: true, firstName: true, lastName: true, avatarUrl: true, publicId: true }
        }),
        prisma.user.findUnique({
            where: { id: receiverId },
            select: { id: true, username: true, firstName: true, lastName: true, avatarUrl: true, publicId: true }
        })
    ]);

    const callerPublicId = callerUser && callerUser.publicId != null ? Number(callerUser.publicId) : null;
    const callerName = callerUser ? `${callerUser.firstName || ""} ${callerUser.lastName || ""}`.trim() || callerUser.username : "Unknown";
    const callerAvatar = callerUser ? callerUser.avatarUrl : null;

    const receiverPublicId = receiverUser && receiverUser.publicId != null ? Number(receiverUser.publicId) : null;
    const receiverName = receiverUser ? `${receiverUser.firstName || ""} ${receiverUser.lastName || ""}`.trim() || receiverUser.username : "Unknown";
    const receiverAvatar = receiverUser ? receiverUser.avatarUrl : null;

    // Socket events (Sending receiver's publicId, profile & coin rate to Caller)
    emitToUser(session.callerId, "CALL_ACCEPTED", {
        sessionId,
        roomName: session.livekitRoom,
        token: callerToken,
        receiverId: session.creatorId,
        receiverPublicId,
        receiverName,
        receiverAvatar,
        coinRatePerMin: Number(coinRate)
    });

    recordHeartbeat(sessionId, session.callerId);
    recordHeartbeat(sessionId, session.creatorId);

    // LIVE-42: minute 2 is billed by this call's own timer at its boundary (the sweep is a backstop).
    scheduleNextBilling(updatedSession).catch(() => { });

    // 2nd minute precision disconnect check (Very fast, runs in background)
    (async () => {
        try {
            const w = await getOrCreateWallet(session.callerId, WalletCurrencyType.COIN);
            const c = await getFastCoinBalance(w.id);
            if (c < coinRate && !(await lowCoinDisconnectPending(sessionId))) {
                const startedAtMs = new Date(updatedSession.startedAt).getTime();
                const disconnectAtMs = startedAtMs + 60000; // end of 1st minute
                const msUntilDisconnect = disconnectAtMs - Date.now();
                if (msUntilDisconnect > 0) {
                    console.log(`[VideoCall] Caller cannot afford minute 2. Scheduling disconnect in ${msUntilDisconnect}ms for session ${sessionId}`);
                    await scheduleLowCoinDisconnect(sessionId, session.callerId, coinRate, disconnectAtMs, 1);
                }
            }
        } catch (e) {
            console.error("[VideoCall] Disconnect check scheduling error:", e);
        }
    })();

    // Run heavy/network-blocking tasks in the background asynchronously!
    (async () => {
        // 1. Pause live stream & auto-mute mic seat speakers immediately if host is live streaming
        try {
            const activeStream = await prisma.liveStream.findFirst({
                where: {
                    OR: [
                        { userId: session.creatorId },
                        { userId: session.callerId }
                    ],
                    isLive: true,
                    endedAt: null
                }
            });
            if (activeStream) {
                const streamId = activeStream.streamId || activeStream.id;
                await redisClient.set(`video_call:stream_pause:${sessionId}`, streamId, { EX: 86400 });

                broadcastToStream(streamId, "HOST_LIVE_PAUSED", {
                    streamId,
                    isPaused: true,
                    message: "Will Be Back"
                });

                const sheetUsers = await getSheetUsersService({ streamId });
                for (const su of sheetUsers) {
                    await removeUserFromSheetService({ streamId, userId: su.userId });
                    broadcastToStream(streamId, "user_left_sheet", {
                        userId: su.userId,
                        reason: "HOST_ON_VIDEO_CALL"
                    });
                }
            }
        } catch (pauseErr) {
            console.error("[VideoCall] Live Stream pause on call accept error:", pauseErr);
        }

        // (The agency tier is recomputed by ol-node-rest with the minute-1 commission.)
        console.log(`[VideoCall] Background tasks completed for session ${sessionId}`);
    })();

    return {
        session: updatedSession,
        token: receiverToken,
        callerId: session.callerId,
        callerPublicId,
        callerName,
        callerAvatar,
        pointRatePerMin: Number(pointRate),
        earnedRatioPercentage: 60
    };
};

export const rejectCall = async (sessionId, receiverId) => {
    const session = await prisma.videoCallSession.findUnique({ where: { id: sessionId } });

    if (!session || session.status !== "RINGING" || session.creatorId !== receiverId) {
        throw new Error("Invalid session or unauthorized.");
    }

    // Conditional: a reject racing an accept or an end must not overwrite them (LIVE-26).
    const { count } = await prisma.videoCallSession.updateMany({
        where: { id: sessionId, status: "RINGING" },
        data: { status: "REJECTED", endedAt: new Date(), endReason: "REJECTED_BY_RECEIVER" }
    });
    if (count === 0) {
        throw new Error("Invalid session or unauthorized.");
    }

    emitToUser(session.callerId, "CALL_REJECTED", { sessionId });

    return { success: true };
};

const SYSTEM_END_REASONS = ["HEARTBEAT_LOST", "INSUFFICIENT_BALANCE", "RINGING_TIMEOUT", "TEST_RESET", "SYSTEM_RESET", "ROOM_FINISHED_WEBHOOK", "VIOLATION_NUDITY"];

export const endCall = async (sessionId, userId, reason = "USER_ENDED", endedAtOverride = null) => {
    // LIVE-26: the user, the heartbeat sweep, the low-coin timer, the LiveKit webhook and the
    // disconnect grace can all end one call at the same moment. The status flip is conditional on
    // the status we read, so exactly one caller wins; only the winner emits, closes the room and
    // schedules the host-return timer. Losers get null, like a call that had already ended.
    // If the status moved under us (an accept turned RINGING into ACTIVE), re-read once and end
    // from the new state, so a billed call is never recorded as MISSED.
    let session = null;
    let updatedSession = null;
    for (let attempt = 0; attempt < 2 && !updatedSession; attempt++) {
        session = await prisma.videoCallSession.findUnique({ where: { id: sessionId } });
        if (!session || !["RINGING", "ACTIVE"].includes(session.status)) return null;

        // LIVE-27: system ends (e.g. a nudity block) pass no user; only user-initiated ends are
        // limited to the call's participants.
        const systemEnd = userId == null && SYSTEM_END_REASONS.includes(reason);
        if (!systemEnd && session.callerId !== userId && session.creatorId !== userId) {
            throw new Error("Unauthorized to end this call.");
        }

        const { count } = await prisma.videoCallSession.updateMany({
            where: { id: sessionId, status: session.status },
            data: {
                status: session.status === "RINGING" ? "MISSED" : "ENDED",
                endedAt: endedAtOverride || new Date(),
                endReason: reason
            }
        });
        if (count === 1) {
            updatedSession = await prisma.videoCallSession.findUnique({ where: { id: sessionId } });
        }
    }
    if (!updatedSession) return null;

    const socketEvent = session.status === "RINGING" ? "CALL_MISSED" : "CALL_ENDED";

    if (SYSTEM_END_REASONS.includes(reason) || userId == null) {
        emitToUser(session.callerId, socketEvent, { sessionId, reason });
        emitToUser(session.creatorId, socketEvent, { sessionId, reason });
    } else {
        const otherUser = session.callerId === userId ? session.creatorId : session.callerId;
        emitToUser(otherUser, socketEvent, { sessionId, reason });
    }

    closeLivekitRoom(session.livekitRoom).catch(err => {
        console.error(`[LiveKit] Background close room ${session.livekitRoom} failed:`, err);
    });
    clearCallHeartbeat(sessionId, session.callerId, session.creatorId);
    if (redisClient.isOpen) {
        if (session.callerId) redisClient.del(`call:disconnect:${sessionId}:${session.callerId}`).catch(() => { });
        if (session.creatorId) redisClient.del(`call:disconnect:${sessionId}:${session.creatorId}`).catch(() => { });
    }

    cancelDurable(LOWCOIN_TIMER, sessionId).catch(() => { });
    cancelDurable("vc_bill", sessionId).catch(() => { }); // LIVE-42 per-call billing timer
    // The 15s socket-disconnect grace (videoCall/socket.js) for either participant.
    if (session.callerId) cancelDurable("vc_disconnect", `${sessionId}:${session.callerId}`).catch(() => { });
    if (session.creatorId) cancelDurable("vc_disconnect", `${sessionId}:${session.creatorId}`).catch(() => { });

    // 2-Minute Host Return Grace Period for Live Stream
    (async () => {
        try {
            const streamId = await redisClient.get(`video_call:stream_pause:${sessionId}`);
            if (streamId) {
                let hostId = session.creatorId;
                const activeStreamByCreator = await prisma.liveStream.findFirst({
                    where: { userId: session.creatorId, isLive: true }
                });
                if (!activeStreamByCreator && session.callerId) {
                    const activeStreamByCaller = await prisma.liveStream.findFirst({
                        where: { userId: session.callerId, isLive: true }
                    });
                    if (activeStreamByCaller) {
                        hostId = session.callerId;
                    }
                }

                const returnTimerKey1 = `host:return_timer:${streamId}:${hostId}`;
                const returnTimerKey2 = `host:return_timer:${hostId}`;

                // Set 120-second (2 minute) return grace timer in Redis
                if (redisClient.isOpen) {
                    await Promise.all([
                        redisClient.set(returnTimerKey1, "pending", { EX: 120 }),
                        redisClient.set(returnTimerKey2, "pending", { EX: 120 })
                    ]).catch(() => { });
                }

                console.log(`[VideoCall End] Host ${hostId} has 2 minutes (120s) to return to live stream ${streamId} from Home screen.`);

                // 2-minute background deadline (replaces any earlier one for this host);
                // handled by HOST_RETURN_TIMER above.
                await scheduleDurable(HOST_RETURN_TIMER, hostId, Date.now() + 120000, { streamId, sessionId });
            }
        } catch (resumeErr) {
            console.error("[VideoCall] Live Stream 2-min return setup error:", resumeErr);
        }
    })();

    return updatedSession;
};

/**
 * SEC-10: participants of a call, cached in-process. They never change after initiate, and the
 * heartbeat (every few seconds per participant) must not cost a DB read each time.
 */
const participantCache = new Map();
const PARTICIPANT_CACHE_MS = 60000;

export const getCallParticipants = async (sessionId) => {
    if (!sessionId) return null;
    const hit = participantCache.get(sessionId);
    if (hit && hit.exp > Date.now()) return hit.value;
    const value = await prisma.videoCallSession.findUnique({
        where: { id: sessionId },
        select: { callerId: true, creatorId: true }
    });
    if (participantCache.size > 20000) participantCache.clear();
    participantCache.set(sessionId, { value, exp: Date.now() + PARTICIPANT_CACHE_MS });
    return value;
};

export const isCallParticipant = (participants, userId) =>
    Boolean(participants && userId && (participants.callerId === userId || participants.creatorId === userId));

export const getCallStatus = async (sessionId) => {
    return await prisma.videoCallSession.findUnique({
        where: { id: sessionId },
        select: { id: true, status: true, callerId: true, creatorId: true, startedAt: true }
    });
};

export const getCallSettingsForCaller = async ({ callerId, creatorId }) => {
    if (callerId === creatorId) {
        throw new Error("You cannot check call settings for yourself.");
    }

    const creator = await prisma.user.findUnique({ where: { id: creatorId } });
    if (!creator) throw new Error("Receiver not found.");

    const settings = await prisma.videoCallSettings.findUnique({ where: { userId: creatorId } });
    if (!settings) {
        throw new Error("Receiver has not enabled video calls.");
    }

    const isBlocked = await prisma.blockList.findFirst({
        where: {
            OR: [
                { blockerId: callerId, blockedId: creatorId },
                { blockerId: creatorId, blockedId: callerId }
            ]
        }
    });

    const wealthLevelRow = await prisma.walletUserLevel.findUnique({
        where: { userId_levelType: { userId: callerId, levelType: LevelType.WEALTH } }
    });
    const callerWealthLevel = wealthLevelRow ? wealthLevelRow.currentLevel : 1;

    let isEligible = true;
    let reason = null;

    if (settings.acceptVideoCalls === false) {
        isEligible = false;
        reason = "NOT_ACCEPTING_CALLS";
    } else if (isBlocked) {
        isEligible = false;
        reason = "BLOCKED";
    } else if (settings.blockLv10 && callerWealthLevel <= 10) {
        isEligible = false;
        reason = "WEALTH_BLOCKED_LV10";
    } else if (settings.blockLv5 && callerWealthLevel <= 5) {
        isEligible = false;
        reason = "WEALTH_BLOCKED_LV5";
    }

    const coinRate = BigInt(Math.ceil((settings.pricePerMin * 5) / 3));
    const callerWallet = await getOrCreateWallet(callerId, WalletCurrencyType.COIN);
    const callerCoins = await getFastCoinBalance(callerWallet.id);

    if (callerCoins < coinRate) {
        isEligible = false;
        if (!reason) {
            reason = "INSUFFICIENT_BALANCE";
        }
    }

    return {
        pricePerMin: settings.pricePerMin,
        callerRatePerMin: Number(coinRate),
        acceptVideoCalls: settings.acceptVideoCalls !== false,
        isVideoCallEnabled: settings.acceptVideoCalls !== false,
        isEligible,
        reason,
        callerWealthLevel,
        callerCoins: Number(callerCoins)
    };
};

/**
 * Bill every minute of an ACTIVE call that is due and not billed yet (LIVE-42).
 * Used by the per-call `vc_bill` timer (each call on its own minute boundary, in parallel) and by
 * the 5 s sweep as a backstop. Both paths lock the session row and skip billed minutes, so
 * they never double-bill each other. `session` is a fresh row.
 */
export const billDueMinutes = async (session) => {
    const elapsedMs = Date.now() - new Date(session.startedAt).getTime();
    const currentMinute = Math.floor(elapsedMs / 60000) + 1;

    if (currentMinute > session.minsCharged) {
        const coinRate = BigInt(Math.ceil((session.pricePerMin * 5) / 3));

        let hasFailed = false;

        for (let m = session.minsCharged + 1; m <= currentMinute; m++) {
            // Billing Guard: Check if caller was disconnected prior to or during minute m boundary
            let isCallerDisconnected = false;
            if (redisClient.isOpen) {
                const discVal = await redisClient.get(`call:disconnect:${session.id}:${session.callerId}`);
                if (discVal) {
                    const discTime = parseInt(discVal, 10);
                    const minStartTime = new Date(session.startedAt).getTime() + (m - 1) * 60000;
                    if (!isNaN(discTime) && discTime <= minStartTime + 5000) {
                        isCallerDisconnected = true;
                    }
                }
            }

            if (isCallerDisconnected) {
                console.log(`[VideoCall Billing Guard] Caller ${session.callerId} was disconnected prior to Minute ${m} boundary. Skipping Minute ${m} charge for session ${session.id}.`);
                break;
            }
            try {
                // BE-20: billed in ol-node-rest under the session row lock, so an ended call is
                // never billed and a minute is never billed twice; it also drops the caches and
                // recomputes the agency tier. (Live-server's local copy was retired 2026-10-21.)
                try {
                    await callLedger("CALL_MINUTE", "call-minute", { sessionId: session.id, minute: m });
                } catch (err) {
                    if (err.code === "INSUFFICIENT_COINS") throw new Error("INSUFFICIENT_BALANCE");
                    throw err;
                }

                if (!(await lowCoinDisconnectPending(session.id))) {
                    const wAfter = await getOrCreateWallet(session.callerId, WalletCurrencyType.COIN);
                    const coinsAfter = await getFastCoinBalance(wAfter.id);
                    if (coinsAfter < coinRate) {
                        const startMs = new Date(session.startedAt).getTime();
                        const disconnectAtMs = startMs + (m * 60000); // end of minute m
                        const msUntil = disconnectAtMs - Date.now();
                        if (msUntil > 0) {
                            console.log(`[VideoCall] Caller cannot afford minute ${m + 1}. Scheduling disconnect in ${msUntil}ms for session ${session.id}`);
                            await scheduleLowCoinDisconnect(session.id, session.callerId, coinRate, disconnectAtMs, m);
                        }
                    }
                }
            } catch (err) {
                if (err.message === "INSUFFICIENT_BALANCE") {
                    console.log(`[VideoCall] Session ${session.id} auto-ended due to insufficient balance.`);
                    await endCall(session.id, session.callerId, "INSUFFICIENT_BALANCE");
                    hasFailed = true;
                    break;
                } else if (err.message === "CALL_NOT_ACTIVE" || err.code === "CALL_NOT_ACTIVE") {
                    // Ended since the snapshot (LIVE-26): nothing to bill.
                    hasFailed = true;
                    break;
                } else if (err.message === "MINUTE_ALREADY_BILLED" || err.code === "MINUTE_OUT_OF_ORDER") {
                    // Another node billed it, or this snapshot is stale; the next tick re-reads.
                    hasFailed = true;
                    break;
                } else {
                    if (err.code === "P2002") {
                        console.log(`[VideoCall] Idempotency key match for minute ${m}, assuming already billed. Error detail:`, err);
                        await prisma.videoCallSession.updateMany({
                            where: { id: session.id, minsCharged: { lt: m } },
                            data: { minsCharged: m }
                        }).catch(() => { });
                    } else {
                        console.error(`[VideoCall] Transaction error billing session ${session.id} minute ${m}:`, err);
                        hasFailed = true;
                        break;
                    }
                }
            }
        }

        if (hasFailed) {
            return;
        }
    }
};

/**
 * LIVE-42: per-call billing deadline. Fires at the call's next minute boundary (durable: another
 * node or a restart still fires it), bills what is due, then schedules the next boundary. At most
 * BILL_CONCURRENCY billings run at once, so a burst of boundaries can't exhaust DB connections.
 */
const BILL_TIMER = "vc_bill";
const BILL_CONCURRENCY = 10;
const BILL_MIN_GAP_MS = 5000;
let billingInFlight = 0;
const billingWaiters = [];
const withBillingSlot = async (fn) => {
    if (billingInFlight >= BILL_CONCURRENCY) await new Promise((r) => billingWaiters.push(r));
    billingInFlight++;
    try {
        return await fn();
    } finally {
        billingInFlight--;
        billingWaiters.shift()?.();
    }
};

/** Schedule the next minute-boundary billing for an ACTIVE call (never sooner than 5 s from now). */
export const scheduleNextBilling = async (session) => {
    if (!session || session.status !== "ACTIVE" || !session.startedAt) return;
    const due = new Date(session.startedAt).getTime() + session.minsCharged * 60000;
    await scheduleDurable(BILL_TIMER, session.id, Math.max(due, Date.now() + BILL_MIN_GAP_MS)).catch(() => { });
};

registerDurableHandler(BILL_TIMER, async (sessionId) => {
    await withBillingSlot(async () => {
        const fresh = await prisma.videoCallSession.findUnique({ where: { id: sessionId } });
        if (!fresh || fresh.status !== "ACTIVE") return;
        await billDueMinutes(fresh);
        await scheduleNextBilling(await prisma.videoCallSession.findUnique({ where: { id: sessionId } }));
    });
});

/** LIVE-41: one tick at a time; a slow tick is logged and the overlapping one skipped. */
const guardedTick = (name, fn) => {
    let running = false;
    return async () => {
        if (running) {
            console.warn(`[${name}] previous tick still running; skipped`);
            return;
        }
        running = true;
        const started = Date.now();
        try {
            await fn();
        } finally {
            running = false;
            const ms = Date.now() - started;
            if (ms > 4000) console.warn(`[${name}] tick took ${ms} ms`);
        }
    };
};

if (process.env.NODE_ENV !== "test" && !process.env.IS_TEST) {
    const videoCallSweep = setInterval(guardedTick("videocall-sweep", async () => {
        // L5 (LIVE-09): billing, ringing timeouts and heartbeat ends run on one node only.
        try {
            if (!(await isLeader("videocall-sweep"))) return;
        } catch {
            return;
        }
        const now = Date.now();

        try {
            const activeSessionsForHeartbeat = await prisma.videoCallSession.findMany({
                where: { status: "ACTIVE" }
            });

            for (const session of activeSessionsForHeartbeat) {
                const sessionAge = now - new Date(session.startedAt).getTime();
                if (sessionAge > 45000) {
                    const sessionPing = (await getCallHeartbeat(session.id)) || new Date(session.startedAt).getTime();
                    if (now - sessionPing > 60000) {
                        console.log(`[VideoCall Protection] Global heartbeat lost for session ${session.id}. Auto-ending call.`);
                        heartbeatCache.delete(session.id);
                        await endCall(session.id, session.callerId, "HEARTBEAT_LOST");
                    }
                }
            }
        } catch (hbErr) {
            console.error("[VideoCall Protection] Heartbeat background check error:", hbErr.message);
        }

        try {
            const staleRingingTime = new Date(now - 45000);
            const staleRingingSessions = await prisma.videoCallSession.findMany({
                where: {
                    status: "RINGING",
                    startedAt: { lt: staleRingingTime }
                }
            });
            for (const session of staleRingingSessions) {
                console.log(`[VideoCall] Ringing timeout for session ${session.id}, auto-ending.`);
                await endCall(session.id, session.callerId, "RINGING_TIMEOUT");
            }
        } catch (err) {
            console.error("[VideoCall] Error ending stale ringing sessions in background:", err);
        }

        try {
            const activeSessions = await prisma.videoCallSession.findMany({
                where: { status: "ACTIVE" }
            });

            // Backstop for the per-call timers (LIVE-42): also re-arms a call whose timer was lost.
            for (const session of activeSessions) {
                await withBillingSlot(() => billDueMinutes(session));
                if (!(await hasDurable(BILL_TIMER, session.id))) {
                    await scheduleNextBilling(await prisma.videoCallSession.findUnique({ where: { id: session.id } }));
                }
            }
        } catch (err) {
            console.error("[VideoCall] Error during active session billing:", err);
        }
    }), 5000);
    onShutdown("videocall-sweep", () => clearInterval(videoCallSweep));
}

export const verifyCallFrame = async (sessionId, base64Image) => {
    try {
        const base64Data = base64Image.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, "base64");

        const check = await moderateImage(buffer);

        if (check.isViolation) {
            console.warn(`[Moderation] Nudity detected in session ${sessionId}. Action: ${check.action}, Label: ${check.label} (Confidence: ${check.confidence}%)`);

            // 1. Upload to S3 under folder "video-call-moderation"
            let s3Key = null;
            let s3Bucket = null;
            try {
                s3Key = `video-call-moderation/${sessionId}_${Date.now()}.jpg`;
                const uploadResult = await uploadFlaggedFrameToS3(buffer, s3Key);
                s3Bucket = uploadResult.bucket;
            } catch (s3Err) {
                console.error(`[Moderation] Failed to upload flagged frame to S3 for session ${sessionId}:`, s3Err);
            }

            // 2. Save log record in PostgreSQL via Prisma
            try {
                await prisma.videoCallModerationLog.create({
                    data: {
                        sessionId,
                        detectedLabel: check.label,
                        confidence: check.confidence,
                        action: check.action,
                        s3Key,
                        s3Bucket
                    }
                });
                console.log(`[Moderation] Saved log entry in DB for session ${sessionId}`);
            } catch (dbErr) {
                console.error(`[Moderation] Failed to save log entry in DB for session ${sessionId}:`, dbErr);
            }

            if (check.action === "BLOCK") {
                // End the call immediately with "VIOLATION_NUDITY"
                await endCall(sessionId, null, "VIOLATION_NUDITY");
                return { status: "BLOCKED", label: check.label };
            } else if (check.action === "WARNING") {
                // Send warning to both participants via socket
                const session = await prisma.videoCallSession.findUnique({
                    where: { id: sessionId },
                    select: { callerId: true, creatorId: true }
                });
                if (session) {
                    const warningPayload = {
                        sessionId,
                        message: `Warning: ${check.label} detected (${check.confidence.toFixed(1)}%). Please keep the call appropriate.`,
                        label: check.label,
                        confidence: check.confidence
                    };
                    emitToUser(session.callerId, "MODERATION_WARNING", warningPayload);
                    emitToUser(session.creatorId, "MODERATION_WARNING", warningPayload);
                }
                return { status: "WARNING", label: check.label, confidence: check.confidence };
            }
        }

        return { status: "CLEAN" };
    } catch (error) {
        console.error(`[Moderation] Failed to verify frame for session ${sessionId}:`, error);
        throw error;
    }
};

export const getFastCoinBalance = async (walletId, tx = prisma) => {
    const latest = await tx.coinLedgerEntry.findFirst({
        where: { walletId },
        orderBy: { createdAt: "desc" },
        select: { balanceAfter: true }
    });
    return latest ? latest.balanceAfter : 0n;
};

export const getFastPointBalance = async (walletId, tx = prisma) => {
    const latest = await tx.pointLedgerEntry.findFirst({
        where: { walletId },
        orderBy: { createdAt: "desc" },
        select: { balanceAfter: true }
    });
    return latest ? latest.balanceAfter : 0n;
};

/**
 * Send a gift inside a video call.
 *
 * The coin debit is decided by ol-node-rest's ledger (BE-20) inside a transaction holding
 * FOR UPDATE on both wallet rows, and the socket event is emitted only after that has
 * committed. ol-node-rest also refreshes the balance and level caches.
 *
 * `clientTxId`, when supplied, makes the send idempotent across client retries;
 * without it the ledger keys are still deterministic per logical send, so an
 * internal transaction retry can never produce a second debit.
 */
export const sendGift = async (sessionId, senderId, giftId, count = 1, clientTxId = null) => {
    // Fast pre-check to reject obviously-frozen senders before doing any work.
    // Authoritative re-check happens under the wallet lock below.
    await checkCoinsFrozenFast(senderId);

    const giftCount = Math.max(1, parseInt(count || 1, 10));

    const [session, gift, senderUser] = await Promise.all([
        prisma.videoCallSession.findUnique({
            where: { id: sessionId }
        }),
        prisma.gift.findUnique({
            where: { id: giftId }
        }),
        prisma.user.findUnique({
            where: { id: senderId },
            select: { username: true }
        })
    ]);

    if (!session) {
        throw new Error("Video call session not found.");
    }
    if (session.status !== "ACTIVE") {
        throw new Error("Video call session is not active.");
    }
    if (!gift || !gift.isActive) {
        throw new Error("Gift not found or is inactive.");
    }

    const receiverId = (senderId === session.callerId) ? session.creatorId : session.callerId;
    const receiverUser = await prisma.user.findUnique({
        where: { id: receiverId },
        select: { username: true }
    });

    const coinCost = BigInt(gift.coinCost) * BigInt(giftCount);
    const pointsAwarded = (coinCost * 60n) / 100n;
    const senderName = senderUser ? (senderUser.username || "User") : "User";
    const receiverName = receiverUser ? (receiverUser.username || "User") : "User";

    // The debit, the wealth-level bump, the host credit and the agency
    // commission all settle in one transaction that holds FOR UPDATE on both
    // wallet rows. Nothing is emitted and no cache is written until it commits.
    const giftTransactionId = crypto.randomUUID();
    const idemBase = clientTxId ? `gift:${senderId}:${clientTxId}` : `gift:${giftTransactionId}`;

    // BE-20: ol-node-rest settles the debit, credit, levels and commission and refreshes the shared
    // caches; this path keeps the socket events below. (Local copy retired 2026-10-21.)
    let settled;
    try {
        const r = await callLedger("GIFT_VIDEO_CALL", "gift", {
            context: "video_call",
            senderId,
            receiverId,
            giftId: gift.id,
            quantity: giftCount,
            giftTransactionId,
            idemBase,
            sessionId
        }, { clientTxId });
        settled = {
            balanceAfterCoins: BigInt(r.balanceAfterCoins),
            balanceAfterPoints: BigInt(r.balanceAfterPoints),
            finalLevel: r.wealth.newLevel,
            isLevelUp: r.wealth.newLevel > r.wealth.previousLevel
        };
    } catch (err) {
        throw toLocalError(err, { insufficient: "Insufficient coins to send this gift." });
    }

    const { balanceAfterCoins, finalLevel, isLevelUp } = settled;

    const socketPayload = {
        success: true,
        sessionId,
        senderId,
        senderName,
        receiverId,
        receiverName,
        count: giftCount,
        message: `${senderName} sent ${receiverName} ${gift.name} Ã—${giftCount}`,
        gift: {
            id: gift.id,
            name: gift.name,
            ...giftImageFields(gift),
            effectUrl: gift.effectUrl,
            vapUrl: gift.vapUrl,
            isVap: Boolean(gift.vapUrl)
        },
        wealthLevel: finalLevel,
        isLevelUp
    };

    emitToUser(session.callerId, "GIFT_SENT", socketPayload);
    emitToUser(session.creatorId, "GIFT_SENT", socketPayload);

    // Also emit RECEIVE_MESSAGE for Video Call Chat Window rendering (same as live stream)
    const chatMsgPayload = {
        senderId,
        senderName,
        text: `${senderName} sent ${gift.name} Ã—${giftCount}`,
        wealthLevel: finalLevel,
        isGift: true,
        gift: {
            id: gift.id,
            name: gift.name,
            ...giftImageFields(gift),
            count: giftCount
        },
        timestamp: new Date().toISOString()
    };
    emitToUser(session.callerId, "RECEIVE_MESSAGE", chatMsgPayload);
    emitToUser(session.creatorId, "RECEIVE_MESSAGE", chatMsgPayload);

    return {
        transactionId: giftTransactionId,
        newBalance: balanceAfterCoins,
        currentLevel: finalLevel,
        isLevelUp
    };
};

const translateClient = new v2.Translate();

export const translateText = async (text, targetLanguage) => {
    try {
        // Convert language code safely (e.g. "english" -> "en")
        const langMap = {
            "english": "en",
            "hindi": "hi",
            "russian": "ru",
            "spanish": "es",
            "french": "fr",
            "german": "de",
            "chinese": "zh",
            "arabic": "ar"
        };
        const target = langMap[targetLanguage.toLowerCase().trim()] || targetLanguage.trim();

        // LIVE-39: chat repeats the same lines; cache Google's answer per (target, text) for 24 h
        // (latency and per-character cost). A Redis failure just calls Google as before.
        const cacheKey = `translate:${target}:${crypto.createHash("sha1").update(String(text)).digest("hex")}`;
        if (redisClient.isOpen) {
            try {
                const hit = await redisClient.get(cacheKey);
                if (hit !== null) return { translatedText: hit };
            } catch { }
        }
        const [translation] = await translateClient.translate(text, target);
        if (redisClient.isOpen && typeof translation === "string") {
            redisClient.set(cacheKey, translation, { EX: 86400 }).catch(() => { });
        }
        return { translatedText: translation };
    } catch (error) {
        console.error("[Google Translate Error]:", error);
        throw new Error(`Translation failed: ${error.message}`);
    }
};
