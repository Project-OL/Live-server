import prisma from '../../config/prisma.js';
import crypto from 'crypto';
import { AccessToken, RoomServiceClient, EgressClient } from 'livekit-server-sdk';
import { client as redisClient } from '../../config/redis.js';
import dotenv from 'dotenv';
import { isUserRestrictedFast } from './serviceAdmin.js';
import { WalletCurrencyType, LedgerDirection, CoinTxType, PointTxType, LevelType } from '@prisma/client';
import {
    getOrCreateWallet,
    getFastCoinBalance,
    getFastPointBalance,
    updateUserLevel,
} from '../../modules/videoCall/service.js';
import { afterCommissionCreditCommit } from '../../services/agencyTierRecompute.service.js';
import { moderateImage, uploadFlaggedFrameToS3 } from '../../modules/videoCall/aws.service.js';
import { broadcastToStream } from './socket-live-service.js';
import { sendLuckyGiftService } from './serviceLuckyGift.js';
import { checkCoinsFrozenFast } from '../../utils/coinRestriction.js';
import { getOrCreateSessionAlias } from './serviceMessage.js';

import {
    cleanOldHlsSegmentsService,
    removeHlsStreamDirService,
    startLocalHlsEgressService,
    stopLocalHlsEgressService
} from './serviceHlsEgress.js';

export {
    cleanOldHlsSegmentsService,
    removeHlsStreamDirService,
    startLocalHlsEgressService,
    stopLocalHlsEgressService
};

dotenv.config();

const apiKey = process.env.LIVEKIT_API_KEY || 'devkey';
const apiSecret = process.env.LIVEKIT_API_SECRET || 'secret';
const livekitHost = process.env.LIVEKIT_URL || 'http://localhost:7880';

const roomService = new RoomServiceClient(livekitHost, apiKey, apiSecret);
const egressClient = new EgressClient(livekitHost, apiKey, apiSecret);
const isProduction = process.env.isProduction === 'true';


export const generateStreamHostToken = async (roomName, participantId) => {
    const at = new AccessToken(apiKey, apiSecret, {
        identity: participantId,
    });
    at.addGrant({
        roomJoin: true,
        room: roomName,
        canPublish: true,
        canSubscribe: true,
    });
    return await at.toJwt();
};

export const generateStreamViewerToken = async (roomName, participantId) => {
    const audioMuted = participantId ? await isUserRestrictedFast(participantId, 'LIVE_AUDIO_MUTE') : false;

    const at = new AccessToken(apiKey, apiSecret, {
        identity: participantId,
    });
    at.addGrant({
        roomJoin: true,
        room: roomName,
        canPublish: !audioMuted,
        canSubscribe: true,
    });
    return await at.toJwt();
};

export const closeLivekitRoom = async (roomName) => {
    try {
        await roomService.deleteRoom(roomName);
    } catch (error) {
        console.error(`[LiveKit] Failed to close room ${roomName}:`, error.message);
    }
};

export const fastGoLiveStreamService = async ({
    userId,
    title,
    heading,
    isCameraOn = true
}) => {
    const activeStreamKey = `user:active_stream:${userId}`;
    const suspendedCacheKey = `user:suspended:${userId}`;

    let [activeStreamId, isSuspended] = redisClient.isOpen ? await Promise.all([
        redisClient.get(activeStreamKey),
        redisClient.get(suspendedCacheKey)
    ]) : [null, null];

    const banRestriction = await isUserRestrictedFast(userId, 'LIVE_STREAM_START_BAN');
    if (banRestriction) {
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
        throw new Error(`You are banned from starting a live stream until ${formattedTime}`);
    }

    if (isSuspended === "true") {
        throw new Error("Your streaming privileges are suspended due to moderation violations.");
    }

    if (activeStreamId) {
        const dbActiveStream = await prisma.liveStream.findFirst({
            where: {
                userId,
                isLive: true
            },
            select: { id: true }
        });
        if (!dbActiveStream) {
            console.warn(`[Self-Healing] Cleaning up stale Redis active stream key for user ${userId} (StreamId: ${activeStreamId})`);
            if (redisClient.isOpen) {
                await Promise.all([
                    redisClient.del(activeStreamKey),
                    redisClient.del(`stream:info:${activeStreamId}`)
                ]).catch(() => { });
            }
            activeStreamId = null;
        } else {
            throw new Error("You already have an active live stream. End it first.");
        }
    }

    // 1. Parallel DB validations (only if not cached in Redis)
    const [user, livePhoto, existingActive] = await Promise.all([
        isSuspended !== null ? Promise.resolve(null) : prisma.user.findUnique({
            where: { id: userId },
            select: { suspended_until: true, avatarUrl: true }
        }),
        prisma.userLivePhoto.findUnique({
            where: { userId },
            select: { imageUrl: true }
        }),
        activeStreamId ? Promise.resolve(null) : prisma.liveStream.findFirst({
            where: {
                userId,
                isLive: true
            },
            select: { id: true }
        })
    ]);

    if (user && user.suspended_until && user.suspended_until > new Date()) {
        if (redisClient.isOpen) {
            await redisClient.set(suspendedCacheKey, "true", "EX", 300);
        }
        throw new Error(`Your streaming privileges are suspended until ${user.suspended_until.toLocaleString()} due to moderation violations.`);
    } else if (user && redisClient.isOpen) {
        await redisClient.set(suspendedCacheKey, "false", "EX", 3600);
    }

    if (existingActive) {
        if (redisClient.isOpen) {
            await redisClient.set(activeStreamKey, existingActive.id, "EX", 86400);
        }
        throw new Error("You already have an active live stream. End it first.");
    }

    const coverImageUrl = livePhoto?.imageUrl || user?.avatarUrl || null;

    const streamId = crypto.randomUUID();
    const streamKey = crypto.randomBytes(32).toString('hex');
    const now = new Date();

    const createdStream = {
        id: streamId,
        userId,
        title,
        heading,
        coverImageUrl,
        streamId,
        streamKey,
        isLive: true,
        startedAt: now,
        endedAt: null,
        createdAt: now,
        updatedAt: now
    };

    if (redisClient.isOpen) {
        await Promise.all([
            redisClient.set(`stream:info:${streamId}`, JSON.stringify(createdStream), "EX", 86400),
            redisClient.set(activeStreamKey, streamId, "EX", 86400)
        ]);
    }

    if (isCameraOn === false || isCameraOn === "false") {
        await handleCameraStateChangeService({ streamId, isCameraOn: false, userId });
    }

    const token = await generateStreamHostToken(streamId, userId);

    setImmediate(async () => {
        try {
            await prisma.liveStream.create({
                data: {
                    id: streamId,
                    userId,
                    title,
                    heading,
                    coverImageUrl,
                    streamId,
                    streamKey,
                    isLive: true,
                    startedAt: now,
                    endedAt: null
                }
            });
            console.log(`[Async DB Write] LiveStream ${streamId} saved to PostgreSQL in background.`);
        } catch (bgError) {
            console.error(`[Background Task Error] Stream ${streamId}:`, bgError.message);
        }
    });

    return {
        stream: createdStream,
        token
    };
};

export const endLiveStreamService = async ({
    id,
    userId
}) => {
    const stream = await prisma.liveStream.findUnique({
        where: { id }
    });

    if (!stream) {
        throw new Error("Live stream not found.");
    }

    if (stream.userId !== userId) {
        throw new Error("Unauthorized to end this live stream.");
    }

    if (isProduction && stream.playbackId) {
        try {
            await egressClient.stopEgress(stream.playbackId);
            console.log(`[LiveKit Egress] Egress stopped successfully.`);
        } catch (egressError) {
            console.error(`[LiveKit Egress] Failed to stop egress ${stream.playbackId}:`, egressError.message);
        }
    }

    const streamIdKey = stream.streamId || id;
    if (redisClient.isOpen) {
        const egressKey = `stream:egress:${streamIdKey}`;
        redisClient.get(egressKey).then(async (activeEgressId) => {
            if (activeEgressId) {
                await stopLocalHlsEgressService(activeEgressId, streamIdKey);
                await redisClient.del(egressKey);
            }
        }).catch(err => console.error("Egress cleanup error:", err.message));
    }

    const endedAt = new Date();
    const keyOff = `stream:camera_off_at:${streamIdKey}`;
    const keyUncounted = `stream:uncounted_seconds:${streamIdKey}`;

    if (redisClient.isOpen) {
        const cameraOffAtStr = await redisClient.get(keyOff);
        if (cameraOffAtStr) {
            const offMs = endedAt.getTime() - Number(cameraOffAtStr);
            const offSec = Math.floor(offMs / 1000);
            if (offSec > 60) {
                const excessSec = offSec - 60;
                await redisClient.incrBy(keyUncounted, excessSec);
                console.log(`[CameraState End] Camera was OFF at stream end for ${streamIdKey}. Off: ${offSec}s, Excess uncounted: ${excessSec}s`);
            }
            await redisClient.del(keyOff);
        }
    }

    const startedAt = stream.startedAt || stream.createdAt || endedAt;
    const grossDurationSeconds = Math.max(0, Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000));

    let uncountedSec = 0;
    if (redisClient.isOpen) {
        const uncountedStr = await redisClient.get(keyUncounted);
        if (uncountedStr) {
            uncountedSec = parseInt(uncountedStr, 10) || 0;
        }
    }

    const effectiveDurationSeconds = Math.max(0, grossDurationSeconds - uncountedSec);

    // Persist billable duration on the same Prisma update (do not rely on a separate
    // $executeRawUnsafe — that path was leaving effective_duration_seconds at 0 in prod).
    const updatedStream = await prisma.liveStream.update({
        where: { id },
        data: {
            isLive: false,
            endedAt,
            effectiveDurationSeconds,
        }
    });

    if (redisClient.isOpen) {
        await Promise.all([
            redisClient.del(`user:active_stream:${userId}`),
            redisClient.del(`stream:info:${stream.streamId}`),
            redisClient.del(`stream:info:${id}`),
            redisClient.del(keyUncounted)
        ]);
    }

    const durationSeconds = effectiveDurationSeconds;

    const hours = Math.floor(durationSeconds / 3600);
    const minutes = Math.floor((durationSeconds % 3600) / 60);
    const secs = durationSeconds % 60;
    const durationFormatted = [hours, minutes, secs]
        .map(v => String(v).padStart(2, '0'))
        .join(':');

    let host = null;
    try {
        const hostUser = await prisma.user.findUnique({
            where: { id: stream.userId },
            select: { id: true, username: true, avatarUrl: true }
        });
        host = {
            id: hostUser ? hostUser.id : stream.userId,
            name: hostUser ? (hostUser.username || "Host") : "Host",
            avatarUrl: hostUser ? hostUser.avatarUrl : null
        };
    } catch (hostErr) {
        console.error("[End Stream Summary] Host fetch failed:", hostErr.message);
        host = { id: stream.userId, name: "Host", avatarUrl: null };
    }

    let wonPoints = 0;
    try {
        const wonPointsAgg = await prisma.giftTransaction.aggregate({
            _sum: {
                pointsAwarded: true
            },
            where: {
                receiverUserId: stream.userId,
                createdAt: {
                    gte: startedAt,
                    lte: endedAt
                }
            }
        });
        wonPoints = wonPointsAgg._sum.pointsAwarded || 0;
    } catch (ptsErr) {
        console.error("[End Stream Summary] Won points calculation failed:", ptsErr.message);
    }

    let newFollowersCount = 0;
    try {
        newFollowersCount = await prisma.userFollow.count({
            where: {
                followingId: stream.userId,
                createdAt: {
                    gte: startedAt,
                    lte: endedAt
                }
            }
        });
    } catch (folErr) {
        console.error("[End Stream Summary] New followers count failed:", folErr.message);
    }

    let totalAudiencesCount = 0;
    try {
        const viewerIds = await redisClient.sMembers(`stream:history:${stream.streamId}`);
        totalAudiencesCount = viewerIds ? viewerIds.length : 0;
    } catch (audErr) {
        console.error("[End Stream Summary] Audiences count failed:", audErr.message);
    }

    const summary = {
        streamId: stream.streamId,
        host,
        durationSeconds,
        durationFormatted,
        wonPoints,
        newFollowersCount,
        totalAudiencesCount
    };

    try {
        const viewerIds = await redisClient.sMembers(`stream:history:${stream.streamId}`);
        if (viewerIds && viewerIds.length > 0) {
            const viewerData = viewerIds.map(vId => ({
                streamId: stream.streamId,
                userId: vId
            }));
            await prisma.streamViewer.createMany({
                data: viewerData,
                skipDuplicates: true
            });
            console.log(`[Batch Sync] Saved ${viewerIds.length} viewer sessions to DB.`);
        }
    } catch (syncError) {
        console.error("[Batch Sync] Failed to sync viewers to DB:", syncError.message);
    }

    try {
        const rawChats = await redisClient.lRange(`stream:chats:${stream.streamId}`, 0, -1);
        if (rawChats && rawChats.length > 0) {
            const chatData = rawChats.map(c => {
                const parsed = JSON.parse(c);
                return {
                    id: parsed.id,
                    streamId: parsed.streamId,
                    senderId: parsed.senderId,
                    message: parsed.message,
                    createdAt: new Date(parsed.createdAt),
                    replyToMessageId: parsed.replyToMessageId || null,
                    replyToUserId: parsed.replyToUserId || null,
                    replyToUsername: parsed.replyToUsername || null,
                    replyToText: parsed.replyToText || null
                };
            });
            await prisma.liveMessage.createMany({
                data: chatData,
                skipDuplicates: true
            });
            console.log(`[Batch Sync] Saved ${chatData.length} live messages to DB.`);
        }
    } catch (syncError) {
        console.error("[Batch Sync] Failed to sync chats to DB:", syncError.message);
    }

    try {
        await redisClient.del([
            `stream:active:${stream.streamId}`,
            `stream:history:${stream.streamId}`,
            `stream:chats:${stream.streamId}`,
            `stream:admins:${stream.streamId}`,
            `stream:kicked:${stream.streamId}`,
            `stream:password:${stream.streamId}`,
            `stream:sheet:${stream.streamId}`,
            `stream:mic_permission:${stream.streamId}`,
            `stream:chat_permission:${stream.streamId}`
        ]);
    } catch (cleanError) {
        console.error("[Redis Clean] Failed to clear Redis keys:", cleanError.message);
    }

    await closeLivekitRoom(stream.streamId);

    return {
        stream: updatedStream,
        summary
    };
};

