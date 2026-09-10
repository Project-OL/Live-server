import { client as redisClient } from '../../config/redis.js';
import prisma from '../../config/prisma.js';
import { endLiveStreamService } from './serviceLive.js';

// Stream is considered unhealthy after this many ms without a heartbeat ping.
const HEARTBEAT_TIMEOUT_MS = 60000;
// How often the background monitor sweeps active streams.
const HEARTBEAT_MONITOR_INTERVAL_MS = 5000;
// Grace period after stream creation before a heartbeat is required at all.
const STREAM_START_GRACE_MS = 60000;
// Redis key TTL for heartbeat entries (kept comfortably above the timeout above).
const HEARTBEAT_KEY_TTL_SECONDS = 90;

/**
 * Record a stream heartbeat ping from Host.
 * @param {string} streamId - Stream room identifier
 * @param {string} userId - Host user ID
 */
export const recordStreamHeartbeat = async (streamId, userId, source = "unknown") => {
    if (!streamId) {
        console.warn(`[Heartbeat] Ping received via ${source} but streamId is missing — ignored.`);
        return null;
    }
    const now = Date.now();
    const payload = JSON.stringify({ userId, timestamp: now });
    if (redisClient.isOpen) {
        try {
            await redisClient.set(`stream:heartbeat:${streamId}`, payload, { EX: HEARTBEAT_KEY_TTL_SECONDS });
            if (userId) {
                await redisClient.set(`stream:heartbeat:user:${userId}`, payload, { EX: HEARTBEAT_KEY_TTL_SECONDS });
            }
            console.log(`[Heartbeat] ✅ Ping recorded via ${source} for stream ${streamId} (user ${userId || "unknown"}) at ${new Date(now).toISOString()}`);
        } catch (err) {
            console.error("[Heartbeat] Redis set error:", err.message);
        }
    } else {
        console.warn(`[Heartbeat] Ping received via ${source} for stream ${streamId} but Redis is not open — not recorded.`);
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
 * If host heartbeat is missing for > HEARTBEAT_TIMEOUT_MS and host is NOT in a video call
 * or 2-minute return window, auto-ends the stream.
 * @param {import('socket.io').Server} io - Socket.io instance
 */
export const startStreamHeartbeatMonitor = (io) => {
    if (heartbeatMonitorInterval) {
        clearInterval(heartbeatMonitorInterval);
    }

    console.log(`[Heartbeat Protection] Background monitor started (interval: ${HEARTBEAT_MONITOR_INTERVAL_MS / 1000}s, timeout: ${HEARTBEAT_TIMEOUT_MS / 1000}s).`);

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

                    // Grace window upon initial stream creation
                    if (now - startTime < STREAM_START_GRACE_MS) {
                        continue;
                    }

                    // Check heartbeat timestamp from Redis
                    let lastHeartbeatTime = null;
                    let rawHb = null;
                    const redisWasOpen = redisClient.isOpen;
                    if (redisClient.isOpen) {
                        rawHb = await redisClient.get(`stream:heartbeat:${streamIdKey}`);
                        if (rawHb) {
                            try {
                                const parsed = JSON.parse(rawHb);
                                lastHeartbeatTime = parsed.timestamp;
                            } catch (_) {
                                lastHeartbeatTime = Number(rawHb);
                            }
                        }
                    }

                    console.log(`[Heartbeat Monitor Debug] stream=${streamIdKey} redisOpen=${redisWasOpen} rawHb=${rawHb} lastHeartbeatTime=${lastHeartbeatTime} now=${now} gapMs=${lastHeartbeatTime ? (now - lastHeartbeatTime) : "N/A"}`);

                    // If heartbeat was received within the timeout window, stream is HEALTHY
                    if (lastHeartbeatTime && (now - lastHeartbeatTime <= HEARTBEAT_TIMEOUT_MS)) {
                        continue;
                    }

                    // If no heartbeat key exists, check when stream started or if heartbeat expired
                    const durationSinceLastPing = lastHeartbeatTime ? (now - lastHeartbeatTime) : (now - startTime);

                    if (durationSinceLastPing <= HEARTBEAT_TIMEOUT_MS) {
                        continue;
                    }

                    // --- Heartbeat Missing > HEARTBEAT_TIMEOUT_MS. Check Pause Conditions ---

                    // PAUSE CONDITION 1: Host is in an active 1-on-1 Video Call
                    const activeVideoCall = await prisma.videoCallSession.findFirst({
                        where: {
                            OR: [{ callerId: hostUserId }, { creatorId: hostUserId }],
                            status: "ACTIVE"
                        }
                    });

                    if (activeVideoCall) {
                        console.log(`[Heartbeat Monitor] Host ${hostUserId} is in active video call (${activeVideoCall.id}). Pausing heartbeat timeout.`);
                        continue;
                    }

                    // PAUSE CONDITION 2: Host is in 2-minute Return Grace Window
                    if (redisClient.isOpen) {
                        const returnTimer1 = await redisClient.get(`host:return_timer:${streamIdKey}:${hostUserId}`);
                        const returnTimer2 = await redisClient.get(`host:return_timer:${hostUserId}`);
                        if (returnTimer1 || returnTimer2) {
                            console.log(`[Heartbeat Monitor] Host ${hostUserId} is in 2-minute return grace window. Pausing heartbeat timeout.`);
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
                        await endLiveStreamService({ id: stream.id, userId: hostUserId, reason: "HEARTBEAT_LOST" });
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
    }, HEARTBEAT_MONITOR_INTERVAL_MS);
};

export const stopStreamHeartbeatMonitor = () => {
    if (heartbeatMonitorInterval) {
        clearInterval(heartbeatMonitorInterval);
        heartbeatMonitorInterval = null;
        console.log("[Heartbeat Protection] Background monitor stopped.");
    }
};
