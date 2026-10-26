import { client as redisClient } from '../../config/redis.js';
import prisma from '../../config/prisma.js';
import {
    endLiveStreamService,
} from './serviceLive.js';
import { livekitHostIsPresent } from './livekitPresence.js';
import { HOST_NOVIDEO_MAX_MS, hostNoVideoKey, hostNoVideoMode, hostNoVideoMs } from './hostNoVideo.js';
import { LIVE_FAILURE_KINDS, recordLiveFailure, pruneOldFailureEvents } from '../../services/liveFailureLog.service.js';
import { hostStreamFacts, livekitCause } from '../../services/livekitEvents.service.js';
import { disconnectMeta } from '../../services/socketDisconnect.service.js';
import { isLeader, onShutdown } from '../../services/cluster.service.js';
import { heartbeatVerdict } from './heartbeatPolicy.js';

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

/**
 * LIVE-15: cap on "host confirmed once, now absent from LiveKit, but still heartbeating". Without
 * it a host whose media dropped keeps a black stream live for hours (seen: ~3 h with ~80 s of
 * video). The first absent tick stamps `stream:host_absent_since:<id>`; being back in the room
 * clears it. Rolled out like SEC-05:
 *   LIVE_HOST_ABSENCE_MODE=log      default: count and log what would be ended
 *   LIVE_HOST_ABSENCE_MODE=enforce  end the stream (reason HOST_MEDIA_LOST)
 * LIVE_HOST_ABSENCE_MAX_MS, default 5 minutes.
 */
const HOST_ABSENCE_MAX_MS = Number(process.env.LIVE_HOST_ABSENCE_MAX_MS || 5 * 60 * 1000);
export const hostAbsenceMode = () =>
    String(process.env.LIVE_HOST_ABSENCE_MODE || 'log').trim().toLowerCase() === 'enforce' ? 'enforce' : 'log';
const hostAbsentKey = (streamIdKey) => `stream:host_absent_since:${streamIdKey}`;

/** @returns {Promise<number>} ms the host has been absent (0 on the first absent tick). */
const noteHostAbsent = async (streamIdKey) => {
    if (!redisClient.isOpen) return 0;
    try {
        const now = Date.now();
        await redisClient.set(hostAbsentKey(streamIdKey), String(now), { NX: true, EX: 86400 });
        const since = Number(await redisClient.get(hostAbsentKey(streamIdKey)));
        return Number.isFinite(since) ? now - since : 0;
    } catch {
        return 0;
    }
};
const clearHostAbsent = (streamIdKey) => {
    if (redisClient.isOpen) redisClient.del(hostAbsentKey(streamIdKey)).catch(() => { });
};
const absenceLoggedAt = new Map();

// Phase 0 black-screen gap (host in LiveKit, no video): see hostNoVideo.js.
const noVideoLoggedAt = new Map();

