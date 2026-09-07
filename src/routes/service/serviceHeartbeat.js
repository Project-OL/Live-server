import { client as redisClient } from '../../config/redis.js';
import prisma from '../../config/prisma.js';
import { endLiveStreamService } from './serviceLive.js';

/**
 * Record a stream heartbeat ping from Host.
 * @param {string} streamId - Stream room identifier
 * @param {string} userId - Host user ID
 */
export const recordStreamHeartbeat = async (streamId, userId) => {
    if (!streamId) return null;
    const now = Date.now();
    const payload = JSON.stringify({ userId, timestamp: now });
    if (redisClient.isOpen) {
        try {
            await redisClient.set(`stream:heartbeat:${streamId}`, payload, "EX", 30);
            if (userId) {
                await redisClient.set(`stream:heartbeat:user:${userId}`, payload, "EX", 30);
            }
        } catch (err) {
            console.error("[Heartbeat] Redis set error:", err.message);
        }
    }
    return now;
};

/**
 * Fetch recorded heartbeat metadata for a stream.
 * @param {string} streamId 
 */
export const getStreamHeartbeat = async (streamId) => {
    if (!streamId || !redisClient.isOpen) return null;
    try {
        const raw = await redisClient.get(`stream:heartbeat:${streamId}`);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (err) {
        console.error("[Heartbeat] Redis get error:", err.message);
        return null;
    }
};

let heartbeatMonitorInterval = null;

/**
 * Start the background worker that monitors all live streams every 5 seconds.
 * If host heartbeat is missing for > 15 seconds and host is NOT in a video call
 * or 2-minute return window, auto-ends the stream.
 * @param {import('socket.io').Server} io - Socket.io instance
 */
export const startStreamHeartbeatMonitor = (io) => {
    if (heartbeatMonitorInterval) {
        clearInterval(heartbeatMonitorInterval);
    }

    console.log("[Heartbeat Protection] Background monitor started (interval: 5s, timeout: 15s).");

    heartbeatMonitorInterval = setInterval(async () => {
        try {
            // Find all currently active live streams
            const activeStreams = await prisma.liveStream.findMany({
                where: { isLive: true, endedAt: null },
                select: { id: true, streamId: true, userId: true, createdAt: true, startedAt: true }
            });

            if (!activeStreams || activeStreams.length === 0) return;

            const now = Date.now();

            for (const stream of activeStreams) {
                try {
                    const streamIdKey = stream.streamId || stream.id;
                    const hostUserId = stream.userId;
                    const startTime = (stream.startedAt || stream.createdAt || new Date()).getTime();

                    // 15-second grace window upon initial stream creation
                    if (now - startTime < 15000) {
                        continue;
                    }

                    // Check heartbeat timestamp from Redis
                    let lastHeartbeatTime = null;
                    if (redisClient.isOpen) {
                        const rawHb = await redisClient.get(`stream:heartbeat:${streamIdKey}`);
                        if (rawHb) {
                            try {
                                const parsed = JSON.parse(rawHb);
                                lastHeartbeatTime = parsed.timestamp;
                            } catch (_) {
                                lastHeartbeatTime = Number(rawHb);
                            }
                        }
                    }

                    // If heartbeat was received within last 15 seconds (15,000 ms), stream is HEALTHY
                    if (lastHeartbeatTime && (now - lastHeartbeatTime <= 15000)) {
                        continue;
                    }

                    // If no heartbeat key exists, check when stream started or if heartbeat expired
                    const durationSinceLastPing = lastHeartbeatTime ? (now - lastHeartbeatTime) : (now - startTime);

                    if (durationSinceLastPing <= 15000) {
                        continue;
                    }

                    // --- Heartbeat Missing > 15 seconds. Check Pause Conditions ---

                    // PAUSE CONDITION 1: Host is in an active 1-on-1 Video Call
                    const activeVideoCall = await prisma.videoCallSession.findFirst({
                        where: {
                            OR: [{ callerId: hostUserId }, { creatorId: hostUserId }],
                            status: "ACTIVE"
                        }
                    });

                    if (activeVideoCall) {
                        console.log(`[Heartbeat Monitor] Host ${hostUserId} is in active video call (${activeVideoCall.id}). Pausing 15s heartbeat timeout.`);
                        continue;
                    }

                    // PAUSE CONDITION 2: Host is in 2-minute Return Grace Window
                    if (redisClient.isOpen) {
                        const returnTimer1 = await redisClient.get(`host:return_timer:${streamIdKey}:${hostUserId}`);
                        const returnTimer2 = await redisClient.get(`host:return_timer:${hostUserId}`);
                        if (returnTimer1 || returnTimer2) {
                            console.log(`[Heartbeat Monitor] Host ${hostUserId} is in 2-minute return grace window. Pausing 15s heartbeat timeout.`);
                            continue;
                        }
                    }

                    // --- BOTH PAUSE CONDITIONS CLEARED: AUTO-END STREAM ---
                    console.warn(`[Heartbeat Monitor] Stream ${streamIdKey} lost heartbeat (last ping ${durationSinceLastPing}ms ago). Auto-ending stream!`);

                    const payload = {
                        streamId: streamIdKey,
                        streamDbId: stream.id,
                        reason: "HEARTBEAT_LOST",
                        message: "Live stream ended due to host network loss."
                    };

                    if (io) {
                        io.to(streamIdKey).emit("stream_ended", payload);
                        if (stream.id && stream.id !== streamIdKey) {
                            io.to(stream.id).emit("stream_ended", payload);
                        }
                    }

                    // Execute endLiveStreamService
                    try {
                        await endLiveStreamService({ id: stream.id, userId: hostUserId });
                    } catch (endErr) {
                        console.error(`[Heartbeat Monitor] Error in endLiveStreamService for ${stream.id}:`, endErr.message);
                    }

                    // Clean up heartbeat key
                    if (redisClient.isOpen) {
                        await Promise.all([
                            redisClient.del(`stream:heartbeat:${streamIdKey}`),
                            redisClient.del(`stream:heartbeat:user:${hostUserId}`)
                        ]).catch(() => {});
                    }

                } catch (streamErr) {
                    console.error(`[Heartbeat Monitor] Error checking stream ${stream.id}:`, streamErr.message);
                }
            }
        } catch (loopErr) {
            console.error("[Heartbeat Monitor] Loop error:", loopErr.message);
        }
    }, 5000);
};

export const stopStreamHeartbeatMonitor = () => {
    if (heartbeatMonitorInterval) {
        clearInterval(heartbeatMonitorInterval);
        heartbeatMonitorInterval = null;
        console.log("[Heartbeat Protection] Background monitor stopped.");
    }
};
