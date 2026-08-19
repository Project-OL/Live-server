import { leaveStreamService, getViewerCountService, sendMessageService, SYSTEM_SENDER_ID, getOrCreateSessionAlias, removeSessionAlias } from './serviceMessage.js';
import prisma from '../../config/prisma.js';
import {
    addUserToSheetService,
    removeUserFromSheetService,
    toggleUserSheetMuteService,
    getSheetUsersService,
    isStreamAdminService,
    getStreamAdminsService,
    getMicPermissionService,
    setMicPermissionService,
    setChatPermissionService,
    sendStreamGiftService,
    handleCameraStateChangeService,
    endLiveStreamService
} from './serviceLive.js';
import { sendLuckyGiftService } from './serviceLuckyGift.js';
import { client as redisClient } from '../../config/redis.js';
import { isUserRestrictedFast } from './serviceAdmin.js';
import { clearHostReturnTimeout } from '../../modules/videoCall/service.js';

let ioInstance = null;
const autoUnmuteTimers = new Map();

const checkUserRestriction = async (userId, type) => {
    try {
        if (typeof isUserRestrictedFast === 'function') {
            return await isUserRestrictedFast(userId, type);
        }
        const { isUserRestrictedFast: fn } = await import('./serviceAdmin.js');
        return await fn(userId, type);
    } catch (e) {
        console.error("[Socket Restriction Check Error]:", e.message);
        return null;
    }
};

const checkIsHostOrAdmin = async (streamId, userId) => {
    if (!userId) return false;
    try {
        const stream = await prisma.liveStream.findFirst({
            where: { streamId, endedAt: null }
        });
        if (!stream) return false;
        if (stream.userId === userId) return true;

        const isAdmin = await isStreamAdminService({ streamId, userId });
        return !!isAdmin;
    } catch (err) {
        console.error("checkIsHostOrAdmin check failed:", err.message);
    }
    return false;
};

