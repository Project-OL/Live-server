/**
 * "Is this user hosting a live right now" for ol-node-rest's presence lists (LIVE-60).
 *
 * The marker is `user:active_stream:<userId>` = streamId (24 h TTL): set at go-live, deleted by every
 * end path through clearLiveStreamRedisKeys (and by ol-node-rest's admin force-end). ol-node-rest
 * reads it in the same MGET as `online:<userId>` and returns `isLive` / `liveStreamId`.
 *
 *  - Reconciler (leader, every 60 s): the DB (`live_streams.is_live`) is the truth. A marker whose
 *    stream is no longer live is deleted; a live stream with no marker gets one back (Redis flush,
 *    streams past the 24 h TTL); markers of live streams get their TTL renewed. A repair needs two
 *    ticks in a row, so a go-live between our Redis read and DB read is never undone.
 *  - LIVE_STATUS: on go-live, on the end that wins, and on each reconciler repair, a frame goes to
 *    ol-node-rest's per-user presence channel. ol-node-rest fans it out raw to every socket that
 *    sent JOIN_PRESENCE for that user; apps that don't know the frame ignore it.
 *
 * Best-effort throughout: nothing here throws into go-live or end.
 */
import prisma from '../config/prisma.js';
import { client as redisClient } from '../config/redis.js';
import { scanKeys } from '../utils/redisScan.js';
import { isLeader, onShutdown } from './cluster.service.js';

const MARKER_PREFIX = 'user:active_stream:';
export const MARKER_TTL_SEC = 86400;
/** Must match ol-node-rest `RedisKeys.presenceChannel`. */
const presenceChannel = (userId) => `presence:user:${userId}`;
const RECONCILE_EVERY_MS = Number(process.env.LIVE_HOST_STATUS_RECONCILE_MS || 60_000);

export const activeStreamKey = (userId) => `${MARKER_PREFIX}${userId}`;

/** Delete only if the marker still points at the stream we judged stale (a new go-live may have replaced it). */
const DEL_IF_EQUALS_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

export const liveStatusFrame = (userId, isLive, streamId) => ({
    t: 'LIVE_STATUS',
    userId: String(userId),
    isLive: Boolean(isLive),
    liveStreamId: isLive && streamId ? String(streamId) : null,
});

/** Tell presence subscribers that `userId` started or stopped hosting. Fire-and-forget. */
export const publishLiveStatus = (userId, isLive, streamId = null) => {
    try {
        if (!userId || !redisClient.isOpen) return;
        redisClient
            .publish(presenceChannel(userId), JSON.stringify(liveStatusFrame(userId, isLive, streamId)))
            .catch((err) => console.error('[LiveHostStatus] publish failed:', err.message));
    } catch {
        /* never affects go-live or end */
    }
};

/**
 * Pure planner, exported for tests.
 * @param {Map<string,string>} markers  userId -> streamId, as read from Redis
 * @param {{userId:string, streamId:string}[]} live  rows of live streams from the DB
 * @param {Set<string>} suspects  repairs proposed by the previous tick
 * @returns {{ del: {userId,streamId}[], set: {userId,streamId}[], touch: string[], suspects: Set<string> }}
 */
export const planMarkerRepair = (markers, live, suspects) => {
    const liveByUser = new Map();
    for (const row of live) {
        if (!row.userId || !row.streamId) continue;
        if (!liveByUser.has(row.userId)) liveByUser.set(row.userId, new Set());
        liveByUser.get(row.userId).add(row.streamId);
    }
    const next = new Set();
    const del = [];
    const set = [];
    const touch = [];

    for (const [userId, streamId] of markers) {
        if (liveByUser.get(userId)?.has(streamId)) {
            touch.push(userId);
            continue;
        }
        const id = `del|${userId}|${streamId}`;
        next.add(id);
        if (suspects.has(id)) del.push({ userId, streamId });
    }
    for (const [userId, streamIds] of liveByUser) {
        if (markers.has(userId)) continue;
        const streamId = [...streamIds][0];
        const id = `set|${userId}|${streamId}`;
        next.add(id);
        if (suspects.has(id)) set.push({ userId, streamId });
    }
    return { del, set, touch, suspects: next };
};

const readMarkers = async () => {
    const keys = [];
    for await (const key of scanKeys(`${MARKER_PREFIX}*`)) keys.push(key);
    const markers = new Map();
    for (let i = 0; i < keys.length; i += 200) {
        const chunk = keys.slice(i, i + 200);
        const values = await redisClient.mGet(chunk);
        chunk.forEach((key, j) => {
            if (values[j]) markers.set(key.slice(MARKER_PREFIX.length), values[j]);
        });
    }
    return markers;
};

let suspects = new Set();

/** One reconcile pass. Exported for tests and ops scripts. */
export const reconcileActiveStreamMarkers = async () => {
    // Redis first, then DB: a go-live writes Redis before its row, so the reverse order could
    // see a fresh marker with no row yet. The two-tick rule covers the rest.
    const markers = await readMarkers();
    const rows = await prisma.liveStream.findMany({
        where: { isLive: true, endedAt: null },
        select: { id: true, streamId: true, userId: true },
    });
    const live = rows.map((r) => ({ userId: r.userId, streamId: r.streamId || r.id }));
    const plan = planMarkerRepair(markers, live, suspects);
    suspects = plan.suspects;

    for (const { userId, streamId } of plan.del) {
        const removed = await redisClient.eval(DEL_IF_EQUALS_LUA, {
            keys: [activeStreamKey(userId)],
            arguments: [streamId],
        });
        if (Number(removed) === 1) {
            redisClient.del(`stream:info:${streamId}`).catch(() => { });
            console.warn(`[LiveHostStatus] removed stale marker for ${userId} (stream ${streamId} not live)`);
            publishLiveStatus(userId, false);
        }
    }
    for (const { userId, streamId } of plan.set) {
        const ok = await redisClient.set(activeStreamKey(userId), streamId, { NX: true, EX: MARKER_TTL_SEC });
        if (ok === 'OK') {
            console.warn(`[LiveHostStatus] restored missing marker for ${userId} (stream ${streamId} live)`);
            publishLiveStatus(userId, true, streamId);
        }
    }
    if (plan.touch.length) {
        const m = redisClient.multi();
        for (const userId of plan.touch) m.expire(activeStreamKey(userId), MARKER_TTL_SEC);
        await m.exec();
    }
    return { markers: markers.size, live: live.length, deleted: plan.del.length, restored: plan.set.length };
};

let timer = null;

export const startActiveStreamReconciler = () => {
    if (timer) clearInterval(timer);
    let running = false;
    timer = setInterval(async () => {
        if (running) return;
        running = true;
        try {
            if (!redisClient.isOpen || !(await isLeader('live-host-status'))) {
                suspects = new Set();
                return;
            }
            await reconcileActiveStreamMarkers();
        } catch (err) {
            console.error('[LiveHostStatus] reconcile failed:', err.message);
        } finally {
            running = false;
        }
    }, RECONCILE_EVERY_MS);
    timer.unref?.();
    onShutdown('live-host-status', () => {
        clearInterval(timer);
        timer = null;
    });
};
