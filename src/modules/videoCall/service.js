import { WalletCurrencyType, LedgerDirection, CoinTxType, PointTxType, LevelType } from "@prisma/client";
import prisma from "../../config/prisma.js";
import { emitToUser } from "./socket.js";
import { closeLivekitRoom, generateLivekitToken } from "./livekit.js";
import { client as redisClient } from "../../config/redis.js";
import { moderateImage, uploadFlaggedFrameToS3 } from "./aws.service.js";
import { v2 } from "@google-cloud/translate";
import { checkCoinsFrozenFast } from "../../utils/coinRestriction.js";
import { broadcastToStream } from "../../routes/service/socket-live-service.js";
import { getSheetUsersService, removeUserFromSheetService } from "../../routes/service/serviceLive.js";

export const heartbeatCache = new Map();

export const scheduledDisconnects = new Map();

export const activeReturnTimeouts = new Map();

export const clearHostReturnTimeout = (hostId) => {
    if (activeReturnTimeouts.has(hostId)) {
        console.log(`[Return Grace Timer] Clearing stale background return timeout for host ${hostId}`);
        clearTimeout(activeReturnTimeouts.get(hostId));
        activeReturnTimeouts.delete(hostId);
    }
};

export const getOrCreateWallet = async (userId, currencyType, tx = prisma) => {
    let wallet = await tx.wallet.findUnique({
        where: { userId_currencyType: { userId, currencyType } }
    });
    if (!wallet) {
        wallet = await tx.wallet.create({
            data: {
                userId,
                currencyType,
                version: 0n
            }
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

export const processAgencyCommission = async (tx, hostId, hostPoints, hostLedgerEntryId) => {
    const hostUser = await tx.user.findUnique({
        where: { id: hostId },
        select: { currentAgencyId: true, username: true, firstName: true }
    });

    if (!hostUser) return null;

    const hostName = hostUser.username || hostUser.firstName || "Host";

    let agencyUserId = hostUser.currentAgencyId;

    // If host is not under an external agency, check if host is an agency owner themselves
    if (!agencyUserId) {
        const selfAgency = await tx.agency.findUnique({
            where: { userId: hostId },
            select: { userId: true }
        });
        if (selfAgency) {
            agencyUserId = hostId;
        }
    }

    if (!agencyUserId) return null;

    const agency = await tx.agency.findUnique({
        where: { userId: agencyUserId },
        select: { currentLevel: true }
    });
    if (!agency) return null;

    const levelConfig = await tx.agencyCommissionLevel.findUnique({
        where: { level: agency.currentLevel }
    });
    if (!levelConfig) return null;

    const rateBp = levelConfig.matchChatRateBp;
    const commissionPoints = BigInt(Math.floor((Number(hostPoints) * rateBp) / 10000));

    await tx.agencyCommissionProcessed.create({
        data: {
            hostLedgerEntryId
        }
    });

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    await tx.agencyDailyEarning.upsert({
        where: {
            agencyUserId_hostUserId_day: {
                agencyUserId,
                hostUserId: hostId,
                day: today
            }
        },
        update: {
            hostEarningsPoints: { increment: hostPoints },
            hostCommissionPoints: { increment: commissionPoints }
        },
        create: {
            agencyUserId,
            hostUserId: hostId,
            day: today,
            hostEarningsPoints: hostPoints,
            hostCommissionPoints: commissionPoints
        }
    });

    let agentLedgerEntry = null;
    if (commissionPoints > 0n) {
        const agentWallet = await getOrCreateWallet(agencyUserId, WalletCurrencyType.POINT, tx);
        const agentPoints = await getFastPointBalance(agentWallet.id, tx);
        const balanceAfter = agentPoints + commissionPoints;

        agentLedgerEntry = await tx.pointLedgerEntry.create({
            data: {
                walletId: agentWallet.id,
                direction: LedgerDirection.CREDIT,
                txType: PointTxType.AGENT_COMMISSION,
                amount: commissionPoints,
                balanceAfter,
                idempotencyKey: `agency-commission-${hostLedgerEntryId}`,
                refId: hostLedgerEntryId,
                counterpartyId: hostId,
                description: `Commission earned from host ${hostName} in video call`
            }
        });
    }

    return { agencyUserId, commissionPoints, agentLedgerEntry };
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
        for (const pattern of patterns) {
            const keys = await redisClient.keys(pattern);
            if (keys && keys.length > 0) {
                await redisClient.del(keys);
            }
        }
    } catch (e) {
        console.error("[Agency] Cache invalidation error:", e);
    }
};

export const invalidateCaches = async (callerId, hostId, agencyUserId = null) => {
    try {
        await redisClient.del(`wallet:coins:${callerId}`);
        await redisClient.del(`level:wealth:${callerId}`);

        await redisClient.del(`wallet:points:${hostId}`);
        await redisClient.del(`level:stream:${hostId}`);

        if (agencyUserId) {
            await bustAgencyCommissionCaches(agencyUserId);
        }
    } catch (e) {
        console.error("[VideoCall] Cache invalidation error:", e);
    }
};

export const updateUserLevel = async (tx, userId, levelType, increment) => {
    const current = await tx.walletUserLevel.upsert({
        where: { userId_levelType: { userId, levelType } },
        create: {
            userId,
            levelType,
            currentLevel: 1,
            cumulativeTotal: 0n
        },
        update: {}
    });

    const newCumulative = current.cumulativeTotal + BigInt(increment);

    const thresholds = await tx.walletLevelConfig.findMany({
        where: { levelType, isActive: true },
        orderBy: { level: "asc" }
    });

    let newLevel = 1;
    for (const t of thresholds) {
        if (newCumulative >= t.threshold) {
            newLevel = t.level;
        } else {
            break;
        }
    }

    await tx.walletUserLevel.update({
        where: { userId_levelType: { userId, levelType } },
        data: {
            cumulativeTotal: newCumulative,
            currentLevel: newLevel
        }
    });

    try {
        if (levelType === LevelType.LIVESTREAM) {
            await tx.userLevel.upsert({
                where: { userId },
                create: { userId, livestreamLevel: newLevel, livestreamXp: newCumulative },
                update: { livestreamLevel: newLevel, livestreamXp: newCumulative }
            });
        } else if (levelType === LevelType.WEALTH) {
            await tx.userLevel.upsert({
                where: { userId },
                create: { userId, wealthLevel: newLevel, wealthXp: newCumulative },
                update: { wealthLevel: newLevel, wealthXp: newCumulative }
            });
        }
    } catch (syncErr) {
        console.error("UserLevel Lvl sync err: -------->", syncErr.message);
    }

    return { newLevel, previousLevel: current.currentLevel, newCumulative };
};

export const initiateCall = async ({ callerId, creatorId }) => {
    await checkCoinsFrozenFast(callerId);

    if (callerId === creatorId) throw new Error("You can't call yourself.");

    const creator = await prisma.user.findUnique({ where: { id: creatorId } });
    if (!creator) throw new Error("Receiver not found.");

    const settings = await prisma.videoCallSettings.findUnique({ where: { userId: creatorId } });
    if (!settings) throw new Error("Receiver has not enabled video calls.");

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
            const lastPing = heartbeatCache.get(callerBusy.id);
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
            const lastPing = heartbeatCache.get(creatorBusy.id);
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

export const acceptCall = async (sessionId, receiverId) => {
    const session = await prisma.videoCallSession.findUnique({ where: { id: sessionId } });

    if (!session || session.status !== "RINGING" || session.creatorId !== receiverId) {
        throw new Error("Invalid session or unauthorized.");
    }

    await checkCoinsFrozenFast(session.callerId);

    const coinRate = BigInt(Math.ceil((session.pricePerMin * 5) / 3));
    const pointRate = BigInt(session.pricePerMin);

    // 1st minute balance check & core balance debit/credit (Strictly blocking)
    const { updatedSession, hostLedgerId } = await prisma.$transaction(async (tx) => {
        const callerWallet = await getOrCreateWallet(session.callerId, WalletCurrencyType.COIN, tx);
        const hostWallet = await getOrCreateWallet(session.creatorId, WalletCurrencyType.POINT, tx);

        const callerCoins = await getFastCoinBalance(callerWallet.id, tx);
        if (callerCoins < coinRate) {
            throw new Error("Insufficient balance to accept call.");
        }

        const balanceAfterCoins = callerCoins - coinRate;
        await tx.coinLedgerEntry.create({
            data: {
                walletId: callerWallet.id,
                direction: LedgerDirection.DEBIT,
                txType: CoinTxType.VIDEO_CALL,
                amount: coinRate,
                balanceAfter: balanceAfterCoins,
                idempotencyKey: `call-${session.id}-min-1-coins`,
                refId: session.id,
                counterpartyId: session.creatorId,
                description: `Video call minute 1 charge`
            }
        });

        const hostPoints = await getFastPointBalance(hostWallet.id, tx);
        const balanceAfterPoints = hostPoints + pointRate;
        const hostLedger = await tx.pointLedgerEntry.create({
            data: {
                walletId: hostWallet.id,
                direction: LedgerDirection.CREDIT,
                txType: PointTxType.VIDEO_CALL,
                amount: pointRate,
                balanceAfter: balanceAfterPoints,
                idempotencyKey: `call-${session.id}-min-1-points`,
                refId: session.id,
                counterpartyId: session.callerId,
                description: `Points for video call minute 1`
            }
        });

        const updated = await tx.videoCallSession.update({
            where: { id: sessionId },
            data: {
                status: "ACTIVE",
                startedAt: new Date(),
                minsCharged: 1,
                coinsDeducted: coinRate,
                pointsAwarded: pointRate
            }
        });

        return { updatedSession: updated, hostLedgerId: hostLedger.id };
    }, { timeout: 10000 });

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

    heartbeatCache.set(sessionId, Date.now());

    // 2nd minute precision disconnect check (Very fast, runs in background)
    (async () => {
        try {
            const w = await getOrCreateWallet(session.callerId, WalletCurrencyType.COIN);
            const c = await getFastCoinBalance(w.id);
            if (c < coinRate && !scheduledDisconnects.has(sessionId)) {
                const startedAtMs = new Date(updatedSession.startedAt).getTime();
                const disconnectAtMs = startedAtMs + 60000; // end of 1st minute
                const msUntilDisconnect = disconnectAtMs - Date.now();
                if (msUntilDisconnect > 0) {
                    console.log(`[VideoCall] Caller cannot afford minute 2. Scheduling disconnect in ${msUntilDisconnect}ms for session ${sessionId}`);
                    const tid = setTimeout(async () => {
                        try {
                            const fresh = await prisma.videoCallSession.findUnique({ where: { id: sessionId } });
                            if (!fresh || fresh.status !== "ACTIVE") return;
                            const freshW = await getOrCreateWallet(session.callerId, WalletCurrencyType.COIN);
                            const freshC = await getFastCoinBalance(freshW.id);
                            if (freshC < coinRate) {
                                console.log(`[VideoCall] Precision disconnect at minute boundary for session ${sessionId}`);
                                await endCall(sessionId, session.callerId, "INSUFFICIENT_BALANCE", new Date(disconnectAtMs));
                            }
                        } catch (e) {
                            console.error("[VideoCall] Precision disconnect error:", e);
                        } finally {
                            scheduledDisconnects.delete(sessionId);
                        }
                    }, msUntilDisconnect);
                    scheduledDisconnects.set(sessionId, tid);
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
                await redisClient.set(`video_call:stream_pause:${sessionId}`, streamId, 'EX', 86400);

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

        try {
            // 2. Process Agency Commission
            const commRes = await processAgencyCommission(prisma, session.creatorId, pointRate, hostLedgerId);
            const agencyUserId = commRes ? commRes.agencyUserId : null;

            // 3. Update User Levels
            await updateUserLevel(prisma, session.callerId, LevelType.WEALTH, coinRate);
            await updateUserLevel(prisma, session.creatorId, LevelType.LIVESTREAM, pointRate);

            // 4. Cache Invalidation
            await invalidateCaches(session.callerId, session.creatorId, agencyUserId);

            console.log(`[VideoCall] Background tasks completed for session ${sessionId}`);
        } catch (e) {
            console.error(`[VideoCall] Background tasks failed for session ${sessionId}:`, e);
        }
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

    await prisma.videoCallSession.update({
        where: { id: sessionId },
        data: { status: "REJECTED", endedAt: new Date(), endReason: "REJECTED_BY_RECEIVER" }
    });

    emitToUser(session.callerId, "CALL_REJECTED", { sessionId });

    return { success: true };
};

export const endCall = async (sessionId, userId, reason = "USER_ENDED", endedAtOverride = null) => {
    const session = await prisma.videoCallSession.findUnique({ where: { id: sessionId } });
    if (!session || !["RINGING", "ACTIVE"].includes(session.status)) return null;

    if (session.callerId !== userId && session.creatorId !== userId) {
        throw new Error("Unauthorized to end this call.");
    }

    const endedAt = endedAtOverride || new Date();

    const newStatus = session.status === "RINGING" ? "MISSED" : "ENDED";
    const socketEvent = session.status === "RINGING" ? "CALL_MISSED" : "CALL_ENDED";

    const updatedSession = await prisma.videoCallSession.update({
        where: { id: sessionId },
        data: {
            status: newStatus,
            endedAt,
            endReason: reason
        }
    });

    const systemReasons = ["HEARTBEAT_LOST", "INSUFFICIENT_BALANCE", "RINGING_TIMEOUT", "TEST_RESET", "SYSTEM_RESET", "ROOM_FINISHED_WEBHOOK"];
    if (systemReasons.includes(reason)) {
        emitToUser(session.callerId, socketEvent, { sessionId, reason });
        emitToUser(session.creatorId, socketEvent, { sessionId, reason });
    } else {
        const otherUser = session.callerId === userId ? session.creatorId : session.callerId;
        emitToUser(otherUser, socketEvent, { sessionId, reason });
    }

    closeLivekitRoom(session.livekitRoom).catch(err => {
        console.error(`[LiveKit] Background close room ${session.livekitRoom} failed:`, err);
    });
    heartbeatCache.delete(sessionId);

    if (scheduledDisconnects.has(sessionId)) {
        clearTimeout(scheduledDisconnects.get(sessionId));
        scheduledDisconnects.delete(sessionId);
    }

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
                        redisClient.set(returnTimerKey1, "pending", "EX", 120),
                        redisClient.set(returnTimerKey2, "pending", "EX", 120)
                    ]).catch(() => {});
                }

                console.log(`[VideoCall End] Host ${hostId} has 2 minutes (120s) to return to live stream ${streamId} from Home screen.`);

                // Clear any previous stale 2-minute return timeout for this host
                clearHostReturnTimeout(hostId);

                // 2-minute (120,000 ms) background worker
                const returnHandle = setTimeout(async () => {
                    activeReturnTimeouts.delete(hostId);
                    try {
                        let isStillPending = true;
                        if (redisClient.isOpen) {
                            const val1 = await redisClient.get(returnTimerKey1);
                            const val2 = await redisClient.get(returnTimerKey2);
                            isStillPending = (val1 === "pending" || val2 === "pending");
                        }

                        if (isStillPending) {
                            console.log(`[VideoCall 2-Min Return Timeout] Host ${hostId} did NOT return to live stream ${streamId} within 2 minutes. Auto-ending live stream...`);
                            if (redisClient.isOpen) {
                                await Promise.all([
                                    redisClient.del(returnTimerKey1),
                                    redisClient.del(returnTimerKey2),
                                    redisClient.del(`video_call:stream_pause:${sessionId}`)
                                ]).catch(() => {});
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
                                await endLiveStreamService({ id: activeStream.id, userId: hostId });
                                console.log(`[VideoCall 2-Min Return Timeout] Auto-ended live stream ${streamId} successfully! ✅`);
                            }
                        }
                    } catch (timeoutErr) {
                        console.error("[VideoCall 2-Min Return Timeout Error]:", timeoutErr.message);
                    }
                }, 120000);

                activeReturnTimeouts.set(hostId, returnHandle);
            }
        } catch (resumeErr) {
            console.error("[VideoCall] Live Stream 2-min return setup error:", resumeErr);
        }
    })();

    return updatedSession;
};

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

    if (isBlocked) {
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
        isEligible,
        reason,
        callerWealthLevel,
        callerCoins: Number(callerCoins)
    };
};

if (process.env.NODE_ENV !== "test" && !process.env.IS_TEST) {
    setInterval(async () => {
        const now = Date.now();

        for (const [sessionId, lastPing] of heartbeatCache.entries()) {
            if (now - lastPing > 30000) {
                console.log(`[VideoCall] Heartbeat lost for session ${sessionId}, auto-ending.`);
                heartbeatCache.delete(sessionId);

                const session = await prisma.videoCallSession.findUnique({ where: { id: sessionId } });
                if (session && session.status === "ACTIVE") {
                    await endCall(sessionId, session.callerId, "HEARTBEAT_LOST");
                }
            }
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

            for (const session of activeSessions) {
                const elapsedMs = Date.now() - new Date(session.startedAt).getTime();
                const currentMinute = Math.floor(elapsedMs / 60000) + 1;

                if (currentMinute > session.minsCharged) {
                    const coinRate = BigInt(Math.ceil((session.pricePerMin * 5) / 3));
                    const pointRate = BigInt(session.pricePerMin);

                    let currentCoinsDeducted = session.coinsDeducted;
                    let currentPointsAwarded = session.pointsAwarded;
                    let hasFailed = false;

                    for (let m = session.minsCharged + 1; m <= currentMinute; m++) {
                        try {
                            let txAgencyUserId = null;
                            await prisma.$transaction(async (tx) => {
                                const callerWallet = await getOrCreateWallet(session.callerId, WalletCurrencyType.COIN, tx);
                                const hostWallet = await getOrCreateWallet(session.creatorId, WalletCurrencyType.POINT, tx);

                                const callerCoins = await getFastCoinBalance(callerWallet.id, tx);
                                if (callerCoins < coinRate) {
                                    throw new Error("INSUFFICIENT_BALANCE");
                                }

                                const balanceAfterCoins = callerCoins - coinRate;
                                await tx.coinLedgerEntry.create({
                                    data: {
                                        walletId: callerWallet.id,
                                        direction: LedgerDirection.DEBIT,
                                        txType: CoinTxType.VIDEO_CALL,
                                        amount: coinRate,
                                        balanceAfter: balanceAfterCoins,
                                        idempotencyKey: `call-${session.id}-min-${m}-coins`,
                                        refId: session.id,
                                        counterpartyId: session.creatorId,
                                        description: `Video call minute ${m} charge`
                                    }
                                });

                                const hostPoints = await getFastPointBalance(hostWallet.id, tx);
                                const balanceAfterPoints = hostPoints + pointRate;
                                const hostLedger = await tx.pointLedgerEntry.create({
                                    data: {
                                        walletId: hostWallet.id,
                                        direction: LedgerDirection.CREDIT,
                                        txType: PointTxType.VIDEO_CALL,
                                        amount: pointRate,
                                        balanceAfter: balanceAfterPoints,
                                        idempotencyKey: `call-${session.id}-min-${m}-points`,
                                        refId: session.id,
                                        counterpartyId: session.callerId,
                                        description: `Points for video call minute ${m}`
                                    }
                                });

                                const commRes = await processAgencyCommission(tx, session.creatorId, pointRate, hostLedger.id);
                                txAgencyUserId = commRes ? commRes.agencyUserId : null;

                                await updateUserLevel(tx, session.callerId, LevelType.WEALTH, coinRate);
                                await updateUserLevel(tx, session.creatorId, LevelType.LIVESTREAM, pointRate);

                                currentCoinsDeducted += coinRate;
                                currentPointsAwarded += pointRate;

                                await tx.videoCallSession.update({
                                    where: { id: session.id },
                                    data: {
                                        minsCharged: m,
                                        coinsDeducted: currentCoinsDeducted,
                                        pointsAwarded: currentPointsAwarded
                                    }
                                });
                            }, { timeout: 15000 });

                            await invalidateCaches(session.callerId, session.creatorId, txAgencyUserId);

                            if (!scheduledDisconnects.has(session.id)) {
                                const wAfter = await getOrCreateWallet(session.callerId, WalletCurrencyType.COIN);
                                const coinsAfter = await getFastCoinBalance(wAfter.id);
                                if (coinsAfter < coinRate) {
                                    const startMs = new Date(session.startedAt).getTime();
                                    const disconnectAtMs = startMs + (m * 60000); // end of minute m
                                    const msUntil = disconnectAtMs - Date.now();
                                    if (msUntil > 0) {
                                        console.log(`[VideoCall] Caller cannot afford minute ${m + 1}. Scheduling disconnect in ${msUntil}ms for session ${session.id}`);
                                        const tid = setTimeout(async () => {
                                            try {
                                                const fs = await prisma.videoCallSession.findUnique({ where: { id: session.id } });
                                                if (!fs || fs.status !== "ACTIVE") return;
                                                const wCheck = await getOrCreateWallet(session.callerId, WalletCurrencyType.COIN);
                                                const cCheck = await getFastCoinBalance(wCheck.id);
                                                if (cCheck < coinRate) {
                                                    console.log(`[VideoCall] Precision disconnect at minute ${m} boundary for session ${session.id}`);
                                                    await endCall(session.id, session.callerId, "INSUFFICIENT_BALANCE", new Date(disconnectAtMs));
                                                }
                                            } catch (e) {
                                                console.error("[VideoCall] Precision disconnect error:", e);
                                            } finally {
                                                scheduledDisconnects.delete(session.id);
                                            }
                                        }, msUntil);
                                        scheduledDisconnects.set(session.id, tid);
                                    }
                                }
                            }
                        } catch (err) {
                            if (err.message === "INSUFFICIENT_BALANCE") {
                                console.log(`[VideoCall] Session ${session.id} auto-ended due to insufficient balance.`);
                                await endCall(session.id, session.callerId, "INSUFFICIENT_BALANCE");
                                hasFailed = true;
                                break;
                            } else {
                                if (err.code === "P2002") {
                                    console.log(`[VideoCall] Idempotency key match for minute ${m}, assuming already billed. Error detail:`, err);
                                    await prisma.videoCallSession.update({
                                        where: { id: session.id },
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
                        continue;
                    }
                }
            }
        } catch (err) {
            console.error("[VideoCall] Error during active session billing:", err);
        }
    }, 5000);
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

export const sendGift = async (sessionId, senderId, giftId, count = 1) => {
    await checkCoinsFrozenFast(senderId);

    const giftCount = Math.max(1, parseInt(count || 1, 10));

    const [session, gift, senderUser, userLevel] = await Promise.all([
        prisma.videoCallSession.findUnique({
            where: { id: sessionId }
        }),
        prisma.gift.findUnique({
            where: { id: giftId }
        }),
        prisma.user.findUnique({
            where: { id: senderId },
            select: { username: true }
        }),
        prisma.walletUserLevel.findUnique({
            where: {
                userId_levelType: {
                    userId: senderId,
                    levelType: LevelType.WEALTH
                }
            }
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

    // 2. Redis-based fast validation and deduction
    const walletKey = `wallet:coins:${senderId}`;
    let senderCoinsStr = await redisClient.get(walletKey);
    let senderCoins;

    let senderWallet = await prisma.wallet.findUnique({
        where: { userId_currencyType: { userId: senderId, currencyType: WalletCurrencyType.COIN } }
    });
    if (!senderWallet) {
        senderWallet = await getOrCreateWallet(senderId, WalletCurrencyType.COIN);
    }

    if (senderCoinsStr === null) {
        senderCoins = await getFastCoinBalance(senderWallet.id);
    } else {
        senderCoins = BigInt(senderCoinsStr);
    }

    if (senderCoins < coinCost) {
        throw new Error("Insufficient coins to send this gift.");
    }

    const balanceAfterCoins = senderCoins - coinCost;
    await redisClient.set(walletKey, balanceAfterCoins.toString(), "EX", 3600);

    const currentLevel = userLevel ? userLevel.currentLevel : 1;
    const cumulativeTotal = userLevel ? userLevel.cumulativeTotal : 0n;
    const newCumulativeTotal = cumulativeTotal + coinCost;

    const nextLevelConfig = await prisma.walletLevelConfig.findUnique({
        where: {
            levelType_level: {
                levelType: LevelType.WEALTH,
                level: currentLevel + 1
            }
        }
    });

    let finalLevel = currentLevel;
    let isLevelUp = false;
    if (nextLevelConfig && newCumulativeTotal >= nextLevelConfig.threshold) {
        finalLevel = nextLevelConfig.level;
        isLevelUp = true;
    }

    const socketPayload = {
        success: true,
        sessionId,
        senderId,
        senderName,
        receiverId,
        receiverName,
        count: giftCount,
        message: `${senderName} sent ${receiverName} ${gift.name} ×${giftCount}`,
        gift: {
            id: gift.id,
            name: gift.name,
            displayImageUrl: gift.displayImageUrl,
            effectUrl: gift.effectUrl
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
        text: `${senderName} sent ${gift.name} ×${giftCount}`,
        wealthLevel: finalLevel,
        isGift: true,
        gift: {
            id: gift.id,
            name: gift.name,
            displayImageUrl: gift.displayImageUrl,
            count: giftCount
        },
        timestamp: new Date().toISOString()
    };
    emitToUser(session.callerId, "RECEIVE_MESSAGE", chatMsgPayload);
    emitToUser(session.creatorId, "RECEIVE_MESSAGE", chatMsgPayload);

    setImmediate(async () => {
        try {
            console.log(`Video Call Gift Background DB Sync session: ${sessionId}`);
            const receiverWallet = await getOrCreateWallet(receiverId, WalletCurrencyType.POINT);

            await prisma.$transaction(async (tx) => {
                // Lock the sender's wallet row to prevent concurrent double-spends
                await tx.$queryRawUnsafe(`SELECT 1 FROM wallets WHERE id = '${senderWallet.id}' FOR UPDATE`);

                const receiverPoints = await getFastPointBalance(receiverWallet.id, tx);
                const balanceAfterPoints = receiverPoints + pointsAwarded;

                // Record transaction details and update levels
                const [hostLedger] = await Promise.all([
                    tx.pointLedgerEntry.create({
                        data: {
                            walletId: receiverWallet.id,
                            direction: LedgerDirection.CREDIT,
                            txType: PointTxType.GIFT_RECEIVE,
                            amount: pointsAwarded,
                            balanceAfter: balanceAfterPoints,
                            idempotencyKey: `gift-${sessionId}-${Date.now()}-points`,
                            refId: gift.id,
                            counterpartyId: senderId,
                            description: `Received gift ${gift.name} x${giftCount} in video call`
                        }
                    }),
                    tx.giftTransaction.create({
                        data: {
                            senderUserId: senderId,
                            receiverUserId: receiverId,
                            giftId: gift.id,
                            coinCost: Number(coinCost),
                            quantity: giftCount,
                            pointsAwarded: Number(pointsAwarded),
                            context: "video_call"
                        }
                    }),
                    tx.coinLedgerEntry.create({
                        data: {
                            walletId: senderWallet.id,
                            direction: LedgerDirection.DEBIT,
                            txType: CoinTxType.GIFT_SEND,
                            amount: coinCost,
                            balanceAfter: balanceAfterCoins,
                            idempotencyKey: `gift-${sessionId}-${Date.now()}-coins`,
                            refId: gift.id,
                            counterpartyId: receiverId,
                            description: `Sent gift ${gift.name} x${giftCount} in video call`
                        }
                    }),
                    tx.walletUserLevel.upsert({
                        where: {
                            userId_levelType: {
                                userId: senderId,
                                levelType: LevelType.WEALTH
                            }
                        },
                        create: {
                            userId: senderId,
                            levelType: LevelType.WEALTH,
                            currentLevel: finalLevel,
                            cumulativeTotal: newCumulativeTotal
                        },
                        update: {
                            currentLevel: finalLevel,
                            cumulativeTotal: newCumulativeTotal
                        }
                    })
                ]);

                // Update Host Livestream Level & Process Agency Commission
                await updateUserLevel(tx, receiverId, LevelType.LIVESTREAM, pointsAwarded);
                const commRes = await processAgencyCommission(tx, receiverId, pointsAwarded, hostLedger.id);
                if (commRes && commRes.agencyUserId) {
                    redisClient.del(`agency:me:${commRes.agencyUserId}`).catch(() => { });
                }
            }, { timeout: 15000 });

            // Clean other cached keys
            redisClient.del(`level:wealth:${senderId}`).catch(err => console.error(err));
            redisClient.del(`wallet:points:${receiverId}`).catch(err => console.error(err));
            redisClient.del(`level:stream:${receiverId}`).catch(err => console.error(err));
            console.log(`[Gift Background DB Sync] Successfully synced to DB for session: ${sessionId}`);
        } catch (dbErr) {
            console.error(`[Gift Background DB Sync] Critical Failure during async sync:`, dbErr);
            // Invalidate Redis balance cache so it's re-fetched from DB next time to maintain correctness
            redisClient.del(walletKey).catch(err => console.error(err));
        }
    });

    return {
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

        const [translation] = await translateClient.translate(text, target);
        return { translatedText: translation };
    } catch (error) {
        console.error("[Google Translate Error]:", error);
        throw new Error(`Translation failed: ${error.message}`);
    }
};