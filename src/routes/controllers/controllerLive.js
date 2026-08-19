import express from 'express';
import auth from '../../middlewares/authMiddleware.js';
import prisma from '../../config/prisma.js';
import { createLiveSchema, sendMessageSchema } from '../../validations/validationLive.js';
import {
    fastGoLiveStreamService,
    endLiveStreamService,
    getLiveStreamsService,
    getLiveStreamService,
    getHostProfileService,
    getUserPrivacyService,
    generateStreamViewerToken,
    isStreamAdminService,
    promoteDemoteAdminService,
    kickUserService,
    isUserKickedService,
    setStreamPasswordService,
    getStreamPasswordService,
    getMicPermissionService,
    setChatPermissionService,
    getChatPermissionService,
    getSheetUsersService,
    sendStreamGiftService,
    followUserService,
    unfollowUserService,
    checkFollowStatusService,
    sendGlobalMessageService,
    verifyStreamFrameService,
    getGiftGalleryTargetsService,
    reportFakeLiveService,
    getUserEffectSettingsService,
    updateUserEffectSettingsService,
    getFansRankingService,
    sortRoomViewersService,
    startLocalHlsEgressService,
    getHostStatsService
} from '../service/serviceLive.js';
import { sendLuckyGiftService } from '../service/serviceLuckyGift.js';
import { isUserRestrictedFast } from '../service/serviceAdmin.js';
import {
    sendMessageService,
    getMessagesService,
    joinStreamService,
    leaveStreamService,
    getViewerCountService,
    SYSTEM_SENDER_ID,
    getOrCreateSessionAlias,
    removeSessionAlias
} from '../service/serviceMessage.js';
import { broadcastToStream, forceLeaveRoom, broadcastGlobalMessage } from '../service/socket-live-service.js';
import { getIO } from '../../socket/index.js';
import { client as redisClient } from '../../config/redis.js';
import { WalletCurrencyType } from '@prisma/client';
import { getOrCreateWallet, getFastCoinBalance } from '../../modules/videoCall/service.js';

const router = express.Router();

const syncAndGetActiveViewerIds = async (streamId) => {
    let activeUserIds = [];
    try {
        if (redisClient.isOpen) {
            activeUserIds = await redisClient.sMembers(`stream:active:${streamId}`);
        }
    } catch (err) {
        console.error("Failed to fetch active viewers from Redis:", err.message);
    }

    const io = getIO();
    if (io) {
        try {
            const clients = io.sockets.adapter.rooms.get(streamId);
            if (clients && clients.size > 0) {
                const streamObj = await getLiveStreamService({ id: streamId });
                const hostId = streamObj ? streamObj.userId : null;

                const socketUserIds = [];
                for (const clientId of clients) {
                    const clientSocket = io.sockets.sockets.get(clientId);
                    if (clientSocket && clientSocket.data && clientSocket.data.userId) {
                        const clientUserId = clientSocket.data.userId;
                        if (hostId && clientUserId === hostId) continue;
                        socketUserIds.push(clientUserId);
                    }
                }

                const missingIds = socketUserIds.filter(id => !activeUserIds.includes(id));
                if (missingIds.length > 0 && redisClient.isOpen) {
                    await redisClient.sAdd(`stream:active:${streamId}`, missingIds);
                    activeUserIds = [...activeUserIds, ...missingIds];
                }
            }
        } catch (socketErr) {
            console.error("Socket room fallback sync failed:", socketErr.message);
        }
    }

    return activeUserIds;
};