export const calculateDistanceKm = (lat1, lon1, lat2, lon2) => {
    if (lat1 === null || lon1 === null || lat2 === null || lon2 === null) return null;
    const nLat1 = Number(lat1);
    const nLon1 = Number(lon1);
    const nLat2 = Number(lat2);
    const nLon2 = Number(lon2);
    if (isNaN(nLat1) || isNaN(nLon1) || isNaN(nLat2) || isNaN(nLon2)) return null;

    const R = 6371; // Earth's radius in KM
    const dLat = (nLat2 - nLat1) * (Math.PI / 180);
    const dLon = (nLon2 - nLon1) * (Math.PI / 180);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(nLat1 * (Math.PI / 180)) * Math.cos(nLat2 * (Math.PI / 180)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return parseFloat((R * c).toFixed(2));
};

export const getLiveStreamsService = async ({ page = 1, limit = 20, country = null, followerUserId = null, followingOnly = false, nearbyOnly = false, userLat = null, userLng = null, minKm = 9, maxKm = 40 } = {}) => {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, parseInt(limit, 10) || 20);
    const skip = (pageNum - 1) * limitNum;

    let whereClause = {
        isLive: true
    };

    const normCountry = (country && typeof country === 'string') ? country.trim().toLowerCase() : null;
    const isGlobalOrRandom = normCountry && ['all', 'global', 'random', 'world'].includes(normCountry);

    // --- 1. NEARBY FILTER (9km - 40km Range) ---
    if (nearbyOnly) {
        let finalUserLat = userLat !== null && userLat !== undefined ? Number(userLat) : null;
        let finalUserLng = userLng !== null && userLng !== undefined ? Number(userLng) : null;

        // If user coordinates not explicitly provided, fetch from DB
        if ((finalUserLat === null || finalUserLng === null || isNaN(finalUserLat) || isNaN(finalUserLng)) && followerUserId) {
            const currentUser = await prisma.user.findUnique({
                where: { id: followerUserId },
                select: { lastLatitude: true, lastLongitude: true }
            });
            if (currentUser && currentUser.lastLatitude !== null && currentUser.lastLongitude !== null) {
                finalUserLat = Number(currentUser.lastLatitude);
                finalUserLng = Number(currentUser.lastLongitude);
            }
        }

        // If user location is still missing, return empty list (No Fallback)
        if (finalUserLat === null || finalUserLng === null || isNaN(finalUserLat) || isNaN(finalUserLng)) {
            return {
                streams: [],
                total: 0,
                page: pageNum,
                limit: limitNum,
                totalPages: 0
            };
        }

        // Fetch all active streams and their hosts' locations
        const allActiveStreams = await prisma.liveStream.findMany({
            where: { isLive: true },
            orderBy: { startedAt: 'desc' }
        });

        if (allActiveStreams.length === 0) {
            return {
                streams: [],
                total: 0,
                page: pageNum,
                limit: limitNum,
                totalPages: 0
            };
        }

        const hostUserIds = [...new Set(allActiveStreams.map(s => s.userId).filter(Boolean))];
        const hostUsers = await prisma.user.findMany({
            where: { id: { in: hostUserIds } },
            select: { id: true, lastLatitude: true, lastLongitude: true }
        });

        const hostLocationMap = new Map();
        hostUsers.forEach(u => {
            if (u.lastLatitude !== null && u.lastLongitude !== null) {
                hostLocationMap.set(u.id, {
                    lat: Number(u.lastLatitude),
                    lng: Number(u.lastLongitude)
                });
            }
        });

        const nearbyStreams = [];
        const minDist = Number(minKm) || 9;
        const maxDist = Number(maxKm) || 40;

        for (const stream of allActiveStreams) {
            const loc = hostLocationMap.get(stream.userId);
            if (!loc) continue;

            const dist = calculateDistanceKm(finalUserLat, finalUserLng, loc.lat, loc.lng);
            if (dist !== null && dist >= minDist && dist <= maxDist) {
                nearbyStreams.push({
                    ...stream,
                    distanceKm: dist
                });
            }
        }

        // Sort by distance ascending (nearest first)
        nearbyStreams.sort((a, b) => a.distanceKm - b.distanceKm);

        const totalNearby = nearbyStreams.length;
        const paginatedStreams = nearbyStreams.slice(skip, skip + limitNum);

        return {
            streams: paginatedStreams,
            total: totalNearby,
            page: pageNum,
            limit: limitNum,
            totalPages: Math.ceil(totalNearby / limitNum)
        };
    }

    // --- 2. FOLLOWING FILTER ---
    if (followingOnly && followerUserId && !isGlobalOrRandom) {
        const follows = await prisma.userFollow.findMany({
            where: { followerId: followerUserId },
            select: { followingId: true }
        });
        const followingIds = follows.map(f => f.followingId);

        if (followingIds.length === 0) {
            return {
                streams: [],
                total: 0,
                page: pageNum,
                limit: limitNum,
                totalPages: 0
            };
        }
        whereClause.userId = { in: followingIds };
    } else if (normCountry && !isGlobalOrRandom) {
        const countryUsers = await prisma.user.findMany({
            where: {
                country: {
                    equals: country.trim(),
                    mode: 'insensitive'
                }
            },
            select: { id: true }
        });

        const userIds = countryUsers.map(u => u.id);
        if (userIds.length === 0) {
            return {
                streams: [],
                total: 0,
                page: pageNum,
                limit: limitNum,
                totalPages: 0
            };
        }
        whereClause.userId = { in: userIds };
    }

    const [streams, total] = await Promise.all([
        prisma.liveStream.findMany({
            where: whereClause,
            orderBy: {
                startedAt: 'desc'
            },
            skip,
            take: limitNum
        }),
        prisma.liveStream.count({
            where: whereClause
        })
    ]);

    return {
        streams,
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum)
    };
};

export const getLiveStreamService = async ({
    id
}) => {
    if (!id) return null;

    if (redisClient.isOpen) {
        const cached = await redisClient.get(`stream:info:${id}`);
        if (cached) {
            try { return JSON.parse(cached); } catch (e) { }
        }
    }

    let stream = await prisma.liveStream.findUnique({
        where: { id }
    });
    if (!stream) {
        stream = await prisma.liveStream.findFirst({
            where: { streamId: id }
        });
    }

    if (stream && redisClient.isOpen) {
        await Promise.all([
            redisClient.set(`stream:info:${stream.id}`, JSON.stringify(stream), "EX", 86400),
            redisClient.set(`stream:info:${stream.streamId}`, JSON.stringify(stream), "EX", 86400)
        ]);
    }
    return stream;
};

export const isStreamAdminService = async ({ streamId, userId, hostUserId = null }) => {
    if (!userId) return false;
    let finalHostUserId = hostUserId;
    if (!finalHostUserId && streamId) {
        const stream = await getLiveStreamService({ id: streamId });
        if (stream) finalHostUserId = stream.userId;
    }

    if (redisClient.isOpen) {
        if (streamId) {
            const isStreamAdmin = await redisClient.sIsMember(`stream:admins:${streamId}`, userId);
            if (isStreamAdmin) return true;
        }
        if (finalHostUserId) {
            const isHostAdmin = await redisClient.sIsMember(`host:admins:${finalHostUserId}`, userId);
            if (isHostAdmin) return true;
        }
    }

    if (finalHostUserId) {
        try {
            const dbAdmin = await prisma.liveStreamAdmin.findUnique({
                where: {
                    hostUserId_adminUserId: {
                        hostUserId: finalHostUserId,
                        adminUserId: userId
                    }
                }
            });
            if (dbAdmin) {
                if (redisClient.isOpen) {
                    await redisClient.sAdd(`host:admins:${finalHostUserId}`, userId);
                }
                return true;
            }
        } catch (dbErr) { }
    }
    return false;
};

