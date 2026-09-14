import { client as redisClient } from '../../config/redis.js';
import prisma from '../../config/prisma.js';
import {
    endLiveStreamService,
} from './serviceLive.js';
import { livekitHostIsPresent } from './livekitPresence.js';

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
            await redisClient.set(`stream:heartbeat:${streamId}`, payload, { EX: 30 });
            if (userId) {
                await redisClient.set(`stream:heartbeat:user:${userId}`, payload, { EX: 30 });
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

/** Seconds after start before missing heartbeat ends the stream */
const HEARTBEAT_TIMEOUT_MS = Number(process.env.LIVE_HEARTBEAT_TIMEOUT_MS || 15000);
/** Initial grace after go-live before heartbeat is required */
const HEARTBEAT_START_GRACE_MS = Number(process.env.LIVE_HEARTBEAT_START_GRACE_MS || 15000);
/**
 * After this age, if the host identity is not in the LiveKit room, end the stream.
 * Catches Wi-Fi ghosts where go-live API succeeded but Room.connect never did
 * (and heartbeat never started). Default 20s.
 */
const LIVEKIT_HOST_GRACE_MS = Number(process.env.LIVE_GHOST_LIVEKIT_GRACE_MS || 20000);
const GHOST_SWEEP_ENABLED = String(process.env.LIVE_GHOST_SWEEP_ENABLED || 'true').toLowerCase() !== 'false';

const emitStreamEnded = (io, stream, streamIdKey, reason, message) => {
    const payload = {
        streamId: streamIdKey,
        streamDbId: stream.id,
        reason,
        message
    };
    if (!io) return;
    io.to(streamIdKey).emit("stream_ended", payload);
    if (stream.id && stream.id !== streamIdKey) {
        io.to(stream.id).emit("stream_ended", payload);
    }
};

const hostPausedForCallOrReturn = async (hostUserId, streamIdKey) => {
    const activeVideoCall = await prisma.videoCallSession.findFirst({
        where: {
            OR: [{ callerId: hostUserId }, { creatorId: hostUserId }],
            status: "ACTIVE"
        }
    });
    if (activeVideoCall) {
        return { paused: true, why: `video call ${activeVideoCall.id}` };
    }
    if (redisClient.isOpen) {
        const returnTimer1 = await redisClient.get(`host:return_timer:${streamIdKey}:${hostUserId}`);
        const returnTimer2 = await redisClient.get(`host:return_timer:${hostUserId}`);
        if (returnTimer1 || returnTimer2) {
            return { paused: true, why: '2-minute return grace' };
        }
    }
    return { paused: false };
};

/**
 * Start the background worker that monitors all live streams every 5 seconds.
 * - Missing host heartbeat > timeout → auto-end (existing)
 * - No LiveKit host participant after grace → auto-end (ghost / Wi-Fi fail)
 */
export const startStreamHeartbeatMonitor = (io) => {
    if (heartbeatMonitorInterval) {
        clearInterval(heartbeatMonitorInterval);
    }

    console.log(
        `[Heartbeat Protection] Background monitor started (interval: 5s, heartbeatTimeout: ${HEARTBEAT_TIMEOUT_MS}ms, livekitGrace: ${LIVEKIT_HOST_GRACE_MS}ms, ghostSweep: ${GHOST_SWEEP_ENABLED}).`
    );

    heartbeatMonitorInterval = setInterval(async () => {
        try {
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
                    const ageMs = now - startTime;

                    // --- Ghost / Wi-Fi: go-live created DB row but host never joined LiveKit ---
                    if (GHOST_SWEEP_ENABLED && ageMs >= LIVEKIT_HOST_GRACE_MS) {
                        const hostInLk = await livekitHostIsPresent(streamIdKey, hostUserId);
                        if (!hostInLk) {
                            const pause = await hostPausedForCallOrReturn(hostUserId, streamIdKey);
                            if (pause.paused) {
                                console.log(`[Ghost Sweep] Stream ${streamIdKey} no LiveKit host but paused (${pause.why}).`);
                            } else {
                                console.warn(
                                    `[Ghost Sweep] Stream ${streamIdKey} age=${ageMs}ms with no LiveKit host ${hostUserId}. Auto-ending.`
                                );
                                emitStreamEnded(
                                    io,
                                    stream,
                                    streamIdKey,
                                    "NO_LIVEKIT_HOST",
                                    "Live stream ended because the host never connected media."
                                );
                                try {
                                    await endLiveStreamService({
                                        id: stream.id,
                                        userId: hostUserId,
                                        reason: "NO_LIVEKIT_HOST"
                                    });
                                } catch (endErr) {
                                    console.error(`[Ghost Sweep] endLiveStreamService ${stream.id}:`, endErr.message);
                                }
                                continue;
                            }
                        }
                    }

                    // 15-second grace window upon initial stream creation (heartbeat)
                    if (ageMs < HEARTBEAT_START_GRACE_MS) {
                        continue;
                    }

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

                    if (lastHeartbeatTime && (now - lastHeartbeatTime <= HEARTBEAT_TIMEOUT_MS)) {
                        continue;
                    }

                    const durationSinceLastPing = lastHeartbeatTime ? (now - lastHeartbeatTime) : ageMs;

                    if (durationSinceLastPing <= HEARTBEAT_TIMEOUT_MS) {
                        continue;
                    }

                    const pause = await hostPausedForCallOrReturn(hostUserId, streamIdKey);
                    if (pause.paused) {
                        console.log(`[Heartbeat Monitor] Host ${hostUserId} paused (${pause.why}).`);
                        continue;
                    }

                    console.warn(
                        `[Heartbeat Monitor] Stream ${streamIdKey} lost heartbeat (last ping ${durationSinceLastPing}ms ago). Auto-ending stream!`
                    );

                    emitStreamEnded(
                        io,
                        stream,
                        streamIdKey,
                        "HEARTBEAT_LOST",
                        "Live stream ended due to host network loss."
                    );

                    try {
                        await endLiveStreamService({
                            id: stream.id,
                            userId: hostUserId,
                            reason: "HEARTBEAT_LOST"
                        });
                    } catch (endErr) {
                        console.error(`[Heartbeat Monitor] Error in endLiveStreamService for ${stream.id}:`, endErr.message);
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