const fastGoLiveStream = async (req, res) => {
    try {
        const banRestriction = await isUserRestrictedFast(req.userId, 'LIVE_STREAM_START_BAN');
        if (banRestriction) {
            const untilIso = new Date(banRestriction.restrictedUntil).toISOString();
            const formattedTime = new Date(banRestriction.restrictedUntil).toLocaleString('en-IN', {
                timeZone: 'Asia/Kolkata',
                day: '2-digit',
                month: 'short',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: true
            });
            return res.status(403).json({
                success: false,
                code: 'LIVE_STREAM_START_BANNED',
                message: `You are banned from starting a live stream until ${formattedTime}`,
                restrictedUntil: untilIso
            });
        }

        const value = await createLiveSchema.validateAsync(req.body);

        const result = await fastGoLiveStreamService({
            userId: req.userId,
            title: value.title,
            heading: value.heading,
            isCameraOn: req.body.isCameraOn
        });

        return res.status(201).json({
            success: true,
            data: result.stream,
            token: result.token
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
};



const endLiveStream = async (req, res) => {
    try {
        const result = await endLiveStreamService({
            id: req.params.id,
            userId: req.userId
        });

        // Broadcast rich summary payload to all viewers in stream room
        broadcastToStream(result.stream.streamId, "stream_ended", result.summary);

        return res.json({
            success: true,
            data: result.stream,
            summary: result.summary
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
};

const joinLiveStream = async (req, res) => {
    try {
        const targetId = req.params.id;

        // Batch Step 1: Parallel lookup for stream info, user privacy, kick status, and stream password
        const [stream, kickTtl, streamPassword, userPrivacy] = await Promise.all([
            getLiveStreamService({ id: targetId }),
            isUserKickedService({ streamId: targetId, userId: req.userId }),
            getStreamPasswordService({ streamId: targetId }),
            getUserPrivacyService({ userId: req.userId })
        ]);

        if (!stream) {
            return res.status(404).json({ success: false, message: "Stream not found" });
        }
        if (!stream.isLive) {
            return res.status(400).json({ success: false, message: "Stream is not live" });
        }

        if (kickTtl !== null) {
            const minutesLeft = Math.ceil(kickTtl / 60);
            return res.status(403).json({
                success: false,
                message: `You have been kicked from this stream and cannot join. Try again in ${minutesLeft} minute(s).`
            });
        }

        if (req.userId !== stream.userId && streamPassword) {
            const { password } = req.body || {};
            if (!password || password !== streamPassword) {
                return res.status(401).json({ success: false, message: "Incorrect stream password" });
            }
        }

        const { username, isStealth } = userPrivacy;

        // Batch Step 2: Parallel execution for Token, Redis Join, Active Viewers, Host Profile & Permissions
        const [token, _, viewerIds, host, micPermissionRequired, chatPermissionMode] = await Promise.all([
            generateStreamViewerToken(stream.streamId, req.userId),
            joinStreamService({ streamId: stream.streamId, userId: req.userId }),
            syncAndGetActiveViewerIds(stream.streamId),
            getHostProfileService({ hostUserId: stream.userId }),
            getMicPermissionService({ streamId: stream.streamId }),
            getChatPermissionService({ streamId: stream.streamId })
        ]);

        if (!isStealth && req.userId !== stream.userId && !viewerIds.includes(req.userId)) {
            viewerIds.push(req.userId);
        }

        const viewers = await sortRoomViewersService({
            hostUserId: stream.userId,
            streamId: stream.streamId,
            viewerIds
        });

        const finalViewerCount = viewers.length;
        const cdnDomain = process.env.CDN_DOMAIN;

        let mode = "WEBRTC";
        let hlsUrl = null;

        // 🟢 51st Viewer Threshold: Viewers 1-50 get WebRTC, Viewers 51+ get BunnyCDN HLS
        if (finalViewerCount > 50 && req.userId !== stream.userId) {
            mode = "HLS";
            hlsUrl = `${cdnDomain}/hls/streams/${stream.streamId}/live.m3u8`;

            // Auto-start Local Egress if not already active
            if (redisClient.isOpen) {
                const egressKey = `stream:egress:${stream.streamId}`;
                redisClient.get(egressKey).then(async (activeEgressId) => {
                    if (!activeEgressId) {
                        const newEgressId = await startLocalHlsEgressService(stream.streamId);
                        if (newEgressId) {
                            await redisClient.set(egressKey, newEgressId, "EX", 86400);
                        }
                    }
                }).catch(err => console.error("Egress start check error:", err.message));
            } else {
                startLocalHlsEgressService(stream.streamId).catch(err => console.error(err.message));
            }
        }

        if (isStealth) {
            getOrCreateSessionAlias(stream.streamId, req.userId).catch(() => { });
            console.log(`[REST Join] Stealth VIP User ${req.userId} joined room ${stream.streamId} silently.`);
        }

        return res.json({
            success: true,
            mode,
            token: mode === "HLS" ? null : token,
            hlsUrl,
            stream,
            viewerCount: finalViewerCount,
            viewers,
            host,
            micPermissionRequired,
            chatPermissionMode
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
};

const leaveLiveStream = async (req, res) => {
    try {
        const stream = await getLiveStreamService({ id: req.params.id });
        if (!stream) {
            return res.status(404).json({ success: false, message: "Stream not found" });
        }

        await leaveStreamService({ streamId: stream.streamId, userId: req.userId });

        const viewerCount = await getViewerCountService({ streamId: stream.streamId });

        let username = "Guest";
        let isStealth = false;
        const user = await prisma.user.findUnique({
            where: { id: req.userId },
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

        await removeSessionAlias(stream.streamId, req.userId);
        console.log(`[REST Leave] User ${req.userId} left room ${stream.streamId} silently.`);

        return res.json({
            success: true,
            viewerCount
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
};

const getLiveStreams = async (req, res) => {
    try {
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 20;
        let country = req.query.country || null;
        const type = req.query.type || null;
        const followingOnly = type === 'following' || req.query.following === 'true';
        const nearbyOnly = type === 'nearby' || req.query.nearby === 'true';
        const userLat = req.query.lat || req.query.latitude || null;
        const userLng = req.query.lng || req.query.longitude || null;
        const minKm = parseFloat(req.query.minKm) || 9;
        const maxKm = parseFloat(req.query.maxKm) || 40;

        // Default to logged-in user's own country if no explicit country, following, or nearby filter is provided
        if (!country && !followingOnly && !nearbyOnly && req.userId) {
            const currentUser = await prisma.user.findUnique({
                where: { id: req.userId },
                select: { country: true }
            });
            if (currentUser && currentUser.country) {
                country = currentUser.country;
            }
        }

        const { streams, total, page: currentPage, limit: currentLimit, totalPages } = await getLiveStreamsService({
            page,
            limit,
            country,
            followerUserId: req.userId,
            followingOnly,
            nearbyOnly,
            userLat,
            userLng,
            minKm,
            maxKm
        });
        if (!streams || streams.length === 0) {
            return res.json({
                success: true,
                data: [],
                pagination: {
                    page: currentPage,
                    limit: currentLimit,
                    totalPages: 0
                }
            });
        }

        const hostUserIds = [...new Set(streams.map(s => s.userId).filter(Boolean))];
        const streamIds = streams.map(s => s.streamId).filter(Boolean);

        const [hostUsers, videoCallSettingsList] = await Promise.all([
            hostUserIds.length > 0 ? prisma.user.findMany({
                where: { id: { in: hostUserIds } },
                select: { id: true, country: true, admin_tags: true }
            }) : [],
            hostUserIds.length > 0 ? prisma.videoCallSettings.findMany({
                where: { userId: { in: hostUserIds } },
                select: { userId: true, pricePerMin: true }
            }) : []
        ]);
        const hostCountryMap = new Map(hostUsers.map(u => [u.id, u.country || null]));
        const hostAdminTagsMap = new Map(hostUsers.map(u => [u.id, u.admin_tags || []]));
        const videoCallRateMap = new Map(videoCallSettingsList.map(s => [s.userId, s.pricePerMin]));

        const passwordKeys = streamIds.map(sId => `stream:password:${sId}`);
        const passwords = passwordKeys.length > 0 ? await redisClient.mGet(passwordKeys) : [];
        const passwordMap = new Map();
        streamIds.forEach((sId, index) => {
            passwordMap.set(sId, passwords[index]);
        });

        const getHostTagPriority = (tags = []) => {
            if (!Array.isArray(tags) || tags.length === 0) return 3;
            const normalized = tags.map(t => String(t).toLowerCase().trim());
            const isCelebrity = normalized.some(t => t.includes('celebrity host') || t === 'celebrity');
            const isRoyal = normalized.some(t => t.includes('royal host') || t === 'royal');
            if (isCelebrity) return 1;
            if (isRoyal) return 2;
            return 3;
        };

        const data = streams.map((stream) => {
            const password = passwordMap.get(stream.streamId);
            const pricePerMin = videoCallRateMap.get(stream.userId) || 1800;
            const coinsPerMin = Math.ceil((pricePerMin * 5) / 3);
            const adminTags = hostAdminTagsMap.get(stream.userId) || [];

            return {
                ...stream,
                hostAvatar: stream.coverImageUrl || null,
                hostCountry: hostCountryMap.get(stream.userId) || null,
                adminTags,
                isPasswordProtected: !!password,
                videoCallPricePerMin: pricePerMin,
                videoCallCoinsPerMin: coinsPerMin
            };
        });

        // Priority Sorting: 'celebrity host' (Priority 1) -> 'royal host' (Priority 2) -> Normal Hosts (Priority 3)
        data.sort((a, b) => {
            const priorityA = getHostTagPriority(a.adminTags);
            const priorityB = getHostTagPriority(b.adminTags);
            if (priorityA !== priorityB) {
                return priorityA - priorityB;
            }
            return 0;
        });

        return res.json({
            success: true,
            data,
            pagination: {
                page: currentPage,
                limit: currentLimit,
                totalPages
            }
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
};

const getLiveStream = async (req, res) => {
    try {
        const stream = await getLiveStreamService({ id: req.params.id });
        if (!stream) {
            return res.status(404).json({ success: false, message: "Stream not found" });
        }

        const [viewerIds, host, password, sheetUsers, micPermissionRequired, chatPermissionMode] = await Promise.all([
            syncAndGetActiveViewerIds(stream.streamId),
            getHostProfileService({ hostUserId: stream.userId }),
            getStreamPasswordService({ streamId: stream.streamId }),
            getSheetUsersService({ streamId: stream.streamId }),
            getMicPermissionService({ streamId: stream.streamId }),
            getChatPermissionService({ streamId: stream.streamId })
        ]);

        const isPasswordProtected = !!password;

        const viewers = await sortRoomViewersService({
            hostUserId: stream.userId,
            streamId: stream.streamId,
            viewerIds
        });

        const responseData = {
            success: true,
            data: stream,
            viewerCount: viewers.length,
            viewers,
            host,
            isPasswordProtected,
            micPermissionRequired,
            chatPermissionMode,
            sheetUsers
        };

        if (req.userId === stream.userId) {
            responseData.roomPassword = password || "";
        }

        return res.json(responseData);
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
};

const sendMessage = async (req, res) => {
    try {
        const chatMute = await isUserRestrictedFast(req.userId, 'LIVE_CHAT_MUTE');
        if (chatMute) {
            const untilIso = new Date(chatMute.restrictedUntil).toISOString();
            const formattedTime = new Date(chatMute.restrictedUntil).toLocaleString('en-IN', {
                timeZone: 'Asia/Kolkata',
                day: '2-digit',
                month: 'short',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: true
            });
            return res.status(403).json({
                success: false,
                code: 'LIVE_CHAT_MUTED',
                message: `You are muted from sending messages in live stream until ${formattedTime}`,
                restrictedUntil: untilIso
            });
        }

        const value = await sendMessageSchema.validateAsync(req.body);

        const stream = await getLiveStreamService({ id: req.params.id });
        if (!stream) {
            return res.status(404).json({ success: false, message: "Stream not found" });
        }

        const messageData = await sendMessageService({
            streamId: stream.streamId,
            senderId: req.userId,
            message: value.message,
            replyToMessageId: value.replyToMessageId,
            replyToUserId: value.replyToUserId,
            replyToUsername: value.replyToUsername,
            replyToText: value.replyToText
        });

        broadcastToStream(stream.streamId, "new_message", messageData);

        return res.status(201).json({
            success: true,
            data: messageData
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
};

const getMessages = async (req, res) => {
    try {
        const stream = await getLiveStreamService({ id: req.params.id });
        if (!stream) {
            return res.status(404).json({ success: false, message: "Stream not found" });
        }

        const filter = req.query.filter || (req.query.chatsOnly === "true" ? "chat" : "all");
        const messages = await getMessagesService({
            streamId: stream.streamId,
            filter,
            chatsOnly: req.query.chatsOnly === "true"
        });

        return res.json({
            success: true,
            data: messages
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
};

const toggleAdminStatus = async (req, res) => {
    try {
        const stream = await getLiveStreamService({ id: req.params.id });
        if (!stream) {
            return res.status(404).json({ success: false, message: "Stream not found" });
        }

        // Only stream host/owner can promote/demote admins
        if (req.userId !== stream.userId) {
            return res.status(403).json({ success: false, message: "Only the host can toggle admin privileges." });
        }

        const { targetUserId } = req.body;
        if (!targetUserId) {
            return res.status(400).json({ success: false, message: "targetUserId is required." });
        }

        if (targetUserId === stream.userId) {
            return res.status(400).json({ success: false, message: "Host cannot be promoted or demoted." });
        }

        const isAdmin = await promoteDemoteAdminService({ streamId: stream.streamId, targetUserId });

        const hostUser = await prisma.user.findUnique({
            where: { id: req.userId },
            select: { username: true, privacyMysteryLive: true, vipSubscriptionActive: true }
        });
        const targetUser = await prisma.user.findUnique({
            where: { id: targetUserId },
            select: { username: true, privacyMysteryLive: true, vipSubscriptionActive: true }
        });

        const isHostStealth = Boolean(hostUser?.privacyMysteryLive && hostUser?.vipSubscriptionActive);
        const isTargetStealth = Boolean(targetUser?.privacyMysteryLive && targetUser?.vipSubscriptionActive);

        const hostName = isHostStealth ? (await getOrCreateSessionAlias(stream.streamId, req.userId) || "Host") : (hostUser ? hostUser.username : "Host");
        const targetName = isTargetStealth ? (await getOrCreateSessionAlias(stream.streamId, targetUserId) || "User") : (targetUser ? targetUser.username : "User");

        const alertText = isAdmin
            ? `${targetName} is now a Room Admin.`
            : `${targetName} is no longer a Room Admin.`;

        const systemMessage = await sendMessageService({
            streamId: stream.streamId,
            senderId: SYSTEM_SENDER_ID,
            message: alertText,
            replyToUserId: isTargetStealth ? null : targetUserId,
            replyToUsername: targetName
        });

        broadcastToStream(stream.streamId, "admin_status_changed", {
            userId: isTargetStealth ? null : targetUserId,
            username: targetName,
            isAdmin,
            isMystery: isTargetStealth
        });

        broadcastToStream(stream.streamId, "new_message", systemMessage);

        return res.json({
            success: true,
            isAdmin
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
};

const kickUser = async (req, res) => {
    try {
        const stream = await getLiveStreamService({ id: req.params.id });
        if (!stream) {
            return res.status(404).json({ success: false, message: "Stream not found" });
        }

        const isHost = req.userId === stream.userId;
        const isAdmin = await isStreamAdminService({ streamId: stream.streamId, userId: req.userId });

        // Must be host or admin
        if (!isHost && !isAdmin) {
            return res.status(403).json({ success: false, message: "Unauthorized: only the host or an admin can kick users." });
        }

        const { targetUserId } = req.body;
        if (!targetUserId) {
            return res.status(400).json({ success: false, message: "targetUserId is required." });
        }

        // Cannot kick the host
        if (targetUserId === stream.userId) {
            return res.status(400).json({ success: false, message: "Host cannot be kicked from their own stream." });
        }

        // Check if target user has active VIP subscription
        const targetVipCheck = await prisma.user.findUnique({
            where: { id: targetUserId },
            select: { vipSubscriptionActive: true }
        });
        if (targetVipCheck && targetVipCheck.vipSubscriptionActive) {
            return res.status(403).json({
                success: false,
                message: "VIP users cannot be kicked from live streams."
            });
        }

        // If kicker is admin (not host), check target properties
        if (!isHost) {
            const isTargetAdmin = await isStreamAdminService({ streamId: stream.streamId, userId: targetUserId });
            if (isTargetAdmin) {
                return res.status(403).json({ success: false, message: "Admins cannot kick other admins." });
            }

            // Wealth level validation
            const kickerLevel = await prisma.userLevel.findUnique({ where: { userId: req.userId } });
            const targetLevel = await prisma.userLevel.findUnique({ where: { userId: targetUserId } });

            const kickerWealth = kickerLevel ? kickerLevel.wealthLevel : 0;
            const targetWealth = targetLevel ? targetLevel.wealthLevel : 0;

            if (kickerWealth < targetWealth) {
                return res.status(403).json({
                    success: false,
                    message: `You cannot kick this user. Their wealth level (${targetWealth}) is higher than yours (${kickerWealth}).`
                });
            }
        }

        await kickUserService({ streamId: stream.streamId, targetUserId });

        const kickerUser = await prisma.user.findUnique({
            where: { id: req.userId },
            select: { username: true, privacyMysteryLive: true, vipSubscriptionActive: true }
        });
        const targetUser = await prisma.user.findUnique({
            where: { id: targetUserId },
            select: { username: true, privacyMysteryLive: true, vipSubscriptionActive: true }
        });

        const isKickerStealth = Boolean(kickerUser?.privacyMysteryLive && kickerUser?.vipSubscriptionActive);
        const isTargetStealth = Boolean(targetUser?.privacyMysteryLive && targetUser?.vipSubscriptionActive);

        const kickerName = isKickerStealth ? (await getOrCreateSessionAlias(stream.streamId, req.userId) || "Admin") : (kickerUser ? kickerUser.username : "Admin");
        const targetName = isTargetStealth ? (await getOrCreateSessionAlias(stream.streamId, targetUserId) || "User") : (targetUser ? targetUser.username : "User");

        const alertText = `${targetName} removed from the room.`;

        const systemMessage = await sendMessageService({
            streamId: stream.streamId,
            senderId: SYSTEM_SENDER_ID,
            message: alertText,
            replyToUserId: isTargetStealth ? null : targetUserId,
            replyToUsername: targetName
        });

        // Broadcast to target specifically
        broadcastToStream(`user:${targetUserId}`, "kicked_from_room", {
            streamId: stream.streamId,
            message: "You have been removed from this stream by an admin."
        });

        // Force socket disconnection from the room
        await forceLeaveRoom(targetUserId, stream.streamId);

        // Broadcast user kicked
        broadcastToStream(stream.streamId, "user_kicked", {
            userId: isTargetStealth ? null : targetUserId,
            username: targetName,
            kickedBy: kickerName,
            isMystery: isTargetStealth
        });

        broadcastToStream(stream.streamId, "new_message", systemMessage);

        return res.json({
            success: true,
            message: `${targetName} has been kicked.`
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
};

const setRoomPassword = async (req, res) => {
    try {
        const stream = await getLiveStreamService({ id: req.params.id });
        if (!stream) {
            return res.status(404).json({ success: false, message: "Stream not found" });
        }

        // Only stream host/owner can set stream password
        if (req.userId !== stream.userId) {
            return res.status(403).json({ success: false, message: "Only the host can set stream password." });
        }

        const { password } = req.body;

        await setStreamPasswordService({ streamId: stream.streamId, password });

        return res.json({
            success: true,
            message: password ? "Stream password updated successfully." : "Stream password disabled."
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
};


const setChatPermission = async (req, res) => {
    try {
        const stream = await getLiveStreamService({ id: req.params.id });
        if (!stream) {
            return res.status(404).json({ success: false, message: "Stream not found" });
        }

        // Only stream host/owner can set chat permission settings
        if (req.userId !== stream.userId) {
            return res.status(403).json({ success: false, message: "Only the host can set chat permission settings." });
        }

        const { mode } = req.body;
        const validModes = ["EVERYONE", "ALL_MUTED", "FOLLOWERS_ONLY", "ADMINS_ONLY"];
        if (!mode || !validModes.includes(mode)) {
            return res.status(400).json({
                success: false,
                message: `Invalid mode. Allowed modes: ${validModes.join(", ")}`
            });
        }

        const updatedMode = await setChatPermissionService({
            streamId: stream.streamId,
            mode
        });

        broadcastToStream(stream.streamId, "chat_permission_changed", {
            streamId: stream.streamId,
            chatPermissionMode: updatedMode
        });

        return res.json({
            success: true,
            chatPermissionMode: updatedMode,
            message: `Chat permission mode updated to ${updatedMode}.`
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
};

const getGifts = async (req, res) => {
    try {
        const gifts = await prisma.gift.findMany({
            where: { isActive: true },
            orderBy: { coinCost: "asc" }
        });
        return res.status(200).json({ success: true, data: gifts });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

const sendStreamGift = async (req, res) => {
    try {
        const { giftId, targetUserId, count = 1 } = req.body;
        const streamDbId = req.params.id;

        if (!giftId) {
            return res.status(400).json({ success: false, message: "giftId is required." });
        }

        const giftCount = count
        const result = await sendStreamGiftService({ streamDbId, senderId: req.userId, giftId, targetUserId, count: giftCount });

        broadcastToStream(result.socketPayload.streamId, "GIFT_SENT", result.socketPayload);

        if (result.luckyWin) {
            broadcastToStream(result.socketPayload.streamId, "LUCKY_GIFT_WIN", result.luckyWin);
        }

        setImmediate(async () => {
            try {
                const giftMsgText = `${result.socketPayload.senderName} sent ${result.socketPayload.receiverName} ${result.socketPayload.gift.name} ×${result.socketPayload.count || 1}.`;
                const systemMessage = await sendMessageService({
                    streamId: result.socketPayload.streamId,
                    senderId: SYSTEM_SENDER_ID,
                    message: giftMsgText
                });
                broadcastToStream(result.socketPayload.streamId, "new_message", systemMessage);
            } catch (msgErr) {
                console.error("[Gift Send Chat Message Error]:", msgErr.message);
            }
        });

        // Targeted Socket Notification to Receiver User Device
        if (result.socketPayload.receiverId) {
            broadcastToStream(`user:${result.socketPayload.receiverId}`, "wallet_updated", {
                currency: "POINT",
                pointsAwarded: result.socketPayload.pointsAwarded,
                newTotalPoints: result.socketPayload.receiverTotalPoints
            });
        }

        // Broadcast gallery update if it unlocked a new gallery target progress
        if (result.galleryProgressUpdate) {
            broadcastToStream(result.socketPayload.streamId, "GIFT_GALLERY_UPDATE", result.galleryProgressUpdate);

            // 100% Gallery Completion Global Announcement ({host} completed the Gift Collection)
            if (result.galleryProgressUpdate.isCompleted) {
                setImmediate(async () => {
                    try {
                        const streamObj = await getLiveStreamService({ id: streamDbId });
                        let hostName = "Host";
                        let hostAvatarUrl = null;
                        if (streamObj) {
                            const hostUser = await getHostProfileService({ hostUserId: streamObj.userId });
                            hostName = hostUser?.username || "Host";
                            hostAvatarUrl = hostUser?.avatarUrl || null;
                        }

                        broadcastGlobalMessage("GLOBAL_ANNOUNCEMENT", {
                            type: "GALLERY_COMPLETED",
                            data: {
                                hostName,
                                hostAvatarUrl,
                                message: `${hostName} completed the Gift Collection.`,
                                streamId: result.socketPayload.streamId
                            }
                        });
                        console.log(`[Global Announcement] Gallery Completed by host ${hostName} (${result.galleryProgressUpdate.hostId})`);
                    } catch (annError) {
                        console.error("[Gallery Completion Announcement Error]:", annError.message);
                    }
                });
            }
        }

        // Global announcements (Non-blocking background worker - Total Gift Cost >= 300,000 Coins)
        const totalGiftCost = Number(result.socketPayload.totalCost || (Number(result.socketPayload.gift?.coinCost || 0) * Number(result.socketPayload.count || 1)));
        console.log(`[SendStreamGift Controller] Debug Gift Cost Check -> giftCost: ${result.socketPayload.gift?.coinCost}, count: ${result.socketPayload.count}, totalCost: ${result.socketPayload.totalCost}, calculatedTotal: ${totalGiftCost}`);
        if (totalGiftCost >= 300000 || Number(result.socketPayload.gift?.coinCost || 0) >= 300000) {
            setImmediate(async () => {
                try {
                    const streamObj = await getLiveStreamService({ id: streamDbId });
                    let hostName = "Host";
                    if (streamObj) {
                        const hostUser = await getHostProfileService({ hostUserId: streamObj.userId });
                        hostName = hostUser?.username || "Host";
                    }

                    const announcementData = {
                        type: "HIGH_VALUE_GIFT",
                        data: {
                            senderName: result.socketPayload.senderName,
                            senderAvatarUrl: result.socketPayload.senderAvatarUrl || null,
                            giftName: result.socketPayload.gift.name,
                            giftDisplayImageUrl: result.socketPayload.gift.displayImageUrl || null,
                            coinCost: totalGiftCost,
                            hostName: hostName,
                            streamId: result.socketPayload.streamId
                        }
                    };

                    console.log(`[Global Announcement] 🚀 Triggering High Value Gift Announcement! Total Cost: ${totalGiftCost} Coins | Gift: ${result.socketPayload.gift.name}`);
                    await broadcastGlobalMessage("GLOBAL_ANNOUNCEMENT", announcementData);
                    await broadcastGlobalMessage("GLOBAL_GIFT_ANNOUNCEMENT", announcementData);
                    await broadcastGlobalMessage("global_announcement", announcementData);
                } catch (annError) {
                    console.error("[Global Announcement Error]:", annError.message);
                }
            });
        }

        return res.status(200).json({
            success: true,
            message: "Gift sent successfully",
            data: {
                newBalance: result.newBalance !== undefined ? result.newBalance : (result.senderRemainingCoins !== undefined ? Number(result.senderRemainingCoins) : null),
                currentLevel: result.currentLevel,
                isLevelUp: result.isLevelUp,
                isLucky: result.isLucky || false,
                sendValue: result.totalCost !== undefined ? Number(result.totalCost) : (Number(result.socketPayload?.gift?.coinCost || 0) * Number(result.socketPayload?.count || 1)),
                returnValue: result.totalRewardCoins !== undefined ? Number(result.totalRewardCoins) : (result.luckyWin ? Number(result.luckyWin.rewardCoins) : 0),
                category: result.category || null
            }
        });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
};

const sendGlobalMessage = async (req, res) => {
    try {
        const { message, streamId } = req.body;
        if (!message) {
            return res.status(400).json({ success: false, message: "message is required." });
        }

        let resolvedStreamId = streamId || null;
        if (streamId) {
            const stream = await getLiveStreamService({ id: streamId });
            if (stream) {
                resolvedStreamId = stream.streamId;
            }
        }

        const result = await sendGlobalMessageService({ senderId: req.userId, message, streamId: resolvedStreamId });

        // 1. Broadcast global announcement banner to all connected sockets
        broadcastGlobalMessage("GLOBAL_MESSAGE_SENT", result.socketPayload);

        // 2. If sent from inside a live stream room, ALSO create and broadcast as a chat message in that room's chat box
        if (resolvedStreamId) {
            setImmediate(async () => {
                try {
                    const chatMsg = await sendMessageService({
                        streamId: resolvedStreamId,
                        senderId: req.userId,
                        message
                    });
                    broadcastToStream(resolvedStreamId, "new_message", chatMsg);
                } catch (chatErr) {
                    console.error("[Global Message Room Chat Error]:", chatErr.message);
                }
            });
        }

        return res.status(200).json({
            success: true,
            message: "Global message sent successfully",
            data: {
                newBalance: result.newBalance
            }
        });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
};

const getWalletBalance = async (req, res) => {
    try {
        const walletKey = `wallet:coins:${req.userId}`;
        if (redisClient.isOpen) {
            const cachedCoins = await redisClient.get(walletKey);
            if (cachedCoins !== null) {
                return res.status(200).json({
                    success: true,
                    balance: Number(cachedCoins)
                });
            }
        }

        const wallet = await getOrCreateWallet(req.userId, WalletCurrencyType.COIN);
        const coins = await getFastCoinBalance(wallet.id);

        if (redisClient.isOpen) {
            await redisClient.set(walletKey, coins.toString(), "EX", 3600);
        }

        return res.status(200).json({
            success: true,
            balance: Number(coins)
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

const followUser = async (req, res) => {
    try {
        const { targetUserId } = req.params;
        const { streamId } = req.body;
        const followerId = req.userId;

        const result = await followUserService({ followerId, followingId: targetUserId });

        if (streamId) {
            setImmediate(async () => {
                try {
                    const [followerUser, streamObj] = await Promise.all([
                        prisma.user.findUnique({
                            where: { id: followerId },
                            select: { privacyMysteryLive: true, vipSubscriptionActive: true }
                        }),
                        getLiveStreamService({ id: streamId })
                    ]);

                    const isFollowerStealth = Boolean(followerUser?.privacyMysteryLive && followerUser?.vipSubscriptionActive);
                    const displayFollowerName = isFollowerStealth ? (await getOrCreateSessionAlias(streamId, followerId) || "Mystery User") : result.followerName;

                    const isHostFollowed = Boolean(streamObj && streamObj.userId === targetUserId);
                    const followMessageText = isHostFollowed
                        ? `${displayFollowerName} followed the host.`
                        : `${displayFollowerName} followed ${result.followingName}.`;

                    const systemMessage = await sendMessageService({
                        streamId,
                        senderId: SYSTEM_SENDER_ID,
                        message: followMessageText,
                        replyToUserId: isFollowerStealth ? null : followerId,
                        replyToUsername: displayFollowerName
                    });

                    broadcastToStream(streamId, "USER_FOLLOWED", {
                        followerId: isFollowerStealth ? null : result.followerId,
                        followerName: displayFollowerName,
                        followingId: result.followingId,
                        followingName: result.followingName,
                        isMystery: isFollowerStealth
                    });

                    broadcastToStream(streamId, "new_message", systemMessage);
                } catch (bgErr) {
                    console.error("[Follow Async Background Error]:", bgErr.message);
                }
            });
        }

        return res.status(200).json({
            success: true,
            message: "Followed successfully",
            data: result
        });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
};

const unfollowUser = async (req, res) => {
    try {
        const { targetUserId } = req.params;
        const { streamId } = req.body;
        const followerId = req.userId;

        await unfollowUserService({ followerId, followingId: targetUserId });

        if (streamId) {
            broadcastToStream(streamId, "USER_UNFOLLOWED", {
                followerId,
                followingId: targetUserId
            });
        }

        return res.status(200).json({
            success: true,
            message: "Unfollowed successfully"
        });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
};

const checkFollowStatus = async (req, res) => {
    try {
        const { targetUserId } = req.params;
        const followerId = req.userId;

        const result = await checkFollowStatusService({ followerId, followingId: targetUserId });

        return res.status(200).json({
            success: true,
            isFollowing: result.isFollowing
        });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
};

const verifyStreamFrame = async (req, res) => {
    try {
        const { id } = req.params;
        const { base64Image } = req.body;

        if (!base64Image) {
            return res.status(400).json({ success: false, message: "Missing base64Image." });
        }

        const result = await verifyStreamFrameService({ id, base64Image });

        return res.status(200).json({
            success: true,
            data: result
        });
    } catch (error) {
        console.error("[Stream Moderation Controller] Error:", error);
        return res.status(400).json({ success: false, message: error.message });
    }
};

const getMyLivePhoto = async (req, res) => {
    try {
        const livePhoto = await prisma.userLivePhoto.findUnique({
            where: { userId: req.userId },
            select: { imageUrl: true }
        });
        return res.json({
            success: true,
            imageUrl: livePhoto?.imageUrl || null
        });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
};

const getGiftGalleryTargets = async (req, res) => {
    try {
        const hostId = req.query.hostId || req.userId;
        const data = await getGiftGalleryTargetsService(hostId);
        return res.json({ success: true, data });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
};

const reportFakeLive = async (req, res) => {
    try {
        const streamDbId = req.params.id;
        const { base64Image, additionalInfo } = req.body;

        const result = await reportFakeLiveService({
            streamDbId,
            reporterId: req.userId,
            base64Image,
            additionalInfo
        });

        return res.status(200).json(result);
    } catch (error) {
        console.error("[Report Fake Live Controller] Error:", error);
        return res.status(400).json({ success: false, message: error.message });
    }
};

const getUserEffectSettings = async (req, res) => {
    try {
        const data = await getUserEffectSettingsService(req.userId);
        return res.status(200).json({ success: true, data });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
};

const updateUserEffectSettings = async (req, res) => {
    try {
        const data = await updateUserEffectSettingsService(req.userId, req.body);
        return res.status(200).json({
            success: true,
            message: "Effect settings updated successfully",
            data
        });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
};

const getFansRanking = async (req, res) => {
    try {
        const { hostId } = req.params;
        const { period } = req.query;

        if (!hostId) {
            return res.status(400).json({ success: false, message: "hostId is required." });
        }

        const data = await getFansRankingService({
            hostId,
            period,
            currentUserId: req.userId
        });

        return res.status(200).json({
            success: true,
            ...data
        });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
};

const sendLuckyGift = async (req, res) => {
    try {
        const { receiverId, streamId, giftId, comboCount = 1, clientTxId } = req.body;
        const senderId = req.userId;

        if (!receiverId || !streamId || !giftId) {
            return res.status(400).json({
                success: false,
                message: "receiverId, streamId, and giftId are required."
            });
        }

        const result = await sendLuckyGiftService({
            senderId,
            receiverId,
            streamId,
            giftId,
            comboCount: comboCount || 1,
            clientTxId: clientTxId || null
        });

        // Trigger Global Announcement if Lucky Gift Total Cost >= 300,000 Coins
        if (result && result.totalCost >= 300000) {
            setImmediate(async () => {
                try {
                    const streamObj = await getLiveStreamService({ id: streamId });
                    let hostName = "Host";
                    if (streamObj) {
                        const hostUser = await getHostProfileService({ hostUserId: streamObj.userId });
                        hostName = hostUser?.username || "Host";
                    }

                    const senderUser = await getHostProfileService({ hostUserId: senderId });

                    broadcastGlobalMessage("GLOBAL_ANNOUNCEMENT", {
                        type: "HIGH_VALUE_GIFT",
                        data: {
                            senderName: senderUser?.username || "Gifter",
                            senderAvatarUrl: senderUser?.avatarUrl || null,
                            giftName: result.gift?.name || "Lucky Gift",
                            giftDisplayImageUrl: result.gift?.displayImageUrl || null,
                            coinCost: result.totalCost,
                            hostName: hostName,
                            streamId: streamId
                        }
                    });
                } catch (annErr) {
                    console.error("[LuckyGift Global Announcement Error]:", annErr.message);
                }
            });
        }

        return res.status(200).json(result);
    } catch (error) {
        console.error("[LuckyGift Controller] Error:", error.message);
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
};

const getHostStats = async (req, res) => {
    try {
        const hostUserId = req.query.hostId || req.userId;
        if (!hostUserId) {
            return res.status(400).json({
                success: false,
                message: "hostId parameter or authentication token required."
            });
        }

        const period = req.query.period || 'today';
        const data = await getHostStatsService({ hostUserId, period });
        return res.json({
            success: true,
            data
        });
    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
};

router.get('/host-stats', auth, getHostStats);
router.get('/user/effect-settings', auth, getUserEffectSettings);
router.patch('/user/effect-settings', auth, updateUserEffectSettings);
router.post('/follow/:targetUserId', auth, followUser);
router.post('/unfollow/:targetUserId', auth, unfollowUser);
router.get('/follow-check/:targetUserId', auth, checkFollowStatus);

router.get('/fans-ranking/:hostId', auth, getFansRanking);
router.get('/my-photo', auth, getMyLivePhoto);
router.get('/gift-gallery/targets', auth, getGiftGalleryTargets);
router.post('/go-live', auth, fastGoLiveStream);
router.post('/end/:id', auth, endLiveStream);
router.post('/join/:id', auth, joinLiveStream);
router.post('/leave/:id', auth, leaveLiveStream);
router.get('/list', auth, getLiveStreams);
router.get('/gifts', auth, getGifts);
router.get('/wallet/balance', auth, getWalletBalance);
router.get('/:id', auth, getLiveStream);
router.post('/:id/message', auth, sendMessage);
router.get('/:id/messages', auth, getMessages);
router.post('/:id/toggle-admin', auth, toggleAdminStatus);
router.post('/:id/kick', auth, kickUser);
router.post('/:id/password', auth, setRoomPassword);
router.post('/:id/chat-permission', auth, setChatPermission);
router.post('/:id/send-gift', auth, sendStreamGift);
router.post('/lucky-gift/send', auth, sendLuckyGift);
router.post('/global-message', auth, sendGlobalMessage);
router.post('/:id/verify-frame', auth, verifyStreamFrame);
router.post('/:id/report-fake', auth, reportFakeLive);

export default router;