export const promoteDemoteAdminService = async ({ streamId, hostUserId = null, targetUserId }) => {
    let finalHostUserId = hostUserId;
    if (!finalHostUserId && streamId) {
        const stream = await getLiveStreamService({ id: streamId });
        if (stream) finalHostUserId = stream.userId;
    }

    const isCurrentlyAdmin = await isStreamAdminService({ streamId, userId: targetUserId, hostUserId: finalHostUserId });
    let resultStatus = false;

    if (isCurrentlyAdmin) {
        if (redisClient.isOpen) {
            if (streamId) await redisClient.sRem(`stream:admins:${streamId}`, targetUserId);
            if (finalHostUserId) await redisClient.sRem(`host:admins:${finalHostUserId}`, targetUserId);
        }
        if (finalHostUserId) {
            try {
                await prisma.liveStreamAdmin.deleteMany({
                    where: { hostUserId: finalHostUserId, adminUserId: targetUserId }
                });
            } catch (err) { }
        }
        resultStatus = false;
    } else {
        if (redisClient.isOpen) {
            if (streamId) await redisClient.sAdd(`stream:admins:${streamId}`, targetUserId);
            if (finalHostUserId) await redisClient.sAdd(`host:admins:${finalHostUserId}`, targetUserId);
        }
        if (finalHostUserId) {
            try {
                await prisma.liveStreamAdmin.upsert({
                    where: {
                        hostUserId_adminUserId: {
                            hostUserId: finalHostUserId,
                            adminUserId: targetUserId
                        }
                    },
                    create: { hostUserId: finalHostUserId, adminUserId: targetUserId },
                    update: {}
                });
            } catch (err) { }
        }
        resultStatus = true;
    }

    if (redisClient.isOpen && streamId) {
        try {
            const keys = await redisClient.keys(`stream:viewers_sorted:${streamId}:*`);
            if (keys && keys.length > 0) {
                await redisClient.del(keys);
            }
        } catch (err) {
            console.error("[Promote/Demote Admin Cache Clear Error]:", err.message);
        }
    }

    return resultStatus;
};

export const getStreamAdminsService = async ({ streamId, hostUserId = null }) => {
    let finalHostUserId = hostUserId;
    if (!finalHostUserId && streamId) {
        const stream = await getLiveStreamService({ id: streamId });
        if (stream) finalHostUserId = stream.userId;
    }

    const adminSet = new Set();
    if (redisClient.isOpen) {
        if (streamId) {
            const streamAdmins = await redisClient.sMembers(`stream:admins:${streamId}`);
            streamAdmins.forEach(id => adminSet.add(id));
        }
        if (finalHostUserId) {
            const hostAdmins = await redisClient.sMembers(`host:admins:${finalHostUserId}`);
            hostAdmins.forEach(id => adminSet.add(id));
        }
    }

    if (finalHostUserId) {
        try {
            const dbAdmins = await prisma.liveStreamAdmin.findMany({
                where: { hostUserId: finalHostUserId },
                select: { adminUserId: true }
            });
            dbAdmins.forEach(a => adminSet.add(a.adminUserId));
            if (redisClient.isOpen && dbAdmins.length > 0) {
                await redisClient.sAdd(`host:admins:${finalHostUserId}`, dbAdmins.map(a => a.adminUserId));
            }
        } catch (err) { }
    }

    return Array.from(adminSet);
};

export const kickUserService = async ({ streamId, targetUserId, hostUserId = null }) => {
    await redisClient.set(`stream:kicked:${streamId}:${targetUserId}`, "1", { EX: 600 });
    await redisClient.sRem(`stream:active:${streamId}`, targetUserId);
    await redisClient.sRem(`stream:admins:${streamId}`, targetUserId);
};

export const isUserKickedService = async ({ streamId, userId }) => {
    const isKicked = await redisClient.get(`stream:kicked:${streamId}:${userId}`);
    if (!isKicked) return null;
    const ttl = await redisClient.ttl(`stream:kicked:${streamId}:${userId}`);
    return ttl > 0 ? ttl : 0;
};

export const setStreamPasswordService = async ({ streamId, password }) => {
    if (!password) {
        await redisClient.del(`stream:password:${streamId}`);
    } else {
        await redisClient.set(`stream:password:${streamId}`, password);
    }
};

export const getStreamPasswordService = async ({ streamId }) => {
    return await redisClient.get(`stream:password:${streamId}`);
};

export const setMicPermissionService = async ({ streamId, micPermissionRequired }) => {
    const isRequired = micPermissionRequired !== false && micPermissionRequired !== "false";
    try {
        await prisma.liveStream.update({
            where: { streamId },
            data: { micPermissionRequired: isRequired }
        });
    } catch (err) {
        // Fallback to Redis if column does not exist in DB schema
    }
    await redisClient.set(`stream:mic_permission:${streamId}`, isRequired ? "1" : "0");
    return isRequired;
};

export const getMicPermissionService = async ({ streamId }) => {
    const cached = await redisClient.get(`stream:mic_permission:${streamId}`);
    if (cached !== null) {
        return cached === "1";
    }
    let isRequired = true;
    try {
        const stream = await prisma.liveStream.findUnique({
            where: { streamId },
            select: { micPermissionRequired: true }
        });
        if (stream && stream.micPermissionRequired !== undefined) {
            isRequired = stream.micPermissionRequired;
        }
    } catch (err) {
        // Fallback default
    }
    await redisClient.set(`stream:mic_permission:${streamId}`, isRequired ? "1" : "0");
    return isRequired;
};

export const setChatPermissionService = async ({ streamId, mode }) => {
    const validModes = ["EVERYONE", "ALL_MUTED", "FOLLOWERS_ONLY", "ADMINS_ONLY"];
    const targetMode = validModes.includes(mode) ? mode : "EVERYONE";

    try {
        await prisma.liveStream.update({
            where: { streamId },
            data: { chatPermissionMode: targetMode }
        });
    } catch (err) {
        // Fallback to Redis if column does not exist in DB schema
    }
    await redisClient.set(`stream:chat_permission:${streamId}`, targetMode);
    return targetMode;
};

export const getChatPermissionService = async ({ streamId }) => {
    const cached = await redisClient.get(`stream:chat_permission:${streamId}`);
    if (cached !== null) {
        return cached;
    }
    let mode = "EVERYONE";
    try {
        const stream = await prisma.liveStream.findUnique({
            where: { streamId },
            select: { chatPermissionMode: true }
        });
        if (stream && stream.chatPermissionMode) {
            mode = stream.chatPermissionMode;
        }
    } catch (err) {
        // Fallback default
    }
    await redisClient.set(`stream:chat_permission:${streamId}`, mode);
    return mode;
};

export const addUserToSheetService = async ({ streamId, userId, username }) => {
    const isAudioRestricted = await isUserRestrictedFast(userId, 'LIVE_AUDIO_MUTE');
    await redisClient.hSet(`stream:sheet:${streamId}`, userId, JSON.stringify({
        userId,
        username,
        isMuted: Boolean(isAudioRestricted),
        mutedByHost: Boolean(isAudioRestricted)
    }));
};

export const removeUserFromSheetService = async ({ streamId, userId }) => {
    await redisClient.hDel(`stream:sheet:${streamId}`, userId);
};

export const toggleUserSheetMuteService = async ({ streamId, userId, muteState, mutedByHost }) => {
    const rawUser = await redisClient.hGet(`stream:sheet:${streamId}`, userId);
    if (rawUser) {
        const userObj = JSON.parse(rawUser);
        userObj.isMuted = muteState;
        if (mutedByHost !== undefined) {
            userObj.mutedByHost = mutedByHost;
            if (mutedByHost) {
                userObj.mutedUntil = Date.now() + 30 * 60 * 1000; // 30 minutes
            } else {
                userObj.mutedUntil = null;
            }
        }
        await redisClient.hSet(`stream:sheet:${streamId}`, userId, JSON.stringify(userObj));
        return userObj;
    }
    return null;
};

export const getSheetUsersService = async ({ streamId }) => {
    const rawData = await redisClient.hGetAll(`stream:sheet:${streamId}`);
    if (!rawData) return [];
    const now = Date.now();
    const users = [];
    for (const val of Object.values(rawData)) {
        const userObj = JSON.parse(val);
        if (userObj.mutedByHost && userObj.mutedUntil && now >= userObj.mutedUntil) {
            userObj.mutedByHost = false;
            userObj.isMuted = false;
            userObj.mutedUntil = null;
            await redisClient.hSet(`stream:sheet:${streamId}`, userObj.userId, JSON.stringify(userObj));
        }
        users.push(userObj);
    }
    return users;
};

export const handleCameraStateChangeService = async ({ streamId, isCameraOn }) => {
    if (!redisClient.isOpen || !streamId) return;
    const keyOff = `stream:camera_off_at:${streamId}`;
    const keyUncounted = `stream:uncounted_seconds:${streamId}`;

    if (!isCameraOn) {
        const existing = await redisClient.get(keyOff);
        if (!existing) {
            await redisClient.set(keyOff, Date.now().toString());
            console.log(`[CameraState] Camera turned OFF for stream ${streamId}`);
        }
    } else {
        const cameraOffAtStr = await redisClient.get(keyOff);
        if (cameraOffAtStr) {
            const offMs = Date.now() - Number(cameraOffAtStr);
            const offSec = Math.floor(offMs / 1000);
            if (offSec > 60) {
                const excessSec = offSec - 60;
                await redisClient.incrBy(keyUncounted, excessSec);
                console.log(`[CameraState] Camera turned ON for stream ${streamId}. Off: ${offSec}s, Excess uncounted: ${excessSec}s`);
            } else {
                console.log(`[CameraState] Camera turned ON for stream ${streamId}. Off: ${offSec}s (Within 60s grace period)`);
            }
            await redisClient.del(keyOff);
        }
    }
};

const ensureActiveGalleryCached = async (year, month) => {
    const galleryLoadedKey = `gift_gallery:loaded:${year}:${month}`;
    const galleryCacheKey = `gift_gallery:active:${year}:${month}`;
    const giftIdsKey = `gift_gallery:gift_ids:${year}:${month}`;

    const isLoaded = await redisClient.exists(galleryLoadedKey);
    const hasGiftIds = await redisClient.exists(giftIdsKey);

    if (!isLoaded || !hasGiftIds) {
        const gallery = await prisma.giftGallery.findFirst({
            where: {
                year: year,
                month: month
            },
            include: {
                sections: {
                    where: { is_active: true },
                    include: {
                        gifts: {
                            include: {
                                gift: true
                            }
                        }
                    }
                }
            }
        });

        const galleryItems = [];
        if (gallery) {
            for (const section of gallery.sections) {
                for (const item of section.gifts) {
                    if (item.gift && item.gift.isActive) {
                        galleryItems.push({
                            id: item.id,
                            giftId: item.gift.id,
                            name: item.gift.name,
                            displayImageUrl: item.gift.displayImageUrl,
                            coinCost: Number(item.gift.coinCost)
                        });
                    }
                }
            }
        }

        if (galleryItems.length > 0) {
            const giftIds = galleryItems.map(item => item.giftId);
            await redisClient.del(giftIdsKey);
            await redisClient.sAdd(giftIdsKey, giftIds);
            await redisClient.expire(giftIdsKey, 86400); // 1 day
            await redisClient.set(galleryCacheKey, JSON.stringify(galleryItems), 'EX', 86400);
        } else {
            await redisClient.set(galleryCacheKey, JSON.stringify([]), 'EX', 300); // 5 min cache for empty
        }
        await redisClient.set(galleryLoadedKey, "1", 'EX', 86400);
    }
};

const ensureHostProgressCached = async (hostId, year, month) => {
    const progressLoadedKey = `host_gallery_progress:loaded:${hostId}:${year}:${month}`;
    const progressCacheKey = `host_gallery_progress:${hostId}:${year}:${month}`;

    const isLoaded = await redisClient.exists(progressLoadedKey);
    if (!isLoaded) {
        const progressRecords = await prisma.giftGalleryProgress.findMany({
            where: {
                hostUserId: hostId,
                gallery: {
                    year: year,
                    month: month
                }
            },
            select: {
                giftId: true
            }
        });

        const collectedGiftIds = progressRecords.map(r => r.giftId);
        if (collectedGiftIds.length > 0) {
            await redisClient.sAdd(progressCacheKey, collectedGiftIds);
            await redisClient.expire(progressCacheKey, 604800); // 7 days
        }
        await redisClient.set(progressLoadedKey, "1", 'EX', 604800);
    }
};

