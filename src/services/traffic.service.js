/**
 * Traffic patterns (TRF-02 / TRF-03), Live-server half. ol-node-rest owns the tables and the
 * admin Traffic page; Live-server only writes shared-Redis counters that ol-node-rest reads.
 *
 * TRF-03: per IST hour, request and 5xx counts per section plus HyperLogLogs of users, under the
 *   same keys ol-node-rest writes (`traffic:req|err|u|su:<YYYYMMDDHH>`), 3-day expiry.
 * TRF-02: once a minute (leader only), `traffic:live:now` = hosts live, viewers in live rooms,
 *   active calls, users in calls, distinct users with a live socket, and `at` (ms).
 *
 * Counts only: no IPs, no user lists. Every write is best-effort and never throws.
 */
import prisma from '../config/prisma.js';
import { client as redisClient } from '../config/redis.js';
import { isLeader, onShutdown } from './cluster.service.js';

const IST_OFFSET_MS = 5.5 * 3600 * 1000;
const KEY_TTL_SEC = 3 * 86400;
const LIVE_NOW_KEY = 'traffic:live:now';
const LIVE_NOW_TTL_SEC = 300;
const SNAPSHOT_EVERY_MS = 60_000;

/** IST hour bucket `YYYYMMDDHH` (same as ol-node-rest `istHourKey`). */
export const istHourKey = (ms = Date.now()) => {
    const iso = new Date(ms + IST_OFFSET_MS).toISOString();
    return iso.slice(0, 4) + iso.slice(5, 7) + iso.slice(8, 10) + iso.slice(11, 13);
};

/** Section for a Live-server path, or null for admin, webhooks, health and anything unmounted. */
export const sectionForPath = (path) => {
    const p = String(path || '').split('?')[0];
    if (p.startsWith('/api/live-stream/')) return 'Live';
    if (p === '/api/video-call/webhook') return null;
    if (p.startsWith('/api/video-call/')) return 'Video call';
    return null;
};

/** Count one finished request (called from requestLog on 'finish'). Fire-and-forget. */
export const recordTrafficRequest = (path, userId, status, at = Date.now()) => {
    try {
        const section = sectionForPath(path);
        if (!section || status === 404 || !redisClient.isOpen) return;
        const hour = istHourKey(at);
        const req = `traffic:req:${hour}`;
        const m = redisClient.multi().hIncrBy(req, section, 1).expire(req, KEY_TTL_SEC);
        if (status >= 500) {
            const err = `traffic:err:${hour}`;
            m.hIncrBy(err, section, 1).expire(err, KEY_TTL_SEC);
        }
        if (userId) {
            const all = `traffic:u:${hour}`;
            const sec = `traffic:su:${hour}:${section}`;
            m.pfAdd(all, String(userId)).expire(all, KEY_TTL_SEC);
            m.pfAdd(sec, String(userId)).expire(sec, KEY_TTL_SEC);
        }
        m.exec().catch(() => { });
    } catch {
        /* never affects the request */
    }
};

/** TRF-02: one snapshot of live and call load. Exported for tests. */
export const collectLiveNow = async (io) => {
    const [streams, callsActive] = await Promise.all([
        prisma.liveStream.findMany({
            where: { isLive: true, endedAt: null },
            select: { id: true, streamId: true, userId: true },
        }),
        prisma.videoCallSession.count({ where: { status: 'ACTIVE' } }),
    ]);

    // Viewers = members of each room's active set, minus the host when the set holds them.
    let viewers = 0;
    for (const s of streams) {
        const key = `stream:active:${s.streamId || s.id}`;
        const [n, hostIn] = await Promise.all([
            redisClient.sCard(key),
            redisClient.sIsMember(key, s.userId),
        ]);
        viewers += Math.max(0, Number(n) - (hostIn ? 1 : 0));
    }

    let socketUsers = null;
    if (io) {
        try {
            const sockets = await io.fetchSockets();
            const ids = new Set();
            for (const sk of sockets) {
                const id = sk.data?.authUserId;
                if (id) ids.add(String(id));
            }
            socketUsers = ids.size;
        } catch {
            socketUsers = null;
        }
    }

    return {
        hostsLive: streams.length,
        viewers,
        callsActive,
        usersInCalls: callsActive * 2,
        socketUsers,
    };
};

let snapshotTimer = null;

/** TRF-02: write `traffic:live:now` every minute from the leader node. */
export const startTrafficSnapshot = (io) => {
    if (snapshotTimer) clearInterval(snapshotTimer);
    let running = false;
    snapshotTimer = setInterval(async () => {
        if (running) return;
        running = true;
        try {
            if (!redisClient.isOpen || !(await isLeader('traffic-live-now'))) return;
            const now = await collectLiveNow(io);
            const fields = { at: String(Date.now()) };
            for (const [k, v] of Object.entries(now)) if (v !== null) fields[k] = String(v);
            await redisClient.multi().del(LIVE_NOW_KEY).hSet(LIVE_NOW_KEY, fields).expire(LIVE_NOW_KEY, LIVE_NOW_TTL_SEC).exec();
        } catch (err) {
            console.error('[Traffic] live snapshot failed:', err.message);
        } finally {
            running = false;
        }
    }, SNAPSHOT_EVERY_MS);
    onShutdown('traffic-live-now', () => {
        clearInterval(snapshotTimer);
        snapshotTimer = null;
    });
};
