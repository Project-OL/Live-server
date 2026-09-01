import { getBannedWords, censorTextWithFuzzyMatch } from "../../utils/censor.js";
import prisma from "../../config/prisma.js";
import redisClient from "../../config/redis.js";
import * as videoCallService from "./service.js";

export const userSockets = new Map();
let ioInstance = null;

export const setupVideoCallSockets = (io) => {
    ioInstance = io;
    io.on("connection", async (socket) => {
        const userId = socket.handshake.auth?.userId || socket.handshake.query?.userId;
        if (userId) {
            userSockets.set(userId, socket.id);

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

        socket.on("SEND_MESSAGE", async ({ receiverId, text, wealthLevel }) => {
            if (!userId || !receiverId) return;

            const bannedWords = await getBannedWords();
            const filteredText = censorTextWithFuzzyMatch(text, bannedWords);

            emitToUser(receiverId, "RECEIVE_MESSAGE", {
                senderId: userId,
                text: filteredText,
                wealthLevel: wealthLevel || 0,
                timestamp: new Date().toISOString()
            });
        });

        socket.on("disconnect", async () => {
            if (userId) {
                userSockets.delete(userId);

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
                            await redisClient.set(disconnectKey, disconnectedAt.toString(), "EX", 30).catch(() => { });
                        }

                        setTimeout(async () => {
                            try {
                                let isStillDisconnected = true;
                                if (redisClient.isOpen) {
                                    const val = await redisClient.get(disconnectKey);
                                    isStillDisconnected = Boolean(val);
                                }

                                if (isStillDisconnected) {
                                    console.log(`[VideoCall Disconnect Timeout] User ${userId} did NOT reconnect to call ${sessionId} within 15s. Auto-ending call.`);
                                    if (redisClient.isOpen) {
                                        await redisClient.del(disconnectKey).catch(() => { });
                                    }

                                    const currentSession = await prisma.videoCallSession.findUnique({
                                        where: { id: sessionId }
                                    });

                                    if (currentSession && currentSession.status === "ACTIVE") {
                                        await videoCallService.endCall(sessionId, userId, "USER_DISCONNECTED_TIMEOUT", new Date(disconnectedAt));
                                    }
                                } else {
                                    console.log(`[VideoCall Disconnect Cancelled] User ${userId} reconnected within 15s grace period for call ${sessionId}.`);
                                }
                            } catch (timerErr) {
                                console.error("[VideoCall Disconnect Timeout Error]:", timerErr);
                            }
                        }, 15000);
                    }
                } catch (err) {
                    console.error("[VideoCall Disconnect Handling Error]:", err);
                }
            }
        });
    });
};

export const emitToUser = (userId, eventName, data) => {
    if (!ioInstance) return;
    const socketId = userSockets.get(userId);
    if (socketId) {
        ioInstance.to(socketId).emit(eventName, data);
    }
};