const processGiftGalleryProgress = async (giftId, receiverId, senderId) => {
    try {
        const currentDate = new Date();
        const currentYear = currentDate.getFullYear();
        const currentMonth = currentDate.getMonth() + 1;

        await ensureActiveGalleryCached(currentYear, currentMonth);
        await ensureHostProgressCached(receiverId, currentYear, currentMonth);

        if (redisClient.isOpen) {
            const giftIdsKey = `gift_gallery:gift_ids:${currentYear}:${currentMonth}`;
            const progressCacheKey = `host_gallery_progress:${receiverId}:${currentYear}:${currentMonth}`;

            const isGalleryGift = await redisClient.sIsMember(giftIdsKey, giftId);
            if (isGalleryGift) {
                await redisClient.sAdd(progressCacheKey, giftId);
                await redisClient.expire(progressCacheKey, 604800);

                // DB Persistence for GiftGalleryProgress
                try {
                    const gallery = await prisma.giftGallery.findFirst({
                        where: { year: currentYear, month: currentMonth },
                        include: {
                            sections: {
                                where: { is_active: true },
                                include: {
                                    gifts: {
                                        where: { giftId: giftId }
                                    }
                                }
                            }
                        }
                    });

                    if (gallery) {
                        for (const sec of gallery.sections) {
                            for (const item of sec.gifts) {
                                await prisma.giftGalleryProgress.upsert({
                                    where: {
                                        hostUserId_giftGallerySectionItemId: {
                                            hostUserId: receiverId,
                                            giftGallerySectionItemId: item.id
                                        }
                                    },
                                    create: {
                                        galleryId: gallery.id,
                                        hostUserId: receiverId,
                                        giftId: giftId,
                                        giftGallerySectionItemId: item.id,
                                        firstGifterId: senderId
                                    },
                                    update: {}
                                }).catch(() => { });
                            }
                        }
                    }
                } catch (dbErr) {
                    console.error("[GiftGallery DB] Error upserting progress:", dbErr.message);
                }
            }
            return await getGiftGalleryTargetsService(receiverId);
        }
    } catch (gErr) {
        console.error("[GiftGallery] Error computing gallery progress:", gErr.message);
    }
    return null;
};

export const getGiftGalleryTargetsService = async (hostId) => {
    const currentDate = new Date();
    const currentYear = currentDate.getFullYear();
    const currentMonth = currentDate.getMonth() + 1;

    await ensureActiveGalleryCached(currentYear, currentMonth);
    await ensureHostProgressCached(hostId, currentYear, currentMonth);

    const galleryCacheKey = `gift_gallery:active:${currentYear}:${currentMonth}`;
    const progressCacheKey = `host_gallery_progress:${hostId}:${currentYear}:${currentMonth}`;

    const galleryItems = JSON.parse(await redisClient.get(galleryCacheKey) || '[]');
    const collectedGiftIds = await redisClient.sMembers(progressCacheKey);
    const collectedSet = new Set(collectedGiftIds);

    const resultGifts = galleryItems.map(item => ({
        ...item,
        isReceived: collectedSet.has(item.giftId)
    }));

    const totalTarget = resultGifts.length;
    const currentProgress = resultGifts.filter(g => g.isReceived).length;

    return {
        year: currentYear,
        month: currentMonth,
        totalTarget,
        currentProgress,
        gifts: resultGifts
    };
};export const getGiftInfoService = async ({ giftId }) => {
    if (!giftId) return null;
    const cacheKey = `gift:info:${giftId}`;
    if (redisClient.isOpen) {
        const cached = await redisClient.get(cacheKey);
        if (cached) {
            try {
                const parsed = JSON.parse(cached);
                if (parsed && (parsed.category !== undefined || parsed.gift_categories !== undefined)) {
                    return parsed;
                }
            } catch (e) { }
        }
    }
    const gift = await prisma.gift.findUnique({
        where: { id: giftId },
        include: {
            category: {
                select: { id: true, name: true, slug: true }
            }
        }
    });
    if (gift && redisClient.isOpen) {
        await redisClient.set(cacheKey, JSON.stringify(gift), "EX", 86400);
    }
    return gift;
};

