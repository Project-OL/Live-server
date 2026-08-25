import prisma from '../../config/prisma.js';
import { client as redisClient } from '../../config/redis.js';
import crypto from 'crypto';
import { LevelType } from '@prisma/client';
import { getBannedWords, censorTextWithFuzzyMatch } from '../../utils/censor.js';
import { getChatPermissionService, isStreamAdminService, getUserPrivacyService } from './serviceLive.js';
import { isUserRestrictedFast } from './serviceAdmin.js';

export const SYSTEM_SENDER_ID = "00000000-0000-0000-0000-000000000000";

export const buildDisplayName = (userObj) => {
    if (!userObj) return '';
    const first = (userObj.firstName || '').trim();
    const last = (userObj.lastName || '').trim();
    if (first && last) return `${first} ${last}`;
    if (first) return first;
    if (last) return last;
    return userObj.username || '';
};

const generateFakeName = () => {
    const chars = 'abcdefghijklmnopqrstuvwxyz';
    const nums = '0123456789';
    let str = '';
    for (let i = 0; i < 3; i++) {
        str += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    for (let i = 0; i < 2; i++) {
        str += nums.charAt(Math.floor(Math.random() * nums.length));
    }
    return `**${str}`; // e.g. "**sdg52"
};

const generateFakePublicId = () => {
    return String(Math.floor(100000000 + Math.random() * 900000000));
};

export const getOrCreateSessionAliasObj = async (streamId, userId) => {
    if (!streamId || !userId) return { alias: generateFakeName(), fakePublicId: generateFakePublicId() };
    const redisKey = `stream:alias:${streamId}:${userId}`;
    try {
        let rawData = await redisClient.get(redisKey);
        if (!rawData) {
            const alias = generateFakeName();
            const fakePublicId = generateFakePublicId();
            const dataObj = { alias, fakePublicId };
            await redisClient.set(redisKey, JSON.stringify(dataObj), 'EX', 86400); // 24 Hours TTL
            return dataObj;
        }
        try {
            const parsed = JSON.parse(rawData);
            if (typeof parsed === 'object' && parsed.alias) {
                return parsed;
            }
            const dataObj = { alias: rawData, fakePublicId: generateFakePublicId() };
            await redisClient.set(redisKey, JSON.stringify(dataObj), 'EX', 86400);
            return dataObj;
        } catch (e) {
            const dataObj = { alias: rawData, fakePublicId: generateFakePublicId() };
            return dataObj;
        }
    } catch (err) {
        console.error("[StealthAlias] Failed to get or create session alias:", err.message);
        return { alias: generateFakeName(), fakePublicId: generateFakePublicId() };
    }
};

export const getOrCreateSessionAlias = async (streamId, userId) => {
    const obj = await getOrCreateSessionAliasObj(streamId, userId);
    return obj ? obj.alias : generateFakeName();
};

export const removeSessionAlias = async (streamId, userId) => {
    if (!streamId || !userId) return;
    try {
        await redisClient.del(`stream:alias:${streamId}:${userId}`);
    } catch (err) {
        console.error("[StealthAlias] Failed to remove session alias:", err.message);
    }
};

export const sendMessageService = async ({
    streamId,
    senderId,
    message,
    replyToMessageId = null,
    replyToUserId = null,
    replyToUsername = null,
    replyToText = null,
    messageType = "CHAT",
    isLuckyGift = false,
    giftId = null,
    giftCount = 1
}) => {
    let user = null;
    let filteredMessage = message;
    let chatBubble = null;
    let senderWealthLevel = 0;
    let senderLivestreamLevel = 0;
    let targetUserObj = null;
    let targetWealthLevel = 0;
    let targetLivestreamLevel = 0;

    if (senderId !== SYSTEM_SENDER_ID) {
        const chatMute = await isUserRestrictedFast(senderId, 'LIVE_CHAT_MUTE');
        if (chatMute) {
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
            throw new Error(`You are muted from sending chat messages until ${formattedTime}`);
        }
        const msgDisable = await isUserRestrictedFast(senderId, 'MESSAGING_DISABLE');
        if (msgDisable) {
            const formattedTime = new Date(msgDisable.restrictedUntil).toLocaleString('en-IN', {
                timeZone: 'Asia/Kolkata',
                day: '2-digit',
                month: 'short',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: true
            });
            throw new Error(`Messaging has been disabled for your account until ${formattedTime}`);
        }

        // Validate chat permission
        const mode = await getChatPermissionService({ streamId });
        if (mode !== "EVERYONE") {
            const stream = await prisma.liveStream.findUnique({
                where: { streamId },
                select: { userId: true }
            });
            const isHost = stream && stream.userId === senderId;
            const isAdmin = await isStreamAdminService({ streamId, userId: senderId });

            if (mode === "ALL_MUTED") {
                if (!isHost) {
                    throw new Error("Chat is muted by the host.");
                }
            } else if (mode === "ADMINS_ONLY") {
                if (!isHost && !isAdmin) {
                    throw new Error("Only the host and admins are allowed to send messages.");
                }
            } else if (mode === "FOLLOWERS_ONLY") {
                const isFollowing = await prisma.userFollow.findUnique({
                    where: {
                        followerId_followingId: {
                            followerId: senderId,
                            followingId: stream.userId
                        }
                    }
                });
                if (!isFollowing) {
                    throw new Error("Only followers of the host are allowed to send messages.");
                }
            }
        }

        const [dbUser, walletLevels] = await Promise.all([
            prisma.user.findUnique({
                where: { id: senderId },
                select: {
                    id: true,
                    publicId: true,
                    username: true,
                    avatarUrl: true,
                    firstName: true,
                    lastName: true,
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
                where: { userId: senderId },
                select: { levelType: true, currentLevel: true }
            })
        ]);

        user = dbUser;
        const levelMap = new Map(walletLevels.map(w => [w.levelType, w.currentLevel]));
        senderWealthLevel = levelMap.get(LevelType.WEALTH) ?? dbUser?.userLevel?.wealthLevel ?? 0;
        senderLivestreamLevel = levelMap.get(LevelType.LIVESTREAM) ?? dbUser?.userLevel?.livestreamLevel ?? 0;

        // Apply fuzzy censorship with 60% threshold
        try {
            const bannedList = await getBannedWords();
            // Guarantee "curve" is in the search list even if not in DB yet
            const searchList = [...bannedList];
            if (!searchList.some(b => b.word.toLowerCase() === 'curve')) {
                searchList.push({ word: 'curve' });
            }
            filteredMessage = censorTextWithFuzzyMatch(message, searchList, 0.6);
        } catch (err) {
            console.error("[Censor] Live chat message censoring failed:", err);
        }

        // Fetch active CHAT_BUBBLE
        try {
            const activeBubble = await prisma.userActiveStoreItems.findUnique({
                where: {
                    userId_category: {
                        userId: senderId,
                        category: "CHAT_BUBBLE"
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

            if (activeBubble && activeBubble.userStoreItem && activeBubble.userStoreItem.isActive) {
                const expiresAt = new Date(activeBubble.userStoreItem.expiresAt);
                if (expiresAt > new Date()) {
                    chatBubble = {
                        name: activeBubble.userStoreItem.storeItem.name,
                        effectUrl: activeBubble.userStoreItem.storeItem.effectUrl
                    };
                }
            }
        } catch (err) {
            console.error("[ChatBubble] Failed to load active chat bubble:", err);
        }
    } else if (replyToUserId) {
        try {
            const [tUser, tLevels] = await Promise.all([
                prisma.user.findUnique({
                    where: { id: replyToUserId },
                    select: {
                        id: true,
                        publicId: true,
                        username: true,
                        firstName: true,
                        lastName: true,
                        avatarUrl: true,
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
                    where: { userId: replyToUserId },
                    select: { levelType: true, currentLevel: true }
                })
            ]);
            if (tUser) {
                targetUserObj = tUser;
                const lvlMap = new Map(tLevels.map(w => [w.levelType, w.currentLevel]));
                targetWealthLevel = lvlMap.get(LevelType.WEALTH) ?? tUser.userLevel?.wealthLevel ?? 0;
                targetLivestreamLevel = lvlMap.get(LevelType.LIVESTREAM) ?? tUser.userLevel?.livestreamLevel ?? 0;
            }
        } catch (err) {
            console.error("[SystemMessage] Failed to load target user details:", err);
        }
    }

    const messageData = {
        id: crypto.randomUUID(),
        streamId,
        senderId,
        message: filteredMessage,
        replyToMessageId: replyToMessageId || null,
        replyToUserId: replyToUserId || null,
        replyToUsername: replyToUsername || null,
        messageType,
        isLuckyGift,
        giftId,
        giftCount,
        createdAt: new Date().toISOString()
    };

    const listKey = `stream:chats:${streamId}`;
    await redisClient.rPush(listKey, JSON.stringify(messageData));
    await redisClient.lTrim(listKey, -200, -1);

    const isStealth = Boolean(user?.privacyMysteryLive && user?.vipSubscriptionActive);
    let stealthAliasObj = null;
    if (isStealth) {
        stealthAliasObj = await getOrCreateSessionAliasObj(streamId, senderId);
    }

    const isTargetStealth = Boolean(targetUserObj?.privacyMysteryLive && targetUserObj?.vipSubscriptionActive);
    let targetStealthAliasObj = null;
    if (isTargetStealth) {
        targetStealthAliasObj = await getOrCreateSessionAliasObj(streamId, targetUserObj.id);
    }

    return {
        ...messageData,
        createdAt: new Date(messageData.createdAt),
        sender: senderId === SYSTEM_SENDER_ID
            ? (targetUserObj ? {
                id: isTargetStealth ? null : targetUserObj.id,
                publicId: isTargetStealth ? targetStealthAliasObj?.fakePublicId : (targetUserObj.publicId ? targetUserObj.publicId.toString() : null),
                username: isTargetStealth ? (targetStealthAliasObj?.alias || 'sdg52') : targetUserObj.username,
                name: isTargetStealth ? (targetStealthAliasObj?.alias || 'sdg52') : buildDisplayName(targetUserObj),
                avatarUrl: isTargetStealth ? null : (targetUserObj.avatarUrl || null),
                wealthLevel: isTargetStealth ? 0 : targetWealthLevel,
                livestreamLevel: isTargetStealth ? 0 : targetLivestreamLevel,
                isMystery: isTargetStealth
            } : { id: SYSTEM_SENDER_ID, username: 'System', name: 'System', avatarUrl: null, wealthLevel: 0, livestreamLevel: 0 })
            : (user ? {
                id: isStealth ? null : user.id,
                publicId: isStealth ? stealthAliasObj?.fakePublicId : (user.publicId ? user.publicId.toString() : null),
                username: isStealth ? (stealthAliasObj?.alias || 'sdg52') : user.username,
                name: isStealth ? (stealthAliasObj?.alias || 'sdg52') : buildDisplayName(user),
                avatarUrl: isStealth ? null : (user.avatarUrl || null),
                wealthLevel: isStealth ? 0 : senderWealthLevel,
                livestreamLevel: isStealth ? 0 : senderLivestreamLevel,
                isMystery: isStealth
            } : { username: 'Unknown User', name: 'Unknown User', avatarUrl: null, wealthLevel: 0, livestreamLevel: 0 })
    };
};

export const getMessagesService = async ({
    streamId,
    filter = 'all',
    chatsOnly = false
}) => {
    let effectiveFilter = filter;
    if (filter === 'all' && chatsOnly) {
        effectiveFilter = 'chat';
    }

    const listKey = `stream:chats:${streamId}`;
    const rawMessages = await redisClient.lRange(listKey, 0, -1);

    let messages = [];
    if (rawMessages.length > 0) {
        messages = rawMessages.map(m => {
            const parsed = JSON.parse(m);
            return {
                ...parsed,
                createdAt: new Date(parsed.createdAt)
            };
        });
    } else {
        const dbMessages = await prisma.liveMessage.findMany({
            where: { streamId },
            orderBy: { createdAt: 'asc' }
        });
        messages = dbMessages.map(m => ({
            id: m.id,
            streamId: m.streamId,
            senderId: m.senderId,
            message: m.message,
            createdAt: m.createdAt,
            replyToMessageId: m.replyToMessageId,
            replyToUserId: m.replyToUserId,
            replyToUsername: m.replyToUsername,
            replyToText: m.replyToText
        }));
    }

    const clearedAtTime = await redisClient.get(`stream:chat_cleared:${streamId}`);
    if (clearedAtTime) {
        const clearedTime = new Date(clearedAtTime).getTime();
        messages = messages.filter(m => new Date(m.createdAt).getTime() > clearedTime);
    }

    if (effectiveFilter === 'chat') {
        messages = messages.filter(m => m.senderId !== SYSTEM_SENDER_ID);
    } else if (effectiveFilter === 'room') {
        messages = messages.filter(m => m.senderId === SYSTEM_SENDER_ID);
    }

    const allUserIds = [...new Set(messages.flatMap(m => {
        const ids = [];
        if (m.senderId && m.senderId !== SYSTEM_SENDER_ID) ids.push(m.senderId);
        if (m.replyToUserId) ids.push(m.replyToUserId);
        return ids;
    }))];

    const [users, walletLevels] = await Promise.all([
        prisma.user.findMany({
            where: {
                id: { in: allUserIds }
            },
            select: {
                id: true,
                publicId: true,
                username: true,
                firstName: true,
                lastName: true,
                avatarUrl: true,
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
                userId: { in: allUserIds }
            },
            select: {
                userId: true,
                levelType: true,
                currentLevel: true
            }
        })
    ]);

    const userMap = new Map(users.map(u => [u.id, u]));
    const levelMap = new Map(walletLevels.map(w => [`${w.userId}_${w.levelType}`, w.currentLevel]));

    return Promise.all(messages.map(async m => {
        const targetId = (m.senderId === SYSTEM_SENDER_ID && m.replyToUserId) ? m.replyToUserId : m.senderId;
        const userObj = userMap.get(targetId);
        const wealthLevel = levelMap.get(`${targetId}_${LevelType.WEALTH}`) ?? userObj?.userLevel?.wealthLevel ?? 0;
        const livestreamLevel = levelMap.get(`${targetId}_${LevelType.LIVESTREAM}`) ?? userObj?.userLevel?.livestreamLevel ?? 0;

        let senderObj;
        if (m.senderId === SYSTEM_SENDER_ID) {
            senderObj = userObj ? {
                id: userObj.id,
                publicId: userObj.publicId ? userObj.publicId.toString() : null,
                username: userObj.username,
                name: buildDisplayName(userObj),
                avatarUrl: userObj.avatarUrl || null,
                wealthLevel,
                livestreamLevel
            } : {
                id: SYSTEM_SENDER_ID,
                username: 'System',
                name: 'System',
                avatarUrl: null,
                wealthLevel: 0,
                livestreamLevel: 0
            };
        } else {
            const isStealth = Boolean(userObj?.privacyMysteryLive && userObj?.vipSubscriptionActive);
            const aliasObj = isStealth ? await getOrCreateSessionAliasObj(streamId, userObj.id) : null;
            senderObj = userObj ? {
                id: isStealth ? null : userObj.id,
                publicId: isStealth ? aliasObj?.fakePublicId : (userObj.publicId ? userObj.publicId.toString() : null),
                username: isStealth ? (aliasObj?.alias || 'sdg52') : userObj.username,
                name: isStealth ? (aliasObj?.alias || 'sdg52') : buildDisplayName(userObj),
                avatarUrl: isStealth ? null : (userObj.avatarUrl || null),
                wealthLevel,
                livestreamLevel,
                isMystery: isStealth
            } : {
                username: 'Unknown User',
                name: 'Unknown User',
                avatarUrl: null,
                wealthLevel: 0,
                livestreamLevel: 0
            };
        }

        return {
            ...m,
            sender: senderObj
        };
    }));
};

export const joinStreamService = async ({
    streamId,
    userId
}) => {
    const { isStealth } = await getUserPrivacyService({ userId });

    // Always add to history set in Redis for admin records
    await redisClient.sAdd(`stream:history:${streamId}`, userId);

    // Add to active set ONLY if NOT stealth
    if (!isStealth) {
        await redisClient.sAdd(`stream:active:${streamId}`, userId);
    }
    return { success: true };
};

export const leaveStreamService = async ({
    streamId,
    userId
}) => {
    await redisClient.sRem(`stream:active:${streamId}`, userId);
    return { success: true };
};

export const getViewerCountService = async ({
    streamId
}) => {
    const count = await redisClient.sCard(`stream:active:${streamId}`);
    return count;
};

export const getStreamViewersService = async ({
    streamId
}) => {
    const viewers = await redisClient.sMembers(`stream:active:${streamId}`);
    return viewers;
};