import { getBannedWords, censorTextWithFuzzyMatch } from "../../utils/censor.js";
import { LevelType } from "@prisma/client";
import prisma from "../../config/prisma.js";
import { client as redisClient } from "../../config/redis.js";
import * as videoCallService from "./service.js";
import {
    isShuttingDown,
    registerDurableHandler,
    scheduleDurable
} from "../../services/cluster.service.js";

/**
 * L3 (LIVE-09): userId -> latest socket id. The local Map is the fast path; the
 * same mapping is mirrored to Redis (`vc:usersock:<userId>`) so a node can route
 * call signalling to a callee connected to another node. With the socket.io Redis
 * adapter, io.to(socketId) reaches that socket wherever it lives. Only the latest
 * socket gets the event, exactly as before.
 */
export const userSockets = new Map();
let ioInstance = null;

const USER_SOCKET_TTL_SEC = 86400;
const userSocketKey = (userId) => `vc:usersock:${userId}`;

// Delete the mapping only if it still points at this socket (a newer one may have replaced it).
const DEL_IF_MATCH_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

/** 15s grace before a dropped participant's call is ended (durable: survives restarts). */
const DISCONNECT_TIMER = "vc_disconnect";
const DISCONNECT_GRACE_MS = 15000;

registerDurableHandler(DISCONNECT_TIMER, async (key, payload) => {
    const sep = key.indexOf(":");
    const sessionId = key.slice(0, sep);
    const userId = key.slice(sep + 1);
    const disconnectKey = `call:disconnect:${sessionId}:${userId}`;

    let isStillDisconnected = true;
    if (redisClient.isOpen) {
        const val = await redisClient.get(disconnectKey);
        isStillDisconnected = Boolean(val);
    }

    if (!isStillDisconnected) {
        console.log(`[VideoCall Disconnect Cancelled] User ${userId} reconnected within 15s grace period for call ${sessionId}.`);
        return;
    }

    console.log(`[VideoCall Disconnect Timeout] User ${userId} did NOT reconnect to call ${sessionId} within 15s. Auto-ending call.`);
    if (redisClient.isOpen) {
        await redisClient.del(disconnectKey).catch(() => { });
    }

    const currentSession = await prisma.videoCallSession.findUnique({
        where: { id: sessionId }
    });

    if (currentSession && currentSession.status === "ACTIVE") {
        const disconnectedAt = Number(payload?.disconnectedAt) || Date.now();
        await videoCallService.endCall(sessionId, userId, "USER_DISCONNECTED_TIMEOUT", new Date(disconnectedAt));
    }
});

export const setupVideoCallSockets = (io) => {
    ioInstance = io;
    io.on("connection", async (socket) => {
        const userId = socket.handshake.auth?.userId || socket.handshake.query?.userId;
        if (userId) {
            userSockets.set(userId, socket.id);
            if (redisClient.isOpen) {
                redisClient
                    .set(userSocketKey(userId), socket.id, { EX: USER_SOCKET_TTL_SEC })
                    .catch((err) => console.error("[VideoCall] user socket map set failed:", err.message));
            }

            // Clear any pending video call disconnect timer on reconnect
            try {
                if (redisClient.isOpen) {
                    const keys = await redisClient.keys(`call:disconnect:*:${userId}`);
                    if (keys && keys.length > 0) {
                        for (const k of keys) {
                            await redisClient.del(k).catch(() => { });
                        }
                        console.log(`[VideoCall Disconnect] User ${userId} reconnected. Cleared disconnect timer.`);
                    }
                }
            } catch (err) {
                console.error("[VideoCall Disconnect Reconnect Clear Error]:", err);
            }
        }

        socket.on("SEND_MESSAGE", async ({ receiverId, text }) => {
            if (!userId || !receiverId) return;

            try {
                // Level comes from the DB, never from the client payload.
                const [bannedWords, levelRow] = await Promise.all([
                    getBannedWords(),
                    prisma.walletUserLevel.findUnique({
                        where: { userId_levelType: { userId, levelType: LevelType.WEALTH } },
                        select: { currentLevel: true }
                    })
                ]);
                const filteredText = censorTextWithFuzzyMatch(text, bannedWords);

                emitToUser(receiverId, "RECEIVE_MESSAGE", {
                    senderId: userId,
                    text: filteredText,
                    wealthLevel: levelRow?.currentLevel ?? 1,
                    timestamp: new Date().toISOString()
                });
            } catch (err) {
                console.error("[VideoCall SEND_MESSAGE] failed:", err.message);
            }
        });

        socket.on("disconnect", async () => {
            if (userId) {
                if (userSockets.get(userId) === socket.id) userSockets.delete(userId);

                // Server shutdown/deploy: the socket.io close is ours, not the user's.
                // Keep the mapping (the client reconnects) and don't start a call-end grace.
                if (isShuttingDown()) return;

                if (redisClient.isOpen) {
                    redisClient
                        .eval(DEL_IF_MATCH_LUA, { keys: [userSocketKey(userId)], arguments: [socket.id] })
                        .catch(() => { });
                }

                // Video Call 15-Second Disconnect Grace Timer
                try {
                    const activeCall = await prisma.videoCallSession.findFirst({
                        where: {
                            OR: [{ callerId: userId }, { creatorId: userId }],
                            status: "ACTIVE"
                        }
                    });

                    if (activeCall) {
                        const sessionId = activeCall.id;
                        const disconnectedAt = Date.now();
                        const disconnectKey = `call:disconnect:${sessionId}:${userId}`;

                        console.warn(`[VideoCall Disconnect] Participant ${userId} disconnected from call ${sessionId}. Starting 15s grace timer.`);

                        if (redisClient.isOpen) {
                            await redisClient.set(disconnectKey, disconnectedAt.toString(), { EX: 30 }).catch(() => { });
                        }

                        await scheduleDurable(
                            DISCONNECT_TIMER,
                            `${sessionId}:${userId}`,
                            disconnectedAt + DISCONNECT_GRACE_MS,
                            { disconnectedAt }
                        );
                    }
                } catch (err) {
                    console.error("[VideoCall Disconnect Handling Error]:", err);
                }
            }
        });
    });
};

export const emitToUser = (userId, eventName, data) => {
    if (!ioInstance || !userId) return;
    const socketId = userSockets.get(userId);
    if (socketId) {
        ioInstance.to(socketId).emit(eventName, data);
        return;
    }
    // Not connected here: look up the socket on another node (L3).
    if (!redisClient.isOpen) return;
    redisClient
        .get(userSocketKey(userId))
        .then((remoteSocketId) => {
            if (remoteSocketId) ioInstance.to(remoteSocketId).emit(eventName, data);
        })
        .catch((err) => console.error(`[VideoCall] emitToUser ${eventName} lookup failed:`, err.message));
};