export const sendStreamGiftService = async ({ streamDbId, senderId, giftId, targetUserId, count = 1 }) => {
    await checkCoinsFrozenFast(senderId);

    const stream = await getLiveStreamService({ id: streamDbId });
    if (!stream) {
        throw new Error("Live stream not found.");
    }
    if (stream.endedAt !== null) {
        throw new Error("Live stream has already ended.");
    }

    const receiverUserId = targetUserId || stream.userId;

    const [gift, senderPrivacy, receiverPrivacy] = await Promise.all([
        getGiftInfoService({ giftId }),
        getUserPrivacyService({ userId: senderId }),
        getUserPrivacyService({ userId: receiverUserId })
    ]);

    if (!gift || !gift.isActive) {
        throw new Error("Gift not found or is inactive.");
    }

    const giftCount = Math.max(1, Math.min(1000, Number(count || 1)));
    const coinCost = BigInt(gift.coinCost) * BigInt(giftCount);
    const pointsAwarded = (coinCost * 60n) / 100n;
    const receiverId = receiverUserId;

    const isStealth = senderPrivacy.isStealth;

    const senderPublicId = isStealth ? null : (senderPrivacy?.publicId || null);
    const receiverPublicId = receiverPrivacy ? (receiverPrivacy?.publicId || null) : null;

    let stealthAlias = null;
    if (isStealth) {
        stealthAlias = await getOrCreateSessionAlias(stream.streamId, senderId);
    }
    const senderName = isStealth ? (stealthAlias || "Mystery Gifter") : (senderPrivacy.name || senderPrivacy.username || "User");
    const receiverName = receiverPrivacy ? (receiverPrivacy.name || receiverPrivacy.username || "Host") : "Host";

    const isCategoryLucky = gift.category?.name?.toLowerCase() === "lucky";

    if (gift.isLucky || gift.effectLuckyGift || isCategoryLucky) {
        const luckyResult = await sendLuckyGiftService({
            senderId,
            receiverId,
            streamId: stream.streamId,
            giftId,
            comboCount: giftCount,
            preFetchedGift: gift
        });
        luckyResult.socketPayload.senderName = senderName;
        luckyResult.socketPayload.senderPublicId = isStealth ? null : senderPublicId;
        luckyResult.socketPayload.senderAvatarUrl = isStealth ? null : (senderPrivacy.avatarUrl || null);
        luckyResult.socketPayload.receiverName = receiverName;
        luckyResult.socketPayload.receiverPublicId = receiverPublicId;
        luckyResult.socketPayload.targetUserPublicId = receiverPublicId;
        luckyResult.socketPayload.isMystery = isStealth;
        if (isStealth) luckyResult.socketPayload.senderId = null;

        const galleryProgressUpdate = await processGiftGalleryProgress(gift.id, receiverId, senderId);
        if (galleryProgressUpdate) {
            luckyResult.galleryProgress = galleryProgressUpdate;
            luckyResult.socketPayload.galleryProgress = galleryProgressUpdate;
        }

        return luckyResult;
    }

    const walletKey = `wallet:coins:${senderId}`;
    let senderCoinsStr = redisClient.isOpen ? await redisClient.get(walletKey) : null;
    let senderCoins;

    if (senderCoinsStr === null) {
        let senderWallet = await prisma.wallet.findUnique({
            where: { userId_currencyType: { userId: senderId, currencyType: WalletCurrencyType.COIN } }
        });
        if (!senderWallet) {
            senderWallet = await getOrCreateWallet(senderId, WalletCurrencyType.COIN);
        }
        senderCoins = await getFastCoinBalance(senderWallet.id);
    } else {
        senderCoins = BigInt(senderCoinsStr);
    }

    if (senderCoins < coinCost) {
        throw new Error("Insufficient coins to send this gift.");
    }

    const balanceAfterCoins = senderCoins - coinCost;
    if (redisClient.isOpen) {
        await redisClient.set(walletKey, balanceAfterCoins.toString(), "EX", 3600);
    }

    const receiverPointsKey = `wallet:points:${receiverId}`;
    let currentReceiverPointsStr = redisClient.isOpen ? await redisClient.get(receiverPointsKey) : null;
    let currentReceiverPoints;

    if (currentReceiverPointsStr === null) {
        const receiverWallet = await getOrCreateWallet(receiverId, WalletCurrencyType.POINT);
        currentReceiverPoints = await getFastPointBalance(receiverWallet.id);
    } else {
        currentReceiverPoints = BigInt(currentReceiverPointsStr);
    }

    const balanceAfterPoints = currentReceiverPoints + pointsAwarded;
    if (redisClient.isOpen) {
        await redisClient.set(receiverPointsKey, balanceAfterPoints.toString(), "EX", 3600);
        // Level XP Cache Invalidation for sender wealth level & receiver stream level
        redisClient.del(`level:wealth:${senderId}`).catch(() => { });
        redisClient.del(`level:stream:${receiverId}`).catch(() => { });
    }

    // Synchronous Gift Gallery Progress check for Receiver (Host)
    const galleryProgressUpdate = await processGiftGalleryProgress(gift.id, receiverId, senderId);

    const senderLevel = await prisma.walletUserLevel.findUnique({
        where: {
            userId_levelType: {
                userId: senderId,
                levelType: LevelType.WEALTH
            }
        },
        select: { currentLevel: true }
    });
    const initialWealthLevel = senderLevel?.currentLevel || 1;

    const socketPayload = {
        success: true,
        streamId: stream.streamId,
        senderId: isStealth ? null : senderId,
        senderPublicId: isStealth ? null : senderPublicId,
        senderName,
        senderAvatarUrl: isStealth ? null : (senderPrivacy.avatarUrl || null),
        isMystery: isStealth,
        senderRemainingCoins: Number(balanceAfterCoins),
        receiverId,
        receiverPublicId: receiverPublicId,
        receiverName,
        pointsAwarded: Number(pointsAwarded),
        receiverTotalPoints: Number(balanceAfterPoints),
        targetUserId: targetUserId || null,
        targetUserPublicId: receiverPublicId,
        targetUserName: receiverName,
        count: giftCount,
        totalCost: Number(coinCost),
        gift: {
            id: gift.id,
            name: gift.name,
            displayImageUrl: gift.displayImageUrl,
            effectUrl: gift.effectUrl,
            coinCost: Number(gift.coinCost)
        },
        wealthLevel: isStealth ? 0 : initialWealthLevel,
        isLevelUp: false,
        galleryProgress: galleryProgressUpdate,
        galleryProgressUpdate: galleryProgressUpdate
    };

    setImmediate(async () => {
        try {
            console.log(`[Gift Background DB Sync] Starting DB sync for stream: ${streamDbId}`);
            const userLevel = await prisma.walletUserLevel.findUnique({
                where: {
                    userId_levelType: {
                        userId: senderId,
                        levelType: LevelType.WEALTH
                    }
                }
            });

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

            socketPayload.wealthLevel = isStealth ? 0 : finalLevel;
            socketPayload.isLevelUp = isLevelUp;



            const senderWallet = await getOrCreateWallet(senderId, WalletCurrencyType.COIN);
            const receiverWallet = await getOrCreateWallet(receiverId, WalletCurrencyType.POINT);

            let txAgencyUserId = null;
            const giftTransactionId = crypto.randomUUID();
            await prisma.$transaction(async (tx) => {
                await tx.$queryRawUnsafe(`SELECT 1 FROM wallets WHERE id = '${senderWallet.id}' FOR UPDATE`);

                const receiverPoints = await getFastPointBalance(receiverWallet.id, tx);
                const balanceAfterPointsCalculated = receiverPoints + pointsAwarded;

                const [hostLedger] = await Promise.all([
                    tx.pointLedgerEntry.create({
                        data: {
                            walletId: receiverWallet.id,
                            direction: LedgerDirection.CREDIT,
                            txType: PointTxType.GIFT_RECEIVE,
                            amount: pointsAwarded,
                            balanceAfter: balanceAfterPointsCalculated,
                            idempotencyKey: `gift-stream-${streamDbId}-${Date.now()}-points`,
                            refId: giftTransactionId,
                            counterpartyId: senderId,
                            description: `Received gift ${gift.name} in live stream`,
                            metadata: {
                                giftId: gift.id,
                                giftName: gift.name,
                                context: "live_stream",
                                quantity: giftCount,
                                unitCoinCost: Number(gift.coinCost),
                                giftTransactionId
                            }
                        }
                    }),
                    tx.giftTransaction.create({
                        data: {
                            id: giftTransactionId,
                            senderUserId: senderId,
                            receiverUserId: receiverId,
                            giftId: gift.id,
                            coinCost: gift.coinCost,
                            quantity: giftCount,
                            pointsAwarded: Number(pointsAwarded),
                            context: "live_stream"
                        }
                    }),
                    tx.coinLedgerEntry.create({
                        data: {
                            walletId: senderWallet.id,
                            direction: LedgerDirection.DEBIT,
                            txType: CoinTxType.GIFT_SEND,
                            amount: coinCost,
                            balanceAfter: balanceAfterCoins,
                            idempotencyKey: `gift-stream-${streamDbId}-${Date.now()}-coins`,
                            refId: giftTransactionId,
                            counterpartyId: receiverId,
                            description: `Sent gift ${gift.name} in live stream`,
                            metadata: {
                                giftId: gift.id,
                                giftTransactionId,
                                context: "live_stream",
                                quantity: giftCount
                            }
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

                await updateUserLevel(tx, receiverId, LevelType.LIVESTREAM, pointsAwarded);

                const commRes = await processLiveStreamAgencyCommission(
                    tx,
                    receiverId,
                    pointsAwarded,
                    hostLedger.id,
                    null,
                    {
                        businessRefId: giftTransactionId,
                        hostTxType: PointTxType.GIFT_RECEIVE,
                        gift,
                        context: "live_stream",
                        quantity: giftCount,
                        unitCoinCost: Number(gift.coinCost)
                    }
                );
                if (commRes && commRes.agencyUserId) {
                    txAgencyUserId = commRes.agencyUserId;
                }
            }, { maxWait: 10000, timeout: 15000 });

            if (txAgencyUserId) {
                await afterCommissionCreditCommit(txAgencyUserId);
            }
            if (redisClient.isOpen) {
                const keys = await redisClient.keys(`stream:viewers_sorted:${stream.streamId}:*`);
                if (keys && keys.length > 0) {
                    await redisClient.del(keys);
                }
            }
            console.log(`[Gift Background DB Sync] Successfully synced to DB for stream: ${streamDbId}`);
        } catch (dbErr) {
            console.error(`[Gift Background DB Sync] Async sync error:`, dbErr.message);
        }
    });

    return {
        socketPayload,
        galleryProgress: galleryProgressUpdate,
        galleryProgressUpdate: galleryProgressUpdate,
        newBalance: Number(balanceAfterCoins),
        currentLevel: initialWealthLevel,
        isLevelUp: false
    };
};

export const followUserService = async ({ followerId, followingId }) => {
    if (followerId === followingId) {
        throw new Error("You cannot follow yourself.");
    }

    const targetUser = await prisma.user.findUnique({
        where: { id: followingId },
        select: { id: true, username: true }
    });
    if (!targetUser) {
        throw new Error("Target user not found.");
    }

    const followerUser = await prisma.user.findUnique({
        where: { id: followerId },
        select: { id: true, username: true }
    });
    if (!followerUser) {
        throw new Error("Follower user not found.");
    }

    const existing = await prisma.userFollow.findUnique({
        where: {
            followerId_followingId: {
                followerId,
                followingId
            }
        }
    });

    if (!existing) {
        await prisma.userFollow.create({
            data: {
                followerId,
                followingId
            }
        });
    }

    return {
        followerId,
        followerName: followerUser.username,
        followingId,
        followingName: targetUser.username
    };
};

export const unfollowUserService = async ({ followerId, followingId }) => {
    await prisma.userFollow.deleteMany({
        where: {
            followerId,
            followingId
        }
    });

    return { success: true };
};

export const checkFollowStatusService = async ({ followerId, followingId }) => {
    const existing = await prisma.userFollow.findUnique({
        where: {
            followerId_followingId: {
                followerId,
                followingId
            }
        }
    });

    return { isFollowing: !!existing };
};

export const getAgencyCommissionRatesService = async () => {
    const cacheKey = "agency:commission_rates";
    if (redisClient.isOpen) {
        const cached = await redisClient.get(cacheKey);
        if (cached) {
            try { return JSON.parse(cached); } catch (e) { }
        }
    }

    const levels = await prisma.agencyCommissionLevel.findMany();
    const ratesMap = {};
    for (const cl of levels) {
        if (cl.level) {
            ratesMap[cl.level.trim()] = cl.liveRateBp || 400;
        }
    }
    if (!ratesMap['D']) ratesMap['D'] = 400;

    if (redisClient.isOpen) {
        await redisClient.set(cacheKey, JSON.stringify(ratesMap), "EX", 86400);
    }
    return ratesMap;
};

export const invalidateAgencyCommissionRatesCache = async () => {
    if (redisClient.isOpen) {
        await redisClient.del("agency:commission_rates");
    }
};

export const processLiveStreamAgencyCommission = async (tx, receiverId, hostPoints, hostLedgerEntryId, cachedReceiverUser = null, opts = {}) => {
    let agencyUserId = cachedReceiverUser?.currentAgencyId;

    const getHostDisplayName = (u) => {
        if (!u) return null;
        const fullName = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
        return fullName || u.firstName || u.username || null;
    };

    let hostName = getHostDisplayName(cachedReceiverUser);

    if (!agencyUserId || !hostName) {
        const receiverUser = await tx.user.findUnique({
            where: { id: receiverId },
            select: { currentAgencyId: true, username: true, firstName: true, lastName: true }
        });
        if (receiverUser) {
            if (!agencyUserId && receiverUser.currentAgencyId) {
                agencyUserId = receiverUser.currentAgencyId;
            }
            if (!hostName) {
                hostName = getHostDisplayName(receiverUser);
            }
        }
    }
    if (!hostName) hostName = "Host";

    if (!agencyUserId) {
        const selfAgency = await tx.agency.findUnique({
            where: { userId: receiverId },
            select: { userId: true }
        });
        if (selfAgency) {
            agencyUserId = receiverId;
        }
    }

    if (!agencyUserId) return null;

    const agency = await tx.agency.findUnique({
        where: { userId: agencyUserId },
        select: { currentLevel: true }
    });
    if (!agency) return null;

    const levelKey = agency.currentLevel ? agency.currentLevel.trim() : 'D';
    const ratesMap = await getAgencyCommissionRatesService();
    const rateBp = ratesMap[levelKey] || 400;
    const commissionPoints = BigInt(Math.floor((Number(hostPoints) * rateBp) / 10000));

    // Same transaction as the gift: /commission/me totals join these rows.
    try {
        await tx.agencyCommissionProcessed.create({
            data: { hostLedgerEntryId }
        });
    } catch (e) {
        if (e?.code !== 'P2002') throw e;
    }

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    await tx.agencyDailyEarning.upsert({
        where: {
            agencyUserId_hostUserId_day: {
                agencyUserId,
                hostUserId: receiverId,
                day: today
            }
        },
        update: {
            hostEarningsPoints: { increment: hostPoints },
            hostCommissionPoints: { increment: commissionPoints }
        },
        create: {
            agencyUserId,
            hostUserId: receiverId,
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

        const businessRefId = opts.businessRefId || hostLedgerEntryId;
        const hostTxType = opts.hostTxType || PointTxType.GIFT_RECEIVE;
        const giftName = opts.gift?.name;
        agentLedgerEntry = await tx.pointLedgerEntry.create({
            data: {
                walletId: agentWallet.id,
                direction: LedgerDirection.CREDIT,
                txType: PointTxType.AGENT_COMMISSION,
                amount: commissionPoints,
                balanceAfter,
                idempotencyKey: `agency-commission-${hostLedgerEntryId}`,
                refId: businessRefId,
                counterpartyId: receiverId,
                description: giftName
                    ? `Agency commission: ${giftName}`
                    : `Commission earned from host ${hostName} in live stream`,
                metadata: {
                    category: "LIVE",
                    hostTxType,
                    hostLedgerEntryId,
                    ...(opts.gift?.id ? { giftId: opts.gift.id } : {}),
                    ...(giftName ? { giftName } : {}),
                    ...(opts.context ? { context: opts.context } : {}),
                    ...(opts.quantity != null ? { quantity: opts.quantity } : {}),
                    ...(opts.unitCoinCost != null ? { unitCoinCost: opts.unitCoinCost } : {})
                }
            }
        });

        // Tier / window total: do NOT mutate currentLevel here (ol-node parity).
        // After the gift tx commits, callers run afterCommissionCreditCommit which
        // recomputes from host earnings + admin tier lock floor.
    }

    return { agencyUserId, commissionPoints, agentLedgerEntry };
};

export const sendGlobalMessageService = async ({ senderId, message, streamId = null }) => {
    await checkCoinsFrozenFast(senderId);

    if (!message || message.trim() === "") {
        throw new Error("Message content cannot be empty.");
    }

    const cost = 10000n;

    // 1. Fetch sender info and wealth level
    const [senderUser, userLevel] = await Promise.all([
        prisma.user.findUnique({
            where: { id: senderId },
            select: { username: true, firstName: true, lastName: true, avatarUrl: true }
        }),
        prisma.walletUserLevel.findUnique({
            where: {
                userId_levelType: {
                    userId: senderId,
                    levelType: LevelType.WEALTH
                }
            },
            select: { currentLevel: true }
        })
    ]);

    if (!senderUser) {
        throw new Error("Sender user not found.");
    }

    const walletKey = `wallet:coins:${senderId}`;
    let senderCoinsStr = await redisClient.get(walletKey);
    let senderCoins;

    let senderWallet = await prisma.wallet.findUnique({
        where: { userId_currencyType: { userId: senderId, currencyType: WalletCurrencyType.COIN } }
    });
    if (!senderWallet) {
        senderWallet = await getOrCreateWallet(senderId, WalletCurrencyType.COIN);
    }

    const dbCoins = await getFastCoinBalance(senderWallet.id);
    if (senderCoinsStr === null) {
        senderCoins = dbCoins;
    } else {
        senderCoins = BigInt(senderCoinsStr);
        if (dbCoins > senderCoins) {
            senderCoins = dbCoins;
        }
    }

    if (senderCoins < cost) {
        throw new Error("Insufficient coins to send a global message.");
    }

    const balanceAfterCoins = senderCoins - cost;
    await redisClient.set(walletKey, balanceAfterCoins.toString(), "EX", 3600);

    setImmediate(async () => {
        try {
            await prisma.$transaction(async (tx) => {
                await tx.$queryRawUnsafe(`SELECT 1 FROM wallets WHERE id = '${senderWallet.id}' FOR UPDATE`);

                const freshCoins = await getFastCoinBalance(senderWallet.id, tx);
                const dbBalanceAfter = freshCoins - cost;

                await tx.coinLedgerEntry.create({
                    data: {
                        walletId: senderWallet.id,
                        direction: LedgerDirection.DEBIT,
                        txType: CoinTxType.GLOBAL_MESSAGE || "GLOBAL_MESSAGE",
                        amount: cost,
                        balanceAfter: dbBalanceAfter,
                        idempotencyKey: `global-msg-${senderId}-${Date.now()}`,
                        description: `Sent global message: "${message.substring(0, 30)}..."`
                    }
                });

                await tx.wallet.update({
                    where: { id: senderWallet.id },
                    data: { version: { increment: 1n } }
                });

                await updateUserLevel(tx, senderId, LevelType.WEALTH, cost);
            }, { maxWait: 10000, timeout: 15000 });

        } catch (dbErr) {
            console.error(`[Global Message DB Sync] Critical Failure during async sync:`, dbErr);
            redisClient.del(walletKey).catch(err => console.error(err));
        }
    });

    return {
        newBalance: Number(balanceAfterCoins),
        socketPayload: {
            senderId,
            senderName: `${senderUser.firstName || ""} ${senderUser.lastName || ""}`.trim() || senderUser.username || "User",
            senderProfilePic: senderUser.avatarUrl || null,
            wealthLevel: Boolean(senderUser?.privacyMysteryLive && senderUser?.vipSubscriptionActive) ? 0 : (userLevel?.currentLevel || 1),
            message,
            streamId: streamId || null,
            timestamp: new Date().toISOString()
        }
    };
};

export const verifyStreamFrameService = async ({ id, base64Image }) => {
    const stream = await prisma.liveStream.findUnique({
        where: { id }
    });

    if (!stream) {
        throw new Error("Live stream not found.");
    }

    if (!stream.isLive) {
        return { success: true, status: "INACTIVE", message: "Stream is not currently live." };
    }

    const base64Data = base64Image.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(base64Data, "base64");

    const check = await moderateImage(buffer);

    if (check.isViolation) {
        console.warn(`[Stream Moderation] Nudity/Explicit content detected in stream ${id}. Action: ${check.action}, Label: ${check.label} (Confidence: ${check.confidence}%)`);

        // 1. Upload flagged frame to S3
        let s3Key = null;
        let s3Bucket = null;
        try {
            s3Key = `live-stream-moderation/${id}_${Date.now()}.jpg`;
            const uploadResult = await uploadFlaggedFrameToS3(buffer, s3Key);
            s3Bucket = uploadResult.bucket;
        } catch (s3Err) {
            console.error(`[Stream Moderation] Failed to upload flagged frame to S3 for stream ${id}:`, s3Err);
        }

        // 2. Save log record in DB via Prisma
        try {
            await prisma.liveStreamModerationLog.create({
                data: {
                    streamId: id,
                    detectedLabel: check.label,
                    confidence: check.confidence,
                    action: check.action,
                    s3Key,
                    s3Bucket
                }
            });
            console.log(`[Stream Moderation] Saved log entry in DB for stream ${id}`);
        } catch (dbErr) {
            console.error(`[Stream Moderation] Failed to save log entry in DB for stream ${id}:`, dbErr);
        }

        if (check.action === "BLOCK") {
            // End the stream immediately
            console.log(`[Stream Moderation] Blocking stream ${id} due to explicit content violation.`);

            // 3. Mark stream as not live in DB (include billable duration)
            const endedAt = new Date();
            const startedAt = stream.startedAt || stream.createdAt || endedAt;
            const grossDurationSeconds = Math.max(
                0,
                Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000),
            );
            let uncountedSec = 0;
            if (redisClient.isOpen) {
                const uncountedStr = await redisClient.get(`stream:uncounted_seconds:${stream.streamId}`);
                if (uncountedStr) uncountedSec = parseInt(uncountedStr, 10) || 0;
            }
            const effectiveDurationSeconds = Math.max(0, grossDurationSeconds - uncountedSec);

            const updatedStream = await prisma.liveStream.update({
                where: { id },
                data: {
                    isLive: false,
                    endedAt,
                    effectiveDurationSeconds,
                }
            });

            // 4. Batch sync viewers/chats from Redis to PostgreSQL
            try {
                const viewerIds = await redisClient.sMembers(`stream:history:${stream.streamId}`);
                if (viewerIds && viewerIds.length > 0) {
                    const viewerData = viewerIds.map(vId => ({
                        streamId: stream.streamId,
                        userId: vId
                    }));
                    await prisma.streamViewer.createMany({
                        data: viewerData,
                        skipDuplicates: true
                    });
                }
            } catch (syncError) {
                console.error("[Stream Moderation Sync] Failed to sync viewers:", syncError.message);
            }

            try {
                const rawChats = await redisClient.lRange(`stream:chats:${stream.streamId}`, 0, -1);
                if (rawChats && rawChats.length > 0) {
                    const chatData = rawChats.map(c => {
                        const parsed = JSON.parse(c);
                        return {
                            id: parsed.id,
                            streamId: parsed.streamId,
                            senderId: parsed.senderId,
                            message: parsed.message,
                            createdAt: new Date(parsed.createdAt),
                            replyToMessageId: parsed.replyToMessageId || null,
                            replyToUserId: parsed.replyToUserId || null,
                            replyToUsername: parsed.replyToUsername || null,
                            replyToText: parsed.replyToText || null
                        };
                    });
                    await prisma.liveMessage.createMany({
                        data: chatData,
                        skipDuplicates: true
                    });
                }
            } catch (syncError) {
                console.error("[Stream Moderation Sync] Failed to sync chats:", syncError.message);
            }

            // 5. Clean Redis
            try {
                await redisClient.del([
                    `user:active_stream:${stream.userId}`,
                    `stream:info:${stream.streamId}`,
                    `stream:info:${id}`,
                    `stream:active:${stream.streamId}`,
                    `stream:history:${stream.streamId}`,
                    `stream:chats:${stream.streamId}`,
                    `stream:admins:${stream.streamId}`,
                    `stream:kicked:${stream.streamId}`,
                    `stream:password:${stream.streamId}`,
                    `stream:sheet:${stream.streamId}`
                ]);
            } catch (cleanError) {
                console.error("[Stream Moderation Clean] Failed to clear Redis keys:", cleanError.message);
            }

            // Calculate ban details and apply automatic ban punishment
            let banDurationHours = 1;
            let banNumber = 1;
            let suspendedUntil = new Date(Date.now() + 1 * 60 * 60 * 1000);
            try {
                const previousBans = await prisma.hostStreamBan.count({
                    where: { userId: stream.userId }
                });
                banNumber = previousBans + 1;
                if (banNumber === 1) {
                    banDurationHours = 1;
                } else if (banNumber === 2) {
                    banDurationHours = 8;
                } else if (banNumber === 3) {
                    banDurationHours = 24;
                } else {
                    banDurationHours = 72;
                }
                suspendedUntil = new Date(Date.now() + banDurationHours * 60 * 60 * 1000);

                await prisma.user.update({
                    where: { id: stream.userId },
                    data: { suspended_until: suspendedUntil }
                });

                if (redisClient.isOpen) {
                    const suspendedCacheKey = `user:suspended:${stream.userId}`;
                    const banCacheKey = `user:restriction:${stream.userId}:LIVE_STREAM_START_BAN`;
                    const ttlSeconds = Math.ceil(banDurationHours * 3600);

                    await Promise.all([
                        redisClient.set(suspendedCacheKey, "true", "EX", ttlSeconds),
                        redisClient.set(banCacheKey, JSON.stringify({
                            restrictionType: 'LIVE_STREAM_START_BAN',
                            reason: 'AI Moderation Nudity Violation',
                            restrictedUntil: suspendedUntil.toISOString()
                        }), "EX", ttlSeconds)
                    ]).catch(e => console.error("[Stream Moderation Cache] Redis set error:", e.message));
                }

                await prisma.hostStreamBan.create({
                    data: {
                        userId: stream.userId,
                        streamId: id,
                        banNumber,
                        banDuration: banDurationHours,
                        suspendedUntil
                    }
                });

                await prisma.userRestriction.create({
                    data: {
                        userId: stream.userId,
                        type: 'LIVE_STREAM_START_BAN',
                        reason: `AI Moderation Nudity Violation (Ban #${banNumber})`,
                        restrictedUntil: suspendedUntil,
                        createdByAdminId: '00000000-0000-0000-0000-000000000000'
                    }
                }).catch(e => console.error("[Stream Moderation DB] Restriction insert error:", e.message));

                console.log(`[Stream Moderation] Successfully applied ${banDurationHours} hour ban to user ${stream.userId} (Ban #${banNumber})`);
            } catch (banErr) {
                console.error("[Stream Moderation] Failed to calculate/apply automatic ban:", banErr);
            }

            // 6. Broadcast socket notification to the stream room that they are blocked
            broadcastToStream(stream.streamId, "stream_blocked", {
                streamId: id,
                reason: "VIOLATION_NUDITY",
                message: "This live stream has been terminated by moderation due to explicit content violation.",
                suspendedUntil: suspendedUntil.toISOString(),
                banDurationHours,
                banNumber
            });

            // 7. Close LiveKit Room
            await closeLivekitRoom(stream.streamId);

            return { status: "BLOCKED", label: check.label, banDurationHours, banNumber, suspendedUntil };
        } else if (check.action === "WARNING") {
            broadcastToStream(stream.streamId, "stream_warning", {
                streamId: id,
                message: `Moderation Warning: Inappropriate content detected. Please keep the stream appropriate.`,
                label: check.label,
                confidence: check.confidence
            });
            return { status: "WARNING", label: check.label, confidence: check.confidence };
        }
    }

    return { isViolation: false, status: "CLEAN" };
};

export const reportFakeLiveService = async ({ streamDbId, reporterId, base64Image, additionalInfo }) => {
    const stream = await prisma.liveStream.findUnique({
        where: { id: streamDbId }
    });

    if (!stream) {
        throw new Error("Live stream not found.");
    }

    if (!stream.isLive) {
        throw new Error("This live stream is not currently active.");
    }

    if (stream.userId === reporterId) {
        throw new Error("You cannot report your own live stream.");
    }

    if (!base64Image) {
        throw new Error("Screenshot image is required for this report.");
    }

    const base64Data = base64Image.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(base64Data, "base64");

    const s3Key = `live-reports/fake-person/${streamDbId}_${Date.now()}.jpg`;
    try {
        await uploadFlaggedFrameToS3(buffer, s3Key);
    } catch (s3Err) {
        console.error(`[Report Fake Live] Failed to upload evidence frame to S3 for stream ${streamDbId}:`, s3Err);
        throw new Error("Failed to upload evidence image. Please try again.");
    }

    const report = await prisma.messageReport.create({
        data: {
            reporterId,
            reportedUserId: stream.userId,
            host_user_id: stream.userId,
            live_session_id: stream.id,
            reason: "FAKE_ACCOUNT",
            context: "LIVE",
            additionalInfo: additionalInfo || "Fake person live reported during stream",
            evidenceS3Keys: [s3Key],
            status: "PENDING"
        }
    });

    return { success: true, reportId: report.id };
};

export const getUserEffectSettingsService = async (userId) => {
    const redisKey = `user:effect_settings:${userId}`;
    const cached = await redisClient.get(redisKey);
    if (cached) {
        return JSON.parse(cached);
    }

    let settings = await prisma.userSettings.findUnique({
        where: { userId },
        select: {
            effectTopRunway: true,
            effectGift: true,
            effectLuckyGift: true,
            effectEntry: true,
            effectGlobal: true
        }
    });

    if (!settings) {
        settings = await prisma.userSettings.create({
            data: {
                userId,
                effectTopRunway: true,
                effectGift: true,
                effectLuckyGift: true,
                effectEntry: true,
                effectGlobal: true
            },
            select: {
                effectTopRunway: true,
                effectGift: true,
                effectLuckyGift: true,
                effectEntry: true,
                effectGlobal: true
            }
        });
    }

    await redisClient.set(redisKey, JSON.stringify(settings), 'EX', 86400);
    return settings;
};

export const updateUserEffectSettingsService = async (userId, newSettings) => {
    const updateData = {};
    if (typeof newSettings.effectTopRunway === 'boolean') updateData.effectTopRunway = newSettings.effectTopRunway;
    if (typeof newSettings.effectGift === 'boolean') updateData.effectGift = newSettings.effectGift;
    if (typeof newSettings.effectLuckyGift === 'boolean') updateData.effectLuckyGift = newSettings.effectLuckyGift;
    if (typeof newSettings.effectEntry === 'boolean') updateData.effectEntry = newSettings.effectEntry;
    if (typeof newSettings.effectGlobal === 'boolean') updateData.effectGlobal = newSettings.effectGlobal;

    const settings = await prisma.userSettings.upsert({
        where: { userId },
        create: {
            userId,
            ...updateData
        },
        update: updateData,
        select: {
            effectTopRunway: true,
            effectGift: true,
            effectLuckyGift: true,
            effectEntry: true,
            effectGlobal: true
        }
    });

    const redisKey = `user:effect_settings:${userId}`;
    await redisClient.set(redisKey, JSON.stringify(settings), 'EX', 86400);
    return settings;
};

export const getFansRankingService = async ({ hostId, period = "today", currentUserId }) => {
    const validPeriod = period.toLowerCase();
    const now = new Date();
    let startDate;

    if (validPeriod === "weekly" || validPeriod === "7days" || validPeriod === "recent_7_days") {
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    } else if (validPeriod === "monthly" || validPeriod === "month") {
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    } else {
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    }

    // Query top 50 gifters directly from GiftTransaction (Real-time DB query)
    const topGifters = await prisma.giftTransaction.groupBy({
        by: ['senderUserId'],
        where: {
            receiverUserId: hostId,
            createdAt: {
                gte: startDate
            }
        },
        _sum: {
            coinCost: true,
            pointsAwarded: true
        },
        orderBy: {
            _sum: {
                coinCost: 'desc'
            }
        },
        take: 50
    });

    const userIds = topGifters.map(g => g.senderUserId);

    const [users, walletLevels] = await Promise.all([
        userIds.length > 0 ? prisma.user.findMany({
            where: { id: { in: userIds } },
            select: {
                id: true,
                username: true,
                firstName: true,
                lastName: true,
                avatarUrl: true,
                privacyMysteryRank: true,
                vipSubscriptionActive: true,
                userLevel: {
                    select: {
                        wealthLevel: true
                    }
                }
            }
        }) : [],
        userIds.length > 0 ? prisma.walletUserLevel.findMany({
            where: {
                userId: { in: userIds },
                levelType: LevelType.WEALTH
            },
            select: {
                userId: true,
                currentLevel: true
            }
        }) : []
    ]);

    const userMap = new Map(users.map(u => [u.id, u]));
    const walletLevelMap = new Map(walletLevels.map(w => [w.userId, w.currentLevel]));

    const visibleGifters = topGifters.filter(g => {
        const u = userMap.get(g.senderUserId);
        const isMystery = Boolean(u?.privacyMysteryRank && u?.vipSubscriptionActive);
        return !isMystery;
    });

    const rankings = visibleGifters.map((g, index) => {
        const u = userMap.get(g.senderUserId);
        const wealthLv = walletLevelMap.get(g.senderUserId) ?? u?.userLevel?.wealthLevel ?? 1;
        const fullName = [u?.firstName, u?.lastName].filter(Boolean).join(" ").trim();
        const name = fullName || u?.username || 'User';
        const coins60Percent = Number(g._sum.pointsAwarded ?? Math.floor((g._sum.coinCost || 0) * 0.60));

        return {
            rank: index + 1,
            userId: g.senderUserId,
            name: name,
            username: u ? u.username : 'User',
            avatarUrl: u ? u.avatarUrl : null,
            coins: coins60Percent,
            wealthLevel: wealthLv,
            isMystery: false
        };
    });

    // Compute myRank for current logged-in user
    let myRankObj = { rank: null, coins: 0 };
    if (currentUserId) {
        const foundIndex = rankings.findIndex(r => r.userId === currentUserId);
        if (foundIndex !== -1) {
            myRankObj = {
                rank: rankings[foundIndex].rank,
                coins: rankings[foundIndex].coins
            };
        } else {
            const myAgg = await prisma.giftTransaction.aggregate({
                _sum: {
                    coinCost: true,
                    pointsAwarded: true
                },
                where: {
                    receiverUserId: hostId,
                    senderUserId: currentUserId,
                    createdAt: {
                        gte: startDate
                    }
                }
            });
            const myTotalCoinCost = Number(myAgg._sum.coinCost || 0);
            const myCoins = Number(myAgg._sum.pointsAwarded ?? Math.floor(myTotalCoinCost * 0.60));
            if (myCoins > 0) {
                const higherGifters = await prisma.giftTransaction.groupBy({
                    by: ['senderUserId'],
                    where: {
                        receiverUserId: hostId,
                        createdAt: {
                            gte: startDate
                        }
                    },
                    _sum: {
                        coinCost: true
                    },
                    having: {
                        coinCost: {
                            _sum: {
                                gt: myTotalCoinCost
                            }
                        }
                    }
                });
                myRankObj = {
                    rank: higherGifters.length + 1,
                    coins: myCoins
                };
            }
        }
    }

    return {
        period: validPeriod,
        hostId,
        rankings,
        myRank: myRankObj
    };
};

export const sortRoomViewersService = async ({ hostUserId, streamId, viewerIds = [] }) => {
    if (!viewerIds || viewerIds.length === 0) return [];

    const cacheKey = `stream:viewers_sorted:${streamId}:${[...viewerIds].sort().join(',')}`;
    if (redisClient.isOpen) {
        const cached = await redisClient.get(cacheKey);
        if (cached) {
            try { return JSON.parse(cached); } catch (e) { }
        }
    }

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const now = new Date();

    const [giftAgg, activeGuardians, dbUsers, walletLevels, adminIds] = await Promise.all([
        prisma.giftTransaction.groupBy({
            by: ['senderUserId'],
            where: {
                receiverUserId: hostUserId,
                senderUserId: { in: viewerIds },
                createdAt: { gte: sevenDaysAgo }
            },
            _sum: {
                coinCost: true
            }
        }),
        prisma.guardian.findMany({
            where: {
                guardianUserId: { in: viewerIds },
                targetUserId: hostUserId,
                isExpired: false,
                expiresAt: { gt: now }
            },
            select: {
                guardianUserId: true
            }
        }),
        prisma.user.findMany({
            where: { id: { in: viewerIds } },
            select: {
                id: true,
                publicId: true,
                username: true,
                firstName: true,
                lastName: true,
                avatarUrl: true,
                gender: true,
                dateOfBirth: true,
                privacyMysteryLive: true,
                vipSubscriptionActive: true,
                userLevel: {
                    select: {
                        wealthLevel: true,
                        livestreamLevel: true
                    }
                }
            }
        }),
        prisma.walletUserLevel.findMany({
            where: {
                userId: { in: viewerIds },
                levelType: LevelType.WEALTH
            },
            select: {
                userId: true,
                currentLevel: true
            }
        }),
        streamId ? getStreamAdminsService({ streamId }) : Promise.resolve([])
    ]);

    const giftMap = new Map(giftAgg.map(g => [g.senderUserId, Number(g._sum.coinCost || 0)]));
    const guardianSet = new Set(activeGuardians.map(g => g.guardianUserId));
    const walletLevelMap = new Map(walletLevels.map(w => [w.userId, w.currentLevel]));
    const adminSet = new Set(adminIds || []);

    const visibleDbUsers = dbUsers.filter(u => !(u.privacyMysteryLive && u.vipSubscriptionActive));

    const viewers = visibleDbUsers.map(u => {
        const coins7d = giftMap.get(u.id) || 0;
        const isGuardian = guardianSet.has(u.id);
        const isVip = !!u.vipSubscriptionActive;
        const wealthLevel = walletLevelMap.get(u.id) ?? (u.userLevel?.wealthLevel || 1);
        const livestreamLevel = (u.userLevel?.livestreamLevel || 1);
        const isAdmin = adminSet.has(u.id);

        let age = null;
        if (u.dateOfBirth) {
            const today = new Date();
            const birthDate = new Date(u.dateOfBirth);
            age = today.getFullYear() - birthDate.getFullYear();
            const m = today.getMonth() - birthDate.getMonth();
            if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
                age--;
            }
            if (age < 0) age = null;
        }

        const name = `${u.firstName || ""} ${u.lastName || ""}`.trim() || u.username || "User";

        return {
            id: u.id,
            publicId: u.publicId ? u.publicId.toString() : null,
            name,
            username: u.username,
            avatarUrl: u.avatarUrl || null,
            gender: u.gender || null,
            age,
            isAdmin,
            isGuardian,
            isVip,
            coins7d,
            wealthLevel,
            livestreamLevel
        };
    });

    viewers.sort((a, b) => {
        // Tier 1: 7-Day Top Gifters Coins (Highest first)
        if (a.coins7d !== b.coins7d) return b.coins7d - a.coins7d;

        // Tier 2: Host Guardian Status (Guardians first)
        if (a.isGuardian !== b.isGuardian) return b.isGuardian ? 1 : -1;

        // Tier 3: VIP Subscribed Status (VIPs first)
        if (a.isVip !== b.isVip) return b.isVip ? 1 : -1;

        // Tier 4: Wealth Level (Highest level first)
        return b.wealthLevel - a.wealthLevel;
    });

    if (redisClient.isOpen && viewers.length > 0) {
        await redisClient.set(cacheKey, JSON.stringify(viewers), "EX", 60);
    }

    return viewers;
};

export const getHostProfileService = async ({ hostUserId }) => {
    if (!hostUserId) return null;

    const cacheKey = `user:profile:${hostUserId}`;
    if (redisClient.isOpen) {
        const cached = await redisClient.get(cacheKey);
        if (cached) {
            try { return JSON.parse(cached); } catch (e) { }
        }
    }

    const [hostUser, hostWalletLevels] = await Promise.all([
        prisma.user.findUnique({
            where: { id: hostUserId },
            select: {
                id: true,
                publicId: true,
                username: true,
                firstName: true,
                lastName: true,
                avatarUrl: true,
                userLevel: {
                    select: {
                        wealthLevel: true,
                        livestreamLevel: true
                    }
                }
            }
        }),
        prisma.walletUserLevel.findMany({
            where: { userId: hostUserId },
            select: { levelType: true, currentLevel: true }
        })
    ]);

    const hostLevelMap = new Map(hostWalletLevels.map(w => [w.levelType, w.currentLevel]));
    const hostName = hostUser ? (`${hostUser.firstName || ""} ${hostUser.lastName || ""}`.trim() || hostUser.username || "Host") : "Host";
    const host = hostUser ? {
        id: hostUser.id,
        publicId: hostUser.publicId ? hostUser.publicId.toString() : null,
        name: hostName,
        username: hostUser.username,
        avatarUrl: hostUser.avatarUrl || null,
        wealthLevel: hostLevelMap.get(LevelType.WEALTH) ?? (hostUser.userLevel?.wealthLevel || 1),
        livestreamLevel: hostLevelMap.get(LevelType.STREAM) ?? (hostUser.userLevel?.livestreamLevel || 1)
    } : null;

    if (host && redisClient.isOpen) {
        await redisClient.set(cacheKey, JSON.stringify(host), "EX", 300);
    }

    return host;
};

export const getUserPrivacyService = async ({ userId }) => {
    if (!userId) return { username: "Guest", avatarUrl: null, isStealth: false };

    const cacheKey = `user:privacy:${userId}`;
    if (redisClient.isOpen) {
        const cached = await redisClient.get(cacheKey);
        if (cached) {
            try {
                const parsed = JSON.parse(cached);
                if (parsed && parsed.publicId !== undefined) {
                    return parsed;
                }
            } catch (e) { }
        }
    }

    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            publicId: true,
            username: true,
            firstName: true,
            lastName: true,
            avatarUrl: true,
            privacyMysteryLive: true,
            vipSubscriptionActive: true
        }
    });

    const nameStr = `${user?.firstName || ""} ${user?.lastName || ""}`.trim();
    const displayName = nameStr || user?.username || "Guest";

    const result = {
        publicId: user?.publicId ? user.publicId.toString() : null,
        name: displayName,
        username: user?.username || "Guest",
        avatarUrl: user?.avatarUrl || null,
        isStealth: Boolean(user?.privacyMysteryLive && user?.vipSubscriptionActive)
    };

    if (redisClient.isOpen) {
        await redisClient.set(cacheKey, JSON.stringify(result), "EX", 300);
    }

    return result;
};

export const cleanupStaleLiveStreamRedisKeys = async () => {
    if (!redisClient.isOpen) return { cleanedCount: 0 };
    try {
        const activeUserKeys = await redisClient.keys("user:active_stream:*");
        let cleanedCount = 0;

        for (const key of activeUserKeys) {
            const userId = key.replace("user:active_stream:", "");
            const streamId = await redisClient.get(key);

            if (streamId) {
                const dbStream = await prisma.liveStream.findFirst({
                    where: { id: streamId, userId, isLive: true }
                });

                if (!dbStream) {
                    console.log(`[Stale Key Cleaner] Deleting stale Redis key ${key} for ended stream ${streamId}`);
                    await Promise.all([
                        redisClient.del(key),
                        redisClient.del(`stream:info:${streamId}`)
                    ]).catch(() => { });
                    cleanedCount++;
                }
            }
        }
        return { cleanedCount, totalChecked: activeUserKeys.length };
    } catch (err) {
        console.error("[Stale Key Cleaner Error]:", err.message);
        return { cleanedCount: 0, error: err.message };
    }
};

/**
 * Helper to compute 11:30 PM (23:30) IST boundaries for today, thisWeek, and thisMonth.
 * IST is UTC + 5:30.
 * 23:30 IST corresponds to 18:00 UTC of the same calendar day.
 */
export const calculate1130DateRanges = (nowDate = new Date()) => {
    const istOffsetMs = 5.5 * 3600 * 1000;
    const istDate = new Date(nowDate.getTime() + istOffsetMs);

    const y = istDate.getUTCFullYear();
    const m = istDate.getUTCMonth();
    const d = istDate.getUTCDate();

    // 18:00 UTC on current calendar day corresponds to 23:30 IST on current day
    const today2330Utc = new Date(Date.UTC(y, m, d, 18, 0, 0, 0));
    let todayStartUtc, todayEndUtc;

    if (nowDate >= today2330Utc) {
        todayStartUtc = today2330Utc;
        todayEndUtc = new Date(Date.UTC(y, m, d + 1, 18, 0, 0, 0));
    } else {
        todayStartUtc = new Date(Date.UTC(y, m, d - 1, 18, 0, 0, 0));
        todayEndUtc = today2330Utc;
    }

    // Determine "This Week" (Sunday 23:30 IST to Sunday 23:30 IST)
    const dayOfWeek = istDate.getUTCDay(); // 0 = Sunday, 1 = Monday ... 6 = Saturday
    let daysSinceSunday = dayOfWeek;
    if (dayOfWeek === 0 && nowDate < today2330Utc) {
        daysSinceSunday = 7;
    }
    const sundayStartUtc = new Date(todayStartUtc.getTime() - (daysSinceSunday * 86400 * 1000));
    const weekStartUtc = new Date(Date.UTC(sundayStartUtc.getUTCFullYear(), sundayStartUtc.getUTCMonth(), sundayStartUtc.getUTCDate(), 18, 0, 0, 0));
    const weekEndUtc = new Date(weekStartUtc.getTime() + 7 * 86400 * 1000);

    // Determine "This Month" (Calendar month start to end anchored at 18:00 UTC / 23:30 IST)
    const monthStartUtc = new Date(Date.UTC(y, m, 1, 18, 0, 0, 0));
    const monthEndUtc = new Date(Date.UTC(y, m + 1, 1, 18, 0, 0, 0));

    return {
        today: { start: todayStartUtc, end: todayEndUtc },
        thisWeek: { start: weekStartUtc, end: weekEndUtc },
        thisMonth: { start: monthStartUtc, end: monthEndUtc }
    };
};

export const formatDurationHHMMSS = (totalSeconds = 0) => {
    const secs = Math.max(0, parseInt(totalSeconds, 10) || 0);
    const hours = Math.floor(secs / 3600);
    const minutes = Math.floor((secs % 3600) / 60);
    const remainingSecs = secs % 60;
    return [hours, minutes, remainingSecs]
        .map(v => String(v).padStart(2, '0'))
        .join(':');
};

export const getHostStatsService = async ({ hostUserId, period = "today" }) => {
    const hostUser = await prisma.user.findUnique({
        where: { id: hostUserId },
        select: { id: true, publicId: true, username: true }
    });

    if (!hostUser) {
        throw new Error("Host user not found.");
    }

    const hostPublicId = hostUser.publicId ? String(hostUser.publicId) : hostUser.id;
    const ranges = calculate1130DateRanges();

    const getMetricsForRange = async (startDate, endDate) => {
        const streams = await prisma.liveStream.findMany({
            where: {
                userId: hostUserId,
                endedAt: {
                    gte: startDate,
                    lt: endDate
                }
            },
            select: { id: true }
        });

        const streamIds = streams.map(s => s.id);
        let liveHoursSeconds = 0;

        if (streamIds.length > 0) {
            // Prefer effective_duration_seconds; fall back to wall-clock when still 0
            // (legacy rows / failed write left the column at default).
            const sumRes = await prisma.$queryRaw`
                SELECT COALESCE(SUM(
                  CASE
                    WHEN effective_duration_seconds > 0 THEN effective_duration_seconds
                    WHEN started_at IS NOT NULL AND ended_at IS NOT NULL
                      THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (ended_at - started_at)))::int)
                    ELSE 0
                  END
                ), 0)::BIGINT AS total
                FROM live_streams
                WHERE id = ANY(${streamIds}::uuid[])
            `;
            liveHoursSeconds = Number(sumRes?.[0]?.total || 0);
        }

        const pointsRes = await prisma.$queryRaw`
            SELECT COALESCE(SUM(ple.amount), 0)::BIGINT AS total_points
            FROM point_ledger_entries ple
            INNER JOIN wallets w ON w.id = ple.wallet_id
            WHERE w.user_id = ${hostUserId}::uuid
              AND w.currency_type = 'POINT'
              AND ple.direction = 'CREDIT'
              AND ple.created_at >= ${startDate}
              AND ple.created_at < ${endDate}
        `;
        const wonPoints = pointsRes && pointsRes[0] ? String(pointsRes[0].total_points) : "0";

        const newFollowers = await prisma.userFollow.count({
            where: {
                followingId: hostUserId,
                createdAt: {
                    gte: startDate,
                    lt: endDate
                }
            }
        });

        return {
            hostPublicId,
            liveHoursSeconds,
            liveHoursFormatted: formatDurationHHMMSS(liveHoursSeconds),
            wonPoints,
            newFollowers,
            pkWon: 0
        };
    };

    const fetchLastLiveStats = async () => {
        let lastLive = {
            streamId: null,
            liveHoursSeconds: 0,
            liveHoursFormatted: "00:00:00",
            wonPoints: "0",
            newFollowers: 0,
            pkWon: 0,
            endedAt: null
        };

        const mostRecentEndedStream = await prisma.liveStream.findFirst({
            where: {
                userId: hostUserId,
                isLive: false,
                endedAt: {
                    gte: ranges.today.start,
                    lt: ranges.today.end
                }
            },
            orderBy: { endedAt: 'desc' }
        });

        if (mostRecentEndedStream) {
            const streamId = mostRecentEndedStream.streamId || mostRecentEndedStream.id;
            const streamStart = mostRecentEndedStream.startedAt || mostRecentEndedStream.createdAt;
            const streamEnd = mostRecentEndedStream.endedAt;
            const streamSeconds = Number(mostRecentEndedStream.effectiveDurationSeconds || mostRecentEndedStream.effective_duration_seconds || 0);

            const streamPointsRes = await prisma.$queryRaw`
                SELECT COALESCE(SUM(ple.amount), 0)::BIGINT AS total_points
                FROM point_ledger_entries ple
                INNER JOIN wallets w ON w.id = ple.wallet_id
                WHERE w.user_id = ${hostUserId}::uuid
                  AND w.currency_type = 'POINT'
                  AND ple.direction = 'CREDIT'
                  AND ple.created_at >= ${streamStart}
                  AND ple.created_at <= ${streamEnd}
            `;
            const streamWonPoints = streamPointsRes && streamPointsRes[0] ? String(streamPointsRes[0].total_points) : "0";

            const streamFollowers = await prisma.userFollow.count({
                where: {
                    followingId: hostUserId,
                    createdAt: {
                        gte: streamStart,
                        lte: streamEnd
                    }
                }
            });

            lastLive = {
                streamId,
                liveHoursSeconds: streamSeconds,
                liveHoursFormatted: formatDurationHHMMSS(streamSeconds),
                wonPoints: streamWonPoints,
                newFollowers: streamFollowers,
                pkWon: 0,
                endedAt: streamEnd
            };
        }
        return lastLive;
    };

    const normPeriod = String(period || 'today').toLowerCase().trim();

    if (normPeriod === 'week' || normPeriod === 'thisweek' || normPeriod === 'this_week') {
        const thisWeekData = await getMetricsForRange(ranges.thisWeek.start, ranges.thisWeek.end);
        return { thisWeekData };
    }

    if (normPeriod === 'month' || normPeriod === 'thismonth' || normPeriod === 'this_month') {
        const thisMonthData = await getMetricsForRange(ranges.thisMonth.start, ranges.thisMonth.end);
        return { thisMonthData };
    }

    if (normPeriod === 'all') {
        const [todayData, thisWeekData, thisMonthData, lastLive] = await Promise.all([
            getMetricsForRange(ranges.today.start, ranges.today.end),
            getMetricsForRange(ranges.thisWeek.start, ranges.thisWeek.end),
            getMetricsForRange(ranges.thisMonth.start, ranges.thisMonth.end),
            fetchLastLiveStats()
        ]);
        todayData.lastLive = lastLive;
        return { todayData, thisWeekData, thisMonthData };
    }

    // Default: 'today' period
    const [todayData, lastLive] = await Promise.all([
        getMetricsForRange(ranges.today.start, ranges.today.end),
        fetchLastLiveStats()
    ]);
    todayData.lastLive = lastLive;

    return { todayData };
};