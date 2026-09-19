import { client as redisClient } from '../../config/redis.js';
import prisma from '../../config/prisma.js';
import {
    endLiveStreamService,
} from './serviceLive.js';
import { livekitHostIsPresent } from './livekitPresence.js';

/**
 * How long a host may go silent (no heartbeat) before the stream is auto-ended.
 * Deliberately generous so a backgrounded app (user briefly switches apps) has
 * time to come back before viewers are kicked out. Default 90s.
 */
const HEARTBEAT_TIMEOUT_MS = Number(process.env.LIVE_HEARTBEAT_TIMEOUT_MS || 90000);

// Redis TTL for the last-heartbeat marker must outlive HEARTBEAT_TIMEOUT_MS — otherwise
// the key expires mid-silence and the monitor falls back to stream *age* instead of
// "time since last ping", ending the stream almost immediately instead of honoring
// the full grace window. +15s buffer covers the 5s monitor poll interval + clock skew.
const HEARTBEAT_KEY_TTL_SEC = Math.ceil(HEARTBEAT_TIMEOUT_MS / 1000) + 15;

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
            await redisClient.set(`stream:heartbeat:${streamId}`, payload, { EX: HEARTBEAT_KEY_TTL_SEC });
            if (userId) {
                await redisClient.set(`stream:heartbeat:user:${userId}`, payload, { EX: HEARTBEAT_KEY_TTL_SEC });
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

/** Initial grace after go-live before heartbeat is required */
const HEARTBEAT_START_GRACE_MS = Number(process.env.LIVE_HEARTBEAT_START_GRACE_MS || 15000);
/**
 * After this age, if the host identity is not in the LiveKit room AND the host has
 * never been confirmed present before, end the stream. Catches true Wi-Fi ghosts
 * where go-live API succeeded but Room.connect never did. Default 20s.
 * Once a host has been confirmed present at least once (see stream:host_confirmed:*
 * below), later LiveKit absences are no longer treated as ghosts here — they fall
 * through to the heartbeat-lost check instead, which has the full HEARTBEAT_TIMEOUT_MS
 * grace (so a brief media drop / backgrounded app doesn't get the fast ghost timeout).
 */
const LIVEKIT_HOST_GRACE_MS = Number(process.env.LIVE_GHOST_LIVEKIT_GRACE_MS || 20000);
const GHOST_SWEEP_ENABLED = String(process.env.LIVE_GHOST_SWEEP_ENABLED || 'true').toLowerCase() !== 'false';
/**
 * How long a host's socket may stay disconnected before the stream is auto-ended.
 * Kept in lockstep with HEARTBEAT_TIMEOUT_MS so backgrounding the app (which often
 * drops the socket too) doesn't get ended by this timer before the heartbeat grace
 * even has a chance to matter.
 */
export const HOST_DISCONNECT_TIMEOUT_MS = Number(process.env.LIVE_HOST_DISCONNECT_TIMEOUT_MS || HEARTBEAT_TIMEOUT_MS);

const hostConfirmedKey = (streamIdKey) => `stream:host_confirmed:${streamIdKey}`;

/** Remember that the host has been seen in the LiveKit room at least once for this stream. */
const markHostConfirmed = async (streamIdKey) => {
    if (!redisClient.isOpen) return;
    try {
        // 24h safety-net TTL in case end-of-stream cleanup is ever skipped (e.g. crash).
        await redisClient.set(hostConfirmedKey(streamIdKey), "1", { EX: 86400 });
    } catch (err) {
        console.error("[Heartbeat] host_confirmed set error:", err.message);
    }
};

const isHostConfirmed = async (streamIdKey) => {
    if (!redisClient.isOpen) return false;
    try {
        return Boolean(await redisClient.get(hostConfirmedKey(streamIdKey)));
    } catch (err) {
        console.error("[Heartbeat] host_confirmed get error:", err.message);
        return false;
    }
};

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
                        if (hostInLk) {
                            // Host confirmed present at least once — remember it so a later
                            // drop (network blip, backgrounded app) isn't mistaken for a
                            // "never connected" ghost and gets the full heartbeat grace instead.
                            markHostConfirmed(streamIdKey).catch(() => { });
                        } else {
                            const pause = await hostPausedForCallOrReturn(hostUserId, streamIdKey);
                            if (pause.paused) {
                                console.log(`[Ghost Sweep] Stream ${streamIdKey} no LiveKit host but paused (${pause.why}).`);
                            } else if (await isHostConfirmed(streamIdKey)) {
                                // Host was live before; this is a drop, not a ghost. Let the
                                // heartbeat-lost check below (full HEARTBEAT_TIMEOUT_MS grace)
                                // decide whether to end the stream.
                                console.log(`[Ghost Sweep] Stream ${streamIdKey} host previously confirmed but not in LiveKit now. Deferring to heartbeat monitor.`);
                            } else {
                                console.warn(
                                    `[Ghost Sweep] Stream ${streamIdKey} age=${ageMs}ms with no LiveKit host ${hostUserId}, never confirmed. Auto-ending.`
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