/** One keepalive log line per stream per minute (the monitor ticks every 5 s). */
const keepaliveLoggedAt = new Map();
const logKeepalive = (streamIdKey, hostUserId, sinceLastPingMs, lastHeartbeatTime) => {
    const now = Date.now();
    if (now - (keepaliveLoggedAt.get(streamIdKey) || 0) < 60000) return;
    keepaliveLoggedAt.set(streamIdKey, now);
    if (keepaliveLoggedAt.size > 5000) keepaliveLoggedAt.clear();
    console.log(
        `[Heartbeat Monitor] Stream ${streamIdKey} host ${hostUserId} sent no heartbeat for ${sinceLastPingMs}ms` +
        `${lastHeartbeatTime ? '' : ' (never)'} but is still in the LiveKit room; kept alive (LIVE-19).`
    );
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

/**
 * LIVE-14: end first, then record the failure and tell viewers, only if this sweep's end won.
 * The sweep works from a snapshot taken at the start of the tick; a host who ended the stream
 * mid-tick used to get a false GHOST_STREAM_ENDED / HEARTBEAT_LOST plus a second stream_ended.
 * endLiveStreamService claims the end atomically (LIVE-29) and reports alreadyEnded otherwise.
 */
const endFromSweep = async (io, stream, streamIdKey, { reason, message, failure, logTag }) => {
    let result = null;
    try {
        result = await endLiveStreamService({ id: stream.id, userId: stream.userId, reason });
    } catch (endErr) {
        console.error(`[${logTag}] endLiveStreamService ${stream.id}:`, endErr.message);
        return;
    }
    if (!result || result.alreadyEnded) {
        console.log(`[${logTag}] Stream ${streamIdKey} was already ended; no failure recorded.`);
        return;
    }
    // BE-05/06: say what LiveKit saw of the host and how their app socket closed, so the event
    // separates "never reached LiveKit" from "left LiveKit: <reason>" and a dead app from a network drop.
    try {
        const [facts, disc] = await Promise.all([
            hostStreamFacts(streamIdKey, stream.userId),
            disconnectMeta(stream.userId),
        ]);
        failure = {
            ...failure,
            role: 'host',
            meta: { ...(failure.meta || {}), livekit: livekitCause(facts), livekitJoins: facts.joins, ...disc },
        };
    } catch {
        /* the failure is recorded without the extra context */
    }
    recordLiveFailure(failure);
    emitStreamEnded(io, stream, streamIdKey, reason, message);
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

    // LIVE-41: one tick at a time (a slow tick used to overlap the next and act on the same streams).
    let tickRunning = false;
    heartbeatMonitorInterval = setInterval(async () => {
        if (tickRunning) {
            console.warn("[Heartbeat Monitor] previous tick still running; skipped");
            return;
        }
        tickRunning = true;
        const tickStarted = Date.now();
        try {
            // L5 (LIVE-09): one node sweeps; the others would race to end the same streams.
            if (!(await isLeader('stream-heartbeat-monitor'))) return;

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
                    // LiveKit presence of the host, looked up at most once per tick per stream.
                    let hostInLk = null;

                    // --- Ghost / Wi-Fi: go-live created DB row but host never joined LiveKit ---
                    if (GHOST_SWEEP_ENABLED && ageMs >= LIVEKIT_HOST_GRACE_MS) {
                        hostInLk = await livekitHostIsPresent(streamIdKey, hostUserId);
                        if (hostInLk) {
                            // Host confirmed present at least once — remember it so a later
                            // drop (network blip, backgrounded app) isn't mistaken for a
                            // "never connected" ghost and gets the full heartbeat grace instead.
                            markHostConfirmed(streamIdKey).catch(() => { });
                            clearHostAbsent(streamIdKey);
                            const noVideoMs = await hostNoVideoMs(streamIdKey, hostUserId, now);
                            if (noVideoMs !== null && noVideoMs >= HOST_NOVIDEO_MAX_MS) {
                                if (hostNoVideoMode() === 'enforce') {
                                    console.warn(`[Host No Video] Stream ${streamIdKey} host in LiveKit without video for ${noVideoMs} ms; ending (HOST_MEDIA_LOST).`);
                                    await endFromSweep(io, stream, streamIdKey, {
                                        reason: "HOST_MEDIA_LOST",
                                        message: "Live stream ended because the host's video was lost.",
                                        logTag: "Host No Video",
                                        failure: {
                                            kind: LIVE_FAILURE_KINDS.HEARTBEAT_LOST,
                                            userId: hostUserId,
                                            streamId: streamIdKey,
                                            code: 'HOST_NO_VIDEO',
                                            message: `Host in LiveKit but published no video for ${noVideoMs} ms; stream auto-ended.`,
                                            meta: { ageMs, noVideoMs }
                                        }
                                    });
                                    redisClient.del(hostNoVideoKey(streamIdKey)).catch(() => { });
                                    continue;
                                }
                                if (now - (noVideoLoggedAt.get(streamIdKey) || 0) >= 60000) {
                                    noVideoLoggedAt.set(streamIdKey, now);
                                    if (noVideoLoggedAt.size > 5000) noVideoLoggedAt.clear();
                                    console.warn(`[Host No Video] mode=log would end stream ${streamIdKey}: host in LiveKit without video for ${Math.round(noVideoMs / 1000)} s (camera not switched off).`);
                                }
                            }
                        } else {
                            const pause = await hostPausedForCallOrReturn(hostUserId, streamIdKey);
                            if (pause.paused) {
                                console.log(`[Ghost Sweep] Stream ${streamIdKey} no LiveKit host but paused (${pause.why}).`);
                                clearHostAbsent(streamIdKey);
                            } else if (await isHostConfirmed(streamIdKey)) {
                                // Host was live before; this is a drop, not a ghost. The heartbeat
                                // check below handles a silent host; LIVE-15 caps a host who keeps
                                // heartbeating without media.
                                const absentMs = await noteHostAbsent(streamIdKey);
                                if (absentMs >= HOST_ABSENCE_MAX_MS) {
                                    if (hostAbsenceMode() === 'enforce') {
                                        console.warn(`[Host Absence] Stream ${streamIdKey} host off LiveKit for ${absentMs} ms; ending (HOST_MEDIA_LOST).`);
                                        await endFromSweep(io, stream, streamIdKey, {
                                            reason: "HOST_MEDIA_LOST",
                                            message: "Live stream ended because the host's video was lost.",
                                            logTag: "Host Absence",
                                            failure: {
                                                kind: LIVE_FAILURE_KINDS.HEARTBEAT_LOST,
                                                userId: hostUserId,
                                                streamId: streamIdKey,
                                                code: 'HOST_MEDIA_LOST',
                                                message: `Host heartbeating but absent from LiveKit for ${absentMs} ms; stream auto-ended.`,
                                                meta: { ageMs, absentMs }
                                            }
                                        });
                                        clearHostAbsent(streamIdKey);
                                        continue;
                                    }
                                    if (now - (absenceLoggedAt.get(streamIdKey) || 0) >= 60000) {
                                        absenceLoggedAt.set(streamIdKey, now);
                                        if (absenceLoggedAt.size > 5000) absenceLoggedAt.clear();
                                        console.warn(`[Host Absence] mode=log would end stream ${streamIdKey}: host off LiveKit for ${Math.round(absentMs / 1000)} s while heartbeating.`);
                                    }
                                } else {
                                    console.log(`[Ghost Sweep] Stream ${streamIdKey} host previously confirmed but not in LiveKit now. Deferring to heartbeat monitor.`);
                                }
                            } else {
                                console.warn(
                                    `[Ghost Sweep] Stream ${streamIdKey} age=${ageMs}ms with no LiveKit host ${hostUserId}, never confirmed. Auto-ending.`
                                );
                                await endFromSweep(io, stream, streamIdKey, {
                                    reason: "NO_LIVEKIT_HOST",
                                    message: "Live stream ended because the host never connected media.",
                                    logTag: "Ghost Sweep",
                                    failure: {
                                        kind: LIVE_FAILURE_KINDS.GHOST_STREAM_ENDED,
                                        userId: hostUserId,
                                        streamId: streamIdKey,
                                        code: 'NO_LIVEKIT_HOST',
                                        message: 'Host never appeared in the LiveKit room; stream auto-ended.',
                                        meta: { ageMs }
                                    }
                                });
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

                    // LIVE-19: the app's heartbeat timer lives on the live room screen, so a
                    // minimized room or a dead socket stops it while the host keeps publishing.
                    // While the host is in the LiveKit room the stream is alive: refresh the
                    // heartbeat ourselves instead of ending a stream viewers are watching.
                    if (hostInLk === null) {
                        hostInLk = await livekitHostIsPresent(streamIdKey, hostUserId);
                    }
                    const pause = hostInLk
                        ? { paused: false }
                        : await hostPausedForCallOrReturn(hostUserId, streamIdKey);
                    const verdict = heartbeatVerdict({
                        now,
                        ageMs,
                        lastHeartbeatTime,
                        timeoutMs: HEARTBEAT_TIMEOUT_MS,
                        startGraceMs: HEARTBEAT_START_GRACE_MS,
                        paused: pause.paused,
                        hostInLiveKit: hostInLk,
                    });
                    if (verdict === 'keepalive') {
                        await recordStreamHeartbeat(streamIdKey, hostUserId);
                        markHostConfirmed(streamIdKey).catch(() => { });
                        logKeepalive(streamIdKey, hostUserId, durationSinceLastPing, lastHeartbeatTime);
                        continue;
                    }
                    if (verdict === 'paused') {
                        console.log(`[Heartbeat Monitor] Host ${hostUserId} paused (${pause.why}).`);
                        continue;
                    }

                    console.warn(
                        `[Heartbeat Monitor] Stream ${streamIdKey} lost heartbeat (last ping ${durationSinceLastPing}ms ago). Auto-ending stream!`
                    );
                    await endFromSweep(io, stream, streamIdKey, {
                        reason: "HEARTBEAT_LOST",
                        message: "Live stream ended due to host network loss.",
                        logTag: "Heartbeat Monitor",
                        failure: {
                            kind: LIVE_FAILURE_KINDS.HEARTBEAT_LOST,
                            userId: hostUserId,
                            streamId: streamIdKey,
                            code: lastHeartbeatTime ? 'HEARTBEAT_LOST' : 'NO_HEARTBEAT_EVER',
                            message: `No host heartbeat for ${durationSinceLastPing}ms; stream auto-ended.`,
                            meta: { ageMs, sinceLastPingMs: durationSinceLastPing }
                        }
                    });
                } catch (streamErr) {
                    console.error(`[Heartbeat Monitor] Error checking stream ${stream.id}:`, streamErr.message);
                }
            }
        } catch (loopErr) {
            console.error("[Heartbeat Monitor] Loop error:", loopErr.message);
        } finally {
            tickRunning = false;
            const ms = Date.now() - tickStarted;
            if (ms > 4000) console.warn(`[Heartbeat Monitor] tick took ${ms} ms`);
        }
    }, 5000);
    onShutdown('stream-heartbeat-monitor', stopStreamHeartbeatMonitor);

    // BE-03: keep live_failure_events to 90 days (leader only, every 6 hours).
    if (failurePruneInterval) clearInterval(failurePruneInterval);
    failurePruneInterval = setInterval(async () => {
        try {
            if (await isLeader('live-failure-prune')) await pruneOldFailureEvents();
        } catch (err) {
            console.error('[LiveFailure] prune failed:', err.message);
        }
    }, 6 * 3600 * 1000);
    onShutdown('live-failure-prune', () => clearInterval(failurePruneInterval));
};

let failurePruneInterval = null;

export const stopStreamHeartbeatMonitor = () => {
    if (heartbeatMonitorInterval) {
        clearInterval(heartbeatMonitorInterval);
        heartbeatMonitorInterval = null;
        console.log("[Heartbeat Protection] Background monitor stopped.");
    }
};