export const setupLiveSockets = (io) => {
    ioInstance = io;
    io.on("connection", (socket) => {
        const userId = socket.handshake.auth?.userId || socket.handshake.query?.userId;
        if (userId) {
            socket.join(`user:${userId}`);
            console.log(`[Socket] User ${userId} joined personal channel user:${userId}`);
        }

        socket.on("join_stream", async ({ streamId }) => {
            socket.join(streamId);
            socket.data = socket.data || {};
            socket.data.streamId = streamId;
            socket.data.userId = userId;
            console.log(`[Socket] User ${userId || 'unknown'} joined stream room: ${streamId}`);

            if (userId) {
                try {
                    let username = "Guest";
                    let isStealth = false;
                    const user = await prisma.user.findUnique({
                        where: { id: userId },
                        select: {
                            username: true,
                            privacyMysteryLive: true,
                            vipSubscriptionActive: true
                        }
                    });
                    if (user) {
                        username = user.username;
                        isStealth = Boolean(user.privacyMysteryLive && user.vipSubscriptionActive);
                    }
                    socket.data.isStealth = isStealth;

                    // Always add to history set in Redis for admin records
                    await redisClient.sAdd(`stream:history:${streamId}`, userId);

                    // Add to active set ONLY if NOT stealth
                    if (!isStealth) {
                        await redisClient.sAdd(`stream:active:${streamId}`, userId);

                        // Fetch the host ID of the stream to exclude them if needed
                        let hostId = null;
                        let dbStreamId = null;
                        const streamObj = await prisma.liveStream.findFirst({
                            where: { streamId, endedAt: null },
                            select: { id: true, userId: true }
                        });
                        if (streamObj) {
                            hostId = streamObj.userId;
                            dbStreamId = streamObj.id;
                        }

                        const isHost = Boolean(hostId && userId === hostId);
                        socket.data.isHost = isHost;
                        socket.data.dbStreamId = dbStreamId;

                        if (isHost) {
                            await redisClient.sRem(`stream:active:${streamId}`, userId);
                            if (redisClient.isOpen) {
                                // 1. Clear 30s disconnect grace timer
                                const disconnectTimerKey = `host:disconnect_timer:${streamId}`;
                                const pendingDisconnect = await redisClient.get(disconnectTimerKey);
                                if (pendingDisconnect) {
                                    console.log(`[Socket Host Reconnect] Host ${userId} reconnected to stream ${streamId}. Clearing disconnect timer.`);
                                    await redisClient.del(disconnectTimerKey).catch(() => { });
                                }

                                // 2. Check and clear 2-minute Video Call Return Grace Timer
                                clearHostReturnTimeout(userId);
                                const returnTimerKey1 = `host:return_timer:${streamId}:${userId}`;
                                const returnTimerKey2 = `host:return_timer:${userId}`;
                                const val1 = await redisClient.get(returnTimerKey1);
                                const val2 = await redisClient.get(returnTimerKey2);
                                if (val1 === "pending" || val2 === "pending") {
                                    console.log(`[Socket Host Rejoin] Host ${userId} returned to stream ${streamId} within 2-minute window. Resuming live stream! ✅`);
                                    await Promise.all([
                                        redisClient.del(returnTimerKey1),
                                        redisClient.del(returnTimerKey2)
                                    ]).catch(() => { });

                                    // Broadcast HOST_LIVE_RESUMED to room
                                    broadcastToStream(streamId, "HOST_LIVE_RESUMED", {
                                        streamId,
                                        isPaused: false
                                    });
                                }
                            }
                        }
                    }

                    const viewerCount = await redisClient.sCard(`stream:active:${streamId}`);

                    if (isStealth) {
                        await getOrCreateSessionAlias(streamId, userId);
                        console.log(`[Socket] Stealth VIP User ${userId} joined room ${streamId} silently (No count increment, no join broadcast).`);
                    } else {
                        // Fetch active RIDE/Entry effect
                        let ride = null;
                        try {
                            const activeRide = await prisma.userActiveStoreItems.findUnique({
                                where: {
                                    userId_category: {
                                        userId,
                                        category: "RIDE"
                                    }
                                },
                                include: {
                                    userStoreItem: {
                                        include: {
                                            storeItem: true
                                        }
                                    }
                                }
                            });

                            if (activeRide && activeRide.userStoreItem && activeRide.userStoreItem.isActive) {
                                const expiresAt = new Date(activeRide.userStoreItem.expiresAt);
                                if (expiresAt > new Date()) {
                                    ride = {
                                        name: activeRide.userStoreItem.storeItem.name,
                                        effectUrl: activeRide.userStoreItem.storeItem.effectUrl,
                                        displayImageUrl: activeRide.userStoreItem.storeItem.displayImageUrl
                                    };
                                }
                            }
                        } catch (err) {
                            console.error("[EntryRide] Failed to fetch active entry ride:", err);
                        }
                        // Broadcast user_joined to notify all clients to sync
                        broadcastToStream(streamId, "user_joined", {
                            userId,
                            username,
                            viewerCount,
                            ride
                        });

                        setImmediate(async () => {
                            try {
                                const systemMessage = await sendMessageService({
                                    streamId,
                                    senderId: SYSTEM_SENDER_ID,
                                    message: `${username} joined the room.`,
                                    replyToUserId: userId,
                                    replyToUsername: username
                                });
                                broadcastToStream(streamId, "new_message", systemMessage);
                            } catch (err) {
                                console.error("[Socket] Async join message error:", err.message);
                            }
                        });
                    }
                } catch (err) {
                    console.error("[Socket] join_stream handler error:", err.message);
                }
            }
        });

        socket.on("leave_stream", async ({ streamId }) => {
            socket.leave(streamId);
            if (socket.data) {
                delete socket.data.streamId;
            }
            console.log(`[Socket] User ${userId || 'unknown'} left stream room: ${streamId}`);
            if (userId) {
                try {
                    await removeUserFromSheetService({ streamId, userId });
                    broadcastToStream(streamId, "user_left_sheet", { userId });
                } catch (err) {
                    console.error("[Socket] Remove from sheet on leave_stream failed:", err.message);
                }
                if (socket.data && socket.data.isStealth) {
                    await removeSessionAlias(streamId, userId);
                }
            }
        });

        socket.on("disconnect", async () => {
            console.log(`[Socket] User ${userId || 'unknown'} disconnected`);
            if (socket.data && socket.data.streamId && socket.data.userId) {
                const { streamId, userId, isStealth, isHost, dbStreamId } = socket.data;

                // If disconnected user is Host, start 30-second network loss disconnect timer (Total ~60s with socket heartbeat)
                if (isHost) {
                    console.warn(`[Socket Host Disconnect] Host ${userId} disconnected from stream ${streamId}. Starting 30s network loss timer.`);
                    const timerKey = `host:disconnect_timer:${streamId}`;
                    if (redisClient.isOpen) {
                        await redisClient.set(timerKey, "pending", "EX", 30).catch(() => { });
                    }

                    // 30-second background worker check
                    setTimeout(async () => {
                        try {
                            let isStillPending = true;
                            if (redisClient.isOpen) {
                                const val = await redisClient.get(timerKey);
                                isStillPending = (val === "pending");
                            }

                            if (isStillPending) {
                                console.log(`[Socket Host Disconnect Timeout] Host ${userId} did NOT reconnect to stream ${streamId} within 30s grace period. Auto-ending live stream...`);
                                if (redisClient.isOpen) {
                                    await redisClient.del(timerKey).catch(() => { });
                                }

                                // Verify stream is still live before auto-ending
                                const activeStream = await prisma.liveStream.findFirst({
                                    where: {
                                        OR: [{ streamId }, { id: dbStreamId || streamId }],
                                        isLive: true
                                    }
                                });

                                if (activeStream) {
                                    // Check 1: Is host in an active Video Call?
                                    const activeCall = await prisma.videoCallSession.findFirst({
                                        where: {
                                            OR: [{ creatorId: userId }, { callerId: userId }],
                                            status: "ACTIVE"
                                        }
                                    });

                                    // Check 2: Is host in 2-minute Video Call Return Grace Period?
                                    let isReturnGraceActive = false;
                                    if (redisClient.isOpen) {
                                        const val1 = await redisClient.get(`host:return_timer:${streamId}:${userId}`);
                                        const val2 = await redisClient.get(`host:return_timer:${userId}`);
                                        isReturnGraceActive = (val1 === "pending" || val2 === "pending");
                                    }

                                    if (activeCall || isReturnGraceActive) {
                                        console.log(`[Socket Host Disconnect Timeout] Host ${userId} is currently on active Video Call or in 2-min Return window. Skipping 30s auto-end for stream ${streamId}.`);
                                        return;
                                    }

                                    broadcastToStream(streamId, "stream_ended", {
                                        streamId,
                                        reason: "HOST_DISCONNECTED_TIMEOUT",
                                        message: "Live stream ended due to host network disconnection."
                                    });
                                    await endLiveStreamService({ id: activeStream.id, userId });
                                    console.log(`[Socket Host Disconnect Timeout] Successfully auto-ended live stream ${streamId} after network loss timeout! ✅`);
                                }
                            } else {
                                console.log(`[Socket Host Disconnect Cancelled] Host reconnected within grace period for stream ${streamId}.`);
                            }
                        } catch (timeoutErr) {
                            console.error("[Socket Host Disconnect Timeout Error]:", timeoutErr.message);
                        }
                    }, 30000);
                }

                try {
                    await removeUserFromSheetService({ streamId, userId });
                    broadcastToStream(streamId, "user_left_sheet", { userId });
                } catch (sheetErr) {
                    // Ignore if not on sheet
                }
                try {
                    await leaveStreamService({ streamId, userId });
                    await removeSessionAlias(streamId, userId);
                    console.log(`[Socket] Cleaned up disconnected user ${userId} from stream ${streamId}`);
                } catch (err) {
                    console.error("[Socket] Disconnect database cleanup error:", err.message);
                }
            }
        });

        // --- AUDIO SHEET EVENTS ---

        // Host/Admin invites a viewer to the sheet
        socket.on("invite_to_sheet", async ({ streamId, targetUserId }) => {
            try {
                const isAuthorized = await checkIsHostOrAdmin(streamId, userId);
                if (!isAuthorized) {
                    console.warn(`[Socket] Unauthorized invite_to_sheet by user ${userId} in stream ${streamId}`);
                    return;
                }

                const isTargetAudioRestricted = await checkUserRestriction(targetUserId, 'LIVE_AUDIO_MUTE');
                if (isTargetAudioRestricted) {
                    console.log(`[Socket] Blocked Host ${userId} from inviting user ${targetUserId} due to active LIVE_AUDIO_MUTE restriction`);
                    socket.emit("error", { message: "This user is restricted by Admin from joining live audio seats." });
                    return;
                }

                const hostUser = await prisma.user.findUnique({
                    where: { id: userId },
                    select: { username: true }
                });
                const hostUsername = hostUser ? hostUser.username : "Host/Admin";
                ioInstance.to(`user:${targetUserId}`).emit("sheet_invite_received", {
                    streamId,
                    hostUsername
                });
                console.log(`[Socket] Host/Admin ${userId} invited user ${targetUserId} to sheet in stream ${streamId}`);
            } catch (err) {
                console.error("[Socket] invite_to_sheet failed:", err.message);
            }
        });

        // Viewer declines host's invite
        socket.on("decline_sheet_invite", async ({ streamId }) => {
            try {
                const user = await prisma.user.findUnique({
                    where: { id: userId },
                    select: { username: true, privacyMysteryLive: true, vipSubscriptionActive: true }
                });
                const isStealth = Boolean(user?.privacyMysteryLive && user?.vipSubscriptionActive);
                const displayUsername = isStealth ? (await getOrCreateSessionAlias(streamId, userId) || "Mystery User") : (user ? user.username : "Guest");
                const stream = await prisma.liveStream.findFirst({
                    where: { streamId, endedAt: null }
                });
                if (stream) {
                    ioInstance.to(`user:${stream.userId}`).emit("sheet_invite_declined", {
                        username: displayUsername
                    });
                    const adminIds = await getStreamAdminsService({ streamId });
                    for (const adminId of adminIds) {
                        ioInstance.to(`user:${adminId}`).emit("sheet_invite_declined", {
                            username: displayUsername
                        });
                    }
                }
            } catch (err) {
                console.error("[Socket] decline_sheet_invite failed:", err.message);
            }
        });

        // Viewer accepts host's invite
        socket.on("accept_sheet_invite", async ({ streamId }) => {
            try {
                const isAudioRestricted = await checkUserRestriction(userId, 'LIVE_AUDIO_MUTE');
                if (isAudioRestricted) {
                    console.log(`[Socket] Blocked user ${userId} from accepting sheet invite due to active LIVE_AUDIO_MUTE restriction`);
                    socket.emit("error", { message: "You are restricted by Admin from joining live audio seats." });
                    return;
                }

                const user = await prisma.user.findUnique({
                    where: { id: userId },
                    select: { username: true, privacyMysteryLive: true, vipSubscriptionActive: true }
                });
                const isStealth = Boolean(user?.privacyMysteryLive && user?.vipSubscriptionActive);
                const displayUsername = isStealth ? (await getOrCreateSessionAlias(streamId, userId) || "Mystery User") : (user ? user.username : "Guest");
                await addUserToSheetService({ streamId, userId, username: displayUsername });
                broadcastToStream(streamId, "user_joined_sheet", {
                    userId: isStealth ? null : userId,
                    username: displayUsername,
                    isMuted: false,
                    isMystery: isStealth
                });
                console.log(`[Socket] User ${userId} accepted sheet invite and joined sheet in stream ${streamId}`);
            } catch (err) {
                console.error("[Socket] accept_sheet_invite failed:", err.message);
            }
        });

        // Host/Admin toggles mic permission mode (permission required vs direct join)
        socket.on("toggle_mic_permission", async ({ streamId, micPermissionRequired }) => {
            try {
                const isAuthorized = await checkIsHostOrAdmin(streamId, userId);
                if (!isAuthorized) {
                    console.warn(`[Socket] Unauthorized toggle_mic_permission by user ${userId} in stream ${streamId}`);
                    return;
                }
                const isRequired = await setMicPermissionService({ streamId, micPermissionRequired });
                console.log(`[Socket] Host/Admin ${userId} set micPermissionRequired to ${isRequired} in stream ${streamId}`);
            } catch (err) {
                console.error("[Socket] toggle_mic_permission failed:", err.message);
            }
        });

        // Host/Admin toggles chat permission mode (EVERYONE, ALL_MUTED, FOLLOWERS_ONLY, ADMINS_ONLY)
        socket.on("set_chat_permission", async ({ streamId, mode }) => {
            try {
                const isAuthorized = await checkIsHostOrAdmin(streamId, userId);
                if (!isAuthorized) {
                    console.warn(`[Socket] Unauthorized set_chat_permission by user ${userId} in stream ${streamId}`);
                    return;
                }
                const updatedMode = await setChatPermissionService({ streamId, mode });
                broadcastToStream(streamId, "chat_permission_changed", {
                    streamId,
                    chatPermissionMode: updatedMode
                });
                console.log(`[Socket] Host/Admin ${userId} set chatPermissionMode to ${updatedMode} in stream ${streamId}`);
            } catch (err) {
                console.error("[Socket] set_chat_permission failed:", err.message);
            }
        });

        // Viewer requests to join the sheet (or directly joins if mic permission is not required)
        socket.on("request_to_join_sheet", async ({ streamId }) => {
            try {
                const isAudioRestricted = await checkUserRestriction(userId, 'LIVE_AUDIO_MUTE');
                if (isAudioRestricted) {
                    console.log(`[Socket] Blocked user ${userId} from requesting sheet join due to active LIVE_AUDIO_MUTE restriction`);
                    socket.emit("error", { message: "You are restricted by Admin from joining live audio seats." });
                    return;
                }

                const user = await prisma.user.findUnique({
                    where: { id: userId },
                    select: { username: true, privacyMysteryLive: true, vipSubscriptionActive: true }
                });
                const isStealth = Boolean(user?.privacyMysteryLive && user?.vipSubscriptionActive);
                const realUsername = user ? user.username : "Guest";
                const displayUsername = isStealth ? (await getOrCreateSessionAlias(streamId, userId) || "Mystery User") : realUsername;
                const stream = await prisma.liveStream.findFirst({
                    where: { streamId, endedAt: null }
                });
                if (stream) {
                    const micPermissionRequired = await getMicPermissionService({ streamId });

                    if (!micPermissionRequired) {
                        // Direct Join Mode: Add user to audio sheet immediately without requiring host approval
                        await addUserToSheetService({ streamId, userId, username: displayUsername });
                        ioInstance.to(`user:${userId}`).emit("sheet_request_accepted", { streamId });
                        broadcastToStream(streamId, "user_joined_sheet", {
                            userId: isStealth ? null : userId,
                            username: displayUsername,
                            isMuted: false,
                            isMystery: isStealth
                        });
                        console.log(`[Socket] Direct Mic Join: User ${userId} (${displayUsername}) joined sheet automatically in stream ${streamId}`);
                    } else {
                        // Permission Required Mode: Send REAL name & ID to Host and Admins for approval
                        ioInstance.to(`user:${stream.userId}`).emit("sheet_request_received", {
                            userId,
                            username: realUsername,
                            isMystery: false
                        });
                        const adminIds = await getStreamAdminsService({ streamId });
                        for (const adminId of adminIds) {
                            ioInstance.to(`user:${adminId}`).emit("sheet_request_received", {
                                userId,
                                username: realUsername,
                                isMystery: false
                            });
                        }
                        console.log(`[Socket] User ${userId} (${realUsername}) requested to join sheet. Host and admins notified with real name.`);
                    }
                }
            } catch (err) {
                console.error("[Socket] request_to_join_sheet failed:", err.message);
            }
        });

        // Host/Admin accepts viewer's request to join sheet
        socket.on("accept_sheet_request", async ({ streamId, targetUserId }) => {
            try {
                const isAuthorized = await checkIsHostOrAdmin(streamId, userId);
                if (!isAuthorized) {
                    console.warn(`[Socket] Unauthorized accept_sheet_request by user ${userId} in stream ${streamId}`);
                    return;
                }

                const isTargetAudioRestricted = await checkUserRestriction(targetUserId, 'LIVE_AUDIO_MUTE');
                if (isTargetAudioRestricted) {
                    console.log(`[Socket] Blocked Host from accepting sheet request for user ${targetUserId} due to active LIVE_AUDIO_MUTE restriction`);
                    socket.emit("error", { message: "This user is restricted by Admin from joining live audio seats." });
                    return;
                }

                const user = await prisma.user.findUnique({
                    where: { id: targetUserId },
                    select: { username: true, privacyMysteryLive: true, vipSubscriptionActive: true }
                });
                const isStealth = Boolean(user?.privacyMysteryLive && user?.vipSubscriptionActive);
                const displayUsername = isStealth ? (await getOrCreateSessionAlias(streamId, targetUserId) || "Mystery User") : (user ? user.username : "Guest");
                await addUserToSheetService({ streamId, userId: targetUserId, username: displayUsername });
                ioInstance.to(`user:${targetUserId}`).emit("sheet_request_accepted", { streamId });
                broadcastToStream(streamId, "user_joined_sheet", {
                    userId: isStealth ? null : targetUserId,
                    username: displayUsername,
                    isMuted: false,
                    isMystery: isStealth
                });
                console.log(`[Socket] Host/Admin accepted sheet request for ${targetUserId} in stream ${streamId}`);
            } catch (err) {
                console.error("[Socket] accept_sheet_request failed:", err.message);
            }
        });

        // Host/Admin rejects viewer's request to join sheet
        socket.on("reject_sheet_request", async ({ streamId, targetUserId }) => {
            try {
                const isAuthorized = await checkIsHostOrAdmin(streamId, userId);
                if (!isAuthorized) {
                    console.warn(`[Socket] Unauthorized reject_sheet_request by user ${userId} in stream ${streamId}`);
                    return;
                }
                ioInstance.to(`user:${targetUserId}`).emit("sheet_request_rejected", { streamId });
                console.log(`[Socket] Host/Admin rejected sheet request for ${targetUserId} in stream ${streamId}`);
            } catch (err) {
                console.error("[Socket] reject_sheet_request failed:", err.message);
            }
        });

        // Host/Admin toggles a user's mute state
        socket.on("toggle_sheet_mute", async ({ streamId, targetUserId, muteState }) => {
            try {
                const isAuthorized = await checkIsHostOrAdmin(streamId, userId);
                if (!isAuthorized) {
                    console.warn(`[Socket] Unauthorized toggle_sheet_mute by user ${userId} in stream ${streamId}`);
                    return;
                }

                // If Host/Admin attempts to UNMUTE (muteState === false), check if target user is restricted by Admin
                if (!muteState) {
                    const isTargetAudioRestricted = await checkUserRestriction(targetUserId, 'LIVE_AUDIO_MUTE');
                    if (isTargetAudioRestricted) {
                        console.log(`[Socket] Blocked Host/Admin ${userId} from unmuting user ${targetUserId} due to active Admin LIVE_AUDIO_MUTE restriction`);
                        socket.emit("error", { message: "User is restricted by Admin from speaking in live audio seats." });
                        return;
                    }
                }

                const updatedUser = await toggleUserSheetMuteService({ streamId, userId: targetUserId, muteState, mutedByHost: muteState });
                if (updatedUser) {
                    broadcastToStream(streamId, "sheet_mute_changed", {
                        userId: targetUserId,
                        isMuted: muteState
                    });
                    console.log(`[Socket] Host/Admin set muteState to ${muteState} (mutedByHost: ${muteState}) for user ${targetUserId} in stream ${streamId}`);

                    // System Chat Message Broadcast
                    setImmediate(async () => {
                        try {
                            const [operatorUser, targetUser] = await Promise.all([
                                prisma.user.findUnique({ where: { id: userId }, select: { username: true } }),
                                prisma.user.findUnique({ where: { id: targetUserId }, select: { username: true } })
                            ]);
                            const operatorName = operatorUser?.username || "Host/Admin";
                            const targetName = targetUser?.username || "User";

                            const muteMsgText = muteState
                                ? `${targetName} has been muted by ${operatorName}.`
                                : `${targetName} has been unmuted by ${operatorName}.`;

                            const systemMessage = await sendMessageService({
                                streamId,
                                senderId: SYSTEM_SENDER_ID,
                                message: muteMsgText,
                                replyToUserId: targetUserId,
                                replyToUsername: targetName
                            });

                            broadcastToStream(streamId, "new_message", systemMessage);
                        } catch (msgErr) {
                            console.error("[Socket Mute Message Error]:", msgErr.message);
                        }
                    });

                    const timerKey = `${streamId}:${targetUserId}`;
                    if (muteState) {
                        // Clear existing timer if any
                        if (autoUnmuteTimers.has(timerKey)) {
                            clearTimeout(autoUnmuteTimers.get(timerKey));
                        }
                        // Schedule 30-minute (1,800,000 ms) auto-unmute
                        const timer = setTimeout(async () => {
                            autoUnmuteTimers.delete(timerKey);
                            try {
                                const rawUser = await redisClient.hGet(`stream:sheet:${streamId}`, targetUserId);
                                if (rawUser) {
                                    const userObj = JSON.parse(rawUser);
                                    if (userObj.mutedByHost) {
                                        await toggleUserSheetMuteService({ streamId, userId: targetUserId, muteState: false, mutedByHost: false });
                                        broadcastToStream(streamId, "sheet_mute_changed", {
                                            userId: targetUserId,
                                            isMuted: false
                                        });
                                        console.log(`[Socket] 30-minute auto-unmute triggered for user ${targetUserId} in stream ${streamId}`);
                                    }
                                }
                            } catch (autoErr) {
                                console.error(`[Socket] Auto-unmute timer error for user ${targetUserId}:`, autoErr.message);
                            }
                        }, 30 * 60 * 1000);

                        autoUnmuteTimers.set(timerKey, timer);
                    } else {
                        // Host manually unmuted - clear timer
                        if (autoUnmuteTimers.has(timerKey)) {
                            clearTimeout(autoUnmuteTimers.get(timerKey));
                            autoUnmuteTimers.delete(timerKey);
                        }
                    }
                }
            } catch (err) {
                console.error("[Socket] toggle_sheet_mute failed:", err.message);
            }
        });

        // Speaker toggles their own mute state
        socket.on("toggle_self_mute", async ({ streamId, muteState }) => {
            try {
                // If user has LIVE_AUDIO_MUTE restriction, prevent unmuting
                const isAudioRestricted = await checkUserRestriction(userId, 'LIVE_AUDIO_MUTE');
                if (isAudioRestricted && !muteState) {
                    console.log(`[Socket] Rejected self-unmute request for user ${userId} due to active LIVE_AUDIO_MUTE restriction`);
                    socket.emit("error", { message: "You are restricted from speaking in live audio seats." });
                    return;
                }

                // Get the current sheet status from Redis first
                const rawUser = await redisClient.hGet(`stream:sheet:${streamId}`, userId);
                if (rawUser) {
                    const userObj = JSON.parse(rawUser);
                    if (userObj.mutedByHost && !muteState) {
                        // Check if 30 minutes have passed
                        if (userObj.mutedUntil && Date.now() >= userObj.mutedUntil) {
                            userObj.mutedByHost = false;
                            userObj.mutedUntil = null;
                        } else {
                            const minutesLeft = userObj.mutedUntil ? Math.ceil((userObj.mutedUntil - Date.now()) / 60000) : 30;
                            console.log(`[Socket] Rejected self-unmute request for user ${userId} since they are muted by host (${minutesLeft} mins left)`);
                            return;
                        }
                    }
                }

                const updatedUser = await toggleUserSheetMuteService({ streamId, userId, muteState, mutedByHost: false });
                if (updatedUser) {
                    broadcastToStream(streamId, "sheet_mute_changed", {
                        userId,
                        isMuted: muteState
                    });
                    console.log(`[Socket] User ${userId} self-set muteState to ${muteState} in stream ${streamId}`);
                }
            } catch (err) {
                console.error("[Socket] toggle_self_mute failed:", err.message);
            }
        });

        // Host/Admin removes user from sheet
        socket.on("remove_from_sheet", async ({ streamId, targetUserId }) => {
            try {
                const isAuthorized = await checkIsHostOrAdmin(streamId, userId);
                if (!isAuthorized) {
                    console.warn(`[Socket] Unauthorized remove_from_sheet by user ${userId} in stream ${streamId}`);
                    return;
                }
                await removeUserFromSheetService({ streamId, userId: targetUserId });
                broadcastToStream(streamId, "user_left_sheet", { userId: targetUserId });
                console.log(`[Socket] Host/Admin removed user ${targetUserId} from sheet in stream ${streamId}`);
            } catch (err) {
                console.error("[Socket] remove_from_sheet failed:", err.message);
            }
        });

        // Host toggles their camera ON/OFF state
        socket.on("toggle_camera_state", async ({ streamId, isCameraOn }) => {
            try {
                await handleCameraStateChangeService({ streamId, isCameraOn });
                broadcastToStream(streamId, "camera_state_changed", {
                    userId,
                    isCameraOn: Boolean(isCameraOn)
                });
                console.log(`[Socket] Host ${userId} toggled camera state to ${isCameraOn} in stream ${streamId}`);
            } catch (err) {
                console.error("[Socket] toggle_camera_state failed:", err.message);
            }
        });

        // Speaker voluntarily leaves sheet
        socket.on("leave_sheet", async ({ streamId }) => {
            try {
                await removeUserFromSheetService({ streamId, userId });
                broadcastToStream(streamId, "user_left_sheet", { userId });
                console.log(`[Socket] User ${userId} voluntarily left sheet in stream ${streamId}`);
            } catch (err) {
                console.error("[Socket] leave_sheet failed:", err.message);
            }
        });

        // Host/Admin clears chat
        socket.on("clear_chat", async ({ streamId }) => {
            try {
                const isAuthorized = await checkIsHostOrAdmin(streamId, userId);
                if (!isAuthorized) {
                    console.warn(`[Socket] Unauthorized clear_chat by user ${userId} in stream ${streamId}`);
                    return;
                }
                const clearedAt = new Date().toISOString();
                await redisClient.set(`stream:chat_cleared:${streamId}`, clearedAt);
                broadcastToStream(streamId, "chat_cleared", { clearedAt });
                console.log(`[Socket] Host/Admin ${userId} cleared chat for stream ${streamId} at ${clearedAt}`);

                setImmediate(async () => {
                    try {
                        const streamObj = await getLiveStreamService({ id: streamId });
                        const isHost = Boolean(streamObj && streamObj.userId === userId);
                        const clearMsgText = isHost
                            ? "The host cleared all room messages."
                            : "The admin cleared all room messages.";

                        const systemMessage = await sendMessageService({
                            streamId,
                            senderId: SYSTEM_SENDER_ID,
                            message: clearMsgText
                        });

                        broadcastToStream(streamId, "new_message", systemMessage);
                    } catch (msgErr) {
                        console.error("[Clear Chat System Message Error]:", msgErr.message);
                    }
                });
            } catch (err) {
                console.error("[Socket] clear_chat failed:", err.message);
            }
        });

        // Unified Send Gift Socket Handler (Handles both Normal & Lucky gifts)
        socket.on("send_gift", async ({ streamId, receiverId, targetUserId, giftId, count = 1, comboCount = 1 }) => {
            try {
                if (!userId) {
                    return socket.emit("error", { message: "Unauthorized socket user" });
                }

                const giftCount = count || comboCount || 1;
                const result = await sendStreamGiftService({
                    streamDbId: streamId,
                    senderId: userId,
                    giftId,
                    targetUserId: targetUserId || receiverId,
                    count: giftCount
                });

                // Standard Gift Animation broadcast
                broadcastToStream(streamId, "gift_sent", result.socketPayload);
                broadcastToStream(streamId, "GIFT_SENT", result.socketPayload);

                // If Lucky Gift Winner -> Broadcast Lucky Win event
                if (result.luckyWin) {
                    broadcastToStream(streamId, "lucky_gift_win", result.luckyWin);
                    broadcastToStream(streamId, "LUCKY_GIFT_WIN", result.luckyWin);
                    console.log(`[Socket Lucky Gift Win] Broadcast lucky_gift_win in stream ${streamId} for winner ${result.luckyWin.senderId}: ${result.luckyWin.rewardCoins} coins`);
                }
            } catch (err) {
                console.error("[Socket] send_gift failed:", err.message);
                socket.emit("error", { message: err.message });
            }
        });

        // Send Lucky Gift Socket Handler
        socket.on("send_lucky_gift", async ({ streamId, receiverId, giftId, comboCount = 1, clientTxId = null }) => {
            try {
                if (!userId) {
                    return socket.emit("error", { message: "Unauthorized socket user" });
                }

                const result = await sendLuckyGiftService({
                    senderId: userId,
                    receiverId,
                    streamId,
                    giftId,
                    comboCount,
                    clientTxId
                });

                const user = await prisma.user.findUnique({
                    where: { id: userId },
                    select: { username: true, privacyMysteryLive: true, vipSubscriptionActive: true }
                });
                const isStealth = Boolean(user?.privacyMysteryLive && user?.vipSubscriptionActive);
                const displaySenderName = isStealth ? (await getOrCreateSessionAlias(streamId, userId) || "Mystery Gifter") : (user ? user.username : "User");

                if (result.breakdownArray.length <= 1) {
                    // Single Lucky Draw Result
                    broadcastToStream(streamId, "lucky_gift_single_result", {
                        senderId: isStealth ? null : userId,
                        senderName: displaySenderName,
                        receiverId,
                        gift: result.gift,
                        totalCost: result.totalCost,
                        totalRewardCoins: result.totalRewardCoins,
                        category: result.category,
                        isMystery: isStealth
                    });
                } else {
                    // Multi-Step Combo Result (Broadcast Sequential Popups)
                    let cumulativeCoins = 0;
                    for (let i = 0; i < result.breakdownArray.length; i++) {
                        const stepCoins = result.breakdownArray[i];
                        cumulativeCoins += stepCoins;
                        broadcastToStream(streamId, "lucky_gift_combo_step", {
                            senderId: isStealth ? null : userId,
                            senderName: displaySenderName,
                            receiverId,
                            gift: result.gift,
                            stepIndex: i + 1,
                            totalSteps: result.breakdownArray.length,
                            stepRewardCoins: stepCoins,
                            accumulatedRewardCoins: cumulativeCoins,
                            totalRewardCoins: result.totalRewardCoins,
                            isMystery: isStealth
                        });
                    }
                }

                // Global Announcement Trigger if Lucky Gift Total Cost >= 300,000 Coins
                const luckyTotalCost = Number(result.totalCost || 0);
                if (luckyTotalCost >= 300000) {
                    setImmediate(async () => {
                        try {
                            const streamObj = await prisma.liveStream.findFirst({
                                where: { streamId, endedAt: null },
                                select: { userId: true }
                            });
                            let hostName = "Host";
                            if (streamObj) {
                                const hostUser = await prisma.user.findUnique({
                                    where: { id: streamObj.userId },
                                    select: { username: true }
                                });
                                hostName = hostUser?.username || "Host";
                            }

                            const announcementData = {
                                type: "HIGH_VALUE_GIFT",
                                data: {
                                    senderName: displaySenderName,
                                    senderAvatarUrl: user?.avatarUrl || null,
                                    giftName: result.gift?.name || "Lucky Gift",
                                    giftDisplayImageUrl: result.gift?.displayImageUrl || null,
                                    coinCost: luckyTotalCost,
                                    hostName: hostName,
                                    streamId: streamId
                                }
                            };

                            console.log(`[Socket Global Announcement] 🚀 Triggering High Value Gift Announcement! Total Cost: ${luckyTotalCost} Coins`);
                            await broadcastGlobalMessage("GLOBAL_ANNOUNCEMENT", announcementData);
                            await broadcastGlobalMessage("GLOBAL_GIFT_ANNOUNCEMENT", announcementData);
                            await broadcastGlobalMessage("global_announcement", announcementData);
                        } catch (annErr) {
                            console.error("[Socket Global Announcement Error]:", annErr.message);
                        }
                    });
                }

                console.log(`[Socket] Lucky Gift sent successfully by ${userId} (${displaySenderName}) in stream ${streamId}`);
            } catch (err) {
                console.error("[Socket] send_lucky_gift failed:", err.message);
                socket.emit("error", { message: err.message });
            }
        });
    });
};

export const broadcastToStream = (streamId, eventName, data) => {
    if (!ioInstance) {
        console.warn("[Socket] Socket.IO instance not initialized for live streaming!");
        return;
    }
    ioInstance.to(streamId).emit(eventName, data);
    if (!streamId.startsWith("stream:")) {
        ioInstance.to(`stream:${streamId}`).emit(eventName, data);
    }
};

export const broadcastGlobalMessage = async (eventName, data) => {
    if (!ioInstance) {
        console.warn("[Socket] Socket.IO instance not initialized for live streaming!");
        return;
    }
    try {
        ioInstance.emit(eventName, data);
    } catch (err) {
        console.error("Failed to broadcast global message:", err.message);
    }
};

export const forceLeaveRoom = async (userId, roomName) => {
    if (!ioInstance) return;
    const userSockets = await ioInstance.in(`user:${userId}`).fetchSockets();
    for (const s of userSockets) {
        s.leave(roomName);
        if (s.data) {
            delete s.data.streamId;
        }
    }
};
